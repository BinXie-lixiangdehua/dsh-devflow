/** Public Typert Remote bridge for the DevFlow client snapshot. */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { DevFlowClientAuditPageResponse, DevFlowClientAuditQuery, DevFlowClientEvent, DevFlowClientSnapshotResponse } from '../contract.ts';
/** What the client tells the channel it already holds. */
export interface DevFlowFollowRequest {
    /** Durable journal head the client's last snapshot was read at, or null when unknown. */
    readonly sequence: number | null;
}
/** Gateway-discoverable, path-free read/refresh service for the Canvas. */
export declare class DevFlowClientBridge extends TypertRemoteService {
    static inject: string[];
    constructor(ctx: Context);
    snapshot(agent: Agent): Promise<DevFlowClientSnapshotResponse>;
    refresh(agent: Agent): Promise<DevFlowClientSnapshotResponse>;
    auditPage(agent: Agent, query: DevFlowClientAuditQuery): Promise<DevFlowClientAuditPageResponse>;
    /**
     * Follow the committed DevFlow state: one opening snapshot, then one signal per
     * coalesced change batch.
     *
     * The channel is intentionally thin. It never sends derived state — only the
     * read model the client could have fetched itself, plus "the state moved on".
     * That is what makes a frame droppable and a replay harmless: the client decides
     * what to re-read, and the existing snapshot path stays the single source of
     * truth. A quiet channel still emits a keepalive signal, so a dead carrier is
     * noticed rather than looking like "nothing is happening".
     *
     * @param agent - the scoped Agent whose session is being followed.
     * @param request - what the client already holds (`sequence`).
     * @param signal - cancellation owned by the Remote stream carrier.
     * @returns the opening snapshot followed by ordered change signals.
     */
    follow(agent: Agent, request: DevFlowFollowRequest, signal: AbortSignal): AsyncIterable<DevFlowClientEvent>;
    private read;
}
