/**
 * Commander action executor foundation: performs a commander control action
 * as a domain state change through the store, and logs every committed
 * change as an event. No decisions, no model calls, no runtime connection —
 * the action type decides the state change, and the result records the
 * outcome. The executor composes the existing batch/attempt/execution store
 * methods and never reimplements their state logic.
 * @module @xiaoxie-ide/dsh-devflow/action-executor
 */
import type { DevFlowStore } from './storage.ts';
import type { CommanderAction } from './types.ts';
/** The outcome of one executed commander control action. */
export interface ActionExecutionResult {
    /** The executed action. */
    readonly actionId: string;
    /** Whether the action's state change committed. */
    readonly success: boolean;
    /** The failure message; null on success. */
    readonly error: string | null;
    /** Completion time, ISO 8601. */
    readonly completedAt: string;
}
/**
 * The action → state-change performer. Each action type maps to one existing
 * domain transition: `start_batch`/`pause_batch`/`complete_batch` transition
 * the target batch, `retry_execution` creates a new attempt for the target
 * execution chained under its latest attempt. Failures (unknown targets,
 * illegal transitions) normalize into a failed {@link ActionExecutionResult}
 * instead of throwing; only committed changes log events.
 * @param store - the storage the batch, attempt, and execution records go through.
 */
export declare class CommanderActionExecutor {
    private readonly store;
    constructor(store: DevFlowStore);
    /**
     * Execute one commander control action.
     * @param action - the action to perform.
     * @returns the action outcome; never throws for domain failures.
     */
    execute(action: CommanderAction): Promise<ActionExecutionResult>;
    /** Create the retry attempt for one execution, chained under its latest attempt. */
    private createRetryAttempt;
}
