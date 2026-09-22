import { describe, expect, it, vi } from 'vitest'
import { createDevFlowClientSnapshot } from '../src/host/client-snapshot.ts'
import { initialDevFlowState } from '../src/host/state.ts'
import type { DevflowController } from '../src/host/index.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { testReadStore, testScopeResolver } from './support/session-scope.ts'

function controller(state = initialDevFlowState(), tasks: readonly object[] = [], results: readonly object[] = []) {
  const store = testReadStore(state, tasks, results)
  return {
    readState: () => state,
    resolveSessionScope: testScopeResolver(store),
    store,
    commanderMode: { current: vi.fn(() => ({ mode: 'commander', sessionId: 's-1', projectId: 'p-1', changedAt: 'now' })) },
  } as unknown as DevflowController
}

describe('DevFlow client snapshot adapter', () => {
  it('maps project, agents, tasks, phases, assignments, executions and decisions to a safe DTO', async () => {
    const state = initialDevFlowState()
    const project = { id: 'p-1', name: 'M5', goal: 'canvas', currentStage: 'build', createdAt: 'a', updatedAt: 'b' }
    state.project = project
    state.orchestrationAgents['commander'] = {
      agentId: 'commander', kind: 'fixed', role: 'planner', status: 'active', prompt: 'secret',
      modelConfig: { model: 'deepseek-chat', apiKey: 'secret' }, tools: ['read'], capabilities: [], skills: [], delegationDepth: 0,
      createdAt: 'a', updatedAt: 'b',
    }
    state.agents.push({ id: 'commander', role: 'planner', displayName: 'Commander', description: 'private', metadata: { secret: true }, createdAt: 'a', updatedAt: 'b' })
    state.phases['phase-1'] = { id: 'phase-1', name: 'Build', description: 'Ship it', status: 'in_progress', createdAt: 'a', updatedAt: 'b' }
    state.assignments['assignment-1'] = { assignmentId: 'assignment-1', taskId: 'task-1', phaseId: 'phase-1', agentId: 'commander', role: 'planner', status: 'in_progress', createdAt: 'a', updatedAt: 'b' }
    state.executions['execution-1'] = { executionId: 'execution-1', batchId: 'batch-1', assignmentId: 'assignment-1', agentId: 'commander', taskId: 'task-1', status: 'running', startedAt: 'b', completedAt: null, createdAt: 'a', updatedAt: 'b' }
    state.commanderDecisions['decision-1'] = { decisionId: 'decision-1', projectId: 'p-1', checkpointId: null, relatedExecutionIds: [], decisionType: 'continue', summary: 'go', nextAction: 'ship', createdAt: 'b', updatedAt: 'b' }
    state.decisionRequests['request-1'] = { requestId: 'request-1', projectId: 'p-1', taskId: 'task-1', trigger: 'ambiguity', question: 'Which path?', options: [{ id: 'a', label: 'A', description: 'first', recommended: true }], allowCustom: true, status: 'pending', answer: null, createdAt: 'b', answeredAt: null }
    const snapshot = await createDevFlowClientSnapshot(controller(state, [{ id: 'task-1', title: 'Task', description: 'Do', status: 'executing', assignedRole: 'planner', updatedAt: 'b' }]), { id: 's-1' } as Agent)
    expect(snapshot.version).toBe(1)
    expect(snapshot.project).toEqual({ id: 'p-1', name: 'M5', goal: 'canvas', currentStage: 'build' })
    expect(snapshot.agents[0]).toMatchObject({ id: 'commander', displayName: 'Commander', model: 'deepseek-chat' })
    expect(snapshot.agents[0]).not.toHaveProperty('apiKey')
    expect(snapshot.tasks[0]).toMatchObject({ id: 'task-1', title: 'Task', status: 'executing' })
    expect(snapshot.assignments[0]).toMatchObject({ id: 'assignment-1', taskId: 'task-1' })
    expect(snapshot.executions[0]).toMatchObject({ id: 'execution-1', assignmentId: 'assignment-1', status: 'running' })
    expect(snapshot.decisionRequests[0]?.status).toBe('pending')
  })

  it('projects bounded result, report, attempt, and failure summaries without unsafe fields', async () => {
    const state = initialDevFlowState()
    state.executions['execution-safe'] = {
      executionId: 'execution-safe', batchId: 'batch-1', assignmentId: 'assignment-1', agentId: 'agent-1', taskId: 'task-1',
      status: 'failed', startedAt: '2026-08-29T10:00:00.000Z', completedAt: '2026-08-29T10:01:00.000Z',
      createdAt: '2026-08-29T09:59:00.000Z', updatedAt: '2026-08-29T10:01:00.000Z',
    }
    state.agentReports['report-safe'] = {
      reportId: 'report-safe', executionId: 'execution-safe', agentId: 'agent-1', status: 'failed',
      summary: 'apiKey=fixture-secret should never be shown', outputReference: 'C:\\Users\\fixture\\raw-output.txt',
      modifiedFiles: ['C:\\Users\\fixture\\secret.ts'], toolStepCount: 99, completedCriteria: ['raw tool output'],
      createdAt: '2026-08-29T10:01:00.000Z', updatedAt: '2026-08-29T10:02:00.000Z',
    }
    state.executionAttempts['attempt-first'] = {
      attemptId: 'attempt-first', executionId: 'execution-safe', parentAttemptId: null, status: 'failed', reason: 'token=fixture-token',
      createdAt: '2026-08-29T10:00:00.000Z', completedAt: '2026-08-29T10:01:00.000Z', updatedAt: '2026-08-29T10:01:00.000Z',
    }
    state.executionAttempts['attempt-retry'] = {
      attemptId: 'attempt-retry', executionId: 'execution-safe', parentAttemptId: 'attempt-first', status: 'running', reason: 'retry',
      createdAt: '2026-08-29T10:03:00.000Z', completedAt: null, updatedAt: '2026-08-29T10:03:00.000Z',
    }
    const longText = 'ordinary '.repeat(80)
    const snapshot = await createDevFlowClientSnapshot(
      controller(
        state,
        [{ id: 'task-1', title: 'Task', description: 'Do', status: 'failed', updatedAt: 'b' }],
        [{ id: 'result-1', taskId: 'task-1', summary: longText, changes: Array.from({ length: 21 }, () => 'change'), verification: [], issues: [], nextSteps: [], createdAt: '2026-08-29T10:04:00.000Z' }],
      ),
      { id: 's-1' } as Agent,
    )

    expect(snapshot.results).toHaveLength(1)
    expect(snapshot.results?.[0]?.summary).toMatchObject({ truncated: true })
    expect(snapshot.results?.[0]?.summary.text.length).toBe(500)
    expect(snapshot.results?.[0]?.summary.text).not.toContain('fixture-secret')
    expect(snapshot.results?.[0]?.summary.redacted).toBe(false)
    expect(snapshot.reports).toEqual([expect.objectContaining({ summary: { text: 'Sensitive content is hidden.', truncated: false, redacted: true } })])
    expect(snapshot.attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'attempt-first', isRetry: false }),
      expect.objectContaining({ id: 'attempt-retry', isRetry: true }),
    ]))
    expect(snapshot.failures).toEqual([expect.objectContaining({ source: 'report', summary: expect.objectContaining({ redacted: true }) })])
    const serialized = JSON.stringify(snapshot)
    expect(serialized).not.toContain('fixture-secret')
    expect(serialized).not.toContain('fixture-token')
    expect(serialized).not.toContain('raw-output')
    expect(serialized).not.toContain('Users')
    expect(serialized).not.toContain('tool output')
    expect(serialized).not.toContain('outputReference')
    expect(serialized).not.toContain('apiKey')
    expect(serialized).not.toContain('reason')
    expect(serialized.length).toBeLessThan(40_000)
  })

  it('emits a no-detail failure fact when a failed execution has no safe report', async () => {
    const state = initialDevFlowState()
    state.executions['execution-failed'] = {
      executionId: 'execution-failed', batchId: 'batch-1', assignmentId: 'assignment-1', agentId: 'agent-1', taskId: 'task-1',
      status: 'failed', startedAt: '2026-08-29T10:00:00.000Z', completedAt: '2026-08-29T10:01:00.000Z',
      createdAt: '2026-08-29T09:59:00.000Z', updatedAt: '2026-08-29T10:01:00.000Z',
    }
    const snapshot = await createDevFlowClientSnapshot(controller(state), { id: 's-1' } as Agent)
    expect(snapshot.failures).toEqual([expect.objectContaining({ source: 'execution', summary: null })])
  })
})
