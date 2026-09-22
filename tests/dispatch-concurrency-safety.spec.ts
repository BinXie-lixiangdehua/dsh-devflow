/**
 * 第十三步 段一｜并发写入安全证明（前置门）+ 段二 在飞上限谓词。
 *
 * `isConcurrencySafe` 是一句**对宿主的承诺**："本工具可以并发执行而不会互踩"。所以在
 * 声明它之前，这个文件先用**受控实测**回答 PM §5.2 的四条：
 *
 *  1. **journal append 的并发**：两个派发各写多条 journal，序号必须唯一、连续、
 *     不丢、不覆盖，head 恰好推进到总数。
 *  2. **任务状态推进的原子性**：`prepareTaskForDispatch` 的 `planTask →
 *     startExecution → 写 execution` 之间是窗口；两条派发必须各自把**自己的**任务
 *     推到 `executing`，两条 execution 记录都真的存在。
 *  3. **store 实体写入**：task / assignment / execution 的读-改-写并发下不得丢更新
 *     （每条记录的字段必须等于**它自己**那次写入的值）。
 *  4. **内存态 / 投影缓存**：并发结束后重新构造一个 store 重新读盘，必须得到同一份
 *     事实（证明没有只活在内存里的中间态被当成事实）。
 *
 * 用**临时工作区 + 出厂固件**（`@deepseek-ai/dsh-fs-local` + 内存 subagents 替身），
 * **不读任何真实 `.devflow`**，可反复运行。
 *
 * ⚠️ 这个文件写的是**真实工具** `devflow_dispatch_agent`（`tools.execute`），不是替身：
 * 被证明的必须是生产路径本身。
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentResult, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { DEVFLOW_CONCURRENCY_LIMIT } from '../src/contract.ts'
import { DevFlowStore } from '../src/host/storage.ts'
import { AgentWorkflow } from '../src/host/workflow-agent.ts'
import { TaskWorkflow } from '../src/host/workflow.ts'
import { inFlightDispatchCount, registerDevFlowTools } from '../src/host/tools.ts'

const roots: string[] = []
/** Children left open by a failed assertion, so teardown can settle them. */
let openRuns: DeferredRun[] = []

afterEach(async () => {
  // Drain first: an un-settled child would (a) leak a module-scope in-flight slot into
  // the next test and (b) keep writing into a directory being removed.
  for (const run of openRuns.splice(0)) run.release()
  openRuns = []
  // Wait for every tool body to actually leave the in-flight set. The module-scope
  // counter is real state, so leaving five bodies parked would corrupt the NEXT test's
  // premise — the clean-up has to be as deterministic as the assertions.
  const deadline = Date.now() + 8000
  while (inFlightDispatchCount() !== 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

interface DeferredRun {
  readonly taskId: string
  readonly release: () => void
}

/** A minimal accepted result document for one task. */
function resultDocument(taskId: string): string {
  return [
    '# DevFlow Result', '', '## Metadata', '', 'Protocol Version: 0.4', `Task ID: ${taskId}`, 'Verdict: accepted', '',
    '## Summary', '', 'Concurrency safety fixture result.', '', '## Changes', '', '- None', '',
    '## Verification', '', '- Fixture result.', '', '## Issues', '', '- None', '', '## Next Steps', '', '- None',
  ].join('\n')
}

const EMPLOYEES = ['backend-engineer', 'frontend-engineer', 'architect'] as const

/**
 * Build one temp project with N planned tasks, each assigned to its own employee,
 * and a `subagents.start` double whose child runs stay open until the test releases
 * them — so every dispatch is genuinely INSIDE its write window at the same time.
 */
async function harness(count: number) {
  const rootDir = await mkdtemp(join(tmpdir(), 'devflow-step13-concurrency-'))
  roots.push(rootDir)
  const ctx = new Context()
  const store = new DevFlowStore(new LocalFileSystem(ctx, { cwd: rootDir, diffBasisMaxBytes: 1024 * 1024 }), './.devflow')
  const workflow = new TaskWorkflow(store)
  const agentWorkflow = new AgentWorkflow(store, workflow)
  const now = '2026-09-21T00:00:00.000Z'
  await store.saveProject({ id: 'project-concurrency', name: 'Concurrency', goal: 'Prove parallel writes are safe', currentStage: 'implementation', createdAt: now, updatedAt: now })

  const phase = await store.createPhase({ name: 'Parallel', description: 'concurrency proof', status: 'in_progress' })
  // One employee per task, so each dispatch owns a distinct assignment (a task may not
  // be dispatched twice) while the STORE, journal and caches they share stay shared.
  const tasks: { taskId: string; agentId: string; assignmentId: string }[] = []
  for (let index = 0; index < count; index += 1) {
    const base = EMPLOYEES[index % EMPLOYEES.length] as string
    const agentId = count <= EMPLOYEES.length ? base : `${base}-${index}`
    const role = base === 'architect' ? 'planner' as const : base === 'backend-engineer' ? 'backend-engineer' as const : 'frontend-engineer' as const
    await store.registerAgent({
      agentId, kind: 'fixed', role, delegationDepth: 0, prompt: `${agentId} fixture`,
      modelConfig: { model: 'deepseek-chat' }, tools: [], capabilities: [], skills: [],
    })
    const task = await store.createTask({ title: `Parallel task ${index}`, description: `Concurrency fixture ${index}`, status: 'planned', assignedRole: role })
    const assignment = await store.createAssignment({ taskId: task.id, phaseId: phase.id, agentId, role, status: 'assigned' })
    tasks.push({ taskId: task.id, agentId, assignmentId: assignment.assignmentId })
  }

  const pending: DeferredRun[] = []
  let startedCount = 0
  const start = async (_provider: string, input: SubagentStartRequest) => {
    const text = input.prompt.map(block => (block.type === 'text' ? block.text : '')).join('')
    const taskId = /Task ID:\s*([0-9a-f-]{36})/i.exec(text)?.[1] ?? ''
    let release!: () => void
    // The child run stays OPEN until the test releases it, so every dispatch is inside
    // its write window (journal + entity records already committed) at the same time.
    const gate = new Promise<SubagentResult>(resolve => {
      release = () => { resolve({ stopReason: 'completed', output: [{ type: 'text', text: resultDocument(taskId) } satisfies ContentBlock] }) }
    })
    pending.push({ taskId, release })
    startedCount += 1
    return { id: `run-${pending.length}` as never, localAgent: undefined, result: gate, dispose: async () => {} }
  }

  ctx.provide('subagents', { start })
  new SystemPrompt(ctx, {})
  const tools = new ToolRuntime(ctx)
  registerDevFlowTools(ctx, { store, workflow, agentWorkflow })
  await Promise.resolve()
  const parent = { id: 'commander-parent', options: {}, session: { header: { cwd: rootDir } } } as unknown as Agent
  const parentScope = createScope(ctx, parent)
  Object.assign(parent, { ctx: parentScope.ctx })

  const dispatch = (entry: { taskId: string; agentId: string }, callId: string) => tools.execute({
    callId: callId as never,
    name: 'devflow_dispatch_agent',
    arguments: { agentId: entry.agentId, taskId: entry.taskId },
    agent: parent,
    signal: new AbortController().signal,
  })

  openRuns = pending
  return {
    rootDir, store, tasks, pending, dispatch, tools, parent,
    /** How many children the runtime has actually started (deterministic, not timed). */
    startedCount: () => startedCount,
    /**
     * The host's own read of the predicate, with arguments that really validate:
     * `defineTool` fails CLOSED on invalid input (its wrapper answers `false`), so a
     * probe with `{}` would report `exclusive` for the wrong reason and prove nothing.
     */
    executionMode: (agentId: unknown, taskId: unknown) => tools.executionMode({
      callId: 'mode-probe' as never,
      name: 'devflow_dispatch_agent',
      arguments: { agentId, taskId },
      agent: parent,
      signal: new AbortController().signal,
    }).kind,
  }
}

/** Poll until the predicate holds, so the test never guesses at a fixed delay. */
async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/**
 * Settle every open child and wait for the in-flight counter to reach the next value.
 *
 * One at a time on purpose: the counter is monotone down, so the expected value after
 * each release is exact.
 */
async function drain(f: { pending: DeferredRun[] }): Promise<void> {
  for (const run of f.pending.splice(0)) {
    const expected = inFlightDispatchCount() - 1
    run.release()
    await waitUntil(() => inFlightDispatchCount() <= expected, 'one dispatch to leave the in-flight set')
  }
}

describe('第十三步 段一：并发写入安全证明', () => {
  it('runs two dispatches through their write windows at the same time without losing a journal entry', { timeout: 30_000 }, async () => {
    const f = await harness(2)
    const first = f.tasks[0] as { taskId: string; agentId: string }
    const second = f.tasks[1] as { taskId: string; agentId: string }

    const a = f.dispatch(first, 'call-a')
    const b = f.dispatch(second, 'call-b')

    // BOTH prefixes must complete while BOTH children are still open — that is the
    // overlap being proven, not an assumption about scheduling.
    await waitUntil(() => f.pending.length === 2, 'two children to start')
    expect(inFlightDispatchCount()).toBe(2)

    const journal = await f.store.listJournal()
    const head = JSON.parse(await readFile(join(f.rootDir, '.devflow', 'journal', 'head.json'), 'utf8')) as { nextSequence: number }

    // (1) journal: unique, contiguous, nothing dropped, head == count.
    const sequences = journal.map(entry => entry.sequence)
    expect(new Set(sequences).size).toBe(sequences.length)
    expect([...sequences].sort((left, right) => left - right)).toEqual(Array.from({ length: journal.length }, (_, index) => index))
    expect(head.nextSequence).toBe(journal.length)
    // Both dispatches wrote their own execution start and bridge export.
    const kinds = journal.map(entry => entry.type)
    expect(kinds.filter(kind => kind === 'devflow/execution/start')).toHaveLength(2)
    expect(kinds.filter(kind => kind === 'devflow/task/transition')).toHaveLength(2)

    // (2)(3) tasks + executions: each record carries ITS OWN write, no lost update.
    const state = await f.store.loadState()
    expect(state.tasks[first.taskId]).toBe('executing')
    expect(state.tasks[second.taskId]).toBe('executing')
    const executions = Object.values(state.executions)
    expect(executions).toHaveLength(2)
    expect(executions.every(execution => execution.status === 'running')).toBe(true)
    expect(new Set(executions.map(execution => execution.taskId))).toEqual(new Set([first.taskId, second.taskId]))
    expect(new Set(executions.map(execution => execution.batchId)).size).toBe(2)
    // One active assignment per dispatch, each moved to in_progress by its own call.
    const assignments = Object.values(state.assignments).filter(assignment => assignment.status === 'in_progress')
    expect(assignments).toHaveLength(2)
    expect(new Set(assignments.map(assignment => assignment.taskId))).toEqual(new Set([first.taskId, second.taskId]))

    // Release the children and let both dispatches settle.
    await drain(f)
    const [resultA, resultB] = await Promise.all([a, b])
    expect(resultA.isError).toBe(false)
    expect(resultB.isError).toBe(false)
    expect(inFlightDispatchCount()).toBe(0)

    // (4) a FRESH store reading the same root must agree — no fact lived only in memory.
    const reread = new DevFlowStore(new LocalFileSystem(new Context(), { cwd: f.rootDir, diffBasisMaxBytes: 1024 * 1024 }), './.devflow')
    const after = await reread.loadState()
    expect(after.tasks[first.taskId]).toBe('reviewing')
    expect(after.tasks[second.taskId]).toBe('reviewing')
    expect(Object.values(after.executions)).toHaveLength(2)
    expect(Object.values(after.executions).every(execution => execution.status === 'completed')).toBe(true)
    expect(Object.values(after.agentReports)).toHaveLength(2)
  })

  it('keeps the journal contiguous under five simultaneous dispatches', { timeout: 30_000 }, async () => {
    // The explicit budget is not hiding a product problem: this case really does run FIVE
    // child dispatches through the whole write path (journal + planning + batch +
    // execution + attempt + bridge export each) and the suite runs files in parallel, so
    // the 5 s default is a harness limit, not a correctness signal. The production
    // behaviour it asserts is unchanged.
    const f = await harness(DEVFLOW_CONCURRENCY_LIMIT)
    const calls = f.tasks.map((entry, index) => f.dispatch(entry, `call-${index}`))
    await waitUntil(() => f.pending.length === DEVFLOW_CONCURRENCY_LIMIT, 'all children to start')
    expect(inFlightDispatchCount()).toBe(DEVFLOW_CONCURRENCY_LIMIT)
    await drain(f)
    const settled = await Promise.all(calls)
    expect(settled.every(result => result.isError === false)).toBe(true)
    expect(inFlightDispatchCount()).toBe(0)

    const journal = await f.store.listJournal()
    const sequences = journal.map(entry => entry.sequence)
    expect(new Set(sequences).size).toBe(sequences.length)
    expect([...sequences].sort((left, right) => left - right)).toEqual(Array.from({ length: journal.length }, (_, index) => index))
    const state = await f.store.loadState()
    expect(Object.keys(state.tasks)).toHaveLength(DEVFLOW_CONCURRENCY_LIMIT)
    expect(Object.values(state.tasks).every(status => status === 'reviewing')).toBe(true)
    expect(Object.values(state.executions)).toHaveLength(DEVFLOW_CONCURRENCY_LIMIT)
  })
})

describe('第十三步 段二：在飞计数与上限谓词', () => {
  it('holds the in-flight count at the limit and returns it to zero after every exit path', { timeout: 30_000 }, async () => {
    // The counter is a module fact: this test pins the limit's identity to the single
    // shared constant, so the host and the panel can never drift.
    expect(DEVFLOW_CONCURRENCY_LIMIT).toBe(5)

    const f = await harness(6)
    const probe = f.tasks[5] as { taskId: string; agentId: string }
    // Measured on an IDLE runtime: no dispatch in flight ⇒ the host reads `parallel`,
    // i.e. it is willing to overlap. (That is the answer the whole round turns on.)
    expect(inFlightDispatchCount()).toBe(0)
    expect(f.executionMode(probe.agentId, probe.taskId)).toBe('parallel')
    // The tool's OWN predicate is what the host reads; its presence is the declaration.
    const tool = f.tools.resolveExecution('devflow_dispatch_agent', f.parent, false)
    expect(tool?.isConcurrencySafe).toBeTypeOf('function')
    // A call whose arguments do not validate stays closed — the same fail-closed rule
    // that protects the host, asserted here so a later edit cannot make the predicate
    // "optimistic" for a malformed call.
    expect(f.tools.executionMode({
      callId: 'mode-probe' as never, name: 'devflow_dispatch_agent',
      arguments: { agentId: 42, taskId: null }, agent: f.parent, signal: new AbortController().signal,
    }).kind).toBe('exclusive')

    // Six calls submitted the way the HOST submits them: classify → start → classify.
    //
    // The host decides "can this call join a parallel group?" when it REACHES the call,
    // and it reaches call 2 only after call 1's body has started. Calling `tools.execute`
    // six times in a bare `map` would bump the counter six times synchronously BEFORE any
    // classification — that models "six already-running calls" and proves nothing about
    // the limit. An `exclusive` answer means "wait for the group, start this one alone",
    // so a sixth call must be recorded as blocked rather than awaited (awaiting it here
    // would deadlock: only this test can free the children).
    const started: Promise<{ isError: boolean }>[] = []
    const blocked: { entry: { taskId: string; agentId: string }; callId: string }[] = []
    for (let index = 0; index < f.tasks.length; index += 1) {
      const entry = f.tasks[index] as { taskId: string; agentId: string }
      const callId = `call-${index}`
      if (f.executionMode(entry.agentId, entry.taskId) === 'exclusive') blocked.push({ entry, callId })
      else started.push(f.dispatch(entry, callId))
      // Let a started body reach its first await, so the next classification sees the
      // truthful count (the counter is bumped synchronously at body entry).
      await new Promise(resolve => setTimeout(resolve, 0))
    }

    // The first five took slots; the sixth was refused a parallel group and is WAITING.
    await waitUntil(() => f.startedCount() === DEVFLOW_CONCURRENCY_LIMIT, 'five children to start')
    expect(blocked).toHaveLength(1)
    expect(inFlightDispatchCount()).toBe(DEVFLOW_CONCURRENCY_LIMIT)
    // AT the limit the classifier closes: `false` ⇒ `exclusive` ⇒ the call waits for the
    // running group to drain = 超限排队 (the safe direction).
    expect(f.executionMode(probe.agentId, probe.taskId)).toBe('exclusive')

    // Free the group. The queued dispatch then starts and must finish too, and the
    // counter must come all the way back to zero.
    for (const run of f.pending.splice(0)) run.release()
    // The queued call starts as soon as a slot frees. Its body must be RUNNING before
    // this test can drain it — `drain` splices `pending`, so a call started afterwards
    // would never be released.
    started.push(...blocked.map(item => f.dispatch(item.entry, item.callId)))
    await waitUntil(() => f.startedCount() === 6, 'the queued dispatch to start')
    await drain(f)
    const settled = await Promise.allSettled(started)
    expect(settled.every(item => item.status === 'fulfilled')).toBe(true)
    expect(inFlightDispatchCount()).toBe(0)
    // Released again once the queue drains.
    expect(f.executionMode(probe.agentId, probe.taskId)).toBe('parallel')
  })

  it('counts an early failure as released, so a rejected dispatch cannot leak a slot', { timeout: 20_000 }, async () => {
    const f = await harness(1)
    const only = f.tasks[0] as { taskId: string; agentId: string }
    // An unknown agent id fails BEFORE any state moves — one of the exit paths the
    // `finally` must cover.
    const failed = await f.tools.execute({
      callId: 'call-unknown' as never,
      name: 'devflow_dispatch_agent',
      arguments: { agentId: 'not-registered', taskId: only.taskId },
      agent: f.parent,
      signal: new AbortController().signal,
    })
    expect(failed.isError).toBe(true)
    expect(inFlightDispatchCount()).toBe(0)

    // And a successful dispatch returns the count to zero as well.
    const ok = f.dispatch(only, 'call-ok')
    await waitUntil(() => f.pending.length === 1, 'the child to start')
    expect(inFlightDispatchCount()).toBe(1)
    await drain(f)
    expect((await ok).isError).toBe(false)
    expect(inFlightDispatchCount()).toBe(0)
  })
})
