import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { DevFlowStore } from '../src/host/storage.ts'
import { recordDevFlowChange } from '../src/host/journal.ts'
import { initialDevFlowState, applyDevFlowStateEvent } from '../src/host/state.ts'
import type { Project } from '../src/host/types.ts'

function project(): Project {
  return {
    id: 'project-1', name: 'M3', goal: 'move state to the plugin store', currentStage: 'host',
    createdAt: '2026-08-27T00:00:00.000Z', updatedAt: '2026-08-27T00:00:00.000Z',
  }
}

describe('DevFlow host journal', () => {
  it('persists a change and recovers it after constructing a fresh store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devflow-m3-'))
    try {
      const makeStore = () => new DevFlowStore(new LocalFileSystem(new Context(), { cwd: root, diffBasisMaxBytes: 1024 * 1024 }), './.devflow')
      const first = makeStore()
      await first.saveProject(project())
      await recordDevFlowChange(first, 'devflow/project/update', { project: project() })
      await recordDevFlowChange(first, 'devflow/control/pause', { at: '2026-08-27T00:00:01.000Z' })
      const second = makeStore()
      const state = await second.loadState()
      expect(state.project?.id).toBe('project-1')
      expect(state.paused).toBe(true)
      expect((await second.listJournal()).map(entry => entry.type)).toEqual([
        'devflow/project/update', 'devflow/control/pause',
      ])
      expect(JSON.parse(await readFile(join(root, '.devflow', 'journal', 'head.json'), 'utf8'))).toEqual({ nextSequence: 2 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('serializes concurrent journal appends with unique committed sequences', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devflow-m3-concurrent-'))
    try {
      const makeStore = () => new DevFlowStore(new LocalFileSystem(new Context(), { cwd: root, diffBasisMaxBytes: 1024 * 1024 }), './.devflow')
      const store = makeStore()
      const entries = await Promise.all(Array.from({ length: 8 }, (_, index) => (
        recordDevFlowChange(store, 'devflow/control/pause', { at: `2026-08-27T00:00:0${index}.000Z` })
      )))
      expect(new Set(entries.map(entry => entry.sequence)).size).toBe(8)
      expect((await store.listJournal()).map(entry => entry.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('deduplicates a retried change by stable journal id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devflow-m3-idempotent-'))
    try {
      const store = new DevFlowStore(new LocalFileSystem(new Context(), { cwd: root, diffBasisMaxBytes: 1024 * 1024 }), './.devflow')
      const id = '00000000-0000-4000-8000-000000000042'
      const first = await store.appendJournal('devflow/control/pause', { at: '2026-08-27T00:00:00.000Z' }, id)
      const second = await store.appendJournal('devflow/control/pause', { at: '2026-08-27T00:00:00.000Z' }, id)
      expect(second).toEqual(first)
      expect(await store.listJournal()).toHaveLength(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('recovers an orphan tail entry left before head publication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devflow-m3-orphan-'))
    try {
      const journal = join(root, '.devflow', 'journal')
      await mkdir(journal, { recursive: true })
      await writeFile(join(journal, '0000000000000000.json'), JSON.stringify({
        sequence: 0,
        id: '00000000-0000-4000-8000-000000000001',
        type: 'devflow/control/pause',
        data: { at: '2026-08-27T00:00:00.000Z' },
        at: '2026-08-27T00:00:00.000Z',
      }))
      const store = new DevFlowStore(new LocalFileSystem(new Context(), { cwd: root, diffBasisMaxBytes: 1024 * 1024 }), './.devflow')
      const next = await store.appendJournal('devflow/control/resume', { at: '2026-08-27T00:00:01.000Z' })
      expect(next.sequence).toBe(1)
      expect((await store.listJournal()).map(entry => entry.type)).toEqual([
        'devflow/control/pause', 'devflow/control/resume',
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('restores entity-file state without relying on a session or journal event', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devflow-m3-entities-'))
    try {
      const makeStore = () => new DevFlowStore(new LocalFileSystem(new Context(), { cwd: root, diffBasisMaxBytes: 1024 * 1024 }), './.devflow')
      const first = makeStore()
      await first.saveProject(project())
      const task = await first.createTask({ title: 'persist task', description: 'entity recovery', status: 'created' })
      const second = makeStore()
      const state = await second.loadState()
      expect(state.project).toEqual(project())
      expect(state.tasks[task.id]).toBe('created')
      expect(state.taskTitles?.[task.id]).toBe('persist task')
      expect(await second.listJournal()).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('preserves failure, rework, acceptance, pause, and resume fold semantics', () => {
    let state = initialDevFlowState()
    const apply = (type: string, data: object) => {
      state = applyDevFlowStateEvent(state, { type, seq: 0, time: 0, data } as never)
    }
    apply('devflow/task/transition', { taskId: 'task-1', title: 'review me', from: 'executing', to: 'failed', at: '2026-08-27T00:00:00.000Z' })
    apply('devflow/bridge/import', { taskId: 'task-1', resultId: 'result-1', protocolVersion: '1', verdict: 'changes-requested', at: '2026-08-27T00:00:01.000Z' })
    apply('devflow/control/pause', { at: '2026-08-27T00:00:02.000Z' })
    expect(state.tasks['task-1']).toBe('failed')
    expect(state.reviewFailCounts['task-1']).toBe(1)
    expect(state.paused).toBe(true)
    apply('devflow/bridge/import', { taskId: 'task-1', resultId: 'result-2', protocolVersion: '1', verdict: 'accepted', at: '2026-08-27T00:00:03.000Z' })
    apply('devflow/control/resume', { at: '2026-08-27T00:00:04.000Z' })
    expect(state.reviewFailCounts['task-1']).toBeUndefined()
    expect(state.paused).toBe(false)
  })

  it('propagates journal failures; official tool anchors are host-owned', async () => {
    // DevFlow never calls Session.append. The dsh tool registry emits the
    // official tool/call and tool/result lifecycle around registered tools.
    await expect(recordDevFlowChange({
      appendJournal: async () => { throw new Error('disk full') },
    } as never, 'devflow/control/pause', { at: 'now' })).rejects.toThrow('disk full')
  })

  it('keeps the pure state fold independent from Session', () => {
    const state = initialDevFlowState()
    const next = applyDevFlowStateEvent(state, {
      type: 'devflow/control/pause', seq: 0, time: 0, data: { at: '2026-08-27T00:00:00.000Z' },
    } as never)
    expect(next.paused).toBe(true)
  })
})
