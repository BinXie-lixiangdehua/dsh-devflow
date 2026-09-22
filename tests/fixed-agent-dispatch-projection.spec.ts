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
import { createDevFlowClientSnapshot } from '../src/host/client-snapshot.ts'
import { DevFlowStore } from '../src/host/storage.ts'
import { registerDevFlowTools } from '../src/host/tools.ts'
import { TaskWorkflow } from '../src/host/workflow.ts'
import { AgentWorkflow } from '../src/host/workflow-agent.ts'
import type { DevflowController } from '../src/host/index.ts'
import { testScopeResolver } from './support/session-scope.ts'

const roots: string[] = []
const lure = 'token=fixture-secret C:\\Users\\fixture\\raw-output.txt /home/fixture/private'

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function result(taskId: string, summary = 'Read-only package script inspection completed.'): string {
  return [
    '# DevFlow Result', '', '## Metadata', '', 'Protocol Version: 0.4', `Task ID: ${taskId}`, 'Verdict: accepted', '',
    '## Summary', '', summary, '', '## Changes', '', '- None', '', '## Verification', '', '- Inspected package.json scripts.', '',
    '## Issues', '', '- None', '', '## Next Steps', '', '- None',
  ].join('\n')
}

type Scenario =
  | { readonly kind: 'success'; readonly summary?: string }
  | { readonly kind: 'stopped' }
  | { readonly kind: 'empty' }
  | { readonly kind: 'malformed' }
  | { readonly kind: 'mismatch' }
  | { readonly kind: 'import-failure' }

async function fixture(scenario: Scenario) {
  const rootDir = await mkdtemp(join(tmpdir(), 'devflow-p0c-'))
  roots.push(rootDir)
  const ctx = new Context()
  const store = new DevFlowStore(new LocalFileSystem(ctx, { cwd: rootDir, diffBasisMaxBytes: 1024 * 1024 }), './.devflow')
  const workflow = new TaskWorkflow(store)
  const agentWorkflow = new AgentWorkflow(store, workflow)
  const now = '2026-08-31T00:00:00.000Z'
  await store.saveProject({ id: 'project-p0c', name: 'P0C', goal: 'Trace fixed dispatch', currentStage: 'implementation', createdAt: now, updatedAt: now })
  const child = await store.registerAgent({
    agentId: 'backend-engineer', kind: 'fixed', role: 'backend-engineer', delegationDepth: 0,
    prompt: 'Backend fixture', modelConfig: { model: 'deepseek-chat' }, tools: ['read'], capabilities: [], skills: [],
  })
  const phase = await store.createPhase({ name: 'Implementation', description: 'P0C', status: 'in_progress' })
  const task = await store.createTask({ title: 'Inspect package scripts', description: 'Read package scripts only', status: 'planned', assignedRole: 'backend-engineer' })
  const assignment = await store.createAssignment({ taskId: task.id, phaseId: phase.id, agentId: child.agentId, role: child.role, status: 'assigned' })
  if (scenario.kind === 'import-failure') {
    vi.spyOn(agentWorkflow, 'submitResult').mockRejectedValue(new Error(`import failed ${lure}`))
  }

  let request: SubagentStartRequest | undefined
  let disposed = 0
  const start = vi.fn(async (_provider: string, input: SubagentStartRequest) => {
    request = input
    const runningState = await store.loadState()
    const batches = Object.values(runningState.executionBatches)
    const executions = Object.values(runningState.executions)
    const attempts = Object.values(runningState.executionAttempts)
    expect(batches).toHaveLength(1)
    expect(batches[0]).toMatchObject({ status: 'running', projectId: 'project-p0c', phaseIds: [phase.id], assignmentIds: [assignment.assignmentId] })
    expect(executions).toHaveLength(1)
    expect(executions[0]).toMatchObject({
      status: 'running', batchId: batches[0]!.batchId, assignmentId: assignment.assignmentId,
      agentId: child.agentId, taskId: task.id,
    })
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({ status: 'running', executionId: executions[0]!.executionId, parentAttemptId: null, reason: null })
    expect(runningState.assignments[assignment.assignmentId]?.status).toBe('in_progress')

    const output: ContentBlock[] = scenario.kind === 'stopped'
      ? [{ type: 'text', text: lure }]
      : scenario.kind === 'empty'
        ? []
        : scenario.kind === 'malformed'
          ? [{ type: 'text', text: `not markdown ${lure}` }]
          : scenario.kind === 'mismatch'
            ? [{ type: 'text', text: result('00000000-0000-4000-8000-000000000099') }]
            : [{ type: 'text', text: result(task.id, scenario.kind === 'success' ? scenario.summary : undefined) }]
    const settled: SubagentResult = {
      stopReason: scenario.kind === 'stopped' ? 'error' : 'completed',
      output,
      ...(scenario.kind === 'stopped' ? { diagnostic: lure } : {}),
    }
    return {
      id: 'child-run' as never,
      localAgent: undefined,
      result: Promise.resolve(settled),
      dispose: async () => { disposed += 1 },
    }
  })
  ctx.provide('subagents', { start })
  new SystemPrompt(ctx, {})
  const tools = new ToolRuntime(ctx)
  registerDevFlowTools(ctx, { store, workflow, agentWorkflow })
  await Promise.resolve()
  const parent = {
    id: 'commander-parent',
    options: {},
    session: { header: {} },
    ctx,
  } as unknown as Agent

  const execution = await tools.execute({
    callId: `dispatch-${scenario.kind}` as never,
    name: 'devflow_dispatch_agent',
    arguments: { agentId: child.agentId, taskId: task.id },
    agent: parent,
    signal: new AbortController().signal,
  })
  return { ctx, store, workflow, agentWorkflow, tools, task, phase, assignment, child, execution, request, start, disposed }
}

async function projected(store: DevFlowStore) {
  const controller = {
    readState: () => store.loadState(),
    resolveSessionScope: testScopeResolver(store),
    store,
    commanderMode: { current: () => ({ mode: 'commander' }) },
  } as unknown as DevflowController
  return createDevFlowClientSnapshot(controller, { id: 'commander-parent' } as Agent)
}

describe('fixed Agent direct dispatch projection', () => {
  it('persists and projects one successful execution chain', async () => {
    const f = await fixture({ kind: 'success' })
    expect(f.execution.isError).toBe(false)
    expect(f.start).toHaveBeenCalledTimes(1)
    expect(f.disposed).toBe(1)
    expect((f.request?.prompt[0] as { text?: string }).text).toContain('## Required Result Format')

    const state = await f.store.loadState()
    const batch = Object.values(state.executionBatches)[0]!
    const execution = Object.values(state.executions)[0]!
    const attempt = Object.values(state.executionAttempts)[0]!
    const report = Object.values(state.agentReports)[0]!
    const results = await f.store.listResultsByTask(f.task.id)
    expect(batch.status).toBe('completed')
    expect(execution).toMatchObject({ status: 'completed', assignmentId: f.assignment.assignmentId, agentId: f.child.agentId, taskId: f.task.id })
    expect(attempt).toMatchObject({ status: 'completed', executionId: execution.executionId, parentAttemptId: null })
    expect(results).toHaveLength(1)
    expect(report).toMatchObject({ status: 'success', executionId: execution.executionId, agentId: f.child.agentId, outputReference: `devflow:result:${results[0]!.id}` })
    expect(state.assignments[f.assignment.assignmentId]?.status).toBe('completed')
    expect(state.tasks[f.task.id]).toBe('reviewing')

    const snapshot = await projected(f.store)
    expect(snapshot.executions[0]).toMatchObject({ id: execution.executionId, assignmentId: f.assignment.assignmentId, status: 'completed' })
    expect(snapshot.attempts?.[0]).toMatchObject({ executionId: execution.executionId, status: 'completed' })
    expect(snapshot.reports?.[0]).toMatchObject({ executionId: execution.executionId, taskId: f.task.id, agentId: f.child.agentId, status: 'success' })
  })

  it('redacts a sensitive success summary before durable report storage', async () => {
    const f = await fixture({ kind: 'success', summary: lure })
    const reports = Object.values((await f.store.loadState()).agentReports)
    expect(reports).toHaveLength(1)
    expect(reports[0]?.summary).toBe('Sensitive content is hidden.')
    const serialized = JSON.stringify(reports)
    expect(serialized).not.toContain('fixture-secret')
    expect(serialized).not.toContain('raw-output')
    expect(serialized).not.toContain('/home/fixture')
  })

  it.each([
    ['stopped', 'DEVFLOW_DISPATCH_ERROR'],
    ['empty', 'DEVFLOW_DISPATCH_EMPTY_OUTPUT'],
    // A reply without an acceptable result document is a REJECTED outcome:
    // retryable, recorded, and never an abort. It replaced the old
    // `…RESULT_FORMAT_INVALID` code, which read as a hard failure.
    ['malformed', 'DEVFLOW_DISPATCH_RESULT_REJECTED'],
    ['mismatch', 'DEVFLOW_DISPATCH_TASK_MISMATCH'],
    ['import-failure', 'DEVFLOW_DISPATCH_RESULT_IMPORT_FAILED'],
  ] as const)('settles %s without leaking child data', async (kind, code) => {
    const f = await fixture({ kind })
    expect(f.execution.isError).toBe(true)
    expect(JSON.stringify(f.execution)).toContain(code)
    const state = await f.store.loadState()
    const batch = Object.values(state.executionBatches)[0]!
    const execution = Object.values(state.executions)[0]!
    const attempt = Object.values(state.executionAttempts)[0]!
    const report = Object.values(state.agentReports)[0]!
    expect(batch.status).toBe('completed')
    expect(execution.status).toBe('failed')
    expect(attempt.status).toBe('failed')
    // A rejected document is `blocked` (retry with the exact format); every
    // other stop reason stays a hard `failed`.
    expect(report).toMatchObject({
      status: kind === 'malformed' ? 'blocked' : 'failed',
      executionId: execution.executionId,
      agentId: f.child.agentId,
    })
    expect(state.assignments[f.assignment.assignmentId]?.status).toBe('assigned')
    expect(state.tasks[f.task.id]).toBe('failed')
    expect(await f.store.listResultsByTask(f.task.id)).toHaveLength(kind === 'import-failure' ? 0 : 0)
    expect([execution.status, attempt.status, state.assignments[f.assignment.assignmentId]?.status]).not.toContain('running')

    const snapshot = await projected(f.store)
    const durable = JSON.stringify({ report, journal: await f.store.listJournal() })
    const visible = JSON.stringify(snapshot)
    for (const text of ['fixture-secret', 'raw-output', 'Users', '/home/fixture', 'token=']) {
      expect(durable).not.toContain(text)
      expect(visible).not.toContain(text)
    }
    expect(snapshot.failures?.[0]).toMatchObject({
      executionId: execution.executionId,
      source: 'report',
      status: kind === 'malformed' ? 'blocked' : 'failed',
    })
  })
})
