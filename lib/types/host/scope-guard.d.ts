/**
 * ScopeGuard accounting and enforcement judgments. These pure functions fold
 * agent reports by task so runtime callers can make replayable stop decisions.
 * @module @xiaoxie-ide/dsh-devflow/scope-guard
 */
import type { AgentReport, ScopeBoundaryHit, ScopeBoundaryType, ScopeGuard, TaskScopeGuard } from './types.ts';
/** Cumulative metrics reconstructed from reports for one task. */
export interface ScopeUsage {
    /** Unique modified files reported across all task executions. */
    readonly modifiedFiles: readonly string[];
    /** Total reported tool calls across all task executions. */
    readonly toolSteps: number;
    /** Completion criteria reported across all task executions. */
    readonly completedCriteria: readonly string[];
}
/** One stop condition produced by ScopeGuard evaluation. */
export interface ScopeBoundaryDecision {
    /** The triggered ScopeGuard condition. */
    readonly boundary: ScopeBoundaryType;
    /** The cumulative value that reached the condition. */
    readonly currentValue: number;
    /** The applicable numeric limit or completion-criterion count. */
    readonly limit: number;
}
/** Fold report metrics into a task's cumulative ScopeGuard usage. */
export declare function foldScopeUsage(reports: readonly AgentReport[]): ScopeUsage;
/** Resolve a task override against the mandatory project ScopeGuard default. */
export declare function resolveTaskScope(defaultScope: ScopeGuard, override: TaskScopeGuard | undefined): TaskScopeGuard;
/** Return every ScopeGuard condition reached by a task's cumulative usage. */
export declare function evaluateScopeUsage(scope: TaskScopeGuard, usage: ScopeUsage): readonly ScopeBoundaryDecision[];
/** Convert a ScopeGuard decision into the durable event payload for one task. */
export declare function createScopeBoundaryHit(taskId: string, decision: ScopeBoundaryDecision, at: string): ScopeBoundaryHit;
