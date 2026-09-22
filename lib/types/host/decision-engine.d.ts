/**
 * Commander decision engine: the default rule-based decision provider.
 * Each rule maps a context state to a decision input; rules are explicit,
 * deterministic, and applied in order — no randomness, no LLM, no side
 * effects. The engine only converts Context → Decision: it never executes
 * actions, never modifies state, never calls a runtime, and never writes
 * memory. The `DecisionRule` seam lets a rule-based, LLM, or human commander
 * coexist behind the same `CommanderDecisionProvider` interface.
 * @module @xiaoxie-ide/dsh-devflow/decision-engine
 */
import type { CommanderContext } from './commander-orchestrator.ts';
import type { CommanderDecisionInput, CommanderDecisionProvider } from './decision-provider.ts';
import type { CommanderExperienceContext } from './experience.ts';
/**
 * One deterministic decision rule: it matches a context state and produces
 * the decision for it. Rules are pure — same context, same decision. A rule
 * may additionally receive the project's experience insights (warnings and
 * preferences derived from memory); the parameter is optional so rules that
 * ignore experience are unchanged.
 */
export interface DecisionRule {
    /** Stable rule name for diagnostics and tests. */
    readonly name: string;
    /** Whether this rule applies to the context (and its experience). */
    matches(context: CommanderContext, experience?: CommanderExperienceContext | null): boolean;
    /** The decision input this rule produces when it applies. */
    decide(context: CommanderContext, experience?: CommanderExperienceContext | null): CommanderDecisionInput;
}
/**
 * The default rule set, applied in precedence order:
 * 1. `pending-reviews` — any pending review → `request_user` + `pause_batch`
 *    on the reviewed execution's batch.
 * 2. `failed-execution` — the first failed execution → `retry` +
 *    `retry_execution` on it.
 * 3. `all-completed` — every execution completed → `continue` +
 *    `complete_batch` on the first batch.
 * 4. `default-continue` — anything else (no anomalies) → `continue` +
 *    `start_batch` on the first pending execution's batch.
 * The rules never inspect anything beyond the context.
 * @returns the standard rule list in precedence order.
 */
export declare function createDefaultDecisionRules(): readonly DecisionRule[];
/**
 * The default rule-based decision engine: applies its rules in order and
 * returns the first matching rule's decision. A rule set that matches
 * nothing fails loud rather than guessing. When an experience reader is
 * supplied, each rule also receives the project's experience insights —
 * information only, never a forced decision. Pure — the engine holds no
 * store, no session, and no model.
 * @param rules - the rules to apply, in precedence order.
 * @param experience - optional reader of the project's experience context;
 *   rules receive null when absent.
 */
export declare class CommanderDecisionEngine implements CommanderDecisionProvider {
    private readonly rules;
    private readonly experience?;
    constructor(rules: readonly DecisionRule[], experience?: (() => CommanderExperienceContext | null) | undefined);
    decide(context: CommanderContext): CommanderDecisionInput;
}
