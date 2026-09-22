/**
 * DeepSeek runtime adapter: the first concrete external runtime adapter — it
 * turns an approved execution context into a DeepSeek execution request,
 * delegates the call to the harness transport, and returns the standardized
 * execution result. The adapter strictly follows the adapter boundary: it
 * receives the approved context, calls the external execution environment,
 * and returns the normalized result — no decision, governance, approval,
 * memory, state, or event participation. The transport is the only I/O; an
 * unconnected adapter settles every execution as an explicit failure. OpenAI,
 * Claude, and local-agent runtimes plug in through the same foundation.
 * @module @xiaoxie-ide/dsh-devflow/deepseek-runtime-adapter
 */
import { CommanderExternalRuntimeAdapter, } from "./commander-external-runtime-adapter.js";
/**
 * The DeepSeek execution adapter: implements the external runtime foundation
 * with DeepSeek-specific request construction. The provider identity and
 * model ride in the request metadata; the harness transport owns the
 * connection.
 */
export class DeepSeekRuntimeAdapter extends CommanderExternalRuntimeAdapter {
    model;
    constructor(options) {
        super({
            transport: options.transport,
            ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        });
        this.model = options.model ?? 'deepseek-chat';
    }
    /** Build the DeepSeek execution request from the approved context. */
    buildRequest(context) {
        return {
            context,
            task: `execute commander action ${context.actionType} on target ${context.targetId}`
                + ` (execution ${context.executionId}, decision ${context.decisionId},`
                + ` approved proposal ${context.proposalId}, risk ${context.riskLevel})`,
            metadata: { provider: 'deepseek', model: this.model },
        };
    }
}
