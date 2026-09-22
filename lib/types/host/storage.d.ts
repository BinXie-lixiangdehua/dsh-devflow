/**
 * DevFlow file-backed storage. One `.devflow` root holds the single project
 * context (`project.json`), one JSON file per task (`tasks/<id>.json`), and
 * one JSON file per result (`results/<id>.json`). Every read and write goes
 * through the `ctx.fs` seam — atomic writes with per-target locks and
 * optional version guards — so swapping the storage backend means swapping
 * the `ctx.fs` provider, never this module.
 *
 * The durable-file boundary is validated on both sides: writes reject
 * malformed records before publication, and reads reject corrupted or
 * unexpected JSON instead of returning it. Task/result ids are UUIDs and are
 * format-checked before they enter a file path.
 * @module @xiaoxie-ide/dsh-devflow/storage
 */
import type { FileSystem } from '@deepseek-ai/dsh-fs';
import { type DevFlowJsonValue } from './json.ts';
import { type ResolvedSkillContent } from './skill-binding.ts';
import type { AgentInstance, AssignedRole, Project, Result, Task } from './types.ts';
import type { AgentConfigPatch, AgentReport, AgentReportUpdate, AssignmentStatus, CommanderAction, CommanderActionStatus, CommanderCheckpoint, CommanderCheckpointUpdate, CommanderDecision, CommanderDecisionUpdate, CommanderMemory, CommanderMemoryUpdate, CommanderPlan, CommanderPlanUpdate, CommanderReview, CommanderActionExecutionRecord, CommanderPolicy, CommanderProposal, CommanderRunRecord, CommanderSchedule, CommanderScheduleUpdate, CommanderWorkflow, CommanderWorkflowExecution, CommanderWorkflowStep, DevFlowCloseReason, ExecutionAttempt, ExecutionAttemptStatus, ExecutionBatch, ExecutionBatchStatus, ExecutionRecord, ExecutionStatus, Improvement, MvpPlan, OrchestrationAgent, Phase, PhaseAssignment, PhaseStatus, RuntimeSession, RuntimeSessionStatus, ScopeGuard, TemporaryAgentStatus, DevFlowProjectionState } from './types.ts';
/** One self-contained, append-only DevFlow journal entry. */
export interface DevFlowJournalEntry {
    /** Monotonic sequence assigned under the journal head's optimistic lock. */
    readonly sequence: number;
    /** Stable UUID for idempotent callers. */
    readonly id: string;
    /** Plugin-owned audit category; never a Session event type. */
    readonly type: string;
    /** Lossless JSON payload. */
    readonly data: DevFlowJsonValue;
    /** ISO-8601 publication timestamp. */
    readonly at: string;
}
/** One bounded backwards scan of committed journal entry files. */
export interface DevFlowJournalSequencePage {
    /** Exclusive committed head captured for this scan. */
    readonly capturedHeadSequence: number;
    /** Entries in descending sequence order. */
    readonly entries: readonly DevFlowJournalEntry[];
    /** Next exclusive sequence to scan, or null at the beginning of the journal. */
    readonly nextExclusiveSequence: number | null;
    /** Direct entry files read during this bounded scan. */
    readonly scannedCount: number;
}
/** Complete read model recovered from plugin-owned journal records. */
export type DevFlowStoreState = DevFlowProjectionState;
/**
 * Task update patch. Unlike a plain `Partial<Task>`, `assignedRole` may be
 * explicitly `undefined`, which clears the assignment; an omitted key leaves
 * it untouched.
 */
export type TaskUpdate = Partial<Omit<Task, 'id' | 'createdAt' | 'assignedRole'>> & {
    assignedRole?: AssignedRole | undefined;
};
/**
 * Agent instance update patch. An omitted or `undefined` key leaves the
 * stored value untouched; the id and `createdAt` are immutable and
 * `updatedAt` is refreshed by the store.
 */
export type AgentInstanceUpdate = {
    role?: AssignedRole | undefined;
    displayName?: string | undefined;
    description?: string | undefined;
    capabilities?: readonly string[] | undefined;
    metadata?: Record<string, unknown> | undefined;
};
/**
 * File-backed DevFlow store over the `ctx.fs` seam.
 * @param fs - the filesystem backend all storage I/O goes through.
 * @param root - the `.devflow` root; a relative path resolves against the
 *   backend's cwd, an absolute path is used verbatim.
 */
export declare class DevFlowStore {
    private readonly fs;
    private readonly root;
    /**
     * Optional committed-write observer. Every `.devflow` mutation funnels through
     * {@link writeJson}, which is the store's only write seam — this is how the live
     * event channel learns that the committed state moved, without the store having
     * to know anything about who listens.
     *
     * The third argument is supplied only for a published journal record, whose
     * committed meaning is known at write time. A plain state-file write reports its
     * path alone, because inventing a meaning from a path would be a guess.
     */
    private readonly onChange?;
    /**
     * The sandbox policy every write of this store carries, when the caller
     * knows which session's workspace this store belongs to.
     *
     * Since 第九步 a store's root lives inside a project session's workspace,
     * which may sit OUTSIDE the host process cwd. The host filesystem fences a
     * write by the per-call policy and falls back to the deployment default —
     * a default whose workspace root is the host cwd — so a store write without
     * this policy is refused as out-of-bounds exactly where the project lives.
     * Supplying it states "this write belongs to that session's workspace".
     *
     * Omitted by callers that own a single store outside any session (tests, a
     * programmatic mount): they keep the backend's own default.
     */
    private readonly sandboxPolicyOf?;
    /** The committed journal id index at one observed head sequence. */
    private journalIdCache;
    /** Cached absolute store root, resolved once; see {@link relativeToRoot}. */
    private absoluteRoot;
    /**
     * Meaning of the journal record whose ENTRY has just been written but whose head
     * has not advanced yet.
     *
     * It is parked here so the head write — the report that already carries the durable
     * sequence — can publish both facts as ONE signal. Reporting the record on its own
     * would race the head report across the coalescing window, and the client would then
     * receive a frame that says "nothing you can see changed" immediately before the
     * frame that explains the change. One commit must produce one frame.
     */
    private pendingJournalRecord;
    constructor(fs: FileSystem, root: string, 
    /**
     * Optional committed-write observer. Every `.devflow` mutation funnels through
     * {@link writeJson}, which is the store's only write seam — this is how the live
     * event channel learns that the committed state moved, without the store having
     * to know anything about who listens.
     *
     * The third argument is supplied only for a published journal record, whose
     * committed meaning is known at write time. A plain state-file write reports its
     * path alone, because inventing a meaning from a path would be a guess.
     */
    onChange?: ((relativePath: string, sequence?: number, record?: {
        readonly type: string;
        readonly data: unknown;
        readonly at: string;
    }) => void) | undefined, 
    /**
     * The sandbox policy every write of this store carries, when the caller
     * knows which session's workspace this store belongs to.
     *
     * Since 第九步 a store's root lives inside a project session's workspace,
     * which may sit OUTSIDE the host process cwd. The host filesystem fences a
     * write by the per-call policy and falls back to the deployment default —
     * a default whose workspace root is the host cwd — so a store write without
     * this policy is refused as out-of-bounds exactly where the project lives.
     * Supplying it states "this write belongs to that session's workspace".
     *
     * Omitted by callers that own a single store outside any session (tests, a
     * programmatic mount): they keep the backend's own default.
     */
    sandboxPolicyOf?: (() => {
        readonly mode: string;
        readonly workspaceRoot: string;
    } | undefined) | undefined);
    /**
     * The configured `.devflow` root of this store.
     *
     * Exposed for the session-scope resolver, which reports which project a
     * session is bound to: a panel that cannot name the root cannot show that two
     * sessions are on two projects.
     */
    get rootPath(): string;
    /** Resolve the append-only journal directory. */
    private journalDirTarget;
    /** Resolve the optimistic journal-head record. */
    private journalHeadTarget;
    /** Resolve one journal entry by its stable sequence. */
    private journalEntryTarget;
    /** Resolve the project record file. */
    private projectTarget;
    /** Resolve one task record file. */
    private taskTarget;
    /** Resolve one result record file. */
    private resultTarget;
    /** Resolve one agent instance record file. */
    private agentTarget;
    /** Read one JSON record; returns undefined when the file is absent. */
    private readJson;
    /**
     * Write one JSON record; `expected` guards against blind overwrites.
     *
     * `report` is set false for the one write whose report would be pure noise: the
     * journal ENTRY file, which is always followed by the head write (the watermark)
     * and, for a published record, by the record's own meaning. Reporting it would put
     * a "nothing you can see changed" frame in front of the frame that explains the
     * change — one commit must yield exactly one frame.
     */
    private writeJson;
    /**
     * Root-relative path of one store target, or null when it lives outside the root.
     *
     * Backends hand back an absolute `displayPath` even when the configured root is
     * relative, so the root is resolved once through the same seam that builds the
     * targets and cached; a relative display path still falls back to a literal
     * prefix match.
     */
    private relativeToRoot;
    /**
     * Look up one committed id without making every append rescan the journal.
     * The cache is valid only at its observed head sequence, so a changed head
     * refreshes it before relying on a negative result from another writer.
     */
    private findJournalEntry;
    /** Remember one locally committed entry without invalidating the observed head. */
    private rememberJournalEntry;
    /**
     * Append one durable DevFlow audit record. The head file uses the filesystem
     * version as a compare-and-swap guard, so concurrent workers retry rather
     * than silently sharing a sequence. The entry is published before the head;
     * a crash can leave an unreachable tail entry, but can never make the head
     * point at a missing entry.
     */
    appendJournal(type: string, data: DevFlowJsonValue, id?: string): Promise<DevFlowJournalEntry>;
    /** Perform one journal append while this process owns the journal tail. */
    private appendJournalUnlocked;
    /**
     * Read a bounded descending sequence window without listing or parsing the
     * complete journal. Callers supply an exclusive position pinned to a
     * previously observed committed head, so later appends cannot move a page.
     */
    readCommittedJournalSequencePage(capturedHeadSequence: number | undefined, nextExclusiveSequence: number | undefined, scanLimit: number): Promise<DevFlowJournalSequencePage>;
    /** Read committed journal entries only, in their stable sequence order. */
    listJournal(): Promise<DevFlowJournalEntry[]>;
    /** Save (create or replace) the project context. */
    saveProject(project: Project): Promise<void>;
    /** Load the project context; undefined when the project has never been saved. */
    loadProject(): Promise<Project | undefined>;
    /**
     * Create and persist one task with a generated id and timestamps.
     * @param input - task fields without the store-owned id and timestamps.
     * @returns the persisted task.
     */
    createTask(input: Omit<Task, 'id' | 'createdAt' | 'updatedAt'>): Promise<Task>;
    /** Load one task; undefined when the task id is unknown. */
    getTask(id: string): Promise<Task | undefined>;
    /** Load every task in the store, oldest first; an empty tasks/ is an empty list. */
    listTasks(): Promise<Task[]>;
    /**
     * Apply a partial update to one task and refresh its `updatedAt`.
     * The id and `createdAt` are immutable; unknown tasks fail loud. An
     * `assignedRole` of `undefined` in the patch clears the assignment; an
     * omitted key leaves it untouched.
     * @param id - the task to update.
     * @param patch - the fields to replace.
     * @returns the updated task.
     */
    updateTask(id: string, patch: TaskUpdate): Promise<Task>;
    /**
     * Create and persist one result with a generated id and creation time.
     * @param input - result fields without the store-owned id and `createdAt`.
     * @returns the persisted result.
     */
    saveResult(input: Omit<Result, 'id' | 'createdAt'>): Promise<Result>;
    /** Load one result; undefined when the result id is unknown. */
    getResult(id: string): Promise<Result | undefined>;
    /** Load every result in the store, oldest first; an empty results/ is an empty list. */
    listResults(): Promise<Result[]>;
    /** Load every result for one task, oldest first; an empty results/ is an empty list. */
    listResultsByTask(taskId: string): Promise<Result[]>;
    /**
     * Read the convention import document for one task
     * (`.devflow/imports/<taskId>.md`); undefined when the user has not placed
     * a document there yet. Reads only — writing stays with the caller layer.
     */
    readImportMarkdown(taskId: string): Promise<string | undefined>;
    /**
     * Create and persist one agent instance with caller-supplied slug id and
     * store-generated timestamps. Duplicate ids fail (createIfAbsent).
     * @param input - instance fields without the store-owned timestamps.
     * @returns the persisted instance.
     */
    createAgentInstance(input: Omit<AgentInstance, 'createdAt' | 'updatedAt'>): Promise<AgentInstance>;
    /** Load one agent instance; undefined when the id is unknown. */
    getAgentInstance(id: string): Promise<AgentInstance | undefined>;
    /** Load every agent instance in the store, oldest first; an empty agents/ is an empty list. */
    listAgentInstances(): Promise<AgentInstance[]>;
    /**
     * Apply a partial update to one agent instance and refresh its `updatedAt`.
     * The id and `createdAt` are immutable; unknown instances fail loud.
     * @param id - the instance to update.
     * @param patch - the fields to replace; undefined keys leave values untouched.
     * @returns the updated instance.
     */
    updateAgentInstance(id: string, patch: AgentInstanceUpdate): Promise<AgentInstance>;
    /** Resolve one orchestration agent record file. */
    private orchestrationAgentTarget;
    /** Resolve the MVP plan record file. */
    private mvpTarget;
    /** Resolve one phase record file. */
    private phaseTarget;
    /** Resolve the scope guard record file. */
    private scopeTarget;
    /** Resolve one task's scope-guard file. */
    private taskScopeTarget;
    /** Resolve one improvement record file. */
    private improvementTarget;
    /**
     * Register one orchestration agent. Fixed agents start `active`; temporary
     * agents start `created`. Duplicate ids fail (createIfAbsent).
     * @param input - agent fields without the store-owned status and timestamps.
     * @returns the persisted agent.
     */
    registerAgent(input: Omit<OrchestrationAgent, 'status' | 'createdAt' | 'updatedAt'>): Promise<OrchestrationAgent>;
    /** Load one orchestration agent; undefined when the id is unknown or removed. */
    getAgent(agentId: string): Promise<OrchestrationAgent | undefined>;
    /** Read the repository-backed Skill contents bound to one agent, preserving binding order. */
    resolveAgentSkills(agent: Pick<OrchestrationAgent, 'skills'>): Promise<ResolvedSkillContent[]>;
    /** Load every registered orchestration agent, oldest first; skips removed agents. */
    listAgents(): Promise<OrchestrationAgent[]>;
    /**
     * Remove one orchestration agent. fs has no delete primitive, so removal is
     * a logical tombstone: the record file is replaced with a marker and every
     * reader skips it. Unknown agents fail loud.
     * @param agentId - the agent to remove.
     */
    removeAgent(agentId: string): Promise<void>;
    /**
     * Apply a partial config patch to one orchestration agent and refresh
     * `updatedAt`. The id, kind, status, and `createdAt` are immutable.
     * @param agentId - the agent to update.
     * @param patch - the fields to replace; omitted keys stay untouched.
     * @returns the updated agent.
     */
    updateAgentConfig(agentId: string, patch: AgentConfigPatch): Promise<OrchestrationAgent>;
    /**
     * Transition one temporary agent through its lifecycle. Only the legal
     * created → running → terminated edges are accepted; fixed agents have no
     * transitions.
     * @param agentId - the temporary agent to transition.
     * @param to - the target status.
     * @returns the updated agent.
     */
    transitionAgent(agentId: string, to: TemporaryAgentStatus): Promise<OrchestrationAgent>;
    /** Save (create or replace) the MVP plan. */
    saveMvpPlan(plan: MvpPlan): Promise<void>;
    /** Load the MVP plan; undefined when it has never been saved. */
    getMvpPlan(): Promise<MvpPlan | undefined>;
    /** Create and persist one phase with a generated id and timestamps. */
    createPhase(input: Omit<Phase, 'id' | 'createdAt' | 'updatedAt'>): Promise<Phase>;
    /** Load one phase; undefined when the id is unknown. */
    getPhase(id: string): Promise<Phase | undefined>;
    /** Change one phase's status and refresh its `updatedAt`. */
    updatePhaseStatus(id: string, status: PhaseStatus): Promise<Phase>;
    /**
     * Update (create or replace) the scope guard. The first update sets
     * `createdAt`; later updates keep it and refresh `updatedAt`.
     */
    updateScope(scope: Omit<ScopeGuard, 'createdAt' | 'updatedAt'>): Promise<ScopeGuard>;
    /** Load the scope guard; undefined when it has never been saved or was cleared. */
    getScope(): Promise<ScopeGuard | undefined>;
    /** Clear the PROJECT default scope (the file stays as a tombstone record). */
    clearScope(): Promise<void>;
    /**
     * Save one TASK-scoped scope guard.
     *
     * Task scopes live beside the project default rather than replacing it: the
     * project file is a fallback for a task that never set bounds, so a later
     * task can no longer overwrite the bounds an earlier task's rework rounds
     * depend on. The first update sets `createdAt`; later updates keep it.
     * @param taskId - the task the bounds belong to.
     * @param scope - summary, in-scope items, limits, and completion criteria.
     * @returns the persisted scope guard.
     */
    saveTaskScope(taskId: string, scope: Omit<ScopeGuard, 'createdAt' | 'updatedAt'>): Promise<ScopeGuard>;
    /** Load one task's scope guard; undefined when that task never set bounds. */
    getTaskScope(taskId: string): Promise<ScopeGuard | undefined>;
    /** Clear one task's scope guard (tombstone; the project default is untouched). */
    clearTaskScope(taskId: string): Promise<void>;
    /** Queue one out-of-scope improvement with a generated id and creation time. */
    addImprovement(input: Omit<Improvement, 'id' | 'createdAt'>): Promise<Improvement>;
    /** Load the improvement queue, oldest first; an empty improvements/ is an empty list. */
    listImprovements(): Promise<Improvement[]>;
    /** Resolve one commander checkpoint record file. */
    private checkpointTarget;
    /** Resolve one phase-assignment record file. */
    private assignmentTarget;
    /** Create and persist one commander checkpoint with a generated id and timestamps. */
    createCheckpoint(input: Omit<CommanderCheckpoint, 'checkpointId' | 'createdAt' | 'updatedAt'>): Promise<CommanderCheckpoint>;
    /** Load one commander checkpoint; undefined when the id is unknown. */
    getCheckpoint(id: string): Promise<CommanderCheckpoint | undefined>;
    /**
     * Apply a partial update to one commander checkpoint and refresh `updatedAt`.
     * The checkpoint id and `createdAt` are immutable; unknown ids fail loud.
     */
    updateCheckpoint(id: string, patch: CommanderCheckpointUpdate): Promise<CommanderCheckpoint>;
    /** Load every commander checkpoint, oldest first; an empty checkpoints/ is an empty list. */
    listCheckpoints(): Promise<CommanderCheckpoint[]>;
    /** Create and persist one phase assignment with a generated id and timestamps. */
    createAssignment(input: Omit<PhaseAssignment, 'assignmentId' | 'createdAt' | 'updatedAt'>): Promise<PhaseAssignment>;
    /** Load one phase assignment; undefined when the id is unknown or removed. */
    getAssignment(id: string): Promise<PhaseAssignment | undefined>;
    /**
     * Change one phase assignment's status and refresh its `updatedAt`.
     *
     * A transition to `closed` must carry a reason and stamps `closedAt`; every other
     * transition must NOT carry one, and clears any stale close stamp. The lifecycle edge
     * is checked against {@link ASSIGNMENT_TRANSITIONS}, so `completed`/`closed` are
     * terminal and a closed assignment can never be reopened.
     *
     * A close also appends its own `devflow/orchestration/close` journal record. This
     * method is where a closure is validated and committed, so it is the only place
     * every caller — tool path, runtime path, or an operator script — can be made to
     * leave the same audit trail. {@link appendClosure} explains why the append is
     * best-effort.
     */
    updateAssignmentStatus(id: string, status: AssignmentStatus, closeReason?: DevFlowCloseReason): Promise<PhaseAssignment>;
    /** Remove one phase assignment via a logical tombstone (fs has no delete). */
    unassignAssignment(id: string): Promise<void>;
    /** Load every phase assignment, oldest first; skips removed assignments. */
    listAssignments(): Promise<PhaseAssignment[]>;
    /** Resolve one commander plan record file. */
    private planningTarget;
    /** Resolve one execution batch record file. */
    private batchTarget;
    /** Create and persist one commander plan (starts `draft`). */
    createPlanning(input: Omit<CommanderPlan, 'planningId' | 'status' | 'createdAt' | 'updatedAt'>): Promise<CommanderPlan>;
    /** Load one commander plan; undefined when the id is unknown. */
    getPlanning(id: string): Promise<CommanderPlan | undefined>;
    /** Apply a partial update to one commander plan and refresh `updatedAt`. */
    updatePlanning(id: string, patch: CommanderPlanUpdate): Promise<CommanderPlan>;
    /** Activate one commander plan (draft → active). */
    activatePlanning(id: string): Promise<CommanderPlan>;
    /** Load every commander plan, oldest first; an empty planning/ is an empty list. */
    listPlanning(): Promise<CommanderPlan[]>;
    /** Create and persist one execution batch (starts `planned`). */
    createBatch(input: Omit<ExecutionBatch, 'batchId' | 'status' | 'createdAt' | 'updatedAt'>): Promise<ExecutionBatch>;
    /** Load one execution batch; undefined when the id is unknown. */
    getBatch(id: string): Promise<ExecutionBatch | undefined>;
    /** Transition one execution batch's status, validating the lifecycle edge. */
    updateBatchStatus(id: string, status: ExecutionBatchStatus): Promise<ExecutionBatch>;
    /** Load every execution batch, oldest first; an empty batches/ is an empty list. */
    listBatches(): Promise<ExecutionBatch[]>;
    /** Resolve one execution record file. */
    private executionTarget;
    /** Resolve one agent report record file. */
    private reportTarget;
    /** Create and persist one execution record (starts `pending`). */
    createExecutionRecord(input: Omit<ExecutionRecord, 'executionId' | 'status' | 'startedAt' | 'completedAt' | 'createdAt' | 'updatedAt'>): Promise<ExecutionRecord>;
    /** Load one execution record; undefined when the id is unknown. */
    getExecutionRecord(id: string): Promise<ExecutionRecord | undefined>;
    /**
     * Transition one execution's status, validating the lifecycle edge and stamping
     * `startedAt`/`completedAt` on the crossing edges.
     *
     * `closed` is the terminal "can never run again" state: it stamps `closedAt` and
     * carries a mandatory reason, and it clears the close stamp on every other edge so a
     * record can never keep a stale closure.
     *
     * A close also appends its own `devflow/execution/close` journal record, for the
     * same reason {@link updateAssignmentStatus} does: this is the one seam every
     * closer passes through.
     */
    updateExecutionStatus(id: string, status: ExecutionStatus, closeReason?: DevFlowCloseReason): Promise<ExecutionRecord>;
    /**
     * Append the journal record that makes one closure auditable.
     *
     * Best-effort by design: the close itself is already committed to its own
     * entity file, and turning a journal write failure into a thrown error would
     * report a successful close as a failure while leaving the record closed on
     * disk — the caller would then retry a transition the lifecycle table already
     * forbids. A missing entry therefore degrades the audit trail, never the
     * closure, and the entity file remains the authority for what the record says.
     * @param type - the dedicated close event type.
     * @param data - the closure's identity, reason, and stamp.
     */
    private appendClosure;
    /** Load every execution record for one task, oldest first. */
    listExecutionsByTask(taskId: string): Promise<ExecutionRecord[]>;
    /** Load every execution record for one batch, oldest first. */
    listExecutionsByBatch(batchId: string): Promise<ExecutionRecord[]>;
    /** Create and persist one agent report with a generated id and timestamps. */
    createReport(input: Omit<AgentReport, 'reportId' | 'createdAt' | 'updatedAt'>): Promise<AgentReport>;
    /** Load one agent report; undefined when the id is unknown. */
    getReport(id: string): Promise<AgentReport | undefined>;
    /** Load every report for all executions of one task, oldest first. */
    listReportsByTask(taskId: string): Promise<AgentReport[]>;
    /** Load every report for one execution, oldest first. */
    listReportsByExecution(executionId: string): Promise<AgentReport[]>;
    /** Apply a partial update to one agent report and refresh `updatedAt`. */
    updateReport(id: string, patch: AgentReportUpdate): Promise<AgentReport>;
    /** Resolve one commander decision record file. */
    private decisionTarget;
    /** Create and persist one commander decision with a generated id and timestamps. */
    createDecision(input: Omit<CommanderDecision, 'decisionId' | 'createdAt' | 'updatedAt'>): Promise<CommanderDecision>;
    /** Load one commander decision; undefined when the id is unknown. */
    getDecision(id: string): Promise<CommanderDecision | undefined>;
    /** Load every commander decision, oldest first; an empty decisions/ is an empty list. */
    listDecisions(): Promise<CommanderDecision[]>;
    /** Apply a partial update to one commander decision and refresh `updatedAt`. */
    updateDecision(id: string, patch: CommanderDecisionUpdate): Promise<CommanderDecision>;
    /** Resolve one commander control action record file. */
    private actionTarget;
    /** Create and persist one commander control action with a generated id and timestamps. */
    createAction(input: Omit<CommanderAction, 'actionId' | 'status' | 'createdAt' | 'updatedAt'>): Promise<CommanderAction>;
    /** Load one commander control action; undefined when the id is unknown. */
    getAction(id: string): Promise<CommanderAction | undefined>;
    /** Load every commander control action, oldest first; an empty actions/ is an empty list. */
    listActions(): Promise<CommanderAction[]>;
    /**
     * Transition one commander control action's status through the created →
     * executing → completed chain and refresh `updatedAt`.
     */
    updateActionStatus(id: string, status: CommanderActionStatus): Promise<CommanderAction>;
    /** Resolve one runtime session record file. */
    private sessionTarget;
    /**
     * Create and persist one runtime session (starts `created`).
     * @param input - session fields without the store-owned id, status,
     *   timestamps, and start/complete stamps.
     * @returns the persisted session.
     */
    createRuntimeSession(input: Omit<RuntimeSession, 'sessionId' | 'status' | 'startedAt' | 'completedAt' | 'createdAt' | 'updatedAt'>): Promise<RuntimeSession>;
    /** Load one runtime session; undefined when the id is unknown. */
    getRuntimeSession(id: string): Promise<RuntimeSession | undefined>;
    /**
     * Transition one runtime session's status, validating the lifecycle edge
     * and stamping `startedAt`/`completedAt` on the crossing edges.
     */
    updateRuntimeSessionStatus(id: string, status: RuntimeSessionStatus): Promise<RuntimeSession>;
    /** Load every runtime session for one execution, oldest first. */
    listRuntimeSessionsByExecution(executionId: string): Promise<RuntimeSession[]>;
    /**
     * Persist one complete agent report record as-is (validate + write). This
     * keeps the report id and timestamps produced by the runtime bridge — the
     * caller layer that converted a runtime result package — authoritative.
     * @param report - the complete report record to persist.
     */
    saveReport(report: AgentReport): Promise<void>;
    /** Resolve one execution attempt record file. */
    private attemptTarget;
    /**
     * Create and persist one execution attempt (starts `created`). A retry
     * chains a new attempt under the previous one via `parentAttemptId` and
     * records why it exists in `reason`.
     * @param input - attempt fields without the store-owned id, status,
     *   `createdAt`, `completedAt`, and `updatedAt`.
     * @returns the persisted attempt.
     */
    createAttempt(input: Omit<ExecutionAttempt, 'attemptId' | 'status' | 'createdAt' | 'completedAt' | 'updatedAt'>): Promise<ExecutionAttempt>;
    /** Load one execution attempt; undefined when the id is unknown. */
    getAttempt(id: string): Promise<ExecutionAttempt | undefined>;
    /**
     * Transition one execution attempt's status, validating the lifecycle edge
     * and stamping `completedAt` on the terminal edges.
     */
    updateAttemptStatus(id: string, status: ExecutionAttemptStatus): Promise<ExecutionAttempt>;
    /** Load every execution attempt for one execution, oldest first. */
    listAttemptsByExecution(executionId: string): Promise<ExecutionAttempt[]>;
    /** Resolve one commander review record file. */
    private reviewTarget;
    /**
     * Create and persist one commander review (starts `pending`).
     * @param input - review fields without the store-owned id, status, and
     *   timestamps.
     * @returns the persisted review.
     */
    createReview(input: Omit<CommanderReview, 'reviewId' | 'status' | 'createdAt' | 'updatedAt'>): Promise<CommanderReview>;
    /** Load one commander review; undefined when the id is unknown. */
    getReview(id: string): Promise<CommanderReview | undefined>;
    /**
     * Complete one commander review (pending → reviewed) and refresh
     * `updatedAt`. The review carries no decision content — a future Commander
     * fills the decision from an explicit review outcome.
     */
    completeReview(id: string): Promise<CommanderReview>;
    /** Load every commander review for one execution, oldest first. */
    listReviewsByExecution(executionId: string): Promise<CommanderReview[]>;
    /** Resolve one commander memory record file. */
    private memoryTarget;
    /**
     * Create and persist one structured commander memory with a generated id
     * and timestamps.
     * @param input - memory fields without the store-owned id and timestamps.
     * @returns the persisted memory.
     */
    createMemory(input: Omit<CommanderMemory, 'memoryId' | 'createdAt' | 'updatedAt'>): Promise<CommanderMemory>;
    /** Load one commander memory; undefined when the id is unknown. */
    getMemory(id: string): Promise<CommanderMemory | undefined>;
    /**
     * Apply a partial update to one commander memory and refresh `updatedAt`.
     * The id, project, type, and `createdAt` are immutable; unknown ids fail
     * loud.
     */
    updateMemory(id: string, patch: CommanderMemoryUpdate): Promise<CommanderMemory>;
    /** Load every commander memory for one project, oldest first. */
    listMemoriesByProject(projectId: string): Promise<CommanderMemory[]>;
    /** Resolve one commander schedule record file. */
    private scheduleTarget;
    /**
     * Create and persist one commander schedule (starts `active` with no last
     * run and the first `nextRunAt` one interval ahead).
     * @param input - schedule fields without the store-owned id, status,
     *   run stamps, and timestamps.
     * @returns the persisted schedule.
     */
    createSchedule(input: Omit<CommanderSchedule, 'scheduleId' | 'status' | 'lastRunAt' | 'nextRunAt' | 'createdAt' | 'updatedAt'>): Promise<CommanderSchedule>;
    /** Load one commander schedule; undefined when the id is unknown. */
    getSchedule(id: string): Promise<CommanderSchedule | undefined>;
    /**
     * Apply a partial update to one commander schedule: an interval change
     * rolls `nextRunAt` forward, and a `markRunAt` stamp records a completed
     * run. Unknown ids fail loud.
     */
    updateSchedule(id: string, patch: CommanderScheduleUpdate): Promise<CommanderSchedule>;
    /** Pause one commander schedule (active → paused) and refresh `updatedAt`. */
    pauseSchedule(id: string): Promise<CommanderSchedule>;
    /** Load every commander schedule, oldest first; an empty schedules/ is an empty list. */
    listSchedules(): Promise<CommanderSchedule[]>;
    /** Resolve one commander run record file. */
    private runTarget;
    /**
     * Create and persist one commander run record (born `running`).
     * @param input - run fields without the store-owned id, status, produced
     *   ids, and timestamps.
     * @returns the persisted run.
     */
    createRunRecord(input: Omit<CommanderRunRecord, 'runId' | 'status' | 'decisionId' | 'actionId' | 'startedAt' | 'completedAt' | 'updatedAt'>): Promise<CommanderRunRecord>;
    /** Load one commander run record; undefined when the id is unknown. */
    getRunRecord(id: string): Promise<CommanderRunRecord | undefined>;
    /**
     * Complete one commander run (running → completed): record the produced
     * decision and action ids and stamp `completedAt`.
     */
    completeRunRecord(id: string, decisionId: string, actionId: string): Promise<CommanderRunRecord>;
    /** Fail one commander run (running → failed) and stamp `completedAt`. */
    failRunRecord(id: string): Promise<CommanderRunRecord>;
    /** Load every commander run record for one project, oldest first. */
    listRunRecordsByProject(projectId: string): Promise<CommanderRunRecord[]>;
    /** Resolve one commander action execution record file. */
    private actionExecutionTarget;
    /**
     * Create and persist one commander action execution (born `running` with no
     * outcome yet).
     * @param input - execution fields without the store-owned id, status,
     *   outcome, and timestamps.
     * @returns the persisted execution.
     */
    createActionExecution(input: Omit<CommanderActionExecutionRecord, 'executionId' | 'status' | 'success' | 'error' | 'createdAt' | 'completedAt' | 'updatedAt'>): Promise<CommanderActionExecutionRecord>;
    /** Load one commander action execution; undefined when the id is unknown. */
    getActionExecution(id: string): Promise<CommanderActionExecutionRecord | undefined>;
    /** Complete one action execution (running → completed, success true) and stamp `completedAt`. */
    completeActionExecution(id: string): Promise<CommanderActionExecutionRecord>;
    /** Fail one action execution (running → failed, success false) with the error, and stamp `completedAt`. */
    failActionExecution(id: string, error: string): Promise<CommanderActionExecutionRecord>;
    /** Load every commander action execution for one action, oldest first. */
    listActionExecutionsByAction(actionId: string): Promise<CommanderActionExecutionRecord[]>;
    /** Resolve one project policy record file. */
    private policyTarget;
    /**
     * Save (create or replace) the governance policy for one project. The
     * first save sets `createdAt`; later saves keep it and refresh `updatedAt`.
     * @param policy - policy fields without the store-owned timestamps.
     * @returns the persisted policy.
     */
    savePolicy(policy: Omit<CommanderPolicy, 'createdAt' | 'updatedAt'>): Promise<CommanderPolicy>;
    /** Load the governance policy for one project; undefined when never saved. */
    getPolicy(projectId: string): Promise<CommanderPolicy | undefined>;
    /** Resolve one commander proposal record file. */
    private proposalTarget;
    /**
     * Create and persist one commander proposal (starts `created`).
     * @param input - proposal fields without the store-owned id, status, and
     *   timestamps.
     * @returns the persisted proposal.
     */
    createProposal(input: Omit<CommanderProposal, 'proposalId' | 'status' | 'createdAt' | 'updatedAt'>): Promise<CommanderProposal>;
    /** Load one commander proposal; undefined when the id is unknown. */
    getProposal(id: string): Promise<CommanderProposal | undefined>;
    /** Approve one commander proposal (created → approved) and refresh `updatedAt`. */
    approveProposal(id: string): Promise<CommanderProposal>;
    /** Reject one commander proposal (created → rejected) and refresh `updatedAt`. */
    rejectProposal(id: string): Promise<CommanderProposal>;
    /** Load every commander proposal for one decision, oldest first. */
    listProposalsByDecision(decisionId: string): Promise<CommanderProposal[]>;
    /** Resolve one commander workflow record file. */
    private workflowTarget;
    /**
     * Create and persist one commander development workflow (born `created`
     * with an empty execution history).
     * @param input - workflow fields without the store-owned id, status,
     *   history, and timestamps.
     * @returns the persisted workflow.
     */
    createWorkflow(input: Omit<CommanderWorkflow, 'workflowId' | 'status' | 'history' | 'createdAt' | 'updatedAt'>): Promise<CommanderWorkflow>;
    /** Load one commander workflow; undefined when the id is unknown. */
    getWorkflow(id: string): Promise<CommanderWorkflow | undefined>;
    /** Start one commander workflow (created → running) and refresh `updatedAt`. */
    startWorkflow(id: string): Promise<CommanderWorkflow>;
    /** Complete one commander workflow (running → completed) and refresh `updatedAt`. */
    completeWorkflow(id: string): Promise<CommanderWorkflow>;
    /** Fail one commander workflow (running → failed) and refresh `updatedAt`. */
    failWorkflow(id: string): Promise<CommanderWorkflow>;
    /** Append one execution-history entry to a running workflow and refresh `updatedAt`. */
    appendWorkflowExecution(id: string, entry: CommanderWorkflowExecution): Promise<CommanderWorkflow>;
    /** Load every commander workflow for one project, oldest first. */
    listWorkflowsByProject(projectId: string): Promise<CommanderWorkflow[]>;
    /** Resolve one commander workflow step record file. */
    private stepTarget;
    /**
     * Create and persist one commander workflow step (born `pending`).
     * @param input - step fields without the store-owned id, status, and
     *   timestamps.
     * @returns the persisted step.
     */
    createStep(input: Omit<CommanderWorkflowStep, 'stepId' | 'status' | 'createdAt' | 'updatedAt'>): Promise<CommanderWorkflowStep>;
    /** Load one commander workflow step; undefined when the id is unknown. */
    getStep(id: string): Promise<CommanderWorkflowStep | undefined>;
    /** Start one commander workflow step (pending → running) and refresh `updatedAt`. */
    startStep(id: string): Promise<CommanderWorkflowStep>;
    /** Complete one commander workflow step (running → completed) and refresh `updatedAt`. */
    completeStep(id: string): Promise<CommanderWorkflowStep>;
    /** Fail one commander workflow step (running → failed) and refresh `updatedAt`. */
    failStep(id: string): Promise<CommanderWorkflowStep>;
    /** Load every commander workflow step for one workflow, in sequence order. */
    listStepsByWorkflow(workflowId: string): Promise<CommanderWorkflowStep[]>;
    /** Read all valid records in one store directory, ordered by creation time. */
    private listRecords;
    /**
     * Recover the complete state from entity files plus the committed plugin
     * journal. Entity files are authoritative for current records; the journal
     * supplies ordering and control facts that have no standalone file.
     */
    loadState(): Promise<DevFlowStoreState>;
}
