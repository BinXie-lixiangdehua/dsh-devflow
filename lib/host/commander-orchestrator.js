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
/** The id of the latest attempt for one execution; null when none exists. */
function latestAttemptId(attempts, executionId) {
    const latest = Object.values(attempts)
        .filter(attempt => attempt.executionId === executionId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return latest[latest.length - 1]?.attemptId ?? null;
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
export function buildCommanderContext(state, projectId) {
    const batchIds = new Set(Object.values(state.executionBatches)
        .filter(batch => batch.projectId === projectId)
        .map(batch => batch.batchId));
    const currentExecutions = Object.values(state.executions)
        .filter(execution => batchIds.has(execution.batchId))
        .map(execution => ({
        executionId: execution.executionId,
        batchId: execution.batchId,
        agentId: execution.agentId,
        status: execution.status,
        latestAttemptId: latestAttemptId(state.executionAttempts, execution.executionId),
    }))
        .sort((a, b) => a.executionId.localeCompare(b.executionId));
    const pendingReviews = Object.values(state.commanderReviews)
        .filter(review => review.projectId === projectId && review.status === 'pending')
        .map(({ reviewId, reportId, executionId, status, summary }) => ({
        reviewId, reportId, executionId, status, summary,
    }))
        .sort((a, b) => a.reviewId.localeCompare(b.reviewId));
    const activeActions = Object.values(state.commanderActions)
        .filter((action) => {
        const decision = state.commanderDecisions[action.decisionId];
        return decision?.projectId === projectId && action.status !== 'completed';
    })
        .map(({ actionId, decisionId, actionType, targetId, status }) => ({
        actionId, decisionId, actionType, targetId, status,
    }))
        .sort((a, b) => a.actionId.localeCompare(b.actionId));
    const checkpoints = Object.values(state.commanderCheckpoints)
        .filter(checkpoint => checkpoint.projectId === projectId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return {
        projectId,
        currentExecutions,
        pendingReviews,
        activeActions,
        checkpoints,
        createdAt: new Date().toISOString(),
    };
}
/**
 * The Commander control-loop entry: reads the current plugin-owned read model and
 * produces the project's loop outcome. Unknown projects fail loud before any
 * context is built. This pass makes no decisions and executes nothing — it
 * only aggregates what a future Commander body would decide on.
 * @param readState - the plugin-owned `.devflow` read-model supplier.
 */
export class CommanderOrchestrator {
    readState;
    constructor(readState) {
        this.readState = readState;
    }
    /**
     * Process one project for the commander loop.
     * @param projectId - the project to process.
     * @returns the derived context and loop summary.
     */
    processProject(projectId) {
        const state = this.readState();
        if (state.project === null || state.project.id !== projectId) {
            throw new Error(`devflow: commander cannot process unknown project ${projectId}`);
        }
        const context = buildCommanderContext(state, projectId);
        return {
            projectId,
            context,
            pendingReviewCount: context.pendingReviews.length,
            pendingActionCount: context.activeActions.length,
            openExecutionCount: context.currentExecutions
                .filter(execution => execution.status !== 'completed').length,
        };
    }
}
