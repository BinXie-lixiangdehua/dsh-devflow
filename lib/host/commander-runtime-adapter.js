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
/**
 * Default adapter: performs no external call and returns a standardized
 * failed result (the runtime is not connected). Replaceable via the
 * `CommanderRuntimeAdapter` seam.
 */
export class DefaultCommanderRuntimeAdapter {
    execute(context) {
        return Promise.resolve({
            contextId: context.contextId,
            success: false,
            output: null,
            error: 'runtime not connected',
            completedAt: new Date().toISOString(),
        });
    }
}
/**
 * Local runtime adapter: executes the approved context against the unchanged
 * `CommanderActionExecutor` as the local runtime. The action is resolved from
 * the context metadata (`actionId`) — never copied into the adapter — and the
 * executor result is normalized into a {@link CommanderRuntimeExecutionResult}.
 * This is the reference local implementation a future DeepSeek, OpenAI,
 * Claude, or remote-agent adapter replaces.
 */
export class CommanderLocalRuntimeAdapter {
    executor;
    store;
    constructor(executor, store) {
        this.executor = executor;
        this.store = store;
    }
    /**
     * Execute one approved execution context through the local action executor.
     * @param context - the immutable execution context to execute.
     * @returns the normalized execution result.
     */
    async execute(context) {
        const actionId = context.metadata['actionId'];
        if (typeof actionId !== 'string') {
            return this.failure(context, 'devflow: execution context carries no action id');
        }
        const action = await this.store.getAction(actionId);
        if (action === undefined) {
            return this.failure(context, `devflow: cannot execute context ${context.contextId}: unknown action ${actionId}`);
        }
        const result = await this.executor.execute(action);
        return {
            contextId: context.contextId,
            success: result.success,
            output: null,
            error: result.error,
            completedAt: result.completedAt,
        };
    }
    /** The normalized failure for a context the local runtime cannot resolve. */
    failure(context, error) {
        return {
            contextId: context.contextId,
            success: false,
            output: null,
            error,
            completedAt: new Date().toISOString(),
        };
    }
}
