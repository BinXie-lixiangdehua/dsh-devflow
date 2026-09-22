/**
 * Commander action execution loop: the action-execution entry that reads a
 * commander action, generates the immutable runtime execution context (event
 * + projection), delegates the execution to the runtime adapter, and records
 * the outcome as a `CommanderActionExecutionRecord` (event-logged, folded,
 * replayable). The loop enforces the approval gate: an action executes only
 * when an approved proposal exists for its (decision, action type, target)
 * triple; a blocked action settles as a failed execution and the adapter is
 * never invoked. The adapter is the only execution path — it receives the
 * approved context and returns the normalized result; an unconfigured
 * runtime (the default adapter) settles every execution as an explicit
 * `runtime not connected` failure instead of silently succeeding. The loop
 * only runs actions — it never decides, and the adapter never participates
 * in decision, governance, or approval.
 * @module @xiaoxie-ide/dsh-devflow/action-loop
 */
import type { CommanderRuntimeAdapter } from './commander-runtime-adapter.ts';
import type { DevFlowStore } from './storage.ts';
import type { CommanderAction } from './types.ts';
export interface CommanderActionLoopResult {
    /** The persisted action-execution id. */
    readonly executionId: string;
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
 * The action execution loop: records an execution for the action, enforces
 * the approved-proposal gate, delegates the execution to the runtime adapter
 * (which owns the transport), and settles the execution record from the
 * adapter's normalized result — a throwing adapter still settles the record
 * as a failure. Every committed change is event-logged.
 * @param adapter - the runtime seam that executes the approved context.
 * @param store - the storage the execution and proposal records go through.
 */
export declare class CommanderActionLoop {
    private readonly adapter;
    private readonly store;
    constructor(adapter: CommanderRuntimeAdapter, store: DevFlowStore);
    /**
     * Execute one commander action — only when an approved proposal exists for
     * its (decision, action type, target) triple; otherwise the execution is
     * recorded as failed and the adapter is never invoked.
     * @param action - the action to run.
     * @returns the settled execution outcome.
     */
    execute(action: CommanderAction): Promise<CommanderActionLoopResult>;
    /** Record a failed execution without invoking the adapter. */
    private block;
    /** Run the adapter and settle the execution record from its result. */
    private run;
}
