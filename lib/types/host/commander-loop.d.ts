/**
 * Commander loop runner foundation: one complete commander cycle —
 * context → decision provider → persisted decision → persisted action.
 * The runner never chooses a decision, never touches a runtime, and never
 * executes the action it creates: action execution stays with the caller.
 * Every committed change is recorded in the plugin-owned journal, so the
 * state remains replayable without extending Session.
 * @module @xiaoxie-ide/dsh-devflow/commander-loop
 */
import type { CommanderContext, CommanderOrchestrator } from './commander-orchestrator.ts';
import type { CommanderDecisionProvider } from './decision-provider.ts';
import type { CommanderDecisionValidator } from './decision-validator.ts';
import type { CommanderGovernanceChecker } from './governance.ts';
import type { DevFlowStore } from './storage.ts';
export interface CommanderLoopResult {
    /** The processed project. */
    readonly projectId: string;
    /** The context the cycle decided on. */
    readonly context: CommanderContext;
    /** The persisted decision id. */
    readonly decisionId: string;
    /** The persisted action id the decision realizes. */
    readonly actionId: string;
    /** Cycle completion time, ISO 8601. */
    readonly completedAt: string;
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
export declare class CommanderLoopRunner {
    private readonly orchestrator;
    private readonly store;
    private readonly provider;
    private readonly validator?;
    private readonly governance?;
    constructor(orchestrator: CommanderOrchestrator, store: DevFlowStore, provider: CommanderDecisionProvider, validator?: CommanderDecisionValidator | undefined, governance?: CommanderGovernanceChecker | undefined);
    /**
     * Run one commander cycle for a project.
     * @param projectId - the project to cycle.
     * @returns the persisted decision and action ids with the context they were
     *   derived from.
     */
    runCycle(projectId: string): Promise<CommanderLoopResult>;
}
