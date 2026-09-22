/**
 * DevFlow task lifecycle: the five-state machine (`created → planned →
 * executing → reviewing → completed`) plus the allowed rework edge
 * (`reviewing → executing`). TaskWorkflow owns no scheduling, Agent
 * registry, or model calls — it only validates transitions against the
 * TRANSITIONS table and persists each committed change through the store.
 * @module @xiaoxie-ide/dsh-devflow/workflow
 */
import type { Task, TaskStatus, TaskStatusChange } from './types.ts';
import type { DevFlowStore } from './storage.ts';
/** Allowed transitions per status; cancelled is terminal while failed/completed may be re-planned. */
export declare const TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>>;
/** One validated transition: the updated task plus its audit record. */
export interface TaskTransitionResult {
    /** The task after the transition. */
    readonly task: Task;
    /** The committed status change. */
    readonly change: TaskStatusChange;
}
/**
 * Task lifecycle manager over the file-backed store. Every transition
 * validates the current status, applies the change, and persists it.
 * @param store - the storage all tasks and changes go through.
 */
export declare class TaskWorkflow {
    private readonly store;
    constructor(store: DevFlowStore);
    /**
     * Create one task in the initial `created` state.
     * @param input - task fields without the store-owned id and timestamps.
     * @returns the persisted task.
     */
    createTask(input: Omit<Task, 'id' | 'createdAt' | 'updatedAt'>): Promise<Task>;
    /**
     * Move one task to `planned` (`created -> planned`).
     * @param taskId - the task to plan.
     * @returns the updated task and its change record.
     */
    planTask(taskId: string): Promise<TaskTransitionResult>;
    /**
     * Move one task to `executing` (`planned -> executing`, or the
     * `reviewing -> executing` rework edge).
     * @param taskId - the task to start.
     * @returns the updated task and its change record.
     */
    startExecution(taskId: string): Promise<TaskTransitionResult>;
    /**
     * Move one task to `reviewing` (`executing -> reviewing`).
     * @param taskId - the task to submit for review.
     * @returns the updated task and its change record.
     */
    submitReview(taskId: string): Promise<TaskTransitionResult>;
    /** Settle one executing task as failed after its execution cannot complete. */
    failTask(taskId: string): Promise<TaskTransitionResult>;
    /** Cancel a task before or during execution; cancelled tasks are terminal. */
    cancelTask(taskId: string): Promise<TaskTransitionResult>;
    /**
     * Move one task to `completed` (`reviewing -> completed`).
     * @param taskId - the task to complete.
     * @returns the updated task and its change record.
     */
    completeTask(taskId: string): Promise<TaskTransitionResult>;
    /**
     * Validate one transition against the TRANSITIONS table, persist it, and
     * return the updated task with its audit record. Illegal transitions and
     * unknown tasks fail loud.
     * @param taskId - the task to transition.
     * @param to - the target status.
     * @returns the updated task and its change record.
     */
    private transition;
}
