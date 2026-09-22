/**
 * ScopeGuard accounting and enforcement judgments. These pure functions fold
 * agent reports by task so runtime callers can make replayable stop decisions.
 * @module @xiaoxie-ide/dsh-devflow/scope-guard
 */
/** Fold report metrics into a task's cumulative ScopeGuard usage. */
export function foldScopeUsage(reports) {
    const modifiedFiles = new Set();
    const completedCriteria = new Set();
    let toolSteps = 0;
    for (const report of reports) {
        for (const file of report.modifiedFiles ?? [])
            modifiedFiles.add(file);
        for (const criterion of report.completedCriteria ?? [])
            completedCriteria.add(criterion);
        toolSteps += report.toolStepCount ?? 0;
    }
    return { modifiedFiles: [...modifiedFiles], toolSteps, completedCriteria: [...completedCriteria] };
}
/** Resolve a task override against the mandatory project ScopeGuard default. */
export function resolveTaskScope(defaultScope, override) {
    return override ?? {
        maxModifiedFiles: defaultScope.maxModifiedFiles,
        maxToolSteps: defaultScope.maxToolSteps,
        completionCriteria: defaultScope.completionCriteria,
    };
}
/** Return every ScopeGuard condition reached by a task's cumulative usage. */
export function evaluateScopeUsage(scope, usage) {
    const decisions = [];
    if (usage.modifiedFiles.length > scope.maxModifiedFiles) {
        decisions.push({ boundary: 'modified_files', currentValue: usage.modifiedFiles.length, limit: scope.maxModifiedFiles });
    }
    if (usage.toolSteps > scope.maxToolSteps) {
        decisions.push({ boundary: 'tool_steps', currentValue: usage.toolSteps, limit: scope.maxToolSteps });
    }
    if (scope.completionCriteria.every(criterion => usage.completedCriteria.includes(criterion))) {
        decisions.push({
            boundary: 'completion_criteria', currentValue: scope.completionCriteria.length, limit: scope.completionCriteria.length,
        });
    }
    return decisions;
}
/** Convert a ScopeGuard decision into the durable event payload for one task. */
export function createScopeBoundaryHit(taskId, decision, at) {
    return { taskId, ...decision, at };
}
