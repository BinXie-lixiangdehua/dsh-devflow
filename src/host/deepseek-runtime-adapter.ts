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

import {
  CommanderExternalRuntimeAdapter,
  type CommanderRuntimeExecutionRequest,
  type CommanderRuntimeTransport,
} from './commander-external-runtime-adapter.ts'
import type { CommanderExecutionContext } from './types.ts'

/** The DeepSeek adapter's provider options. */
export interface DeepSeekRuntimeAdapterOptions {
  /** The harness transport that performs the DeepSeek call; null means not connected. */
  readonly transport: CommanderRuntimeTransport | null
  /** Optional call timeout in milliseconds; no timeout when absent or zero. */
  readonly timeoutMs?: number
  /** The DeepSeek model name carried in the request metadata; defaults to `deepseek-chat`. */
  readonly model?: string
}

/**
 * The DeepSeek execution adapter: implements the external runtime foundation
 * with DeepSeek-specific request construction. The provider identity and
 * model ride in the request metadata; the harness transport owns the
 * connection.
 */
export class DeepSeekRuntimeAdapter extends CommanderExternalRuntimeAdapter {
  private readonly model: string

  constructor(options: DeepSeekRuntimeAdapterOptions) {
    super({
      transport: options.transport,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    })
    this.model = options.model ?? 'deepseek-chat'
  }

  /** Build the DeepSeek execution request from the approved context. */
  protected buildRequest(context: CommanderExecutionContext): CommanderRuntimeExecutionRequest {
    return {
      context,
      task: `execute commander action ${context.actionType} on target ${context.targetId}`
        + ` (execution ${context.executionId}, decision ${context.decisionId},`
        + ` approved proposal ${context.proposalId}, risk ${context.riskLevel})`,
      metadata: { provider: 'deepseek', model: this.model },
    }
  }
}
