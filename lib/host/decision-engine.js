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
/** The batch id of one execution (or the first execution) in the context; '' when none. */
function resolveBatchId(context, executionId) {
    if (executionId !== undefined) {
        const execution = context.currentExecutions.find(item => item.executionId === executionId);
        if (execution !== undefined)
            return execution.batchId;
    }
    return context.currentExecutions[0]?.batchId ?? '';
}
/** The latest checkpoint id in the context; null when none. */
function latestCheckpointId(context) {
    return context.checkpoints[context.checkpoints.length - 1]?.checkpointId ?? null;
}
/** Fail loud when a rule's precondition vanished before its decide ran. */
function mustBeDefined(value, what) {
    if (value === undefined)
        throw new Error(`devflow: decision rule precondition missing: ${what}`);
    return value;
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
export function createDefaultDecisionRules() {
    const pendingReviewsRule = {
        name: 'pending-reviews',
        matches: context => context.pendingReviews.length > 0,
        decide: (context) => {
            const review = mustBeDefined(context.pendingReviews[0], 'pending review');
            return {
                projectId: context.projectId,
                checkpointId: latestCheckpointId(context),
                relatedExecutionIds: [review.executionId],
                decisionType: 'request_user',
                summary: `${context.pendingReviews.length} pending review(s) await input`,
                nextAction: 'await user input on the pending reviews',
                actionType: 'pause_batch',
                targetId: resolveBatchId(context, review.executionId),
            };
        },
    };
    const failedExecutionRule = {
        name: 'failed-execution',
        matches: context => context.currentExecutions.some(execution => execution.status === 'failed'),
        decide: (context) => {
            const execution = mustBeDefined(context.currentExecutions.find(item => item.status === 'failed'), 'failed execution');
            return {
                projectId: context.projectId,
                checkpointId: latestCheckpointId(context),
                relatedExecutionIds: [execution.executionId],
                decisionType: 'retry',
                summary: `execution ${execution.executionId} failed`,
                nextAction: `retry execution ${execution.executionId}`,
                actionType: 'retry_execution',
                targetId: execution.executionId,
            };
        },
    };
    const allCompletedRule = {
        name: 'all-completed',
        matches: context => context.currentExecutions.length > 0
            && context.currentExecutions.every(execution => execution.status === 'completed'),
        decide: (context) => {
            const execution = mustBeDefined(context.currentExecutions[0], 'execution');
            return {
                projectId: context.projectId,
                checkpointId: latestCheckpointId(context),
                relatedExecutionIds: context.currentExecutions.map(item => item.executionId),
                decisionType: 'continue',
                summary: 'all executions completed',
                nextAction: `complete batch ${execution.batchId}`,
                actionType: 'complete_batch',
                targetId: execution.batchId,
            };
        },
    };
    const defaultContinueRule = {
        name: 'default-continue',
        matches: () => true,
        decide: (context) => {
            const execution = context.currentExecutions.find(item => item.status === 'pending') ?? context.currentExecutions[0];
            return {
                projectId: context.projectId,
                checkpointId: latestCheckpointId(context),
                relatedExecutionIds: execution === undefined ? [] : [execution.executionId],
                decisionType: 'continue',
                summary: 'no anomalies',
                nextAction: execution === undefined ? 'await executions' : `start batch ${execution.batchId}`,
                actionType: 'start_batch',
                targetId: execution?.batchId ?? '',
            };
        },
    };
    return [pendingReviewsRule, failedExecutionRule, allCompletedRule, defaultContinueRule];
}
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
export class CommanderDecisionEngine {
    rules;
    experience;
    constructor(rules, experience) {
        this.rules = rules;
        this.experience = experience;
    }
    decide(context) {
        const experience = this.experience === undefined ? null : this.experience();
        for (const rule of this.rules) {
            if (rule.matches(context, experience))
                return rule.decide(context, experience);
        }
        throw new Error('devflow: commander decision engine has no matching rule');
    }
}
