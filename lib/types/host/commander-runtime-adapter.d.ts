/**
 * Commander runtime adapter boundary: the replaceable seam between the
 * Commander and an external execution runtime. The adapter receives an
 * approved runtime execution context, calls the external runtime, and
 * returns a normalized execution result — it never participates in decision,
 * governance, or approval, and it never writes state or events itself. The
 * `CommanderActionExecutor` remains the upper control interface; a future
 * DeepSeek, OpenAI, Claude, or local-agent adapter implements this seam.
 * `CommanderLocalRuntimeAdapter` is the shipped local implementation: it
 * delegates the approved context to the unchanged action executor, keeping
 * the domain state changes reachable through the seam.
 * @module @xiaoxie-ide/dsh-devflow/commander-runtime-adapter
 */
import type { CommanderActionExecutor } from './action-executor.ts';
import type { DevFlowStore } from './storage.ts';
import type { CommanderExecutionContext } from './types.ts';
/** The normalized outcome of one external runtime execution. */
export interface CommanderRuntimeExecutionResult {
    /** The execution context this result answers. */
    readonly contextId: string;
    /** Whether the external execution committed. */
    readonly success: boolean;
    /** The runtime output text; null when the execution failed. */
    readonly output: string | null;
    /** The failure message; null on success. */
    readonly error: string | null;
    /** Completion time, ISO 8601. */
    readonly completedAt: string;
}
/**
 * The external execution runtime seam. Implementations own the transport and
 * normalize outcomes into {@link CommanderRuntimeExecutionResult}; they know
 * nothing about decisions, governance, or approvals.
 */
export interface CommanderRuntimeAdapter {
    /**
     * Execute one approved execution context against the external runtime.
     * @param context - the immutable execution context to execute.
     * @returns the normalized execution result.
     */
    execute(context: CommanderExecutionContext): Promise<CommanderRuntimeExecutionResult>;
}
/**
 * Default adapter: performs no external call and returns a standardized
 * failed result (the runtime is not connected). Replaceable via the
 * `CommanderRuntimeAdapter` seam.
 */
export declare class DefaultCommanderRuntimeAdapter implements CommanderRuntimeAdapter {
    execute(context: CommanderExecutionContext): Promise<CommanderRuntimeExecutionResult>;
}
/**
 * Local runtime adapter: executes the approved context against the unchanged
 * `CommanderActionExecutor` as the local runtime. The action is resolved from
 * the context metadata (`actionId`) — never copied into the adapter — and the
 * executor result is normalized into a {@link CommanderRuntimeExecutionResult}.
 * This is the reference local implementation a future DeepSeek, OpenAI,
 * Claude, or remote-agent adapter replaces.
 */
export declare class CommanderLocalRuntimeAdapter implements CommanderRuntimeAdapter {
    private readonly executor;
    private readonly store;
    constructor(executor: CommanderActionExecutor, store: DevFlowStore);
    /**
     * Execute one approved execution context through the local action executor.
     * @param context - the immutable execution context to execute.
     * @returns the normalized execution result.
     */
    execute(context: CommanderExecutionContext): Promise<CommanderRuntimeExecutionResult>;
    /** The normalized failure for a context the local runtime cannot resolve. */
    private failure;
}
