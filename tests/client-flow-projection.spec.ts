import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { DevFlowClientSnapshot } from '../src/contract.ts'
import { DEVFLOW_CONCURRENCY_LIMIT } from '../src/contract.ts'
import { createWorkspaceModel } from '../src/client/workspace.ts'
import { buildOverview } from '../src/client/overview.ts'
import {
  FLOW_NODE_WIDTH,
  createFlowModel,
  orthogonalPath,
  relativeTime,
  routeEdge,
  type FlowEdge,
  type FlowEdgeState,
  type FlowNode,
  type LayoutBox,
} from '../src/client/flow-projection.ts'

/**
 * The instant the projection is judged against. Pinned so a "running execution"
 * fixture stays inside the live window no matter when the suite runs.
 */
const NOW = Date.parse('2026-09-14T06:00:00.000Z')

function snapshot(overrides: Partial<DevFlowClientSnapshot> = {}): DevFlowClientSnapshot {
  return {
    version: 1,
    generatedAt: '2026-09-14T04:00:00.000Z',
    session: { id: 'session-a', commanderMode: 'commander', presetId: 'devflow', activation: 'bound', activationError: null, verifiedAt: null },
    paused: false,
    project: { id: 'project-a', name: 'DevFlow', goal: 'Ship', currentStage: 'M7' },
    agents: [
      { id: 'commander', role: 'planner', kind: 'fixed', status: 'active', displayName: '总指挥', model: 'm', skills: [], capabilities: ['task-dispatch'], delegationDepth: 0 },
      { id: 'backend-engineer', role: 'backend-engineer', kind: 'fixed', status: 'active', displayName: '后端', model: 'm', skills: ['repository-conventions'], capabilities: ['backend-implementation'], delegationDepth: 0 },
      { id: 'code-auditor', role: 'reviewer', kind: 'fixed', status: 'active', displayName: '审计', model: 'm', skills: [], capabilities: ['code-review'], delegationDepth: 0 },
    ],
    tasks: [],
    phases: [],
    assignments: [],
    executions: [],
    results: [],
    reports: [],
    attempts: [],
    failures: [],
    decisions: [],
    decisionRequests: [],
    ...overrides,
  }
}

function model(
  source: DevFlowClientSnapshot,
  now: number = NOW,
  heights: Readonly<Record<string, number>> = {},
  scope: 'current' | 'history' = 'current',
) {
  return createFlowModel(createWorkspaceModel(source), now, heights, scope)
}

function states(edgeStates: readonly { readonly state: FlowEdgeState }[]): FlowEdgeState[] {
  return edgeStates.map(edge => edge.state)
}

describe('dispatch-flow projection', () => {
  it('shows only the read-only 用户需求 node and the commander when nothing was dispatched', () => {
    const flow = model(snapshot())
    // The 用户需求 node is its own node — it may never be merged into the commander.
    expect(flow.nodes.map(node => node.id)).toEqual(['requirement', 'commander'])
    expect(flow.nodes[0]?.kind).toBe('requirement')
    expect(flow.nodes[0]?.label).toBe('用户需求')
    expect(flow.nodes[0]?.sourceLabel).toBe('来源：用户')
    expect(flow.nodes[0]?.delegable).toBe(false)
    expect(flow.nodes[0]?.y).toBeLessThan(flow.nodes[1]?.y ?? 0)
    expect(flow.requirementEdge?.semantic).toBe('requirement')
    expect(flow.requirementEdge?.from).toBe('requirement')
    expect(flow.requirementEdge?.to).toBe('commander')
    expect(flow.history.edges).toHaveLength(0)
  })

  it('draws one edge per dispatched task, always with the commander as one end', () => {
    const flow = model(snapshot({
      tasks: [
        { id: 'task-a', title: 'Build bridge', description: 'Acceptance A', status: 'executing', updatedAt: '2026-09-14T03:00:00.000Z' },
        { id: 'task-b', title: 'Audit bridge', description: 'Acceptance B', status: 'completed', updatedAt: '2026-09-14T02:00:00.000Z' },
      ],
      assignments: [
        { id: 'assignment-a', taskId: 'task-a', phaseId: 'phase-a', agentId: 'backend-engineer', role: 'backend-engineer', status: 'in_progress' },
        { id: 'assignment-b', taskId: 'task-b', phaseId: 'phase-a', agentId: 'code-auditor', role: 'reviewer', status: 'completed' },
      ],
      executions: [
        { id: 'execution-a', assignmentId: 'assignment-a', taskId: 'task-a', agentId: 'backend-engineer', status: 'running', startedAt: '2026-09-14T05:50:00.000Z', completedAt: null },
        { id: 'execution-b', assignmentId: 'assignment-b', taskId: 'task-b', agentId: 'code-auditor', status: 'completed', startedAt: '2026-09-14T02:00:00.000Z', completedAt: '2026-09-14T02:20:00.000Z' },
      ],
    }))
    expect(flow.history.edges).toHaveLength(2)
    expect(flow.history.edges.every(edge => edge.from === 'commander' || edge.to === 'commander')).toBe(true)
    expect(states(flow.history.edges)).toEqual(['executing', 'done'])
    // 关系由线型与箭头方向表达：在飞的派发从总指挥出发，已交付的那条指回总指挥。
    expect(flow.history.edges[0]?.semantic).toBe('dispatch')
    expect(flow.history.edges[0]?.from).toBe('commander')
    expect(flow.history.edges[1]?.semantic).toBe('delivery')
    expect(flow.history.edges[1]?.from).toBe('code-auditor')
    expect(flow.history.edges[1]?.to).toBe('commander')
    expect(flow.history.edges[0]?.handoff.taskId).toBe('task-a')
    expect(flow.history.edges[0]?.handoff.acceptance.value).toBe('Acceptance A')
    expect(flow.history.edges[0]?.handoff.toLabel).toBe('代码工程师')
    expect(flow.history.edges[1]?.handoff.fromLabel).toBe('审计工程师')
    // Only employees named by a dispatch appear on the canvas.
    expect(flow.visibleAgentIds).toEqual(['backend-engineer', 'code-auditor'])
  })

  it('names the architect as 架构师 even though it shares the planner role', () => {
    // The architect sits on the `planner` role (the assigned-role enum has no
    // `architect`), so a role-only lookup labels its card 总指挥 — the same name
    // as the commander. The card label must come from the agent id.
    const flow = model(snapshot({
      agents: [
        { id: 'commander', role: 'planner', kind: 'fixed', status: 'active', displayName: '总指挥', model: 'm', skills: [], capabilities: [], delegationDepth: 0 },
        { id: 'architect', role: 'planner', kind: 'fixed', status: 'active', displayName: '总指挥', model: 'm', skills: ['archify'], capabilities: ['architecture-design'], delegationDepth: 0 },
      ],
      tasks: [{ id: 'task-arch', title: 'Design it', description: 'A', status: 'executing', updatedAt: '2026-09-14T03:00:00.000Z' }],
      assignments: [{ id: 'assignment-arch', taskId: 'task-arch', phaseId: 'phase-a', agentId: 'architect', role: 'planner', status: 'in_progress' }],
      executions: [{ id: 'execution-arch', assignmentId: 'assignment-arch', taskId: 'task-arch', agentId: 'architect', status: 'running', startedAt: '2026-09-14T05:50:00.000Z', completedAt: null }],
    }))
    const architect = flow.nodes.find(node => node.id === 'architect')
    expect(architect?.label).toBe('架构师')
    expect(architect?.roleLabel).toBe('架构师')
    expect(flow.nodes.find(node => node.id === 'commander')?.label).toBe('总指挥')
    // The two cards must never carry the same label.
    const labels = flow.nodes.filter(node => node.kind === 'commander' || node.kind === 'fixed').map(node => node.label)
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('shows every live execution as 执行中 when the snapshot carries two of them', () => {
    // 并发落地（路径 C）：宿主允许多个派发在同一轮真重叠，所以"多于一条 running 就只留
    // 最新一条"的降级已经不成立 —— 它会让面板否认正在发生的执行。两条都必须如实显示。
    const flow = model(snapshot({
      tasks: [
        { id: 'task-a', title: 'Backend', description: 'A', status: 'executing', updatedAt: '2026-09-14T03:00:00.000Z' },
        { id: 'task-c', title: 'Frontend', description: 'C', status: 'executing', updatedAt: '2026-09-14T03:05:00.000Z' },
      ],
      assignments: [
        { id: 'assignment-a', taskId: 'task-a', phaseId: 'phase-a', agentId: 'backend-engineer', role: 'backend-engineer', status: 'in_progress' },
        { id: 'assignment-c', taskId: 'task-c', phaseId: 'phase-a', agentId: 'code-auditor', role: 'reviewer', status: 'in_progress' },
      ],
      executions: [
        { id: 'execution-a', assignmentId: 'assignment-a', taskId: 'task-a', agentId: 'backend-engineer', status: 'running', startedAt: '2026-09-14T05:40:00.000Z', completedAt: null },
        { id: 'execution-c', assignmentId: 'assignment-c', taskId: 'task-c', agentId: 'code-auditor', status: 'running', startedAt: '2026-09-14T05:55:00.000Z', completedAt: null },
      ],
    }))
    expect(states(flow.history.edges)).toEqual(['executing', 'executing'])
    // 并发上限来自 host/client 共用的单点常量，`running` 是从快照数出来的。
    expect(flow.concurrency).toEqual({ running: 2, limit: 5, atLimit: false })
  })

  it('★ 零并发时输出与并发前逐字一致（深度相等用例，硬要求）', () => {
    // 并发能力是**附加**的：没有并发时必须与今天**逐字一致**。这里把"今天的面板输出"
    // 逐字段钉成期望值（等于从真实运行里冻结下来的读数），再与投影结果做深度相等比较；
    // 并发相关的**唯一**新增字段是 `concurrency`，在零并发下必须读作 `0/5`。
    const flow = model(snapshot({
      tasks: [
        { id: 'task-a', title: 'Build bridge', description: 'Acceptance A', status: 'executing', updatedAt: '2026-09-14T03:00:00.000Z' },
        { id: 'task-b', title: 'Audit bridge', description: 'Acceptance B', status: 'completed', updatedAt: '2026-09-14T02:00:00.000Z' },
      ],
      assignments: [
        { id: 'assignment-a', taskId: 'task-a', phaseId: 'phase-a', agentId: 'backend-engineer', role: 'backend-engineer', status: 'in_progress' },
        { id: 'assignment-b', taskId: 'task-b', phaseId: 'phase-a', agentId: 'code-auditor', role: 'reviewer', status: 'completed' },
      ],
      executions: [
        { id: 'execution-a', assignmentId: 'assignment-a', taskId: 'task-a', agentId: 'backend-engineer', status: 'completed', startedAt: '2026-09-14T03:00:00.000Z', completedAt: '2026-09-14T03:10:00.000Z' },
        { id: 'execution-b', assignmentId: 'assignment-b', taskId: 'task-b', agentId: 'code-auditor', status: 'completed', startedAt: '2026-09-14T02:00:00.000Z', completedAt: '2026-09-14T02:20:00.000Z' },
      ],
    }), NOW, {}, 'history')

    // 1) 一条 executing 都没有 ⇒ 并发读数必须是 0/5（不是估算，也不是省略）。
    expect(flow.concurrency).toEqual({ running: 0, limit: DEVFLOW_CONCURRENCY_LIMIT, atLimit: false })
    expect(DEVFLOW_CONCURRENCY_LIMIT).toBe(5)

    // 2) 边读数逐字不变：状态词、动作词、badge、语义、可见员工、计数、staleness 边界。
    const signature = (item: (typeof flow)['history']['edges'][number]) => ({
      id: item.id, from: item.from, to: item.to, state: item.state, semantic: item.semantic,
      // The badge's TIME segment is relative to `now`, so the frozen reading pins the
      // state word + action word and the module's own relative-time formatter supplies
      // the rest — "逐字一致" is asserted on the words, not on a clock.
      badgeState: item.badge.split(' · ').slice(0, 2).join(' · '),
      taskId: item.taskId, phaseId: item.phaseId,
    })
    const frozen = flow.history.edges.map(signature)
    expect(frozen).toEqual([
      {
        id: 'dispatch:assignment-a', from: 'backend-engineer', to: 'commander', state: 'done', semantic: 'delivery',
        badgeState: '已完成 · 交付结果', taskId: 'task-a', phaseId: 'phase-a',
      },
      {
        id: 'dispatch:assignment-b', from: 'code-auditor', to: 'commander', state: 'done', semantic: 'delivery',
        badgeState: '已完成 · 复核通过', taskId: 'task-b', phaseId: 'phase-a',
      },
    ])
    expect(flow.visibleAgentIds).toEqual(['backend-engineer', 'code-auditor'])
    expect(flow.lostCount).toBe(0)
    expect(flow.unroutedCount).toBe(0)
    expect(flow.staleBoundary).toBe('2026-09-14T03:10:00.000Z')

    // 3) 同一输入重新投影一次，必须与上一次**深度相等** —— 「附加改动没有动到既有输出」
    //    的机器可判定形式（不是靠人眼比文案）。
    expect(model(snapshot({
      tasks: [
        { id: 'task-a', title: 'Build bridge', description: 'Acceptance A', status: 'executing', updatedAt: '2026-09-14T03:00:00.000Z' },
        { id: 'task-b', title: 'Audit bridge', description: 'Acceptance B', status: 'completed', updatedAt: '2026-09-14T02:00:00.000Z' },
      ],
      assignments: [
        { id: 'assignment-a', taskId: 'task-a', phaseId: 'phase-a', agentId: 'backend-engineer', role: 'backend-engineer', status: 'in_progress' },
        { id: 'assignment-b', taskId: 'task-b', phaseId: 'phase-a', agentId: 'code-auditor', role: 'reviewer', status: 'completed' },
      ],
      executions: [
        { id: 'execution-a', assignmentId: 'assignment-a', taskId: 'task-a', agentId: 'backend-engineer', status: 'completed', startedAt: '2026-09-14T03:00:00.000Z', completedAt: '2026-09-14T03:10:00.000Z' },
        { id: 'execution-b', assignmentId: 'assignment-b', taskId: 'task-b', agentId: 'code-auditor', status: 'completed', startedAt: '2026-09-14T02:00:00.000Z', completedAt: '2026-09-14T02:20:00.000Z' },
      ],
    }), NOW, {}, 'history')).toEqual(flow)
  })

  it('★ 被降级的边 badge 不再自相矛盾（「排队中 · 执行槽占用」零命中）', () => {
    // 第十二步段一发现：`edgeAction` 只看 `state === 'executing'`，而降级发生在
    // `edgeState` 之后、badge 未重算 ⇒ 出现 `排队中 · 执行槽占用`（状态词与动作词矛盾）。
    // 本轮既删掉降级，也把动作词从"执行槽占用"改成"正在执行"，两层都堵住。
    const flow = model(snapshot({
      tasks: [
        { id: 'task-a', title: 'Backend', description: 'A', status: 'executing', updatedAt: '2026-09-14T03:00:00.000Z' },
        { id: 'task-c', title: 'Frontend', description: 'C', status: 'executing', updatedAt: '2026-09-14T03:05:00.000Z' },
      ],
      assignments: [
        { id: 'assignment-a', taskId: 'task-a', phaseId: 'phase-a', agentId: 'backend-engineer', role: 'backend-engineer', status: 'in_progress' },
        { id: 'assignment-c', taskId: 'task-c', phaseId: 'phase-a', agentId: 'code-auditor', role: 'reviewer', status: 'in_progress' },
      ],
      executions: [
        { id: 'execution-a', assignmentId: 'assignment-a', taskId: 'task-a', agentId: 'backend-engineer', status: 'running', startedAt: '2026-09-14T05:40:00.000Z', completedAt: null },
        { id: 'execution-c', assignmentId: 'assignment-c', taskId: 'task-c', agentId: 'code-auditor', status: 'running', startedAt: '2026-09-14T05:55:00.000Z', completedAt: null },
      ],
    }), NOW, {}, 'history')
    const badges = flow.history.edges.map(edge => edge.badge)
    expect(badges.every(badge => !badge.includes('执行槽'))).toBe(true)
    expect(badges.filter(badge => badge.includes('排队中 · 执行槽占用'))).toEqual([])
    // 两条都在跑 ⇒ 状态词与动作词必须自洽（动作词不再是「执行槽占用」）。
    expect(badges.map(badge => badge.split(' · ').slice(0, 2).join(' · ')))
      .toEqual(['执行中 · 正在执行', '执行中 · 正在执行'])
  })

  it('reports 并发 N/5 at the limit without inventing a fifth execution', () => {
    const executions = Array.from({ length: 6 }, (_, index) => ({
      id: `execution-${index}`, assignmentId: `assignment-${index}`, taskId: `task-${index}`, agentId: 'backend-engineer',
      status: 'running' as const, startedAt: '2026-09-14T05:40:00.000Z', completedAt: null,
    }))
    const flow = model(snapshot({
      tasks: executions.map((_, index) => ({ id: `task-${index}`, title: `T${index}`, description: 'A', status: 'executing' as const, updatedAt: '2026-09-14T03:00:00.000Z' })),
      // The same employee twice: the count is a fact about the ROW SET, not about
      // how many distinct cards the canvas happens to draw.
      assignments: executions.map((_, index) => ({ id: `assignment-${index}`, taskId: `task-${index}`, phaseId: 'phase-a', agentId: 'backend-engineer', role: 'backend-engineer' as const, status: 'in_progress' as const })),
      executions,
    }))
    expect(flow.concurrency.running).toBe(6)
    expect(flow.concurrency.limit).toBe(5)
    expect(flow.concurrency.atLimit).toBe(true)
  })

  it('marks a retried dispatch as 返工 and keeps the retry count', () => {
    const flow = model(snapshot({
      tasks: [{ id: 'task-a', title: 'Rework', description: 'A', status: 'executing', updatedAt: '2026-09-14T03:00:00.000Z' }],
      assignments: [{ id: 'assignment-a', taskId: 'task-a', phaseId: 'phase-a', agentId: 'backend-engineer', role: 'backend-engineer', status: 'in_progress' }],
      executions: [
        { id: 'execution-a', assignmentId: 'assignment-a', taskId: 'task-a', agentId: 'backend-engineer', status: 'failed', startedAt: '2026-09-14T02:00:00.000Z', completedAt: '2026-09-14T02:10:00.000Z' },
        { id: 'execution-a2', assignmentId: 'assignment-a', taskId: 'task-a', agentId: 'backend-engineer', status: 'pending', startedAt: null, completedAt: null },
      ],
      attempts: [{ id: 'attempt-a2', executionId: 'execution-a2', source: 'attempt', status: 'created', isRetry: true, at: '2026-09-14T03:00:00.000Z', completedAt: null }],
    }))
    expect(states(flow.history.edges)).toEqual(['rework'])
    expect(flow.history.edges[0]?.handoff.retryCount).toBe(2)
    expect(flow.history.edges[0]?.badge).toContain('返工')
    expect(flow.nodes.find(node => node.id === 'backend-engineer')?.state).toBe('rework')
  })

  it('defaults to one edge per employee and offers the full dispatch history on demand', () => {
    const flow = model(snapshot({
      tasks: [
        { id: 'task-a', title: 'First pass', description: 'A', status: 'completed', updatedAt: '2026-09-14T01:00:00.000Z' },
        { id: 'task-b', title: 'Rework pass', description: 'B', status: 'executing', updatedAt: '2026-09-14T03:00:00.000Z' },
        { id: 'task-c', title: 'Audit pass', description: 'C', status: 'completed', updatedAt: '2026-09-14T02:00:00.000Z' },
        { id: 'task-unassigned', title: 'Never dispatched', description: 'D', status: 'created', updatedAt: '2026-09-14T00:30:00.000Z' },
      ],
      assignments: [
        { id: 'assignment-a1', taskId: 'task-a', phaseId: 'phase-a', agentId: 'backend-engineer', role: 'backend-engineer', status: 'completed' },
        { id: 'assignment-b1', taskId: 'task-b', phaseId: 'phase-a', agentId: 'backend-engineer', role: 'backend-engineer', status: 'in_progress' },
        { id: 'assignment-c1', taskId: 'task-c', phaseId: 'phase-a', agentId: 'code-auditor', role: 'reviewer', status: 'completed' },
      ],
      executions: [
        { id: 'execution-a1', assignmentId: 'assignment-a1', taskId: 'task-a', agentId: 'backend-engineer', status: 'completed', startedAt: '2026-09-14T01:00:00.000Z', completedAt: '2026-09-14T01:10:00.000Z' },
        { id: 'execution-b1', assignmentId: 'assignment-b1', taskId: 'task-b', agentId: 'backend-engineer', status: 'running', startedAt: '2026-09-14T05:40:00.000Z', completedAt: null },
        { id: 'execution-c1', assignmentId: 'assignment-c1', taskId: 'task-c', agentId: 'code-auditor', status: 'completed', startedAt: '2026-09-14T02:00:00.000Z', completedAt: '2026-09-14T02:10:00.000Z' },
      ],
    }))
    // Every dispatch is kept in the history route, including the two that share an employee.
    expect(flow.history.edges).toHaveLength(3)
    expect(flow.history.edges.map(edge => edge.id)).toEqual(['dispatch:assignment-a1', 'dispatch:assignment-b1', 'dispatch:assignment-c1'])
    // The default route collapses to the dispatch still in flight per employee.
    expect(flow.current.edges).toHaveLength(2)
    expect(flow.current.edges.map(edge => edge.id)).toEqual(['dispatch:assignment-b1', 'dispatch:assignment-c1'])
    expect(flow.current.edges.find(edge => edge.id === 'dispatch:assignment-b1')?.state).toBe('executing')
    // A task that never reached an assignment is still declared, never drawn as a line.
    expect(flow.history.unroutedCount).toBe(1)
    expect(flow.current.unroutedCount).toBe(1)
  })

  it('never calls a stale running execution 执行中 — it is 未收尾 · 已失联', () => {
    // A running row from 3 days ago with no other activity: the host process that
    // owned it is long gone, so the canvas must not claim it is working.
    const flow = model(snapshot({
      tasks: [{ id: 'task-a', title: 'Old run', description: 'A', status: 'executing', updatedAt: '2026-09-11T03:00:00.000Z' }],
      assignments: [{ id: 'assignment-a', taskId: 'task-a', phaseId: 'phase-a', agentId: 'backend-engineer', role: 'backend-engineer', status: 'in_progress' }],
      executions: [{ id: 'execution-a', assignmentId: 'assignment-a', taskId: 'task-a', agentId: 'backend-engineer', status: 'running', startedAt: '2026-09-11T03:00:00.000Z', completedAt: null }],
    }))
    expect(states(flow.history.edges)).toEqual(['lost'])
    expect(flow.history.edges[0]?.badge).toContain('未收尾')
    expect(flow.lostCount).toBe(1)
    // A genuinely stale run is NOT counted as concurrency.
    expect(flow.concurrency).toEqual({ running: 0, limit: 5, atLimit: false })
    expect(flow.nodes.find(node => node.id === 'backend-engineer')?.state).toBe('lost')
  })

  it('★ keeps a running dispatch as 执行中 when ANOTHER dispatch finished later', () => {
    // 第十二步段一实测的误判形状：两条同时在跑 + 另有一条更晚完成。旧判据「running 但
    // 早于此后已完成的执行 ⇒ lost」把它按「阻塞派发只占一个执行槽」推断成失联，实测
    // 概览 active 2→0 / lost 0→2 —— 那是伪造状态。并发下这是**普通事实**，不是失联证据。
    const flow = model(snapshot({
      tasks: [
        { id: 'task-a', title: 'Stuck', description: 'A', status: 'executing', updatedAt: '2026-09-14T05:00:00.000Z' },
        { id: 'task-b', title: 'Later cycle', description: 'B', status: 'completed', updatedAt: '2026-09-14T05:30:00.000Z' },
      ],
      assignments: [
        { id: 'assignment-a', taskId: 'task-a', phaseId: 'phase-a', agentId: 'backend-engineer', role: 'backend-engineer', status: 'in_progress' },
        { id: 'assignment-b', taskId: 'task-b', phaseId: 'phase-a', agentId: 'code-auditor', role: 'reviewer', status: 'completed' },
      ],
      executions: [
        // Live: 20 minutes old, inside the 30-minute window, and STARTED BEFORE the
        // 05:30 completion below — exactly the shape the old hard rule misjudged.
        { id: 'execution-a', assignmentId: 'assignment-a', taskId: 'task-a', agentId: 'backend-engineer', status: 'running', startedAt: '2026-09-14T05:40:00.000Z', completedAt: null },
        { id: 'execution-b', assignmentId: 'assignment-b', taskId: 'task-b', agentId: 'code-auditor', status: 'completed', startedAt: '2026-09-14T05:25:00.000Z', completedAt: '2026-09-14T05:30:00.000Z' },
      ],
    }))
    expect(flow.history.edges.map(edge => edge.state).sort()).toEqual(['done', 'executing'])
    expect(flow.lostCount).toBe(0)
    expect(flow.concurrency.running).toBe(1)
    // The newest completion is still REPORTED (the inspector names it) — it just no
    // longer decides anything.
    expect(flow.staleBoundary).toBe('2026-09-14T05:30:00.000Z')
  })

  it('★ keeps 未收尾判定 by duration when a later completion exists too', () => {
    // 判据重设为「按时长/心跳」之后，「更晚完成」不再触发失联；触发它的是超阈值时长。
    // 这条同时证明"能力没被删掉"：真陈旧的 running 仍然被判「未收尾 · 已失联」。
    const flow = model(snapshot({
      tasks: [
        { id: 'task-a', title: 'Stuck', description: 'A', status: 'executing', updatedAt: '2026-09-11T03:00:00.000Z' },
        { id: 'task-b', title: 'Later cycle', description: 'B', status: 'completed', updatedAt: '2026-09-14T05:30:00.000Z' },
      ],
      assignments: [
        { id: 'assignment-a', taskId: 'task-a', phaseId: 'phase-a', agentId: 'backend-engineer', role: 'backend-engineer', status: 'in_progress' },
        { id: 'assignment-b', taskId: 'task-b', phaseId: 'phase-a', agentId: 'code-auditor', role: 'reviewer', status: 'completed' },
      ],
      executions: [
        { id: 'execution-a', assignmentId: 'assignment-a', taskId: 'task-a', agentId: 'backend-engineer', status: 'running', startedAt: '2026-09-11T03:00:00.000Z', completedAt: null },
        { id: 'execution-b', assignmentId: 'assignment-b', taskId: 'task-b', agentId: 'code-auditor', status: 'completed', startedAt: '2026-09-14T05:25:00.000Z', completedAt: '2026-09-14T05:30:00.000Z' },
      ],
    }))
    expect(flow.history.edges.map(edge => edge.state).sort()).toEqual(['done', 'lost'])
    // The lost edge states WHY (auditable from the inspector) — and the reason is the
    // duration, not "another dispatch finished later".
    expect(flow.history.edges.find(edge => edge.state === 'lost')?.handoff.statusLabel).toContain('超过 30 分钟无更新')
  })

  it('keeps an ancient dispatch with no execution out of 排队中', () => {
    const flow = model(snapshot({
      tasks: [{ id: 'task-a', title: 'Never started', description: 'A', status: 'planned', updatedAt: '2026-08-19T16:19:23.986Z' }],
      assignments: [{ id: 'assignment-a', taskId: 'task-a', phaseId: 'phase-a', agentId: 'backend-engineer', role: 'backend-engineer', status: 'assigned' }],
      executions: [],
    }))
    expect(states(flow.history.edges)).toEqual(['lost'])
    expect(flow.history.edges[0]?.badge).toContain('未收尾 · 已失联')
    // The reason is stated, so the state is auditable from the handoff inspector.
    expect(flow.history.edges[0]?.handoff.statusLabel).toContain('此后没有任何执行记录')
  })

  it('still calls a fresh dispatch with no execution 排队中', () => {
    const flow = model(snapshot({
      tasks: [{ id: 'task-a', title: 'Just dispatched', description: 'A', status: 'planned', updatedAt: '2026-09-14T05:58:00.000Z' }],
      assignments: [{ id: 'assignment-a', taskId: 'task-a', phaseId: 'phase-a', agentId: 'backend-engineer', role: 'backend-engineer', status: 'assigned' }],
      executions: [],
    }))
    expect(states(flow.history.edges)).toEqual(['queued'])
    expect(flow.history.edges[0]?.badge).toContain('排队中 · 已接收')
  })

  it('never invents an employee-to-employee edge or a fixed-employee delegation', () => {
    const flow = model(snapshot({
      tasks: [
        { id: 'task-a', title: 'Implement', description: 'A', status: 'completed', updatedAt: '2026-09-14T03:00:00.000Z' },
        { id: 'task-b', title: 'Audit', description: 'B', status: 'completed', updatedAt: '2026-09-14T02:00:00.000Z' },
      ],
      assignments: [
        { id: 'assignment-a', taskId: 'task-a', phaseId: 'phase-a', agentId: 'backend-engineer', role: 'backend-engineer', status: 'completed' },
        { id: 'assignment-b', taskId: 'task-b', phaseId: 'phase-a', agentId: 'code-auditor', role: 'reviewer', status: 'completed' },
      ],
      executions: [
        { id: 'execution-a', assignmentId: 'assignment-a', taskId: 'task-a', agentId: 'backend-engineer', status: 'completed', startedAt: '2026-09-14T03:00:00.000Z', completedAt: '2026-09-14T03:10:00.000Z' },
        { id: 'execution-b', assignmentId: 'assignment-b', taskId: 'task-b', agentId: 'code-auditor', status: 'completed', startedAt: '2026-09-14T02:00:00.000Z', completedAt: '2026-09-14T02:10:00.000Z' },
      ],
    }))
    // Architecture fact: every edge has the commander as one of its two ends. A
    // 交付·汇报 edge is drawn back INTO the commander, never employee-to-employee.
    const employeeIds = ['backend-engineer', 'frontend-engineer', 'code-auditor']
    for (const edge of flow.history.edges) {
      expect(edge.from === 'commander' || edge.to === 'commander').toBe(true)
      expect(employeeIds.includes(edge.from) && employeeIds.includes(edge.to)).toBe(false)
    }
    for (const node of flow.nodes.filter(item => item.kind === 'fixed' && item.id !== 'commander')) {
      expect(node.delegationLabel).toContain('委派深度 0 · 不能再派子代理')
      expect(node.delegable).toBe(false)
      // The sub-agent fact is its own field: gluing it into the depth line produced
      // the contradictory "不能再派子代理（总指挥现场创建…）" the boss flagged.
      expect(node.subagentNote).toBe('子代理：固定员工没有委派能力')
      expect(node.delegationLabel).not.toContain('（')
    }
    expect(flow.nodes.find(node => node.id === 'commander')?.subagentNote).toContain('只可由总指挥现场创建')
    expect(flow.nodes.find(node => node.id === 'requirement')?.subagentNote).toContain('不适用')
  })

  it('carries the phase task list the inspector shows, without inventing links', () => {
    const flow = model(snapshot({
      phases: [{ id: 'phase-a', name: '画布布局', description: '', status: 'in_progress' }],
      tasks: [
        { id: 'task-a', title: 'Already dispatched', description: 'A', status: 'completed', updatedAt: '2026-09-14T01:00:00.000Z' },
        { id: 'task-b', title: 'Never dispatched', description: 'B', status: 'planned', updatedAt: '2026-09-14T02:00:00.000Z' },
      ],
      assignments: [
        { id: 'assignment-a', taskId: 'task-a', phaseId: 'phase-a', agentId: 'backend-engineer', role: 'backend-engineer', status: 'completed' },
      ],
      executions: [
        { id: 'execution-a', assignmentId: 'assignment-a', taskId: 'task-a', agentId: 'backend-engineer', status: 'completed', startedAt: '2026-09-14T01:00:00.000Z', completedAt: '2026-09-14T01:10:00.000Z' },
      ],
    }))
    const band = flow.bands[0]
    expect(band?.name).toBe('画布布局')
    // The phase link the browser contract carries is the ASSIGNMENT's phaseId, so a
    // task that never reached an assignment has no phase association at all and is
    // therefore not listed under any band (no link is invented for it).
    expect(band?.tasks.map(task => task.id)).toEqual(['task-a'])
    expect(band?.tasks[0]?.title).toBe('Already dispatched')
    expect(band?.tasks[0]?.stateLabel).toBe('Completed')
    expect(band?.taskCount).toBe(1)
  })

  it('gives every drawn dispatch its own lane, band and port so nothing overlaps', () => {
    const flow = model(historySnapshot(), NOW, {}, 'history')
    // One unique lane per edge: two edges can never share a horizontal run.
    const lanes = flow.edges.map(edge => edge.laneY)
    expect(new Set(lanes).size).toBe(flow.edges.length)
    // One 阶段关联带 per phase that actually carries a dispatch.
    expect(flow.bands).toHaveLength(1)
    expect(flow.bands[0]?.dispatchCount).toBe(3)
    expect(flow.bands[0]?.taskCount).toBe(3)
    expect(flow.bands[0]?.label).toBe('阶段关联 1')
    // Ports are distinct per card side, so a bundle fans out instead of stacking.
    const commanderPorts = flow.edges.filter(edge => edge.from === 'commander').map(edge => edge.fromPort)
    expect(new Set(commanderPorts).size).toBe(commanderPorts.length)
    // Each band's slot actually covers its lanes.
    const band = flow.bands[0]
    for (const lane of lanes) {
      expect(lane).toBeGreaterThanOrEqual((band?.y ?? 0) - 0.001)
      expect(lane).toBeLessThanOrEqual((band?.y ?? 0) + (band?.height ?? 0) + 0.001)
    }
  })

  it('keeps the association bands in phase order and splits one band per phase', () => {
    const flow = model(snapshot({
      phases: [
        { id: 'phase-late', name: '后来的阶段', description: '', status: 'in_progress' },
        { id: 'phase-early', name: '较早的阶段', description: '', status: 'completed' },
      ],
      tasks: [
        { id: 'task-a', title: 'Early', description: 'A', status: 'completed', updatedAt: '2026-09-14T01:00:00.000Z' },
        { id: 'task-b', title: 'Late', description: 'B', status: 'completed', updatedAt: '2026-09-14T03:00:00.000Z' },
      ],
      assignments: [
        { id: 'assignment-a', taskId: 'task-a', phaseId: 'phase-early', agentId: 'backend-engineer', role: 'backend-engineer', status: 'completed' },
        { id: 'assignment-b', taskId: 'task-b', phaseId: 'phase-late', agentId: 'code-auditor', role: 'reviewer', status: 'completed' },
      ],
      executions: [
        { id: 'execution-a', assignmentId: 'assignment-a', taskId: 'task-a', agentId: 'backend-engineer', status: 'completed', startedAt: '2026-09-14T01:00:00.000Z', completedAt: '2026-09-14T01:10:00.000Z' },
        { id: 'execution-b', assignmentId: 'assignment-b', taskId: 'task-b', agentId: 'code-auditor', status: 'completed', startedAt: '2026-09-14T03:00:00.000Z', completedAt: '2026-09-14T03:10:00.000Z' },
      ],
    }), NOW, {}, 'history')
    // Association order comes from the earliest real execution evidence, because
    // the phase's `createdAt` is not part of the browser contract.
    expect(flow.bands.map(band => band.name)).toEqual(['较早的阶段', '后来的阶段'])
    expect(flow.bands.map(band => band.statusLabel)).toEqual(['已完成', '进行中'])
    expect(flow.bands[0]?.dispatchCount).toBe(1)
    expect(flow.bands[1]?.dispatchCount).toBe(1)
  })

  it('routes every edge around the cards instead of through them', () => {
    const flow = model(historySnapshot(), NOW, {}, 'history')
    const boxes = new Map(flow.nodes.map(node => [node.id, {
      x: node.x, y: node.y, width: node.id === 'requirement' ? 208 : FLOW_NODE_WIDTH, height: 118,
    }]))
    for (const edge of flow.edges) {
      const geometry = routeEdge(edge.from, edge.to, edge.fromPort, edge.toPort, edge.laneY, boxes)
      const points = samplePath(geometry.path)
      for (const [id, box] of boxes) {
        if (id === edge.from || id === edge.to) continue
        const inside = points.filter(point => point.x > box.x && point.x < box.x + box.width
          && point.y > box.y && point.y < box.y + box.height)
        expect(inside, `${edge.id} passes through ${id}`).toHaveLength(0)
      }
    }
  })

  it('lays nodes out inside the declared canvas box with the employees in one row', () => {
    const single = model(snapshot({
      tasks: [{ id: 'task-a', title: 'Only', description: 'A', status: 'executing', updatedAt: '2026-09-14T03:00:00.000Z' }],
      assignments: [{ id: 'assignment-a', taskId: 'task-a', phaseId: 'phase-a', agentId: 'backend-engineer', role: 'backend-engineer', status: 'in_progress' }],
      executions: [{ id: 'execution-a', assignmentId: 'assignment-a', taskId: 'task-a', agentId: 'backend-engineer', status: 'running', startedAt: '2026-09-14T03:00:00.000Z', completedAt: null }],
    }))
    for (const node of single.nodes) {
      const width = node.kind === 'requirement' ? 208 : FLOW_NODE_WIDTH
      expect(node.x).toBeGreaterThanOrEqual(0)
      expect(node.x + width).toBeLessThanOrEqual(single.canvasWidth)
      expect(node.y + 90).toBeLessThanOrEqual(single.canvasHeight)
    }
    const rows = new Set(single.nodes.filter(node => node.kind === 'fixed' || node.kind === 'temporary').map(node => node.y))
    expect(rows.size).toBe(1)
    // The requirement node is the top rank, the commander the one below it.
    expect(rankOf(single.nodes, 'requirement')).toBeLessThan(rankOf(single.nodes, 'commander'))
    expect(rankOf(single.nodes, 'commander')).toBeLessThan(rankOf(single.nodes, 'backend-engineer'))
  })

  it('keeps every port on a globally unique x, so no two edges can be drawn on top of each other', () => {
    const flow = model(historySnapshot(), NOW, {}, 'history')
    const boxes = new Map(flow.nodes.map(node => [node.id, {
      x: node.x, y: node.y, width: node.id === 'requirement' ? 208 : FLOW_NODE_WIDTH, height: 118,
    }]))
    const seen = new Map<number, string>()
    const record = (x: number, label: string): void => {
      const key = Math.round(x * 10) / 10
      const previous = seen.get(key)
      expect(previous === undefined || previous === label, `x=${key} reused by ${String(previous)} and ${label}`).toBe(true)
      seen.set(key, label)
    }
    for (const edge of flow.edges) {
      const from = boxes.get(edge.from)
      const to = boxes.get(edge.to)
      record((from?.x ?? 0) + (from?.width ?? 0) / 2 + edge.fromPort, `${edge.id}:from`)
      record((to?.x ?? 0) + (to?.width ?? 0) / 2 + edge.toPort, `${edge.id}:to`)
    }
    // Every lane is unique too, which is what makes the horizontal runs disjoint.
    expect(new Set(flow.edges.map(edge => edge.laneY)).size).toBe(flow.edges.length)
  })

  it('builds a rounded orthogonal path and a bounded relative-time label', () => {
    const path = orthogonalPath([{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 80, y: 100 }, { x: 80, y: 300 }], 5)
    expect(path.startsWith('M0 0 L0 95')).toBe(true)
    expect(path).toContain('Q0 100 5 100')
    expect(path.endsWith('L80 300')).toBe(true)
    expect(orthogonalPath([], 5)).toBe('')
    expect(relativeTime('2026-09-14T03:59:56.000Z', Date.parse('2026-09-14T04:00:00.000Z'))).toBe('4 秒前')
    expect(relativeTime('not-a-date')).toBeNull()
  })

  it('never names a task dependency: relations are 关联 only', () => {
    const client = join(process.cwd(), 'src', 'client')
    const sources = readdirSync(client).filter(name => /\.tsx?$/.test(name))
    const forbidden = /依赖|前置|解锁|blockedBy|dependsOn|dependencies/
    for (const name of sources) {
      // Comments document the discipline; the check is about what the panel can
      // actually render, so only code and string literals are scanned.
      const text = readFileSync(join(client, name), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
      expect(forbidden.test(text), `${name} must not claim a task dependency`).toBe(false)
    }
  })
})

/**
 * 第十一步: a temporary sub-agent the Commander creates on the spot must be
 * visible — card, edge and count together. Everything the projection needs for
 * that (the `temporary` node kind, the `agentNode` branch, the `subagent`
 * relation, the `archived` node state) shipped in the first canvas revision; a
 * single entry filter kept all of it unreachable. These cases pin both halves:
 * the entry is open, AND opening it changes nothing when no temporary employee
 * has any record.
 */
describe('temporary sub-agent mapping (第十一步)', () => {
  const TEMPORARY_ID = 'researcher-refs'

  /** The shipped-shape fixture: two fixed employees, one dispatch each. */
  function fixedOnly(): DevFlowClientSnapshot {
    return snapshot({
      phases: [{ id: 'phase-a', name: '调研', description: '', status: 'in_progress' }],
      tasks: [
        { id: 'task-a', title: 'First pass', description: 'A', status: 'completed', updatedAt: '2026-09-14T01:00:00.000Z' },
        { id: 'task-b', title: 'Second pass', description: 'B', status: 'completed', updatedAt: '2026-09-14T02:00:00.000Z' },
      ],
      assignments: [
        { id: 'assignment-a', taskId: 'task-a', phaseId: 'phase-a', agentId: 'backend-engineer', role: 'backend-engineer', status: 'completed' },
        { id: 'assignment-b', taskId: 'task-b', phaseId: 'phase-a', agentId: 'code-auditor', role: 'reviewer', status: 'completed' },
      ],
      executions: [
        { id: 'execution-a', assignmentId: 'assignment-a', taskId: 'task-a', agentId: 'backend-engineer', status: 'completed', startedAt: '2026-09-14T01:00:00.000Z', completedAt: '2026-09-14T01:10:00.000Z' },
        { id: 'execution-b', assignmentId: 'assignment-b', taskId: 'task-b', agentId: 'code-auditor', status: 'completed', startedAt: '2026-09-14T02:00:00.000Z', completedAt: '2026-09-14T02:10:00.000Z' },
      ],
    })
  }

  /** One temporary employee with NO record at all — the "not selected yet" shape. */
  function withUnrecordedTemporary(): DevFlowClientSnapshot {
    const base = fixedOnly()
    return {
      ...base,
      agents: [...base.agents, {
        id: TEMPORARY_ID, role: 'planner', kind: 'temporary', status: 'created',
        displayName: '临时调研员', model: 'm', skills: [], capabilities: [], delegationDepth: 1,
      }],
    }
  }

  /** The real N5 shape: registered temporary employee + assignment + failed execution. */
  function withTemporaryDispatch(): DevFlowClientSnapshot {
    const base = withUnrecordedTemporary()
    return {
      ...base,
      tasks: [...base.tasks, {
        id: 'task-c', title: '调研 2 个优秀案例项目的目录结构', description: 'C',
        status: 'failed', updatedAt: '2026-09-14T03:00:00.000Z',
      }],
      assignments: [...base.assignments, {
        id: 'assignment-c', taskId: 'task-c', phaseId: 'phase-a',
        agentId: TEMPORARY_ID, role: 'planner', status: 'assigned',
      }],
      executions: [...base.executions, {
        id: 'execution-c', assignmentId: 'assignment-c', taskId: 'task-c', agentId: TEMPORARY_ID,
        status: 'failed', startedAt: '2026-09-14T03:00:00.000Z', completedAt: '2026-09-14T03:05:00.000Z',
      }],
      failures: [...base.failures, {
        id: 'execution-execution-c', executionId: 'execution-c', taskId: 'task-c',
        agentId: TEMPORARY_ID, source: 'execution', status: 'failed',
        at: '2026-09-14T03:05:00.000Z', summary: null,
      }],
    }
  }

  it('draws nothing new when a temporary employee has no record at all', () => {
    // The hard requirement: opening the entry must not move, resize or redraw a
    // canvas that has no temporary sub-agent work on it.
    const bare = model(fixedOnly())
    const unrecorded = model(withUnrecordedTemporary())
    expect(unrecorded).toEqual(bare)
    expect(unrecorded.nodes.map(node => node.id)).toEqual(['requirement', 'commander', 'backend-engineer', 'code-auditor'])
    expect(unrecorded.unroutedCount).toBe(bare.unroutedCount)
  })

  it('gives a dispatched temporary sub-agent a card, a 子代理 edge, and a settled count', () => {
    const bare = model(fixedOnly())
    const flow = model(withTemporaryDispatch(), NOW, {}, 'history')

    // Card: the node exists, carries the temporary kind the canvas styles on, and
    // says where it came from.
    const node = flow.nodes.find(item => item.id === TEMPORARY_ID)
    expect(node?.kind).toBe('temporary')
    expect(node?.designTarget).toBe(true)
    expect(node?.delegable).toBe(true)
    expect(node?.subagentNote).toContain('临时子代理')
    // The failed execution makes it a 返工 card, not an idle one.
    expect(node?.state).toBe('rework')

    // Edge: the dispatch to it is drawn, as the 子代理 relation, and it is ROUTED —
    // which is the whole point (it used to be counted as 未落点 and never drawn).
    // `FlowEdge` exposes its ends as `from`/`to`, never the raw agent id.
    const edge = flow.history.edges.find(item => item.to === TEMPORARY_ID)
    expect(edge).toBeDefined()
    expect(edge?.semantic).toBe('subagent')
    expect(edge?.from).toBe('commander')
    // The sub-agent's own name, NOT the commander's: a temporary employee is
    // registered under a fixed role (`planner`), whose role label is 总指挥.
    expect(edge?.toLabel).toBe('临时调研员')
    expect(flow.unroutedCount).toBe(bare.unroutedCount)
    expect(flow.unroutedCount).toBe(0)

    // Layout: one more column, and the temporary card sits in the employees' row.
    expect(flow.nodes.length).toBe(bare.nodes.length + 1)
    expect(flow.canvasWidth).toBeGreaterThan(bare.canvasWidth)
    const employeeRow = flow.nodes.filter(item => item.kind === 'fixed' || item.kind === 'temporary').map(item => item.y)
    expect(new Set(employeeRow).size).toBe(1)
    expect(node?.y).toBe(employeeRow[0])

    // The fixed employees' cards keep everything that is a fact about them. Their
    // x/y are NOT compared: the extra column re-centres the whole row on purpose
    // (that is the declared cost of mapping a temporary sub-agent).
    const card = (node: FlowNode) => {
      const { x: _x, y: _y, ...rest } = node
      return rest
    }
    for (const id of ['backend-engineer', 'code-auditor']) {
      expect(card(flow.nodes.find(item => item.id === id) as FlowNode))
        .toEqual(card(bare.nodes.find(item => item.id === id) as FlowNode))
    }
  })

  it('shows the same temporary employee in the overview roster, so card and count agree', () => {
    const view = buildOverview(createWorkspaceModel(withTemporaryDispatch()), NOW, null)
    const member = view.members.find(item => item.id === TEMPORARY_ID)
    expect(member?.name).toBe('临时调研员')
    // The overview row and the canvas card read the same derived state.
    expect(member?.state).toBe('rework')
    expect(member?.kind).toBe('temporary')
    expect(member?.taskTitle).toBe('调研 2 个优秀案例项目的目录结构')
    // ...the fixed rows keep their place and their own kind...
    expect(view.members.map(item => item.id)).toEqual(['backend-engineer', 'code-auditor', TEMPORARY_ID])
    expect(view.members.filter(item => item.kind === 'fixed').map(item => item.id))
      .toEqual(['backend-engineer', 'code-auditor'])
  })

  it('lists no temporary row when the temporary employee has no record', () => {
    // The float must not claim an employee the canvas does not draw.
    const view = buildOverview(createWorkspaceModel(withUnrecordedTemporary()), NOW, null)
    expect(view.members.map(item => item.id)).toEqual(['backend-engineer', 'code-auditor'])
    expect(view.members.some(item => item.kind === 'temporary')).toBe(false)
  })

  /**
   * The N5 failure that is NOT about the temporary roster at all: one assignment
   * whose first execution failed and whose retry then delivered.
   *
   * N5, 2026-09-19: `researcher-refs`' assignment 901b9afc carried execution
   * 46043611 (failed 17:29) and then aae2028d (completed 17:52). The panel showed
   * 返工中 while the chat had already shown the delivered result, because the task's
   * work state read "failed" from the RETRY HISTORY rather than from the current
   * attempt. These cases pin the current-attempt rule.
   */
  describe('one assignment, failed then delivered', () => {
    const FAILED = {
      id: 'execution-failed', assignmentId: 'assignment-temp', taskId: 'task-temp',
      agentId: TEMPORARY_ID, status: 'failed' as const,
      startedAt: '2026-09-14T01:00:00.000Z', completedAt: '2026-09-14T01:05:00.000Z',
    }
    const DELIVERED = {
      id: 'execution-delivered', assignmentId: 'assignment-temp', taskId: 'task-temp',
      agentId: TEMPORARY_ID, status: 'completed' as const,
      startedAt: '2026-09-14T02:00:00.000Z', completedAt: '2026-09-14T02:30:00.000Z',
    }

    /** The retry-then-delivered shape, with the task where the host leaves it. */
    function retried(taskStatus: 'executing' | 'reviewing', executions: DevFlowClientSnapshot['executions']) {
      return snapshot({
        agents: [...fixedOnly().agents, {
          id: TEMPORARY_ID, role: 'planner', kind: 'temporary', status: 'created',
          displayName: '临时调研员', model: 'm', skills: [], capabilities: [], delegationDepth: 1,
        }],
        tasks: [{ id: 'task-temp', title: '调研', description: 'd', status: taskStatus, updatedAt: '2026-09-14T02:30:00.000Z' }],
        phases: [{ id: 'phase-a', name: '调研', description: '', status: 'in_progress' }],
        assignments: [{ id: 'assignment-temp', taskId: 'task-temp', phaseId: 'phase-a', agentId: TEMPORARY_ID, role: 'planner', status: 'completed' }],
        executions: [...executions],
      })
    }

    it('reads 已完成 once the retry delivered, whichever order the rows arrive in', () => {
      for (const rows of [[FAILED, DELIVERED], [DELIVERED, FAILED]]) {
        const model = createWorkspaceModel(retried('reviewing', rows))
        const flow = createFlowModel(model, NOW, {}, 'history')
        // The task's own state no longer claims 返工 from its retry history...
        expect(model.taskById.get('task-temp')?.workState).toBe('reviewing')
        // ...so the dispatch reads 已完成 · 交付结果, not 返工 · 派发返工.
        const edge = flow.history.edges.find(item => item.to === TEMPORARY_ID)
        expect(edge?.state).toBe('done')
        expect(edge?.badge).toContain('交付结果')
        expect(edge?.badge).not.toContain('派发返工')
      }
    })

    it('still reads 返工 while the retry is the current attempt', () => {
      const running = { ...DELIVERED, id: 'execution-running', status: 'running' as const, startedAt: '2026-09-14T05:55:00.000Z', completedAt: null }
      const model = createWorkspaceModel(retried('executing', [FAILED, running]))
      const flow = createFlowModel(model, NOW, {}, 'history')
      const edge = flow.history.edges.find(item => item.to === TEMPORARY_ID)
      // A live current attempt is 执行中 — the failure is history, not the state.
      expect(edge?.state).toBe('executing')

      const failedAgain = { ...DELIVERED, id: 'execution-failed-again', status: 'failed' as const, startedAt: '2026-09-14T05:55:00.000Z', completedAt: '2026-09-14T05:58:00.000Z' }
      const second = createWorkspaceModel(retried('executing', [FAILED, failedAgain]))
      const secondEdge = createFlowModel(second, NOW, {}, 'history').history.edges.find(item => item.to === TEMPORARY_ID)
      // The NEWEST attempt failed ⇒ 返工, with the whole history kept as a count:
      // one failed execution plus one failed retry attempt.
      expect(secondEdge?.state).toBe('rework')
      expect(secondEdge?.badge).toContain('返工 2 次')
    })

    it('keeps a task with no successful attempt at 返工', () => {
      const model = createWorkspaceModel(retried('executing', [FAILED]))
      const flow = createFlowModel(model, NOW, {}, 'history')
      expect(model.taskById.get('task-temp')?.workState).toBe('failed')
      expect(flow.history.edges.find(item => item.to === TEMPORARY_ID)?.state).toBe('rework')
    })

    it('survives a record whose current attempt cannot be read from one row alone', () => {
      // A no-evidence execution row (`null` timestamps both ways) must not beat a
      // dated one just because it happens to sit later in the array.
      const undated = { ...DELIVERED, id: 'execution-undated', startedAt: null, completedAt: null }
      const model = createWorkspaceModel(retried('reviewing', [undated, FAILED, DELIVERED]))
      expect(model.taskById.get('task-temp')?.workState).toBe('reviewing')
    })
  })
})

/** A snapshot with three dispatches to two employees, all in one phase. */
function historySnapshot(): DevFlowClientSnapshot {
  return snapshot({
    phases: [{ id: 'phase-a', name: '画布布局', description: '', status: 'in_progress' }],
    tasks: [
      { id: 'task-a', title: 'First pass', description: 'A', status: 'completed', updatedAt: '2026-09-14T01:00:00.000Z' },
      { id: 'task-b', title: 'Rework pass', description: 'B', status: 'completed', updatedAt: '2026-09-14T03:00:00.000Z' },
      { id: 'task-c', title: 'Audit pass', description: 'C', status: 'completed', updatedAt: '2026-09-14T02:00:00.000Z' },
    ],
    assignments: [
      { id: 'assignment-a1', taskId: 'task-a', phaseId: 'phase-a', agentId: 'backend-engineer', role: 'backend-engineer', status: 'completed' },
      { id: 'assignment-b1', taskId: 'task-b', phaseId: 'phase-a', agentId: 'backend-engineer', role: 'backend-engineer', status: 'completed' },
      { id: 'assignment-c1', taskId: 'task-c', phaseId: 'phase-a', agentId: 'code-auditor', role: 'reviewer', status: 'completed' },
    ],
    executions: [
      { id: 'execution-a1', assignmentId: 'assignment-a1', taskId: 'task-a', agentId: 'backend-engineer', status: 'completed', startedAt: '2026-09-14T01:00:00.000Z', completedAt: '2026-09-14T01:10:00.000Z' },
      { id: 'execution-b1', assignmentId: 'assignment-b1', taskId: 'task-b', agentId: 'backend-engineer', status: 'completed', startedAt: '2026-09-14T03:00:00.000Z', completedAt: '2026-09-14T03:10:00.000Z' },
      { id: 'execution-c1', assignmentId: 'assignment-c1', taskId: 'task-c', agentId: 'code-auditor', status: 'completed', startedAt: '2026-09-14T02:00:00.000Z', completedAt: '2026-09-14T02:10:00.000Z' },
    ],
  })
}

function rankOf(nodes: readonly FlowNode[], id: string): number {
  const node = nodes.find(item => item.id === id)
  return node === undefined ? Number.MAX_SAFE_INTEGER : node.y
}

/** Sample one `d` attribute into world-space points for geometric assertions. */
function samplePath(path: string, steps = 200): readonly { readonly x: number; readonly y: number }[] {
  const commands = [...path.matchAll(/([MLQ])([-\d. ]+)/g)]
  const points: { x: number; y: number }[] = []
  let cursor = { x: 0, y: 0 }
  for (const command of commands) {
    const values = (command[2] ?? '').trim().split(/[ ,]+/).map(Number)
    if (command[1] === 'M' || command[1] === 'L') {
      cursor = { x: values[0] ?? 0, y: values[1] ?? 0 }
      points.push(cursor)
      continue
    }
    const control = { x: values[0] ?? 0, y: values[1] ?? 0 }
    const end = { x: values[2] ?? 0, y: values[3] ?? 0 }
    const start = cursor
    for (let step = 1; step <= steps / 4; step += 1) {
      const t = step / (steps / 4)
      const x = (1 - t) ** 2 * start.x + 2 * (1 - t) * t * control.x + t ** 2 * end.x
      const y = (1 - t) ** 2 * start.y + 2 * (1 - t) * t * control.y + t ** 2 * end.y
      points.push({ x, y })
    }
    cursor = end
  }
  return points
}
