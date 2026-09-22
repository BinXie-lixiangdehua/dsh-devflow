/**
 * ScopeGuard accounting and enforcement judgments. These pure functions fold
 * agent reports by task so runtime callers can make replayable stop decisions.
 * @module @xiaoxie-ide/dsh-devflow/scope-guard
 */

import type { AgentReport, ScopeBoundaryHit, ScopeBoundaryType, ScopeGuard, TaskScopeGuard } from './types.ts'

/** Cumulative metrics reconstructed from reports for one task. */
export interface ScopeUsage {
  /** Unique modified files reported across all task executions. */
  readonly modifiedFiles: readonly string[]
  /** Total reported tool calls across all task executions. */
  readonly toolSteps: number
  /** Completion criteria reported across all task executions. */
  readonly completedCriteria: readonly string[]
}

/** One stop condition produced by ScopeGuard evaluation. */
export interface ScopeBoundaryDecision {
  /** The triggered ScopeGuard condition. */
  readonly boundary: ScopeBoundaryType
  /** The cumulative value that reached the condition. */
  readonly currentValue: number
  /** The applicable numeric limit or completion-criterion count. */
  readonly limit: number
}

/** Fold report metrics into a task's cumulative ScopeGuard usage. */
export function foldScopeUsage(reports: readonly AgentReport[]): ScopeUsage {
  const modifiedFiles = new Set<string>()
  const completedCriteria = new Set<string>()
  let toolSteps = 0
  for (const report of reports) {
    for (const file of report.modifiedFiles ?? []) modifiedFiles.add(file)
    for (const criterion of report.completedCriteria ?? []) completedCriteria.add(criterion)
    toolSteps += report.toolStepCount ?? 0
  }
  return { modifiedFiles: [...modifiedFiles], toolSteps, completedCriteria: [...completedCriteria] }
}

/** Resolve a task override against the mandatory project ScopeGuard default. */
export function resolveTaskScope(defaultScope: ScopeGuard, override: TaskScopeGuard | undefined): TaskScopeGuard {
  return override ?? {
    maxModifiedFiles: defaultScope.maxModifiedFiles,
    maxToolSteps: defaultScope.maxToolSteps,
    completionCriteria: defaultScope.completionCriteria,
  }
}

/** Return every ScopeGuard condition reached by a task's cumulative usage. */
export function evaluateScopeUsage(scope: TaskScopeGuard, usage: ScopeUsage): readonly ScopeBoundaryDecision[] {
  const decisions: ScopeBoundaryDecision[] = []
  if (usage.modifiedFiles.length > scope.maxModifiedFiles) {
    decisions.push({ boundary: 'modified_files', currentValue: usage.modifiedFiles.length, limit: scope.maxModifiedFiles })
  }
  if (usage.toolSteps > scope.maxToolSteps) {
    decisions.push({ boundary: 'tool_steps', currentValue: usage.toolSteps, limit: scope.maxToolSteps })
  }
  if (scope.completionCriteria.every(criterion => usage.completedCriteria.includes(criterion))) {
    decisions.push({
      boundary: 'completion_criteria', currentValue: scope.completionCriteria.length, limit: scope.completionCriteria.length,
    })
  }
  return decisions
}

/** Convert a ScopeGuard decision into the durable event payload for one task. */
export function createScopeBoundaryHit(
  taskId: string,
  decision: ScopeBoundaryDecision,
  at: string,
): ScopeBoundaryHit {
  return { taskId, ...decision, at }
}
