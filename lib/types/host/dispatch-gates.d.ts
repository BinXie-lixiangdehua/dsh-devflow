import type { DevFlowProjectionState, DispatchDiagnostic, Project, Task } from './types.ts';
/** Why a dispatch gate rejected an otherwise valid task. */
export type DispatchGateBlock = 'projection-unavailable' | 'review-failed-twice' | 'review-decision-missing' | 'review-decision-pending' | 'review-decision-task-mismatch' | 'review-decision-project-mismatch' | 'review-decision-expired' | 'high-risk-decision-missing' | 'high-risk-decision-pending' | 'high-risk-decision-task-mismatch' | 'high-risk-decision-project-mismatch' | 'high-risk-decision-expired';
/** The auditable result of all dispatch decision gates. */
export interface DispatchGateResult {
    readonly allowed: boolean;
    readonly blockedBy: DispatchGateBlock | null;
    readonly requiredDecision: 'review-failed-twice' | 'high-risk-operation' | null;
    readonly projectionStatus: 'available' | 'unavailable';
    readonly reviewFailCount: number;
    readonly highRisk: boolean;
    readonly decisionStatus: string | undefined;
}
/** Evaluate every dispatch decision gate without reading or mutating external state. */
export declare function evaluateDispatchGates(task: Task, projection: DevFlowProjectionState | undefined, project: Project): DispatchGateResult;
/** Render a short, non-secret diagnostic error message for a dispatch gate. */
export declare function dispatchGateMessage(result: DispatchGateResult): string;
/** Keep diagnostic text bounded before it enters the plugin-owned journal. */
export declare function boundedDiagnosticText(value: string, limit?: number): string;
/** Create an immutable diagnostic snapshot from a partial set of facts. */
export declare function makeDispatchDiagnostic(input: DispatchDiagnostic): DispatchDiagnostic;
