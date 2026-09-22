/**
 * §一·前.2 — the shared pause must be visible ON THE CANVAS.
 *
 * Boss verified a task is paused while the canvas still said 「返工中」. The pause flag
 * is not new: the identity line already reads `snapshot.paused` ("派发已暂停"). The
 * bug was that only that line consumed it, so every card and every edge kept claiming
 * live work.
 *
 * The iron rule of the motion round settles the rest: **moving = happening, still =
 * finished**. A paused dispatch is not happening, so its motion must stop — the edge's
 * highlight layer stops travelling and the card's running border stops animating —
 * and then come back exactly as it was when the pause is lifted.
 *
 * This module is pure: it rewrites the PRESENTATION of one projected model (state
 * names, labels, status text) and reports which states were frozen, so the canvas can
 * assert both without a browser. It never invents a state the data does not support:
 * only states that claim "happening right now" are rewritten, and every finished or
 * lost dispatch keeps its own, still-correct label.
 */

import type { FlowEdgeState, FlowModel, FlowNodeState } from './flow-projection.ts'

/** The label a paused in-flight dispatch and card carry. */
export const PAUSED_LABEL = '已暂停'

/**
 * Edge states that CLAIM activity: only these may be rewritten by a pause.
 * `done` and `lost` are finished postures and keep their honest labels.
 */
const IN_FLIGHT_EDGE: ReadonlySet<FlowEdgeState> = new Set<FlowEdgeState>(['executing', 'rework', 'queued'])
/**
 * Node states that claim activity. `blocked`/`done`/`lost`/`idle` are already still.
 *
 * `planned` is in the set because an employee node reads `planned` when it holds a
 * dispatch that has not started, and "waiting for a dispatch that is paused" is not
 * 「待派发」 any more. The two nodes that never hold a dispatch are excluded below.
 */
const IN_FLIGHT_NODE: ReadonlySet<FlowNodeState> = new Set<FlowNodeState>(['active', 'rework', 'planned'])

/**
 * Apply the session's pause posture to one flow model.
 *
 * @param model - the projected model.
 * @param paused - `snapshot.paused`, the same field the identity line reads.
 * @returns the model unchanged when not paused, else the paused presentation.
 */
export function applyPausePresentation(model: FlowModel, paused: boolean): FlowModel {
  if (!paused) return model
  const edges = model.edges.map(edge => {
    if (!IN_FLIGHT_EDGE.has(edge.state)) return edge
    return {
      ...edge,
      state: 'paused' as const,
      badge: pausedBadge(edge.badge),
      handoff: { ...edge.handoff, statusLabel: `${PAUSED_LABEL}（共享派发已暂停）` },
    }
  })
  const nodes = model.nodes.map(node => (isPausableNode(node) ? { ...node, state: 'paused' as const, stateLabel: PAUSED_LABEL } : node))
  const byId = new Map(edges.map(edge => [edge.id, edge]))
  return {
    ...model,
    edges,
    nodes,
    current: { ...model.current, edges: model.current.edges.map(edge => byId.get(edge.id) ?? edge) },
  }
}

/**
 * Whether a pause may restate this node.
 *
 * Two nodes are never "paused": the 用户需求 node (a read-only source node that carries
 * no dispatch at all — its label is 「来源：用户」, not a work state) and the commander
 * while it only reads `planned` (a commander with nothing running is idle, not frozen).
 * A commander that WAS running or reworking is genuinely frozen by the pause.
 */
function isPausableNode(node: FlowModel['nodes'][number]): boolean {
  if (node.kind === 'requirement') return false
  if (node.kind === 'commander' && node.state === 'planned') return false
  return IN_FLIGHT_NODE.has(node.state)
}

/**
 * Replace only the state WORD of a dispatch badge. The badge is
 * `状态 · 动作 · 相对时间 · 返工 N 次` (see `edgeBadge`), so the first segment is
 * swapped in place and everything the record actually knows is preserved — the
 * pause changes what the line claims, not what the record says.
 */
function pausedBadge(badge: string): string {
  const separator = badge.indexOf(' · ')
  if (separator === -1) return `${PAUSED_LABEL} · ${badge}`
  return `${PAUSED_LABEL}${badge.slice(separator)}`
}
