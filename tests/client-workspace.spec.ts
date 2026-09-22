import { describe, expect, it } from 'vitest'
import type { DevFlowClientSnapshot } from '../src/contract.ts'
import {
  PROJECT_SELECTION,
  auditFilterForSelection,
  createWorkspaceModel,
  focusedPhaseIds,
  selectionExists,
  selectionParent,
  taskWorkStateLabel,
  workStateLabel,
} from '../src/client/workspace.ts'

function snapshot(overrides: Partial<DevFlowClientSnapshot> = {}): DevFlowClientSnapshot {
  return {
    version: 1,
    generatedAt: '2026-08-29T10:00:00.000Z',
    session: { id: 'session-a', commanderMode: 'commander' },
    paused: false,
    project: { id: 'project-a', name: 'Workspace', goal: 'Ship a view', currentStage: 'Build' },
    agents: [
      { id: 'idle-fixed', displayName: 'Idle fixed', role: 'planner', kind: 'fixed', status: 'active', model: 'model' },
      { id: 'working-fixed', displayName: 'Working fixed', role: 'backend-engineer', kind: 'fixed', status: 'active', model: 'model' },
      { id: 'done-fixed', displayName: 'Done fixed', role: 'reviewer', kind: 'fixed', status: 'active', model: 'model' },
      { id: 'blocked-fixed', displayName: 'Blocked fixed', role: 'frontend-engineer', kind: 'fixed', status: 'active', model: 'model' },
      { id: 'archived-temp', displayName: 'Archived temp', role: 'reviewer', kind: 'temporary', status: 'terminated', model: 'model' },
      { id: 'unknown-temp', displayName: 'Unknown temp', role: 'reviewer', kind: 'temporary', status: 'created', model: 'model' },
    ],
    tasks: [
      { id: 'task-working', title: 'Working task', description: 'Current work', status: 'executing', assignedRole: 'backend-engineer', updatedAt: '2026-08-29T09:00:00.000Z' },
      { id: 'task-completed', title: 'Completed task', description: 'Finished work', status: 'completed', updatedAt: '2026-08-29T08:00:00.000Z' },
      { id: 'task-blocked', title: 'Blocked task', description: 'Waiting work', status: 'planned', updatedAt: '2026-08-29T07:00:00.000Z' },
      { id: 'task-failed', title: 'Failed task', description: 'Retry work', status: 'failed', updatedAt: '2026-08-29T06:00:00.000Z' },
    ],
    phases: [
      { id: 'phase-b', name: 'Build', description: 'Implement', status: 'in_progress' },
      { id: 'phase-a', name: 'Plan', description: 'Plan it', status: 'completed' },
    ],
    assignments: [
      { id: 'assignment-working', taskId: 'task-working', phaseId: 'phase-b', agentId: 'working-fixed', role: 'backend-engineer', status: 'in_progress' },
      { id: 'assignment-completed', taskId: 'task-completed', phaseId: 'phase-a', agentId: 'done-fixed', role: 'reviewer', status: 'completed' },
      { id: 'assignment-blocked', taskId: 'task-blocked', phaseId: 'phase-b', agentId: 'blocked-fixed', role: 'frontend-engineer', status: 'assigned' },
      { id: 'assignment-failed', taskId: 'task-failed', phaseId: 'phase-b', agentId: 'unknown-temp', role: 'reviewer', status: 'assigned' },
    ],
    executions: [
      { id: 'execution-working', assignmentId: 'assignment-working', taskId: 'task-working', agentId: 'working-fixed', status: 'running', startedAt: '2026-08-29T09:30:00.000Z', completedAt: null },
      { id: 'execution-completed', assignmentId: 'assignment-completed', taskId: 'task-completed', agentId: 'done-fixed', status: 'completed', startedAt: '2026-08-29T07:30:00.000Z', completedAt: '2026-08-29T08:00:00.000Z' },
      { id: 'execution-failed', assignmentId: 'assignment-failed', taskId: 'task-failed', agentId: 'unknown-temp', status: 'failed', startedAt: '2026-08-29T05:30:00.000Z', completedAt: '2026-08-29T06:00:00.000Z' },
    ],
    decisions: [{ id: 'decision-1', type: 'continue', summary: 'Proceed', nextAction: 'Continue build', createdAt: '2026-08-29T09:15:00.000Z' }],
    decisionRequests: [{ id: 'request-1', taskId: 'task-blocked', trigger: 'ambiguity', question: 'Choose an implementation', options: [], status: 'pending' }],
    ...overrides,
  }
}

describe('P0A workspace view model', () => {
  it('uses stable ID fallback for phases and factual relationship helpers', () => {
    const model = createWorkspaceModel(snapshot())
    expect(model.phases.map(phase => phase.id)).toEqual(['phase-a', 'phase-b'])
    expect(model.assignmentsByPhase.get('phase-b')).toHaveLength(3)
    expect(focusedPhaseIds(model, { kind: 'task', id: 'task-working' })).toEqual(new Set(['phase-b']))
  })

  it('derives conservative work states without treating lifecycle as work', () => {
    const model = createWorkspaceModel(snapshot())
    const agent = (id: string) => model.agentById.get(id)?.workState
    expect(agent('idle-fixed')).toBe('idle')
    expect(agent('working-fixed')).toBe('working')
    expect(agent('done-fixed')).toBe('done')
    expect(agent('blocked-fixed')).toBe('blocked')
    expect(agent('archived-temp')).toBe('archived')
    expect(agent('unknown-temp')).toBe('unknown')
    expect(model.taskById.get('task-blocked')?.workState).toBe('blocked')
    expect(model.taskById.get('task-failed')?.workState).toBe('failed')
  })

  it('does not keep a fixed Agent working after its execution settles into review', () => {
    const reviewing = snapshot({
      tasks: [{ id: 'task-reviewing', title: 'Reviewing task', description: 'Awaiting review', status: 'reviewing', assignedRole: 'backend-engineer', updatedAt: '2026-08-29T10:00:00.000Z' }],
      assignments: [{ id: 'assignment-reviewing', taskId: 'task-reviewing', phaseId: 'phase-b', agentId: 'working-fixed', role: 'backend-engineer', status: 'completed' }],
      executions: [{ id: 'execution-reviewing', assignmentId: 'assignment-reviewing', taskId: 'task-reviewing', agentId: 'working-fixed', status: 'completed', startedAt: '2026-08-29T09:30:00.000Z', completedAt: '2026-08-29T10:00:00.000Z' }],
      decisionRequests: [],
    })
    const model = createWorkspaceModel(reviewing)
    expect(model.taskById.get('task-reviewing')?.workState).toBe('reviewing')
    expect(model.agentById.get('working-fixed')?.workState).toBe('done')
  })

  it('keeps completion distinct from acceptance', () => {
    const model = createWorkspaceModel(snapshot())
    expect(model.taskById.get('task-completed')?.workState).toBe('completed')
    expect(taskWorkStateLabel('completed')).toBe('Completed')
    expect(taskWorkStateLabel('completed')).not.toContain('Accepted')
    expect(workStateLabel('done')).toBe('Done')
  })

  it('creates blockers from real V1 decision and failure facts only', () => {
    const model = createWorkspaceModel(snapshot({ paused: true }))
    expect(model.blockers.map(item => item.kind)).toEqual(expect.arrayContaining(['paused', 'decision', 'failed-task']))
    expect(model.blockers.some(item => item.title.includes('dependency'))).toBe(false)
  })

  it('validates selections and derives local breadcrumb parents', () => {
    const model = createWorkspaceModel(snapshot())
    expect(selectionExists(model, { kind: 'task', id: 'task-working' })).toBe(true)
    expect(selectionExists(model, { kind: 'task', id: 'removed-task' })).toBe(false)
    expect(selectionExists(model, { kind: 'commander' })).toBe(true)
    expect(selectionParent(model, { kind: 'execution', id: 'execution-working' })).toEqual({ kind: 'task', id: 'task-working' })
    expect(selectionParent(model, { kind: 'commander' })).toEqual(PROJECT_SELECTION)
  })

  it('associates safe summaries by factual task, agent, and execution ids', () => {
    const model = createWorkspaceModel(snapshot({
      results: [{ id: 'result-task', taskId: 'task-working', source: 'result', at: '2026-08-29T09:40:00.000Z', summary: { text: 'safe result', truncated: false, redacted: false } }],
      reports: [{ id: 'report-execution', executionId: 'execution-working', taskId: 'task-working', agentId: 'working-fixed', source: 'report', status: 'success', at: '2026-08-29T09:45:00.000Z', summary: { text: 'safe report', truncated: false, redacted: false } }],
      attempts: [{ id: 'attempt-execution', executionId: 'execution-working', source: 'attempt', status: 'completed', isRetry: true, at: '2026-08-29T09:46:00.000Z', completedAt: '2026-08-29T09:46:00.000Z' }],
      failures: [{ id: 'failure-execution', executionId: 'execution-working', taskId: 'task-working', agentId: 'working-fixed', source: 'report', status: 'blocked', at: '2026-08-29T09:47:00.000Z', summary: null }],
    }))
    const task = model.taskById.get('task-working')
    const agent = model.agentById.get('working-fixed')
    expect(task?.results.map(item => item.id)).toEqual(['result-task'])
    expect(task?.reports.map(item => item.id)).toEqual(['report-execution'])
    expect(task?.attempts.map(item => item.id)).toEqual(['attempt-execution'])
    expect(task?.failures.map(item => item.id)).toEqual(['failure-execution'])
    expect(agent?.reports.map(item => item.id)).toEqual(['report-execution'])
    expect(agent?.failures.map(item => item.id)).toEqual(['failure-execution'])
    expect(model.snapshot.results?.[0]?.taskId).toBe('task-working')
    expect(model.snapshot.executions[0]?.assignmentId).toBe('assignment-working')
    expect(model.snapshot.reports?.[0]?.executionId).toBe('execution-working')
  })

  it('maps selections to exact audit filters without temporal inference', () => {
    expect(auditFilterForSelection({ kind: 'project' })).toEqual({ kind: 'project' })
    expect(auditFilterForSelection({ kind: 'commander' })).toEqual({ kind: 'project' })
    expect(auditFilterForSelection({ kind: 'task', id: 'task-a' })).toEqual({ kind: 'task', id: 'task-a' })
    expect(auditFilterForSelection({ kind: 'agent', id: 'agent-a' })).toEqual({ kind: 'agent', id: 'agent-a' })
    expect(auditFilterForSelection({ kind: 'execution', id: 'execution-a' })).toEqual({ kind: 'execution', id: 'execution-a' })
    expect(auditFilterForSelection({ kind: 'decision', id: 'decision-a' })).toEqual({ kind: 'decision', id: 'decision-a' })
  })

  it('keeps old snapshots and absent retry facts conservative', () => {
    const model = createWorkspaceModel(snapshot())
    expect(model.taskById.get('task-working')?.results).toEqual([])
    expect(model.taskById.get('task-working')?.attempts).toEqual([])
    expect(model.taskById.get('task-working')?.failures).toEqual([])
    expect(model.snapshot.results).toBeUndefined()
  })
})
