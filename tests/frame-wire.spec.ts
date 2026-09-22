/**
 * 第七步任务 1 的**接线**取证：真实 `.devflow` 写入 → 变化总线 → 帧的 `changes`。
 *
 * 为什么需要它：`change-set.spec.ts` 只证明"投影函数对"、`client-live-channel.spec.ts`
 * 只证明"帧的形状对"；**两者都没有证明那根线真的接上了**。这份用例用**真的**
 * `DevFlowStore`（真写 journal / 实体文件）喂**真的** `DevFlowChangeBus`，断言：
 *
 *  1. 一次真实提交 ⇒ 信号同时带 **水位**（sequence/revision）与**语义变更**；
 *  2. **纯状态文件写入**（非 journal）不产生语义变更（否则词表会被路径猜出来）；
 *  3. 一次批量提交里**多条**真实记录各自映射成 kind，顺序与提交一致；
 *  4. 观察者抛错**不会**让已提交的写入失败（既有契约，回归保护）。
 *
 * 全程在临时根内；不触碰 `D:\Deepseek\Harness\.devflow`。
 */
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { DevFlowChangeBus } from '../src/host/change-bus.ts'
import { DevFlowStore } from '../src/host/storage.ts'
import { recordDevFlowChange } from '../src/host/journal.ts'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** A real store whose committed writes reach the bus through the real seam. */
async function wired(busOptions: { readonly changeLimit?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'devflow-frame-wire-'))
  roots.push(root)
  const bus = new DevFlowChangeBus({ windowMs: 0, ...busOptions })
  const store = new DevFlowStore(
    new LocalFileSystem(new Context(), { cwd: root, diffBasisMaxBytes: 1024 * 1024 }),
    './.devflow',
    (relativePath, sequence, record) => { bus.report(relativePath, sequence, record) },
  )
  const signals: ReturnType<typeof capture>[] = []
  bus.subscribe(signal => { signals.push(capture(signal)) })
  return { bus, store, signals, flush: () => { bus.flush() } }
}

/** Narrow a signal to what the frame actually carries, so assertions read clearly. */
function capture(signal: { revision: number; sequence: number | null; changed: readonly string[]; changes: readonly { type: string; id: string }[] }) {
  return {
    revision: signal.revision,
    sequence: signal.sequence,
    changed: [...signal.changed],
    changes: signal.changes.map(change => ({ type: change.type, id: change.id })),
  }
}

describe('committed writes reach the frame as a semantic change set', () => {
  it('carries both the watermark and the semantic change in ONE frame per commit', async () => {
    const env = await wired()
    await recordDevFlowChange(env.store, 'devflow/execution/start', { execution: { executionId: 'exec-wire-1' } })
    env.flush()
    // One commit = one frame. A watermark-only frame immediately before the one that
    // explains the change would tell the client "nothing you can see changed" and
    // then contradict itself.
    expect(env.signals).toHaveLength(1)
    expect(env.signals[0]).toMatchObject({
      revision: 1,
      changes: [{ type: 'execution-started', id: 'exec-wire-1' }],
    })
    // The watermark rides the same frame: the signal contract is unchanged.
    expect(env.signals[0]?.sequence).toBe(1)
    env.bus.dispose()
  })

  it('derives no semantic change from a pure state-file write', async () => {
    const env = await wired()
    await env.store.saveProject({
      id: 'wire-probe-project', name: 'line probe', goal: 'frame wiring evidence',
      currentStage: '', createdAt: 'now', updatedAt: 'now',
    })
    env.flush()
    expect(env.signals.length).toBeGreaterThan(0)
    // A state-file write has no committed meaning of its own; inventing one from the
    // path is exactly the guess this design refuses to make.
    for (const signal of env.signals) expect(signal.changes).toEqual([])
    env.bus.dispose()
  })

  it('maps several real records, preserving commit order', async () => {
    const env = await wired()
    await recordDevFlowChange(env.store, 'devflow/task/transition', { taskId: 'task-wire-1', to: 'executing' })
    await recordDevFlowChange(env.store, 'devflow/orchestration/assign', { assignment: { assignmentId: 'assign-wire-1' } })
    await recordDevFlowChange(env.store, 'devflow/execution/complete', { executionId: 'exec-wire-2' })
    env.flush()
    // Each commit is its own frame (the window is 0 here), and the kinds must follow
    // the commit order rather than a map's iteration order.
    const mapped = env.signals.flatMap(signal => signal.changes)
    expect(mapped).toEqual([
      { type: 'task-executing', id: 'task-wire-1' },
      { type: 'assignment-created', id: 'assign-wire-1' },
      { type: 'execution-settled', id: 'exec-wire-2' },
    ])
    // Every frame still carries its watermark.
    for (const signal of env.signals) expect(signal.sequence).not.toBeNull()
    env.bus.dispose()
  })

  it('degrades one overfull window to watermark-only, without truncating it', async () => {
    const env = await wired({ changeLimit: 2 })
    // windowMs is 0 in this harness, so each commit flushes on its own; the limit is
    // therefore exercised by reporting three changes inside ONE window.
    env.bus.report('journal/a.json', 1, { type: 'devflow/execution/start', data: { executionId: 'x1' }, at: 'now' })
    env.bus.report('journal/b.json', 2, { type: 'devflow/execution/start', data: { executionId: 'x2' }, at: 'now' })
    env.bus.report('journal/c.json', 3, { type: 'devflow/execution/start', data: { executionId: 'x3' }, at: 'now' })
    env.flush()
    const last = env.signals.at(-1)
    // The watermark survived; the change list did NOT survive partially — a truncated
    // hint is indistinguishable from a complete one, which is the failure mode the
    // whole-list drop exists to avoid.
    expect(last?.sequence).toBe(3)
    expect(last?.changes).toEqual([])
    env.bus.dispose()
  })

  it('still commits the write when the observer throws', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devflow-frame-throw-'))
    roots.push(root)
    const store = new DevFlowStore(
      new LocalFileSystem(new Context(), { cwd: root, diffBasisMaxBytes: 1024 * 1024 }),
      './.devflow',
      () => { throw new Error('observer exploded') },
    )
    // An observer must never fail a committed write: the record is on disk and the
    // caller must not be told otherwise.
    const entry = await recordDevFlowChange(store, 'devflow/execution/start', { execution: { executionId: 'exec-throw' } })
    expect(entry.type).toBe('devflow/execution/start')
    expect(await store.listJournal()).toHaveLength(1)
  })
})
