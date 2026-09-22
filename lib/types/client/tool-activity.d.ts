import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client';
import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client';
export type OfficialToolActivityStatus = 'running' | 'succeeded' | 'failed' | 'result-without-call';
export interface SafeOfficialToolActivity {
    readonly id: string;
    readonly source: 'harness-official-tool';
    readonly sessionId: string;
    readonly callId: string;
    readonly toolName: string;
    readonly status: OfficialToolActivityStatus;
    readonly startedAt: string | null;
    readonly endedAt: string | null;
    readonly durationMs: number | null;
    readonly startSeq: number | null;
    readonly resultSeq: number | null;
    readonly resultSummary: 'running' | 'completed' | 'failed' | 'result received without visible call';
    readonly devflowRelation: {
        readonly kind: 'unknown';
    };
}
export interface CurrentSessionToolsState {
    readonly phase: 'loading' | 'ready' | 'unavailable';
    readonly source: 'harness-official-tool';
    readonly window: 'current-loaded-window';
    readonly hasMore: boolean;
    readonly staleSafeItems: boolean;
    readonly incompleteCount: number;
    readonly items: readonly SafeOfficialToolActivity[];
}
/**
 * The two framework targets the official tool window reads.
 *
 * Harness 0.1.5 splits what one client-runtime snapshot used to bundle: session
 * lifecycle state comes from the Session Controller adapter (`useSession`),
 * loaded Chat nodes from the Chat target (`useChat`). Both are selected
 * separately by the view and joined here.
 */
export interface CurrentSessionSources {
    readonly session: SessionSnapshot;
    readonly chat: ChatSnapshot;
}
export declare function mapCurrentSessionTools(expectedSessionId: string, sources: CurrentSessionSources): CurrentSessionToolsState;
export declare function equalCurrentSessionToolsState(left: CurrentSessionToolsState, right: CurrentSessionToolsState): boolean;
