/**
 * Commander governance: the policy-driven constraint check a decision must
 * pass before its action is created. The checker only judges — it never
 * generates a decision, never executes an action, never modifies the
 * runtime, and never writes memory. With no policy the check is a pass (old
 * behavior compatible).
 * @module @xiaoxie-ide/dsh-devflow/governance
 */

import type { CommanderDecisionInput } from './decision-provider.ts'
import type { CommanderPolicy } from './types.ts'

/** The outcome of one governance check. */
export interface CommanderGovernanceResult {
  /** Whether the decision may proceed to action creation. */
  readonly allowed: boolean
  /** The blocking reason; null when allowed. */
  readonly reason: string | null
  /** Whether the action type requires an approved proposal before execution. */
  readonly requiresApproval: boolean
}

/**
 * The policy-driven governance judge. Pure and deterministic: the same
 * policy, decision input, and retry count always yield the same result.
 */
export class CommanderGovernanceChecker {
  /**
   * Check one decision input against a project's policy.
   * @param policy - the project policy; undefined means no constraints.
   * @param input - the decision to judge.
   * @param retryCount - the number of attempts already recorded for the
   *   target execution (relevant for `retry_execution`).
   * @returns the governance verdict.
   */
  check(
    policy: Omit<CommanderPolicy, 'createdAt' | 'updatedAt'> | undefined,
    input: CommanderDecisionInput,
    retryCount: number,
  ): CommanderGovernanceResult {
    if (policy === undefined) {
      return { allowed: true, reason: null, requiresApproval: false }
    }
    if (!policy.allowedActionTypes.includes(input.actionType)) {
      return {
        allowed: false,
        reason: `action type ${input.actionType} is not allowed by the policy of ${policy.projectId}`,
        requiresApproval: false,
      }
    }
    if (input.actionType === 'retry_execution' && retryCount >= policy.maxRetryCount) {
      return {
        allowed: false,
        reason: `retry limit ${policy.maxRetryCount} reached for execution ${input.targetId}`,
        requiresApproval: false,
      }
    }
    return {
      allowed: true,
      reason: null,
      requiresApproval: policy.requireApprovalActionTypes.includes(input.actionType),
    }
  }
}
