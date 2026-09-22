/**
 * DevFlow task lifecycle: the five-state machine (`created → planned →
 * executing → reviewing → completed`) plus the allowed rework edge
 * (`reviewing → executing`). TaskWorkflow owns no scheduling, Agent
 * registry, or model calls — it only validates transitions against the
 * TRANSITIONS table and persists each committed change through the store.
 * @module @xiaoxie-ide/dsh-devflow/workflow
 */
/** Allowed transitions per status; cancelled is terminal while failed/completed may be re-planned. */
export const TRANSITIONS = {
    created: ['planned', 'cancelled'],
    planned: ['executing', 'cancelled'],
    executing: ['planned', 'reviewing', 'failed', 'cancelled'],
    reviewing: ['completed', 'executing', 'planned', 'failed', 'cancelled'],
    completed: ['planned'],
    failed: ['planned', 'executing', 'cancelled'],
    cancelled: [],
};
/**
 * Task lifecycle manager over the file-backed store. Every transition
 * validates the current status, applies the change, and persists it.
 * @param store - the storage all tasks and changes go through.
 */
export class TaskWorkflow {
    store;
    constructor(store) {
        this.store = store;
    }
    /**
     * Create one task in the initial `created` state.
     * @param input - task fields without the store-owned id and timestamps.
     * @returns the persisted task.
     */
    async createTask(input) {
        return this.store.createTask(input);
    }
    /**
     * Move one task to `planned` (`created -> planned`).
     * @param taskId - the task to plan.
     * @returns the updated task and its change record.
     */
    async planTask(taskId) {
        return this.transition(taskId, 'planned');
    }
    /**
     * Move one task to `executing` (`planned -> executing`, or the
     * `reviewing -> executing` rework edge).
     * @param taskId - the task to start.
     * @returns the updated task and its change record.
     */
    async startExecution(taskId) {
        return this.transition(taskId, 'executing');
    }
    /**
     * Move one task to `reviewing` (`executing -> reviewing`).
     * @param taskId - the task to submit for review.
     * @returns the updated task and its change record.
     */
    async submitReview(taskId) {
        return this.transition(taskId, 'reviewing');
    }
    /** Settle one executing task as failed after its execution cannot complete. */
    async failTask(taskId) {
        return this.transition(taskId, 'failed');
    }
    /** Cancel a task before or during execution; cancelled tasks are terminal. */
    async cancelTask(taskId) {
        return this.transition(taskId, 'cancelled');
    }
    /**
     * Move one task to `completed` (`reviewing -> completed`).
     * @param taskId - the task to complete.
     * @returns the updated task and its change record.
     */
    async completeTask(taskId) {
        return this.transition(taskId, 'completed');
    }
    /**
     * Validate one transition against the TRANSITIONS table, persist it, and
     * return the updated task with its audit record. Illegal transitions and
     * unknown tasks fail loud.
     * @param taskId - the task to transition.
     * @param to - the target status.
     * @returns the updated task and its change record.
     */
    async transition(taskId, to) {
        const task = await this.store.getTask(taskId);
        if (task === undefined) {
            throw new Error(`devflow: cannot transition unknown task ${taskId}`);
        }
        if (!TRANSITIONS[task.status].includes(to)) {
            throw new Error(`Invalid task transition: ${task.status} -> ${to}`);
        }
        const updated = await this.store.updateTask(taskId, { status: to });
        return {
            task: updated,
            change: { taskId: updated.id, from: task.status, to, at: updated.updatedAt },
        };
    }
}
