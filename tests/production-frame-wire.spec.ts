import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { DevFlowChangeBus, committedWriteObserver } from '../src/host/change-bus.ts'
import { DevFlowStore } from '../src/host/storage.ts'
import { recordDevFlowChange } from '../src/host/journal.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('production wiring', () => {
  it('carries the record argument into the bus', () => {
    const captured: unknown[][] = []
    const bus = { report: (...args: unknown[]) => { captured.push(args) } } as unknown as DevFlowChangeBus
    const record = { type: 'devflow/task/transition', data: { taskId: 't-1', to: 'executing' }, at: 'now' }
    committedWriteObserver(bus)('tasks/t-1.json', 7, record)
    expect(captured).toEqual([['tasks/t-1.json', 7, record]])
  })

  it('delivers a non-empty change set through the production wiring', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devflow-prod-wire-'))
    roots.push(root)
    const bus = new DevFlowChangeBus({ windowMs: 0 })
    const store = new DevFlowStore(
      new LocalFileSystem(new Context(), { cwd: root, diffBasisMaxBytes: 1024 * 1024 }),
      './.devflow',
      committedWriteObserver(bus),
    )
    const signals: { changes: readonly { type: string; id: string }[]; sequence: number | null }[] = []
    bus.subscribe(signal => { signals.push({ changes: signal.changes, sequence: signal.sequence }) })
    await recordDevFlowChange(store, 'devflow/task/transition', { taskId: 'task-prod-1', to: 'executing' })
    bus.flush()
    expect(signals).toHaveLength(1)
    expect(signals[0]?.sequence).toBe(1)
    expect(signals[0]?.changes.map(change => ({ type: change.type, id: change.id })))
      .toEqual([{ type: 'task-executing', id: 'task-prod-1' }])
    bus.dispose()
  })

  it('keeps a plain state-file write watermark-only through the production wiring', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devflow-prod-plain-'))
    roots.push(root)
    const bus = new DevFlowChangeBus({ windowMs: 0 })
    const store = new DevFlowStore(
      new LocalFileSystem(new Context(), { cwd: root, diffBasisMaxBytes: 1024 * 1024 }),
      './.devflow',
      committedWriteObserver(bus),
    )
    const signals: { changes: readonly unknown[] }[] = []
    bus.subscribe(signal => { signals.push({ changes: signal.changes }) })
    await store.saveProject({
      id: 'p-prod', name: 'production wire', goal: 'g', currentStage: '',
      createdAt: 'now', updatedAt: 'now',
    })
    bus.flush()
    expect(signals.length).toBeGreaterThan(0)
    // A bare path is not a committed meaning: the production wiring must not invent one.
    for (const signal of signals) expect(signal.changes).toEqual([])
    bus.dispose()
  })

  it('reports the watermark alone when no record is attached', () => {
    const captured: unknown[][] = []
    const bus = { report: (...args: unknown[]) => { captured.push(args) } } as unknown as DevFlowChangeBus
    committedWriteObserver(bus)('journal/head.json', 12, undefined)
    expect(captured).toEqual([['journal/head.json', 12, undefined]])
  })
})
