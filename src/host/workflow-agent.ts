/**
 * DevFlow Agent collaboration flow: the Planner → DevFlow → Executor loop
 * composed over the store, the task lifecycle, and the handoff protocol.
 * This layer simulates the workflow only — no model calls, no Agent
 * instances, no registry, no scheduling, no parallelism.
 * @module @xiaoxie-ide/dsh-devflow/workflow-agent
 */

import type { Project, Result } from './types.ts'
import { createTaskPackage, type AgentTaskPackage } from './protocol.ts'
import type { ResultVerdict } from './types.ts'
import { MarkdownBridge } from './markdown-bridge.ts'
import type { DevFlowStore } from './storage.ts'
import type { TaskTransitionResult, TaskWorkflow } from './workflow.ts'
import { buildPlannerContext, renderPlannerResume, type PlannerContext } from './planner-resume.ts'
import { prepareTaskPackage } from './package-preflight.ts'
import type { Task } from './types.ts'

/** The task fields the Planner supplies when opening a planning task. */
export interface PlanningTaskInput {
  /** Human-readable task title. */
  readonly title: string
  /** Free-form task description. */
  readonly description: string
}

/** The result fields the Executor supplies when submitting execution output. */
export type ExecutionResultInput = Omit<Result, 'id' | 'createdAt' | 'taskId'>

/** One submitted execution result plus the transition it triggered. */
export interface ExecutionSubmission {
  /** The archived result record. */
  readonly result: Result
  /** The `executing -> reviewing` transition. */
  readonly transition: TaskTransitionResult
}

/**
 * Agent collaboration flow over the file-backed store and task lifecycle.
 * @param store - the storage all tasks and results go through.
 * @param workflow - the task lifecycle manager.
 */
export class AgentWorkflow {
  private readonly bridge = new MarkdownBridge()

  constructor(
    private readonly store: DevFlowStore,
    private readonly workflow: TaskWorkflow,
  ) {}

  /**
   * Export one task as its handoff Markdown document: task + project →
   * AgentTaskPackage → MarkdownBridge. Unknown tasks and missing projects
   * fail loud.
   * @param taskId - the task to export.
   * @returns the task id and the rendered Markdown.
   */
  async exportTask(
    taskId: string,
    onProjectUpdate?: (project: Project) => Promise<void>,
  ): Promise<{ taskId: string; markdown: string }> {
    const prepared = await prepareTaskPackage(this.store, taskId, {}, onProjectUpdate)
    return { taskId, markdown: this.bridge.exportTask(prepared.package) }
  }

  /**
   * Planner flow: open a planning task for the given project and hand back
   * its task package. The task is created in `created` with the planner
   * role, then advanced to `planned` (the plan is done), and packaged for
   * handoff.
   * @param project - the project context the task belongs to.
   * @param input - the task title and description.
   * @returns the planner task package ready for handoff.
   */
  async createPlanningTask(project: Project, input: PlanningTaskInput): Promise<AgentTaskPackage> {
    const task = await this.workflow.createTask({
      title: input.title,
      description: input.description,
      status: 'created',
      assignedRole: 'planner',
    })
    const { task: planned } = await this.workflow.planTask(task.id)
    return createTaskPackage(planned, project, { role: 'planner' })
  }

  /**
   * Executor flow, step one: accept a task package and start executing its
   * task (`planned -> executing`). The task must exist and be in `planned`;
   * any other status is rejected by the lifecycle.
   * @param pkg - the task package the Executor received.
   * @returns the transition to `executing`.
   */
  async assignExecutor(pkg: AgentTaskPackage): Promise<TaskTransitionResult> {
    const task = await this.store.getTask(pkg.taskId)
    if (task === undefined) {
      throw new Error(`devflow: cannot assign executor to unknown task ${pkg.taskId}`)
    }
    return this.workflow.startExecution(task.id)
  }

  /**
   * Executor flow, step two: archive the execution result and move the task
   * to `reviewing` (`executing -> reviewing`). The task must be in
   * `executing`; the status is checked before the result is written, so a
   * rejected submission leaves no orphan result behind.
   * @param pkg - the task package the Executor received.
   * @param input - the execution result fields.
   * @returns the archived result and the transition it triggered.
   */
  async submitExecutionResult(pkg: AgentTaskPackage, input: ExecutionResultInput): Promise<ExecutionSubmission> {
    return this.submitResult(pkg.taskId, input)
  }

  /**
   * Archive one execution result and move its task to `reviewing`. Shared by
   * the package-driven and the import-driven flows; the task must be in
   * `executing`, checked before the result is written.
   * @param taskId - the task the result belongs to.
   * @param input - the execution result fields.
   * @returns the archived result and the transition it triggered.
   */
  async submitResult(taskId: string, input: ExecutionResultInput): Promise<ExecutionSubmission> {
    const task = await this.store.getTask(taskId)
    if (task === undefined) {
      throw new Error(`devflow: cannot submit an execution result for unknown task ${taskId}`)
    }
    if (task.status !== 'executing') {
      throw new Error(
        `devflow: cannot submit an execution result for task ${taskId} in status ${task.status}; expected executing`,
      )
    }
    const result = await this.store.saveResult({ taskId: task.id, ...input })
    const transition = await this.workflow.submitReview(task.id)
    return { result, transition }
  }

  /**
   * Import one Markdown result document: parse it through the MarkdownBridge
   * (fail loud on malformed input), require the document's task id to match,
   * then archive and advance through the shared result flow.
   * @param taskId - the expected task the document answers.
   * @param markdown - the result document produced by an external Agent.
   * @returns the archived result, transition, protocol version, and review verdict.
   */
  async importResult(taskId: string, markdown: string): Promise<ExecutionSubmission & { protocolVersion: string; verdict: ResultVerdict }> {
    const pkg = this.bridge.importResult(markdown)
    if (pkg.taskId !== taskId) {
      throw new Error(`devflow: result document targets task ${pkg.taskId}, expected ${taskId}`)
    }
    const submission = await this.submitResult(taskId, {
      summary: pkg.summary,
      changes: pkg.changes,
      verification: pkg.verification,
      issues: pkg.issues,
      nextSteps: pkg.nextSteps,
    })
    return { ...submission, protocolVersion: pkg.protocolVersion, verdict: pkg.verdict }
  }

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
  async resumePlanner(
    taskId: string,
    results: readonly Result[],
    history: readonly Task[],
  ): Promise<{ context: PlannerContext; resume: string }> {
    const task = await this.store.getTask(taskId)
    if (task === undefined) {
      throw new Error(`devflow: cannot resume planner for unknown task ${taskId}`)
    }
    const project = await this.store.loadProject()
    if (project === undefined) {
      throw new Error('devflow: no project initialized; save a project before resuming the planner')
    }
    const context = buildPlannerContext(project, task, results, history)
    return { context, resume: renderPlannerResume(context) }
  }

  /**
   * Resume one task with its own stored facts: results for the task come
   * from the store (oldest first) and history from the full task list
   * (oldest first), then the resume document is rendered.
   * @param taskId - the task the Planner resumes on.
   * @returns the assembled context and its rendered resume document.
   */
  async resumeTask(taskId: string): Promise<{ context: PlannerContext; resume: string }> {
    const results = await this.store.listResultsByTask(taskId)
    const history = await this.store.listTasks()
    return this.resumePlanner(taskId, results, history)
  }
}
