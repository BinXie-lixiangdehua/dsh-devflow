/**
 * 第七步 任务 1：有界语义变更集。
 *
 * 三件事必须被钉住：
 *  1. **封闭词表**：journal 的持久事件族 → 固定的 kind 集合；不认识的记录 ⇒ **不产出**，
 *     而不是给一个含糊的名字（否则词表会随着调用方漂开）。
 *  2. **有界**：单帧超过上限 ⇒ **整份退化为"仅水位"**（而不是截断——半个列表会让
 *     客户端无法区分"提示不全"和"提示完整"，那比没有提示更危险）。
 *  3. **帧仍是提示**：本模块只产出"什么动了"，不产出任何可直接渲染的状态。
 */
import { describe, expect, it } from 'vitest'
import { DevFlowChangeBus } from '../src/host/change-bus.ts'
import {
  DEVFLOW_COMMIT_CHANGE_LIMIT, DEVFLOW_COMMIT_KINDS, commitChangeOf,
} from '../src/host/change-set.ts'

const AT = '2026-09-16T12:00:00.000Z'

describe('committed change projection', () => {
  it('maps the journal families the canvas draws onto the closed vocabulary', () => {
    expect(commitChangeOf({ type: 'devflow/task/transition', data: { taskId: 't1', to: 'executing' }, at: AT }))
      .toEqual({ type: 'task-executing', id: 't1', at: AT })
    expect(commitChangeOf({ type: 'devflow/task/transition', data: { taskId: 't1', to: 'reviewing' }, at: AT }))
      .toEqual({ type: 'task-reviewing', id: 't1', at: AT })
    expect(commitChangeOf({ type: 'devflow/task/transition', data: { taskId: 't1', to: 'completed' }, at: AT }))
      .toEqual({ type: 'task-settled', id: 't1', at: AT })
    expect(commitChangeOf({ type: 'devflow/execution/start', data: { execution: { executionId: 'e1' } }, at: AT }))
      .toEqual({ type: 'execution-started', id: 'e1', at: AT })
    expect(commitChangeOf({ type: 'devflow/execution/complete', data: { executionId: 'e1' }, at: AT }))
      .toEqual({ type: 'execution-settled', id: 'e1', at: AT })
    expect(commitChangeOf({ type: 'devflow/execution/fail', data: { executionId: 'e1' }, at: AT }))
      .toEqual({ type: 'execution-settled', id: 'e1', at: AT })
    expect(commitChangeOf({ type: 'devflow/execution/close', data: { executionId: 'e1' }, at: AT }))
      .toEqual({ type: 'execution-settled', id: 'e1', at: AT })
    expect(commitChangeOf({ type: 'devflow/orchestration/assign', data: { assignment: { assignmentId: 'a1' } }, at: AT }))
      .toEqual({ type: 'assignment-created', id: 'a1', at: AT })
    expect(commitChangeOf({ type: 'devflow/orchestration/close', data: { assignmentId: 'a1' }, at: AT }))
      .toEqual({ type: 'assignment-settled', id: 'a1', at: AT })
  })

  it('yields nothing for records the canvas has no element for', () => {
    // Every produced kind must be in the published vocabulary: a code path that
    // invents a name would silently widen the contract.
    for (const type of [
      'devflow/orchestration/update', 'devflow/project/update', 'devflow/agent/register',
      'devflow/task/create', 'devflow/scope/task-update', 'devflow/preset/activated',
      'devflow/preset/activation-failed', 'devflow/commander/mode-enter',
    ]) {
      expect(commitChangeOf({ type, data: { taskId: 't1' }, at: AT }), type).toBeNull()
    }
    // A task transition whose target the canvas does not distinguish is not a kind.
    expect(commitChangeOf({ type: 'devflow/task/transition', data: { taskId: 't1', to: 'created' }, at: AT })).toBeNull()
  })

  it('refuses a record with no identifiable entity instead of inventing an id', () => {
    expect(commitChangeOf({ type: 'devflow/execution/start', data: {}, at: AT })).toBeNull()
    expect(commitChangeOf({ type: 'devflow/execution/start', data: { executionId: '' }, at: AT })).toBeNull()
    expect(commitChangeOf({ type: 'devflow/execution/start', data: { executionId: 'x'.repeat(200) }, at: AT })).toBeNull()
  })

  it('keeps every published kind reachable, so the vocabulary cannot drift', () => {
    const reachable = new Set<string>()
    const samples = [
      { type: 'devflow/task/transition', data: { taskId: 't1', to: 'reviewing' } },
      { type: 'devflow/task/transition', data: { taskId: 't1', to: 'executing' } },
      { type: 'devflow/task/transition', data: { taskId: 't1', to: 'failed' } },
      { type: 'devflow/execution/start', data: { executionId: 'e1' } },
      { type: 'devflow/execution/complete', data: { executionId: 'e1' } },
      { type: 'devflow/orchestration/assign', data: { assignmentId: 'a1' } },
      { type: 'devflow/orchestration/close', data: { assignmentId: 'a1' } },
    ]
    for (const sample of samples) {
      const change = commitChangeOf({ ...sample, at: AT })
      if (change !== null) reachable.add(change.type)
    }
    expect([...reachable].sort()).toEqual([...DEVFLOW_COMMIT_KINDS].sort())
  })
})

describe('change bus carries a bounded change set beside the watermark', () => {
  it('reports the semantic changes of the batch and still reports the watermark', () => {
    const bus = new DevFlowChangeBus({ windowMs: 0, now: () => AT })
    const seen: unknown[] = []
    bus.subscribe(signal => { seen.push(signal) })
    bus.report('journal/0000000000000001.json', 2, { type: 'devflow/execution/start', data: { executionId: 'e1' }, at: AT })
    bus.flush()
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      revision: 1,
      sequence: 2,
      changes: [{ type: 'execution-started', id: 'e1', at: AT }],
    })
    bus.dispose()
  })

  it('degrades the WHOLE change list when the batch outgrows the limit', () => {
    const bus = new DevFlowChangeBus({ windowMs: 0, now: () => AT })
    const seen: { changes: readonly unknown[] }[] = []
    bus.subscribe(signal => { seen.push(signal as { changes: readonly unknown[] }) })
    for (let index = 0; index <= DEVFLOW_COMMIT_CHANGE_LIMIT; index += 1) {
      bus.report(`journal/${String(index).padStart(16, '0')}.json`, index, {
        type: 'devflow/execution/start', data: { executionId: `e${String(index)}` }, at: AT,
      })
    }
    bus.flush()
    // Truncating would hand the client a hint it cannot tell apart from a complete
    // one; watermark-only is the honest degradation and the pre-existing contract.
    expect(seen[0]?.changes).toEqual([])
    bus.dispose()
  })

  it('reports no changes for a plain state-file write', () => {
    const bus = new DevFlowChangeBus({ windowMs: 0, now: () => AT })
    const seen: { changes: readonly unknown[] }[] = []
    bus.subscribe(signal => { seen.push(signal as { changes: readonly unknown[] }) })
    bus.report('tasks/t1.json')
    bus.flush()
    expect(seen[0]?.changes).toEqual([])
    bus.dispose()
  })
})
