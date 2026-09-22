/**
 * Store-journal DevFlow read model.
 *
 * This is the former session projection's pure fold, reused over plugin-owned
 * journal records so third-party state never depends on session event support.
 * @module @xiaoxie-ide/dsh-devflow/state
 */
import type { DevFlowJournalEvent, DevFlowProjectionState } from './types.ts';
/** Create the empty durable DevFlow state. */
export declare function initialDevFlowState(): DevFlowProjectionState;
/** Fold one plugin-owned journal record using the established DevFlow rules. */
export declare function applyDevFlowStateEvent(state: DevFlowProjectionState, event: DevFlowJournalEvent): DevFlowProjectionState;
