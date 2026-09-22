/**
 * DevFlow Agent collaboration flow: the Planner → DevFlow → Executor loop
 * composed over the store, the task lifecycle, and the handoff protocol.
 * This layer simulates the workflow only — no model calls, no Agent
 * instances, no registry, no scheduling, no parallelism.
 * @module @xiaoxie-ide/dsh-devflow/workflow-agent
 */
import type { Project, Result } from './types.ts';
import { type AgentTaskPackage } from './protocol.ts';
import type { ResultVerdict } from './types.ts';
import type { DevFlowStore } from './storage.ts';
import type { TaskTransitionResult, TaskWorkflow } from './workflow.ts';
import { type PlannerContext } from './planner-resume.ts';
import type { Task } from './types.ts';
/** The task fields the Planner supplies when opening a planning task. */
export interface PlanningTaskInput {
    /** Human-readable task title. */
    readonly title: string;
    /** Free-form task description. */
    readonly description: string;
}
/** The result fields the Executor supplies when submitting execution output. */
export type ExecutionResultInput = Omit<Result, 'id' | 'createdAt' | 'taskId'>;
/** One submitted execution result plus the transition it triggered. */
export interface ExecutionSubmission {
    /** The archived result record. */
    readonly result: Result;
    /** The `executing -> reviewing` transition. */
    readonly transition: TaskTransitionResult;
}
/**
 * Agent collaboration flow over the file-backed store and task lifecycle.
 * @param store - the storage all tasks and results go through.
 * @param workflow - the task lifecycle manager.
 */
export declare class AgentWorkflow {
    private readonly store;
    private readonly workflow;
    private readonly bridge;
    constructor(store: DevFlowStore, workflow: TaskWorkflow);
    /**
     * Export one task as its handoff Markdown document: task + project →
     * AgentTaskPackage → MarkdownBridge. Unknown tasks and missing projects
     * fail loud.
     * @param taskId - the task to export.
     * @returns the task id and the rendered Markdown.
     */
    exportTask(taskId: string, onProjectUpdate?: (project: Project) => Promise<void>): Promise<{
        taskId: string;
        markdown: string;
    }>;
    /**
     * Planner flow: open a planning task for the given project and hand back
     * its task package. The task is created in `created` with the planner
     * role, then advanced to `planned` (the plan is done), and packaged for
     * handoff.
     * @param project - the project context the task belongs to.
     * @param input - the task title and description.
     * @returns the planner task package ready for handoff.
     */
    createPlanningTask(project: Project, input: PlanningTaskInput): Promise<AgentTaskPackage>;
    /**
     * Executor flow, step one: accept a task package and start executing its
     * task (`planned -> executing`). The task must exist and be in `planned`;
     * any other status is rejected by the lifecycle.
     * @param pkg - the task package the Executor received.
     * @returns the transition to `executing`.
     */
    assignExecutor(pkg: AgentTaskPackage): Promise<TaskTransitionResult>;
    /**
     * Executor flow, step two: archive the execution result and move the task
     * to `reviewing` (`executing -> reviewing`). The task must be in
     * `executing`; the status is checked before the result is written, so a
     * rejected submission leaves no orphan result behind.
     * @param pkg - the task package the Executor received.
     * @param input - the execution result fields.
     * @returns the archived result and the transition it triggered.
     */
    submitExecutionResult(pkg: AgentTaskPackage, input: ExecutionResultInput): Promise<ExecutionSubmission>;
    /**
     * Archive one execution result and move its task to `reviewing`. Shared by
     * the package-driven and the import-driven flows; the task must be in
     * `executing`, checked before the result is written.
     * @param taskId - the task the result belongs to.
     * @param input - the execution result fields.
     * @returns the archived result and the transition it triggered.
     */
    submitResult(taskId: string, input: ExecutionResultInput): Promise<ExecutionSubmission>;
    /**
     * Import one Markdown result document: parse it through the MarkdownBridge
     * (fail loud on malformed input), require the document's task id to match,
     * then archive and advance through the shared result flow.
     * @param taskId - the expected task the document answers.
     * @param markdown - the result document produced by an external Agent.
     * @returns the archived result, transition, protocol version, and review verdict.
     */
    importResult(taskId: string, markdown: string): Promise<ExecutionSubmission & {
        protocolVersion: string;
        verdict: ResultVerdict;
    }>;
    /**
     * Planner flow, resume step: assemble the PlannerContext for one task and
     * render its resume document. Pure assembly — no model calls, no task
     * creation, no scheduling. Results and history arrive from the caller in
     * deterministic order; the store supplies the project and current task,
     * failing loud when either is missing.
     * @param taskId - the task the Planner resumes on.
     * @param results - execution results for the task, in order.
     * @param history - earlier task records, in order.
     * @returns the assembled context and its rendered resume document.
     */
    resumePlanner(taskId: string, results: readonly Result[], history: readonly Task[]): Promise<{
        context: PlannerContext;
        resume: string;
    }>;
    /**
     * Resume one task with its own stored facts: results for the task come
     * from the store (oldest first) and history from the full task list
     * (oldest first), then the resume document is rendered.
     * @param taskId - the task the Planner resumes on.
     * @returns the assembled context and its rendered resume document.
     */
    resumeTask(taskId: string): Promise<{
        context: PlannerContext;
        resume: string;
    }>;
}
