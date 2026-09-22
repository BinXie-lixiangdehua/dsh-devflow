/**
 * Commander action executor foundation: performs a commander control action
 * as a domain state change through the store, and logs every committed
 * change as an event. No decisions, no model calls, no runtime connection —
 * the action type decides the state change, and the result records the
 * outcome. The executor composes the existing batch/attempt/execution store
 * methods and never reimplements their state logic.
 * @module @xiaoxie-ide/dsh-devflow/action-executor
 */
import { recordDevFlowChange } from "./journal.js";
/**
 * The action → state-change performer. Each action type maps to one existing
 * domain transition: `start_batch`/`pause_batch`/`complete_batch` transition
 * the target batch, `retry_execution` creates a new attempt for the target
 * execution chained under its latest attempt. Failures (unknown targets,
 * illegal transitions) normalize into a failed {@link ActionExecutionResult}
 * instead of throwing; only committed changes log events.
 * @param store - the storage the batch, attempt, and execution records go through.
 */
export class CommanderActionExecutor {
    store;
    constructor(store) {
        this.store = store;
    }
    /**
     * Execute one commander control action.
     * @param action - the action to perform.
     * @returns the action outcome; never throws for domain failures.
     */
    async execute(action) {
        const completedAt = new Date().toISOString();
        try {
            switch (action.actionType) {
                case 'start_batch': {
                    const batch = await this.store.updateBatchStatus(action.targetId, 'running');
                    await recordDevFlowChange(this.store, 'devflow/execution/batch/start', { batchId: action.targetId, at: batch.updatedAt });
                    return { actionId: action.actionId, success: true, error: null, completedAt };
                }
                case 'pause_batch': {
                    const batch = await this.store.updateBatchStatus(action.targetId, 'paused');
                    await recordDevFlowChange(this.store, 'devflow/execution/batch/pause', { batchId: action.targetId, at: batch.updatedAt });
                    return { actionId: action.actionId, success: true, error: null, completedAt };
                }
                case 'complete_batch': {
                    const batch = await this.store.updateBatchStatus(action.targetId, 'completed');
                    await recordDevFlowChange(this.store, 'devflow/execution/batch/complete', { batchId: action.targetId, at: batch.updatedAt });
                    return { actionId: action.actionId, success: true, error: null, completedAt };
                }
                case 'retry_execution': {
                    const attempt = await this.createRetryAttempt(action);
                    await recordDevFlowChange(this.store, 'devflow/execution/attempt/create', { attempt });
                    return { actionId: action.actionId, success: true, error: null, completedAt };
                }
                default: {
                    const exhaustive = action.actionType;
                    return {
                        actionId: action.actionId,
                        success: false,
                        error: `devflow: unsupported commander action type ${String(exhaustive)}`,
                        completedAt,
                    };
                }
            }
        }
        catch (cause) {
            const error = cause instanceof Error ? cause.message : String(cause);
            return { actionId: action.actionId, success: false, error, completedAt };
        }
    }
    /** Create the retry attempt for one execution, chained under its latest attempt. */
    async createRetryAttempt(action) {
        const execution = await this.store.getExecutionRecord(action.targetId);
        if (execution === undefined) {
            throw new Error(`devflow: cannot retry unknown execution ${action.targetId}`);
        }
        const attempts = await this.store.listAttemptsByExecution(action.targetId);
        const parentAttemptId = attempts[attempts.length - 1]?.attemptId ?? null;
        return this.store.createAttempt({
            executionId: action.targetId,
            parentAttemptId,
            reason: `retry via commander action ${action.actionId}`,
        });
    }
}
