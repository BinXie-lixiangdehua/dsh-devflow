/** Safe, bounded projection of the plugin-owned DevFlow journal for the Canvas. */
import { type DevFlowClientAuditItem, type DevFlowClientAuditPageResponse, type DevFlowClientAuditQuery } from '../contract.ts';
import type { DevFlowJournalEntry, DevFlowStore } from './storage.ts';
export declare const DEVFLOW_AUDIT_CANDIDATE_SCAN_LIMIT = 200;
export declare const DEVFLOW_AUDIT_DEFAULT_RANGE_MS: number;
export declare const DEVFLOW_AUDIT_MAX_RANGE_MS: number;
/** A private, per-service cursor signer prevents clients changing page meaning. */
export declare class DevFlowAuditPager {
    private readonly secret;
    private readonly storeFor;
    /**
     * @param source - the session's store, or a supplier resolving it per call.
     *   The supplier form is what keeps the audit page inside the CALLING
     *   session's project: one audit panel must not page through another
     *   project's journal.
     */
    constructor(source: DevFlowStore | (() => DevFlowStore));
    page(query?: DevFlowClientAuditQuery): Promise<DevFlowClientAuditPageResponse>;
    private buildPage;
    private encodeCursor;
    private decodeCursor;
}
/** Converts only explicit, reviewed journal payload fields into the browser DTO. */
export declare function toSafeAuditItem(entry: DevFlowJournalEntry): DevFlowClientAuditItem | undefined;
