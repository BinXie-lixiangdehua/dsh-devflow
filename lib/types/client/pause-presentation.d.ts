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
import type { FlowModel } from './flow-projection.ts';
/** The label a paused in-flight dispatch and card carry. */
export declare const PAUSED_LABEL = "\u5DF2\u6682\u505C";
/**
 * Apply the session's pause posture to one flow model.
 *
 * @param model - the projected model.
 * @param paused - `snapshot.paused`, the same field the identity line reads.
 * @returns the model unchanged when not paused, else the paused presentation.
 */
export declare function applyPausePresentation(model: FlowModel, paused: boolean): FlowModel;
