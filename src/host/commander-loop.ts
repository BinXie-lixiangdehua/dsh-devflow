/**
 * Commander loop runner foundation: one complete commander cycle —
 * context → decision provider → persisted decision → persisted action.
 * The runner never chooses a decision, never touches a runtime, and never
 * executes the action it creates: action execution stays with the caller.
 * Every committed change is recorded in the plugin-owned journal, so the
 * state remains replayable without extending Session.
 * @module @xiaoxie-ide/dsh-devflow/commander-loop
 */

import type { CommanderContext, CommanderOrchestrator } from './commander-orchestrator.ts'
import type { CommanderDecisionProvider } from './decision-provider.ts'
import type { CommanderDecisionValidator } from './decision-validator.ts'
import type { CommanderGovernanceChecker } from './governance.ts'
import type { DevFlowStore } from './storage.ts'

/** The outcome of one commander cycle. */
import { recordDevFlowChange } from './journal.ts'
export interface CommanderLoopResult {
  /** The processed project. */
  readonly projectId: string
  /** The context the cycle decided on. */
  readonly context: CommanderContext
  /** The persisted decision id. */
  readonly decisionId: string
  /** The persisted action id the decision realizes. */
  readonly actionId: string
  /** Cycle completion time, ISO 8601. */
  readonly completedAt: string
}

/**
 * The one-cycle commander driver. The cycle is: `processProject` for the
 * context, the decision provider for the decision input, the decision store
 * for the decision record, then the action store for the action the decision
 * realizes. When a validator is supplied, the provider's decision is
 * validated against the context before anything is persisted — an invalid
 * decision rejects the cycle. When a governance checker is supplied, the
 * decision must also pass the project's policy between validation and action
 * creation — a blocked decision rejects the cycle. The action is created but
 * never executed — the caller decides whether and when to run it through the
 * action executor.
 * @param orchestrator - the context source for the cycle.
 * @param store - the storage the decision and action records go through.
 * @param provider - the replaceable decision-maker.
 * @param validator - optional safety guard; when absent the provider is trusted.
 * @param governance - optional policy checker; when absent the policy is ignored.
 */
export class CommanderLoopRunner {
  constructor(
    private readonly orchestrator: CommanderOrchestrator,
    private readonly store: DevFlowStore,
    private readonly provider: CommanderDecisionProvider,
    private readonly validator?: CommanderDecisionValidator,
    private readonly governance?: CommanderGovernanceChecker,
  ) {}

  /**
   * Run one commander cycle for a project.
   * @param projectId - the project to cycle.
   * @returns the persisted decision and action ids with the context they were
   *   derived from.
   */
  async runCycle(projectId: string): Promise<CommanderLoopResult> {
    const completedAt = new Date().toISOString()
    const { context } = this.orchestrator.processProject(projectId)
    const input = await this.provider.decide(context)
    if (input.projectId !== projectId) {
      throw new Error(
        `devflow: commander decision provider returned a decision for project ${input.projectId}; expected ${projectId}`,
      )
    }
    if (this.validator !== undefined) {
      const validation = this.validator.validate(context, input)
      if (!validation.valid) {
        const detail = validation.errors.map(error => `${error.field}: ${error.reason}`).join('; ')
        throw new Error(`devflow: commander decision rejected: ${detail}`)
      }
    }
    if (this.governance !== undefined) {
      const policy = await this.store.getPolicy(projectId)
      const retryCount = input.actionType === 'retry_execution'
        ? (await this.store.listAttemptsByExecution(input.targetId)).length
        : 0
      const governance = this.governance.check(policy, input, retryCount)
      if (!governance.allowed) {
        throw new Error(`devflow: commander decision blocked by governance: ${governance.reason ?? 'unknown reason'}`)
      }
    }
    const decision = await this.store.createDecision({
      projectId: input.projectId,
      checkpointId: input.checkpointId,
      relatedExecutionIds: input.relatedExecutionIds,
      decisionType: input.decisionType,
      summary: input.summary,
      nextAction: input.nextAction,
    })
    await recordDevFlowChange(this.store, 'devflow/commander/decision/create', { decision })
    const action = await this.store.createAction({
      decisionId: decision.decisionId,
      actionType: input.actionType,
      targetId: input.targetId,
    })
    await recordDevFlowChange(this.store, 'devflow/commander/action/create', { action })
    return {
      projectId,
      context,
      decisionId: decision.decisionId,
      actionId: action.actionId,
      completedAt,
    }
  }
}
