/**
 * Commander decision provider seam: the replaceable decision-maker that turns
 * a commander context into a decision input. Implementations may be an LLM
 * Commander, a rule-based Commander, or a human confirmation flow — the
 * interface binds none of them, and nothing here calls a model or reasons
 * automatically. The CommanderDecision data model is untouched: the input
 * this seam produces is what a caller persists through the decision store.
 * @module @xiaoxie-ide/dsh-devflow/decision-provider
 */

import type { CommanderContext } from './commander-orchestrator.ts'
import type { CommanderActionType, CommanderDecisionType } from './types.ts'

/**
 * The decision content a provider returns for one context. Every field is
 * provider-chosen — nothing here defaults a decision type, a summary, or an
 * action intent.
 */
export interface CommanderDecisionInput {
  /** The project the decision is for (must mirror the context). */
  readonly projectId: string
  /** The checkpoint this decision reviews; null when none. */
  readonly checkpointId: string | null
  /** The execution ids this decision reviews. */
  readonly relatedExecutionIds: readonly string[]
  /** The decision kind — chosen by the provider. */
  readonly decisionType: CommanderDecisionType
  /** One-paragraph rationale summary. */
  readonly summary: string
  /** The next action the Commander will take. */
  readonly nextAction: string
  /** The control action the decision realizes. */
  readonly actionType: CommanderActionType
  /** The batch or execution the action targets. */
  readonly targetId: string
}

/** The replaceable commander decision-maker. */
export interface CommanderDecisionProvider {
  /**
   * Produce a decision input for one commander context.
   * @param context - the aggregated project context to decide on.
   * @returns the decision content the commander chose.
   */
  decide(context: CommanderContext): CommanderDecisionInput | Promise<CommanderDecisionInput>
}

/**
 * Manual decision provider: returns exactly the caller-supplied result and
 * generates nothing on its own. The default implementation — used for tests
 * and as the seam for future human-confirmation flows.
 * @param supply - the caller-supplied decision function; it receives the
 *   context so a caller can react to it without any automatic reasoning.
 */
export class ManualDecisionProvider implements CommanderDecisionProvider {
  constructor(private readonly supply: (context: CommanderContext) => CommanderDecisionInput) {}

  decide(context: CommanderContext): CommanderDecisionInput {
    return this.supply(context)
  }
}
