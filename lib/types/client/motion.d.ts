/**
 * Motion rules for the dispatch-flow canvas (step 3C).
 *
 * The iron rule of the round: **moving = happening; still = finished.** A finished
 * dispatch must never keep flowing, so a completed edge is allowed exactly ONE
 * short "pass-through" sweep at the moment it becomes completed, and is static
 * afterwards. Everything below is pure so the rule can be asserted without a
 * browser; the animation itself is CSS/SVG only (no scripted frame loop).
 */
import type { FlowEdgeState } from './flow-projection.ts';
/**
 * Line speed in px per second, i.e. how fast the dash pattern travels along an
 * edge. The round brief fixes the band: 执行中 ≈ 45–60 px/s, 返工 ≈ 1.3–1.5×,
 * 排队 ≈ 0.4–0.6×, 已完成 = one sweep, 未收尾 = static.
 */
export declare const FLOW_LINE_SPEED_BASE = 52;
/** Dash pattern period, in px, shared by every flowing edge so speed is uniform. */
export declare const FLOW_DASH_PERIOD = 96;
/** One-shot sweep played when a dispatch becomes 已完成 (≤1.2s per the brief). */
export declare const FLOW_DONE_SWEEP_MS = 1100;
/**
 * §一·前.1 (reading round): the moving highlight must read as MOVEMENT at a glance,
 * which the 3C numbers did not achieve — 12px of light travelling through a 96px
 * period is a speck, not a current. The head is therefore 32px (a third of the
 * period, so the bright segment stays separated from its own tail) while the period
 * and the speed formula (`speed = period / duration`) are untouched, so every
 * measured px/s from 3C still holds.
 */
export declare const FLOW_DASH_HEAD = 32;
/** Dash offset of one period used by the animation and asserted as the period. */
export declare const FLOW_DASH_TAIL: number;
/**
 * Bright highlight colour per rate, by SKIN. Each is a higher-luminance member of
 * the same hue family as the rate's semantic stroke, so the state still reads from
 * the colour while the moving head is unmistakable. Measured in the browser on both
 * skins (see the round report): the light skin needs a deeper cyan than the dark one.
 */
export declare const FLOW_GLOW_LIGHT = "#3fbfe0";
export declare const FLOW_GLOW_GOLD = "#7fd4ea";
/** Rework head: the same lift applied to the red family, per skin. */
export declare const FLOW_GLOW_REWORK_LIGHT = "#e8655f";
export declare const FLOW_GLOW_REWORK_GOLD = "#ff8a86";
/** Stroke width of the moving highlight, in SVG user units (was 2.6). */
export declare const FLOW_FLOW_WIDTH = 3.4;
/** Queue's highlight stays deliberately weaker than 执行中's (the 3C layering rule). */
export declare const FLOW_FLOW_WIDTH_WEAK = 3;
export declare const FLOW_FLOW_OPACITY_WEAK = 0.55;
export interface FlowMotionProfile {
    /** True when the edge's dashes travel at all. */
    readonly flowing: boolean;
    /** Multiplier over {@link FLOW_LINE_SPEED_BASE}; 0 when static. */
    readonly multiplier: number;
    /** Travel speed in px/s (0 when static). */
    readonly speed: number;
    /** Animation duration for one dash period, in seconds (0 when static). */
    readonly durationSeconds: number;
    /**
     * Opacity of the WHOLE edge (the moving dashes and the line under them); the
     * queued state is deliberately fainter so "waiting" reads weaker than "running".
     */
    readonly opacity: number;
    /** True when the dispatch is frozen by the shared pause, not by being finished. */
    readonly paused?: boolean;
}
/**
 * The motion profile of one dispatch state.
 *
 * `lost` is static on purpose: a dispatch nobody wrapped up is not "happening",
 * so animating it would claim activity that does not exist.
 *
 * @param state - the dispatch's projected state.
 * @param paused - the snapshot's shared-dispatch pause flag; when set, a state that
 *   would otherwise move returns {@link PAUSED} instead.
 */
export declare function motionProfile(state: FlowEdgeState, paused?: boolean): FlowMotionProfile;
/**
 * The profile's rate as a CSS-facing token, so the overlay's colour/width is chosen
 * from the MEASURED profile instead of re-deriving it from the dispatch state in the
 * stylesheet (one source of truth for "how fast is this thing moving").
 */
export type FlowMotionRate = 'still' | 'base' | 'strong' | 'weak' | 'paused';
export declare function motionRate(profile: FlowMotionProfile): FlowMotionRate;
/**
 * Which edges have JUST become 已完成, and may therefore play the single sweep.
 *
 * An edge that is already completed when it first appears never sweeps: it did not
 * "just" finish, it finished before this view existed. The previous-state map is
 * owned by the caller and is updated in place.
 */
export declare function freshlyDoneEdges(previous: Map<string, FlowEdgeState>, edges: readonly {
    readonly id: string;
    readonly state: FlowEdgeState;
}[]): readonly string[];
/**
 * How long a newly generated card's one-shot entrance runs.
 *
 * Short and low-amplitude on purpose: the entrance marks "this node appears NOW",
 * and a long or large one would read as the canvas rearranging itself, which the
 * round explicitly forbids (no other node may move).
 */
export declare const FLOW_ENTER_MS = 420;
/**
 * The edge ids whose state ACTUALLY changed in this render, i.e. the edges a real
 * committed event moved.
 *
 * This is the "real drive" primitive: the canvas re-arms an edge's flowing layer
 * only when its projected state differs from the previous render, so the phase of
 * every animation is anchored to an event that really happened rather than to a
 * timer. An idle canvas therefore produces NO re-arm at all, and a frame that
 * arrives without a state change is visibly inert.
 *
 * An edge seen for the FIRST time is not "changed": it did not move, it appeared.
 * That mirrors {@link freshlyDoneEdges}'s rule and is what keeps a refresh, a
 * session switch, or a skin swap from animating the whole canvas at once.
 * @param previous - previous edge states, owned by the caller (mutated in place).
 * @param edges - the current edge states.
 * @returns the ids whose state changed, in edge order.
 */
export declare function changedEdges(previous: Map<string, FlowEdgeState>, edges: readonly {
    readonly id: string;
    readonly state: FlowEdgeState;
}[]): readonly string[];
/**
 * 入场历史的**起点**：首帧一律从"一个节点都没见过"开始。
 *
 * 这是 boss 2026-09-18 裁决的**产品口径 A（首帧也入场）**：首帧 ⇒ **打开画布 / 刷新时
 * 当帧的全部节点各走一次 {@link FLOW_ENTER_MS}**；**切换会话**后本视图**没见过的 id**
 * 同样入场（新会话的节点集合与旧的完全相同时，则一个也不入场）。
 * 早先这里用 `null` 表示"还没有历史"，让首帧与刷新一起**不播**入场；
 * 那个抑制已被裁决推翻，理由不是"更真实"而是产品：**新面板不该突然出现一批静止的卡片**。
 * **切换皮肤不在入场范围里**：它不改变节点集合（只换 `skin` state 与 `data-skin`/CSS 变量），
 * 而 `FlowCanvas` 里入场 effect 的依赖是 `nodes` ⇒ 不重跑、不产生新的入场标记。
 * 需要抑制时改这里，不要改 {@link newlyEnteredNodes} 的语义。
 */
export declare const FLOW_ENTER_HISTORY_START: ReadonlySet<string>;
/**
 * The node ids that are genuinely NEW in this view, and may play the entrance.
 *
 * "New" means present now and absent from the previous render. A node set with NO
 * history at all does NOT mean "nothing enters" any more: it means every node enters
 * once — see {@link FLOW_ENTER_HISTORY_START} for the product decision behind that.
 * Only node ids already present in `previousIds` are skipped, so the very first paint and
 * a refresh animate the whole set, while a later render animates exactly the ids it had not
 * seen before (that is what a session switch contributes: the new session's new node ids).
 * A skin swap changes no node set at all — it only swaps `data-skin`/CSS variables — so it
 * never reaches this function with a new id set, and a re-render of the same set animates
 * nothing (an idle canvas still never self-drives).
 * @param previousIds - node ids of the previous render; an empty set is the first frame.
 * @param nodes - the current nodes.
 * @returns the ids to animate, in node order.
 */
export declare function newlyEnteredNodes(previousIds: ReadonlySet<string>, nodes: readonly {
    readonly id: string;
}[]): readonly string[];
/**
 * The next id set for {@link newlyEnteredNodes}'s history.
 * @param nodes - the current nodes.
 * @returns the id set to hand back on the following render.
 */
export declare function nodeIdSet(nodes: readonly {
    readonly id: string;
}[]): ReadonlySet<string>;
