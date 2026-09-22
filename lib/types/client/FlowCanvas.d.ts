/**
 * Canvas body of the right column's third tab ("派发流").
 *
 * Interaction model (design §2/§11, correction round):
 *   * pan, wheel + button zoom, fit, node drag, edge inspection;
 *   * cards carry a SUMMARY only — the full node record lives in the canvas'
 *     right-hand inspector, so clicking a card never changes its height and never
 *     squeezes the routing;
 *   * one inspector serves all three selections: a node, a dispatch edge
 *     (交接详情) and a 阶段关联带 (阶段关联);
 *   * the inspector is docked beside the canvas when the pane is wide enough and
 *     becomes an overlay drawer at the narrow end, so the canvas is never crushed.
 *
 * Layout and view stay decoupled from data:
 *   * a data refresh only re-projects the model and re-draws the edges;
 *   * node positions the user moved are "user placed" and a refresh never re-lays
 *     them out — only the explicit 重置布局 action returns to auto layout;
 *   * the viewport transform is recomputed only by 适配视图, a real resize of the
 *     canvas box, a scope switch, or the first fit after the cards were measured —
 *     never by a text-only refresh;
 *   * once the operator pans, zooms or drags, automatic fitting stops.
 */
import { type DevFlowConnectionState, type DevFlowClientLoadState, type DevFlowInspectorTab } from './store.ts';
import { type FlowBand, type FlowEdge, type FlowModel, type FlowNode } from './flow-projection.ts';
import { type WorkspaceModel } from './workspace.ts';
interface FlowCanvasProps {
    readonly model: WorkspaceModel;
    readonly phase: DevFlowClientLoadState['phase'];
    readonly tab: DevFlowInspectorTab;
    readonly onTabChange: (tab: DevFlowInspectorTab) => void;
    readonly auditPanel: React.ReactNode;
    readonly toolsPanel: React.ReactNode;
    /** Clock used for the stale-dispatch judgement; injectable for tests. */
    readonly now?: number;
    /**
     * Posture of the session's live event channel, read by the panel's owner and
     * passed down as plain data (the canvas never subscribes itself). `null` means
     * the channel is not part of this client build.
     */
    readonly connection?: DevFlowConnectionState | null;
    /**
     * Session-level notice (e.g. the shared project changed). It is rendered in the
     * canvas' own notice line — never as a bar across the drawing area.
     */
    readonly notice?: string | null;
    /**
     * §二·3: reopen the top-right overview float from the panel's own header. The
     * panel is the documented way back in after the float was explicitly closed.
     */
    readonly onReopenOverview?: () => void;
}
/** One task picked in the 阶段关联 list, or a whole phase, highlighted on the canvas. */
type FlowHighlight = {
    readonly kind: 'task';
    readonly id: string;
} | {
    readonly kind: 'phase';
    readonly id: string;
} | null;
/** Render the dispatch-flow canvas plus its overlays, inspector and the secondary views. */
export declare function FlowCanvas(props: FlowCanvasProps): import("react").JSX.Element;
/**
 * The canvas' right-hand inspector: one panel for node detail, dispatch handoff
 * detail and 阶段关联 — exactly one of them at a time.
 *
 * Correction R2 moved EVERY phase visual here: the canvas no longer draws a box,
 * a name, a count badge or a rail for 阶段关联, so this list is the only place
 * phase association is shown.
 *
 * Exported so the panel's content can be rendered and asserted directly, without
 * driving the canvas' pointer interactions.
 */
export declare function FlowInspector(props: {
    readonly mode: 'dock' | 'drawer';
    readonly flow: FlowModel;
    readonly edges: readonly FlowEdge[];
    readonly node: FlowNode | null;
    readonly edge: FlowEdge | null;
    readonly band: FlowBand | null;
    readonly highlight: FlowHighlight;
    readonly onClose: () => void;
    readonly onSelectNode: (nodeId: string) => void;
    readonly onSelectEdge: (edgeId: string) => void;
    readonly onSelectBand: (bandId: string) => void;
    readonly onHighlightTask: (taskId: string) => void;
}): import("react").JSX.Element;
export {};
