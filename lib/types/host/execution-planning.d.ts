/**
 * Pure execution-granularity and frontend/backend sequencing judgments used by
 * the Commander prompt and decision requests.
 * @module @xiaoxie-ide/dsh-devflow/execution-planning
 */
/** Declared project scale used to avoid unnecessary granularity prompts. */
export type ProjectSize = 'small' | 'medium' | 'large';
/** Execution cadence selected by the user or default policy. */
export type ExecutionGranularity = 'stepwise' | 'phase';
/** Frontend/backend dispatch ordering selected by the user. */
export type DevelopmentOrder = 'parallel' | 'backend-first' | 'frontend-first';
/** Resolve scale from a Commander plan's phase count. */
export declare function projectSizeForPhaseCount(phaseCount: number): ProjectSize;
/** Whether the scale needs an explicit execution-granularity decision. */
export declare function requiresGranularityDecision(size: ProjectSize): boolean;
/** Default cadence when the Commander does not need to ask the user. */
export declare function defaultGranularity(size: ProjectSize): ExecutionGranularity;
/** Determine the first role dispatch order for a selected development order. */
export declare function dispatchRolesForOrder(order: DevelopmentOrder): readonly ('backend-engineer' | 'frontend-engineer')[];
