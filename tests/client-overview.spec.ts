import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { DevFlowClientSnapshot } from '../src/contract.ts'
import { createWorkspaceModel } from '../src/client/workspace.ts'
import { createFlowModel } from '../src/client/flow-projection.ts'
import { motionProfile, motionRate } from '../src/client/motion.ts'
import { applyPausePresentation, PAUSED_LABEL } from '../src/client/pause-presentation.ts'
import {
  LONG_FRAME_MS,
  LONG_FRAME_STREAK,
  MOTION_QUIET_MS,
  MotionBudget,
  RECOVER_MS,
  meanFrameMs,
  readGlassOverride,
} from '../src/client/motion-budget.ts'
import {
  OVERVIEW_CLOSED_KEY,
  OVERVIEW_EXPANDED_KEY,
  buildOverview,
  connectionDetail,
  connectionLabel,
  hiddenDispatchCount,
  overviewGate,
} from '../src/client/overview.ts'
import { DEVFLOW_FLOW_CSS } from '../src/client/flow-css.ts'

/** The float's own source, read as text so "no second channel" is asserted, not assumed. */
const OVERVIEW_SOURCE = readFileSync(new URL('../src/client/DevFlowOverview.tsx', import.meta.url), 'utf8')

/** A snapshot with one running dispatch, one finished-and-accepted, one awaiting review. */
function snapshot(overrides: Partial<DevFlowClientSnapshot> = {}): DevFlowClientSnapshot {
  return {
    version: 1,
    generatedAt: '2026-09-15T10:00:00.000Z',
    session: { id: 'session-a', commanderMode: 'commander', presetId: 'devflow', activation: 'bound', activationError: null, verifiedAt: '2026-09-15T09:59:00.000Z' },
    paused: false,
    project: { id: 'project-a', name: 'DevFlow', goal: 'ship', currentStage: 'M8' },
    agents: [
      { id: 'commander', role: 'planner', kind: 'fixed', status: 'active', displayName: '总指挥', model: 'deepseek-chat', skills: [], capabilities: [], delegationDepth: 0 },
      { id: 'backend-engineer', role: 'backend-engineer', kind: 'fixed', status: 'active', displayName: '后端', model: 'deepseek-chat', skills: ['repo'], capabilities: [], delegationDepth: 0 },
      { id: 'code-auditor', role: 'reviewer', kind: 'fixed', status: 'active', displayName: '审计', model: 'deepseek-chat', skills: ['review'], capabilities: [], delegationDepth: 0 },
    ],
    tasks: [
      { id: 'task-run', title: 'Running work', description: 'd', status: 'executing', updatedAt: '2026-09-15T09:50:00.000Z' },
      { id: 'task-review', title: 'Awaiting review', description: 'd', status: 'reviewing', updatedAt: '2026-09-15T09:40:00.000Z' },
      { id: 'task-done', title: 'Accepted work', description: 'd', status: 'completed', updatedAt: '2026-09-15T09:30:00.000Z' },
    ],
    phases: [{ id: 'phase-a', name: 'P1', description: 'p', status: 'in_progress' }],
    assignments: [
      { id: 'assignment-run', taskId: 'task-run', phaseId: 'phase-a', agentId: 'backend-engineer', role: 'backend-engineer', status: 'in_progress' },
      { id: 'assignment-review', taskId: 'task-review', phaseId: 'phase-a', agentId: 'code-auditor', role: 'reviewer', status: 'in_progress' },
      { id: 'assignment-done', taskId: 'task-done', phaseId: 'phase-a', agentId: 'backend-engineer', role: 'backend-engineer', status: 'completed' },
    ],
    executions: [
      { id: 'execution-run', assignmentId: 'assignment-run', taskId: 'task-run', agentId: 'backend-engineer', status: 'running', startedAt: '2026-09-15T09:59:00.000Z', completedAt: null },
      { id: 'execution-review', assignmentId: 'assignment-review', taskId: 'task-review', agentId: 'code-auditor', status: 'completed', startedAt: '2026-09-15T09:30:00.000Z', completedAt: '2026-09-15T09:45:00.000Z' },
      { id: 'execution-done', assignmentId: 'assignment-done', taskId: 'task-done', agentId: 'backend-engineer', status: 'completed', startedAt: '2026-09-15T09:00:00.000Z', completedAt: '2026-09-15T09:20:00.000Z' },
    ],
    decisions: [],
    decisionRequests: [],
    ...overrides,
  }
}

const NOW = Date.parse('2026-09-15T10:00:00.000Z')

describe('step 3B overview gate — deny by default', () => {
  it('allows exactly one case: the preset is literally devflow', () => {
    const allowed = overviewGate({ current: 's1', byId: { s1: { projectionValues: { agentPreset: 'devflow' } } } })
    expect(allowed).toEqual({ allowed: true, sessionId: 's1', preset: 'devflow', reason: 'allowed' })
  })

  it('refuses standard mode and every other preset', () => {
    for (const preset of ['standard', 'minimal', 'cordis', 'DevFlow', 'devflow ']) {
      const gate = overviewGate({ current: 's1', byId: { s1: { projectionValues: { agentPreset: preset } } } })
      expect(gate.allowed).toBe(false)
      expect(gate.reason).toBe('other-preset')
      expect(gate.preset).toBe(preset)
    }
  })

  it('refuses a session with no recorded preset — an old session never appears', () => {
    expect(overviewGate({ current: 's1', byId: { s1: { projectionValues: {} } } }))
      .toEqual({ allowed: false, sessionId: 's1', preset: null, reason: 'preset-unresolved' })
    expect(overviewGate({ current: 's1', byId: { s1: {} } }).reason).toBe('preset-unresolved')
    expect(overviewGate({ current: 's1', byId: { s1: { projectionValues: { agentPreset: null } } } }).reason).toBe('preset-unresolved')
    expect(overviewGate({ current: 's1', byId: { s1: { projectionValues: { agentPreset: '' } } } }).reason).toBe('preset-unresolved')
  })

  it('refuses while the preset has not been resolved yet, and with no session at all', () => {
    // The instant the projection has no value for the CURRENT session is the same case.
    expect(overviewGate({ current: 's1', byId: {} }).reason).toBe('preset-unresolved')
    expect(overviewGate({ current: undefined, byId: {} })).toEqual({ allowed: false, sessionId: null, preset: null, reason: 'no-session' })
    expect(overviewGate(null).allowed).toBe(false)
    expect(overviewGate(undefined).allowed).toBe(false)
  })
})

describe('第四步 收尾终态：计数与展示层衔接', () => {
  /** One stale dispatch whose ASSIGNMENT was closed, plus one that stayed lost. */
  const withClosure = (): DevFlowClientSnapshot => ({
    ...snapshot(),
    paused: false,
    tasks: [
      { id: 'task-closed', title: 'Closed work', description: 'd', status: 'cancelled', updatedAt: '2026-08-20T09:00:00.000Z' },
      { id: 'task-lost', title: 'Lost work', description: 'd', status: 'executing', updatedAt: '2026-08-20T09:00:00.000Z' },
    ],
    assignments: [
      { id: 'assignment-closed', taskId: 'task-closed', phaseId: 'phase-a', agentId: 'backend-engineer', role: 'backend-engineer', status: 'closed', closedAt: '2026-09-16T00:30:00.000Z', closeReason: 'stale-lost' },
      { id: 'assignment-lost', taskId: 'task-lost', phaseId: 'phase-a', agentId: 'code-auditor', role: 'reviewer', status: 'assigned' },
    ],
    executions: [],
    results: [],
    reports: [],
    decisionRequests: [],
  })

  it('counts 已收尾 separately and keeps it OUT of 未收尾 · 已失联', () => {
    const model = createWorkspaceModel(withClosure())
    const view = buildOverview(model, NOW, null)
    const flow = createFlowModel(model, NOW, {}, 'history')
    const states = flow.history.edges.map(edge => edge.state).sort()
    // The closed dispatch is `closed`; the untouched stale one is still `lost`.
    expect(states).toContain('closed')
    expect(states).toContain('lost')
    expect(view.counts.closed).toBe(1)
    expect(view.counts.lost).toBe(1)
    // The pipeline is untouched: 进行中 0 with nothing executing, and no edge claims it.
    expect(view.counts.active).toBe(0)
    expect(states).not.toContain('executing')
  })

  it('says why a dispatch was closed, in fixed Chinese, on the edge label', () => {
    const model = createWorkspaceModel(withClosure())
    const flow = createFlowModel(model, NOW, {}, 'history')
    const closed = flow.history.edges.find(edge => edge.state === 'closed')
    expect(closed?.badge).toContain('已收尾')
    expect(closed?.handoff.statusLabel).toContain('已收尾')
    expect(closed?.handoff.statusLabel).toContain('陈旧在飞')
  })

  it('adds the 已收尾 row to the float without disturbing the other rows', () => {
    const model = createWorkspaceModel(withClosure())
    const view = buildOverview(model, NOW, null)
    expect(Object.keys(view.counts)).toEqual(
      ['active', 'review', 'done', 'lost', 'paused', 'closed', 'unrouted', 'hidden'],
    )
    // 已收尾 alone is NOT "happening": a project whose only leftover records were wrapped
    // up reports the resting posture, and the closed count is reported in the card's row.
    const closedOnly = createWorkspaceModel({
      ...withClosure(),
      tasks: [{ id: 'task-closed', title: 'Closed work', description: 'd', status: 'cancelled', updatedAt: '2026-08-20T09:00:00.000Z' }],
      assignments: [{ id: 'assignment-closed', taskId: 'task-closed', phaseId: 'phase-a', agentId: 'backend-engineer', role: 'backend-engineer', status: 'closed', closedAt: '2026-09-16T00:30:00.000Z', closeReason: 'stale-lost' }],
    })
    const onlyView = buildOverview(closedOnly, NOW, null)
    expect(onlyView.counts.closed).toBe(1)
    expect(onlyView.counts.lost).toBe(0)
    expect(onlyView.posture).toBe('done')
    // ...while a genuinely stale, UNCLOSED record still keeps the project "active".
    expect(view.posture).toBe('active')
  })

  it('keeps a closed record static: no motion layer, no animation', () => {
    const model = createWorkspaceModel(withClosure())
    const flow = createFlowModel(model, NOW, {}, 'history')
    for (const edge of flow.history.edges.filter(candidate => candidate.state === 'closed')) {
      const motion = motionProfile(edge.state, false)
      expect(motion.flowing).toBe(false)
      expect(motion.speed).toBe(0)
      expect(motionRate(motion)).toBe('still')
      expect(edge.state).not.toBe('lost')
    }
  })

  it('leaves the five-state legend and wording untouched', () => {
    // The five states the canvas lists are unchanged; 已收尾 is a separate presentation.
    expect(DEVFLOW_FLOW_CSS).toContain('.devflow-flow-edge[data-edge-state=closed]')
    expect(DEVFLOW_FLOW_CSS).toContain('.devflow-flow-badge.closed')
    for (const forbidden of ['依赖', '前置', '解锁', 'blockedBy', 'dependsOn']) {
      expect(DEVFLOW_FLOW_CSS.includes(forbidden)).toBe(false)
    }
  })
})

describe('step 3B overview numbers', () => {
  it('counts the dispatch ledger the same way the canvas draws it', () => {
    const model = createWorkspaceModel(snapshot())
    const view = buildOverview(model, NOW, null)
    // task-run is 执行中, task-review is finished with its task still reviewing ⇒ 待验收,
    // task-done is finished and accepted ⇒ 已完成. Nothing is lost or unrouted.
    expect(view.counts.active).toBe(1)
    expect(view.counts.review).toBe(1)
    expect(view.counts.done).toBe(1)
    expect(view.counts.lost).toBe(0)
    expect(view.counts.unrouted).toBe(0)
    expect(view.total).toBe(3)
    expect(view.summary).toBe('进行中 1 · 待验收 1')
    expect(view.posture).toBe('active')
    expect(view.projectName).toBe('DevFlow')
    expect(view.bindingLabel).toBe('已绑定')
    expect(view.dispatchCount).toBe(3)
  })

  it('reports the same edge count the canvas model carries', () => {
    const model = createWorkspaceModel(snapshot())
    const flow = createFlowModel(model, NOW)
    const view = buildOverview(model, NOW, null)
    expect(view.total).toBe(flow.history.edges.length)
    expect(view.counts.hidden).toBe(hiddenDispatchCount(flow))
    expect(hiddenDispatchCount(flow)).toBe(flow.history.edges.length - flow.current.edges.length)
  })

  it('reads a task awaiting acceptance as 待验收, never as 复核返工', () => {
    // The N5 shape, reproduced from the shipped fixture: the dispatch finished
    // (`execution-review` completed) while its task is still `reviewing`, i.e. it is
    // waiting for the USER to accept. `edgeAction` reaches its `taskState === 'reviewing'`
    // branch only when the edge state is `queued`/`paused` — every other state returns
    // earlier — and a finished dispatch is `done`, so the badge carries the delivery
    // wording and 复核返工 is never shown here.
    const model = createWorkspaceModel(snapshot())
    const flow = createFlowModel(model, NOW, {}, 'history')
    const edge = flow.history.edges.find(candidate => candidate.taskId === 'task-review')
    expect(edge?.state).toBe('done')
    expect(edge?.badge).toContain('复核通过')
    expect(edge?.badge).not.toContain('复核返工')
    // The dispatch's own status line agrees: finished, while the task reads Reviewing.
    expect(edge?.handoff.statusLabel).toBe('已完成 · Reviewing')
    expect(model.taskById.get('task-review')?.workState).toBe('reviewing')
  })

  it('lists exactly the four fixed employees, never the commander', () => {
    const model = createWorkspaceModel(snapshot())
    const view = buildOverview(model, NOW, null)
    expect(view.members.map(member => member.id)).toEqual(['backend-engineer', 'code-auditor'])
    expect(view.members.some(member => member.id === 'commander')).toBe(false)
    expect(view.commanderName).toBe('总指挥')
    // The row carries the dispatch the employee currently holds, truncated for the float.
    expect(view.members[0]?.name).toBe('代码工程师')
    expect(view.members[0]?.state).toBe('active')
    expect(view.members[0]?.taskTitle).toBe('Running work')
  })

  it('says 全部完成 only when nothing is in flight and nothing is stuck', () => {
    const quiet = createWorkspaceModel(snapshot({
      tasks: [{ id: 'task-done', title: 'Accepted', description: 'd', status: 'completed', updatedAt: '2026-09-15T09:30:00.000Z' }],
      assignments: [{ id: 'assignment-done', taskId: 'task-done', phaseId: 'phase-a', agentId: 'backend-engineer', role: 'backend-engineer', status: 'completed' }],
      executions: [{ id: 'execution-done', assignmentId: 'assignment-done', taskId: 'task-done', agentId: 'backend-engineer', status: 'completed', startedAt: '2026-09-15T09:00:00.000Z', completedAt: '2026-09-15T09:20:00.000Z' }],
    }))
    const view = buildOverview(quiet, NOW, null)
    expect(view.posture).toBe('done')
    expect(view.postureLabel).toBe('全部完成')
    expect(view.summary).toBe('全部完成')
  })

  it('never invents the words 依赖 / 前置 / 解锁', () => {
    const model = createWorkspaceModel(snapshot())
    const view = buildOverview(model, NOW, null)
    const text = JSON.stringify(view)
    for (const forbidden of ['依赖', '前置', '解锁']) expect(text.includes(forbidden)).toBe(false)
  })
})

describe('live-channel posture wording', () => {
  it('names live, connecting and the polling fallback in Chinese', () => {
    expect(connectionLabel({ phase: 'live', sequence: 3, revision: 1, detail: null, attempts: 0 })).toBe('实时通道')
    expect(connectionLabel({ phase: 'connecting', sequence: null, revision: null, detail: null, attempts: 0 })).toBe('连接中')
    expect(connectionLabel({ phase: 'polling', sequence: null, revision: null, detail: null, attempts: 2 })).toBe('轮询兜底')
    expect(connectionLabel(null)).toBe('轮询兜底')
  })

  it('surfaces the fixed fallback reason only while polling', () => {
    expect(connectionDetail({ phase: 'live', sequence: 1, revision: 1, detail: null, attempts: 0 })).toBeNull()
    expect(connectionDetail(null)).toBeNull()
    expect(connectionDetail({ phase: 'polling', sequence: null, revision: null, detail: null, attempts: 1 }))
      .toBe('实时连接已断开，正在使用轮询')
    expect(connectionDetail({ phase: 'polling', sequence: null, revision: null, detail: 'x', attempts: 1 })).toBe('x')
  })

  it('keeps the float free of 依赖 / 前置 / 解锁', () => {
    for (const forbidden of ['依赖', '前置', '解锁']) expect(DEVFLOW_FLOW_CSS.includes(forbidden)).toBe(false)
    expect(DEVFLOW_FLOW_CSS).toContain('.devflow-ov{')
  })

  it('opens no second subscription: the float reads the panel controller and live channel', () => {
    // §五 forbids a second channel. The float subscribes to the SAME controller and
    // live instances the panel uses, and never calls the Remote's `follow` itself.
    expect(OVERVIEW_SOURCE).toContain('useSyncExternalStore')
    expect(OVERVIEW_SOURCE).toContain('controllerFor(sessionId)')
    expect(OVERVIEW_SOURCE).toContain('liveFor(sessionId)')
    expect(OVERVIEW_SOURCE).not.toContain('follow(')
    expect(OVERVIEW_SOURCE).not.toContain('setInterval')
    expect(OVERVIEW_SOURCE).not.toContain('DEVFLOW_REMOTE')
  })
})

describe('§11.2 the float carries no animation matrix', () => {
  it('animates at most the one weak status dot, and stops it under reduced motion', () => {
    const overview = DEVFLOW_FLOW_CSS.slice(DEVFLOW_FLOW_CSS.indexOf('.devflow-ov{'))
    const animations = [...overview.matchAll(/animation:([\w-]+)/g)].map(match => match[1]).filter(name => name !== 'none')
    expect(animations).toEqual(['devflow-ov-pulse'])
    expect(overview).toContain('@keyframes devflow-ov-pulse')
    expect(overview).toContain('.devflow-ov[data-posture=active][data-paused=false] .devflow-ov-pill .devflow-ov-dot{animation:devflow-ov-pulse')
    // The float must never reach for the canvas' travelling dash or the sweep.
    expect(overview).not.toContain('devflow-flow-run')
    expect(overview).not.toContain('devflow-flow-done')
    expect(overview).toContain('@media (prefers-reduced-motion:reduce){\n  .devflow-ov *{animation:none!important}')
  })
})

describe('§一·前.2 pause presentation', () => {
  it('rewrites only the in-flight states, and restores them exactly when lifted', () => {
    const model = createWorkspaceModel(snapshot({ paused: true }))
    const base = createFlowModel(model, NOW)
    const paused = applyPausePresentation(base, true)
    for (let index = 0; index < base.edges.length; index++) {
      const before = base.edges[index]!
      const after = paused.edges[index]!
      if (before.state === 'executing' || before.state === 'rework' || before.state === 'queued') {
        expect(after.state).toBe('paused')
        expect(after.badge.startsWith(PAUSED_LABEL)).toBe(true)
        expect(after.handoff.statusLabel).toBe(`${PAUSED_LABEL}（共享派发已暂停）`)
      } else {
        expect(after).toEqual(before)
      }
    }
    // The node presentation follows the same rule: a card that claimed work says 已暂停.
    expect(paused.nodes.find(node => node.id === 'backend-engineer')?.state).toBe('paused')
    expect(paused.nodes.find(node => node.id === 'backend-engineer')?.stateLabel).toBe(PAUSED_LABEL)
    // Lifting the pause returns the very same model, with nothing rewritten.
    expect(applyPausePresentation(base, false)).toBe(base)
  })

  it('never touches a finished or lost dispatch', () => {
    const model = createWorkspaceModel(snapshot({ paused: true }))
    const base = createFlowModel(model, NOW)
    const paused = applyPausePresentation(base, true)
    const done = base.edges.filter(edge => edge.state === 'done')
    expect(done.length).toBeGreaterThan(0)
    for (const edge of done) {
      expect(paused.edges.find(candidate => candidate.id === edge.id)).toEqual(edge)
    }
  })
})

describe('§11.1 glass × motion budget', () => {
  it('degrades while motion runs and restores on the next sample after it stops', () => {
    const budget = new MotionBudget()
    expect(budget.sample({ animating: false, meanFrameMs: 16 })).toEqual({ budget: 'auto', motion: 'idle', slow: false })
    expect(budget.sample({ animating: true, meanFrameMs: 16 })).toEqual({ budget: 'degrade', motion: 'active', slow: false })
    expect(budget.sample({ animating: false, meanFrameMs: 16 })).toEqual({ budget: 'auto', motion: 'idle', slow: false })
  })

  it('holds degradation after a run of long frames, and releases only after a run of fast ones', () => {
    const budget = new MotionBudget()
    for (let index = 0; index < LONG_FRAME_STREAK - 1; index++) {
      expect(budget.sample({ animating: false, meanFrameMs: LONG_FRAME_MS + 20 }).budget).toBe('auto')
    }
    const slow = budget.sample({ animating: false, meanFrameMs: LONG_FRAME_MS + 20 })
    expect(slow).toEqual({ budget: 'degrade', motion: 'degraded', slow: true })
    // One, two, three fast samples: the release needs the FULL streak, so the posture
    // is still degraded until the streak is complete.
    for (let index = 1; index < LONG_FRAME_STREAK; index++) {
      expect(budget.sample({ animating: false, meanFrameMs: RECOVER_MS - 1 }).budget).toBe('degrade')
    }
    expect(budget.sample({ animating: false, meanFrameMs: RECOVER_MS - 1 }).budget).toBe('auto')
    // ...and one slow sample again resets the healthy streak.
    expect(budget.sample({ animating: false, meanFrameMs: LONG_FRAME_MS + 20 }).budget).toBe('auto')
  })

  it('averages only real samples, and reads the manual override', () => {
    expect(meanFrameMs([])).toBeNull()
    expect(meanFrameMs([10, 20, 30])).toBe(20)
    expect(readGlassOverride('')).toBe('auto')
    expect(readGlassOverride('?devflow-glass=solid')).toBe('degrade')
    expect(readGlassOverride('?devflow-glass=glass')).toBe('glass')
    expect(readGlassOverride('?devflow-glass=banana')).toBe('auto')
    expect(MOTION_QUIET_MS).toBeGreaterThan(0)
  })

  it('switches the glass layers to the solid path only under the degrade posture', () => {
    expect(DEVFLOW_FLOW_CSS).toContain('.devflow-flow[data-glass-budget=degrade] .devflow-flow-viewport{background:var(--flow-surface-solid);-webkit-backdrop-filter:none;backdrop-filter:none}')
    expect(DEVFLOW_FLOW_CSS).toContain('.devflow-flow[data-glass-budget=degrade] .devflow-flow-card{background:var(--flow-surface-solid);background-image:none;-webkit-backdrop-filter:none;backdrop-filter:none}')
    // No animation is ever switched off to buy performance.
    expect(DEVFLOW_FLOW_CSS).not.toContain('[data-glass-budget=degrade] .devflow-flow-flow{animation:none')
  })
})

describe('step 3B float storage keys', () => {
  it('uses named keys so folding/closed survive a refresh', () => {
    expect(OVERVIEW_EXPANDED_KEY).toBe('devflow.overview.expanded')
    expect(OVERVIEW_CLOSED_KEY).toBe('devflow.overview.closed')
  })
})
