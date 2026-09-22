import type { DevFlowClientAuditPageResponse, DevFlowClientAuditQuery, DevFlowClientEvent, DevFlowClientSnapshotResponse } from '../contract.ts';
import type { RemoteResult, TypertRemoteContribution, TypertRemoteScopeApi } from '@deepseek-ai/dsh-typert-protocol';
declare module '@deepseek-ai/dsh-typert-protocol' {
    interface TypertRemoteMap {
        'devflow/snapshot': (sessionId: string) => Promise<RemoteResult<DevFlowClientSnapshotResponse>>;
        'devflow/refresh': (sessionId: string) => Promise<RemoteResult<DevFlowClientSnapshotResponse>>;
        'devflow/audit-page': (sessionId: string, query: DevFlowClientAuditQuery) => Promise<RemoteResult<DevFlowClientAuditPageResponse>>;
        'devflow/follow': (sessionId: string, request: DevFlowFollowRequest) => AsyncIterable<DevFlowClientEvent>;
    }
    interface TypertRemoteNamespaceMap {
        devflow: TypertRemoteNamespace;
    }
    interface TypertRemoteScopeMap {
        'agent:devflow/snapshot': () => Promise<RemoteResult<DevFlowClientSnapshotResponse>>;
        'agent:devflow/refresh': () => Promise<RemoteResult<DevFlowClientSnapshotResponse>>;
        'agent:devflow/audit-page': (query: DevFlowClientAuditQuery) => Promise<RemoteResult<DevFlowClientAuditPageResponse>>;
        'agent:devflow/follow': (request: DevFlowFollowRequest, signal: AbortSignal) => AsyncIterable<DevFlowClientEvent>;
    }
}
/** What the client tells the live channel it already holds. */
export interface DevFlowFollowRequest {
    /** Durable journal head the client's last snapshot was read at, or null when unknown. */
    readonly sequence: number | null;
}
export interface TypertRemoteNamespace {
    snapshot(sessionId: string): Promise<RemoteResult<DevFlowClientSnapshotResponse>>;
    refresh(sessionId: string): Promise<RemoteResult<DevFlowClientSnapshotResponse>>;
    auditPage(sessionId: string, query: DevFlowClientAuditQuery): Promise<RemoteResult<DevFlowClientAuditPageResponse>>;
    /** Streams the frames themselves; there is no `RemoteResult` envelope on a stream. */
    follow(sessionId: string, request: DevFlowFollowRequest, signal: AbortSignal): AsyncIterable<DevFlowClientEvent>;
}
export type DevFlowRemote = TypertRemoteScopeApi<'agent'>['devflow'];
/** Client-side Remote contribution for DevFlow's narrow public bridge. */
export declare const DEVFLOW_REMOTE: TypertRemoteContribution;
/**
 * Strictly parse the follow request. The cursor is advisory — a channel that cannot
 * read it still opens with a full snapshot — so anything unrecognized degrades to
 * `null` rather than failing the subscription.
 */
export declare function parseFollowRequest(value: unknown): DevFlowFollowRequest;
/** Strictly parse one live-channel frame; an unknown shape is dropped by the caller. */
export declare function parseDevFlowEvent(value: unknown): DevFlowClientEvent;
export declare function parseDevFlowResponse(value: unknown): DevFlowClientSnapshotResponse;
/** Strictly parse a browser-supplied safe page query; unknown fields are dropped. */
export declare function parseAuditQuery(value: unknown): DevFlowClientAuditQuery;
export declare function parseDevFlowAuditResponse(value: unknown): DevFlowClientAuditPageResponse;
