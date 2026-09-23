/**
 * Pure dispatch-flow projection for the right column's third tab.
 *
 * The canvas is a read-only view of the SAME snapshot the previous detail view
 * rendered. Nothing here talks to the Host, invents a state, or subscribes to a
 * new stream: `assignment`, `execution`, `attempt`, `report`, `result`, `phase`
 * and `task` records are folded into nodes, association bands and edges.
 *
 * Layout contract (this round):
 *   * rank 0 — the 用户需求 node, the read-only origin of the work;
 *   * rank 1 — 总指挥, the only dispatcher;
 *   * the corridor between them carries one LANE per dispatch, grouped into the
 *     阶段关联带 of the phase that dispatch is associated with;
 *   * rank 2 — the employees, always in ONE row, so no edge can ever be routed
 *     through a card and the lane order can be chosen to keep crossings low.
 *
 * Authority for the semantics is `docs\设计\DevFlow-第三栏派发流面板-设计草案-v2.md`
 * §11: every edge has the commander as one of its two ends; one edge is one
 * dispatch of one task; fixed employees have `delegationDepth = 0` and can never
 * dispatch. §11's earlier "at most ONE edge may be executing" clause was
 * SUPERSEDED by the boss decision of 2026-09-21 (并发上限 5 · 超限排队，见
 * `docs\overview.md` §三-3): dispatches may genuinely overlap, so this module
 * reports every live execution as 执行中 instead of demoting all but one.
 *
 * Naming discipline (this round): relations are called 关联 — 阶段关联 /
 * 派发关联 / 执行关联. The canvas, its legends and this module contain no wording
 * that would claim one task must wait for another.
 */

import { DEVFLOW_CONCURRENCY_LIMIT } from '../contract.ts'
import type {
  DevFlowClientAgent,
  DevFlowClientAssignment,
  DevFlowClientCloseReason,
  DevFlowClientExecution,
  DevFlowClientPhase,
  DevFlowClientTask,
} from '../contract.ts'
import {
  shortId,
  taskWorkStateLabel,
  type TaskWorkState,
  type WorkspaceAgent,
  type WorkspaceFlowTask,
  type WorkspaceModel,
} from './workspace.ts'

/**
 * Visual state of canvas nodes.
 *
 * `lost` is the honest fifth state: a dispatch that claims to be in flight but has
 * no running execution behind it any more. See {@link edgeState} for the rules.
 *
 * `pending` is the node-side twin of the edge state `queued`: the employee holds a
 * dispatch that was accepted but has not started. Without it the node fell through to
 * the `workState === 'working'` fallback and read 执行中 while its own edge read
 * 排队中 — one card contradicting itself.
 */
export type FlowNodeState = 'idle' | 'active' | 'pending' | 'blocked' | 'done' | 'rework' | 'planned' | 'lost' | 'paused' | 'closed'

/**
 * Dispatch states.
 *
 * `queued` — dispatched, no execution started, and the dispatch is still fresh.
 *   It carries TWO real meanings, and neither is "pretend": the window between
 *   `prepareTaskForDispatch` pushing a task to `executing` and the execution
 *   record being written, and a dispatch the host held back because the
 *   in-flight limit was already reached (超限排队 — the call is classified
 *   `exclusive` and starts once the running group drains).
 * `executing` — a running execution recorded within {@link DISPATCH_STALE_MS}.
 *   SEVERAL dispatches may be `executing` at once: the in-flight limit is
 *   {@link DEVFLOW_CONCURRENCY_LIMIT}, not one.
 * `done` / `rework` — the execution reached a terminal state.
 * `lost` — a running execution older than the window, or an `assigned` record the
 *   flow has moved past: a historical dispatch nobody wrapped up. The judgement is
 *   DURATION/heartbeat only — it must never be derived from "another dispatch
 *   finished later", which is an ordinary concurrent fact, not evidence of loss.
 */
export type FlowEdgeState = 'queued' | 'executing' | 'done' | 'rework' | 'lost' | 'paused' | 'closed'

/** What kind of relation one edge draws. Line style and arrow direction carry it. */
export type FlowEdgeSemantic = 'requirement' | 'dispatch' | 'delivery' | 'rework' | 'subagent'

/** Canvas node kinds. `requirement` is the read-only 用户需求 origin node. */
export type FlowNodeKind = 'requirement' | 'commander' | 'fixed' | 'temporary'

/**
 * How long a running execution may claim to be in flight without a newer write.
 * 30 minutes is far beyond one dispatch round in this project (observed rounds
 * are seconds to minutes) while still covering a slow build or a long audit, so a
 * record past it is history rather than work in flight. This is the ONLY input to
 * the 未收尾 · 已失联 judgement — see {@link edgeState}.
 */
export const DISPATCH_STALE_MS = 30 * 60 * 1000

/**
 * How long an `assigned` record with no execution at all may still read
 * 「排队中」. The same window: the host writes an execution as the dispatch
 * starts, so a dispatch with no execution after this long never started.
 *
 * It covers BOTH real queueing causes: the window between the task turning
 * `executing` and its execution record being written, and a dispatch the host
 * held back because the in-flight limit was already reached.
 */
export const DISPATCH_QUEUE_MAX_MS = DISPATCH_STALE_MS

export const FLOW_COMMANDER_ID = 'commander'
export const FLOW_REQUIREMENT_ID = 'requirement'
export const FLOW_NODE_WIDTH = 172
export const FLOW_COMMANDER_STATE_LABEL = '总指挥'

export interface FlowHandoffField {
  readonly label: string
  readonly value: string
  readonly truncated: boolean
}

/** Everything the handoff inspector shows after a user clicks one edge. */
export interface FlowHandoff {
  readonly title: string
  readonly taskId: string | null
  readonly acceptance: FlowHandoffField
  readonly statusLabel: string
  readonly fromLabel: string
  readonly toLabel: string
  readonly at: string | null
  readonly retryCount: number
  readonly detail: string | null
}

export interface FlowNode {
  readonly id: string
  readonly label: string
  readonly kind: FlowNodeKind
  readonly roleId: string
  readonly roleLabel: string
  readonly state: FlowNodeState
  readonly stateLabel: string
  readonly taskId: string | null
  readonly taskTitle: string | null
  readonly taskDescription: string | null
  readonly taskStateLabel: string | null
  readonly skillsLabel: string
  /**
   * The Skill ids injected into the CHILD's persona for this node's current dispatch.
   *
   * Distinct from {@link skillsLabel} (what the roster binds): injection happens at
   * dispatch time, and it is observable evidence rather than a self-report — the host
   * resolves every bound Skill before starting the child and ABORTS the dispatch when one
   * source is unavailable, so a dispatch that exists at all was started WITH its Skills.
   */
  readonly dispatchSkillsLabel: string
  readonly capabilitiesLabel: string
  readonly delegationLabel: string
  /**
   * The sub-agent note as its OWN field. Joining it into {@link delegationLabel}
   * produced a mixed, contradictory line ("不能再派子代理（总指挥现场创建…）"),
   * so the two facts are rendered on separate rows by the canvas and the inspector.
   */
  readonly subagentNote: string
  readonly delegable: boolean
  readonly deliveryCount: number
  readonly delegationDepth: number | null
  readonly thought: string | null
  readonly output: string | null
  readonly executionLabel: string | null
  readonly modelLabel: string
  readonly designTarget: boolean
  /** Read-only source note for the 用户需求 node; null for every other node. */
  readonly sourceLabel: string | null
  readonly x: number
  readonly y: number
}

export interface FlowEdge {
  readonly id: string
  readonly from: string
  readonly to: string
  readonly fromLabel: string
  readonly toLabel: string
  readonly state: FlowEdgeState
  /** What relation this edge draws; drives its line style and arrow direction. */
  readonly semantic: FlowEdgeSemantic
  /** The phase this dispatch is associated with, or null when unrecorded. */
  readonly phaseId: string | null
  /** Corridor lane this edge owns; unique per drawn edge, so edges never overlap. */
  readonly laneY: number
  /** Port offset from the source card's centre, in world units. */
  readonly fromPort: number
  /** Port offset from the target card's centre, in world units. */
  readonly toPort: number
  readonly badge: string
  /** Set when the record is stale rather than live; shown in the handoff inspector. */
  readonly stale: boolean
  readonly taskId: string | null
  readonly taskLabel: string
  readonly handoff: FlowHandoff
  readonly path: string
  readonly arrowPath: string
  readonly labelX: number
  readonly labelY: number
}

/** One task of a phase, as the 阶段关联 block of the inspector lists it. */
export interface FlowBandTask {
  readonly id: string
  readonly title: string
  readonly stateLabel: string
}

/**
 * One 阶段关联: the internal grouping of dispatches by phase.
 *
 * Correction R2: this is NEVER drawn on the canvas any more — no box, no name, no
 * count badge, no rail. It stays the basis for layer order, corridor grouping and
 * lane pitch, and it is what the inspector's 阶段关联 list renders.
 */
export interface FlowBand {
  readonly id: string
  /** Sequence label, e.g. 阶段关联 2. */
  readonly label: string
  readonly name: string
  readonly status: FlowPhaseStatus
  readonly statusLabel: string
  readonly taskCount: number
  readonly dispatchCount: number
  /** The phase's tasks, for the inspector's 阶段关联 block. */
  readonly tasks: readonly FlowBandTask[]
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export type FlowPhaseStatus = DevFlowClientPhase['status']

/** Which dispatch edges the canvas draws. */
export type FlowEdgeScope = 'current' | 'history'

export interface FlowEdgeRoute {
  readonly edges: readonly FlowEdge[]
  /** Dispatches this scope does not draw because the employee has no canvas node. */
  readonly unroutedCount: number
}

export interface FlowModel {
  readonly commanderId: string
  readonly requirementId: string
  readonly nodes: readonly FlowNode[]
  readonly visibleAgentIds: readonly string[]
  /** The scope this model's geometry was computed for. */
  readonly scope: FlowEdgeScope
  /** Drawn dispatches of {@link scope}, with lanes, ports and paths attached. */
  readonly edges: readonly FlowEdge[]
  /** 用户需求 → 总指挥 relation; not a dispatch, so it is never counted as one. */
  readonly requirementEdge: FlowEdge | null
  /** 阶段关联带 of the drawn scope, in absolute world coordinates. */
  readonly bands: readonly FlowBand[]
  readonly canvasWidth: number
  readonly canvasHeight: number
  /**
   * How many dispatches in this snapshot are genuinely in flight, and the limit
   * they are measured against. `running` is COUNTED from the edges — every
   * `executing` edge, in every scope — never estimated, so the toolbar's
   * `并发 N/5` can only ever restate a record the snapshot really carries.
   */
  readonly concurrency: FlowConcurrency
  /** Default view: one edge per employee, for the dispatch that is still current. */
  readonly current: FlowEdgeRoute
  /** Opt-in view: every dispatch the snapshot still records. */
  readonly history: FlowEdgeRoute
  /** Count of dispatches the canvas reads as 未收尾 · 已失联, for the honest footer. */
  readonly lostCount: number
  /** Dispatches with no canvas node to land on; counted, never drawn as a dangling line. */
  readonly unroutedCount: number
  /** The newest completion in the snapshot, kept as a display boundary only; it no longer decides `lost`. */
  readonly staleBoundary: string | null
  /** Epoch ms the projection judged staleness against. */
  readonly judgedAt: number
}

/** In-flight dispatch count plus the limit it is measured against. */
export interface FlowConcurrency {
  /** Dispatches whose execution record says `running`, counted from the snapshot. */
  readonly running: number
  /** The configured ceiling; the panel shows `并发 running/limit`. */
  readonly limit: number
  /** True when the ceiling is reached and any further dispatch waits in line. */
  readonly atLimit: boolean
}

const NODE_HEIGHT_ESTIMATE = 118
const REQUIREMENT_WIDTH = 208
const REQUIREMENT_HEIGHT_ESTIMATE = 96
/**
 * Left rail width. Correction R2 removed every phase visual from the canvas, so
 * the rail is gone: the 阶段关联 带 still exist as the internal grouping that
 * decides layer order, corridor grouping and lane pitch — they are simply not
 * drawn. See {@link FlowBand} for what the inspector still lists.
 */
const BAND_GUTTER = 0
const COLUMN_GAP = 26
const ROW_GAP = 30
const CORRIDOR_TOP_PAD = 24
/** Vertical pitch between two dispatch lanes; far wider than any stroke. */
export const LANE_PITCH = 13
const LANE_GROUP_GAP = 13
const BAND_PAD = 7
const MARGIN_X = 16
const MARGIN_Y = 18
/** Port margin inside a card edge, so a fan never runs off the card. */
const PORT_MARGIN = 10

const ROLE_LABELS: Readonly<Record<string, string>> = {
  commander: '总指挥',
  planner: '总指挥',
  'backend-engineer': '代码工程师',
  'frontend-engineer': '前端工程师',
  // The architect shares the `planner` role, so without its own entry the canvas
  // would label its card 总指挥 — the same name as the commander.
  architect: '架构师',
  'code-auditor': '审计工程师',
  reviewer: '审计工程师',
}

const NODE_STATE_LABELS: Readonly<Record<FlowNodeState, string>> = {
  idle: '空闲',
  active: '执行中',
  pending: '待执行',
  blocked: '待决策',
  done: '已完成',
  rework: '返工中',
  planned: '待派发',
  lost: '未收尾',
  paused: '已暂停',
  closed: '已收尾',
}

const EDGE_STATE_LABELS: Readonly<Record<FlowEdgeState, string>> = {
  queued: '排队中',
  executing: '执行中',
  done: '已完成',
  rework: '返工',
  lost: '未收尾 · 已失联',
  paused: '已暂停',
  closed: '已收尾',
}

/** Stable zh-CN copy for the relation kinds drawn on the canvas. */
export const FLOW_SEMANTIC_LABELS: Readonly<Record<FlowEdgeSemantic, string>> = {
  requirement: '需求下达',
  dispatch: '派发',
  delivery: '交付 · 汇报',
  rework: '返工',
  subagent: '子代理创建 / 回传',
}

const PHASE_STATUS_LABELS: Readonly<Record<FlowPhaseStatus, string>> = {
  planned: '计划中',
  in_progress: '进行中',
  completed: '已完成',
}

/**
 * Chinese display name for a stored agent id, falling back to the role label.
 *
 * @param agentId - the stored agent id.
 * @param role - the stored role, used only when the id has no name of its own.
 * @param fallback - the name to use when neither the id nor the role is known.
 * @param namedByItself - true when `fallback` is the agent's OWN stored display
 *   name. Such a name must win over the role table: a temporary sub-agent is
 *   registered with a role (`planner`, `reviewer`, …), and those role entries are
 *   the FIXED seats' names, so the role fallback would label a temporary agent
 *   「总指挥」 — the commander's own name — on its card and on its edge.
 */
export function flowAgentLabel(
  agentId: string,
  role: string | undefined,
  fallback: string,
  namedByItself = false,
): string {
  const byId = ROLE_LABELS[agentId]
  if (byId !== undefined) return byId
  if (namedByItself) return fallback
  const byRole = role === undefined ? undefined : ROLE_LABELS[role]
  return byRole ?? fallback
}

export function flowNodeStateLabel(state: FlowNodeState): string { return NODE_STATE_LABELS[state] }
export function flowEdgeStateLabel(state: FlowEdgeState): string { return EDGE_STATE_LABELS[state] }
export function flowSemanticLabel(semantic: FlowEdgeSemantic): string { return FLOW_SEMANTIC_LABELS[semantic] }

/**
 * Inputs for the stale-dispatch judgement: the clock, and the newest completion in
 * the snapshot (retained as a reported boundary — `lost` itself is judged by the
 * clock alone, see {@link edgeState}).
 */
interface StaleContext {
  readonly now: number
  readonly newestCompletion: number
}

/**
 * Project the current snapshot into canvas nodes, association bands and edges.
 *
 * @param model - the read-only workspace model folded from the V1 snapshot.
 * @param now - clock used for the stale judgement.
 * @param nodeHeights - measured card heights, keyed by node id, so a taller card
 *   never collides with the next rank.
 * @param scope - which edge scope the geometry is computed for; the default view
 *   and the full-history view carry different lane counts and therefore different
 *   corridor heights.
 */
export function createFlowModel(  model: WorkspaceModel,
  now: number = Date.now(),
  nodeHeights: Readonly<Record<string, number>> = {},
  scope: FlowEdgeScope = 'current',
): FlowModel {
  const commander = model.agents.find(item => item.agent.id === FLOW_COMMANDER_ID)
  /**
   * Every employee the canvas may draw a card for — fixed AND temporary.
   *
   * The Commander itself never gets a card here (it is its own node), but a
   * temporary sub-agent created on the spot by the Commander must: the roster
   * record, the assignment, the execution and the dispatch edge are all real, so
   * leaving it out made the whole dispatch invisible (no card, no edge, and the
   * edge counted as 未落点). The temporary branch in {@link agentNode} was always
   * implemented — this filter was the only thing keeping it unreachable.
   *
   * Being a candidate is NOT being drawn: {@link isVisible} still decides, and it
   * reads only real records, so an employee with nothing recorded produces no card
   * and the layout stays exactly as it was.
   */
  const employees = model.agents.filter(item => item.agent.id !== FLOW_COMMANDER_ID)
  const visibleAgents = employees.filter(isVisible)
  const visibleIds = visibleAgents.map(item => item.agent.id)

  const context: StaleContext = { now, newestCompletion: newestCompletionAt(model) }
  const dispatches = model.tasks.flatMap((task, index) => createTaskEdges(task, index, model, context))
  // Concurrent dispatches are REAL (并发上限 5 · 超限排队): every edge the snapshot
  // reports as executing stays 执行中. The demotion that used to keep only the
  // freshest one live was a claim about a single execution slot that no longer
  // exists — it made the panel deny work the host was actually running.
  const liveEdges = dispatches
  // "Current" is decided per employee, not per task: an employee's canvas keeps one
  // edge — the dispatch still in flight, else the newest one.
  const currentIds = pickCurrentEdges(liveEdges)
  const routed = liveEdges.filter(edge => visibleIds.includes(edge.targetAgentId))
  const unroutedCount = liveEdges.length - routed.length
  const current = routed.filter(edge => currentIds.has(edge.edgeId))
  // Counted from the edges, never estimated: every dispatch whose execution record
  // says `running` — the same predicate that paints 执行中.
  const runningCount = dispatches.filter(edge => edge.state === 'executing').length

  const ordered = orderEmployees(visibleAgents, routed)
  const columns = Math.max(1, ordered.length)
  const rowWidth = columns * FLOW_NODE_WIDTH + (columns - 1) * COLUMN_GAP
  const rowLeft = MARGIN_X + BAND_GUTTER
  // The 用户需求 node is centred over the row; with the phase rail gone (correction
  // R2) a narrow row would push it past the left margin, so the whole layout is
  // shifted right just enough for the widest rank to stay inside the canvas.
  const shift = Math.max(0, MARGIN_X - (rowLeft + rowWidth / 2 - REQUIREMENT_WIDTH / 2))
  const rowX = rowLeft + shift
  const centre = rowLeft + rowWidth / 2 + shift
  const canvasWidth = Math.max(
    rowX + rowWidth + MARGIN_X,
    centre + REQUIREMENT_WIDTH / 2 + MARGIN_X,
  )

  const currentLanes = assignLanes(current, ordered, centre, rowX)
  const historyLanes = assignLanes(routed, ordered, centre, rowX)
  const commanderHeight = nodeHeights[FLOW_COMMANDER_ID] ?? NODE_HEIGHT_ESTIMATE
  const requirementHeight = nodeHeights[FLOW_REQUIREMENT_ID] ?? REQUIREMENT_HEIGHT_ESTIMATE
  const requirementY = MARGIN_Y
  const commanderY = requirementY + requirementHeight + ROW_GAP
  const corridorTop = commanderY + commanderHeight + CORRIDOR_TOP_PAD
  // Lanes and bands are shifted into absolute world coordinates, so an edge's lane
  // and the 阶段关联带 that owns it always agree.
  const offsetLanes = (laneSet: LaneAssignment): LaneAssignment => ({
    ...laneSet,
    laneY: new Map([...laneSet.laneY].map(([id, y]) => [id, y + corridorTop])),
    bands: laneSet.bands.map(band => ({ ...band, y: band.y + corridorTop })),
  })
  const lanes = offsetLanes(scope === 'history' ? historyLanes : currentLanes)
  const rowY = corridorTop + lanes.height + ROW_GAP

  const nodes: FlowNode[] = []
  nodes.push({
    ...commanderNode(commander, routed.length),
    x: centre - FLOW_NODE_WIDTH / 2,
    y: commanderY,
  })
  if (model.snapshot.project !== null) {
    nodes.unshift({
      ...requirementNode(model.snapshot.project.name, model.snapshot.project.goal, model.snapshot.project.currentStage),
      x: centre - REQUIREMENT_WIDTH / 2,
      y: requirementY,
    })
  }
  ordered.forEach((item, index) => {
    nodes.push({
      ...agentNode(item, currentDispatch(item.agent.id, routed), routed),
      x: rowX + index * (FLOW_NODE_WIDTH + COLUMN_GAP),
      y: rowY,
    })
  })

  const byId = new Map(nodes.map(node => [node.id, node]))
  const boxes = new Map<string, LayoutBox>(nodes.map(node => [node.id, {
    x: node.x,
    y: node.y,
    width: nodeWidth(node.kind),
    height: nodeHeights[node.id] ?? (node.kind === 'requirement' ? REQUIREMENT_HEIGHT_ESTIMATE : NODE_HEIGHT_ESTIMATE),
  }]))

  const commanderLabel = byId.get(FLOW_COMMANDER_ID)?.label ?? FLOW_COMMANDER_STATE_LABEL
  const visibleById = new Map(ordered.map(item => [item.agent.id, item]))
  const currentPorts = assignPorts(current, visibleById, boxes)
  const historyPorts = assignPorts(routed, visibleById, boxes)
  const finalize = (
    items: readonly TaskEdge[],
    laneSet: LaneAssignment,
    portSet: ReadonlyMap<string, EdgePorts>,
  ): readonly FlowEdge[] => items.map(edge => finalizeEdge(
    edge,
    commanderLabel,
    visibleById,
    laneSet,
    portSet,
    boxes,
  ))

  const requirementEdge = model.snapshot.project === null
    ? null
    : requirementRelation(boxes, requirementY, commanderY)
  const bands = sizedBands(lanes.bands, canvasWidth).map(band => ({ ...band, tasks: tasksOfPhase(model, band.id) }))

  const lastRowHeight = ordered.length === 0
    ? 0
    : Math.max(...ordered.map(item => nodeHeights[item.agent.id] ?? NODE_HEIGHT_ESTIMATE))
  const canvasHeight = (ordered.length === 0 ? rowY - ROW_GAP : rowY + lastRowHeight) + MARGIN_Y

  return {
    commanderId: FLOW_COMMANDER_ID,
    requirementId: FLOW_REQUIREMENT_ID,
    nodes,
    visibleAgentIds: visibleIds,
    scope,
    edges: finalize(scope === 'history' ? routed : current, lanes, scope === 'history' ? historyPorts : currentPorts),
    requirementEdge,
    bands,
    canvasWidth,
    canvasHeight,
    concurrency: {
      running: runningCount,
      limit: DEVFLOW_CONCURRENCY_LIMIT,
      atLimit: runningCount >= DEVFLOW_CONCURRENCY_LIMIT,
    },
    // Default view collapses to the dispatch still in flight per employee, so a
    // project with a long history stays readable.
    current: { edges: finalize(current, offsetLanes(currentLanes), currentPorts), unroutedCount },
    history: { edges: finalize(routed, offsetLanes(historyLanes), historyPorts), unroutedCount },
    lostCount: routed.filter(edge => edge.state === 'lost').length,
    unroutedCount,
    // Kept as a display boundary (the inspector names the newest completion). It no
    // longer decides `lost`: a later completion is an ordinary concurrent fact.
    staleBoundary: context.newestCompletion === 0 ? null : new Date(context.newestCompletion).toISOString(),
    judgedAt: now,
  }
}

function nodeWidth(kind: FlowNodeKind): number {
  return kind === 'requirement' ? REQUIREMENT_WIDTH : FLOW_NODE_WIDTH
}

/**
 * Every task associated with one phase, for the inspector's 阶段关联 block.
 * Association only: it is read from the task's own phase links, never inferred.
 */
function tasksOfPhase(model: WorkspaceModel, phaseId: string): readonly FlowBandTask[] {
  if (phaseId === '' || phaseId === 'phase:unrecorded') return []
  return model.tasks
    .filter(item => item.phaseIds.includes(phaseId))
    .sort((left, right) => left.task.updatedAt.localeCompare(right.task.updatedAt) || left.task.id.localeCompare(right.task.id))
    .map(item => ({ id: item.task.id, title: item.task.title, stateLabel: taskWorkStateLabel(item.workState) }))
}

/** Anchor corridor-relative band geometry to the canvas width. */
function sizedBands(bands: readonly FlowBand[], canvasWidth: number): readonly FlowBand[] {
  return bands.map(band => ({
    ...band,
    x: MARGIN_X,
    width: Math.max(0, canvasWidth - MARGIN_X * 2),
  }))
}

/**
 * Order the employees left to right so the corridor reads as one dispatch
 * schedule: the employee whose earliest associated dispatch came first sits
 * leftmost. Association order (never a dependency) is the only ordering input.
 */
function orderEmployees(
  agents: readonly WorkspaceAgent[],
  routed: readonly TaskEdge[],
): readonly WorkspaceAgent[] {
  const score = new Map<string, number>()
  for (const edge of routed) {
    const current = score.get(edge.targetAgentId)
    if (current === undefined || edge.order < current) score.set(edge.targetAgentId, edge.order)
  }
  return [...agents].sort((left, right) => {
    const leftScore = score.get(left.agent.id) ?? Number.MAX_SAFE_INTEGER
    const rightScore = score.get(right.agent.id) ?? Number.MAX_SAFE_INTEGER
    if (leftScore !== rightScore) return leftScore - rightScore
    return left.agent.id.localeCompare(right.agent.id)
  })
}

interface LaneAssignment {
  readonly laneY: ReadonlyMap<string, number>
  readonly bands: readonly FlowBand[]
  readonly height: number
}

interface EdgePorts {
  readonly fromPort: number
  readonly toPort: number
}

/**
 * Give every drawn dispatch its own lane, grouped into 阶段关联带.
 *
 * Why lanes: several dispatches share the same (commander → employee) card pair,
 * and rendering them as one bundle is exactly the "合并不清" the product rejected
 * — so each dispatch owns a distinct horizontal lane and a distinct port on both
 * cards. Distinct lanes plus distinct ports make overlapping edges impossible by
 * construction; the ordering below then keeps crossings low.
 *
 * Ordering rules (association only, no dependency semantics):
 *  1. one band per phase that actually carries a dispatch;
 *  2. bands run in the phase's own association order (see {@link phaseOrder});
 *  3. inside a band, leftmost endpoint first — the same order as the target row,
 *     which is what makes a fan-out non-crossing;
 *  4. a bounded adjacent-swap pass then removes any crossing that order still
 *     leaves, without ever reordering the bands themselves.
 */
function assignLanes(
  edges: readonly TaskEdge[],
  agents: readonly WorkspaceAgent[],
  centre: number,
  rowX: number,
): LaneAssignment {
  const columnX = new Map(agents.map((item, index) => [
    item.agent.id,
    rowX + index * (FLOW_NODE_WIDTH + COLUMN_GAP) + FLOW_NODE_WIDTH / 2,
  ]))
  const agentById = new Map(agents.map(item => [item.agent.id, item]))
  const phaseIndex = phaseOrder(edges)
  const groups = new Map<string, TaskEdge[]>()
  for (const edge of edges) {
    const key = edge.phaseId ?? ''
    const list = groups.get(key)
    if (list === undefined) groups.set(key, [edge])
    else list.push(edge)
  }
  const ordered = [...groups.entries()]
    .sort(([left], [right]) => {
      const leftIndex = phaseIndex.get(left) ?? Number.MAX_SAFE_INTEGER
      const rightIndex = phaseIndex.get(right) ?? Number.MAX_SAFE_INTEGER
      if (leftIndex !== rightIndex) return leftIndex - rightIndex
      return left.localeCompare(right)
    })
    .map(([, list]) => sortWithinBand(list, columnX))

  const laneY = new Map<string, number>()
  const bands: FlowBand[] = []
  let cursor = 0
  for (const list of ordered) {
    const ys = list.map((_, index) => cursor + index * LANE_PITCH)
    improveWithinBand(list, ys, (edge, index) => {
      const back = semanticOf(edge, agentById.get(edge.targetAgentId)) === 'delivery'
      const employeeX = columnX.get(edge.targetAgentId) ?? centre
      return {
        sourceX: back ? employeeX : centre,
        targetX: back ? centre : employeeX,
        lane: ys[index] ?? cursor,
        sourceAbove: !back,
      }
    })
    list.forEach((edge, index) => { laneY.set(edge.edgeId, ys[index] ?? cursor) })
    const first = list[0]
    const top = cursor - LANE_PITCH / 2 - BAND_PAD
    const height = Math.max(LANE_PITCH, (list.length - 1) * LANE_PITCH) + BAND_PAD * 2
    bands.push({
      id: first?.phaseId ?? 'phase:unrecorded',
      label: `阶段关联 ${bands.length + 1}`,
      name: first?.phaseName ?? '未记录阶段',
      status: first?.phaseStatus ?? 'planned',
      statusLabel: PHASE_STATUS_LABELS[first?.phaseStatus ?? 'planned'],
      taskCount: new Set(list.map(edge => edge.taskId)).size,
      dispatchCount: list.length,
      tasks: [],
      x: 0,
      y: top,
      width: 0,
      height,
    })
    cursor = top + height + LANE_GROUP_GAP
  }
  const height = cursor === 0 ? 0 : cursor - LANE_GROUP_GAP + BAND_PAD
  return { laneY, bands, height: Math.max(height, 0) }
}

/** Stable left-to-right order inside one band: leftmost endpoint first. */
function sortWithinBand(edges: readonly TaskEdge[], columnX: ReadonlyMap<string, number>): TaskEdge[] {
  return [...edges].sort((left, right) => {
    const leftX = columnX.get(left.targetAgentId) ?? Number.MAX_SAFE_INTEGER
    const rightX = columnX.get(right.targetAgentId) ?? Number.MAX_SAFE_INTEGER
    if (leftX !== rightX) return leftX - rightX
    return left.order - right.order
  })
}

/**
 * Bounded adjacent-swap pass over one band's lanes. Swaps are accepted only when
 * the measured crossing count strictly decreases, so the pass always terminates;
 * the band's own edge set never changes, so the phase grouping stays intact.
 */
function improveWithinBand(
  edges: readonly TaskEdge[],
  laneY: number[],
  shapeAt: (edge: TaskEdge, index: number) => RouteShape,
): void {
  const shapes = (): RouteShape[] => edges.map((edge, index) => shapeAt(edge, index))
  let current = countCrossings(shapes())
  for (let pass = 0; pass < 3 && current > 0; pass += 1) {
    let swapped = false
    for (let index = 0; index + 1 < edges.length; index += 1) {
      const leftY = laneY[index]
      const rightY = laneY[index + 1]
      if (leftY === undefined || rightY === undefined) continue
      laneY[index] = rightY
      laneY[index + 1] = leftY
      const next = countCrossings(shapes())
      if (next < current) { current = next; swapped = true; continue }
      laneY[index] = leftY
      laneY[index + 1] = rightY
    }
    if (!swapped) break
  }
}

export interface RouteShape {
  readonly sourceX: number
  readonly targetX: number
  readonly lane: number
  /** True when the source card is above the corridor; false for 交付 · 汇报. */
  readonly sourceAbove: boolean
}

/**
 * Count proper crossings of a set of orthogonal Z routes that all share one
 * source column. A crossing is an interior intersection between one route's
 * horizontal lane run and another route's vertical run; meeting at the shared
 * source is not a crossing.
 */
export function countCrossings(shapes: readonly RouteShape[]): number {
  const TOP = -1
  const BOTTOM = 1_000_000
  const segments = shapes.map(shape => {
    const left = Math.min(shape.sourceX, shape.targetX)
    const right = Math.max(shape.sourceX, shape.targetX)
    return {
      verticals: shape.sourceAbove
        ? [
          { x1: shape.sourceX, y1: TOP, x2: shape.sourceX, y2: shape.lane },
          { x1: shape.targetX, y1: shape.lane, x2: shape.targetX, y2: BOTTOM },
        ]
        : [
          { x1: shape.sourceX, y1: shape.lane, x2: shape.sourceX, y2: BOTTOM },
          { x1: shape.targetX, y1: TOP, x2: shape.targetX, y2: shape.lane },
        ],
      horizontal: { x1: left, y1: shape.lane, x2: right, y2: shape.lane },
    }
  })
  let total = 0
  for (let a = 0; a < segments.length; a += 1) {
    for (let b = 0; b < segments.length; b += 1) {
      if (a === b) continue
      const first = segments[a]
      const second = segments[b]
      if (first === undefined || second === undefined) continue
      for (const vertical of second.verticals) {
        const low = Math.min(first.horizontal.x1, first.horizontal.x2)
        const high = Math.max(first.horizontal.x1, first.horizontal.x2)
        if (vertical.x1 <= low || vertical.x1 >= high) continue
        const top = Math.min(vertical.y1, vertical.y2)
        const bottom = Math.max(vertical.y1, vertical.y2)
        const lane = first.horizontal.y1
        if (lane > top && lane < bottom) total += 1
      }
    }
  }
  return total
}

/**
 * Assign a distinct port to every edge endpoint on a card side, ordered by the
 * peer's x.
 *
 * Two separations are needed and both are enforced here:
 *  1. within one card side the ports are evenly spread, so a bundle of dispatches
 *     between the same pair fans out instead of stacking;
 *  2. across ALL card sides the absolute x values stay unique (a small nudge
 *     resolves a collision), because two edges whose vertical runs share an x can
 *     otherwise be drawn on top of each other for part of their length. Two cards
 *     that are centred on the same column would otherwise produce identical ports.
 */
function assignPorts(
  edges: readonly TaskEdge[],
  agents: ReadonlyMap<string, WorkspaceAgent>,
  boxes: ReadonlyMap<string, LayoutBox>,
): ReadonlyMap<string, EdgePorts> {
  interface End {
    readonly edgeId: string
    readonly nodeId: string
    readonly side: 'top' | 'bottom'
    readonly peerX: number
    readonly order: number
  }
  const ends: End[] = []
  const push = (edge: TaskEdge, from: string, to: string): void => {
    const fromBox = boxes.get(from)
    const toBox = boxes.get(to)
    if (fromBox === undefined || toBox === undefined) return
    const targetX = toBox.x + toBox.width / 2
    const sourceX = fromBox.x + fromBox.width / 2
    const down = fromBox.y + fromBox.height <= toBox.y
    ends.push({ edgeId: edge.edgeId, nodeId: from, side: down ? 'bottom' : 'top', peerX: targetX, order: edge.order })
    ends.push({ edgeId: edge.edgeId, nodeId: to, side: down ? 'top' : 'bottom', peerX: sourceX, order: edge.order })
  }
  for (const edge of edges) {
    const { from, to } = endpointsOf(edge, agents.get(edge.targetAgentId))
    push(edge, from, to)
  }
  const grouped = new Map<string, End[]>()
  for (const end of ends) {
    const key = `${end.nodeId}|${end.side}`
    const list = grouped.get(key)
    if (list === undefined) grouped.set(key, [end])
    else list.push(end)
  }
  const used = new Set<number>()
  const xOf = new Map<string, number>()
  const orderedGroups = [...grouped.entries()]
    .map(([key, list]) => ({ key, nodeId: key.slice(0, key.lastIndexOf('|')), list }))
    .sort((left, right) => left.key.localeCompare(right.key))
  for (const group of orderedGroups) {
    const box = boxes.get(group.nodeId)
    if (box === undefined) continue
    const centre = box.x + box.width / 2
    const usable = Math.max(0, box.width - PORT_MARGIN * 2)
    const sorted = [...group.list].sort((left, right) => (left.peerX - right.peerX) || (left.order - right.order))
    sorted.forEach((end, index) => {
      const ratio = sorted.length === 1 ? 0.5 : index / (sorted.length - 1)
      xOf.set(`${end.edgeId}|${end.nodeId}`, claim(centre - usable / 2 + ratio * usable, box, used))
    })
  }
  const ports = new Map<string, EdgePorts>()
  for (const edge of edges) {
    const { from, to } = endpointsOf(edge, agents.get(edge.targetAgentId))
    const fromCentre = centreOf(boxes.get(from))
    const toCentre = centreOf(boxes.get(to))
    ports.set(edge.edgeId, {
      fromPort: (xOf.get(`${edge.edgeId}|${from}`) ?? fromCentre) - fromCentre,
      toPort: (xOf.get(`${edge.edgeId}|${to}`) ?? toCentre) - toCentre,
    })
  }
  return ports
}

function centreOf(box: LayoutBox | undefined): number {
  return box === undefined ? 0 : box.x + box.width / 2
}

/**
 * Claim an unused absolute x on a card edge, nudging until it is unique.
 *
 * The nudge step is larger than a drawn stroke by an order of magnitude, so two
 * nudged ports are still visibly separate lines rather than a doubled one.
 */
function claim(preferred: number, box: LayoutBox, used: Set<number>): number {
  const minimum = box.x + 4
  const maximum = box.x + box.width - 4
  const key = (value: number): number => Math.round(value * 10) / 10
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const step = Math.ceil(attempt / 2) * 3.2 * (attempt % 2 === 0 ? 1 : -1)
    const candidate = clampNumber(preferred + step, minimum, maximum)
    if (!used.has(key(candidate))) {
      used.add(key(candidate))
      return candidate
    }
  }
  used.add(key(preferred))
  return preferred
}

function clampNumber(value: number, minimum: number, maximum: number): number {
  if (minimum > maximum) return (minimum + maximum) / 2
  return Math.min(maximum, Math.max(minimum, value))
}

/**
 * Which relation kind one dispatch draws right now.
 *
 * The relation is a fact of the record, not a decoration: a dispatch still moving
 * is a 派发, one that came back is a 交付 · 汇报 (drawn back into the commander),
 * one that is being redone is a 返工, and a dispatch to a temporary sub-agent is
 * the 子代理创建 / 回传 pair. A dispatch nobody ever closed stays a 派发, because
 * nothing was delivered.
 */
function semanticOf(edge: TaskEdge, target: WorkspaceAgent | undefined): FlowEdgeSemantic {
  if (target?.agent.kind === 'temporary') return 'subagent'
  if (edge.state === 'rework') return 'rework'
  if (edge.state === 'done') return 'delivery'
  return 'dispatch'
}

/** The two ends of one relation; the commander is always one of them. */
function endpointsOf(
  edge: TaskEdge,
  target: WorkspaceAgent | undefined,
): { readonly from: string; readonly to: string; readonly semantic: FlowEdgeSemantic } {
  const semantic = semanticOf(edge, target)
  const back = semantic === 'delivery'
  return {
    from: back ? edge.targetAgentId : FLOW_COMMANDER_ID,
    to: back ? FLOW_COMMANDER_ID : edge.targetAgentId,
    semantic,
  }
}

/**
 * The association order of phases.
 *
 * `Phase` carries no order field, and the browser contract does not ship the
 * phase's `createdAt` (adding it would need a Host-side projection change, which
 * this round must not make). The order therefore comes from real data the
 * snapshot does carry: the earliest execution start among the phase's associated
 * dispatches, falling back to the phase id so the order is always stable.
 */
function phaseOrder(edges: readonly TaskEdge[]): ReadonlyMap<string, number> {
  const firstSeen = new Map<string, number>()
  for (const edge of edges) {
    if (edge.phaseId === null) continue
    const at = Date.parse(edge.execution?.startedAt ?? edge.at ?? '')
    const value = Number.isNaN(at) ? Number.MAX_SAFE_INTEGER - 1 : at
    const current = firstSeen.get(edge.phaseId)
    if (current === undefined || value < current) firstSeen.set(edge.phaseId, value)
  }
  return new Map([...firstSeen.entries()]
    .sort(([leftId, left], [rightId, right]) => (left - right) || leftId.localeCompare(rightId))
    .map(([id], index) => [id, index]))
}

/**
 * The one in-flight edge of one employee: 执行中 wins over 排队中.
 *
 * The order matters and used to be wrong. Both predicates used to be searched in one
 * pass ("reverse, then the first that is executing OR queued"), so an employee holding
 * an older 执行中 dispatch AND a newer 排队中 one presented the QUEUED edge: its card
 * said 执行中 (the node reads any executing edge) while the line attached to it said
 * 排队中 with the queued colour. An employee that is really running must show the
 * running line; a queued dispatch is only the fallback when nothing of theirs runs.
 */
function pickLiveEdge(list: readonly TaskEdge[]): TaskEdge | undefined {
  const reversed = [...list].reverse()
  return reversed.find(edge => edge.state === 'executing') ?? reversed.find(edge => edge.state === 'queued')
}

/**
 * The one dispatch each employee's canvas keeps by default: the dispatch still in
 * flight when there is one, otherwise the newest dispatch of that employee.
 */
function pickCurrentEdges(edges: readonly TaskEdge[]): ReadonlySet<string> {
  const byAgent = new Map<string, TaskEdge[]>()
  for (const edge of edges) {
    const list = byAgent.get(edge.targetAgentId)
    if (list === undefined) byAgent.set(edge.targetAgentId, [edge])
    else list.push(edge)
  }
  const current = new Set<string>()
  for (const list of byAgent.values()) {
    const chosen = pickLiveEdge(list) ?? list.at(-1)
    if (chosen !== undefined) current.add(chosen.edgeId)
  }
  return current
}

/** The dispatch a node presents: the one still in flight, else the newest one. */
function currentDispatch(agentId: string, edges: readonly TaskEdge[]): TaskEdge | null {
  const items = edges.filter(edge => edge.targetAgentId === agentId)
  if (items.length === 0) return null
  return pickLiveEdge(items) ?? items.at(-1) ?? null
}

interface TaskEdge {
  readonly edgeId: string
  readonly targetAgentId: string
  readonly taskId: string
  readonly task: DevFlowClientTask
  readonly taskState: TaskWorkState
  readonly assignment: DevFlowClientAssignment | null
  readonly execution: DevFlowClientExecution | null
  readonly state: FlowEdgeState
  readonly action: string
  readonly at: string | null
  readonly retryCount: number
  readonly output: string | null
  readonly thought: string | null
  readonly executionLabel: string | null
  /** True when the state is 未收尾 because the record is stale rather than live. */
  readonly stale: boolean
  /** Human-readable reason for {@link stale}; null while the dispatch is live. */
  readonly staleReason: string | null
  /** The phase this dispatch is associated with, from its assignment. */
  readonly phaseId: string | null
  readonly phaseName: string | null
  readonly phaseStatus: FlowPhaseStatus
  /** Stable creation order, used to derive the current dispatch per employee. */
  readonly order: number
}

/**
 * One edge per dispatched assignment: `assignments` is what actually records a
 * dispatch to an employee, so a task that went back and forth produces one edge
 * per hand-off instead of a single edge pinned to whichever assignment came last.
 * A task that never reached an assignment still contributes one unattributed edge
 * so the count stays honest.
 */
function createTaskEdges(
  item: WorkspaceFlowTask,
  index: number,
  model: WorkspaceModel,
  context: StaleContext,
): readonly TaskEdge[] {
  if (item.assignments.length === 0) {
    return [createTaskEdge(item, null, null, index * 100, model, context)]
  }
  return item.assignments.map((assignment, offset) => {
    const execution = latestExecutionFor(item.executions, assignment.id)
    return createTaskEdge(item, assignment, execution, index * 100 + offset, model, context)
  })
}

function createTaskEdge(
  item: WorkspaceFlowTask,
  assignment: DevFlowClientAssignment | null,
  assignedExecution: DevFlowClientExecution | null,
  order: number,
  model: WorkspaceModel,
  context: StaleContext,
): TaskEdge {
  const execution = assignedExecution ?? (assignment === null ? latestExecution(item.executions) : null)
  const retryCount = item.attempts.filter(attempt => attempt.isRetry).length
    + item.executions.filter(candidate => candidate.status === 'failed').length
  const dispatchAt = latestTimestamp([
    item.task.updatedAt,
    execution?.startedAt ?? null,
    execution?.completedAt ?? null,
  ])
  const verdict = edgeState(item.workState, assignment, execution, retryCount, dispatchAt, context)
  const reports = execution === null ? [] : item.reports.filter(report => report.executionId === execution.id)
  const thought = reports.at(-1)?.summary ?? item.reports.at(-1)?.summary ?? null
  const output = item.results.at(-1)?.summary ?? reports.at(-1)?.summary ?? null
  const phase = assignment === null ? undefined : model.phases.find(candidate => candidate.id === assignment.phaseId)
  return {
    edgeId: assignment === null ? `task:${item.task.id}` : `dispatch:${assignment.id}`,
    targetAgentId: assignment?.agentId ?? execution?.agentId ?? '',
    taskId: item.task.id,
    task: item.task,
    taskState: item.workState,
    assignment,
    execution,
    state: verdict.state,
    action: edgeAction(verdict.state, item.workState, assignment),
    at: dispatchAt,
    retryCount,
    output: output === null ? null : output.text,
    thought: thought === null ? null : thought.text,
    executionLabel: executionLabel(execution),
    stale: verdict.reason !== null,
    staleReason: verdict.reason,
    phaseId: assignment?.phaseId ?? null,
    phaseName: phase?.name ?? null,
    phaseStatus: phase?.status ?? 'planned',
    order,
  }
}

/** The newest of several ISO timestamps, or null when none parses. */
function latestTimestamp(values: readonly (string | null | undefined)[]): string | null {
  let best: string | null = null
  let bestTime = Number.NEGATIVE_INFINITY
  for (const value of values) {
    if (value === null || value === undefined) continue
    const parsed = Date.parse(value)
    if (Number.isNaN(parsed)) continue
    if (parsed > bestTime) { bestTime = parsed; best = value }
  }
  return best
}

/**
 * Epoch ms of the newest completion recorded anywhere in the snapshot, or 0 when
 * nothing ever completed.
 *
 * It is now a DISPLAY boundary only (`FlowModel.staleBoundary`). It used to
 * decide `lost` — "started before a later completion ⇒ never held the single
 * execution slot" — and that inference is invalid once dispatches overlap:
 * concurrent children start before other dispatches complete all the time, so
 * the rule reported running work as 已失联.
 */
function newestCompletionAt(model: WorkspaceModel): number {
  let newest = 0
  for (const execution of model.snapshot.executions) {
    if (execution.status !== 'completed' || execution.completedAt === null) continue
    const parsed = Date.parse(execution.completedAt)
    if (!Number.isNaN(parsed) && parsed > newest) newest = parsed
  }
  return newest
}

/** The newest execution that belongs to one assignment. */
function latestExecutionFor(
  executions: readonly DevFlowClientExecution[],
  assignmentId: string,
): DevFlowClientExecution | null {
  return latestExecution(executions.filter(execution => execution.assignmentId === assignmentId))
}

/**
 * The execution that actually ran last.
 *
 * Time decides, not array order. The snapshot's rows are sorted by execution ID
 * (the host's own order), which says nothing about which attempt ran last — and a
 * task whose first attempt failed and whose retry delivered is the ordinary case,
 * not an exotic one. Taking `at(-1)` made the choice depend on the UUID order of
 * the two ids, so the panel could show 返工 for a dispatch that had already
 * delivered (N5, `researcher-refs`: failed 46043611 then delivered aae2028d — the
 * failure sorted last and won).
 *
 * A live attempt still wins over a finished one, because "which execution is this
 * dispatch in" and "which execution is newest" are the same question while one is
 * running or queued.
 */
function latestExecution(executions: readonly DevFlowClientExecution[]): DevFlowClientExecution | null {
  if (executions.length === 0) return null
  const running = executions.filter(execution => execution.status === 'running')
  if (running.length > 0) return running.at(-1) ?? null
  const pending = executions.filter(execution => execution.status === 'pending')
  if (pending.length > 0) return pending.at(-1) ?? null
  const at = (value: string | null | undefined): number => {
    if (value === null || value === undefined) return Number.NEGATIVE_INFINITY
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed
  }
  let best: DevFlowClientExecution | null = null
  let bestAt = Number.NEGATIVE_INFINITY
  for (const execution of executions) {
    const when = Math.max(at(execution.completedAt), at(execution.startedAt))
    if (best === null || when > bestAt) {
      best = execution
      bestAt = when
    }
  }
  return best
}

/**
 * Decide one dispatch's honest state.
 *
 * The rules, in order:
 *  1. a running execution within {@link DISPATCH_STALE_MS} ⇒ 执行中. Several
 *     dispatches may report this at the same time: the ceiling is the in-flight
 *     limit, not one slot.
 *  2. a running execution older than the window ⇒ 未收尾 · 已失联. The judgement
 *     is DURATION ONLY. It used to also fire when the row started before the
 *     newest completion anywhere in the snapshot, on the reasoning that a
 *     blocking dispatch owns the only execution slot — and that reasoning died
 *     with the single slot. Concurrently running children routinely start before
 *     ANOTHER dispatch finishes, so the old rule reported live work as lost
 *     (measured: two running children ⇒ 概览 `active 2→0` / `lost 0→2`). The
 *     capability is NOT removed — a genuinely stale run is still called out,
 *     which is what "不伪造状态" requires — only the false trigger is.
 *  3. failed execution / retry history ⇒ 返工.
 *  4. completed execution / completed task ⇒ 已完成.
 *  5. no execution at all: 排队中 while the dispatch is fresh, otherwise
 *     未收尾 · 已失联 — the host writes an execution when a dispatch starts, so a
 *     dispatch this old never started. A dispatch held back by the in-flight
 *     limit is exactly this case while it waits, which is how 超限排队 stays
 *     visible on the panel instead of looking like a hang.
 */
function edgeState(
  taskState: TaskWorkState,
  assignment: DevFlowClientAssignment | null,
  execution: DevFlowClientExecution | null,
  retryCount: number,
  dispatchAt: string | null,
  context: StaleContext,
): { readonly state: FlowEdgeState; readonly reason: string | null } {
  // 收尾终态 FIRST: a closed record is the authoritative "this can never continue"
  // statement, so it must not be re-judged as 未收尾 · 已失联 by any staleness rule
  // below. That is exactly the change this round makes to the counts: a dispatch that
  // was actually wrapped up stops inflating the lost pile.
  const closure = closureOf(assignment, execution)
  if (closure !== null) return { state: 'closed', reason: closure.reason }
  if (execution !== null && execution.status === 'running') {
    const startedAt = Date.parse(execution.startedAt ?? '')
    const started = Number.isNaN(startedAt) ? 0 : startedAt
    if (context.now - started > DISPATCH_STALE_MS) {
      return { state: 'lost', reason: `运行记录停在 ${execution.startedAt ?? '未知时间'}，超过 30 分钟无更新` }
    }
    return { state: 'executing', reason: null }
  }
  if (execution !== null && execution.status === 'failed') return { state: 'rework', reason: null }
  if (retryCount > 0 && (taskState === 'failed' || taskState === 'working' || taskState === 'blocked')) return { state: 'rework', reason: null }
  if (taskState === 'failed') return { state: 'rework', reason: null }
  if (execution !== null && execution.status === 'completed') return { state: 'done', reason: null }
  if (taskState === 'completed') return { state: 'done', reason: null }
  if (execution !== null && execution.status === 'pending') {
    const pendingAt = Date.parse(execution.startedAt ?? dispatchAt ?? '')
    if (context.now - (Number.isNaN(pendingAt) ? 0 : pendingAt) > DISPATCH_QUEUE_MAX_MS) {
      return { state: 'lost', reason: '排队的执行记录超过 30 分钟未开工' }
    }
    return { state: 'queued', reason: null }
  }
  if (assignment !== null && assignment.status === 'completed') return { state: 'done', reason: null }
  const queuedAt = Date.parse(dispatchAt ?? '')
  if (Number.isNaN(queuedAt) || queuedAt === 0) return { state: 'queued', reason: null }
  if (context.now - queuedAt > DISPATCH_QUEUE_MAX_MS) {
    return { state: 'lost', reason: `派发于 ${dispatchAt}，此后没有任何执行记录` }
  }
  return { state: 'queued', reason: null }
}

function edgeAction(state: FlowEdgeState, taskState: TaskWorkState, assignment: DevFlowClientAssignment | null): string {
  if (state === 'rework') return '派发返工'
  if (state === 'done') return assignment?.role === 'reviewer' ? '复核通过' : '交付结果'
  // Was 「执行槽占用」 — a phrase about ONE occupied slot, which under 并发上限 5
  // reads as a contradiction on the 2nd and later live dispatch. The action now
  // names the act, not a slot count, so the badge is honest for every N.
  if (state === 'executing') return '正在执行'
  if (state === 'lost') return '未收尾'
  if (state === 'closed') return '已收尾'
  // Reachable only for an IN-FLIGHT edge (排队中 / 已暂停): every finished, failed,
  // executing, lost and closed edge has already returned above. It is NOT the
  // "waiting for the user" wording — a dispatch awaiting acceptance is `done` and
  // returns 交付结果/复核通过 two lines up — so it never contradicts 待验收.
  if (taskState === 'reviewing') return '复核返工'
  return '已接收'
}

/**
 * The authoritative closure of one dispatch, or null when it is not closed.
 *
 * Either layer can carry it, and BOTH are terminal statements about the same dispatch:
 *  * an `execution` closed as stale — the record that claimed to be running;
 *  * an `assignment` closed without ever running — the dispatch that will never start.
 * The execution wins when both are present, because it names the more specific fact.
 */
function closureOf(
  assignment: DevFlowClientAssignment | null,
  execution: DevFlowClientExecution | null,
): { readonly reason: string } | null {
  if (execution !== null && execution.status === 'closed') {
    return { reason: `已收尾 · ${closeReasonLabel(execution.closeReason)}` }
  }
  if (assignment !== null && assignment.status === 'closed') {
    return { reason: `已收尾 · ${closeReasonLabel(assignment.closeReason)}` }
  }
  return null
}

/** Fixed zh-CN wording per close reason; never a raw stored value. */
export function closeReasonLabel(reason: DevFlowClientCloseReason | undefined): string {
  if (reason === 'stale-lost') return '陈旧在飞'
  if (reason === 'superseded') return '已被后续派发取代'
  if (reason === 'abandoned') return '已放弃'
  return '原因未记录'
}

/**
 * REMOVED: `pickExecutingEdge` / `timeOf`.
 *
 * They demoted every live execution but the newest to 排队中, on design §11's
 * "exactly one execution slot" clause. The boss decision of 2026-09-21 replaced
 * that clause with 「并发上限 5 · 超限排队」, so under the new rule two children
 * running at once is the normal case and the demotion was simply false. Kept as
 * a note (not a function) so the next reader does not reintroduce it: the panel
 * must be able to show several 执行中 at once.
 */

function requirementNode(name: string, goal: string, stage: string): Omit<FlowNode, 'x' | 'y'> {
  return {
    id: FLOW_REQUIREMENT_ID,
    label: '用户需求',
    kind: 'requirement',
    roleId: 'user',
    roleLabel: '用户',
    state: 'planned',
    stateLabel: '来源：用户',
    taskId: null,
    taskTitle: name.trim() === '' ? '（未命名需求）' : name,
    taskDescription: goal.trim() === '' ? '未记录需求全文' : goal,
    taskStateLabel: stage.trim() === '' ? '未记录当前阶段' : `当前阶段：${stage}`,
    skillsLabel: '只读状态节点',
    dispatchSkillsLabel: '不适用（本节点不承载派发）',
    capabilitiesLabel: '不适用（只读）',
    delegationLabel: '委派深度 0 · 只读状态节点不参与派发',
    subagentNote: '子代理：不适用（只读状态节点）',
    delegable: false,
    deliveryCount: 0,
    delegationDepth: null,
    thought: null,
    output: null,
    executionLabel: null,
    modelLabel: '',
    designTarget: false,
    sourceLabel: '来源：用户',
  }
}

function commanderNode(agent: WorkspaceAgent | undefined, dispatchCount: number): Omit<FlowNode, 'x' | 'y'> {
  const blocked = agent?.workState === 'blocked'
  const working = !blocked && agent?.workState === 'working'
  const state: FlowNodeState = blocked ? 'blocked' : working ? 'active' : dispatchCount > 0 ? 'done' : 'planned'
  return {
    id: FLOW_COMMANDER_ID,
    label: flowAgentLabel(FLOW_COMMANDER_ID, agent?.agent.role, FLOW_COMMANDER_STATE_LABEL),
    kind: 'commander',
    roleId: agent?.agent.id ?? FLOW_COMMANDER_ID,
    roleLabel: '总指挥',
    state,
    stateLabel: NODE_STATE_LABELS[state],
    taskId: null,
    taskTitle: `已派出 ${dispatchCount} 次派发`,
    taskDescription: null,
    taskStateLabel: null,
    skillsLabel: '不适用（总指挥不写代码）',
    dispatchSkillsLabel: '不适用（总指挥不接派发）',
    capabilitiesLabel: capabilityText(agent?.agent.capabilities),
    delegationLabel: delegationText(agent?.agent.delegationDepth ?? 0),
    subagentNote: '子代理：只可由总指挥现场创建，创建后即由本面板呈现（生命周期状态尚未与面板联动）',
    delegable: true,
    deliveryCount: dispatchCount,
    delegationDepth: agent?.agent.delegationDepth ?? 0,
    thought: null,
    output: null,
    executionLabel: null,
    modelLabel: agent === undefined ? '' : modelLabel(agent.agent),
    designTarget: false,
    sourceLabel: null,
  }
}

function agentNode(
  item: WorkspaceAgent,
  current: TaskEdge | null,
  edges: readonly TaskEdge[],
): Omit<FlowNode, 'x' | 'y'> {
  const label = flowAgentLabel(item.agent.id, item.agent.role, item.agent.displayName, true)
  const state = nodeState(item, current, edges)
  return {
    id: item.agent.id,
    label,
    kind: item.agent.kind === 'temporary' ? 'temporary' : 'fixed',
    roleId: item.agent.id,
    roleLabel: label,
    state,
    stateLabel: NODE_STATE_LABELS[state],
    taskId: current?.taskId ?? null,
    taskTitle: current?.task.title ?? null,
    taskDescription: current?.task.description ?? null,
    taskStateLabel: current === null ? null : taskWorkStateLabel(current.taskState),
    skillsLabel: skillText(item.agent.skills),
    dispatchSkillsLabel: dispatchSkillText(item.agent.skills, current !== null),
    capabilitiesLabel: capabilityText(item.agent.capabilities),
    delegationLabel: delegationText(item.agent.delegationDepth),
    subagentNote: item.agent.kind === 'temporary'
      ? '子代理：本节点就是由总指挥现场创建的临时子代理'
      : '子代理：固定员工没有委派能力',
    delegable: item.agent.id !== FLOW_COMMANDER_ID && item.agent.kind === 'temporary',
    deliveryCount: item.executions.filter(execution => execution.status === 'completed').length,
    delegationDepth: item.agent.delegationDepth ?? null,
    thought: current?.thought ?? null,
    output: current?.output ?? null,
    executionLabel: current?.executionLabel ?? null,
    modelLabel: modelLabel(item.agent),
    designTarget: item.agent.kind === 'temporary',
    sourceLabel: null,
  }
}

function nodeState(item: WorkspaceAgent, current: TaskEdge | null, edges: readonly TaskEdge[]): FlowNodeState {
  if (current !== null) {
    if (current.state === 'rework') return 'rework'
    if (current.state === 'executing') return 'active'
    // 已派发但尚未开工 ⇒ 待执行。少了这一支，节点会掉进下面的 workState === 'working'
    // 兜底而显示「执行中」，而它自己的连线写着「排队中」——一张卡自相矛盾。
    if (current.state === 'queued') return 'pending'
    if (current.state === 'done') return 'done'
    if (current.state === 'lost') return 'lost'
  }
  if (edges.some(edge => edge.targetAgentId === item.agent.id && edge.state === 'executing')) return 'active'
  if (item.workState === 'blocked') return 'blocked'
  if (item.workState === 'working') return 'active'
  if (current !== null) return current.state === 'rework' ? 'rework' : current.state === 'lost' ? 'lost' : 'planned'
  if (item.workState === 'done') return 'done'
  if (item.workState === 'archived') return 'done'
  return 'idle'
}

function finalizeEdge(
  edge: TaskEdge,
  commanderLabel: string,
  agents: ReadonlyMap<string, WorkspaceAgent>,
  lanes: LaneAssignment,
  ports: ReadonlyMap<string, EdgePorts>,
  boxes: ReadonlyMap<string, LayoutBox>,
): FlowEdge {
  const target = agents.get(edge.targetAgentId)
  const targetLabel = edge.targetAgentId === ''
    ? '（未记录员工）'
    : flowAgentLabel(edge.targetAgentId, target?.agent.role, target?.agent.displayName ?? edge.targetAgentId, target !== undefined)
  // 交付 · 汇报 is the employee reporting back, so that edge is drawn INTO the
  // commander; everything else starts at the commander, the only dispatcher in
  // this architecture. A temporary sub-agent contributes the 子代理 relation.
  const { from, to, semantic } = endpointsOf(edge, target)
  const fromLabel = semantic === 'delivery' ? targetLabel : commanderLabel
  const toLabel = semantic === 'delivery' ? commanderLabel : targetLabel
  const badge = edgeBadge(edge)
  const acceptance = boundText(edge.task.description, 220)
  const laneY = lanes.laneY.get(edge.edgeId) ?? 0
  const port = ports.get(edge.edgeId) ?? { fromPort: 0, toPort: 0 }
  const geometry = routeEdge(from, to, port.fromPort, port.toPort, laneY, boxes)
  return {
    id: edge.edgeId,
    from,
    to,
    fromLabel,
    toLabel,
    state: edge.state,
    semantic,
    phaseId: edge.phaseId,
    laneY,
    fromPort: port.fromPort,
    toPort: port.toPort,
    badge,
    stale: edge.stale,
    taskId: edge.taskId,
    taskLabel: edge.task.title,
    handoff: {
      title: edge.task.title,
      taskId: edge.taskId,
      acceptance: { label: '验收标准摘要', value: acceptance.text, truncated: acceptance.truncated },
      statusLabel: `${EDGE_STATE_LABELS[edge.state]} · ${taskWorkStateLabel(edge.taskState)}${edge.staleReason === null ? '' : ` · ${edge.staleReason}`}`,
      fromLabel,
      toLabel,
      at: edge.at,
      retryCount: edge.retryCount,
      detail: edge.output === null ? null : boundText(edge.output, 220).text,
    },
    path: geometry.path,
    arrowPath: geometry.arrowPath,
    labelX: geometry.labelX,
    labelY: geometry.labelY,
  }
}

/** The 用户需求 → 总指挥 relation: one straight vertical, never a dispatch. */
function requirementRelation(
  boxes: ReadonlyMap<string, LayoutBox>,
  requirementY: number,
  commanderY: number,
): FlowEdge {
  const box = boxes.get(FLOW_REQUIREMENT_ID)
  const x = (box?.x ?? 0) + (box?.width ?? REQUIREMENT_WIDTH) / 2
  const startY = requirementY + (box?.height ?? REQUIREMENT_HEIGHT_ESTIMATE)
  const endY = commanderY
  const path = `M${round(x)} ${round(startY)} L${round(x)} ${round(endY)}`
  return {
    id: 'relation:requirement',
    from: FLOW_REQUIREMENT_ID,
    to: FLOW_COMMANDER_ID,
    fromLabel: '用户需求',
    toLabel: FLOW_COMMANDER_STATE_LABEL,
    state: 'queued',
    semantic: 'requirement',
    phaseId: null,
    laneY: (startY + endY) / 2,
    fromPort: 0,
    toPort: 0,
    badge: '需求下达',
    stale: false,
    taskId: null,
    taskLabel: '',
    handoff: {
      title: '用户需求',
      taskId: null,
      acceptance: { label: '验收标准摘要', value: '未记录', truncated: false },
      statusLabel: '需求下达 · 只读',
      fromLabel: '用户需求',
      toLabel: FLOW_COMMANDER_STATE_LABEL,
      at: null,
      retryCount: 0,
      detail: null,
    },
    path,
    arrowPath: arrowHead(x, endY, 'down'),
    labelX: x,
    labelY: (startY + endY) / 2,
  }
}

export interface LayoutBox {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface RoutedGeometry {
  readonly path: string
  readonly arrowPath: string
  readonly labelX: number
  readonly labelY: number
  readonly direction: 'down' | 'up'
}

/**
 * Route one edge as an orthogonal three-segment Z through its own lane.
 *
 * Down edges leave the source card's bottom edge, drop to the lane, run across and
 * drop into the target's top edge; up edges are the mirror image. Because every
 * edge owns a unique lane AND unique ports, two edges can never share a segment.
 */
export function routeEdge(
  from: string,
  to: string,
  fromPort: number,
  toPort: number,
  laneY: number,
  boxes: ReadonlyMap<string, LayoutBox>,
): RoutedGeometry {
  const fromBox = boxes.get(from)
  const toBox = boxes.get(to)
  if (fromBox === undefined || toBox === undefined) {
    return { path: '', arrowPath: '', labelX: 0, labelY: 0, direction: 'down' }
  }
  const down = fromBox.y + fromBox.height <= toBox.y
  const startX = fromBox.x + fromBox.width / 2 + fromPort
  const endX = toBox.x + toBox.width / 2 + toPort
  const startY = down ? fromBox.y + fromBox.height : fromBox.y
  const endY = down ? toBox.y : toBox.y + toBox.height
  // Keep the lane inside the corridor between the two cards.
  const lane = down
    ? Math.min(Math.max(laneY, startY + 4), Math.max(startY + 4, endY - 4))
    : Math.min(Math.max(laneY, endY + 4), Math.max(endY + 4, startY - 4))
  const path = orthogonalPath([
    { x: startX, y: startY },
    { x: startX, y: lane },
    { x: endX, y: lane },
    { x: endX, y: endY },
  ], 5)
  return {
    path,
    arrowPath: arrowHead(endX, endY, down ? 'down' : 'up'),
    labelX: (startX + endX) / 2,
    labelY: lane - 4,
    direction: down ? 'down' : 'up',
  }
}

/** Re-anchor edges to the measured boxes; lane and port assignments are kept. */
export function layoutEdges(
  edges: readonly FlowEdge[],
  boxes: ReadonlyMap<string, LayoutBox>,
): readonly FlowEdge[] {
  return edges.map(edge => {
    const geometry = routeEdge(edge.from, edge.to, edge.fromPort, edge.toPort, edge.laneY, boxes)
    return { ...edge, path: geometry.path, arrowPath: geometry.arrowPath, labelX: geometry.labelX, labelY: geometry.labelY }
  })
}

export interface Point { readonly x: number; readonly y: number }

/** Rounded-corner polyline; corners collapse gracefully on very short segments. */
export function orthogonalPath(points: readonly Point[], radius = 5): string {
  if (points.length === 0) return ''
  const first = points[0]
  if (first === undefined) return ''
  if (points.length === 1) return `M${round(first.x)} ${round(first.y)}`
  const parts: string[] = [`M${round(first.x)} ${round(first.y)}`]
  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1]
    const current = points[index]
    const next = points[index + 1]
    if (previous === undefined || current === undefined || next === undefined) continue
    const incoming = distance(previous, current)
    const outgoing = distance(current, next)
    const corner = Math.min(radius, incoming / 2, outgoing / 2)
    if (corner <= 0.5) {
      parts.push(`L${round(current.x)} ${round(current.y)}`)
      continue
    }
    const entry = pointTowards(current, previous, corner)
    const exit = pointTowards(current, next, corner)
    parts.push(`L${round(entry.x)} ${round(entry.y)}`)
    parts.push(`Q${round(current.x)} ${round(current.y)} ${round(exit.x)} ${round(exit.y)}`)
  }
  const last = points[points.length - 1]
  if (last !== undefined) parts.push(`L${round(last.x)} ${round(last.y)}`)
  return parts.join(' ')
}

/** Small chevron at the `to` end, pointing the way the relation actually flows. */
export function arrowHead(x: number, y: number, direction: 'down' | 'up', size = 5): string {
  const offset = direction === 'down' ? -size * 1.8 : size * 1.8
  return `M${round(x - size)} ${round(y + offset)} L${round(x)} ${round(y)} L${round(x + size)} ${round(y + offset)}`
}

function distance(left: Point, right: Point): number {
  return Math.hypot(right.x - left.x, right.y - left.y)
}

function pointTowards(from: Point, to: Point, length: number): Point {
  const total = distance(from, to)
  if (total === 0) return from
  const ratio = Math.min(1, length / total)
  return { x: from.x + (to.x - from.x) * ratio, y: from.y + (to.y - from.y) * ratio }
}

function edgeBadge(edge: TaskEdge): string {
  const relative = edge.at === null ? null : relativeTime(edge.at)
  const retry = edge.retryCount > 0 ? ` · 返工 ${edge.retryCount} 次` : ''
  const base = `${EDGE_STATE_LABELS[edge.state]} · ${edge.action}`
  return relative === null ? `${base}${retry}` : `${base} · ${relative}${retry}`
}

function isVisible(item: WorkspaceAgent): boolean {
  if (item.assignments.length > 0) return true
  if (item.executions.length > 0) return true
  if (item.taskIds.length > 0) return true
  if (item.reports.length > 0) return true
  if (item.failures.length > 0) return true
  return item.pendingDecisions.length > 0
}

function modelLabel(agent: DevFlowClientAgent): string {
  return agent.provider === undefined ? agent.model : `${agent.provider} · ${agent.model}`
}

function skillText(skills: readonly string[] | undefined): string {
  if (skills === undefined || skills.length === 0) return '暂未绑定'
  return skills.join('、')
}

/**
 * What the CURRENT dispatch actually put into the child's persona.
 *
 * The host resolves every bound Skill and aborts the dispatch when a source is missing,
 * so "this employee holds a dispatch" already proves the Skills went in — this wording
 * states the injected set, never a claim about how the model used it.
 */
function dispatchSkillText(skills: readonly string[] | undefined, hasDispatch: boolean): string {
  if (!hasDispatch) return '—（当前没有派发）'
  if (skills === undefined || skills.length === 0) return '未绑定技能（本次派发未注入）'
  return `${skills.join('、')}（本次派发已注入 ${skills.length} 项）`
}

function capabilityText(capabilities: readonly string[] | undefined): string {
  if (capabilities === undefined || capabilities.length === 0) return '未记录'
  return capabilities.join('、')
}

/** Depth-only statement; the sub-agent fact lives in {@link FlowNode.subagentNote}. */
function delegationText(depth: number | undefined): string {
  const value = depth ?? 0
  if (value <= 0) return `委派深度 ${value} · 不能再派子代理`
  return `委派深度 ${value} · 可继续派子代理`
}

function executionLabel(execution: DevFlowClientExecution | null): string | null {
  if (execution === null) return null
  const started = execution.startedAt ?? '未记录开始时间'
  const completed = execution.completedAt ?? (execution.status === 'running' ? '进行中' : '未完成')
  return `${executionStatusLabel(execution.status)} · ${started} → ${completed} · ${shortId(execution.id, 14)}`
}

function executionStatusLabel(status: DevFlowClientExecution['status']): string {
  return ({ pending: '排队中', running: '执行中', completed: '已完成', failed: '失败', closed: '已收尾' })[status]
}

function boundText(text: string, limit: number): { text: string; truncated: boolean } {
  const value = text.trim()
  if (value.length === 0) return { text: '未记录', truncated: false }
  if (value.length <= limit) return { text: value, truncated: false }
  return { text: value.slice(0, limit), truncated: true }
}

/** Compact zh-CN relative time; invalid or absent times render no suffix. */
export function relativeTime(at: string, now = Date.now()): string | null {
  const parsed = Date.parse(at)
  if (Number.isNaN(parsed)) return null
  const delta = now - parsed
  if (delta < 0) return '刚刚'
  const seconds = Math.floor(delta / 1000)
  if (seconds < 60) return `${seconds} 秒前`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  return at.slice(0, 10)
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}
