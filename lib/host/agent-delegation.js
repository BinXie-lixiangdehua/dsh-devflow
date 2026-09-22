/**
 * Agent delegation-depth policy. The function derives a child budget without
 * changing the parent's durable configuration or creating execution records.
 * @module @xiaoxie-ide/dsh-devflow/agent-delegation
 */
/**
 * Derive the only allowed child delegation budget from the parent's remaining
 * budget. Future dispatchers must use this result with DevFlowStore.registerAgent,
 * createAssignment, createExecutionRecord, and AgentRuntimeExecutor.
 * @param parent - the agent that requests a temporary child.
 * @returns the authorization decision and derived child budget.
 */
export function evaluateChildAgentDispatch(parent) {
    if (parent.delegationDepth === 0) {
        return { allowed: false, reason: 'agent delegation depth exhausted', childDelegationDepth: null };
    }
    return { allowed: true, reason: null, childDelegationDepth: parent.delegationDepth - 1 };
}
