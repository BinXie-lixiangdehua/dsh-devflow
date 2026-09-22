/**
 * Commander external runtime adapter foundation: the base abstraction for
 * adapters that connect the Commander to an external AI-agent execution
 * environment (DeepSeek Harness, OpenAI Agent, Claude Agent, local agent).
 * The foundation owns the generic lifecycle — connection check, transport
 * call with optional timeout, and normalization of responses, timeouts, and
 * exceptions into a standardized execution result — while a concrete adapter
 * owns only the provider-specific request construction. The foundation
 * enforces the adapter boundary: it never participates in decision,
 * governance, approval, or memory, and it never writes state or events
 * itself; an unconnected adapter settles every execution as an explicit
 * failure instead of silently succeeding, and the execution record is always
 * settled by the action loop, never bypassed.
 * @module @xiaoxie-ide/dsh-devflow/commander-external-runtime-adapter
 */
/**
 * The external runtime adapter foundation: implements the
 * {@link CommanderRuntimeAdapter} seam for external execution environments.
 * `buildRequest` is the only provider-specific step; everything else —
 * connection check, timed transport call, response/exception normalization —
 * is shared by every external adapter.
 */
export class CommanderExternalRuntimeAdapter {
    transport;
    timeoutMs;
    constructor(options) {
        this.transport = options.transport;
        this.timeoutMs = options.timeoutMs !== undefined && options.timeoutMs > 0 ? options.timeoutMs : null;
    }
    /**
     * Execute one approved context against the external runtime.
     * @param context - the immutable execution context to execute.
     * @returns the normalized execution result; an unconnected, failing,
     *   timing-out, or throwing runtime settles as a recorded failure, never a
     *   silent success.
     */
    async execute(context) {
        const transport = this.transport;
        if (transport === null) {
            return this.failure(context, 'external runtime not connected');
        }
        const request = this.buildRequest(context);
        const timeoutMs = this.timeoutMs;
        let response;
        try {
            response = timeoutMs === null
                ? await transport.run(request)
                : await this.runWithTimeout(transport, request, timeoutMs);
        }
        catch (cause) {
            return this.failure(context, cause instanceof Error ? cause.message : String(cause));
        }
        if (response.error !== null) {
            return this.failure(context, response.error);
        }
        return {
            contextId: context.contextId,
            success: true,
            output: response.output,
            error: null,
            completedAt: new Date().toISOString(),
        };
    }
    /** Race the transport call against the configured timeout. */
    async runWithTimeout(transport, request, timeoutMs) {
        let timer;
        try {
            return await Promise.race([
                transport.run(request),
                new Promise((_, reject) => {
                    timer = setTimeout(() => { reject(new Error(`external runtime timed out after ${timeoutMs}ms`)); }, timeoutMs);
                }),
            ]);
        }
        finally {
            if (timer !== undefined)
                clearTimeout(timer);
        }
    }
    /** The standardized failure result for one context. */
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
