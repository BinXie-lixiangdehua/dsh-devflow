import type { DevFlowClientAgent, DevFlowClientAssignment, DevFlowClientAttemptSummary, DevFlowClientAuditFilter, DevFlowClientDecision, DevFlowClientDecisionRequest, DevFlowClientExecution, DevFlowClientFailureSummary, DevFlowClientPhase, DevFlowClientReportSummary, DevFlowClientResultSummary, DevFlowClientSnapshot, DevFlowClientTask } from '../contract.ts';
/** A local Canvas selection. It is never persisted to DevFlow or Harness Session state. */
export type WorkspaceSelection = {
    readonly kind: 'project';
} | {
    readonly kind: 'commander';
} | {
    readonly kind: 'phase';
    readonly id: string;
} | {
    readonly kind: 'task';
    readonly id: string;
} | {
    readonly kind: 'agent';
    readonly id: string;
} | {
    readonly kind: 'execution';
    readonly id: string;
} | {
    readonly kind: 'decision';
    readonly id: string;
};
export type AgentWorkState = 'idle' | 'working' | 'blocked' | 'done' | 'archived' | 'unknown';
export type TaskWorkState = 'created' | 'planned' | 'working' | 'blocked' | 'reviewing' | 'completed' | 'failed' | 'cancelled';
export interface WorkspaceTask {
    readonly task: DevFlowClientTask;
    readonly workState: TaskWorkState;
    readonly assignments: readonly DevFlowClientAssignment[];
    readonly executions: readonly DevFlowClientExecution[];
    readonly results: readonly DevFlowClientResultSummary[];
    readonly reports: readonly DevFlowClientReportSummary[];
    readonly attempts: readonly DevFlowClientAttemptSummary[];
    readonly failures: readonly DevFlowClientFailureSummary[];
    readonly pendingDecisions: readonly DevFlowClientDecisionRequest[];
    readonly phaseIds: readonly string[];
}
export interface WorkspaceAgent {
    readonly agent: DevFlowClientAgent;
    readonly workState: AgentWorkState;
    readonly assignments: readonly DevFlowClientAssignment[];
    readonly executions: readonly DevFlowClientExecution[];
    readonly reports: readonly DevFlowClientReportSummary[];
    readonly failures: readonly DevFlowClientFailureSummary[];
    readonly taskIds: readonly string[];
    readonly pendingDecisions: readonly DevFlowClientDecisionRequest[];
}
export interface WorkspaceBlocker {
    readonly id: string;
    readonly kind: 'decision' | 'failed-task' | 'failed-execution' | 'paused';
    readonly title: string;
    readonly detail: string;
    readonly selection: WorkspaceSelection;
}
export interface WorkspaceActivity {
    readonly id: string;
    readonly at: string;
    readonly title: string;
    readonly detail: string;
    readonly selection: WorkspaceSelection;
}
/** One task entry of the workspace model, as grouped by `createWorkspaceModel`. */
export type WorkspaceFlowTask = WorkspaceModel['tasks'][number];
export interface WorkspaceModel {
    readonly snapshot: DevFlowClientSnapshot;
    readonly phases: readonly DevFlowClientPhase[];
    readonly tasks: readonly WorkspaceTask[];
    readonly agents: readonly WorkspaceAgent[];
    readonly assignmentsByPhase: ReadonlyMap<string, readonly DevFlowClientAssignment[]>;
    readonly taskById: ReadonlyMap<string, WorkspaceTask>;
    readonly agentById: ReadonlyMap<string, WorkspaceAgent>;
    readonly executionById: ReadonlyMap<string, DevFlowClientExecution>;
    readonly decisionRequestsById: ReadonlyMap<string, DevFlowClientDecisionRequest>;
    readonly decisionsById: ReadonlyMap<string, DevFlowClientDecision>;
    readonly blockers: readonly WorkspaceBlocker[];
    readonly recentActivity: readonly WorkspaceActivity[];
}
export declare const PROJECT_SELECTION: WorkspaceSelection;
/** Convert a Canvas selection into an exact, Host-enforced audit predicate. */
export declare function auditFilterForSelection(selection: WorkspaceSelection): DevFlowClientAuditFilter;
/** Build the read-only Canvas view model from the current V1 snapshot only. */
export declare function createWorkspaceModel(snapshot: DevFlowClientSnapshot): WorkspaceModel;
/** True when a local selection still refers to an object in the refreshed snapshot. */
export declare function selectionExists(model: WorkspaceModel, selection: WorkspaceSelection): boolean;
export declare function flowAgentName(agentId: string, displayName: string): string;
/** Render-safe title for the selected object. */
export declare function selectionLabel(model: WorkspaceModel, selection: WorkspaceSelection): string;
/** The nearest factual parent for a selection. Used by the local breadcrumb only. */
export declare function selectionParent(model: WorkspaceModel, selection: WorkspaceSelection): WorkspaceSelection | undefined;
/** All visible phase IDs relevant to a selection. Empty means show the full project view. */
export declare function focusedPhaseIds(model: WorkspaceModel, selection: WorkspaceSelection): ReadonlySet<string>;
/** Whether a work item belongs to the selected object for visual focus only. */
export declare function isSelectionRelated(model: WorkspaceModel, selection: WorkspaceSelection, taskId: string): boolean;
export declare function workStateLabel(state: AgentWorkState): string;
export declare function lifecycleLabel(status: DevFlowClientAgent['status']): string;
export declare function taskWorkStateLabel(state: TaskWorkState): string;
export declare function shortId(id: string, length?: number): string;
/**
 * The last path segment of one workspace directory, for the panel identity line.
 *
 * The identity line is one compact Chinese line, so it names the project by its
 * directory while the full path stays available as the element's `title`. Both
 * separators are honoured because a session workspace is whatever the host
 * resolved, not necessarily this process's platform style; a path with no
 * segment at all is returned unchanged rather than rendered as an empty label.
 * @param path - the session workspace directory.
 * @returns its last segment, or the input when it has none.
 */
export declare function workspaceBasename(path: string): string;
