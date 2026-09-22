import type { DevFlowJournalEntry, DevFlowStore } from './storage.ts';
import type { DevFlowJsonValue } from './json.ts';
type JournalWriter = Pick<DevFlowStore, 'appendJournal'>;
/** One DevFlow business mutation that has already committed to `.devflow/`. */
export interface DevFlowChange {
    readonly type: `devflow/${string}`;
    readonly data: DevFlowJsonValue;
}
/**
 * Persist a post-mutation DevFlow audit fact in the plugin-owned journal.
 *
 * DevFlow events are never appended to Session: a third-party plugin cannot
 * reliably extend the host persistence vocabulary. Official tool lifecycle
 * records are independently produced by the dsh tool runtime and remain the
 * only session-level conversation anchors.
 */
export declare function recordDevFlowChange(store: JournalWriter, type: `devflow/${string}`, data: unknown): Promise<DevFlowJournalEntry>;
export {};
