import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { DevFlowStore } from '../src/host/storage.ts'
import { recordDevFlowChange } from '../src/host/journal.ts'
import { applyDevFlowStateEvent, initialDevFlowState } from '../src/host/state.ts'
import { patchAssignmentStatus, transitionExecution } from '../src/host/projection.ts'
import { toSafeAuditItem } from '../src/host/client-audit.ts'
import { createDevFlowClientSnapshot } from '../src/host/client-snapshot.ts'
import type { DevflowController } from '../src/host/index.ts'
import { testReadStore, testScopeResolver } from './support/session-scope.ts'
import { closeReasonLabel } from '../src/client/flow-projection.ts'
import type { ExecutionRecord, PhaseAssignment, Project } from '../src/host/types.ts'

/**
 * 第四步「收尾终态语义」—— NOT deleting data, just saying "this record can never
 * continue". Every layer that carries a status is asserted here, because a link missing
 * from that chain is exactly how earlier rounds' fields got silently dropped.
 */

const NOW = '2026-09-16T01:00:00.000Z'

function project(): Project {
  return {
    id: 'project-1', name: 'Close-out', goal: '终态', currentStage: 'M8',
    createdAt: '2026-08-27T00:00:00.000Z', updatedAt: '2026-08-27T00:00:00.000Z',
  }
}

function makeStore(root: string): DevFlowStore {
  return new DevFlowStore(new LocalFileSystem(new Context(), { cwd: root, diffBasisMaxBytes: 1024 * 1024 }), './.devflow')
}

/** Seed a project + phase + one live assignment, returning the ids the store minted. */
async function seedAssignment(store: DevFlowStore): Promise<{ assignmentId: string; phaseId: string; taskId: string }> {
  await store.saveProject(project())
  const phase = await store.createPhase({ name: 'P1', description: 'p', status: 'in_progress' })
  const task = await store.createTask({ title: 'Dispatch', description: 'd', status: 'executing' })
  const assignment = await store.createAssignment({
    taskId: task.id, phaseId: phase.id, agentId: 'backend-engineer', role: 'backend-engineer', status: 'assigned',
  })
  return { assignmentId: assignment.assignmentId, phaseId: phase.id, taskId: task.id }
}

function controller(state = initialDevFlowState(), tasks: readonly object[] = []) {
  const store = testReadStore(state, tasks)
  return {
    readState: () => state,
    resolveSessionScope: testScopeResolver(store),
    store,
    commanderMode: { current: vi.fn(() => ({ mode: 'commander', sessionId: 's-1', projectId: 'p-1', changedAt: 'now' })) },
  } as unknown as DevflowController
}

describe('收尾终态：存储层的状态机与封存字段', () => {
  it('closes an assignment with a mandatory reason, and rejects closing without one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devflow-close-assignment-'))
    try {
      const store = makeStore(root)
      const { assignmentId } = await seedAssignment(store)
      // A close without a reason is a wiring mistake, not a state.
      await expect(store.updateAssignmentStatus(assignmentId, 'closed')).rejects.toThrow('requires a close reason')
      const closed = await store.updateAssignmentStatus(assignmentId, 'closed', 'stale-lost')
      expect(closed.status).toBe('closed')
      expect(closed.closeReason).toBe('stale-lost')
      expect(typeof closed.closedAt).toBe('string')
      // Reloading from disk must return the same closure (the validator keeps both fields).
      expect(await store.getAssignment(assignmentId)).toEqual(closed)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('makes `closed` terminal for assignments: no reopen, and no close from completed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devflow-close-terminal-'))
    try {
      const store = makeStore(root)
      const { assignmentId } = await seedAssignment(store)
      await store.updateAssignmentStatus(assignmentId, 'in_progress')
      await store.updateAssignmentStatus(assignmentId, 'closed', 'abandoned')
      await expect(store.updateAssignmentStatus(assignmentId, 'assigned')).rejects.toThrow('illegal assignment transition closed -> assigned')
      await expect(store.updateAssignmentStatus(assignmentId, 'in_progress')).rejects.toThrow('illegal assignment transition closed -> in_progress')
      await expect(store.updateAssignmentStatus(assignmentId, 'completed')).rejects.toThrow('illegal assignment transition closed -> completed')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a close reason on a transition that is not a close', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devflow-close-illegal-'))
    try {
      const store = makeStore(root)
      const { assignmentId } = await seedAssignment(store)
      await expect(store.updateAssignmentStatus(assignmentId, 'in_progress', 'stale-lost'))
        .rejects.toThrow('may only carry a close reason while closed')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('makes `closed` terminal for executions, stamps closedAt, and keeps it on disk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devflow-close-execution-'))
    try {
      const store = makeStore(root)
      const { assignmentId, taskId } = await seedAssignment(store)
      const created = await store.createExecutionRecord({
        batchId: '00000000-0000-4000-8000-0000000000b1', assignmentId, agentId: 'backend-engineer', taskId,
      })
      await store.updateExecutionStatus(created.executionId, 'running')
      await expect(store.updateExecutionStatus(created.executionId, 'closed')).rejects.toThrow('requires a close reason')
      const closed = await store.updateExecutionStatus(created.executionId, 'closed', 'stale-lost')
      expect(closed.status).toBe('closed')
      expect(closed.closeReason).toBe('stale-lost')
      expect(typeof closed.closedAt).toBe('string')
      // A closed execution can never be "completed" afterwards.
      await expect(store.updateExecutionStatus(created.executionId, 'completed')).rejects.toThrow('illegal execution transition closed -> completed')
      // ...and the closure survives a fresh read of the durable file.
      expect(await store.getExecutionRecord(created.executionId)).toEqual(closed)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('收尾终态：投影层', () => {
  it('folds a close with its stamp and clears the stamp on every other status', () => {
    const assignment: PhaseAssignment = {
      assignmentId: 'a-1', phaseId: 'p-1', agentId: 'backend-engineer',
      role: 'backend-engineer', status: 'assigned', createdAt: NOW, updatedAt: NOW,
    }
    const closed = patchAssignmentStatus({ 'a-1': assignment }, 'a-1', 'closed', NOW, 'superseded')
    expect(closed['a-1']).toMatchObject({ status: 'closed', closedAt: NOW, closeReason: 'superseded' })
    // A later non-close fold must not leave a stale closure behind.
    const moved = patchAssignmentStatus(closed, 'a-1', 'in_progress', NOW)
    expect(moved['a-1']?.status).toBe('in_progress')
    expect(moved['a-1']?.closedAt).toBeUndefined()
    expect(moved['a-1']?.closeReason).toBeUndefined()
  })

  it('folds an execution close and stamps it on the record', () => {
    const execution: ExecutionRecord = {
      executionId: 'e-1', batchId: 'b-1', assignmentId: 'a-1', agentId: 'backend-engineer',
      status: 'running', startedAt: NOW, completedAt: null, createdAt: NOW, updatedAt: NOW,
    }
    const closed = transitionExecution({ 'e-1': execution }, 'e-1', 'closed', NOW, 'stale-lost')
    expect(closed['e-1']).toMatchObject({ status: 'closed', closedAt: NOW, closeReason: 'stale-lost', completedAt: null })
  })

  it('refuses to invent a closure: a close without a reason folds no stamp', () => {
    const assignment: PhaseAssignment = {
      assignmentId: 'a-1', phaseId: 'p-1', agentId: 'backend-engineer',
      role: 'backend-engineer', status: 'assigned', createdAt: NOW, updatedAt: NOW,
    }
    const folded = patchAssignmentStatus({ 'a-1': assignment }, 'a-1', 'closed', NOW)
    expect(folded['a-1']?.closedAt).toBeUndefined()
    expect(folded['a-1']?.closeReason).toBeUndefined()
  })
})

describe('收尾终态：状态折叠（journal → state）', () => {
  it('applies the dedicated close events onto the durable state', () => {
    const assignment: PhaseAssignment = {
      assignmentId: 'a-1', phaseId: 'p-1', agentId: 'backend-engineer',
      role: 'backend-engineer', status: 'assigned', createdAt: NOW, updatedAt: NOW,
    }
    const execution: ExecutionRecord = {
      executionId: 'e-1', batchId: 'b-1', assignmentId: 'a-1', agentId: 'backend-engineer',
      status: 'running', startedAt: NOW, completedAt: null, createdAt: NOW, updatedAt: NOW,
    }
    const seeded = {
      ...initialDevFlowState(),
      assignments: { 'a-1': assignment },
      executions: { 'e-1': execution },
    }
    const afterAssignment = applyDevFlowStateEvent(seeded, {
      type: 'devflow/orchestration/close', data: { assignmentId: 'a-1', closeReason: 'superseded', at: NOW },
    } as never)
    expect(afterAssignment.assignments['a-1']).toMatchObject({ status: 'closed', closeReason: 'superseded', closedAt: NOW })

    const afterExecution = applyDevFlowStateEvent(seeded, {
      type: 'devflow/execution/close', data: { executionId: 'e-1', closeReason: 'stale-lost', at: NOW },
    } as never)
    expect(afterExecution.executions['e-1']).toMatchObject({ status: 'closed', closeReason: 'stale-lost', closedAt: NOW })
  })

  it('keeps the closure through a real journal replay', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devflow-close-replay-'))
    try {
      const store = makeStore(root)
      const { assignmentId } = await seedAssignment(store)
      await store.updateAssignmentStatus(assignmentId, 'closed', 'abandoned')
      const replayed = await store.loadState()
      expect(replayed.assignments[assignmentId]).toMatchObject({ status: 'closed', closeReason: 'abandoned' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('收尾终态：审计投影与客户端契约', () => {
  it('projects a close as the `closed` action with the closed status, not as incomplete', () => {
    const item = toSafeAuditItem({
      sequence: 1, id: '00000000-0000-4000-8000-000000000009', type: 'devflow/orchestration/close',
      at: NOW, data: { assignmentId: 'a-1', closeReason: 'stale-lost', at: NOW },
    } as never)
    expect(item?.action).toBe('closed')
    expect(item?.status).toBe('closed')
    expect(item?.category).toBe('assignment')
    expect(item?.incomplete).toBe(false)
  })

  it('projects a closed execution update without dropping the status', () => {
    const item = toSafeAuditItem({
      sequence: 2, id: '00000000-0000-4000-8000-00000000000a', type: 'devflow/execution/update',
      at: NOW, data: { executionId: 'e-1', status: 'closed', at: NOW },
    } as never)
    expect(item?.action).toBe('updated')
    expect(item?.status).toBe('closed')
  })

  it('carries the closure into the browser snapshot', async () => {
    const state = initialDevFlowState()
    state.project = project()
    state.assignments['a-1'] = {
      assignmentId: 'a-1', phaseId: 'p-1', agentId: 'backend-engineer', role: 'backend-engineer',
      status: 'closed', closedAt: NOW, closeReason: 'stale-lost', createdAt: NOW, updatedAt: NOW,
    }
    state.executions['e-1'] = {
      executionId: 'e-1', batchId: 'b-1', assignmentId: 'a-1', agentId: 'backend-engineer',
      status: 'closed', startedAt: NOW, completedAt: null, closedAt: NOW, closeReason: 'stale-lost', createdAt: NOW, updatedAt: NOW,
    }
    const snapshot = await createDevFlowClientSnapshot(controller(state), { id: 's-1' } as Agent)
    expect(snapshot.assignments[0]).toMatchObject({ id: 'a-1', status: 'closed', closeReason: 'stale-lost', closedAt: NOW })
    expect(snapshot.executions[0]).toMatchObject({ id: 'e-1', status: 'closed', closeReason: 'stale-lost', closedAt: NOW })
  })

  it('never puts a close stamp on a record that is not closed', async () => {
    const state = initialDevFlowState()
    state.project = project()
    state.assignments['a-2'] = {
      assignmentId: 'a-2', phaseId: 'p-1', agentId: 'backend-engineer', role: 'backend-engineer',
      status: 'in_progress', createdAt: NOW, updatedAt: NOW,
    }
    const snapshot = await createDevFlowClientSnapshot(controller(state), { id: 's-1' } as Agent)
    expect(snapshot.assignments[0]).not.toHaveProperty('closedAt')
    expect(snapshot.assignments[0]).not.toHaveProperty('closeReason')
  })

  it('names every close reason in fixed Chinese, and never leaks a raw value', () => {
    expect(closeReasonLabel('stale-lost')).toBe('陈旧在飞')
    expect(closeReasonLabel('superseded')).toBe('已被后续派发取代')
    expect(closeReasonLabel('abandoned')).toBe('已放弃')
    expect(closeReasonLabel(undefined)).toBe('原因未记录')
  })
})

describe('收尾终态：记录留痕', () => {
  it('appends a close journal entry instead of touching existing ones', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devflow-close-journal-'))
    try {
      const store = makeStore(root)
      const { assignmentId } = await seedAssignment(store)
      const before = (await store.listJournal()).map(entry => entry.sequence)
      await recordDevFlowChange(store, 'devflow/orchestration/close', { assignmentId, closeReason: 'stale-lost', at: NOW })
      const after = await store.listJournal()
      // The earlier entries are untouched and the close is a NEW entry at the tail.
      expect(after.map(entry => entry.sequence).slice(0, before.length)).toEqual(before)
      expect(after.at(-1)?.type).toBe('devflow/orchestration/close')
      expect(after.length).toBe(before.length + 1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
