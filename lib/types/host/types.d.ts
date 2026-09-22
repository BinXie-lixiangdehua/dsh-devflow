/**
 * DevFlow durable data types. Pure structural types only; all runtime logic
 * lives in the storage and tool layers.
 * @module @xiaoxie-ide/dsh-devflow/types
 */
/** Agent role that owns a task in the four-person DevFlow team. */
export type AssignedRole = 'planner' | 'backend-engineer' | 'frontend-engineer' | 'reviewer';
/** Review outcome recorded when a task result enters the durable event stream. */
export type ResultVerdict = 'accepted' | 'changes-requested' | 'rejected';
/**
 * One concrete Agent access instance playing a role. The instance is the
 * physical participant (e.g. `deepseek-local-harness-001`); the role stays
 * the stable protocol contract. Ids and role ids are English machine
 * identifiers — display-facing Chinese lives only in `displayName` and the
 * display layer, never here.
 */
export interface AgentInstance {
    /** Stable English slug id, human-recognizable (never a UUID). */
    readonly id: string;
    /** The role this instance plays (the protocol's AgentRoleId). */
    readonly role: AssignedRole;
    /** Display name for CLI/Web/Canvas; Chinese is allowed here. */
    readonly displayName: string;
    /** One-paragraph responsibility description. */
    readonly description?: string;
    /** Capability tags for future role-based assignment. */
    readonly capabilities?: readonly string[];
    /** Free-form extension fields (avatar, endpoint, and future concerns). */
    readonly metadata?: Record<string, unknown>;
    /** Creation time, ISO 8601. */
    readonly createdAt: string;
    /** Last save time, ISO 8601. */
    readonly updatedAt: string;
}
/** Task lifecycle status (six-state machine). */
export type TaskStatus = 'created' | 'planned' | 'executing' | 'reviewing' | 'completed' | 'failed' | 'cancelled';
/** One status transition between two task states. */
export interface TaskTransition {
    /** The status the task leaves. */
    readonly from: TaskStatus;
    /** The status the task enters. */
    readonly to: TaskStatus;
}
/** A committed task status change: the audit record of one transition. */
export interface TaskStatusChange extends TaskTransition {
    /** The task the transition applied to. */
    readonly taskId: string;
    /** Commit time, ISO 8601. */
    readonly at: string;
}
/** Project context shared by every Agent role in the workflow. */
export interface Project {
    /** Stable project identifier, unique within a devflow root. */
    readonly id: string;
    /** Display name. */
    readonly name: string;
    /** Business/product goal the whole workflow anchors to. */
    readonly goal: string;
    /** Current development stage (deployment-defined label). */
    readonly currentStage: string;
    /** Creation time, ISO 8601. */
    readonly createdAt: string;
    /** Last save time, ISO 8601. */
    readonly updatedAt: string;
}
/** One task in the Agent workflow. */
export interface Task {
    /** Stable task identifier, unique within a project. */
    readonly id: string;
    /** Human-readable title. */
    readonly title: string;
    /** Free-form description. */
    readonly description: string;
    /** Current lifecycle status. */
    readonly status: TaskStatus;
    /** Role the task is assigned to; unset until assignment. */
    readonly assignedRole?: AssignedRole;
    /** Creation time, ISO 8601. */
    readonly createdAt: string;
    /** Last update time, ISO 8601. */
    readonly updatedAt: string;
}
/** Structured execution result produced by an Agent and archived by DevFlow. */
export interface Result {
    /** Stable result identifier, unique within a project. */
    readonly id: string;
    /** The task this result belongs to. */
    readonly taskId: string;
    /** One-paragraph execution summary. */
    readonly summary: string;
    /** Files, interfaces, or config changes made, one per entry. */
    readonly changes: readonly string[];
    /** Verification method and outcome, one per entry. */
    readonly verification: readonly string[];
    /** Unfinished work, risks, and follow-ups, one per entry. */
    readonly issues: readonly string[];
    /** Suggested next steps derived from the result, one per entry. */
    readonly nextSteps: readonly string[];
    /** Creation time, ISO 8601. */
    readonly createdAt: string;
}
/**
 * Agent kind: a fixed team member (permanent employee) or a temporary spawn
 * for one task.
 */
export type AgentKind = 'fixed' | 'temporary';
/** Fixed agents have one lifecycle state: active until removed. */
export type FixedAgentStatus = 'active';
/** Temporary agents run through created → running → terminated. */
export type TemporaryAgentStatus = 'created' | 'running' | 'terminated';
/** An orchestration agent's lifecycle status. */
export type AgentLifecycleStatus = FixedAgentStatus | TemporaryAgentStatus;
/** Model configuration for one orchestration agent (never executed in v0.4). */
export interface AgentModelConfig {
    /** Provider/model id, e.g. `deepseek-chat`. */
    readonly model: string;
    /** Optional provider name. */
    readonly provider?: string;
    /** Optional provider endpoint. */
    readonly baseURL?: string;
    /** Optional provider credential; never included in display output. */
    readonly apiKey?: string;
    /** Optional sampling temperature. */
    readonly temperature?: number;
    /** Optional max output tokens. */
    readonly maxTokens?: number;
    /** Free-form provider options. */
    readonly options?: Record<string, unknown>;
}
/**
 * One orchestration agent in the registry: a fixed employee or a temporary
 * per-task spawn. This is the v0.4 foundation — it only carries the config a
 * future Commander reads; it is never executed here.
 */
export interface OrchestrationAgent {
    /** Stable English slug id. */
    readonly agentId: string;
    /** Fixed team member or temporary spawn. */
    readonly kind: AgentKind;
    /** The role this agent plays. */
    readonly role: AssignedRole;
    /** Lifecycle status. */
    readonly status: AgentLifecycleStatus;
    /** System prompt / config. */
    readonly prompt: string;
    /** Model configuration. */
    readonly modelConfig: AgentModelConfig;
    /** Tool names the agent may use. */
    readonly tools: readonly string[];
    /** Capability tags. */
    readonly capabilities: readonly string[];
    /** Skill ids whose contents are injected whenever this agent starts. */
    readonly skills: readonly string[];
    /** Remaining recursive child-agent delegation levels allowed for this agent. */
    readonly delegationDepth: number;
    /** Creation time, ISO 8601. */
    readonly createdAt: string;
    /** Last update time, ISO 8601. */
    readonly updatedAt: string;
}
/** Config patch for `devflow/agent/update-config`. Omitted keys stay untouched. */
export interface AgentConfigPatch {
    readonly role?: AssignedRole;
    readonly prompt?: string;
    readonly modelConfig?: Partial<AgentModelConfig>;
    readonly tools?: readonly string[];
    readonly capabilities?: readonly string[];
    /** Skill ids whose contents are injected whenever this agent starts. */
    readonly skills?: readonly string[];
    /** Remaining recursive child-agent delegation levels allowed for this agent. */
    readonly delegationDepth?: number;
}
/** Phase lifecycle status. */
export type PhaseStatus = 'planned' | 'in_progress' | 'completed';
/** One phase of the MVP plan. */
export interface Phase {
    /** Stable phase id (UUID). */
    readonly id: string;
    /** Human-readable name. */
    readonly name: string;
    /** One-paragraph description. */
    readonly description: string;
    /** Lifecycle status. */
    readonly status: PhaseStatus;
    /** Creation time, ISO 8601. */
    readonly createdAt: string;
    /** Last update time, ISO 8601. */
    readonly updatedAt: string;
}
/**
 * The MVP plan: the Commander's scoped first delivery — a goal, an explicit
 * scope, and the phases that realize it.
 */
export interface MvpPlan {
    /** The business/product goal the MVP anchors to. */
    readonly goal: string;
    /** The explicit in-scope items. */
    readonly scope: readonly string[];
    /** The ordered phase ids this plan runs through. */
    readonly phaseIds: readonly string[];
    /** Creation time, ISO 8601. */
    readonly createdAt: string;
    /** Last update time, ISO 8601. */
    readonly updatedAt: string;
}
/** A post-MVP iteration: continuous improvement after the MVP ships. */
export interface Iteration {
    /** Stable iteration id (UUID). */
    readonly id: string;
    /** Human-readable name. */
    readonly name: string;
    /** The iteration's goal. */
    readonly goal: string;
    /** Creation time, ISO 8601. */
    readonly createdAt: string;
}
/** The scope guard: the currently committed scope boundary. */
export interface ScopeGuard {
    /** One-paragraph summary of the committed scope. */
    readonly summary: string;
    /** The explicit in-scope items. */
    readonly inScope: readonly string[];
    /** Maximum number of files an execution may report as modified. */
    readonly maxModifiedFiles: number;
    /** Maximum number of tool calls an execution may report. */
    readonly maxToolSteps: number;
    /** Completion criteria that stop further execution once all are met. */
    readonly completionCriteria: readonly string[];
    /** Creation time, ISO 8601. */
    readonly createdAt: string;
    /** Last update time, ISO 8601. */
    readonly updatedAt: string;
}
/** The numeric and completion fields that may override a project's default ScopeGuard for one task. */
export type TaskScopeGuard = Pick<ScopeGuard, 'maxModifiedFiles' | 'maxToolSteps' | 'completionCriteria'>;
/** The reason a task execution stopped at its declared ScopeGuard. */
export type ScopeBoundaryType = 'modified_files' | 'tool_steps' | 'completion_criteria';
/** One durable record that a task reached a ScopeGuard limit. */
export interface ScopeBoundaryHit {
    /** The task work-unit id whose execution stopped. */
    readonly taskId: string;
    /** The limit that stopped execution. */
    readonly boundary: ScopeBoundaryType;
    /** The cumulative value at the stopping point. */
    readonly currentValue: number;
    /** The numeric limit, or criterion count for completion. */
    readonly limit: number;
    /** Event time, ISO 8601. */
    readonly at: string;
}
/** Reasons that require a Commander decision request. */
export type DecisionTrigger = 'ambiguity' | 'approach-divergence' | 'scope-creep' | 'review-failed-twice' | 'high-risk-operation' | 'granularity' | 'development-order';
/**
 * What an option actually DOES, declared by the caller that proposes it.
 *
 * The popup rules are enforced on this field rather than on prose: a caller must
 * declare which option stops the work, and the recommended option may never be a
 * retry. Wording is localization; intent is a contract.
 */
export type DecisionOptionKind = 'proceed' | 'retry' | 'stop';
/** One recommended option in a durable Commander decision request. */
export interface DecisionOption {
    readonly id: string;
    readonly label: string;
    readonly description: string;
    readonly recommended: boolean;
    /** Declared intent; absent on records written before this rule existed. */
    readonly kind?: DecisionOptionKind;
}
/** A user answer to a durable Commander decision request. */
export type DecisionAnswer = {
    readonly optionId: string;
} | {
    readonly custom: string;
};
/** A Commander request for a direction, scope, or risk decision. */
export interface DecisionRequest {
    readonly requestId: string;
    readonly projectId: string;
    readonly taskId: string | null;
    readonly trigger: DecisionTrigger;
    readonly question: string;
    readonly options: readonly DecisionOption[];
    readonly allowCustom: boolean;
    readonly status: 'pending' | 'answered' | 'dismissed';
    readonly answer: DecisionAnswer | null;
    readonly createdAt: string;
    readonly answeredAt: string | null;
}
/** One queued improvement that exceeded the current MVP scope. */
export interface Improvement {
    /** Stable improvement id (UUID). */
    readonly id: string;
    /** Human-readable title. */
    readonly title: string;
    /** One-paragraph description of the deferred need. */
    readonly description: string;
    /** Creation time, ISO 8601. */
    readonly createdAt: string;
}
/**
 * A commander context checkpoint: the durable long-task continuity snapshot
 * the Commander saves so a future session can resume. Pure data — nothing here
 * is executed or resumed in v0.4.
 */
export interface CommanderCheckpoint {
    /** Stable checkpoint id (UUID). */
    readonly checkpointId: string;
    /** The project this checkpoint belongs to. */
    readonly projectId: string;
    /** The current MVP goal; null before the MVP is created. */
    readonly currentMvp: string | null;
    /** The current iteration id; null before the first iteration. */
    readonly currentIteration: string | null;
    /** The current phase id; null before the first phase. */
    readonly currentPhase: string | null;
    /** The current task id; null before the first task. */
    readonly currentTask: string | null;
    /** Completed items so far. */
    readonly completedItems: readonly string[];
    /** Decisions made so far. */
    readonly decisions: readonly string[];
    /** Planned next steps. */
    readonly nextSteps: readonly string[];
    /** Creation time, ISO 8601. */
    readonly createdAt: string;
    /** Last update time, ISO 8601. */
    readonly updatedAt: string;
}
/** Partial update patch for a commander checkpoint. Omitted keys stay untouched. */
export interface CommanderCheckpointUpdate {
    readonly currentMvp?: string | null;
    readonly currentIteration?: string | null;
    readonly currentPhase?: string | null;
    readonly currentTask?: string | null;
    readonly completedItems?: readonly string[];
    readonly decisions?: readonly string[];
    readonly nextSteps?: readonly string[];
}
/**
 * Why a stale record was closed. A closed record is one that can never continue, and the
 * reason is the only thing that distinguishes the three cases the panel reports.
 */
export type DevFlowCloseReason = 
/** The record claimed to be in flight but is far past any plausible window. */
'stale-lost'
/** A newer dispatch for the same work superseded it. */
 | 'superseded'
/** The work was dropped without a result. */
 | 'abandoned';
/** Every close reason, in one place, so all layers validate the same set. */
export declare const DEVFLOW_CLOSE_REASONS: readonly DevFlowCloseReason[];
/** Is this value one of the three close reasons? */
export declare function isDevFlowCloseReason(value: unknown): value is DevFlowCloseReason;
/**
 * Assignment lifecycle status. `closed` is TERMINAL and means "this dispatch can never
 * continue": it is not a failure and not a completion, so it carries its own stamp and
 * reason rather than pretending to be either.
 */
/**
 * The act a refused DevFlow preset activation was performing.
 *
 * The stable codes above say *what* was refused; this says *what for*, which is
 * the distinction an operator needs first: a mount that never happened differs
 * from a switch that was rolled back.
 */
export type DevFlowActivationFailurePhase = 'initial' | 'recompose' | 'deactivate' | 'restore' | 'journal';
/** One stable, allowlisted reason a DevFlow preset activation was refused. */
export type DevFlowActivationCode = 'devflow-preset-identity-mismatch' | 'devflow-session-mismatch' | 'devflow-project-unavailable' | 'devflow-project-init-failed' | 'devflow-commander-install-failed' | 'devflow-activation-verification-failed' | 'devflow-commander-not-installed' | 'devflow-deactivation-failed' | 'devflow-restore-failed' | 'devflow-journal-failed' | 'devflow-host-unavailable';
export type AssignmentStatus = 'assigned' | 'in_progress' | 'completed' | 'closed';
/** One phase → agent assignment: which agent owns which phase under which role. */
export interface PhaseAssignment {
    /** Stable assignment id (UUID). */
    readonly assignmentId: string;
    /** Task id for task-bound dispatch assignments; absent for legacy phase-only records. */
    readonly taskId?: string;
    readonly phaseId: string;
    /** The assigned agent (registry slug id). */
    readonly agentId: string;
    /** The role the agent plays for this phase. */
    readonly role: AssignedRole;
    /** Lifecycle status. */
    readonly status: AssignmentStatus;
    /** Close stamp; present exactly while {@link status} is `closed`. */
    readonly closedAt?: string;
    /** Close reason; present exactly while {@link status} is `closed`. */
    readonly closeReason?: DevFlowCloseReason;
    /** Creation time, ISO 8601. */
    readonly createdAt: string;
    /** Last update time, ISO 8601. */
    readonly updatedAt: string;
}
/** A structured snapshot of one native child dispatch. */
export interface DispatchDiagnostic {
    readonly dispatchId: string;
    readonly taskId: string;
    readonly agentId: string;
    readonly projectId: string | null;
    readonly taskStatus: TaskStatus;
    readonly projectionStatus: 'available' | 'unavailable';
    readonly reviewFailCount: number;
    readonly decisionStatus: string | undefined;
    readonly highRisk: boolean;
    readonly assignmentId?: string;
    readonly assignmentAgentId?: string;
    readonly assignmentPhaseId?: string;
    readonly assignmentStatus?: AssignmentStatus;
    readonly childDepth?: number;
    readonly maxDepth?: number;
    readonly provider?: string;
    readonly model?: string;
    readonly toolFilter?: readonly string[];
    readonly runId?: string;
    readonly stopReason?: string;
    /** Child replies this dispatch spent before it settled (1, or 2 after a retry). */
    readonly attempts?: number;
    readonly errorCode?: string;
    readonly errorMessage?: string;
    readonly partialOutput?: string;
    readonly lastToolCall?: string;
    readonly status: 'started' | 'blocked' | 'failed' | 'completed';
    readonly at: string;
}
/** Commander planning lifecycle status. */
export type CommanderPlanStatus = 'draft' | 'active' | 'completed';
/** One commander planning record: the goal → MVP plan bridge. */
export interface CommanderPlan {
    /** Stable planning id (UUID). */
    readonly planningId: string;
    /** The project this planning belongs to. */
    readonly projectId: string;
    /** The user goal the planning anchors to. */
    readonly goal: string;
    /** Lifecycle status. */
    readonly status: CommanderPlanStatus;
    /** The referenced MVP plan id; null before the MVP is created. */
    readonly mvpPlanId: string | null;
    /** Creation time, ISO 8601. */
    readonly createdAt: string;
    /** Last update time, ISO 8601. */
    readonly updatedAt: string;
}
/** Partial update patch for a commander plan. Omitted keys stay untouched. */
export interface CommanderPlanUpdate {
    readonly goal?: string;
    readonly mvpPlanId?: string | null;
    readonly status?: CommanderPlanStatus;
}
/** Execution batch lifecycle status. */
export type ExecutionBatchStatus = 'planned' | 'running' | 'paused' | 'completed';
/** One execution batch: the Commander's selected execution scope. */
export interface ExecutionBatch {
    /** Stable batch id (UUID). */
    readonly batchId: string;
    /** The project this batch belongs to. */
    readonly projectId: string;
    /** The commander plan this batch realizes. */
    readonly planningId: string;
    /** The phases this batch covers. */
    readonly phaseIds: readonly string[];
    /** The assignments this batch executes. */
    readonly assignmentIds: readonly string[];
    /** Lifecycle status. */
    readonly status: ExecutionBatchStatus;
    /** Creation time, ISO 8601. */
    readonly createdAt: string;
    /** Last update time, ISO 8601. */
    readonly updatedAt: string;
}
/** Execution record lifecycle status. `closed` is terminal: it can never run again. */
export type ExecutionStatus = 'pending' | 'running' | 'completed' | 'failed' | 'closed';
/** One execution record inside a batch: which agent executes which assignment. */
export interface ExecutionRecord {
    /** Stable execution id (UUID). */
    readonly executionId: string;
    /** The batch this execution belongs to. */
    readonly batchId: string;
    /** The assignment this execution realizes. */
    readonly assignmentId: string;
    /** The agent executing (registry slug id). */
    readonly agentId: string;
    /** The task whose scope and completion criteria this execution realizes, when supplied by the dispatcher. */
    readonly taskId?: string;
    /** Optional task-specific scope that overrides the project ScopeGuard. */
    readonly scopeGuard?: TaskScopeGuard;
    /** Lifecycle status. */
    readonly status: ExecutionStatus;
    /** Start time, ISO 8601; null before the execution starts. */
    readonly startedAt: string | null;
    /** Completion time, ISO 8601; null before completion/failure. */
    readonly completedAt: string | null;
    /** Close stamp; present exactly while {@link status} is `closed`. */
    readonly closedAt?: string;
    /** Close reason; present exactly while {@link status} is `closed`. */
    readonly closeReason?: DevFlowCloseReason;
    /** Creation time, ISO 8601. */
    readonly createdAt: string;
    /** Last update time, ISO 8601. */
    readonly updatedAt: string;
}
/** Execution attempt lifecycle status. */
export type ExecutionAttemptStatus = 'created' | 'running' | 'completed' | 'failed';
/**
 * One execution attempt: a single retryable run of an execution record. The
 * first attempt has no parent; a retry chains a new attempt under the
 * previous one via `parentAttemptId`. References (never copies) its
 * execution record; the retry reason is recorded at creation.
 */
export interface ExecutionAttempt {
    /** Stable attempt id (UUID). */
    readonly attemptId: string;
    /** The execution this attempt realizes (reference, never a copy). */
    readonly executionId: string;
    /** The previous attempt this retry continues; null for the first attempt. */
    readonly parentAttemptId: string | null;
    /** Lifecycle status. */
    readonly status: ExecutionAttemptStatus;
    /** Why this attempt exists (e.g. a retry reason); null when none. */
    readonly reason: string | null;
    /** Creation time, ISO 8601. */
    readonly createdAt: string;
    /** Completion time, ISO 8601; null before completion/failure. */
    readonly completedAt: string | null;
    /** Last update time, ISO 8601. */
    readonly updatedAt: string;
}
/** Agent report lifecycle status. */
export type AgentReportStatus = 'success' | 'failed' | 'blocked';
/**
 * The BUSINESS conclusion of one dispatched task, kept apart from
 * {@link AgentReportStatus}.
 *
 * `status` answers "did this dispatch produce a report?" — it is a fact about
 * the pipeline. `outcome` answers "did the task actually get done?" — a fact
 * about the work. A dispatch that ran to completion and archived a report is
 * `status: 'success'` while the employee's own reply says `blocked`, and without
 * this split those two very different facts were indistinguishable.
 */
export type AgentReportOutcome = 'delivered' | 'blocked' | 'failed' | 'unknown';
/** The capability a blocked employee was missing, as far as it could tell. */
export type CapabilityGapKind = 'tool' | 'permission' | 'dependency' | 'unstated';
/**
 * One structured "I am blocked" record: the durable form of an employee reply
 * that says the task could not be done and why.
 *
 * It is derived from a real reply or a real subagent terminal state, never
 * inferred from a failure to parse one: an unreadable signal produces
 * `gapKind: 'unstated'`, never a guess.
 */
export interface BlockedReport {
    /** Stable id (UUID). */
    readonly blockedId: string;
    /** The task the blocked dispatch belonged to. */
    readonly taskId: string;
    /** The employee that reported the block. */
    readonly agentId: string;
    /** The execution that carried the reply, when one was recorded. */
    readonly executionId?: string;
    /** The session the employee ran in, when the runtime reported one. */
    readonly sessionId?: string;
    /** What class of capability was missing. */
    readonly gapKind: CapabilityGapKind;
    /** The specific capability named by the reply, verbatim when it named one. */
    readonly missing: string;
    /** Who could clear it, in the reporter's own words when it said so. */
    readonly suggestedOwner: string;
    /** The employee's one-sentence reason, verbatim (bounded). */
    readonly reason: string;
    /** Creation time, ISO 8601. */
    readonly createdAt: string;
}
/** One agent result report returned to the Commander. */
export interface AgentReport {
    /** Stable report id (UUID). */
    readonly reportId: string;
    /** The execution this report belongs to. */
    readonly executionId: string;
    /** The agent that produced this report (registry slug id). */
    readonly agentId: string;
    /** Result status. */
    readonly status: AgentReportStatus;
    /** One-paragraph summary. */
    readonly summary: string;
    /** Reference to the output artifact (path or uri). */
    readonly outputReference: string;
    /**
     * The employee's own business conclusion, when it declared one. Absent means
     * undeclared — readers must treat that as `unknown`, never as `delivered`.
     */
    readonly outcome?: AgentReportOutcome;
    /** Paths of files modified by this execution, when the runtime reports them. */
    readonly modifiedFiles?: readonly string[];
    /** Number of tool calls used by this execution, when the runtime reports it. */
    readonly toolStepCount?: number;
    /** Completion criteria the runtime reports as satisfied. */
    readonly completedCriteria?: readonly string[];
    /** Creation time, ISO 8601. */
    readonly createdAt: string;
    /** Last update time, ISO 8601. */
    readonly updatedAt: string;
}
/** Partial update patch for an agent report. */
export interface AgentReportUpdate {
    readonly status?: AgentReportStatus;
    readonly summary?: string;
    readonly outputReference?: string;
    readonly outcome?: AgentReportOutcome;
    readonly modifiedFiles?: readonly string[];
    readonly toolStepCount?: number;
    readonly completedCriteria?: readonly string[];
}
/** Commander decision types (the review-loop outcomes). */
export type CommanderDecisionType = 'continue' | 'retry' | 'pause' | 'request_user';
/** One commander decision in the review loop. */
export interface CommanderDecision {
    /** Stable decision id (UUID). */
    readonly decisionId: string;
    /** The project this decision belongs to. */
    readonly projectId: string;
    /** The checkpoint this decision reviews; null when none. */
    readonly checkpointId: string | null;
    /** The execution ids this decision reviews. */
    readonly relatedExecutionIds: readonly string[];
    /** The decision kind. */
    readonly decisionType: CommanderDecisionType;
    /** One-paragraph rationale summary. */
    readonly summary: string;
    /** The next action the Commander will take. */
    readonly nextAction: string;
    /** Creation time, ISO 8601. */
    readonly createdAt: string;
    /** Last update time, ISO 8601. */
    readonly updatedAt: string;
}
/** Partial update patch for a commander decision. */
export interface CommanderDecisionUpdate {
    readonly checkpointId?: string | null;
    readonly relatedExecutionIds?: readonly string[];
    readonly decisionType?: CommanderDecisionType;
    readonly summary?: string;
    readonly nextAction?: string;
}
/** Commander review lifecycle status. */
export type CommanderReviewStatus = 'pending' | 'reviewed';
/**
 * One commander review: the AgentReport → CommanderDecision bridge record in
 * the review loop. References (never copies) its agent report and execution
 * record by id; the review itself carries no decision content — a future
 * Commander fills the decision from an explicit review outcome.
 */
export interface CommanderReview {
    /** Stable review id (UUID). */
    readonly reviewId: string;
    /** The project this review belongs to. */
    readonly projectId: string;
    /** The agent report under review (reference, never a copy). */
    readonly reportId: string;
    /** The execution the report answers (reference, never a copy). */
    readonly executionId: string;
    /** Lifecycle status. */
    readonly status: CommanderReviewStatus;
    /** One-paragraph review summary. */
    readonly summary: string;
    /** Creation time, ISO 8601. */
    readonly createdAt: string;
    /** Last update time, ISO 8601. */
    readonly updatedAt: string;
}
/** Commander control-action kinds: the batch/execution flow step a decision triggers. */
export type CommanderActionType = 'start_batch' | 'pause_batch' | 'retry_execution' | 'complete_batch';
/** Commander control-action lifecycle: created → executing → completed. */
export type CommanderActionStatus = 'created' | 'executing' | 'completed';
/** One commander control action: a decision realized as a batch/execution flow step. */
export interface CommanderAction {
    /** Stable action id (UUID). */
    readonly actionId: string;
    /** The commander decision this action realizes. */
    readonly decisionId: string;
    /** The action kind. */
    readonly actionType: CommanderActionType;
    /**
     * The batch or execution id this action targets: a batch id for
     * `start_batch`/`pause_batch`/`complete_batch`, an execution id for
     * `retry_execution`.
     */
    readonly targetId: string;
    /** The action lifecycle status. */
    readonly status: CommanderActionStatus;
    /** Creation time, ISO 8601. */
    readonly createdAt: string;
    /** Last update time, ISO 8601. */
    readonly updatedAt: string;
}
/** Runtime result status (the raw runtime outcome). */
export type RuntimeResultStatus = 'success' | 'failed';
/** A task package exported to the runtime for execution. */
export interface RuntimeTaskPackage {
    /** Stable package id (UUID). */
    readonly packageId: string;
    /** The execution this package realizes. */
    readonly executionId: string;
    /** The agent that will execute (registry slug id). */
    readonly agentId: string;
    /** The task description handed to the runtime. */
    readonly taskDescription: string;
    /** The tool names the runtime may use. */
    readonly tools: readonly string[];
    /** Free-form carry-over metadata. */
    readonly metadata: Record<string, unknown>;
    /** Remaining recursive child-agent delegation levels available to the runtime. */
    readonly currentDelegationDepth: number;
    /** Applied numeric task scope, when the dispatcher supplies one. */
    readonly scopeGuard?: TaskScopeGuard;
    /** Creation time, ISO 8601. */
    readonly createdAt: string;
}
/** A result package imported back from the runtime. */
export interface RuntimeResultPackage {
    /** Stable result id (UUID). */
    readonly resultId: string;
    /** The execution this result answers. */
    readonly executionId: string;
    /** Raw outcome. */
    readonly status: RuntimeResultStatus;
    /** The runtime output text. */
    readonly output: string;
    /** Free-form carry-over metadata. */
    readonly metadata: Record<string, unknown>;
    /** Paths of files modified by the runtime, when available. */
    readonly modifiedFiles?: readonly string[];
    /** Number of tool calls the runtime performed, when available. */
    readonly toolStepCount?: number;
    /** Completion criteria the runtime reports as satisfied. */
    readonly completedCriteria?: readonly string[];
    /** Creation time, ISO 8601. */
    readonly createdAt: string;
}
/** Runtime session lifecycle status. */
export type RuntimeSessionStatus = 'created' | 'running' | 'completed' | 'failed';
/**
 * One runtime call session: the per-execution lifecycle record of a runtime
 * adapter invocation. It references (never copies) its execution record and
 * registered agent by id — the ExecutionRecord stays the authoritative source.
 */
export interface RuntimeSession {
    /** Stable session id (UUID). */
    readonly sessionId: string;
    /** The execution this session realizes (reference, never a copy). */
    readonly executionId: string;
    /** The agent executing (registry slug id). */
    readonly agentId: string;
    /** Lifecycle status. */
    readonly status: RuntimeSessionStatus;
    /** Start time, ISO 8601; null before the session starts. */
    readonly startedAt: string | null;
    /** Completion time, ISO 8601; null before completion/failure. */
    readonly completedAt: string | null;
    /** Free-form carry-over metadata. */
    readonly metadata: Record<string, unknown>;
    /** Creation time, ISO 8601. */
    readonly createdAt: string;
    /** Last update time, ISO 8601. */
    readonly updatedAt: string;
}
/** Commander memory kinds: what a structured memory record describes. */
export type CommanderMemoryType = 'project' | 'decision' | 'execution' | 'preference';
/**
 * One structured commander memory record: a flat, durable fact about a
 * project, a decision, an execution, or a user preference. No vectors, no
 * retrieval — the memory layer is the plain store a future Commander brain
 * reads as additional input.
 */
export interface CommanderMemory {
    /** Stable memory id (UUID). */
    readonly memoryId: string;
    /** The project this memory belongs to. */
    readonly projectId: string;
    /** What the memory describes. */
    readonly memoryType: CommanderMemoryType;
    /** The memory content. */
    readonly content: string;
    /** Where the memory came from (e.g. a decision id, a report id, user input). */
    readonly source: string;
    /** Creation time, ISO 8601. */
    readonly createdAt: string;
    /** Last update time, ISO 8601. */
    readonly updatedAt: string;
}
/** Partial update patch for a commander memory. Omitted keys stay untouched. */
export interface CommanderMemoryUpdate {
    readonly content?: string;
    readonly source?: string;
}
/** Commander schedule lifecycle status. */
export type CommanderScheduleStatus = 'active' | 'paused';
/**
 * One commander cycle schedule: when the loop should run for a project.
 * The interval and run stamps drive a pure should-run judgment; nothing here
 * executes the loop.
 */
export interface CommanderSchedule {
    /** Stable schedule id (UUID). */
    readonly scheduleId: string;
    /** The project this schedule drives. */
    readonly projectId: string;
    /** Lifecycle status. */
    readonly status: CommanderScheduleStatus;
    /** The minimum interval between cycles, in milliseconds. */
    readonly interval: number;
    /** The last cycle run time, ISO 8601; null before the first run. */
    readonly lastRunAt: string | null;
    /** The next scheduled cycle time, ISO 8601. */
    readonly nextRunAt: string;
    /** Creation time, ISO 8601. */
    readonly createdAt: string;
    /** Last update time, ISO 8601. */
    readonly updatedAt: string;
}
/** Partial update patch for a commander schedule. */
export interface CommanderScheduleUpdate {
    /** New interval in milliseconds; `nextRunAt` rolls forward from the last run. */
    readonly interval?: number;
    /** A completed run timestamp: sets `lastRunAt` and rolls `nextRunAt` forward. */
    readonly markRunAt?: string;
}
/** Commander run lifecycle status. */
export type CommanderRunStatus = 'running' | 'completed' | 'failed';
/**
 * One commander runtime driver run: the record of one scheduled cycle —
 * which schedule drove it, which decision and action it produced, and when
 * it started and settled. The run references (never copies) its schedule,
 * decision, and action by id.
 */
export interface CommanderRunRecord {
    /** Stable run id (UUID). */
    readonly runId: string;
    /** The project this run drove. */
    readonly projectId: string;
    /** The schedule this run realized (reference, never a copy). */
    readonly scheduleId: string;
    /** Lifecycle status. */
    readonly status: CommanderRunStatus;
    /** The decision this run created; null before the cycle decides. */
    readonly decisionId: string | null;
    /** The action this run created; null before the cycle acts. */
    readonly actionId: string | null;
    /** Start time, ISO 8601. */
    readonly startedAt: string;
    /** Completion time, ISO 8601; null while running. */
    readonly completedAt: string | null;
    /** Last update time, ISO 8601. */
    readonly updatedAt: string;
}
/** Commander action execution lifecycle status. */
export type CommanderActionExecutionStatus = 'running' | 'completed' | 'failed';
/** Commander risk posture levels. */
export type CommanderRiskLevel = 'low' | 'medium' | 'high';
/**
 * The project-level governance policy: the rules every decision/action of a
 * project must pass before execution. One policy per project; absent policy
 * means no governance constraints.
 */
export interface CommanderPolicy {
    /** The project this policy governs (slug id). */
    readonly projectId: string;
    /** The maximum number of retry executions allowed per execution. */
    readonly maxRetryCount: number;
    /** The action types this project permits. */
    readonly allowedActionTypes: readonly CommanderActionType[];
    /** The action types that require an approved proposal before execution. */
    readonly requireApprovalActionTypes: readonly CommanderActionType[];
    /** The project's risk posture. */
    readonly riskLevel: CommanderRiskLevel;
    /** Creation time, ISO 8601. */
    readonly createdAt: string;
    /** Last update time, ISO 8601. */
    readonly updatedAt: string;
}
/** Commander proposal lifecycle status. */
export type CommanderProposalStatus = 'created' | 'approved' | 'rejected';
/**
 * One commander proposal: the approval-gate record between a decision's
 * action and its execution. References its decision by id and snapshots the
 * action intent (type, target) and the policy risk level at proposal time.
 */
export interface CommanderProposal {
    /** Stable proposal id (UUID). */
    readonly proposalId: string;
    /** The decision this proposal realizes (reference, never a copy). */
    readonly decisionId: string;
    /** The proposed action kind. */
    readonly actionType: CommanderActionType;
    /** The batch or execution the proposed action targets. */
    readonly targetId: string;
    /** The policy risk level snapshot at proposal time. */
    readonly riskLevel: CommanderRiskLevel;
    /** Lifecycle status. */
    readonly status: CommanderProposalStatus;
    /** Creation time, ISO 8601. */
    readonly createdAt: string;
    /** Last update time, ISO 8601. */
    readonly updatedAt: string;
}
/**
 * One immutable commander runtime execution context: the execution
 * environment snapshot generated before an approved action executes. It
 * describes the environment and records every association (action execution,
 * decision, proposal, target) — it never decides, never approves, and never
 * judges policy. Managed through the plugin-owned journal and read model only;
 * generated once, never updated.
 */
export interface CommanderExecutionContext {
    /** Stable context id (UUID). */
    readonly contextId: string;
    /** The action-execution this context was generated for (reference). */
    readonly executionId: string;
    /** The decision the execution realizes (reference). */
    readonly decisionId: string;
    /** The approved proposal that unlocked this execution (reference). */
    readonly proposalId: string;
    /** The action kind being executed. */
    readonly actionType: CommanderActionType;
    /** The batch or execution the action targets. */
    readonly targetId: string;
    /** The risk posture snapshot from the approved proposal. */
    readonly riskLevel: CommanderRiskLevel;
    /** Free-form environment metadata (e.g. the action id). */
    readonly metadata: Record<string, unknown>;
    /** Creation time, ISO 8601. */
    readonly createdAt: string;
}
/** Commander development workflow lifecycle status. */
export type CommanderWorkflowStatus = 'created' | 'running' | 'completed' | 'failed';
/** The runtime outcome snapshot of one workflow cycle. */
export interface CommanderWorkflowExecutionResult {
    /** Whether the execution committed. */
    readonly success: boolean;
    /** The failure message; null on success. */
    readonly error: string | null;
}
/**
 * One commander workflow execution-history entry: the artifacts one workflow
 * cycle produced. It references (never copies) the decision, proposal,
 * execution context, action execution, and feedback the cycle produced, and
 * snapshots the approval verdict and the runtime outcome.
 */
export interface CommanderWorkflowExecution {
    /** Stable history-entry id (UUID). */
    readonly entryId: string;
    /** The workflow step whose cycle produced this entry (reference); null when no step drove it. */
    readonly stepId: string | null;
    /** The decision the cycle produced (reference). */
    readonly decisionId: string;
    /** The proposal the cycle produced (reference); null when the cycle produced no action. */
    readonly proposalId: string | null;
    /** The approval verdict snapshot: whether the proposal was approved. */
    readonly approved: boolean;
    /** The execution context generated for the approved execution (reference); null when nothing executed. */
    readonly contextId: string | null;
    /** The action-execution record id (reference); null when nothing executed. */
    readonly actionExecutionId: string | null;
    /** The runtime outcome snapshot; null when nothing executed. */
    readonly result: CommanderWorkflowExecutionResult | null;
    /** The feedback the execution produced (reference); null when nothing executed. */
    readonly feedbackId: string | null;
    /** Creation time, ISO 8601. */
    readonly createdAt: string;
}
/**
 * One commander development workflow: a development task's lifecycle record.
 * It references its project and carries the append-only execution history —
 * each entry associates the decision, proposal, approval verdict, execution
 * context, action execution, runtime result, and feedback one cycle produced.
 * The workflow never decides, never approves, and never executes; it only
 * tracks the lifecycle, which the task orchestrator drives.
 */
export interface CommanderWorkflow {
    /** Stable workflow id (UUID). */
    readonly workflowId: string;
    /** The project this workflow belongs to (slug id). */
    readonly projectId: string;
    /** The development task title. */
    readonly title: string;
    /** The development task description. */
    readonly description: string;
    /** Lifecycle status: created → running → completed/failed (terminal). */
    readonly status: CommanderWorkflowStatus;
    /** The execution history, oldest first (append-only). */
    readonly history: readonly CommanderWorkflowExecution[];
    /** Creation time, ISO 8601. */
    readonly createdAt: string;
    /** Last update time, ISO 8601. */
    readonly updatedAt: string;
}
/** Commander workflow task-step lifecycle status. */
export type CommanderStepStatus = 'pending' | 'running' | 'completed' | 'failed';
/**
 * One commander workflow step: a sequenced unit of a development workflow.
 * References its workflow by id; the step index is the workflow's sequence.
 * The step never decides, executes, or judges policy — its cycle produces
 * the artifacts that the workflow history records.
 */
export interface CommanderWorkflowStep {
    /** Stable step id (UUID). */
    readonly stepId: string;
    /** The workflow this step belongs to (reference, never a copy). */
    readonly workflowId: string;
    /** The 0-based position in the workflow's sequence. */
    readonly stepIndex: number;
    /** The step's development-task title. */
    readonly title: string;
    /** Lifecycle status: pending → running → completed/failed (terminal). */
    readonly status: CommanderStepStatus;
    /** Creation time, ISO 8601. */
    readonly createdAt: string;
    /** Last update time, ISO 8601. */
    readonly updatedAt: string;
}
/**
 * One commander action execution: the record of one CommanderActionExecutor
 * call — which action ran, whether it succeeded, and when it settled.
 * References (never copies) its action by id.
 */
export interface CommanderActionExecutionRecord {
    /** Stable execution id (UUID). */
    readonly executionId: string;
    /** The action being executed (reference, never a copy). */
    readonly actionId: string;
    /** Lifecycle status. */
    readonly status: CommanderActionExecutionStatus;
    /** The action outcome; null while running. */
    readonly success: boolean | null;
    /** The failure message; null before failure. */
    readonly error: string | null;
    /** Creation time, ISO 8601. */
    readonly createdAt: string;
    /** Completion time, ISO 8601; null while running. */
    readonly completedAt: string | null;
    /** Last update time, ISO 8601. */
    readonly updatedAt: string;
}
/**
 * The plugin-owned `.devflow` read model: latest project snapshot (or null),
 * latest status per task, and agent instance list in upsert order (last one
 * wins per id). This is the v0.2 wire value the browser canvas consumes.
 */
export interface DevFlowProjectionState {
    /** The latest logged project snapshot; null before the first project/update. */
    readonly project: Project | null;
    /** Latest logged status per task id. */
    readonly tasks: Record<string, TaskStatus>;
    /** Latest human-readable title per task id, when the event carried one. */
    readonly taskTitles?: Record<string, string>;
    /** Agent instances in upsert order; the last upsert per id wins. */
    readonly agents: readonly AgentInstance[];
    /** Orchestration agent registry (id → agent); register/remove/update fold here. */
    readonly orchestrationAgents: Record<string, OrchestrationAgent>;
    /** The latest MVP plan; null before the first mvp/create. */
    readonly plan: MvpPlan | null;
    /** Phases by id; phase/create and phase/update fold here. */
    readonly phases: Record<string, Phase>;
    /** The latest scope guard; null before the first scope/update. */
    readonly scope: ScopeGuard | null;
    /** The future improvement queue in arrival order. */
    readonly improvements: readonly Improvement[];
    /** Commander checkpoints by id (the commander-context continuity records). */
    readonly commanderCheckpoints: Record<string, CommanderCheckpoint>;
    /** Phase → agent assignments by id. */
    readonly assignments: Record<string, PhaseAssignment>;
    /** Commander plans by id. */
    readonly commanderPlans: Record<string, CommanderPlan>;
    /** Execution batches by id. */
    readonly executionBatches: Record<string, ExecutionBatch>;
    /** Execution records by id. */
    readonly executions: Record<string, ExecutionRecord>;
    /** Execution attempts by id (the retryable runs of each execution). */
    readonly executionAttempts: Record<string, ExecutionAttempt>;
    /** Agent result reports by id. */
    readonly agentReports: Record<string, AgentReport>;
    /** Structured "I am blocked" records by id (the受阻上报 terminal state). */
    readonly blockedReports: Record<string, BlockedReport>;
    /** Commander decisions by id. */
    readonly commanderDecisions: Record<string, CommanderDecision>;
    /** Commander control actions by id. */
    readonly commanderActions: Record<string, CommanderAction>;
    /** Commander reviews by id (the AgentReport → decision bridge records). */
    readonly commanderReviews: Record<string, CommanderReview>;
    /** Runtime task packages by id. */
    readonly runtimePackages: Record<string, RuntimeTaskPackage>;
    /** Runtime result packages by id. */
    readonly runtimeResults: Record<string, RuntimeResultPackage>;
    /** Runtime call sessions by id. */
    readonly runtimeSessions: Record<string, RuntimeSession>;
    /** Commander structured memory by id. */
    readonly commanderMemory: Record<string, CommanderMemory>;
    /** Commander cycle schedules by id. */
    readonly commanderSchedules: Record<string, CommanderSchedule>;
    /** Commander runtime driver runs by id. */
    readonly commanderRuns: Record<string, CommanderRunRecord>;
    /** Commander action executions by id. */
    readonly commanderActionExecutions: Record<string, CommanderActionExecutionRecord>;
    /** Project governance policies by project id. */
    readonly policies: Record<string, CommanderPolicy>;
    /** Commander proposals by id. */
    readonly commanderProposals: Record<string, CommanderProposal>;
    /** Commander runtime execution contexts by id. */
    readonly commanderExecutionContexts: Record<string, CommanderExecutionContext>;
    /** Commander development workflows by id. */
    readonly commanderWorkflows: Record<string, CommanderWorkflow>;
    /** Commander workflow steps by id. */
    readonly commanderWorkflowSteps: Record<string, CommanderWorkflowStep>;
    /** ScopeGuard enforcement records in append order. */
    readonly scopeBoundaryHits: readonly ScopeBoundaryHit[];
    /** Commander decision requests by id. */
    readonly decisionRequests: Record<string, DecisionRequest>;
    /** Latest native dispatch diagnostics by tool call id. */
    readonly dispatchDiagnostics?: Record<string, DispatchDiagnostic>;
    /** Consecutive review failures by task id, reset by acceptance, completion, or answered review intervention. */
    readonly reviewFailCounts: Record<string, number>;
    /** Current interactive Commander mode for this session. */
    readonly commanderMode: 'chat' | 'commander';
    /** Timestamp of the latest explicit Commander exit, when one was logged. */
    readonly commanderModeExitAt?: string;
    /** Whether new dispatches are paused after the current work group. */
    readonly paused: boolean;
}
export interface DevFlowJournalEventMap {
    /**
     * Whole-value project context snapshot, appended on every project save.
     * Log-only, non-surface: the last one wins, and a log with none folds to
     * no project.
     */
    'devflow/project/update': {
        project: Project;
    };
    /**
     * One task status change. Task creation logs `from: null`; every later
     * change must follow the TRANSITIONS table of the task lifecycle.
     */
    'devflow/task/transition': {
        taskId: string;
        title?: string;
        from: TaskStatus | null;
        to: TaskStatus;
        at: string;
    };
    /**
     * Whole-value agent instance snapshot, appended on every instance
     * create/update. Last one wins per instance id.
     */
    'devflow/agent/upsert': {
        instance: AgentInstance;
    };
    /**
     * One task export record: a handoff document was produced for a task.
     * Log-only, non-surface.
     */
    'devflow/bridge/export': {
        taskId: string;
        bridge: string;
        at: string;
    };
    /**
     * One result import record: a result document was parsed and archived.
     * Must reference a task exported earlier in the same session.
     */
    'devflow/bridge/import': {
        taskId: string;
        resultId: string;
        protocolVersion: string;
        verdict: ResultVerdict;
        at: string;
    };
    /**
     * One planner resume generation record. Facts only — no model output,
     * no planning behavior.
     */
    'devflow/planner/resume': {
        taskId: string;
        at: string;
    };
    /**
     * One orchestration agent registered (fixed → active, temporary → created).
     */
    'devflow/agent/register': {
        agent: OrchestrationAgent;
    };
    /** One orchestration agent removed from the registry. */
    'devflow/agent/remove': {
        agentId: string;
        at: string;
    };
    /** One orchestration agent config patch applied. */
    'devflow/agent/update-config': {
        agentId: string;
        patch: AgentConfigPatch;
        at: string;
    };
    /** One temporary-agent lifecycle transition (created → running → terminated). */
    'devflow/agent/transition': {
        agentId: string;
        from: TemporaryAgentStatus;
        to: TemporaryAgentStatus;
        at: string;
    };
    /** The MVP plan was created (or replaced). */
    'devflow/mvp/create': {
        plan: MvpPlan;
    };
    /** One phase was created. */
    'devflow/phase/create': {
        phase: Phase;
    };
    /** One phase status change. */
    'devflow/phase/update': {
        phaseId: string;
        status: PhaseStatus;
        at: string;
    };
    /** The PROJECT default scope guard was updated (fallback for unscoped tasks). */
    'devflow/scope/update': {
        scope: ScopeGuard;
    };
    /** The project default scope guard was cleared. */
    'devflow/scope/clear': {
        at: string;
    };
    /**
     * One TASK's own scope guard was updated. Deliberately not folded into the
     * project default: a task's bounds must never become another task's bounds.
     */
    'devflow/scope/task-update': {
        taskId: string;
        scope: ScopeGuard;
    };
    /** One task's own scope guard was cleared. */
    'devflow/scope/task-clear': {
        taskId: string;
        at: string;
    };
    /** One task execution reached a ScopeGuard limit or completion criterion. */
    'devflow/scope/boundary-hit': {
        hit: ScopeBoundaryHit;
    };
    /** One Commander decision request was created. */
    'devflow/decision/request': {
        request: DecisionRequest;
    };
    /** One pending Commander decision request was answered. */
    'devflow/decision/answer': {
        requestId: string;
        answer: DecisionAnswer;
        at: string;
    };
    /**
     * One DevFlow preset activation was refused.
     *
     * Appended by the activation adapter itself, because the host boundary
     * cannot carry this fact for an initial activation: `session.create` fails
     * before any client surface exists, and the plugin never learns the wire
     * code. This record is the durable half of the activation self-evidence —
     * it survives a Host restart, where an in-memory field would not.
     */
    'devflow/preset/activation-failed': {
        sessionId: string;
        activationCode: DevFlowActivationCode;
        phase: DevFlowActivationFailurePhase;
        attempts: number;
        reason: string;
        at: string;
    };
    /** Interactive Commander mode entered for a project. */
    'devflow/commander/mode-enter': {
        projectId: string;
        sessionId: string;
        at: string;
    };
    /** Interactive Commander mode returned to native chat. */
    'devflow/commander/mode-exit': {
        at: string;
    };
    /** New task dispatches pause after current work settles. */
    'devflow/control/pause': {
        at: string;
    };
    /** New task dispatches resume. */
    'devflow/control/resume': {
        at: string;
    };
    /** One out-of-scope improvement was queued. */
    'devflow/improvement/add': {
        improvement: Improvement;
    };
    /** One commander checkpoint was created. */
    'devflow/commander/checkpoint/create': {
        checkpoint: CommanderCheckpoint;
    };
    /** One commander checkpoint was patched. */
    'devflow/commander/checkpoint/update': {
        checkpointId: string;
        patch: CommanderCheckpointUpdate;
        at: string;
    };
    /** One phase → agent assignment was created. */
    'devflow/orchestration/assign': {
        assignment: PhaseAssignment;
    };
    /** One task dispatch diagnostic snapshot. */
    'devflow/dispatch/diagnostic': {
        diagnostic: DispatchDiagnostic;
    };
    /** One phase → agent assignment was removed. */
    'devflow/orchestration/unassign': {
        assignmentId: string;
        at: string;
    };
    /** One phase → agent assignment status changed. */
    'devflow/orchestration/update': {
        assignmentId: string;
        status: AssignmentStatus;
        at: string;
        closeReason?: DevFlowCloseReason;
    };
    /** One stale assignment was closed (terminal, never dispatched again). */
    'devflow/orchestration/close': {
        assignmentId: string;
        closeReason: DevFlowCloseReason;
        at: string;
    };
    /** One commander plan was created. */
    'devflow/commander/plan/create': {
        plan: CommanderPlan;
    };
    /** One commander plan was patched. */
    'devflow/commander/plan/update': {
        planningId: string;
        patch: CommanderPlanUpdate;
        at: string;
    };
    /** One commander plan was activated. */
    'devflow/commander/plan/activate': {
        planningId: string;
        at: string;
    };
    /** One execution batch was created. */
    'devflow/execution/batch/create': {
        batch: ExecutionBatch;
    };
    /** One execution batch was started. */
    'devflow/execution/batch/start': {
        batchId: string;
        at: string;
    };
    /** One execution batch was paused. */
    'devflow/execution/batch/pause': {
        batchId: string;
        at: string;
    };
    /** One execution batch was completed. */
    'devflow/execution/batch/complete': {
        batchId: string;
        at: string;
    };
    /** One execution started (record born running). */
    'devflow/execution/start': {
        execution: ExecutionRecord;
    };
    /** One execution status changed. */
    'devflow/execution/update': {
        executionId: string;
        status: ExecutionStatus;
        at: string;
        closeReason?: DevFlowCloseReason;
    };
    /** One execution completed. */
    'devflow/execution/complete': {
        executionId: string;
        at: string;
    };
    /** One execution failed. */
    'devflow/execution/fail': {
        executionId: string;
        at: string;
    };
    /** One stale execution was closed (terminal, never runs again). */
    'devflow/execution/close': {
        executionId: string;
        closeReason: DevFlowCloseReason;
        at: string;
    };
    /** One execution attempt was created (status `created`). */
    'devflow/execution/attempt/create': {
        attempt: ExecutionAttempt;
    };
    /** One execution attempt began running (created → running). */
    'devflow/execution/attempt/start': {
        attemptId: string;
        at: string;
    };
    /** One execution attempt completed (running → completed). */
    'devflow/execution/attempt/complete': {
        attemptId: string;
        at: string;
    };
    /** One execution attempt failed (running → failed). */
    'devflow/execution/attempt/fail': {
        attemptId: string;
        at: string;
    };
    /** One agent report was created. */
    'devflow/agent/report/create': {
        report: AgentReport;
    };
    /** One agent report was patched. */
    'devflow/agent/report/update': {
        reportId: string;
        patch: AgentReportUpdate;
        at: string;
    };
    /** One employee reported it was blocked, with the structured reason. */
    'devflow/blocked/report': {
        blocked: BlockedReport;
    };
    /** One commander decision was created. */
    'devflow/commander/decision/create': {
        decision: CommanderDecision;
    };
    /** One commander decision was patched. */
    'devflow/commander/decision/update': {
        decisionId: string;
        patch: CommanderDecisionUpdate;
        at: string;
    };
    /** One runtime task package was exported. */
    'devflow/runtime/export': {
        package: RuntimeTaskPackage;
    };
    /** One runtime result package was imported. */
    'devflow/runtime/import': {
        result: RuntimeResultPackage;
    };
    /** One runtime session was created (status `created`). */
    'devflow/runtime/session/create': {
        session: RuntimeSession;
    };
    /** One runtime session began running (created → running). */
    'devflow/runtime/session/start': {
        sessionId: string;
        at: string;
    };
    /** One runtime session completed (running → completed). */
    'devflow/runtime/session/complete': {
        sessionId: string;
        at: string;
    };
    /** One runtime session failed (running → failed). */
    'devflow/runtime/session/fail': {
        sessionId: string;
        at: string;
    };
    /** One commander control action was created. */
    'devflow/commander/action/create': {
        action: CommanderAction;
    };
    /** One commander control action began executing. */
    'devflow/commander/action/execute': {
        actionId: string;
        at: string;
    };
    /** One commander control action completed. */
    'devflow/commander/action/complete': {
        actionId: string;
        at: string;
    };
    /** One commander review was created (status `pending`). */
    'devflow/commander/review/create': {
        review: CommanderReview;
    };
    /** One commander review completed (pending → reviewed). */
    'devflow/commander/review/complete': {
        reviewId: string;
        at: string;
    };
    /** One structured commander memory was created. */
    'devflow/memory/create': {
        memory: CommanderMemory;
    };
    /** One structured commander memory was patched. */
    'devflow/memory/update': {
        memoryId: string;
        patch: CommanderMemoryUpdate;
        at: string;
    };
    /** One commander cycle schedule was created (status `active`). */
    'devflow/commander/schedule/create': {
        schedule: CommanderSchedule;
    };
    /** One commander cycle schedule was patched (interval or run stamps). */
    'devflow/commander/schedule/update': {
        scheduleId: string;
        patch: CommanderScheduleUpdate;
        at: string;
    };
    /** One commander cycle schedule was paused (active → paused). */
    'devflow/commander/schedule/pause': {
        scheduleId: string;
        at: string;
    };
    /** One commander runtime driver run was created (status `running`). */
    'devflow/commander/run/create': {
        run: CommanderRunRecord;
    };
    /** One commander runtime driver run completed (running → completed). */
    'devflow/commander/run/complete': {
        runId: string;
        decisionId: string;
        actionId: string;
        at: string;
    };
    /** One commander runtime driver run failed (running → failed). */
    'devflow/commander/run/fail': {
        runId: string;
        at: string;
    };
    /** One commander action execution was created (status `running`). */
    'devflow/commander/action-execution/create': {
        execution: CommanderActionExecutionRecord;
    };
    /** One commander action execution completed (running → completed). */
    'devflow/commander/action-execution/complete': {
        executionId: string;
        at: string;
    };
    /** One commander action execution failed (running → failed). */
    'devflow/commander/action-execution/fail': {
        executionId: string;
        error: string;
        at: string;
    };
    /** The project governance policy was created or replaced (last one wins). */
    'devflow/policy/update': {
        policy: CommanderPolicy;
    };
    /** One commander proposal was created (status `created`). */
    'devflow/commander/proposal/create': {
        proposal: CommanderProposal;
    };
    /** One commander proposal was approved (created → approved). */
    'devflow/commander/proposal/approve': {
        proposalId: string;
        at: string;
    };
    /** One commander proposal was rejected (created → rejected). */
    'devflow/commander/proposal/reject': {
        proposalId: string;
        at: string;
    };
    /** One immutable commander runtime execution context was generated. */
    'devflow/commander/execution-context/create': {
        context: CommanderExecutionContext;
    };
    /** One commander development workflow was created (status `created`). */
    'devflow/commander/workflow/create': {
        workflow: CommanderWorkflow;
    };
    /** One commander development workflow started (created → running). */
    'devflow/commander/workflow/start': {
        workflowId: string;
        at: string;
    };
    /** One commander development workflow completed (running → completed). */
    'devflow/commander/workflow/complete': {
        workflowId: string;
        at: string;
    };
    /** One commander development workflow failed (running → failed). */
    'devflow/commander/workflow/fail': {
        workflowId: string;
        at: string;
    };
    /** One execution-history entry was appended to a workflow. */
    'devflow/commander/workflow/execution/add': {
        workflowId: string;
        entry: CommanderWorkflowExecution;
        at: string;
    };
    /** One commander workflow step was created (status `pending`). */
    'devflow/commander/step/create': {
        step: CommanderWorkflowStep;
    };
    /** One commander workflow step started (pending → running). */
    'devflow/commander/step/start': {
        stepId: string;
        at: string;
    };
    /** One commander workflow step completed (running → completed). */
    'devflow/commander/step/complete': {
        stepId: string;
        at: string;
    };
    /** One commander workflow step failed (running → failed). */
    'devflow/commander/step/fail': {
        stepId: string;
        at: string;
    };
}
export type DevFlowJournalEventType = keyof DevFlowJournalEventMap;
export type DevFlowJournalEvent<T extends DevFlowJournalEventType = DevFlowJournalEventType> = {
    [K in T]: {
        readonly type: K;
        readonly seq: number;
        readonly time: number;
        readonly data: DevFlowJournalEventMap[K];
    };
}[T];
