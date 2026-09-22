/**
 * Step 3B — the top-right DevFlow overview float (`shell.overlay`).
 *
 * The float is the "简版概览" the boss asked for: one glance at the current session's
 * DevFlow state without opening the right panel, and one click into the full panel.
 * It is explicitly NOT a second full panel — no audit list, no tool activity, no
 * handoff detail, no history chain, and none of the canvas' motion matrix.
 *
 * Three states, all of them reachable by keyboard:
 *   * **折叠** — a small pill in the frame's top-right corner: status dot, the
 *     headline counts, and the live-channel posture ("实时通道" / "轮询兜底").
 *   * **展开** — a docked float beside the panel: project + binding, the segmented
 *     progress bar, the commander line, one row per fixed employee, the small-print
 *     counts, and 打开完整面板.
 *   * **关闭** — the pill goes too; the way back in is the DevFlow panel's own
 *     header action (see `DevFlowCanvas`), which is why the closed flag is remembered.
 *
 * §四 (session filtering) is the round's real trap: `shell.overlay` is ROOT-scoped, so
 * this component owns the gate and {@link overviewGate} executes it deny-by-default.
 * A session change ALSO folds the float, so a value from the previous session can
 * never be on screen while the next one loads.
 *
 * §11.2 (motion): the float is still by default and distinguishes its states by
 * COLOUR. The only motion it may carry is one very weak opacity pulse on the status
 * dot while dispatches are in flight — no glass resampling, no travelling dash, no
 * animation matrix. `prefers-reduced-motion` removes even that.
 */
import type { DevFlowLiveController, DevFlowSnapshotController } from './store.ts';
import { OVERVIEW_REOPEN_EVENT, type OverviewSessionInput } from './overview.ts';
/** The session-list hook the framework binds onto a root-scoped cell. */
export type UseOverviewSessions = <T>(selector: (state: OverviewSessionInput) => T) => T;
/** Props the cell receives: the standard `useSessions` plus the plugin's own face. */
export interface DevFlowOverviewProps {
    readonly useSessions: UseOverviewSessions;
    /** The per-session controller the panel uses; the float reads the SAME instance. */
    readonly controllerFor: (sessionId: string) => DevFlowSnapshotController;
    readonly liveFor: (sessionId: string) => DevFlowLiveController | undefined;
    /** Open the full panel (expand the right column and focus its DevFlow tab). */
    readonly openPanel: () => void;
}
/** The window event the panel's header action dispatches to bring the float back. */
export { OVERVIEW_REOPEN_EVENT };
/** The float's cell body. */
export declare function DevFlowOverview(props: DevFlowOverviewProps): import("react").JSX.Element | null;
