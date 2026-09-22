/**
 * Step 3B — the top-right overview float's read model, and its session gate.
 *
 * Two responsibilities, both pure so they can be asserted without a browser:
 *
 *  1. {@link overviewGate} — the round's hard requirement, executed as **deny by
 *     default**: `shell.overlay` is ROOT-scoped, so the host does not filter it by
 *     session and this module must. The float exists only while the current session's
 *     `agentPreset` is exactly `devflow`; every other case — standard mode, another
 *     preset, a session with no recorded preset, and the instant before the preset is
 *     resolved — renders nothing at all. No placeholder, no empty strip: absence is
 *     the correct semantics for "this session is not a DevFlow session".
 *
 *  2. {@link buildOverview} — the numbers and rows the float shows. It reads the SAME
 *     `FlowModel` the canvas renders, so the float and the right panel can never
 *     disagree: the counts are a `group by` over the very edges the canvas draws.
 */
import { type FlowModel, type FlowNodeState } from './flow-projection.ts';
import { type DevFlowConnectionPhase, type DevFlowConnectionState } from './store.ts';
import { type WorkspaceModel } from './workspace.ts';
/** The one preset that owns this float. */
export declare const DEVFLOW_PRESET = "devflow";
/** The float's own identity in `shell.overlay`, and its localStorage namespace. */
export declare const OVERVIEW_CELL_ID = "devflow-overview";
/**
 * The window event the panel's header action dispatches to bring a CLOSED float back.
 *
 * It lives here, in the pure module both sides already import, so the panel does not
 * have to reach into the float's component module (which would make the two import
 * each other).
 */
export declare const OVERVIEW_REOPEN_EVENT = "devflow:overview-reopen";
/**
 * Storage keys: folding, the explicit close, and the skin the float renders in.
 *
 * The fold and the close are remembered **per session** (see
 * {@link overviewClosedKey} / {@link overviewExpandedKey}). They are UI
 * preferences ABOUT ONE SESSION's float, and a single global flag made one
 * accidental click hide the overview in every DevFlow session — including
 * projects the operator never touched — with no way back except hunting for the
 * panel's reopen action. The `*_KEY` constants below are the LEGACY global keys:
 * they are only read to be discarded (see `legacyFlagCleanup`).
 */
export declare const OVERVIEW_EXPANDED_KEY = "devflow.overview.expanded";
export declare const OVERVIEW_CLOSED_KEY = "devflow.overview.closed";
/**
 * The per-session close key.
 *
 * Scoped by session id so "I don't need the overview here" stays a decision about
 * THAT session. An id-less call falls back to the legacy global key, which keeps
 * the read total instead of throwing on an unexpected state.
 * @param sessionId - the session the float belongs to.
 * @returns the storage key for that session's close flag.
 */
export declare function overviewClosedKey(sessionId: string | null | undefined): string;
/**
 * The per-session fold key; same scoping rule as {@link overviewClosedKey}.
 * @param sessionId - the session the float belongs to.
 * @returns the storage key for that session's fold flag.
 */
export declare function overviewExpandedKey(sessionId: string | null | undefined): string;
/**
 * Remove the legacy GLOBAL flags once, so they cannot keep hiding the float.
 *
 * A global `closed` written by an older build would otherwise hide the float
 * forever: the per-session key it is read from now would never match, and the
 * stale flag would sit there resurrecting the bug for anyone whose session id
 * ever collided with it.
 * @param storage - the storage to clean, or null when unavailable.
 */
export declare function legacyFlagCleanup(storage: {
    removeItem(key: string): void;
} | null): void;
/** One shared skin key with the canvas, so the two surfaces always agree. */
export declare const OVERVIEW_SKIN_KEY = "devflow.overview.skin";
export declare const DEVFLOW_SKIN_KEY = "devflow.flow.skin";
/** What one gate decision says. */
export interface OverviewGate {
    /** True only when the float may render at all. */
    readonly allowed: boolean;
    /** The session the float would read, or null while there is none. */
    readonly sessionId: string | null;
    /** The preset that was actually read, for the DOM evidence. */
    readonly preset: string | null;
    /** Why it was refused, in the fixed vocabulary the report quotes. */
    readonly reason: 'allowed' | 'no-session' | 'preset-unresolved' | 'other-preset';
}
/** The minimum of the session list state this module needs (keeps it test-pure). */
export interface OverviewSessionInput {
    readonly current: string | undefined;
    readonly byId: Readonly<Record<string, {
        readonly projectionValues?: Readonly<Partial<Record<string, unknown>>>;
    } | undefined>>;
}
/**
 * Decide whether the float may exist for the current session.
 *
 * @param sessions - the client session list state.
 * @returns the gate decision; `allowed` is true for exactly one case.
 */
export declare function overviewGate(sessions: OverviewSessionInput | undefined | null): OverviewGate;
/** The buckets of the segmented progress bar, in display order. */
export interface OverviewCounts {
    /** Edge states that are happening right now (执行中). */
    readonly active: number;
    /** Dispatches finished but whose task is still 复核中 — the 待验收 bucket. */
    readonly review: number;
    /** Finished dispatches (已完成). */
    readonly done: number;
    /** 未收尾 · 已失联 — stale in-flight records that have NOT been closed. */
    readonly lost: number;
    /** Frozen by the shared pause (§一·前.2). */
    readonly paused: number;
    /** 已收尾 (第四步): the terminal "this can never continue" statement. */
    readonly closed: number;
    /** Dispatches with no canvas node to land on (未落点). */
    readonly unrouted: number;
    /** Dispatch edges the default view hides (已隐藏). */
    readonly hidden: number;
}
/** One employee's row: the node the canvas draws, plus the dispatch it holds. */
export interface OverviewMember {
    readonly id: string;
    readonly name: string;
    /** Which roster the row belongs to — the float groups them by this. */
    readonly kind: 'fixed' | 'temporary';
    readonly state: FlowNodeState;
    readonly stateLabel: string;
    /** The dispatch this employee currently holds, or null. */
    readonly taskTitle: string | null;
}
/** The whole float, as one value. */
export interface OverviewView {
    readonly projectName: string;
    /** 已绑定 / 未绑定, from the snapshot's own commander posture. */
    readonly bindingLabel: string;
    readonly paused: boolean;
    readonly counts: OverviewCounts;
    readonly total: number;
    /** The one-line summary the collapsed pill shows. */
    readonly summary: string;
    /** 进行中 / 待验收 / 全部完成 — the pill's status dot. */
    readonly posture: 'active' | 'review' | 'done';
    readonly postureLabel: string;
    readonly commanderName: string;
    readonly commanderStateLabel: string;
    readonly dispatchCount: number;
    readonly members: readonly OverviewMember[];
    readonly connectionLabel: string;
    readonly connectionPhase: DevFlowConnectionPhase;
}
/** Chinese wording for the live-channel posture; never a raw transport string. */
export declare function connectionLabel(connection: DevFlowConnectionState | null): string;
/** The reason line under a polling badge, or null while the channel is healthy. */
export declare function connectionDetail(connection: DevFlowConnectionState | null): string | null;
/** How many dispatch edges the default (current) view hides behind 全部历史. */
export declare function hiddenDispatchCount(flow: FlowModel): number;
/**
 * Build the float's read model from the same inputs the canvas uses.
 *
 * @param model - the workspace model folded from the snapshot.
 * @param now - the clock the stale judgement uses (the canvas passes the same one).
 * @param connection - the live-channel posture, or null when unavailable.
 * @returns the overview view model.
 */
export declare function buildOverview(model: WorkspaceModel, now?: number, connection?: DevFlowConnectionState | null): OverviewView;
