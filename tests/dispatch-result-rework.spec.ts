import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentResult, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseResultMarkdown } from '../src/host/markdown-bridge.ts'
import { PROTOCOL_VERSION } from '../src/host/protocol.ts'
import { DevFlowStore } from '../src/host/storage.ts'
import { registerDevFlowTools } from '../src/host/tools.ts'
import { TaskWorkflow } from '../src/host/workflow.ts'
import { AgentWorkflow } from '../src/host/workflow-agent.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** A well-formed result document for `taskId`. */
function resultDocument(taskId: string, verdict = 'accepted'): string {
  return [
    '# DevFlow Result', '', '## Metadata', '', `Protocol Version: ${PROTOCOL_VERSION}`, `Task ID: ${taskId}`, `Verdict: ${verdict}`, '',
    '## Summary', '', 'Fixed the reported defect.', '', '## Changes', '', '- Updated the fixture file.', '',
    '## Verification', '', '- Ran the focused check.', '', '## Issues', '', '- None', '', '## Next Steps', '', '- None',
  ].join('\n')
}

describe('result document extraction tolerance', () => {
  it('parses a result document wrapped in surrounding natural language', () => {
    const taskId = 'task-rework-prose'
    const reply = [
      '我已经把审计提出的缺陷修好了，下面是结果。',
      '',
      resultDocument(taskId, 'changes-requested'),
      '',
      '如果还需要我继续处理，请告诉我。',
    ].join('\n')

    const parsed = parseResultMarkdown(reply)
    expect(parsed.taskId).toBe(taskId)
    expect(parsed.verdict).toBe('changes-requested')
    expect(parsed.summary).toBe('Fixed the reported defect.')
    expect(parsed.changes).toEqual(['Updated the fixture file.'])
  })

  it('parses a result document wrapped in a fenced code block', () => {
    const taskId = 'task-rework-fence'
    const reply = ['Here is the result document:', '', '```markdown', resultDocument(taskId), '```', ''].join('\n')

    const parsed = parseResultMarkdown(reply)
    expect(parsed.taskId).toBe(taskId)
    expect(parsed.verdict).toBe('accepted')
    expect(parsed.nextSteps).toEqual(['None'])
  })

  it('still fails when the result heading is absent', () => {
    expect(() => parseResultMarkdown('I fixed it. Everything works now.')).toThrow(/DevFlow Result/)
  })
})

type ChildReply =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'stopped'; readonly stopReason: 'error' | 'aborted' }

/** Dispatch one task whose stored status may already be `reviewing` (rework). */
async function dispatch(options: {
  readonly replies: readonly ChildReply[]
  readonly status?: 'planned' | 'reviewing'
}) {
  const rootDir = await mkdtemp(join(tmpdir(), 'devflow-rework-'))
  roots.push(rootDir)
  const ctx = new Context()
  const store = new DevFlowStore(new LocalFileSystem(ctx, { cwd: rootDir, diffBasisMaxBytes: 1024 * 1024 }), './.devflow')
  const workflow = new TaskWorkflow(store)
  const agentWorkflow = new AgentWorkflow(store, workflow)
  const now = '2026-09-10T00:00:00.000Z'
  await store.saveProject({ id: 'project-rework', name: 'Rework', goal: 'Fix the audit finding', currentStage: 'implementation', createdAt: now, updatedAt: now })
  const child = await store.registerAgent({
    agentId: 'backend-engineer', kind: 'fixed', role: 'backend-engineer', delegationDepth: 0,
    prompt: 'Backend fixture', modelConfig: { model: 'deepseek-chat' }, tools: ['read', 'write'], capabilities: [], skills: [],
  })
  const phase = await store.createPhase({ name: 'Implementation', description: 'rework', status: 'in_progress' })
  const task = await store.createTask({
    title: 'Fix the audited defect', description: 'Apply the audit finding.', status: options.status ?? 'planned', assignedRole: 'backend-engineer',
  })
  const assignment = await store.createAssignment({ taskId: task.id, phaseId: phase.id, agentId: child.agentId, role: child.role, status: 'assigned' })

  const requests: SubagentStartRequest[] = []
  let call = 0
  const start = vi.fn(async (_provider: string, input: SubagentStartRequest) => {
    requests.push(input)
    const reply = options.replies[Math.min(call, options.replies.length - 1)]
    call += 1
    const settled: SubagentResult = reply?.kind === 'stopped'
      ? { stopReason: reply.stopReason, output: [] }
      : { stopReason: 'completed', output: [{ type: 'text', text: (reply?.text ?? '').replaceAll('__TASK_ID__', task.id) } satisfies ContentBlock] }
    return { id: `child-run-${call}` as never, localAgent: undefined, result: Promise.resolve(settled), dispose: async () => {} }
  })
  ctx.provide('subagents', { start })
  new SystemPrompt(ctx, {})
  const tools = new ToolRuntime(ctx)
  registerDevFlowTools(ctx, { store, workflow, agentWorkflow })
  await Promise.resolve()
  const parent = { id: 'commander-parent', options: {}, session: { header: {} }, ctx } as unknown as Agent

  const execution = await tools.execute({
    callId: 'dispatch-rework' as never,
    name: 'devflow_dispatch_agent',
    arguments: { agentId: child.agentId, taskId: task.id },
    agent: parent,
    signal: new AbortController().signal,
  })
  return { execution, requests, start, store, workflow, child, task, assignment, tools, parent }
}

describe('rework dispatch result handling', () => {
  it('re-exports the task markdown with the Required Result Format on the rework path', async () => {
    const f = await dispatch({ replies: [{ kind: 'text', text: '' }], status: 'reviewing' })

    const prompt = (f.requests[0]?.prompt[0] as { text?: string } | undefined)?.text ?? ''
    expect(prompt).toContain('# DevFlow Task')
    expect(prompt).toContain('## Required Result Format')
    expect(prompt).toContain('# DevFlow Result')
    expect(prompt).toContain(`Task ID: ${f.task.id}`)
    expect(prompt).toContain('Verdict: accepted|changes-requested|rejected')
  })

  it('accepts a rework reply that is wrapped in prose after one clean parse', async () => {
    const f = await dispatch({
      replies: [{ kind: 'text', text: `修复完成。\n\n${resultDocument('__TASK_ID__', 'changes-requested')}\n\n以上。` }],
      status: 'reviewing',
    })

    expect(f.execution.isError).toBe(false)
    expect(f.start).toHaveBeenCalledTimes(1)
    expect(await f.store.listResultsByTask(f.task.id)).toHaveLength(1)
  })

  it('retries once with a stricter instruction when the first reply has no result document', async () => {
    const f = await dispatch({ replies: [{ kind: 'text', text: 'I fixed everything, see my notes above.' }] })
    // The second reply is the same fixture reply (index clamped) — the point of
    // this case is the retry itself, asserted below.
    expect(f.start).toHaveBeenCalledTimes(2)
    const retryPrompt = (f.requests[1]?.prompt[0] as { text?: string } | undefined)?.text ?? ''
    expect(retryPrompt).toContain('## Retry: Required Result Format')
    expect(retryPrompt).toContain('only the result document')
  })

  it('recovers when the retry returns a valid document', async () => {
    const f = await dispatch({
      replies: [
        { kind: 'text', text: 'Done — details in the diff.' },
        { kind: 'text', text: resultDocument('__TASK_ID__') },
      ],
    })

    expect(f.execution.isError).toBe(false)
    expect(f.start).toHaveBeenCalledTimes(2)
    expect(await f.store.listResultsByTask(f.task.id)).toHaveLength(1)
    const state = await f.store.loadState()
    expect(Object.values(state.agentReports)[0]).toMatchObject({ status: 'success' })
  })

  it.each([
    ['missing verdict', (taskId: string) => resultDocument(taskId).replace(/^Verdict: .*$/m, '')],
    ['invalid verdict', (taskId: string) => resultDocument(taskId).replace(/^Verdict: .*$/m, 'Verdict: done')],
    ['missing summary', (taskId: string) => resultDocument(taskId).replace('Fixed the reported defect.', '')],
  ])('rejects (never aborts) a document with %s and keeps the records', async (_label, mutate) => {
    const f = await dispatch({ replies: [{ kind: 'text', text: mutate('placeholder') }] })
    const text = JSON.stringify(f.execution)

    expect(f.execution.isError).toBe(true)
    expect(text).toContain('DEVFLOW_DISPATCH_RESULT_REJECTED')
    expect(text).not.toContain('DEVFLOW_DISPATCH_ABORTED')
    expect(f.start).toHaveBeenCalledTimes(2)

    const state = await f.store.loadState()
    const execution = Object.values(state.executions)[0]
    const attempt = Object.values(state.executionAttempts)[0]
    const report = Object.values(state.agentReports)[0]
    expect(execution?.status).toBe('failed')
    expect(attempt?.status).toBe('failed')
    expect(report?.status).toBe('blocked')
    expect(state.assignments[f.assignment.assignmentId]?.status).toBe('assigned')
    expect(state.tasks[f.task.id]).toBe('failed')
    const durable = JSON.stringify({ report, journal: await f.store.listJournal() })
    for (const unsafe of ['I fixed everything', 'C:\\', 'prompt']) expect(durable).not.toContain(unsafe)
  })

  it('reports which field was missing when the retry also fails', async () => {
    const f = await dispatch({
      replies: [
        { kind: 'text', text: 'prose only' },
        { kind: 'text', text: ['# DevFlow Result', '', '## Metadata', '', `Protocol Version: ${PROTOCOL_VERSION}`, 'Task ID: t', 'Verdict: maybe', '', '## Summary', '', 'x'].join('\n') },
      ],
    })

    expect(f.execution.isError).toBe(true)
    const text = JSON.stringify(f.execution)
    expect(text).toContain('DEVFLOW_DISPATCH_RESULT_REJECTED')
    expect(text).toMatch(/Verdict|verdict/)
    const report = Object.values((await f.store.loadState()).agentReports)[0]
    expect(report?.summary).toMatch(/Verdict|verdict/)
    expect(report?.summary).not.toContain('prose only')
  })
})
