/**
 * Commander autonomous orchestration runtime: the unified entry that runs
 * one complete commander cycle end to end — schedule due → run record →
 * decision → action → proposal → approval → action execution → feedback
 * candidate. The orchestrator only connects existing seams and keeps every
 * responsibility with its owner: it never generates a decision (the engine
 * does), never bypasses the validator or governance (the loop runner
 * enforces both), never modifies state directly (the driver, runner, and
 * action loop do), and never writes memory (the feedback candidate is
 * returned to the caller). Only explicit `runScheduled`/`runOnce` APIs exist
 * — no auto-write, no infinite loop, no background scheduler.
 * @module @xiaoxie-ide/dsh-devflow/commander-runtime-orchestrator
 */

import type { CommanderRunOutcome } from './commander-driver.ts'
import type { CommanderActionLoopResult } from './action-loop.ts'
import type { CommanderFeedbackResult, CommanderFeedbackProcessor } from './feedback.ts'
import type { ApprovalProvider, ApprovalResult } from './approval.ts'
import type { DefaultCommanderRuntime } from './default-commander-runtime.ts'
import type { DevFlowStore } from './storage.ts'
import type { CommanderProposal } from './types.ts'

/** The outcome of one orchestrated commander cycle. */
import { recordDevFlowChange } from './journal.ts'
export interface CommanderOrchestrationResult {
  /** The driven project. */
  readonly projectId: string
  /** The run outcome (cycle + decision/action creation). */
  readonly run: CommanderRunOutcome
  /** The approval-gate proposal; null when the cycle produced no action. */
  readonly proposal: CommanderProposal | null
  /** The approval verdict; null when nothing was proposed. */
  readonly approval: ApprovalResult | null
  /** The action execution outcome; null when the cycle produced no action or it was rejected. */
  readonly execution: CommanderActionLoopResult | null
  /** The feedback derived from the execution; null when nothing executed. */
  readonly feedback: CommanderFeedbackResult | null
}

/**
 * The autonomous orchestration entry: one explicit call runs the full cycle
 * — including the proposal/approval gate and the action execution — and
 * returns everything, while writing no memory itself. The feedback candidate
 * is the caller's to persist through the memory writer or the feedback
 * bridge.
 * @param runtime - the pre-wired default commander runtime (cycle + action loop).
 * @param store - the storage used to resolve the created action and policy.
 * @param session - the session whose event log records the proposal lifecycle.
 * @param feedbackProcessor - the feedback converter for the execution result.
 * @param approvalProvider - the proposal judge; a rejected proposal is not executed.
 */
export class CommanderRuntimeOrchestrator {
  constructor(
    private readonly runtime: DefaultCommanderRuntime,
    private readonly store: DevFlowStore,
    private readonly feedbackProcessor: CommanderFeedbackProcessor,
    private readonly approvalProvider: ApprovalProvider,
  ) {}

  /**
   * Run one scheduled orchestration: the full cycle only when the schedule
   * is due.
   * @param projectId - the project to orchestrate.
   * @param now - the current time, ISO 8601 (the scheduler's clock).
   * @returns the orchestration outcome, or null when no schedule is due.
   */
  async runScheduled(projectId: string, now: string): Promise<CommanderOrchestrationResult | null> {
    const run = await this.runtime.runScheduledCycle(projectId, now)
    if (run === null) return null
    return this.finish(run)
  }

  /**
   * Run one orchestration immediately, bypassing the schedule gate — the
   * explicit manual trigger.
   * @param projectId - the project to orchestrate.
   * @returns the orchestration outcome.
   */
  async runOnce(projectId: string): Promise<CommanderOrchestrationResult> {
    const run = await this.runtime.runOnce(projectId)
    return this.finish(run)
  }

  /** Propose, judge, execute (when approved), and derive feedback for the run's action. */
  private async finish(run: CommanderRunOutcome): Promise<CommanderOrchestrationResult> {
    if (run.status !== 'completed' || run.actionId === null) {
      return { projectId: run.projectId, run, proposal: null, approval: null, execution: null, feedback: null }
    }
    const action = await this.store.getAction(run.actionId)
    if (action === undefined) {
      throw new Error(`devflow: run ${run.runId} references unknown action ${run.actionId}`)
    }
    const policy = await this.store.getPolicy(run.projectId)
    const proposal = await this.store.createProposal({
      decisionId: action.decisionId,
      actionType: action.actionType,
      targetId: action.targetId,
      riskLevel: policy?.riskLevel ?? 'low',
    })
    await recordDevFlowChange(this.store, 'devflow/commander/proposal/create', { proposal })
    const approval = await this.approvalProvider.approve(proposal)
    if (!approval.approved) {
      const rejected = await this.store.rejectProposal(proposal.proposalId)
      await recordDevFlowChange(this.store, 'devflow/commander/proposal/reject', {
        proposalId: proposal.proposalId,
        at: rejected.updatedAt,
      })
      return { projectId: run.projectId, run, proposal: rejected, approval, execution: null, feedback: null }
    }
    const approved = await this.store.approveProposal(proposal.proposalId)
    await recordDevFlowChange(this.store, 'devflow/commander/proposal/approve', {
      proposalId: proposal.proposalId,
      at: approved.updatedAt,
    })
    const execution = await this.runtime.actionLoop.execute(action)
    const feedback = this.feedbackProcessor.process({
      actionId: action.actionId,
      success: execution.success,
      error: execution.error,
      completedAt: execution.completedAt,
    })
    return { projectId: run.projectId, run, proposal: approved, approval, execution, feedback }
  }
}
