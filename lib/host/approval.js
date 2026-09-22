/**
 * Commander approval: the replaceable proposal-judging seam between a
 * proposal and its execution. Implementations may be manual (a caller or
 * human decides) or rule based (e.g. risk posture); nothing here calls an
 * LLM. The approval only judges — execution stays with the action loop, and
 * the loop enforces that only approved proposals execute.
 * @module @xiaoxie-ide/dsh-devflow/approval
 */
/**
 * Manual approval provider: returns exactly the caller-supplied verdict and
 * judges nothing on its own — the seam for tests and future human approval
 * flows.
 * @param decide - the caller-supplied verdict function; receives the proposal
 *   so a caller can react to it without any automatic reasoning.
 */
export class ManualApprovalProvider {
    decide;
    constructor(decide) {
        this.decide = decide;
    }
    approve(proposal) {
        return this.decide(proposal);
    }
}
/**
 * Rule approval provider: approves by risk posture — high-risk proposals are
 * rejected for manual judgment, everything else is approved. Explicit,
 * deterministic, no learning.
 */
export class RuleApprovalProvider {
    approve(proposal) {
        if (proposal.riskLevel === 'high') {
            return { approved: false, reason: 'high-risk proposal requires manual approval' };
        }
        return { approved: true, reason: null };
    }
}
