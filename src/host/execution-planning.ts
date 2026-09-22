/**
 * Pure execution-granularity and frontend/backend sequencing judgments used by
 * the Commander prompt and decision requests.
 * @module @xiaoxie-ide/dsh-devflow/execution-planning
 */

/** Declared project scale used to avoid unnecessary granularity prompts. */
export type ProjectSize = 'small' | 'medium' | 'large'

/** Execution cadence selected by the user or default policy. */
export type ExecutionGranularity = 'stepwise' | 'phase'

/** Frontend/backend dispatch ordering selected by the user. */
export type DevelopmentOrder = 'parallel' | 'backend-first' | 'frontend-first'

/** Resolve scale from a Commander plan's phase count. */
export function projectSizeForPhaseCount(phaseCount: number): ProjectSize {
  if (phaseCount <= 2) return 'small'
  if (phaseCount <= 5) return 'medium'
  return 'large'
}

/** Whether the scale needs an explicit execution-granularity decision. */
export function requiresGranularityDecision(size: ProjectSize): boolean {
  return size === 'medium'
}

/** Default cadence when the Commander does not need to ask the user. */
export function defaultGranularity(size: ProjectSize): ExecutionGranularity {
  return size === 'small' ? 'phase' : 'stepwise'
}

/** Determine the first role dispatch order for a selected development order. */
export function dispatchRolesForOrder(order: DevelopmentOrder): readonly ('backend-engineer' | 'frontend-engineer')[] {
  switch (order) {
    case 'parallel': return ['backend-engineer', 'frontend-engineer']
    case 'backend-first': return ['backend-engineer', 'frontend-engineer']
    case 'frontend-first': return ['frontend-engineer', 'backend-engineer']
  }
}
