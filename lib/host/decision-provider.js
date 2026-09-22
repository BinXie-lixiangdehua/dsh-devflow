/**
 * Commander decision provider seam: the replaceable decision-maker that turns
 * a commander context into a decision input. Implementations may be an LLM
 * Commander, a rule-based Commander, or a human confirmation flow — the
 * interface binds none of them, and nothing here calls a model or reasons
 * automatically. The CommanderDecision data model is untouched: the input
 * this seam produces is what a caller persists through the decision store.
 * @module @xiaoxie-ide/dsh-devflow/decision-provider
 */
/**
 * Manual decision provider: returns exactly the caller-supplied result and
 * generates nothing on its own. The default implementation — used for tests
 * and as the seam for future human-confirmation flows.
 * @param supply - the caller-supplied decision function; it receives the
 *   context so a caller can react to it without any automatic reasoning.
 */
export class ManualDecisionProvider {
    supply;
    constructor(supply) {
        this.supply = supply;
    }
    decide(context) {
        return this.supply(context);
    }
}
