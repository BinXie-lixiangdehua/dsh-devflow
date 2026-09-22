/**
 * Commander decision validation: the safety layer that blocks a decision
 * before it reaches the decision/action stores. The provider may produce
 * wrong decisions — this layer rejects them with structured findings and
 * never crashes on invalid input. Purely a guard: the driver, loop runner,
 * and action executor keep their responsibilities, and no model, embedding,
 * or vector store is involved.
 * @module @xiaoxie-ide/dsh-devflow/decision-validator
 */

import type { CommanderContext } from './commander-orchestrator.ts'
import type { CommanderDecisionInput } from './decision-provider.ts'
import type { DevFlowProjectionState } from './types.ts'

/** The decision field a finding names. */
export type DecisionValidationField = 'projectId' | 'relatedExecutionIds' | 'actionType' | 'targetId'

/** One structured validation finding. */
export interface DecisionValidationError {
  /** The field that failed. */
  readonly field: DecisionValidationField
  /** Why the field failed. */
  readonly reason: string
}

/** The outcome of validating one decision input. */
export interface DecisionValidationResult {
  /** Whether the decision may be persisted. */
  readonly valid: boolean
  /** Every finding; empty when valid. */
  readonly errors: readonly DecisionValidationError[]
}

/**
 * The decision safety guard. `validate` checks that the decision's project
 * matches the context, that every related execution belongs to the project,
 * and that the action target exists and matches the action kind: a
 * `retry_execution` must target an execution of the project, and a batch
 * action must target a batch of the project.
 * @param readState - the projection-state reader used to resolve batch
 *   targets (execution targets resolve from the context alone).
 */
export class CommanderDecisionValidator {
  constructor(private readonly readState: () => DevFlowProjectionState) {}

  /**
   * Validate one decision input against the context.
   * @param context - the context the decision was derived from.
   * @param input - the decision to validate.
   * @returns the validation outcome; never throws for invalid decisions.
   */
  validate(context: CommanderContext, input: CommanderDecisionInput): DecisionValidationResult {
    const errors: DecisionValidationError[] = []
    if (input.projectId !== context.projectId) {
      errors.push({
        field: 'projectId',
        reason: `decision project ${input.projectId} does not match context project ${context.projectId}`,
      })
    }
    const executionIds = new Set(context.currentExecutions.map(execution => execution.executionId))
    for (const executionId of input.relatedExecutionIds) {
      if (!executionIds.has(executionId)) {
        errors.push({
          field: 'relatedExecutionIds',
          reason: `execution ${executionId} does not belong to project ${context.projectId}`,
        })
      }
    }
    if (input.actionType === 'retry_execution') {
      if (!executionIds.has(input.targetId)) {
        errors.push({
          field: 'targetId',
          reason: `retry_execution targets unknown execution ${input.targetId}`,
        })
      }
    } else {
      const batch = this.readState().executionBatches[input.targetId]
      if (batch === undefined || batch.projectId !== context.projectId) {
        errors.push({
          field: 'targetId',
          reason: `${input.actionType} targets unknown batch ${input.targetId}`,
        })
      }
    }
    return { valid: errors.length === 0, errors }
  }
}
