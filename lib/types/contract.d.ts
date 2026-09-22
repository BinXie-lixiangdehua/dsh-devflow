/**
 * Versioned, JSON-safe DevFlow browser contract.
 *
 * This module deliberately has no Host or Client runtime imports: both sides
 * agree on this DTO without exposing `.devflow` files, journal records, or
 * execution credentials.
 */
export declare const DEVFLOW_CLIENT_SNAPSHOT_VERSION: 1;
/**
 * How many `devflow_dispatch_agent` calls may be in flight at once.
 *
 * **Single point of definition** (boss 2026-09-21 01:49: 起步 5). This module is
 * the only file both build targets compile (`tsconfig.json` includes
 * `src/contract.ts` for the host, `tsconfig.client.json` for the client), so the
 * host's admission predicate and the panel's `并发 N/5` read the SAME number and
 * cannot drift into two copies of "5" — a write-time contract, not a
 * convention. Editing the limit is editing this one line.
 *
 * The host enforces it (a dispatch beyond it is classified `exclusive` and waits
 * behind the running group — 超限排队); the client only DISPLAYS it.
 */
export declare const DEVFLOW_CONCURRENCY_LIMIT: 5;
export type DevFlowClientTaskStatus = 'created' | 'planned' | 'executing' | 'reviewing' | 'completed' | 'failed' | 'cancelled';
export type DevFlowClientRole = 'planner' | 'backend-engineer' | 'frontend-engineer' | 'reviewer';
export interface DevFlowClientProject {
    readonly id: string;
    readonly name: string;
    readonly goal: string;
    readonly currentStage: string;
}
export interface DevFlowClientAgent {
    readonly id: string;
    readonly role: DevFlowClientRole;
    readonly kind: 'fixed' | 'temporary';
    readonly status: 'active' | 'created' | 'running' | 'terminated';
    readonly displayName: string;
    readonly model: string;
    readonly provider?: string;
    /**
     * Additive roster pass-through of the stored Orchestration Agent: the bound
     * Skill ids in their stored order, the capability tags, and the delegation
     * depth. They are read from the same `.devflow` record the snapshot already
     * projects; no new read path or subscription is introduced.
     */
    readonly skills?: readonly string[];
    readonly capabilities?: readonly string[];
    readonly delegationDepth?: number;
}
export interface DevFlowClientTask {
    readonly id: string;
    readonly title: string;
    readonly description: string;
    readonly status: DevFlowClientTaskStatus;
    readonly assignedRole?: DevFlowClientRole;
    readonly updatedAt: string;
}
export interface DevFlowClientPhase {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly status: 'planned' | 'in_progress' | 'completed';
}
export interface DevFlowClientAssignment {
    readonly id: string;
    readonly taskId?: string;
    readonly phaseId: string;
    readonly agentId: string;
    readonly role: DevFlowClientRole;
    /** `closed` is terminal: the dispatch can never continue (see `DevFlowCloseReason`). */
    readonly status: 'assigned' | 'in_progress' | 'completed' | 'closed';
    /** Close stamp; present exactly while {@link status} is `closed`. */
    readonly closedAt?: string;
    /** Close reason; present exactly while {@link status} is `closed`. */
    readonly closeReason?: DevFlowClientCloseReason;
}
/**
 * Why a stale record was closed. The vocabulary is closed on purpose: the panel shows
 * one fixed phrase per reason and never invents a new one from the record.
 */
export type DevFlowClientCloseReason = 'stale-lost' | 'superseded' | 'abandoned';
export interface DevFlowClientExecution {
    readonly id: string;
    readonly assignmentId: string;
    readonly taskId?: string;
    readonly agentId: string;
    /** `closed` is terminal: the execution can never run again. */
    readonly status: 'pending' | 'running' | 'completed' | 'failed' | 'closed';
    readonly startedAt: string | null;
    readonly completedAt: string | null;
    /** Close stamp; present exactly while {@link status} is `closed`. */
    readonly closedAt?: string;
    /** Close reason; present exactly while {@link status} is `closed`. */
    readonly closeReason?: DevFlowClientCloseReason;
}
/** One bounded piece of text approved for browser display. */
export interface DevFlowClientSafeText {
    readonly text: string;
    readonly truncated: boolean;
    readonly redacted: boolean;
}
/**
 * The DevFlow preset activation posture of one session, computed Host-side.
 *
 * `bound` is a verified conjunction (live Agent ↔ session, composed preset is
 * `devflow`, Commander is installed on this Agent with a non-empty shared
 * project, and the `.devflow` project record still exists and agrees). It is
 * never derived from a selection event or a journal record alone.
 */
export type DevFlowClientActivation = 'bound' | 'unbound' | 'error';
/** Stable, bounded activation failure surface; never raw error text. */
export interface DevFlowClientActivationError {
    /** Stable allowlisted code, e.g. `devflow-project-unavailable`. */
    readonly code: string;
    /** Fixed diagnostic summary; may not carry paths, prompts, or credentials. */
    readonly message: string;
}
/** One recorded activation refusal, as the panel shows it. */
export interface DevFlowClientActivationFailure {
    /** Stable allowlisted refusal code. */
    readonly code: string;
    /** The refused act: `initial` (create-time mount) or `recompose` (a switch). */
    readonly phase: string;
    /** Activation runs consumed before the refusal settled; 1 means first try. */
    readonly attempts: number;
    /** Fixed Chinese sentence naming the actionable cause. */
    readonly reason: string;
    /** ISO-8601 time the refusal settled. */
    readonly at: string;
}
/**
 * One blocked dispatch the panel must show without the user opening a chat.
 *
 * This is the product's "受阻" terminal state: it exists only because an
 * employee's own reply declared it was blocked, and it carries the structured
 * reason so the panel can render one plain-language line.
 */
export interface DevFlowClientBlocked {
    /** Stable blocked-report id. */
    readonly id: string;
    /** The task the blocked dispatch belonged to. */
    readonly taskId: string;
    /** The employee that reported the block. */
    readonly agentId: string;
    /** Chinese display name of that employee. */
    readonly agentName: string;
    /** What class of capability was missing. */
    readonly gapKind: 'tool' | 'permission' | 'dependency' | 'unstated';
    /** The specific capability the employee named. */
    readonly missing: string;
    /** Who the employee said could clear it. */
    readonly suggestedOwner: string;
    /** The employee's own one-sentence reason, bounded and redacted. */
    readonly reason: DevFlowClientSafeText;
    /** The one line the panel shows, already assembled. */
    readonly headline: string;
    /** Creation time, ISO 8601. */
    readonly at: string;
}
/** One session's preset identity and verified activation state. */
export interface DevFlowClientSession {
    readonly id: string;
    readonly commanderMode: 'chat' | 'commander';
    /**
     * The session's workspace directory, or null when it carries none.
     *
     * Since 第九步 this is the session's PROJECT IDENTIFIER: the panel names the
     * project a session is isolated to, so an operator can see at a glance which
     * of several projects this panel is showing. Absent in pre-第九步 snapshots,
     * which parse as null.
     */
    readonly workspacePath?: string | null;
    /** The `.devflow` root behind this session's project, when known. */
    readonly storeRoot?: string | null;
    /** The preset the live Agent's scope is actually composed from, or null. */
    readonly presetId: string | null;
    /** Verified activation posture of this session. */
    readonly activation: DevFlowClientActivation;
    /** Present only while `activation` is `error`. */
    readonly activationError: DevFlowClientActivationError | null;
    /** ISO-8601 time of the last successful Bound verification, or null. */
    readonly verifiedAt: string | null;
    /**
     * The last recorded refusal, or null when none was recorded.
     *
     * Rides the snapshot independently of {@link activationError} so a session
     * that failed and later recovered still shows what went wrong, and so the
     * panel can surface the reason without reading the Host journal.
     */
    readonly lastActivationFailure: DevFlowClientActivationFailure | null;
}
/** Safe projection of a durable task result; it has no execution relationship. */
export interface DevFlowClientResultSummary {
    readonly id: string;
    readonly taskId: string;
    readonly source: 'result';
    readonly at: string;
    readonly summary: DevFlowClientSafeText;
}
/** Safe projection of an Agent report for one real execution. */
export interface DevFlowClientReportSummary {
    readonly id: string;
    readonly executionId: string;
    readonly taskId?: string;
    readonly agentId: string;
    readonly source: 'report';
    readonly status: 'success' | 'failed' | 'blocked';
    readonly at: string;
    readonly summary: DevFlowClientSafeText;
}
/** Safe projection of one execution attempt; reason text is intentionally absent. */
export interface DevFlowClientAttemptSummary {
    readonly id: string;
    readonly executionId: string;
    readonly source: 'attempt';
    readonly status: 'created' | 'running' | 'completed' | 'failed';
    readonly isRetry: boolean;
    readonly at: string;
    readonly completedAt: string | null;
}
/** Safe failure fact or an explicitly redacted failure report summary. */
export interface DevFlowClientFailureSummary {
    readonly id: string;
    readonly executionId: string;
    readonly taskId?: string;
    readonly agentId: string;
    readonly source: 'execution' | 'report';
    readonly status: 'failed' | 'blocked';
    readonly at: string;
    readonly summary: DevFlowClientSafeText | null;
}
export interface DevFlowClientDecision {
    readonly id: string;
    readonly type: 'continue' | 'retry' | 'pause' | 'request_user';
    readonly summary: string;
    readonly nextAction: string;
    readonly createdAt: string;
}
export interface DevFlowClientDecisionRequest {
    readonly id: string;
    readonly taskId: string | null;
    readonly trigger: string;
    readonly question: string;
    readonly options: readonly {
        readonly id: string;
        readonly label: string;
        readonly description: string;
        readonly recommended: boolean;
    }[];
    readonly status: 'pending' | 'answered' | 'dismissed';
}
/** One complete safe Canvas read model at a single host read boundary. */
export interface DevFlowClientSnapshot {
    readonly version: typeof DEVFLOW_CLIENT_SNAPSHOT_VERSION;
    readonly generatedAt: string;
    readonly session: DevFlowClientSession;
    readonly paused: boolean;
    readonly project: DevFlowClientProject | null;
    readonly agents: readonly DevFlowClientAgent[];
    readonly tasks: readonly DevFlowClientTask[];
    readonly phases: readonly DevFlowClientPhase[];
    readonly assignments: readonly DevFlowClientAssignment[];
    readonly executions: readonly DevFlowClientExecution[];
    /** Optional additive P0B fields; absent in older V1 snapshots. */
    readonly results?: readonly DevFlowClientResultSummary[];
    readonly reports?: readonly DevFlowClientReportSummary[];
    readonly attempts?: readonly DevFlowClientAttemptSummary[];
    readonly failures?: readonly DevFlowClientFailureSummary[];
    readonly decisions: readonly DevFlowClientDecision[];
    readonly decisionRequests: readonly DevFlowClientDecisionRequest[];
    /**
     * Blocked dispatches, newest first. Optional and additive: an older snapshot
     * without it parses, and the panel simply shows no blocked row.
     */
    readonly blocked?: readonly DevFlowClientBlocked[];
}
/** Stable public failure; its message must never contain host paths or raw errors. */
export interface DevFlowClientStateError {
    /**
     * `state-unavailable` is the generic "could not read" posture.
     *
     * `scope-unavailable` is the 第九步 isolation refusal: this session carries no
     * workspace, so there is no project to scope it to, and the host refuses to
     * answer from the shared library. The two are distinct on purpose — a session
     * that could not be ISOLATED must not look like one that merely failed to
     * load.
     */
    readonly code: 'state-unavailable' | 'scope-unavailable';
    readonly message: 'DevFlow state is unavailable. Refresh to try again.' | 'DevFlow cannot isolate this session: it has no project workspace. Shared state is not shown.';
}
export type DevFlowClientSnapshotResponse = {
    readonly kind: 'snapshot';
    readonly snapshot: DevFlowClientSnapshot;
} | {
    readonly kind: 'error';
    readonly error: DevFlowClientStateError;
};
/** P1A is independently versioned so V1 snapshot/refresh stays stable. */
export declare const DEVFLOW_CLIENT_AUDIT_PAGE_VERSION: 1;
export declare const DEVFLOW_CLIENT_AUDIT_PAGE_LIMIT: 20;
export declare const DEVFLOW_CLIENT_AUDIT_TEXT_LIMIT: 500;
export declare const DEVFLOW_CLIENT_AUDIT_PAGE_BYTES: 49152;
export type DevFlowClientAuditFilter = {
    readonly kind: 'project';
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
/** Browser input for one safe audit page. It has no path, Session, or project field. */
export interface DevFlowClientAuditQuery {
    readonly cursor?: string;
    readonly filter?: DevFlowClientAuditFilter;
    readonly range?: {
        readonly from?: string;
        readonly to?: string;
    };
}
export type DevFlowClientAuditCategory = 'project' | 'task' | 'phase' | 'agent' | 'assignment' | 'execution' | 'attempt' | 'report' | 'decision' | 'control' | 'scope' | 'bridge-review' | 'runtime' | 'commander-action';
export type DevFlowClientAuditAction = 'updated' | 'created' | 'removed' | 'transitioned' | 'assigned' | 'unassigned' | 'started' | 'completed' | 'failed' | 'blocked' | 'requested' | 'answered' | 'paused' | 'resumed' | 'imported' | 'exported' | 'boundary-hit' | 'executed'
/** A stale record was closed: terminal, never continues (the 收尾终态 statement). */
 | 'closed';
export type DevFlowClientAuditEntityType = 'project' | 'task' | 'phase' | 'agent' | 'assignment' | 'execution' | 'attempt' | 'report' | 'decision-request' | 'decision' | 'batch' | 'runtime-session' | 'review' | 'action' | 'unknown';
/** One allowlisted, safe browser projection of a committed DevFlow journal entry. */
export interface DevFlowClientAuditItem {
    readonly id: string;
    readonly sequence: number;
    readonly category: DevFlowClientAuditCategory;
    readonly action: DevFlowClientAuditAction;
    readonly at: string;
    readonly entity: {
        readonly type: DevFlowClientAuditEntityType;
        readonly id: string | null;
        readonly display: DevFlowClientSafeText | null;
    };
    readonly related: {
        readonly projectId?: string;
        readonly taskId?: string;
        readonly phaseId?: string;
        readonly agentId?: string;
        readonly assignmentId?: string;
        readonly executionId?: string;
        readonly attemptId?: string;
        readonly reportId?: string;
        readonly decisionId?: string;
        readonly requestId?: string;
    };
    readonly status: string | null;
    readonly summary: DevFlowClientSafeText | null;
    readonly incomplete: boolean;
}
/** A bounded, cursor-paginated read from the plugin-owned committed journal only. */
export interface DevFlowClientAuditPage {
    readonly version: typeof DEVFLOW_CLIENT_AUDIT_PAGE_VERSION;
    readonly source: 'devflow-journal';
    readonly projectId: string | null;
    readonly range: {
        readonly from: string;
        readonly to: string;
    };
    readonly items: readonly DevFlowClientAuditItem[];
    readonly nextCursor: string | null;
    readonly capturedHeadSequence: number | null;
    readonly omittedUnsafeCount: number;
    readonly truncated: boolean;
}
export interface DevFlowClientAuditError {
    readonly code: 'audit-unavailable' | 'cursor-invalid';
    readonly message: 'DevFlow audit is unavailable. Refresh to try again.' | 'DevFlow audit history changed. Refresh to try again.';
}
export type DevFlowClientAuditPageResponse = {
    readonly kind: 'page';
    readonly page: DevFlowClientAuditPage;
} | {
    readonly kind: 'error';
    readonly error: DevFlowClientAuditError;
};
/**
 * The live event channel's payload.
 *
 * The channel is a SIGNAL, not a second source of truth: `snapshot` carries the
 * same read model the unary `snapshot` Remote returns, and `changed` says only
 * that the committed `.devflow` state moved on. A client may therefore drop any
 * frame it cannot order (or replay one twice) without corrupting its view, and it
 * always re-reads the model through the existing snapshot path.
 */
export type DevFlowClientEvent = {
    readonly kind: 'snapshot';
    readonly snapshot: DevFlowClientSnapshot;
} | {
    /** In-process revision of the committed state; strictly increasing per host run. */
    readonly kind: 'changed';
    readonly revision: number;
    /** Durable journal head sequence, or null when the project has no journal yet. */
    readonly sequence: number | null;
    /** Root-relative `.devflow` paths in this batch, for diagnostics only. */
    readonly changed: readonly string[];
    /**
     * Bounded semantic changes committed in this batch, or `[]`.
     *
     * A HINT, never truth: the client uses it to keep motion tied to real events,
     * and still re-reads the snapshot for every fact it renders. Empty means either
     * "nothing the canvas draws changed" or "the batch was too large to describe" —
     * both degrade to the pre-existing watermark-only contract, and neither may be
     * rendered as state.
     */
    readonly changes: readonly DevFlowClientChange[];
    readonly at: string;
};
/** One committed change as the client receives it; `type` is a closed vocabulary. */
export interface DevFlowClientChange {
    /** Bounded kind, e.g. `execution-started`; anything else fails the frame parse. */
    readonly type: string;
    /** Identity of the entity the kind refers to. */
    readonly id: string;
    /** ISO-8601 time the change was committed. */
    readonly at: string;
}
/** Bound on the diagnostic path list one `changed` frame may carry. */
export declare const DEVFLOW_CLIENT_EVENT_PATH_LIMIT = 12;
/** Bound on the semantic change list one `changed` frame may carry. */
export declare const DEVFLOW_CLIENT_EVENT_CHANGE_LIMIT = 8;
/** The closed vocabulary a `changed` frame's `changes[].type` may use. */
export declare const DEVFLOW_CLIENT_CHANGE_KINDS: readonly string[];
