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

import type { CommanderRuntimeAdapter, CommanderRuntimeExecutionResult } from './commander-runtime-adapter.ts'
import type { CommanderExecutionContext } from './types.ts'

/** One external execution request: the approved context plus the provider-specific intent. */
export interface CommanderRuntimeExecutionRequest {
  /** The approved execution context (never modified). */
  readonly context: CommanderExecutionContext
  /** The provider-specific task instruction derived from the context. */
  readonly task: string
  /** Provider-specific carry-over metadata (provider, model, ...). */
  readonly metadata: Record<string, unknown>
}

/** The raw external runtime response before normalization. */
export interface CommanderRuntimeExecutionResponse {
  /** The runtime output text; null when the runtime itself failed. */
  readonly output: string | null
  /** The runtime failure message; null on success. */
  readonly error: string | null
}

/**
 * The transport seam: the only I/O an external adapter performs. The
 * transport owns the connection to the external execution environment —
 * implementations are the future DeepSeek Harness, OpenAI, Claude, and local
 * agent connections.
 */
export interface CommanderRuntimeTransport {
  /**
   * Run one external execution.
   * @param request - the execution request.
   * @returns the raw runtime response; rejections normalize into a failed result.
   */
  run(request: CommanderRuntimeExecutionRequest): Promise<CommanderRuntimeExecutionResponse>
}

/** The external adapter foundation options. */
export interface CommanderExternalRuntimeAdapterOptions {
  /** The transport that performs the external call; null means not connected. */
  readonly transport: CommanderRuntimeTransport | null
  /** Optional call timeout in milliseconds; no timeout when absent or zero. */
  readonly timeoutMs?: number
}

/**
 * The external runtime adapter foundation: implements the
 * {@link CommanderRuntimeAdapter} seam for external execution environments.
 * `buildRequest` is the only provider-specific step; everything else —
 * connection check, timed transport call, response/exception normalization —
 * is shared by every external adapter.
 */
export abstract class CommanderExternalRuntimeAdapter implements CommanderRuntimeAdapter {
  private readonly transport: CommanderRuntimeTransport | null
  private readonly timeoutMs: number | null

  protected constructor(options: CommanderExternalRuntimeAdapterOptions) {
    this.transport = options.transport
    this.timeoutMs = options.timeoutMs !== undefined && options.timeoutMs > 0 ? options.timeoutMs : null
  }

  /**
   * Execute one approved context against the external runtime.
   * @param context - the immutable execution context to execute.
   * @returns the normalized execution result; an unconnected, failing,
   *   timing-out, or throwing runtime settles as a recorded failure, never a
   *   silent success.
   */
  async execute(context: CommanderExecutionContext): Promise<CommanderRuntimeExecutionResult> {
    const transport = this.transport
    if (transport === null) {
      return this.failure(context, 'external runtime not connected')
    }
    const request = this.buildRequest(context)
    const timeoutMs = this.timeoutMs
    let response: CommanderRuntimeExecutionResponse
    try {
      response = timeoutMs === null
        ? await transport.run(request)
        : await this.runWithTimeout(transport, request, timeoutMs)
    } catch (cause) {
      return this.failure(context, cause instanceof Error ? cause.message : String(cause))
    }
    if (response.error !== null) {
      return this.failure(context, response.error)
    }
    return {
      contextId: context.contextId,
      success: true,
      output: response.output,
      error: null,
      completedAt: new Date().toISOString(),
    }
  }

  /**
   * Build the provider-specific execution request from the approved context.
   * @param context - the immutable execution context to execute.
   * @returns the request handed to the transport.
   */
  protected abstract buildRequest(context: CommanderExecutionContext): CommanderRuntimeExecutionRequest

  /** Race the transport call against the configured timeout. */
  private async runWithTimeout(
    transport: CommanderRuntimeTransport,
    request: CommanderRuntimeExecutionRequest,
    timeoutMs: number,
  ): Promise<CommanderRuntimeExecutionResponse> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        transport.run(request),
        new Promise<CommanderRuntimeExecutionResponse>((_, reject) => {
          timer = setTimeout(() => { reject(new Error(`external runtime timed out after ${timeoutMs}ms`)) }, timeoutMs)
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /** The standardized failure result for one context. */
  private failure(context: CommanderExecutionContext, error: string): CommanderRuntimeExecutionResult {
    return {
      contextId: context.contextId,
      success: false,
      output: null,
      error,
      completedAt: new Date().toISOString(),
    }
  }
}
