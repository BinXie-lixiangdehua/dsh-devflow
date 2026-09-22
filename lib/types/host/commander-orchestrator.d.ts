/**
 * Commander orchestrator foundation: the control-loop entry that reads the
 * current plugin-owned DevFlow read model and builds the Commander's input context.
 * Pure business orchestration — no runtime binding, no model binding, and no
 * decision generation: a future LLM Commander consumes the context and makes
 * decisions; this layer only aggregates the project's loop-relevant state.
 * The `.devflow` entity and journal fold provides the read model; no Harness
 * Session projection is read or restored here.
 * @module @xiaoxie-ide/dsh-devflow/commander-orchestrator
 */
import type { CommanderActionStatus, CommanderActionType, CommanderCheckpoint, CommanderReviewStatus, DevFlowProjectionState, ExecutionStatus } from './types.ts';
/** One execution visible to the commander context (batch-linked). */
export interface CommanderContextExecution {
    /** The execution id. */
    readonly executionId: string;
    /** The batch this execution belongs to. */
    readonly batchId: string;
    /** The agent executing (registry slug id). */
    readonly agentId: string;
    /** Lifecycle status. */
    readonly status: ExecutionStatus;
    /** The id of the latest attempt, when any attempt exists. */
    readonly latestAttemptId: string | null;
}
/** One pending review visible to the commander context. */
export interface CommanderContextReview {
    /** The review id. */
    readonly reviewId: string;
    /** The agent report under review (reference). */
    readonly reportId: string;
    /** The execution the report answers (reference). */
    readonly executionId: string;
    /** Review lifecycle status. */
    readonly status: CommanderReviewStatus;
    /** One-paragraph review summary. */
    readonly summary: string;
}
/** One control action visible to the commander context (decision-linked). */
export interface CommanderContextAction {
    /** The action id. */
    readonly actionId: string;
    /** The commander decision this action realizes. */
    readonly decisionId: string;
    /** The action kind. */
    readonly actionType: CommanderActionType;
    /** The batch or execution id this action targets. */
    readonly targetId: string;
    /** The action lifecycle status. */
    readonly status: CommanderActionStatus;
}
/**
 * The Commander's input snapshot for one project: what a future LLM Commander
 * reads before deciding. Pure derived data — no decisions, no instructions,
 * no model vocabulary.
 */
export interface CommanderContext {
    /** The project this context describes. */
    readonly projectId: string;
    /** The project's executions with their latest attempt links. */
    readonly currentExecutions: readonly CommanderContextExecution[];
    /** The project's reviews awaiting a decision. */
    readonly pendingReviews: readonly CommanderContextReview[];
    /** The project's control actions not yet completed. */
    readonly activeActions: readonly CommanderContextAction[];
    /** The project's commander checkpoints, oldest first. */
    readonly checkpoints: readonly CommanderCheckpoint[];
    /** Context snapshot time, ISO 8601. */
    readonly createdAt: string;
}
/** The observable outcome of one Commander control-loop pass over a project. */
export interface CommanderProcessResult {
    /** The processed project. */
    readonly projectId: string;
    /** The derived commander input context. */
    readonly context: CommanderContext;
    /** Reviews awaiting a commander decision. */
    readonly pendingReviewCount: number;
    /** Control actions awaiting execution. */
    readonly pendingActionCount: number;
    /** Executions in a non-terminal status (pending/running/failed). */
    readonly openExecutionCount: number;
}
/**
 * Build the Commander's input context for one project from the plugin-owned
 * `.devflow` read-model snapshot. Executions are linked through their batches, actions through
 * their decisions, and attempts through their execution — all pure id joins
 * over the snapshot; no store access, no decisions.
 * @param state - the current devflow projection snapshot.
 * @param projectId - the project to aggregate.
 * @returns the derived commander context.
 */
export declare function buildCommanderContext(state: DevFlowProjectionState, projectId: string): CommanderContext;
/**
 * The Commander control-loop entry: reads the current plugin-owned read model and
 * produces the project's loop outcome. Unknown projects fail loud before any
 * context is built. This pass makes no decisions and executes nothing — it
 * only aggregates what a future Commander body would decide on.
 * @param readState - the plugin-owned `.devflow` read-model supplier.
 */
export declare class CommanderOrchestrator {
    private readonly readState;
    constructor(readState: () => DevFlowProjectionState);
    /**
     * Process one project for the commander loop.
     * @param projectId - the project to process.
     * @returns the derived context and loop summary.
     */
    processProject(projectId: string): CommanderProcessResult;
}
