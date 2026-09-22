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
import type { CommanderActionLoopResult } from './action-loop.ts';
import type { ApprovalProvider, ApprovalResult } from './approval.ts';
import type { DefaultCommanderRuntime } from './default-commander-runtime.ts';
import type { CommanderFeedbackResult, CommanderFeedbackProcessor } from './feedback.ts';
import type { DevFlowStore } from './storage.ts';
import type { CommanderProposal, CommanderWorkflow, CommanderWorkflowExecution, CommanderWorkflowStep, DevFlowProjectionState } from './types.ts';
export interface CommanderTaskStepOutcome {
    /** The orchestrated workflow. */
    readonly workflowId: string;
    /** The settled step. */
    readonly step: CommanderWorkflowStep;
    /** The step's cycle decision; null when the cycle was blocked before any decision. */
    readonly decisionId: string | null;
    /** The approval-gate proposal; null when the cycle produced no action. */
    readonly proposal: CommanderProposal | null;
    /** The approval verdict; null when nothing was proposed. */
    readonly approval: ApprovalResult | null;
    /** The action execution outcome; null when nothing executed. */
    readonly execution: CommanderActionLoopResult | null;
    /** The feedback derived from the execution; null when nothing executed. */
    readonly feedback: CommanderFeedbackResult | null;
    /** The history entry appended for the cycle; null when the cycle was blocked before any decision. */
    readonly entry: CommanderWorkflowExecution | null;
    /** The failure message; null when the cycle produced a decision. */
    readonly error: string | null;
    /** Whether the workflow settled (completed or failed) after this step. */
    readonly workflowSettled: boolean;
}
/** The plan output: the created workflow and its sequenced steps. */
export interface CommanderWorkflowPlan {
    /** The created workflow (status `created`). */
    readonly workflow: CommanderWorkflow;
    /** The created steps in sequence order (status `pending`). */
    readonly steps: readonly CommanderWorkflowStep[];
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
export declare class CommanderTaskOrchestrator {
    private readonly runtime;
    private readonly store;
    private readonly feedbackProcessor;
    private readonly approvalProvider;
    private readonly readState;
    constructor(runtime: DefaultCommanderRuntime, store: DevFlowStore, feedbackProcessor: CommanderFeedbackProcessor, approvalProvider: ApprovalProvider, readState: () => DevFlowProjectionState);
    /**
     * Plan one development workflow: create the workflow and one pending step
     * per step title, in sequence order.
     * @param input - the workflow intent and its ordered step titles.
     * @returns the created workflow and steps.
     */
    planWorkflow(input: {
        projectId: string;
        title: string;
        description: string;
        steps: readonly string[];
    }): Promise<CommanderWorkflowPlan>;
    /**
     * Run the next pending step of one workflow. The workflow starts on its
     * first step and completes when the last pending step completes; a failing
     * step fails the workflow (fail fast). Returns null when no step is pending.
     * @param workflowId - the workflow to advance.
     * @returns the settled step outcome, or null when every step is settled.
     */
    runNextStep(workflowId: string): Promise<CommanderTaskStepOutcome | null>;
    /** Run one step through the commander seams and settle it with its workflow. */
    private runStep;
    /** Build the workflow history entry for one step's cycle. */
    private buildEntry;
    /** Append one history entry to the workflow (event-logged). */
    private recordEntry;
    /** Settle one step (completed only when its execution committed) and its workflow. */
    private settleStep;
}
