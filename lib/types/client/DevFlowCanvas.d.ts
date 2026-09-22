import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { DevFlowClientAuditFilter } from '../contract.ts';
import type { DevFlowClientAuditLoadState, DevFlowInspectorTab, DevFlowLiveController, DevFlowSnapshotController } from './store.ts';
interface DevFlowCanvasInjected {
    readonly hooks: {
        readonly devflow: DevFlowSnapshotController;
        readonly audit?: {
            readonly getSnapshot: () => DevFlowClientAuditLoadState;
            readonly subscribe: (listener: () => void) => () => void;
        };
        readonly live?: DevFlowLiveController;
    };
    readonly refresh: () => Promise<void>;
    readonly audit?: {
        readonly ensure: (filter: DevFlowClientAuditFilter, scopeKey?: string) => Promise<void>;
        readonly refresh: () => Promise<void>;
        readonly loadMore: () => Promise<void>;
        readonly retry: () => Promise<void>;
    };
    readonly getInspectorTab: () => DevFlowInspectorTab;
    readonly setInspectorTab: (tab: DevFlowInspectorTab) => void;
    /** §二·3: the only way back in after the overview float was closed. */
    readonly reopenOverview?: () => void;
}
type Props = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'devflow'> & InjectFace<DevFlowCanvasInjected>;
/** Render the read-only DevFlow workspace as the right Sidebar's DevFlow tab body. */
export declare function DevFlowCanvas(props: Props): import("react").JSX.Element;
export {};
