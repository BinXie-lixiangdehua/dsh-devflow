/**
 * 第四步 §七.6 展示层衔接证据（**只读**，不写 `.devflow`）。
 *
 * 它不是回归断言（数据会随真实使用变化），而是**一次性取证**：读真实 `.devflow`
 * （只读）→ 用宿主同源 store 折叠状态 → (a) 现状投影；(b) 在内存里把命中"收尾判据"
 * 的记录标成 closed（= 授权回填后的样子）→ 两份都走**同一套客户端投影与浮层计数**，
 * 把改前/改后对照打印成 JSON（报告 §七.6 引用）。
 *
 * 运行：npx vitest run tests/close-out-report.spec.ts --pool=threads
 */
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { DevFlowStore } from '../src/host/storage.ts'
import { createDevFlowClientSnapshot } from '../src/host/client-snapshot.ts'
import type { DevflowController } from '../src/host/index.ts'
import { createWorkspaceModel } from '../src/client/workspace.ts'
import {
  DISPATCH_QUEUE_MAX_MS,
  DISPATCH_STALE_MS,
  createFlowModel,
} from '../src/client/flow-projection.ts'
import { buildOverview } from '../src/client/overview.ts'
import type { DevFlowClientSnapshot } from '../src/contract.ts'
import type { ExecutionRecord, PhaseAssignment } from '../src/host/types.ts'
import { testReadStore, testScopeResolver } from './support/session-scope.ts'

/** The real state root; the store is only ever READ from it. */
const REAL_ROOT = 'D:/Deepseek/Harness'

function countsOf(snapshot: DevFlowClientSnapshot, now: number) {
  const model = createWorkspaceModel(snapshot)
  const flow = createFlowModel(model, now, {}, 'history')
  const view = buildOverview(model, now, null)
  const byState: Record<string, number> = {}
  for (const edge of flow.history.edges) byState[edge.state] = (byState[edge.state] ?? 0) + 1
  return {
    byState,
    segment: {
      active: view.counts.active,
      review: view.counts.review,
      done: view.counts.done,
      lost: view.counts.lost,
      closed: view.counts.closed,
    },
    total: view.total,
    summary: view.summary,
  }
}

/** The closure predicate: the same rules the client uses to call a record 失联. */
function closureFor(
  assignment: PhaseAssignment | undefined,
  execution: ExecutionRecord | undefined,
  now: number,
  newestCompletion: number,
): 'stale-lost' | 'superseded' | null {
  if (execution !== undefined && execution.status === 'running') {
    const started = Date.parse(execution.startedAt ?? '')
    if (Number.isNaN(started) || now - started > DISPATCH_STALE_MS) return 'stale-lost'
    if (started < newestCompletion) return 'superseded'
    return null
  }
  if (execution !== undefined && execution.status === 'pending') {
    const started = Date.parse(execution.startedAt ?? execution.createdAt)
    if (Number.isNaN(started) || now - started > DISPATCH_QUEUE_MAX_MS) return 'stale-lost'
    return null
  }
  if (execution !== undefined) return null
  if (assignment !== undefined && (assignment.status === 'assigned' || assignment.status === 'in_progress')) {
    const created = Date.parse(assignment.createdAt)
    if (Number.isNaN(created) || now - created > DISPATCH_STALE_MS) return 'stale-lost'
  }
  return null
}

function controllerFor(state: unknown, tasks: readonly unknown[]): DevflowController {
  const store = testReadStore(state, tasks)
  return {
    readState: () => state,
    resolveSessionScope: testScopeResolver(store),
    store,
    commanderMode: { current: () => ({ mode: 'commander', sessionId: 's', projectId: 'p', changedAt: 'now' }) },
  } as unknown as DevflowController
}

describe('第四步 §七.6 展示层衔接（只读真实 .devflow，一次性取证）', () => {
  it('prints the before/after counts for the closable records, and proves the ledger is unchanged', async () => {
    const store = new DevFlowStore(
      new LocalFileSystem(new Context(), { cwd: REAL_ROOT, diffBasisMaxBytes: 1024 * 1024 }),
      './.devflow',
    )
    const state = await store.loadState()
    const assignments = Object.values(state.assignments)
    const executions = Object.values(state.executions)
    const tasks = await store.listTasks()
    const now = Date.now()
    const completions = executions.map(item => Date.parse(item.completedAt ?? '')).filter(Number.isFinite)
    const newestCompletion = completions.length === 0 ? 0 : Math.max(...completions)

    const executionByAssignment = new Map<string, ExecutionRecord>()
    for (const execution of executions) executionByAssignment.set(execution.assignmentId, execution)
    const assignmentById = new Map(assignments.map(item => [item.assignmentId, item]))

    const closableExecutions: { id: string; reason: string; startedAt: string | null }[] = []
    for (const execution of executions) {
      const reason = closureFor(assignmentById.get(execution.assignmentId), execution, now, newestCompletion)
      if (reason !== null) closableExecutions.push({ id: execution.executionId, reason, startedAt: execution.startedAt })
    }
    const closableAssignments: { id: string; reason: string; createdAt: string }[] = []
    for (const assignment of assignments) {
      if (executionByAssignment.has(assignment.assignmentId)) continue
      const reason = closureFor(assignment, undefined, now, newestCompletion)
      if (reason !== null) closableAssignments.push({ id: assignment.assignmentId, reason, createdAt: assignment.createdAt })
    }

    const before = await createDevFlowClientSnapshot(controllerFor(state, tasks), { id: 's-1' } as Agent)

    // The "after" shape is built IN MEMORY ONLY: the durable state is never written.
    const afterState = {
      ...state,
      assignments: { ...state.assignments },
      executions: { ...state.executions },
    }
    for (const row of closableAssignments) {
      const existing = afterState.assignments[row.id] as PhaseAssignment
      afterState.assignments[row.id] = {
        ...existing, status: 'closed', closedAt: new Date(now).toISOString(),
        closeReason: row.reason as 'stale-lost' | 'superseded',
      }
    }
    for (const row of closableExecutions) {
      const existing = afterState.executions[row.id] as ExecutionRecord
      afterState.executions[row.id] = {
        ...existing, status: 'closed', closedAt: new Date(now).toISOString(),
        closeReason: row.reason as 'stale-lost' | 'superseded',
      }
    }
    const after = await createDevFlowClientSnapshot(controllerFor(afterState, tasks), { id: 's-1' } as Agent)

    const report = {
      generatedAt: new Date(now).toISOString(),
      durable: { assignments: assignments.length, executions: executions.length, tasks: tasks.length },
      closable: {
        executions: closableExecutions,
        assignments: closableAssignments,
        total: closableExecutions.length + closableAssignments.length,
      },
      before: countsOf(before, now),
      after: countsOf(after, now),
      note: '只读：本次运行未写入任何 .devflow 业务实体；after 仅为内存中的等价形态。',
    }
    // eslint-disable-next-line no-console
    console.log('[step4-display-diff] ' + JSON.stringify(report))

    // --- invariants that hold whatever the live data says -------------------------
    expect(report.durable.executions).toBeGreaterThan(0)
    // 收尾只改"这条算哪一档"：派发总数不变、执行槽不被收尾制造，也不会凭空多出"执行中"。
    expect(report.after.total).toBe(report.before.total)
    expect(report.after.byState.executing ?? 0).toBe(report.before.byState.executing ?? 0)
    // 命中收尾判据的记录一律离开「未收尾·已失联」，并计入「已收尾」。
    expect(report.after.segment.lost).toBe(0)
    expect(report.after.segment.closed).toBeGreaterThanOrEqual(report.before.segment.lost)

    /**
     * 「已完成」这一档不是收尾不变量。
     *
     * 收尾把一个 assignment 从它的**当前**边状态搬进 `closed`，而"当前状态"并不总是
     * `lost`：一条永远没开工的派发（既无 execution、也没有早于它的新完成）会长期停在
     * `done`。断言 `after.done === before.done` 与"`closed` 变多"互相矛盾——`closed` 变多
     * 就必须有别的档变少——那条断言是**测试自身的错误不变量**，不是产品不变量。
     *
     * 这里改为核对**账目恒等式**。混合库是活数据，`before` 与 `after` 之间确实可能有
     * 一条边自己跨过 30 分钟陈旧阈值而在 `lost` 与 `done`/`rework` 之间漂移，因此恒等式
     * 用恰好覆盖"至多一条在飞 + 一条排队"的容差 `DRIFT`；同时要求任何一档的移动量都不
     * 超过"可收尾条数 + DRIFT"，即**没有与收尾无关的大规模状态搬动**。
     */
    const DRIFT = 2
    const closable = report.closable.total
    const delta = {
      done: (report.after.byState.done ?? 0) - (report.before.byState.done ?? 0),
      lost: (report.after.byState.lost ?? 0) - (report.before.byState.lost ?? 0),
      closed: (report.after.byState.closed ?? 0) - (report.before.byState.closed ?? 0),
    }
    // 收尾是唯一的"进入 closed"的来源，且一条只收一次。
    expect(Math.abs(delta.closed - closable)).toBeLessThanOrEqual(DRIFT)
    // 总账守恒（上面 total 相等）⇒ 除 `closed` 外各档变化之和 = −closed 的变化量。
    const others = (state: Record<string, number>) =>
      ['done', 'lost', 'rework', 'queued', 'executing'].reduce((sum, key) => sum + (state[key] ?? 0), 0)
    expect(Math.abs((others(report.after.byState) - others(report.before.byState)) + delta.closed))
      .toBeLessThanOrEqual(DRIFT)
    // 没有任何一档被收尾以外的事件大规模搬动。
    for (const key of ['done', 'lost', 'rework']) {
      const moved = (report.after.byState[key] ?? 0) - (report.before.byState[key] ?? 0)
      expect(Math.abs(moved)).toBeLessThanOrEqual(closable + DRIFT)
    }
    if (report.closable.total > 0) {
      // 回填前：内存中收尾会让「已收尾」增加，并相应减少「进行中」（返工边被收尾）。
      expect(report.after.segment.closed).toBeGreaterThan(report.before.segment.closed)
      expect(report.after.segment.active).toBeLessThanOrEqual(report.before.segment.active)
    } else {
      // 回填后：已无可收尾记录 ⇒ 改前与改后相同、且未收尾为 0（这份对照因此自证"已回填"）。
      expect(report.after.segment).toEqual(report.before.segment)
      expect(report.before.segment.lost).toBe(0)
    }
  }, 20_000)
})
