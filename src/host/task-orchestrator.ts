/**
 * Commander task orchestrator: the multi-step development workflow driver.
 * It plans a workflow (workflow + sequenced steps), runs one pending step at
 * a time through the existing commander seams — cycle (decision via the
 * provider, guarded by the validator and governance) → proposal → approval →
 * action execution (through the runtime adapter) → feedback — records every
 * step outcome as a workflow history entry, and settles the workflow when
 * all steps settle. The orchestrator never decides, never executes, and
 * never judges policy: it only orchestrates the flow, coordinates state, and
 * manages the lifecycle. Every committed change is event-logged and
 * replayable.
 * @module @xiaoxie-ide/dsh-devflow/task-orchestrator
 */

import { randomUUID } from 'node:crypto'
import type { CommanderActionLoopResult } from './action-loop.ts'
import type { ApprovalProvider, ApprovalResult } from './approval.ts'
import type { DefaultCommanderRuntime } from './default-commander-runtime.ts'
import type { CommanderFeedbackResult, CommanderFeedbackProcessor } from './feedback.ts'
import type { DevFlowStore } from './storage.ts'
import type {
  CommanderProposal, CommanderWorkflow, CommanderWorkflowExecution, CommanderWorkflowStep,
  DevFlowProjectionState,
} from './types.ts'

/** The outcome of one orchestrated workflow step. */
import { recordDevFlowChange } from './journal.ts'
export interface CommanderTaskStepOutcome {
  /** The orchestrated workflow. */
  readonly workflowId: string
  /** The settled step. */
  readonly step: CommanderWorkflowStep
  /** The step's cycle decision; null when the cycle was blocked before any decision. */
  readonly decisionId: string | null
  /** The approval-gate proposal; null when the cycle produced no action. */
  readonly proposal: CommanderProposal | null
  /** The approval verdict; null when nothing was proposed. */
  readonly approval: ApprovalResult | null
  /** The action execution outcome; null when nothing executed. */
  readonly execution: CommanderActionLoopResult | null
  /** The feedback derived from the execution; null when nothing executed. */
  readonly feedback: CommanderFeedbackResult | null
  /** The history entry appended for the cycle; null when the cycle was blocked before any decision. */
  readonly entry: CommanderWorkflowExecution | null
  /** The failure message; null when the cycle produced a decision. */
  readonly error: string | null
  /** Whether the workflow settled (completed or failed) after this step. */
  readonly workflowSettled: boolean
}

/** The plan output: the created workflow and its sequenced steps. */
export interface CommanderWorkflowPlan {
  /** The created workflow (status `created`). */
  readonly workflow: CommanderWorkflow
  /** The created steps in sequence order (status `pending`). */
  readonly steps: readonly CommanderWorkflowStep[]
}

/**
 * The multi-step development workflow orchestrator. `planWorkflow` creates
 * the workflow and its sequenced steps (task planning); `runNextStep` runs
 * the next pending step through the existing commander seams and records the
 * cycle's artifacts into the workflow history. A step settles `completed`
 * only when its execution committed; a blocked cycle, a rejected proposal,
 * or a failed execution settles the step `failed` and the workflow `failed`
 * (fail fast). When the last pending step completes, the workflow completes.
 * @param runtime - the pre-wired commander runtime (cycle runner + action loop).
 * @param store - the storage the workflow, step, decision, proposal, and action records go through.
 * @param session - the session whose event log records every committed change.
 * @param feedbackProcessor - the feedback converter for each execution result.
 * @param approvalProvider - the proposal judge; a rejected proposal fails the step.
 * @param readState - the projection-state reader used to resolve generated execution contexts.
 */
export class CommanderTaskOrchestrator {
  constructor(
    private readonly runtime: DefaultCommanderRuntime,
    private readonly store: DevFlowStore,
    private readonly feedbackProcessor: CommanderFeedbackProcessor,
    private readonly approvalProvider: ApprovalProvider,
    private readonly readState: () => DevFlowProjectionState,
  ) {}

  /**
   * Plan one development workflow: create the workflow and one pending step
   * per step title, in sequence order.
   * @param input - the workflow intent and its ordered step titles.
   * @returns the created workflow and steps.
   */
  async planWorkflow(input: {
    projectId: string
    title: string
    description: string
    steps: readonly string[]
  }): Promise<CommanderWorkflowPlan> {
    const workflow = await this.store.createWorkflow({
      projectId: input.projectId,
      title: input.title,
      description: input.description,
    })
    await recordDevFlowChange(this.store, 'devflow/commander/workflow/create', { workflow })
    const steps: CommanderWorkflowStep[] = []
    for (const [index, title] of input.steps.entries()) {
      const step = await this.store.createStep({ workflowId: workflow.workflowId, stepIndex: index, title })
      await recordDevFlowChange(this.store, 'devflow/commander/step/create', { step })
      steps.push(step)
    }
    return { workflow, steps }
  }

  /**
   * Run the next pending step of one workflow. The workflow starts on its
   * first step and completes when the last pending step completes; a failing
   * step fails the workflow (fail fast). Returns null when no step is pending.
   * @param workflowId - the workflow to advance.
   * @returns the settled step outcome, or null when every step is settled.
   */
  async runNextStep(workflowId: string): Promise<CommanderTaskStepOutcome | null> {
    const workflow = await this.store.getWorkflow(workflowId)
    if (workflow === undefined) {
      throw new Error(`devflow: cannot run unknown workflow ${workflowId}`)
    }
    const next = (await this.store.listStepsByWorkflow(workflowId)).find(step => step.status === 'pending')
    if (next === undefined) return null
    if (workflow.status === 'completed' || workflow.status === 'failed') {
      throw new Error(`devflow: cannot run a step of settled workflow ${workflowId} (status ${workflow.status})`)
    }
    if (workflow.status === 'created') {
      const started = await this.store.startWorkflow(workflowId)
      await recordDevFlowChange(this.store, 'devflow/commander/workflow/start', { workflowId, at: started.updatedAt })
    }
    return this.runStep(workflow, next)
  }

  /** Run one step through the commander seams and settle it with its workflow. */
  private async runStep(workflow: CommanderWorkflow, step: CommanderWorkflowStep): Promise<CommanderTaskStepOutcome> {
    const running = await this.store.startStep(step.stepId)
    await recordDevFlowChange(this.store, 'devflow/commander/step/start', { stepId: step.stepId, at: running.updatedAt })
    let decisionId: string | null = null
    let proposal: CommanderProposal | null = null
    let approval: ApprovalResult | null = null
    let execution: CommanderActionLoopResult | null = null
    let feedback: CommanderFeedbackResult | null = null
    let entry: CommanderWorkflowExecution | null = null
    let error: string | null = null
    try {
      const cycle = await this.runtime.runner.runCycle(workflow.projectId)
      decisionId = cycle.decisionId
      const action = await this.store.getAction(cycle.actionId)
      if (action === undefined) {
        throw new Error(`devflow: step cycle produced unknown action ${cycle.actionId}`)
      }
      const policy = await this.store.getPolicy(workflow.projectId)
      const created = await this.store.createProposal({
        decisionId: action.decisionId,
        actionType: action.actionType,
        targetId: action.targetId,
        riskLevel: policy?.riskLevel ?? 'low',
      })
      await recordDevFlowChange(this.store, 'devflow/commander/proposal/create', { proposal: created })
      proposal = created
      approval = await this.approvalProvider.approve(created)
      if (!approval.approved) {
        const rejected = await this.store.rejectProposal(created.proposalId)
        await recordDevFlowChange(this.store, 'devflow/commander/proposal/reject', {
          proposalId: created.proposalId,
          at: rejected.updatedAt,
        })
        proposal = rejected
        entry = this.buildEntry(step, decisionId, rejected, null, null)
      } else {
        const approved = await this.store.approveProposal(created.proposalId)
        await recordDevFlowChange(this.store, 'devflow/commander/proposal/approve', {
          proposalId: created.proposalId,
          at: approved.updatedAt,
        })
        proposal = approved
        execution = await this.runtime.actionLoop.execute(action)
        feedback = this.feedbackProcessor.process({
          actionId: action.actionId,
          success: execution.success,
          error: execution.error,
          completedAt: execution.completedAt,
        })
        entry = this.buildEntry(step, decisionId, approved, execution, feedback)
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    }
    if (entry !== null) {
      await this.recordEntry(workflow.workflowId, entry)
    }
    const settled = await this.settleStep(workflow, step, execution?.success === true)
    return {
      workflowId: workflow.workflowId,
      step: settled.step,
      decisionId,
      proposal,
      approval,
      execution,
      feedback,
      entry,
      error,
      workflowSettled: settled.workflowSettled,
    }
  }

  /** Build the workflow history entry for one step's cycle. */
  private buildEntry(
    step: CommanderWorkflowStep,
    decisionId: string,
    proposal: CommanderProposal,
    execution: CommanderActionLoopResult | null,
    feedback: CommanderFeedbackResult | null,
  ): CommanderWorkflowExecution {
    const context = execution === null
      ? null
      : Object.values(this.readState().commanderExecutionContexts)
        .find(item => item.executionId === execution.executionId) ?? null
    return {
      entryId: randomUUID(),
      stepId: step.stepId,
      decisionId,
      proposalId: proposal.proposalId,
      approved: proposal.status === 'approved',
      contextId: context?.contextId ?? null,
      actionExecutionId: execution?.executionId ?? null,
      result: execution === null ? null : { success: execution.success, error: execution.error },
      feedbackId: feedback?.feedback.feedbackId ?? null,
      createdAt: new Date().toISOString(),
    }
  }

  /** Append one history entry to the workflow (event-logged). */
  private async recordEntry(workflowId: string, entry: CommanderWorkflowExecution): Promise<void> {
    const updated = await this.store.appendWorkflowExecution(workflowId, entry)
    await recordDevFlowChange(this.store, 'devflow/commander/workflow/execution/add', { workflowId, entry, at: updated.updatedAt })
  }

  /** Settle one step (completed only when its execution committed) and its workflow. */
  private async settleStep(
    workflow: CommanderWorkflow,
    step: CommanderWorkflowStep,
    succeeded: boolean,
  ): Promise<{ step: CommanderWorkflowStep; workflowSettled: boolean }> {
    if (!succeeded) {
      const failed = await this.store.failStep(step.stepId)
      await recordDevFlowChange(this.store, 'devflow/commander/step/fail', { stepId: step.stepId, at: failed.updatedAt })
      const failedWorkflow = await this.store.failWorkflow(workflow.workflowId)
      await recordDevFlowChange(this.store, 'devflow/commander/workflow/fail', { workflowId: workflow.workflowId, at: failedWorkflow.updatedAt })
      return { step: failed, workflowSettled: true }
    }
    const completed = await this.store.completeStep(step.stepId)
    await recordDevFlowChange(this.store, 'devflow/commander/step/complete', { stepId: step.stepId, at: completed.updatedAt })
    const remaining = (await this.store.listStepsByWorkflow(workflow.workflowId)).some(item => item.status === 'pending')
    if (remaining) return { step: completed, workflowSettled: false }
    const completedWorkflow = await this.store.completeWorkflow(workflow.workflowId)
    await recordDevFlowChange(this.store, 'devflow/commander/workflow/complete', { workflowId: workflow.workflowId, at: completedWorkflow.updatedAt })
    return { step: completed, workflowSettled: true }
  }
}
