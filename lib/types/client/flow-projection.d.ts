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
import type { DevFlowClientCloseReason, DevFlowClientPhase } from '../contract.ts';
import { type WorkspaceModel } from './workspace.ts';
/**
 * Visual state of canvas nodes.
 *
 * `lost` is the honest fifth state: a dispatch that claims to be in flight but has
 * no running execution behind it any more. See {@link edgeState} for the rules.
 */
export type FlowNodeState = 'idle' | 'active' | 'blocked' | 'done' | 'rework' | 'planned' | 'lost' | 'paused' | 'closed';
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
export type FlowEdgeState = 'queued' | 'executing' | 'done' | 'rework' | 'lost' | 'paused' | 'closed';
/** What kind of relation one edge draws. Line style and arrow direction carry it. */
export type FlowEdgeSemantic = 'requirement' | 'dispatch' | 'delivery' | 'rework' | 'subagent';
/** Canvas node kinds. `requirement` is the read-only 用户需求 origin node. */
export type FlowNodeKind = 'requirement' | 'commander' | 'fixed' | 'temporary';
/**
 * How long a running execution may claim to be in flight without a newer write.
 * 30 minutes is far beyond one dispatch round in this project (observed rounds
 * are seconds to minutes) while still covering a slow build or a long audit, so a
 * record past it is history rather than work in flight. This is the ONLY input to
 * the 未收尾 · 已失联 judgement — see {@link edgeState}.
 */
export declare const DISPATCH_STALE_MS: number;
/**
 * How long an `assigned` record with no execution at all may still read
 * 「排队中」. The same window: the host writes an execution as the dispatch
 * starts, so a dispatch with no execution after this long never started.
 *
 * It covers BOTH real queueing causes: the window between the task turning
 * `executing` and its execution record being written, and a dispatch the host
 * held back because the in-flight limit was already reached.
 */
export declare const DISPATCH_QUEUE_MAX_MS: number;
export declare const FLOW_COMMANDER_ID = "commander";
export declare const FLOW_REQUIREMENT_ID = "requirement";
export declare const FLOW_NODE_WIDTH = 172;
export declare const FLOW_COMMANDER_STATE_LABEL = "\u603B\u6307\u6325";
export interface FlowHandoffField {
    readonly label: string;
    readonly value: string;
    readonly truncated: boolean;
}
/** Everything the handoff inspector shows after a user clicks one edge. */
export interface FlowHandoff {
    readonly title: string;
    readonly taskId: string | null;
    readonly acceptance: FlowHandoffField;
    readonly statusLabel: string;
    readonly fromLabel: string;
    readonly toLabel: string;
    readonly at: string | null;
    readonly retryCount: number;
    readonly detail: string | null;
}
export interface FlowNode {
    readonly id: string;
    readonly label: string;
    readonly kind: FlowNodeKind;
    readonly roleId: string;
    readonly roleLabel: string;
    readonly state: FlowNodeState;
    readonly stateLabel: string;
    readonly taskId: string | null;
    readonly taskTitle: string | null;
    readonly taskDescription: string | null;
    readonly taskStateLabel: string | null;
    readonly skillsLabel: string;
    readonly capabilitiesLabel: string;
    readonly delegationLabel: string;
    /**
     * The sub-agent note as its OWN field. Joining it into {@link delegationLabel}
     * produced a mixed, contradictory line ("不能再派子代理（总指挥现场创建…）"),
     * so the two facts are rendered on separate rows by the canvas and the inspector.
     */
    readonly subagentNote: string;
    readonly delegable: boolean;
    readonly deliveryCount: number;
    readonly delegationDepth: number | null;
    readonly thought: string | null;
    readonly output: string | null;
    readonly executionLabel: string | null;
    readonly modelLabel: string;
    readonly designTarget: boolean;
    /** Read-only source note for the 用户需求 node; null for every other node. */
    readonly sourceLabel: string | null;
    readonly x: number;
    readonly y: number;
}
export interface FlowEdge {
    readonly id: string;
    readonly from: string;
    readonly to: string;
    readonly fromLabel: string;
    readonly toLabel: string;
    readonly state: FlowEdgeState;
    /** What relation this edge draws; drives its line style and arrow direction. */
    readonly semantic: FlowEdgeSemantic;
    /** The phase this dispatch is associated with, or null when unrecorded. */
    readonly phaseId: string | null;
    /** Corridor lane this edge owns; unique per drawn edge, so edges never overlap. */
    readonly laneY: number;
    /** Port offset from the source card's centre, in world units. */
    readonly fromPort: number;
    /** Port offset from the target card's centre, in world units. */
    readonly toPort: number;
    readonly badge: string;
    /** Set when the record is stale rather than live; shown in the handoff inspector. */
    readonly stale: boolean;
    readonly taskId: string | null;
    readonly taskLabel: string;
    readonly handoff: FlowHandoff;
    readonly path: string;
    readonly arrowPath: string;
    readonly labelX: number;
    readonly labelY: number;
}
/** One task of a phase, as the 阶段关联 block of the inspector lists it. */
export interface FlowBandTask {
    readonly id: string;
    readonly title: string;
    readonly stateLabel: string;
}
/**
 * One 阶段关联: the internal grouping of dispatches by phase.
 *
 * Correction R2: this is NEVER drawn on the canvas any more — no box, no name, no
 * count badge, no rail. It stays the basis for layer order, corridor grouping and
 * lane pitch, and it is what the inspector's 阶段关联 list renders.
 */
export interface FlowBand {
    readonly id: string;
    /** Sequence label, e.g. 阶段关联 2. */
    readonly label: string;
    readonly name: string;
    readonly status: FlowPhaseStatus;
    readonly statusLabel: string;
    readonly taskCount: number;
    readonly dispatchCount: number;
    /** The phase's tasks, for the inspector's 阶段关联 block. */
    readonly tasks: readonly FlowBandTask[];
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}
export type FlowPhaseStatus = DevFlowClientPhase['status'];
/** Which dispatch edges the canvas draws. */
export type FlowEdgeScope = 'current' | 'history';
export interface FlowEdgeRoute {
    readonly edges: readonly FlowEdge[];
    /** Dispatches this scope does not draw because the employee has no canvas node. */
    readonly unroutedCount: number;
}
export interface FlowModel {
    readonly commanderId: string;
    readonly requirementId: string;
    readonly nodes: readonly FlowNode[];
    readonly visibleAgentIds: readonly string[];
    /** The scope this model's geometry was computed for. */
    readonly scope: FlowEdgeScope;
    /** Drawn dispatches of {@link scope}, with lanes, ports and paths attached. */
    readonly edges: readonly FlowEdge[];
    /** 用户需求 → 总指挥 relation; not a dispatch, so it is never counted as one. */
    readonly requirementEdge: FlowEdge | null;
    /** 阶段关联带 of the drawn scope, in absolute world coordinates. */
    readonly bands: readonly FlowBand[];
    readonly canvasWidth: number;
    readonly canvasHeight: number;
    /**
     * How many dispatches in this snapshot are genuinely in flight, and the limit
     * they are measured against. `running` is COUNTED from the edges — every
     * `executing` edge, in every scope — never estimated, so the toolbar's
     * `并发 N/5` can only ever restate a record the snapshot really carries.
     */
    readonly concurrency: FlowConcurrency;
    /** Default view: one edge per employee, for the dispatch that is still current. */
    readonly current: FlowEdgeRoute;
    /** Opt-in view: every dispatch the snapshot still records. */
    readonly history: FlowEdgeRoute;
    /** Count of dispatches the canvas reads as 未收尾 · 已失联, for the honest footer. */
    readonly lostCount: number;
    /** Dispatches with no canvas node to land on; counted, never drawn as a dangling line. */
    readonly unroutedCount: number;
    /** The newest completion in the snapshot, kept as a display boundary only; it no longer decides `lost`. */
    readonly staleBoundary: string | null;
    /** Epoch ms the projection judged staleness against. */
    readonly judgedAt: number;
}
/** In-flight dispatch count plus the limit it is measured against. */
export interface FlowConcurrency {
    /** Dispatches whose execution record says `running`, counted from the snapshot. */
    readonly running: number;
    /** The configured ceiling; the panel shows `并发 running/limit`. */
    readonly limit: number;
    /** True when the ceiling is reached and any further dispatch waits in line. */
    readonly atLimit: boolean;
}
/** Vertical pitch between two dispatch lanes; far wider than any stroke. */
export declare const LANE_PITCH = 13;
/** Stable zh-CN copy for the relation kinds drawn on the canvas. */
export declare const FLOW_SEMANTIC_LABELS: Readonly<Record<FlowEdgeSemantic, string>>;
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
export declare function flowAgentLabel(agentId: string, role: string | undefined, fallback: string, namedByItself?: boolean): string;
export declare function flowNodeStateLabel(state: FlowNodeState): string;
export declare function flowEdgeStateLabel(state: FlowEdgeState): string;
export declare function flowSemanticLabel(semantic: FlowEdgeSemantic): string;
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
export declare function createFlowModel(model: WorkspaceModel, now?: number, nodeHeights?: Readonly<Record<string, number>>, scope?: FlowEdgeScope): FlowModel;
export interface RouteShape {
    readonly sourceX: number;
    readonly targetX: number;
    readonly lane: number;
    /** True when the source card is above the corridor; false for 交付 · 汇报. */
    readonly sourceAbove: boolean;
}
/**
 * Count proper crossings of a set of orthogonal Z routes that all share one
 * source column. A crossing is an interior intersection between one route's
 * horizontal lane run and another route's vertical run; meeting at the shared
 * source is not a crossing.
 */
export declare function countCrossings(shapes: readonly RouteShape[]): number;
/** Fixed zh-CN wording per close reason; never a raw stored value. */
export declare function closeReasonLabel(reason: DevFlowClientCloseReason | undefined): string;
export interface LayoutBox {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}
export interface RoutedGeometry {
    readonly path: string;
    readonly arrowPath: string;
    readonly labelX: number;
    readonly labelY: number;
    readonly direction: 'down' | 'up';
}
/**
 * Route one edge as an orthogonal three-segment Z through its own lane.
 *
 * Down edges leave the source card's bottom edge, drop to the lane, run across and
 * drop into the target's top edge; up edges are the mirror image. Because every
 * edge owns a unique lane AND unique ports, two edges can never share a segment.
 */
export declare function routeEdge(from: string, to: string, fromPort: number, toPort: number, laneY: number, boxes: ReadonlyMap<string, LayoutBox>): RoutedGeometry;
/** Re-anchor edges to the measured boxes; lane and port assignments are kept. */
export declare function layoutEdges(edges: readonly FlowEdge[], boxes: ReadonlyMap<string, LayoutBox>): readonly FlowEdge[];
export interface Point {
    readonly x: number;
    readonly y: number;
}
/** Rounded-corner polyline; corners collapse gracefully on very short segments. */
export declare function orthogonalPath(points: readonly Point[], radius?: number): string;
/** Small chevron at the `to` end, pointing the way the relation actually flows. */
export declare function arrowHead(x: number, y: number, direction: 'down' | 'up', size?: number): string;
/** Compact zh-CN relative time; invalid or absent times render no suffix. */
export declare function relativeTime(at: string, now?: number): string | null;
