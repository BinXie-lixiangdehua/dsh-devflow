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

import { randomUUID } from 'node:crypto'
import type { CommanderRuntimeAdapter, CommanderRuntimeExecutionResult } from './commander-runtime-adapter.ts'
import type { DevFlowStore } from './storage.ts'
import type { CommanderAction, CommanderExecutionContext, CommanderProposal } from './types.ts'

/** The outcome of one executed action through the loop. */
import { recordDevFlowChange } from './journal.ts'
export interface CommanderActionLoopResult {
  /** The persisted action-execution id. */
  readonly executionId: string
  /** The executed action. */
  readonly actionId: string
  /** Whether the action's state change committed. */
  readonly success: boolean
  /** The failure message; null on success. */
  readonly error: string | null
  /** Completion time, ISO 8601. */
  readonly completedAt: string
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
export class CommanderActionLoop {
  constructor(
    private readonly adapter: CommanderRuntimeAdapter,
    private readonly store: DevFlowStore,
  ) {}

  /**
   * Execute one commander action — only when an approved proposal exists for
   * its (decision, action type, target) triple; otherwise the execution is
   * recorded as failed and the adapter is never invoked.
   * @param action - the action to run.
   * @returns the settled execution outcome.
   */
  async execute(action: CommanderAction): Promise<CommanderActionLoopResult> {
    const approved = (await this.store.listProposalsByDecision(action.decisionId))
      .filter(proposal => proposal.actionType === action.actionType
        && proposal.targetId === action.targetId
        && proposal.status === 'approved')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
    if (approved === undefined) {
      return this.block(action, 'no approved proposal for this action; execution blocked')
    }
    return this.run(action, approved)
  }

  /** Record a failed execution without invoking the adapter. */
  private async block(action: CommanderAction, error: string): Promise<CommanderActionLoopResult> {
    const execution = await this.store.createActionExecution({ actionId: action.actionId })
    await recordDevFlowChange(this.store, 'devflow/commander/action-execution/create', { execution })
    const failed = await this.store.failActionExecution(execution.executionId, error)
    await recordDevFlowChange(this.store, 'devflow/commander/action-execution/fail', {
      executionId: execution.executionId,
      error,
      at: failed.completedAt ?? failed.updatedAt,
    })
    return {
      executionId: execution.executionId,
      actionId: action.actionId,
      success: false,
      error,
      completedAt: failed.completedAt ?? failed.updatedAt,
    }
  }

  /** Run the adapter and settle the execution record from its result. */
  private async run(action: CommanderAction, proposal: CommanderProposal): Promise<CommanderActionLoopResult> {
    const execution = await this.store.createActionExecution({ actionId: action.actionId })
    await recordDevFlowChange(this.store, 'devflow/commander/action-execution/create', { execution })
    // Immutable execution context: the environment snapshot for this approved
    // execution, generated before the adapter runs. Event + projection only.
    const context: CommanderExecutionContext = {
      contextId: randomUUID(),
      executionId: execution.executionId,
      decisionId: action.decisionId,
      proposalId: proposal.proposalId,
      actionType: action.actionType,
      targetId: action.targetId,
      riskLevel: proposal.riskLevel,
      metadata: { actionId: action.actionId },
      createdAt: execution.createdAt,
    }
    await recordDevFlowChange(this.store, 'devflow/commander/execution-context/create', { context })
    // The adapter is the only execution path; a throwing adapter still
    // settles the record as a normalized failure (never a dangling execution).
    let result: CommanderRuntimeExecutionResult
    try {
      result = await this.adapter.execute(context)
    } catch (cause) {
      result = {
        contextId: context.contextId,
        success: false,
        output: null,
        error: cause instanceof Error ? cause.message : String(cause),
        completedAt: new Date().toISOString(),
      }
    }
    if (result.success) {
      const completed = await this.store.completeActionExecution(execution.executionId)
      await recordDevFlowChange(this.store, 'devflow/commander/action-execution/complete', {
        executionId: execution.executionId,
        at: completed.completedAt ?? completed.updatedAt,
      })
      return {
        executionId: execution.executionId,
        actionId: action.actionId,
        success: true,
        error: null,
        completedAt: completed.completedAt ?? completed.updatedAt,
      }
    }
    const error = result.error ?? 'unknown error'
    const failed = await this.store.failActionExecution(execution.executionId, error)
    await recordDevFlowChange(this.store, 'devflow/commander/action-execution/fail', {
      executionId: execution.executionId,
      error,
      at: failed.completedAt ?? failed.updatedAt,
    })
    return {
      executionId: execution.executionId,
      actionId: action.actionId,
      success: false,
      error,
      completedAt: failed.completedAt ?? failed.updatedAt,
    }
  }
}
