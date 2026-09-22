/**
 * Commander interaction layer: the user-facing boundary between a future
 * Harness Commander Mode (or CLI/UI) and the DevFlow commander. It receives
 * user intent, creates or queries workflows, invokes the existing task
 * orchestrator, and returns status information — it never implements workflow
 * logic, never modifies domain state, and never bypasses the event store
 * (every committed change flows through the orchestrator's event-logged
 * seams). The layer holds no decision, governance, approval, or runtime
 * responsibility.
 * @module @xiaoxie-ide/dsh-devflow/commander-interaction
 */

import type { CommanderTaskOrchestrator, CommanderTaskStepOutcome } from './task-orchestrator.ts'
import type { DevFlowStore } from './storage.ts'
import type { CommanderWorkflow, CommanderWorkflowStep } from './types.ts'

/** The user intent kinds the commander interaction layer understands. */
export type CommanderInteractionKind = 'create_workflow' | 'run_step' | 'workflow_status'

/** The workflow intent of a `create_workflow` request. */
export interface CommanderWorkflowIntent {
  /** The development task title. */
  readonly title: string
  /** The development task description. */
  readonly description: string
  /** The ordered step titles the workflow is planned with. */
  readonly steps: readonly string[]
}

/** One user request to the commander interaction layer. */
export interface CommanderInteractionRequest {
  /** The user intent kind. */
  readonly kind: CommanderInteractionKind
  /** The project the request concerns (slug id). */
  readonly projectId: string
  /** The workflow the request concerns; required for `run_step` and `workflow_status`. */
  readonly workflowId?: string
  /** The workflow intent; required for `create_workflow`. */
  readonly intent?: CommanderWorkflowIntent
}

/** The response to one commander interaction request. */
export interface CommanderInteractionResponse {
  /** The answered intent kind. */
  readonly kind: CommanderInteractionKind
  /** The project the request concerned. */
  readonly projectId: string
  /** The workflow the request created or queried; null when it could not be resolved. */
  readonly workflow: CommanderWorkflow | null
  /** The workflow's steps (created or current); empty when the workflow is unknown. */
  readonly steps: readonly CommanderWorkflowStep[]
  /** The step outcome a `run_step` produced; null for other kinds or when nothing ran. */
  readonly outcome: CommanderTaskStepOutcome | null
  /** The failure message; null on success. */
  readonly error: string | null
}

/**
 * The commander interaction layer: the single entry for user intent. Each
 * request maps to one delegation — `create_workflow` plans through the task
 * orchestrator, `run_step` advances one workflow step through the full
 * commander chain, and `workflow_status` reads the workflow and its steps
 * without writing anything. Invalid requests and orchestrator failures
 * normalize into error responses instead of throwing.
 * @param orchestrator - the task orchestrator the layer delegates to.
 * @param store - the storage the read-only queries go through.
 */
export class CommanderInteractionLayer {
  constructor(
    private readonly orchestrator: CommanderTaskOrchestrator,
    private readonly store: DevFlowStore,
  ) {}

  /**
   * Handle one user request.
   * @param request - the user intent.
   * @returns the status response; never throws for user-level failures.
   */
  async handle(request: CommanderInteractionRequest): Promise<CommanderInteractionResponse> {
    switch (request.kind) {
      case 'create_workflow': return this.createWorkflow(request)
      case 'run_step': return this.runStep(request)
      case 'workflow_status': return this.workflowStatus(request)
    }
  }

  /** Create a workflow through the task orchestrator (task planning). */
  private async createWorkflow(request: CommanderInteractionRequest): Promise<CommanderInteractionResponse> {
    const intent = request.intent
    if (intent === undefined) {
      return this.errorResponse(request, 'create_workflow requires a workflow intent')
    }
    try {
      const plan = await this.orchestrator.planWorkflow({
        projectId: request.projectId,
        title: intent.title,
        description: intent.description,
        steps: intent.steps,
      })
      return {
        kind: request.kind,
        projectId: request.projectId,
        workflow: plan.workflow,
        steps: plan.steps,
        outcome: null,
        error: null,
      }
    } catch (cause) {
      return this.errorResponse(request, cause instanceof Error ? cause.message : String(cause))
    }
  }

  /** Run the next pending workflow step through the task orchestrator. */
  private async runStep(request: CommanderInteractionRequest): Promise<CommanderInteractionResponse> {
    const workflowId = request.workflowId
    if (workflowId === undefined) {
      return this.errorResponse(request, 'run_step requires a workflowId')
    }
    try {
      const outcome = await this.orchestrator.runNextStep(workflowId)
      const workflow = await this.store.getWorkflow(workflowId)
      const steps = await this.store.listStepsByWorkflow(workflowId)
      return {
        kind: request.kind,
        projectId: request.projectId,
        workflow: workflow ?? null,
        steps,
        outcome,
        error: null,
      }
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause)
      const workflow = await this.store.getWorkflow(workflowId)
      const steps = workflow === undefined ? [] : await this.store.listStepsByWorkflow(workflowId)
      return { kind: request.kind, projectId: request.projectId, workflow: workflow ?? null, steps, outcome: null, error }
    }
  }

  /** Read the workflow and its steps without writing anything. */
  private async workflowStatus(request: CommanderInteractionRequest): Promise<CommanderInteractionResponse> {
    const workflowId = request.workflowId
    if (workflowId === undefined) {
      return this.errorResponse(request, 'workflow_status requires a workflowId')
    }
    const workflow = await this.store.getWorkflow(workflowId)
    if (workflow === undefined) {
      return this.errorResponse(request, `unknown workflow ${workflowId}`)
    }
    const steps = await this.store.listStepsByWorkflow(workflowId)
    return { kind: request.kind, projectId: request.projectId, workflow, steps, outcome: null, error: null }
  }

  /** The standardized failure response for one request. */
  private errorResponse(request: CommanderInteractionRequest, error: string): CommanderInteractionResponse {
    return { kind: request.kind, projectId: request.projectId, workflow: null, steps: [], outcome: null, error }
  }
}
