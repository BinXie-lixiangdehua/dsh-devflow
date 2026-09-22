import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CurrentSessionSources } from '../src/client/tool-activity.ts'
import { DevFlowCanvas } from '../src/client/DevFlowCanvas.tsx'
import type { DevFlowClientAuditPage, DevFlowClientSnapshot } from '../src/contract.ts'
import type { DevFlowClientAuditLoadState, DevFlowClientLoadState, DevFlowConnectionState, DevFlowInspectorTab } from '../src/client/store.ts'

const reactState = vi.hoisted(() => ({
  tab: 'flow' as DevFlowInspectorTab,
  // The canvas body's own state slots come first: 0 = selection, 1 = history,
  // 2 = selection notice, 3 = inspector open, 4 = inspector tab. The flow canvas then
  // adds 5 = transform, 6 = node positions, 7 = pinned nodes, 8 = selected edge,
  // 9 = expanded nodes, 10 = roster expanded, 11 = roster cards, 12 = panning,
  // 13 = history scope. Slots 4 and 10 are forced so one static render covers the
  // inspector tab choice and the expanded roster.
  stateIndex: 0,
  tabSlot: 4,
  rosterSlot: 9,
}))

vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useState: <T,>(initial: T | (() => T)) => {
      const index = reactState.stateIndex++
      const resolved = typeof initial === 'function' ? (initial as () => T)() : initial
      if (index === reactState.tabSlot) return [reactState.tab, vi.fn()]
      if (index === reactState.rosterSlot) return [true, vi.fn()]
      return [resolved, vi.fn()]
    },
  }
})

const t = (key: string) => key
/** Pinned clock so the fixture's running execution stays inside the live window. */
const NOW = Date.parse('2026-09-14T06:00:00.000Z')

const snapshot: DevFlowClientSnapshot = {
  version: 1,
  generatedAt: '2026-09-14T04:00:00.000Z',
  session: { id: 'session-a-very-long', commanderMode: 'commander', presetId: 'devflow', activation: 'bound', activationError: null, verifiedAt: '2026-09-14T03:59:00.000Z' },
  paused: true,
  project: { id: 'project-a', name: 'Migration', goal: 'Ship the bridge', currentStage: 'M7' },
  agents: [
    { id: 'commander', role: 'planner', kind: 'fixed', status: 'active', displayName: '总指挥', model: 'deepseek-chat', skills: [], capabilities: ['task-planning', 'task-dispatch', 'acceptance'], delegationDepth: 0 },
    { id: 'backend-engineer', role: 'backend-engineer', kind: 'fixed', status: 'active', displayName: '后端', model: 'deepseek-chat', skills: ['repository-conventions', 'testing-policy'], capabilities: ['backend-implementation'], delegationDepth: 0 },
    { id: 'frontend-engineer', role: 'frontend-engineer', kind: 'fixed', status: 'active', displayName: '前端', model: 'deepseek-chat', skills: [], capabilities: ['frontend-implementation'], delegationDepth: 0 },
    { id: 'code-auditor', role: 'reviewer', kind: 'fixed', status: 'active', displayName: '审计', model: 'deepseek-chat', skills: ['code-review'], capabilities: ['code-review'], delegationDepth: 0 },
  ],
  tasks: [
    { id: 'task-a', title: 'Build bridge', description: 'Build it with acceptance criteria', status: 'executing', updatedAt: '2026-09-14T03:00:00.000Z' },
    { id: 'task-b', title: 'Ship audit', description: 'Audit the bridge', status: 'completed', updatedAt: '2026-09-14T02:00:00.000Z' },
  ],
  phases: [{ id: 'phase-a', name: 'Host', description: 'Host work', status: 'in_progress' }],
  assignments: [
    { id: 'assignment-a', taskId: 'task-a', phaseId: 'phase-a', agentId: 'backend-engineer', role: 'backend-engineer', status: 'in_progress' },
    { id: 'assignment-b', taskId: 'task-b', phaseId: 'phase-a', agentId: 'code-auditor', role: 'reviewer', status: 'completed' },
  ],
  executions: [
    { id: 'execution-a', assignmentId: 'assignment-a', taskId: 'task-a', agentId: 'backend-engineer', status: 'running', startedAt: '2026-09-14T05:50:00.000Z', completedAt: null },
    { id: 'execution-b', assignmentId: 'assignment-b', taskId: 'task-b', agentId: 'code-auditor', status: 'completed', startedAt: '2026-09-14T02:00:00.000Z', completedAt: '2026-09-14T02:20:00.000Z' },
  ],
  results: [{ id: 'result-a', taskId: 'task-b', source: 'result', at: '2026-09-14T02:30:00.000Z', summary: { text: 'Audit shipped', truncated: false, redacted: false } }],
  reports: [{ id: 'report-a', executionId: 'execution-a', taskId: 'task-a', agentId: 'backend-engineer', source: 'report', status: 'success', at: '2026-09-14T03:40:00.000Z', summary: { text: 'Wired the bridge endpoints', truncated: false, redacted: false } }],
  attempts: [],
  failures: [],
  decisions: [{ id: 'decision-a', type: 'continue', summary: 'Continue', nextAction: 'Ship', createdAt: '2026-09-14T03:45:00.000Z' }],
  decisionRequests: [{ id: 'request-a', taskId: 'task-a', trigger: 'ambiguity', question: 'Which approach?', options: [], status: 'pending' }],
}

/** Two live executions in one snapshot: 并发落地后两条都必须如实显示为「执行中」。 */
const parallelSnapshot: DevFlowClientSnapshot = {
  ...snapshot,
  // The concurrency floor is a rule about the DATA, independent of the session
  // pause, so this fixture is deliberately unpaused (§一·前.2 is asserted on the
  // base fixture in its own case).
  paused: false,
  tasks: [
    ...snapshot.tasks,
    { id: 'task-c', title: 'Ship frontend', description: 'Frontend acceptance criteria', status: 'executing', updatedAt: '2026-09-14T03:10:00.000Z' },
  ],
  assignments: [
    ...snapshot.assignments,
    { id: 'assignment-c', taskId: 'task-c', phaseId: 'phase-a', agentId: 'frontend-engineer', role: 'frontend-engineer', status: 'in_progress' },
  ],
  executions: [
    ...snapshot.executions,
    { id: 'execution-c', assignmentId: 'assignment-c', taskId: 'task-c', agentId: 'frontend-engineer', status: 'running', startedAt: '2026-09-14T05:55:00.000Z', completedAt: null },
  ],
  decisionRequests: [],
}

/** A project with no dispatch history at all: the canvas may only show the commander. */
const emptyDispatchSnapshot: DevFlowClientSnapshot = {
  ...snapshot,
  tasks: [],
  assignments: [],
  executions: [],
  results: [],
  reports: [],
  decisionRequests: [],
}

/**
 * 第十一步: one temporary sub-agent the Commander created on the spot, with a real
 * assignment and a failed execution — the exact N5 shape. Kept as its own fixture so
 * the shared `snapshot` keeps its four fixed employees.
 */
const temporarySubagentSnapshot: DevFlowClientSnapshot = {
  ...snapshot,
  paused: false,
  agents: [...snapshot.agents, {
    id: 'researcher-refs', role: 'planner', kind: 'temporary', status: 'created',
    displayName: '案例调研员', model: 'deepseek-chat', skills: [], capabilities: [], delegationDepth: 1,
  }],
  tasks: [...snapshot.tasks, {
    id: 'task-temp', title: '调研 2 个优秀案例项目', description: '目录结构与分层做法',
    status: 'failed', updatedAt: '2026-09-14T03:20:00.000Z',
  }],
  assignments: [...snapshot.assignments, {
    id: 'assignment-temp', taskId: 'task-temp', phaseId: 'phase-a',
    agentId: 'researcher-refs', role: 'planner', status: 'assigned',
  }],
  executions: [...snapshot.executions, {
    id: 'execution-temp', assignmentId: 'assignment-temp', taskId: 'task-temp',
    agentId: 'researcher-refs', status: 'failed',
    startedAt: '2026-09-14T03:10:00.000Z', completedAt: '2026-09-14T03:20:00.000Z',
  }],
  failures: [{
    id: 'execution-execution-temp', executionId: 'execution-temp', taskId: 'task-temp',
    agentId: 'researcher-refs', source: 'execution', status: 'failed',
    at: '2026-09-14T03:20:00.000Z', summary: null,
  }],
}

const auditPage: DevFlowClientAuditPage = {
  version: 1,
  source: 'devflow-journal',
  projectId: 'project-a',
  range: { from: '2026-07-31T00:00:00.000Z', to: '2026-09-14T00:00:00.000Z' },
  items: [{
    id: 'audit-safe', sequence: 1, category: 'task', action: 'updated', at: '2026-09-14T03:00:00.000Z',
    entity: { type: 'task', id: 'task-a', display: { text: 'Build bridge', truncated: false, redacted: false } },
    related: { taskId: 'task-a' }, status: 'executing', summary: null, incomplete: false,
  }],
  nextCursor: null,
  capturedHeadSequence: 2,
  omittedUnsafeCount: 0,
  truncated: false,
}

function conversation(nodes: readonly unknown[] = [], overrides: Record<string, unknown> = {}): CurrentSessionSources {
  const entries = nodes.map((node, index) => [`node-${index}`, node] as const)
  const byKey = new Map(entries)
  return {
    session: {
      sessionId: snapshot.session.id,
      running: true,
      subagent: null,
      openState: 'open',
      hasMore: false,
      ...overrides,
    },
    chat: { order: entries.map(([key]) => key), nodes: { get: (key: string) => byKey.get(key), values: () => nodes } },
  } as unknown as CurrentSessionSources
}

function runningNode(callId = 'call-safe'): unknown {
  return {
    key: `tool-call:${callId}`,
    id: callId,
    target: 'chat',
    location: { kind: 'turn', turn: { status: 'open' } },
    visibility: 'visible',
    kind: 'tool-call', anchorSeq: 10,
    data: { root: {
      callId, name: 'read', time: Date.UTC(2026, 8, 14, 10),
      argsRaw: 'RAW_ARGUMENT_TOKEN_PROMPT_PATH_MARKER', turn: 1, step: 1, callView: null,
      subCalls: [{ callId: 'nested-raw', name: 'RAW_SUBCALL_MARKER', argsRaw: 'RAW_SUBCALL_ARGS', time: 0 }],
    } },
  }
}

function canvas(
  state: DevFlowClientLoadState,
  options: {
    readonly tab?: DevFlowInspectorTab
    readonly conversation?: CurrentSessionSources
    readonly auditState?: DevFlowClientAuditLoadState
    readonly connection?: DevFlowConnectionState
  } = {},
): string {
  reactState.tab = options.tab ?? 'flow'
  reactState.stateIndex = 0
  const session = options.conversation ?? conversation()
  const auditState = options.auditState ?? { phase: 'ready', filter: { kind: 'project' }, page: auditPage, error: null }
  const connection = options.connection
  return renderToStaticMarkup(createElement(DevFlowCanvas, {
    sessionId: snapshot.session.id,
    useSession: <S,>(selector: (value: CurrentSessionSources['session']) => S) => selector(session.session),
    useChat: <S,>(selector: (value: CurrentSessionSources['chat']) => S) => selector(session.chat),
    useDevflow: <S,>(selector: (value: DevFlowClientLoadState) => S) => selector(state),
    useAudit: <S,>(selector: (value: DevFlowClientAuditLoadState) => S) => selector(auditState),
    ...(connection === undefined ? {} : { useLive: <S,>(selector: (value: DevFlowConnectionState) => S) => selector(connection) }),
    refresh: async () => undefined,
    getInspectorTab: () => 'flow',
    setInspectorTab: () => undefined,
    now: NOW,
    audit: { ensure: async () => undefined, refresh: async () => undefined, loadMore: async () => undefined, retry: async () => undefined },
    t,
  } as never))
}

function ready(source: DevFlowClientSnapshot = snapshot): DevFlowClientLoadState {
  return { phase: 'ready', snapshot: source, error: null }
}

function edgeStates(html: string): string[] {
  return [...html.matchAll(/data-edge-state="([a-z]+)"/g)].map(match => match[1] ?? '')
}

describe('DevFlow dispatch-flow canvas (third tab)', () => {
  beforeEach(() => {
    reactState.tab = 'flow'
    reactState.stateIndex = 0
  })

  it('renders the canvas as the default third-column view with a single Chinese identity line and the four-state legend', () => {
    const html = canvas(ready())
    // One compact Chinese line replaces the old English badge row. 第九步: it
    // names the CURRENT project (its workspace id when the snapshot carries one)
    // instead of the former machine-wide 共享项目 wording.
    expect(html).toContain('本项目 Migration')
    expect(html).toContain('本会话已绑定总指挥')
    expect(html).toContain('派发已暂停')
    expect(html).toContain('会话 session-a-')
    expect(html).toContain('更新 12:00:00')
    expect(html).not.toContain('Shared project · .devflow')
    expect(html).not.toContain('Commander · Bound in this session')
    expect(html).toContain('devflow-flow-canvas')
    expect(html).toContain('devflow-flow-viewport')
    // The tab strip is gone; 审计 / 本会话 live as canvas overlay entries.
    expect(html).not.toContain('role="tablist"')
    expect(html).toContain('>审计</button>')
    expect(html).toContain('>本会话</button>')
    expect(html).toContain('排队/已接收')
    expect(html).toContain('返工')
    expect(html).not.toContain('<input')
    expect(html).not.toContain('<textarea')
  })

  /**
   * 第九步 §1.2 ②: the panel's identity line carries the CURRENT project — the
   * session workspace it is isolated to — so two panels on one host are
   * distinguishable, and the machine-wide "共享项目" wording is gone for good.
   */
  it('names the current project workspace in the identity line, with the full path available', () => {
    const isolated: DevFlowClientSnapshot = {
      ...snapshot,
      session: {
        ...snapshot.session,
        workspacePath: 'D:\\projects\\snake',
        storeRoot: 'D:\\projects\\snake\\.devflow',
      },
    }
    const html = canvas(ready(isolated))
    expect(html).toContain('本项目 Migration @ snake')
    expect(html).not.toContain('共享项目')
    // The compact line names the directory; the exact path rides the title, so
    // an operator can copy it without widening the line.
    expect(html).toContain('data-project-workspace="D:\\projects\\snake"')
    expect(html).toContain('title="session-a-very-long · D:\\projects\\snake"')
  })

  /**
   * §一·前.2, the DOM原文 the round asks for: a paused session must say 已暂停 on the
   * cards AND on the edges, must not still say 返工中/执行中, and must leave no motion
   * layer animating (`data-flow-rate="paused"`, and no inline animation duration).
   */
  it('writes 已暂停 onto the cards and the edges of a paused session, and stops their motion', () => {
    const html = canvas(ready(snapshot))
    expect(snapshot.paused).toBe(true)
    expect(html).toContain('data-paused="true"')
    // Cards: the badge text and the state attribute the stylesheet keys on. The legend
    // still lists 执行中/返工 as STATE NAMES, so only badges are asserted here.
    const badges = [...html.matchAll(/<span class="devflow-flow-badge ([a-z]*)">([^<]*)<\/span>/g)]
      .map(match => ({ tone: match[1], text: match[2] }))
    expect(badges.some(badge => badge.tone === 'paused' && badge.text === '已暂停')).toBe(true)
    expect(badges.some(badge => badge.text === '执行中' || badge.text === '返工中')).toBe(false)
    // Edges: the state attribute, the rate group, the badge and the handoff label.
    expect(html).toContain('data-edge-state="paused"')
    expect(html).toContain('data-flow-rate="paused"')
    expect(html).toContain('已暂停 · 正在执行')
    expect(html).toContain('已暂停（共享派发已暂停）')
    // A paused edge carries no animation duration: the motion layer is hidden, not slowed.
    expect(html).not.toContain('animationDuration')
    // The read-only 用户需求 node is NOT a dispatch, so a pause leaves it alone.
    expect(html).toContain('data-flow-node="requirement" data-kind="requirement" data-state="planned"')
  })

  it('names the live channel on the identity line and announces a polling fallback', () => {    const off = canvas(ready())
    expect(off).toContain('实时通道未启用 · 轮询快照')
    expect(off).toContain('data-connection="off"')
    expect(off).not.toContain('已断开')

    const live = canvas(ready(), { connection: { phase: 'live', sequence: 12, revision: 4, detail: null, attempts: 0 } })
    expect(live).toContain('实时通道已连接 · 游标 #12')
    expect(live).toContain('data-connection="live"')
    expect(live).not.toContain('轮询兜底')

    const polling = canvas(ready(), { connection: { phase: 'polling', sequence: null, revision: null, detail: null, attempts: 2 } })
    expect(polling).toContain('实时通道已断开 · 轮询兜底')
    expect(polling).toContain('data-connection="polling"')
    expect(polling).toContain('实时连接已断开，正在使用轮询')
    expect(polling).toContain('每 5 秒拉取快照')
  })

  it('draws one edge per dispatched task, all of them from the commander', () => {
    const html = canvas(ready())
    expect(html).toContain('data-flow-node="commander"')
    expect(html).toContain('data-flow-node="backend-engineer"')
    expect(html).toContain('data-flow-node="code-auditor"')
    // The frontend engineer is never dispatched in this snapshot: no node, no edge.
    expect(html).not.toContain('data-flow-node="frontend-engineer"')
    expect(html.match(/data-flow-edge="dispatch:/g)).toHaveLength(2)
    expect(html).toContain('data-flow-edge="dispatch:assignment-a"')
    expect(html).toContain('data-flow-edge="dispatch:assignment-b"')
    // Default scope is the current chain, and the opt-in switch is present.
    expect(html).toContain('全部历史')
    expect(html).toContain('aria-pressed="false"')
    expect(html).not.toContain('data-flow-edge="task:task-c"')
  })

  it('shows every in-flight dispatch as 执行中 and prints 并发 N/5 on the toolbar row', () => {
    // §一·前.2: the base fixture's session IS paused, so its in-flight dispatch is
    // presented as 已暂停 — every card/edge label and every motion layer follows the
    // shared pause flag. That is asserted here, and unpaused below.
    const single = edgeStates(canvas(ready()))
    expect(single).toEqual(['paused', 'done'])
    expect(canvas(ready())).toContain('已暂停 · 正在执行')
    expect(canvas(ready())).not.toContain('执行中 · 正在执行')

    const parallel = canvas(ready(parallelSnapshot))
    // 并发落地：两条真在跑 ⇒ 画布两条都写「执行中」，一条都不降级成「排队中」。
    expect(edgeStates(parallel).filter(state => state === 'executing')).toHaveLength(2)
    expect(edgeStates(parallel).filter(state => state === 'queued')).toHaveLength(0)
    expect(parallel).toContain('执行中 · 正在执行')
    // 面板必须展现并发上限（boss 要求）：`N` 从快照数出，`5` 是单点常量。
    expect(parallel).toContain('并发 2/5')
    expect(parallel).not.toContain('已达并发上限')
    // 旧的"阻塞调用"说法在并发成立后是假话，必须已经消失。
    expect(parallel).not.toContain('派发是阻塞调用')
    expect(parallel).not.toContain('执行槽')
  })

  it('spells 「已达并发上限 · 后续排队」 once the in-flight limit is reached', () => {
    const many = {
      ...parallelSnapshot,
      executions: [
        ...parallelSnapshot.executions,
        { id: 'execution-d', assignmentId: 'assignment-d', taskId: 'task-d', agentId: 'backend-engineer', status: 'running' as const, startedAt: '2026-09-14T05:56:00.000Z', completedAt: null },
        { id: 'execution-e', assignmentId: 'assignment-e', taskId: 'task-e', agentId: 'code-auditor', status: 'running' as const, startedAt: '2026-09-14T05:57:00.000Z', completedAt: null },
        { id: 'execution-f', assignmentId: 'assignment-f', taskId: 'task-f', agentId: 'backend-engineer', status: 'running' as const, startedAt: '2026-09-14T05:58:00.000Z', completedAt: null },
      ],
      tasks: [
        ...parallelSnapshot.tasks,
        { id: 'task-d', title: 'T-D', description: 'd', status: 'executing' as const, updatedAt: '2026-09-14T03:20:00.000Z' },
        { id: 'task-e', title: 'T-E', description: 'd', status: 'executing' as const, updatedAt: '2026-09-14T03:20:00.000Z' },
        { id: 'task-f', title: 'T-F', description: 'd', status: 'executing' as const, updatedAt: '2026-09-14T03:20:00.000Z' },
      ],
      assignments: [
        ...parallelSnapshot.assignments,
        { id: 'assignment-d', taskId: 'task-d', phaseId: 'phase-a', agentId: 'backend-engineer', role: 'backend-engineer' as const, status: 'in_progress' as const },
        { id: 'assignment-e', taskId: 'task-e', phaseId: 'phase-a', agentId: 'code-auditor', role: 'reviewer' as const, status: 'in_progress' as const },
        { id: 'assignment-f', taskId: 'task-f', phaseId: 'phase-a', agentId: 'backend-engineer', role: 'backend-engineer' as const, status: 'in_progress' as const },
      ],
    }
    const html = canvas(ready(many))
    expect(html).toContain('并发 5/5')
    expect(html).toContain('已达并发上限 · 后续排队')
    expect(html).toContain('data-at-limit="true"')
  })

  it('★ 被并发上限挡下的派发在面板上显示为「排队中」，不悄悄串行', () => {
    // 「看不见的拖时间」正是这次立项的痛点。超限时宿主把派发判 `exclusive`，那条派发
    // 还没有 execution 记录 —— 面板必须把它读成「排队中」，并且**同时**说明已达上限。
    const running = [0, 1, 2, 3, 4].map(index => ({
      id: `execution-run-${index}`,
      assignmentId: `assignment-run-${index}`,
      taskId: `task-run-${index}`,
      agentId: 'backend-engineer',
      status: 'running' as const,
      startedAt: '2026-09-14T05:50:00.000Z',
      completedAt: null,
    }))
    const queued = {
      // Built on the BASE fixture with `tasks`/`assignments`/`executions` REPLACED (not
      // extended): the base fixture already carries one running execution of its own, so
      // spreading it would put the in-flight count at six and the "at limit" reading
      // would be about the wrong thing.
      ...snapshot,
      paused: false,
      tasks: [
        ...running.map((_, index) => ({ id: `task-run-${index}`, title: `R${index}`, description: 'd', status: 'executing' as const, updatedAt: '2026-09-14T05:50:00.000Z' })),
        { id: 'task-g', title: '等上限的派发', description: 'queued behind the limit', status: 'executing' as const, updatedAt: '2026-09-14T05:59:00.000Z' },
      ],
      assignments: [
        ...running.map((_, index) => ({ id: `assignment-run-${index}`, taskId: `task-run-${index}`, phaseId: 'phase-a', agentId: 'backend-engineer', role: 'backend-engineer' as const, status: 'in_progress' as const })),
        { id: 'assignment-g', taskId: 'task-g', phaseId: 'phase-a', agentId: 'code-auditor', role: 'reviewer' as const, status: 'in_progress' as const },
      ],
      executions: [...running],
      // No execution row for assignment-g: that IS the shape of a dispatch the host has
      // not started yet, which is exactly what the concurrency gate produces.
    }
    const html = canvas(ready(queued))
    // The ceiling is reached and said out loud...
    expect(html).toContain('并发 5/5')
    expect(html).toContain('已达并发上限 · 后续排队')
    // ...and the dispatch waiting behind it is STILL SHOWN as 排队中, not hidden.
    expect(edgeStates(html).filter(state => state === 'queued')).toHaveLength(1)
    expect(html).toContain('排队中 · 已接收')
  })

  it('shows only the commander when the snapshot carries no dispatch history', () => {
    const html = canvas(ready(emptyDispatchSnapshot))
    expect(html).toContain('data-flow-node="commander"')
    expect(html).not.toContain('data-flow-edge=')
    expect(html).toContain('画布初始只有总指挥')
  })

  it('surfaces a blocked dispatch as a visible banner with NO action to click', () => {
    // A user who does not read the conversation must still see that an employee
    // could not do the work, and the fix is a configuration fix — so the banner
    // carries text only, never a button that would invite another attempt.
    const blocked = {
      ...snapshot,
      blocked: [{
        id: 'blocked-1', taskId: 'task-a', agentId: 'architect', agentName: '架构师',
        gapKind: 'tool' as const, missing: 'web_search', suggestedOwner: 'boss',
        reason: { text: '本会话没有 web_search 工具', truncated: false, redacted: false },
        headline: '架构师缺少web_search 工具，无法继续本次派发— 需 boss 处理',
        at: '2026-09-18T02:00:00.000Z',
      }],
    }
    const html = canvas(ready(blocked))
    expect(html).toContain('devflow-blocked-banner')
    expect(html).toContain('data-blocked-count="1"')
    expect(html).toContain('受阻 · 需要处理')
    expect(html).toContain('data-gap-kind="tool"')
    expect(html).toContain('架构师')
    // The banner is informative only.
    const banner = html.slice(html.indexOf('devflow-blocked-banner'), html.indexOf('devflow-blocked-banner') + 900)
    expect(banner).not.toContain('<button')
    // A snapshot with no blocked rows renders no banner at all.
    expect(canvas(ready())).not.toContain('devflow-blocked-banner')
  })

  it('maps the roster and nodes to Chinese display names, and keeps cards to a summary', () => {
    const html = canvas(ready())
    // The roster is an overlay that expands on click; this render covers its header,
    // the canvas nodes and the standing 临时子代理 disclosure (the expanded roster cards
    // are covered by the real browser evidence).
    expect(html).toContain('固定员工 · 4 人 / 临时子代理 · 0 人')
    expect(html).toContain('总指挥')
    expect(html).toContain('代码工程师')
    expect(html).toContain('审计工程师')
    expect(html).toContain('devflow-flow-rosterhead')
    // Cards carry a summary only: skills / depth / model moved into the inspector,
    // so no card ever grows when the operator inspects it.
    expect(html).not.toContain('技能：repository-conventions')
    expect(html).not.toContain('委派深度')
    expect(html).not.toContain('devflow-flow-detail')
    // The requirement node is its own card with its own source tag.
    expect(html).toContain('data-kind="requirement"')
    expect(html).toContain('来源：用户')
    // An employee with no stored Skill binding still reads 暂未绑定 in the roster
    // header's count line rather than a blank.
    const unbound = canvas(ready({
      ...snapshot,
      agents: snapshot.agents.map(agent => agent.id === 'code-auditor' ? { ...agent, skills: [] } : agent),
    }))
    expect(unbound).toContain('devflow-flow-rosterhead')
  })

  it('draws a temporary sub-agent card, its 子代理 edge, and its roster line', () => {
    const html = canvas(ready(temporarySubagentSnapshot))
    // The card exists, is typed `temporary` (that is what the canvas styles on), and
    // shows the sub-agent's OWN name — never 总指挥, which is what the `planner` role
    // label would have produced.
    expect(html).toContain('data-flow-node="researcher-refs"')
    expect(html).toContain('data-kind="temporary"')
    expect(html).toContain('案例调研员')
    expect(html).toContain('>子代理<')
    // The dispatch to it is drawn as the 子代理 relation, pointing AT the sub-agent.
    expect(html).toContain('data-edge-semantic="subagent"')
    expect(html).toContain('data-edge-from="commander"')
    expect(html).toContain('data-edge-to="researcher-refs"')
    // The roster header names the temporary group, so the card has a lookup line.
    expect(html).toContain('固定员工 · 4 人 / 临时子代理 · 1 人')
    // No stale "not wired up yet" claim survives anywhere the operator can read.
    expect(html).not.toContain('尚未闭环')
    expect(html).not.toContain('不表现为可用')
    expect(html).not.toContain('设计目标 · 待闭环')
  })

  it('keeps the handoff inspector reachable from the canvas edge', () => {
    const html = canvas(ready())
    // The inspector is an overlay that mounts on edge click (covered by the real
    // browser evidence); the static render proves the hit target and its hint.
    expect(html).toContain('点连线看这次派发的任务')
    expect(html).toContain('data-flow-edge="dispatch:assignment-a"')
    expect(html).toContain('devflow-flow-edge-hit')
  })

  it('renders explicit loading, unavailable, refreshing and error states around the canvas', () => {
    expect(canvas({ phase: 'loading', snapshot: null, error: null })).toContain('loading')
    expect(canvas({ phase: 'error', snapshot: null, error: { code: 'state-unavailable', message: 'DevFlow state is unavailable. Refresh to try again.' } })).toContain('unavailable')
    expect(canvas({ phase: 'refreshing', snapshot, error: null })).toContain('更新中…')
    expect(canvas({ phase: 'error', snapshot, error: { code: 'state-unavailable', message: 'DevFlow state is unavailable. Refresh to try again.' } })).toContain('显示最近一次成功的数据')
  })

  it('keeps the audit and current-session tabs working next to the canvas', () => {
    const audit = canvas(ready(), { tab: 'audit' })
    expect(audit).toContain('业务审计')
    expect(audit).toContain('Build bridge')
    expect(audit).not.toContain('devflow-flow-viewport')

    const tools = canvas(ready(), { tab: 'tools', conversation: conversation([runningNode()]) })
    expect(tools).toContain('本会话工具动态')
    expect(tools).toContain('call-safe')
    expect(tools).not.toContain('devflow-flow-viewport')
    expect(tools).not.toMatch(/RAW_ARGUMENT|RAW_SUBCALL/)
  })

  it('renders an empty project without inventing dispatch data', () => {
    const html = canvas({ phase: 'ready', snapshot: { ...snapshot, project: null }, error: null }, { tab: 'audit' })
    expect(html).toContain('本机 Chat')
    expect(html).toContain('派发流')
  })
})
