/**
 * Planner Resume: the structured context handed back to the Planner after an
 * Executor round. Pure data assembly plus a stable Markdown renderer — no
 * model calls, no task creation, no file I/O. Rendering is a separate layer
 * so JSON/UI resumes can reuse the same PlannerContext later.
 * @module @xiaoxie-ide/dsh-devflow/planner-resume
 */
import type { Project, Result, Task } from './types.ts';
/**
 * The structured context a Planner resumes from: the project, the task that
 * produced results, those results in input order, and the task history.
 */
export interface PlannerContext {
    /** The project the workflow belongs to. */
    readonly project: Project;
    /** The task the Planner is resuming on. */
    readonly task: Task;
    /** Execution results for the current task, in input order. */
    readonly results: readonly Result[];
    /** Earlier task records, in input order (caller supplies a stable order). */
    readonly history: readonly Task[];
}
/**
 * Assemble one PlannerContext. Pure: no I/O, no events, no mutation;
 * identical inputs produce identical outputs. Results and history keep their
 * input order — the caller owns ordering (e.g. store.listTasks is
 * createdAt-sorted).
 * @param project - the project context.
 * @param task - the current task.
 * @param results - execution results for the current task.
 * @param history - earlier task records.
 * @returns the assembled context.
 */
export declare function buildPlannerContext(project: Project, task: Task, results: readonly Result[], history: readonly Task[]): PlannerContext;
/**
 * Render one PlannerContext into the fixed resume document. Pure and
 * deterministic; empty results and history are legal and render as (none).
 * The Next Planning Context section states facts only — it never invents
 * tasks or conclusions.
 * @param context - the assembled planner context.
 * @returns the resume document.
 */
export declare function renderPlannerResume(context: PlannerContext): string;
