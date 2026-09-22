/**
 * Agent delegation-depth policy. The function derives a child budget without
 * changing the parent's durable configuration or creating execution records.
 * @module @xiaoxie-ide/dsh-devflow/agent-delegation
 */
import type { OrchestrationAgent } from './types.ts';
/** The authorization result for an attempted child-agent dispatch. */
export interface ChildAgentDispatchDecision {
    /** Whether the parent has a remaining delegation level. */
    readonly allowed: boolean;
    /** Stable failure identifier, or null when dispatch is allowed. */
    readonly reason: string | null;
    /** The derived child budget, or null when dispatch is forbidden. */
    readonly childDelegationDepth: number | null;
}
/**
 * Derive the only allowed child delegation budget from the parent's remaining
 * budget. Future dispatchers must use this result with DevFlowStore.registerAgent,
 * createAssignment, createExecutionRecord, and AgentRuntimeExecutor.
 * @param parent - the agent that requests a temporary child.
 * @returns the authorization decision and derived child budget.
 */
export declare function evaluateChildAgentDispatch(parent: Pick<OrchestrationAgent, 'delegationDepth'>): ChildAgentDispatchDecision;
