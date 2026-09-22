/**
 * Commander review conversion boundary: the pure data bridge between a
 * commander review and a future commander decision. Conversion only — the
 * caller supplies the decision content explicitly, so no decision is ever
 * generated automatically.
 * @module @xiaoxie-ide/dsh-devflow/review-bridge
 */

import type { CommanderDecision, CommanderDecisionType, CommanderReview } from './types.ts'

/** The decision content a caller supplies when converting a review. */
export interface ReviewDecisionInput {
  /** The decision kind the Commander picked explicitly. */
  readonly decisionType: CommanderDecisionType
  /** One-paragraph rationale summary. */
  readonly summary: string
  /** The next action the Commander will take. */
  readonly nextAction: string
  /** The checkpoint this decision reviews; null when none. */
  readonly checkpointId?: string | null
}

/**
 * Build the durable commander-decision input from a review and explicit
 * decision content. The review's project and execution link the decision
 * (`relatedExecutionIds` names the reviewed execution); the decision type,
 * summary, and next action come from the caller — this function never
 * chooses a decision. Intended for a completed (`reviewed`) review; the
 * caller decides when the conversion is legitimate.
 * @param review - the review being converted.
 * @param input - the caller-supplied decision content.
 * @returns the decision record fields ready for `DevFlowStore.createDecision`.
 */
export function buildCommanderDecisionInput(
  review: CommanderReview,
  input: ReviewDecisionInput,
): Omit<CommanderDecision, 'decisionId' | 'createdAt' | 'updatedAt'> {
  return {
    projectId: review.projectId,
    checkpointId: input.checkpointId ?? null,
    relatedExecutionIds: [review.executionId],
    decisionType: input.decisionType,
    summary: input.summary,
    nextAction: input.nextAction,
  }
}
