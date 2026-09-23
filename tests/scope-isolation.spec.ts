import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentResult, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_FIXED_AGENTS } from '../src/host/default-agents.ts'
import { CommanderMode } from '../src/host/commander-mode.ts'
import { PROTOCOL_VERSION } from '../src/host/protocol.ts'
import { DevFlowStore } from '../src/host/storage.ts'
import { registerDevFlowTools } from '../src/host/tools.ts'
import { TaskWorkflow } from '../src/host/workflow.ts'
import { AgentWorkflow } from '../src/host/workflow-agent.ts'

const roots: string[] = []
afterEach(async () => {
  // `maxRetries` covers the Windows delete race that made this teardown
  // intermittently fail with ENOTEMPTY while a just-written `.devflow` file was
  // still being released: a flaky teardown must not read as a product failure.
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })))
})

const SNAKE_CRITERIA = ['Collision is detected and reported.', 'Existing food and score behaviour is unchanged.']
const E2E_CRITERIA = ['D:\\Desktop\\DevFlow-E2E\\index.html exists and opens as an HTML document.']
const SNAKE_DESCRIPTION = 'Fix the self-collision check in game.js and style.css without changing index.html behaviour.'
const E2E_DESCRIPTION = 'Create D:\\Desktop\\DevFlow-E2E\\index.html as a single-page smoke document.'

function nativeTool(name: string) {
  return defineTool({
    name,
    description: `${name} fixture`,
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.name }],
    },
    execute: async () => ({ name }),
  })
}

function resultDocument(taskId: string): string {
  return [
    '# DevFlow Result', '', '## Metadata', '', `Protocol Version: ${PROTOCOL_VERSION}`, `Task ID: ${taskId}`, 'Verdict: accepted', '',
    '## Summary', '', 'Done.', '', '## Changes', '', '- None', '', '## Verification', '', '- None', '',
    '## Issues', '', '- None', '', '## Next Steps', '', '- None',
  ].join('\n')
}

async function fixture() {
  const rootDir = await mkdtemp(join(tmpdir(), 'devflow-scope-isolation-'))
  roots.push(rootDir)
  const ctx = new Context()
  const store = new DevFlowStore(new LocalFileSystem(ctx, { cwd: rootDir, diffBasisMaxBytes: 1024 * 1024 }), './.devflow')
  const workflow = new TaskWorkflow(store)
  const agentWorkflow = new AgentWorkflow(store, workflow)
  const now = '2026-09-10T00:00:00.000Z'
  await store.saveProject({ id: 'project-isolation', name: 'Isolation', goal: 'Keep bounds per task', currentStage: 'implementation', createdAt: now, updatedAt: now })
  const child = await store.registerAgent({
    agentId: 'frontend-engineer', kind: 'fixed', role: 'frontend-engineer', delegationDepth: 0,
    prompt: 'Frontend fixture', modelConfig: { model: 'deepseek-chat' }, tools: ['read', 'write'], capabilities: [], skills: [],
  })
  const phase = await store.createPhase({ name: 'Implementation', description: 'isolation', status: 'in_progress' })

  const requests: SubagentStartRequest[] = []
  const start = vi.fn(async (_provider: string, input: SubagentStartRequest) => {
    requests.push(input)
    const settled: SubagentResult = {
      stopReason: 'completed',
      output: [{ type: 'text', text: resultDocument(currentTaskId) } satisfies ContentBlock],
    }
    return { id: 'child-run' as never, localAgent: undefined, result: Promise.resolve(settled), dispose: async () => {} }
  })
  ctx.provide('subagents', { start })
  new SystemPrompt(ctx, {})
  const tools = new ToolRuntime(ctx)
  registerDevFlowTools(ctx, { store, workflow, agentWorkflow })
  await Promise.resolve()

  let currentTaskId = ''
  const task = async (description: string, status: 'planned' | 'reviewing' = 'planned') => {
    const created = await store.createTask({ title: 'Task', description, status, assignedRole: 'frontend-engineer' })
    currentTaskId = created.id
    await store.createAssignment({ taskId: created.id, phaseId: phase.id, agentId: child.agentId, role: child.role, status: 'assigned' })
    return created
  }
  const call = async (name: string, args: Record<string, unknown>, agent: Agent) => await tools.execute({
    callId: `${name}-call` as never, name, arguments: args as never, agent, signal: new AbortController().signal,
  })
  const parent = { id: 'commander-parent', options: {}, session: { header: {} }, ctx } as unknown as Agent
  return { ctx, store, workflow, tools, start, requests, child, task, call, parent }
}

const setScope = (taskId: string, summary: string, criteria: readonly string[]) => ({
  taskId, summary, inScope: [summary], maxModifiedFiles: 6, maxToolSteps: 60, completionCriteria: [...criteria],
})

describe('Scope Guard isolation', () => {
  it('keeps task A bounds out of task B (and vice versa)', async () => {
    const f = await fixture()
    const a = await f.task(SNAKE_DESCRIPTION, 'reviewing')
    await f.call('devflow_set_scope', setScope(a.id, 'Snake collision fix only.', SNAKE_CRITERIA), f.parent)
    const b = await f.task(E2E_DESCRIPTION)
    await f.call('devflow_set_scope', setScope(b.id, 'E2E smoke only.', E2E_CRITERIA), f.parent)

    const packageB = await f.call('devflow_create_task_package', { taskId: b.id }, f.parent)
    expect(packageB.isError).toBe(false)
    const valueB = packageB.value as { acceptanceCriteria: string[]; instructions: string }
    expect(valueB.acceptanceCriteria).toEqual([...E2E_CRITERIA])
    expect(valueB.instructions).toContain('E2E smoke only.')
    expect(valueB.instructions).not.toContain('Snake collision fix only.')
    expect(valueB.instructions).toContain(`source: this task ${b.id}`)

    // Task A still reads its own bounds after B was set (no overwrite).
    const packageA = await f.call('devflow_create_task_package', { taskId: a.id }, f.parent)
    const valueA = packageA.value as { acceptanceCriteria: string[]; instructions: string }
    expect(valueA.acceptanceCriteria).toEqual([...SNAKE_CRITERIA])
    expect(valueA.instructions).toContain(`source: this task ${a.id}`)
    expect(valueA.instructions).not.toContain('E2E smoke only.')
  })

  it('marks a project-default fallback instead of carrying another task\'s bounds', async () => {
    const f = await fixture()
    const a = await f.task(SNAKE_DESCRIPTION, 'reviewing')
    await f.call('devflow_set_scope', setScope(a.id, 'Snake collision fix only.', SNAKE_CRITERIA), f.parent)
    await f.call('devflow_set_scope', {
      summary: 'Project default bounds.', inScope: ['project'], maxModifiedFiles: 20, maxToolSteps: 200,
      completionCriteria: ['Project default criterion.'],
    }, f.parent)
    const c = await f.task(E2E_DESCRIPTION)

    const packageC = await f.call('devflow_create_task_package', { taskId: c.id }, f.parent)
    const valueC = packageC.value as { acceptanceCriteria: string[]; instructions: string }
    expect(valueC.acceptanceCriteria).toEqual(['Project default criterion.'])
    expect(valueC.instructions).toContain('source: project default')
    expect(valueC.instructions).toContain('Call devflow_set_scope with this task id')
    expect(valueC.instructions).not.toContain('Snake collision fix only.')
  })

  it('carries no bounds at all when neither the task nor the project has any', async () => {
    const f = await fixture()
    const d = await f.task(E2E_DESCRIPTION)

    const packageD = await f.call('devflow_create_task_package', { taskId: d.id }, f.parent)
    const valueD = packageD.value as { acceptanceCriteria: string[]; instructions: string }
    expect(valueD.acceptanceCriteria).toEqual([])
    expect(valueD.instructions).not.toContain('Scope Guard (source:')
  })

  it('refuses a dispatch whose bounds name another task\'s location', async () => {
    const f = await fixture()
    await f.call('devflow_set_scope', {
      summary: 'E2E smoke bounds.', inScope: ['create the E2E file'], maxModifiedFiles: 1, maxToolSteps: 15,
      completionCriteria: [...E2E_CRITERIA],
    }, f.parent)
    const snake = await f.task(SNAKE_DESCRIPTION, 'reviewing')

    const execution = await f.call('devflow_dispatch_agent', { agentId: f.child.agentId, taskId: snake.id }, f.parent)

    expect(execution.isError).toBe(true)
    expect(JSON.stringify(execution)).toContain('DEVFLOW_DISPATCH_SCOPE_CONFLICT')
    expect(f.start).not.toHaveBeenCalled()
    const state = await f.store.loadState()
    expect(Object.values(state.executions)).toHaveLength(0)
    expect(Object.values(state.executionAttempts)).toHaveLength(0)
    expect(Object.values(state.executionBatches)).toHaveLength(0)
    // The task is untouched: a refused handoff is not a failed execution.
    expect((await f.store.getTask(snake.id))?.status).toBe('reviewing')
    // The refusal itself carries no raw location.
    expect(JSON.stringify(execution)).not.toContain('Desktop')
  })

  it('accepts bounds written with forward slashes when the task names the same files with backslashes', async () => {
    // The real N5 rejection (2026-09-19 15:22:16, task e3f44250, frontend-engineer),
    // reduced to its mechanism. The bounds and the task describe the SAME files, so this
    // handoff carries no contradictory bound at all.
    //
    // HISTORICAL DEFECT SNAPSHOT — this case used to be REFUSED. `ABSOLUTE_PATH_TOKEN`
    // began matching AT the first slash, so the path segment of a bare relative path
    // (`src/js/ui.js` ⇒ directory `/js`) was read as an "absolute location", while the task
    // wrote the same files with backslashes (`src\js\ui.js`), which that token never
    // matched at all: the two directory sets could not intersect and the guard refused a
    // legitimate dispatch (N5 14:52:55 / 14:53:02 / 15:22:16; step 13 01:28:19/20/25).
    //
    // Step 16 flips the two assertions this comment used to pin: the heuristic now
    // normalizes both slash styles before comparing, so the same input must be handed over.
    const f = await fixture()
    await f.call('devflow_set_scope', {
      summary: 'Interface-layer copy fixes for the empty-state branch.',
      inScope: ['src/js/ui.js empty-state copy branches', 'src/js/main.js validation notice path'],
      maxModifiedFiles: 3, maxToolSteps: 30,
      completionCriteria: ['Empty-state copy differs per filter.'],
    }, f.parent)
    const task = await f.task(
      'Fix src\\js\\ui.js empty-state copy and the src\\js\\main.js duplicate validation notice.',
      'reviewing',
    )

    const execution = await f.call('devflow_dispatch_agent', { agentId: f.child.agentId, taskId: task.id }, f.parent)

    expect(execution.isError).toBe(false)
    expect(JSON.stringify(execution)).not.toContain('DEVFLOW_DISPATCH_SCOPE_CONFLICT')
    // The child really started, and the handoff carried the matching bounds.
    expect(f.start).toHaveBeenCalled()
    const prompt = (f.requests[0]?.prompt[0] as { text?: string } | undefined)?.text ?? ''
    expect(prompt).toContain('Interface-layer copy fixes for the empty-state branch.')
    // A handed-over dispatch is not a refused one: the same state the refusal below
    // asserts is empty now holds a real execution.
    const state = await f.store.loadState()
    expect(Object.values(state.executions)).toHaveLength(1)
    expect(Object.values(state.executionAttempts)).toHaveLength(1)
  })

  it('still refuses bounds whose relative location the task never names', async () => {
    // The counterweight to the flip above: normalizing slashes must not turn the guard
    // into a no-op. The file-name check passes here on purpose (`ui.js` is named on both
    // sides), so the refusal can only come from the location check: these bounds name
    // `docs/secret`, a directory the task never mentions in either slash style.
    const f = await fixture()
    await f.call('devflow_set_scope', {
      summary: 'Empty-state copy for the interface layer.',
      inScope: ['docs/secret/ui.js empty-state copy branches'],
      maxModifiedFiles: 1, maxToolSteps: 15,
      completionCriteria: ['Empty-state copy differs per filter.'],
    }, f.parent)
    const task = await f.task('Fix the ui.js empty-state copy without changing style.css.', 'reviewing')

    const execution = await f.call('devflow_dispatch_agent', { agentId: f.child.agentId, taskId: task.id }, f.parent)

    expect(execution.isError).toBe(true)
    expect(JSON.stringify(execution)).toContain('DEVFLOW_DISPATCH_SCOPE_CONFLICT')
    expect(f.start).not.toHaveBeenCalled()
    // A refused handoff still leaves the task exactly where it was.
    expect((await f.store.getTask(task.id))?.status).toBe('reviewing')
  })

  it('refuses bounds a shared slash word cannot excuse', async () => {
    // Found by the independent audit of this round's fix: a throwaway slash word in BOTH
    // texts (`A/B` — prose, not a path) used to put the SAME pseudo directory into both
    // location sets, and since only ONE scope location has to match to hand the package
    // over, the real contradiction (`docs/secret`, which the task never mentions) rode
    // along. The judging side therefore counts only tokens that name a location on their
    // own; the file-name check passes here on purpose (`ui.js` on both sides).
    const f = await fixture()
    await f.call('devflow_set_scope', {
      summary: 'Empty-state copy for the interface layer.',
      inScope: ['docs/secret/ui.js empty-state copy branches', 'A/B 两种写法都要看'],
      maxModifiedFiles: 1, maxToolSteps: 15,
      completionCriteria: ['Empty-state copy differs per filter.'],
    }, f.parent)
    const task = await f.task('Fix the ui.js empty-state copy and A/B without changing style.css.', 'reviewing')

    const execution = await f.call('devflow_dispatch_agent', { agentId: f.child.agentId, taskId: task.id }, f.parent)

    expect(execution.isError).toBe(true)
    expect(JSON.stringify(execution)).toContain('DEVFLOW_DISPATCH_SCOPE_CONFLICT')
    expect(f.start).not.toHaveBeenCalled()
    expect((await f.store.getTask(task.id))?.status).toBe('reviewing')
  })

  it('refuses bounds whose directory differs even when the last segment is the same', async () => {
    // Pins the shape that separates a directory comparison from a last-segment comparison:
    // `secret/ui.js` is the tail of both, and the file-name check passes on purpose, so
    // only the directory may decide. A weaker heuristic that compared file names or last
    // segments would hand this over — this round's own tests all stayed green under that
    // regression, which is exactly why this case is pinned here.
    const f = await fixture()
    await f.call('devflow_set_scope', {
      summary: 'Empty-state copy for the interface layer.',
      inScope: ['docs/secret/ui.js empty-state copy branches'],
      maxModifiedFiles: 1, maxToolSteps: 15,
      completionCriteria: ['Empty-state copy differs per filter.'],
    }, f.parent)
    const task = await f.task('Fix app/secret/ui.js empty-state copy branches.', 'reviewing')

    const execution = await f.call('devflow_dispatch_agent', { agentId: f.child.agentId, taskId: task.id }, f.parent)

    expect(execution.isError).toBe(true)
    expect(JSON.stringify(execution)).toContain('DEVFLOW_DISPATCH_SCOPE_CONFLICT')
    expect(f.start).not.toHaveBeenCalled()
  })

  it('refuses bounds whose path shares only a grandparent with the task text', async () => {
    // 活机验收当场抓到的回退（2026-09-23，重启后的 PID 7576）：把"边界的每一个祖先"都当作可被解释
    // 的位置之后，`docs/secret/overview.md` 会被任务里的 `docs\overview.md` 解释掉 —— 两边都含
    // `docs`，于是真矛盾被放行。现在按**同源**判定（相等，或一方是另一方的分段前缀），
    // 共同祖先 `docs` 不再能替两个不同的子路径背书。
    const f = await fixture()
    await f.call('devflow_set_scope', {
      summary: '只读核对红线条目原文。',
      inScope: ['docs/secret/overview.md 的红线条目'],
      maxModifiedFiles: 1, maxToolSteps: 15,
      completionCriteria: ['给出红线条目原文清单'],
    }, f.parent)
    const task = await f.task('核对 docs\\overview.md 的红线条目原文。', 'reviewing')

    const execution = await f.call('devflow_dispatch_agent', { agentId: f.child.agentId, taskId: task.id }, f.parent)

    expect(execution.isError).toBe(true)
    expect(JSON.stringify(execution)).toContain('DEVFLOW_DISPATCH_SCOPE_CONFLICT')
    expect(f.start).not.toHaveBeenCalled()
  })

  it('accepts a bounds directory written with a trailing slash when the task names it bare', async () => {
    // The counterweight to the case above, also found by the audit: a bounds DIRECTORY
    // written in directory form (`docs/日志/`) and a task naming the same directory bare
    // (`docs\日志`) describe ONE location. Reading only the holder directory refused this
    // legitimate handoff — a new false positive, i.e. the very defect this round removes.
    const f = await fixture()
    await f.call('devflow_set_scope', {
      summary: 'Notes archive layout.',
      inScope: ['docs/日志/ archive layout'],
      maxModifiedFiles: 1, maxToolSteps: 15,
      completionCriteria: ['The archive directory keeps its layout.'],
    }, f.parent)
    const task = await f.task('整理 docs\\日志 的内容与顺序。', 'reviewing')

    const execution = await f.call('devflow_dispatch_agent', { agentId: f.child.agentId, taskId: task.id }, f.parent)

    expect(execution.isError).toBe(false)
    expect(JSON.stringify(execution)).not.toContain('DEVFLOW_DISPATCH_SCOPE_CONFLICT')
    expect(f.start).toHaveBeenCalled()
    expect(Object.values((await f.store.loadState()).executions)).toHaveLength(1)
  })

  it('★ hands over bounds whose only "locations" are Chinese prose using slashes', async () => {
    // 真机实测（2026-09-22，`D:\公众号agent`）：同一批 7 次误拒里有 4 次的唯一原因是中文散文把 `/`
    // 当"或"用（`暂停/继续/每轮复制`、`成立/不成立/无法判定`），被判据当成"自成位置的路径"。
    // 判定侧现在要求首段是 ASCII，这类 token 只能"提及"、不能"判定"，合法派发不再被拒。
    const f = await fixture()
    await f.call('devflow_set_scope', {
      summary: 'Empty-state copy for the interface layer.',
      inScope: ['src/js/ui.js 拷贝分支', '暂停/继续/每轮复制 的说明'],
      maxModifiedFiles: 1, maxToolSteps: 15,
      completionCriteria: ['Empty-state copy differs per filter.'],
    }, f.parent)
    const task = await f.task('Fix src\\js\\ui.js 拷贝分支，支持暂停/继续/每轮复制。', 'reviewing')

    const execution = await f.call('devflow_dispatch_agent', { agentId: f.child.agentId, taskId: task.id }, f.parent)

    expect(execution.isError).toBe(false)
    expect(f.start).toHaveBeenCalled()
  })

  it('★ hands over bounds naming a deep path whose shorter ancestor the task names', async () => {
    // 真机同一批误拒的第 5 次：边界写 `.npm-cache/node_modules/dist/output/logs/config`，任务只写了
    // `.npm-cache/`。位置集合现在登记祖先链，短提及即可匹配深路径。
    const f = await fixture()
    await f.call('devflow_set_scope', {
      summary: 'Repository hygiene.',
      inScope: ['把产物写入 .npm-cache/node_modules/dist/output/logs/config'],
      maxModifiedFiles: 2, maxToolSteps: 15,
      completionCriteria: ['Cache directories stay ignored.'],
    }, f.parent)
    const task = await f.task('清理 .npm-cache/ 与 output/ 下的产物。', 'reviewing')

    const execution = await f.call('devflow_dispatch_agent', { agentId: f.child.agentId, taskId: task.id }, f.parent)

    expect(execution.isError).toBe(false)
    expect(f.start).toHaveBeenCalled()
  })

  it('★ hands over bounds that join several paths with a Chinese enumeration comma', async () => {
    // 真机同一批误拒的第 6/7 次：`server/、gzh-Skills/、docs/契约/、产品说明.md` 被当成**一个** token，
    // 判据位置 `server/、gzh-skills/、docs/契约` 任务文本永远不可能提到。全角顿号进入排除集后被拆开。
    const f = await fixture()
    await f.call('devflow_set_scope', {
      summary: 'Repository layout review.',
      inScope: ['核对 server/、gzh-Skills/、docs/契约/ 的目录'],
      maxModifiedFiles: 1, maxToolSteps: 15,
      completionCriteria: ['Layout matches the ADR.'],
    }, f.parent)
    const task = await f.task('核对 server/ 与 docs/契约/ 与 gzh-Skills/ 的目录结构。', 'reviewing')

    const execution = await f.call('devflow_dispatch_agent', { agentId: f.child.agentId, taskId: task.id }, f.parent)

    expect(execution.isError).toBe(false)
    expect(f.start).toHaveBeenCalled()
  })

  it('KNOWN GAP: bounds whose only location is a bare multi-segment directory are not judged', async () => {
    // Executable evidence for the residual gap the second audit measured — NOT an endorsement.
    // Bounds whose only path token is `docs/secret` (one separator, no trailing separator) are
    // invisible to the judging side, so the location check never runs and a contradictory bound
    // is handed over. The pre-step-16 heuristic behaved the same way (its `/secret` normalised
    // to no directory), so this round did not introduce it — but v1 (76a2c0f) did refuse it, and
    // closing it needs the bounds to carry structured locations: judging one-separator tokens
    // re-opens the throwaway `A/B` excuse this round removed, and demanding that EVERY location
    // be mentioned turns ordinary multi-location bounds into false refusals.
    // FLIP THIS TEST when the bounds carry structured locations.
    const f = await fixture()
    await f.call('devflow_set_scope', {
      summary: 'Empty-state copy for the interface layer.',
      inScope: ['paste the ui.js copy into docs/secret'],
      maxModifiedFiles: 1, maxToolSteps: 15,
      completionCriteria: ['Empty-state copy differs per filter.'],
    }, f.parent)
    const task = await f.task('Fix the ui.js empty-state copy without changing style.css.', 'reviewing')

    const execution = await f.call('devflow_dispatch_agent', { agentId: f.child.agentId, taskId: task.id }, f.parent)

    // KNOWN GAP: handed over, although the task names no location at all.
    expect(execution.isError).toBe(false)
    expect(f.start).toHaveBeenCalled()
  })

  it('KNOWN GAP: a shared two-separator prose token can still excuse a contradictory bound', async () => {
    // The other half of the same gap, pinned so a later round can prove it closed. `2026/09/21`
    // holds two separators, so it counts as a location on BOTH sides and ONE shared token is
    // enough to hand the package over — even though the bounds also name `docs/secret`, which
    // the task never mentions. Measured identically in all three heuristics (pre-step-16, v1,
    // v2): pre-existing, not introduced by this round.
    // FLIP THIS TEST when the bounds carry structured locations.
    const f = await fixture()
    await f.call('devflow_set_scope', {
      summary: 'Empty-state copy for the interface layer.',
      inScope: ['docs/secret/ui.js empty-state copy branches', '2026/09/21 的说明'],
      maxModifiedFiles: 1, maxToolSteps: 15,
      completionCriteria: ['Empty-state copy differs per filter.'],
    }, f.parent)
    const task = await f.task('Fix the ui.js 2026/09/21 说明 without changing style.css.', 'reviewing')

    const execution = await f.call('devflow_dispatch_agent', { agentId: f.child.agentId, taskId: task.id }, f.parent)

    // KNOWN GAP: handed over, although `docs/secret` is never mentioned.
    expect(execution.isError).toBe(false)
    expect(f.start).toHaveBeenCalled()
  })

  it('clears stale bounds and then dispatches the task with its own', async () => {
    const f = await fixture()
    await f.call('devflow_set_scope', {
      summary: 'Stale project bounds.', inScope: ['stale'], maxModifiedFiles: 1, maxToolSteps: 15,
      completionCriteria: ['Old criterion that belongs to another task.'],
    }, f.parent)
    const snake = await f.task(SNAKE_DESCRIPTION, 'reviewing')

    const cleared = await f.call('devflow_clear_scope', {}, f.parent)
    expect(cleared.isError).toBe(false)
    expect((cleared.value as { cleared: string }).cleared).toBe('project-default')
    expect(await f.store.getScope()).toBeUndefined()

    await f.call('devflow_set_scope', setScope(snake.id, 'Snake collision fix only.', SNAKE_CRITERIA), f.parent)
    const execution = await f.call('devflow_dispatch_agent', { agentId: f.child.agentId, taskId: snake.id }, f.parent)
    expect(execution.isError).toBe(false)

    const prompt = (f.requests[0]?.prompt[0] as { text?: string } | undefined)?.text ?? ''
    expect(prompt).toContain('Snake collision fix only.')
    expect(prompt).toContain(SNAKE_CRITERIA[0] ?? '')
    expect(prompt).not.toContain('Old criterion that belongs to another task.')
    expect(prompt).toContain('# DevFlow Result')
  })

  it('accepts whatever shape the cleaned-up project scope file has', async () => {
    const path = 'D:\\Deepseek\\Harness\\.devflow\\scope.json'
    const raw = await readFile(path, 'utf8').catch(() => undefined)
    if (raw === undefined) return
    const parsed = JSON.parse(raw) as {
      removed?: boolean; summary?: string; inScope?: string[]; maxModifiedFiles?: number
      maxToolSteps?: number; completionCriteria?: string[]
    }
    // The cleanup wrote the neutral placeholder, and a later
    // `devflow_clear_scope` on the live host replaced it with a tombstone; both
    // shapes must be readable, and neither may carry the E2E pollution.
    expect(JSON.stringify(parsed)).not.toContain('DevFlow-E2E')
    const rootDir = await mkdtemp(join(tmpdir(), 'devflow-scope-shape-'))
    roots.push(rootDir)
    const store = new DevFlowStore(new LocalFileSystem(new Context(), { cwd: rootDir, diffBasisMaxBytes: 1024 * 1024 }), './.devflow')
    if (parsed.removed === true) {
      await store.clearScope()
      expect(await store.getScope()).toBeUndefined()
      return
    }
    // Feed the exact file values through the store's own validation.
    const scope = await store.updateScope({
      summary: parsed.summary ?? '', inScope: parsed.inScope ?? [], maxModifiedFiles: parsed.maxModifiedFiles ?? 20,
      maxToolSteps: parsed.maxToolSteps ?? 200, completionCriteria: parsed.completionCriteria ?? ['placeholder'],
    })
    expect(scope.summary).toBe('')
    expect(scope.inScope).toEqual([])
    expect(await store.getScope()).toMatchObject({ summary: '', inScope: [] })
  })
})

describe('Commander scope tooling', () => {
  it('exposes devflow_clear_scope and devflow_transition_task, and reads navigation without any writing tool', () => {
    const commander = DEFAULT_FIXED_AGENTS.find(agent => agent.agentId === 'commander')
    expect(commander?.tools).toContain('devflow_clear_scope')
    expect(commander?.tools).toContain('devflow_transition_task')
    // Step 8: the Commander reads the project's own navigation files at
    // kickoff, so exactly the three read-only lookups are allowed through.
    for (const readOnly of ['read', 'glob', 'grep']) {
      expect(commander?.tools).toContain(readOnly)
    }
    // ...and nothing that can change the workspace may ever join them.
    for (const writing of ['write', 'edit', 'pwsh', 'str_replace_editor']) {
      expect(commander?.tools).not.toContain(writing)
    }
  })

  it('shows both tools and the read-only lookups in the Commander\'s restricted view', () => {
    const ctx = new Context()
    new SystemPrompt(ctx, {})
    const tools = new ToolRuntime(ctx)
    for (const name of ['devflow_clear_scope', 'devflow_transition_task', 'devflow_set_scope', 'read', 'glob', 'grep', 'write', 'edit', 'pwsh']) tools.register(nativeTool(name))
    const agent = { id: 'commander-scope-tools' } as Agent
    const scope = createScope(ctx, agent)
    Object.assign(agent, { ctx: scope.ctx })

    new CommanderMode('persona').enter(agent, 'project-1')

    const visible = tools.schemas(agent).map(schema => schema.name)
    expect(visible).toContain('devflow_clear_scope')
    expect(visible).toContain('devflow_transition_task')
    expect(visible).toContain('read')
    expect(visible).toContain('glob')
    expect(visible).toContain('grep')
    expect(visible).not.toContain('write')
    expect(visible).not.toContain('edit')
    expect(visible).not.toContain('pwsh')
  })
})
