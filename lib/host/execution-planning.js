/**
 * Pure execution-granularity and frontend/backend sequencing judgments used by
 * the Commander prompt and decision requests.
 * @module @xiaoxie-ide/dsh-devflow/execution-planning
 */
/** Resolve scale from a Commander plan's phase count. */
export function projectSizeForPhaseCount(phaseCount) {
    if (phaseCount <= 2)
        return 'small';
    if (phaseCount <= 5)
        return 'medium';
    return 'large';
}
/** Whether the scale needs an explicit execution-granularity decision. */
export function requiresGranularityDecision(size) {
    return size === 'medium';
}
/** Default cadence when the Commander does not need to ask the user. */
export function defaultGranularity(size) {
    return size === 'small' ? 'phase' : 'stepwise';
}
/** Determine the first role dispatch order for a selected development order. */
export function dispatchRolesForOrder(order) {
    switch (order) {
        case 'parallel': return ['backend-engineer', 'frontend-engineer'];
        case 'backend-first': return ['backend-engineer', 'frontend-engineer'];
        case 'frontend-first': return ['frontend-engineer', 'backend-engineer'];
    }
}
