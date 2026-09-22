/**
 * The bounded, semantic change set one `changed` frame may carry.
 *
 * The live channel is a SIGNAL, never a second source of truth. Until this module
 * existed a `changed` frame said only "the committed state moved to revision N",
 * which forced the canvas to infer *what* moved by diffing two full snapshots.
 * This adds a hint — the same facts the journal already committed, projected to a
 * closed vocabulary — so the client can tell a busy canvas from an idle one
 * without inventing motion of its own.
 *
 * Two properties are load-bearing and must not be traded away:
 *
 *  - **The vocabulary is closed.** {@link DEVFLOW_COMMIT_KINDS} is derived from the
 *    journal's own durable event families, not from whatever a caller happens to
 *    write. A record this build does not recognise yields NO change rather than a
 *    vaguely-named one, so the enum cannot drift open over time.
 *  - **The set is bounded.** A batch that would carry more than
 *    {@link DEVFLOW_COMMIT_CHANGE_LIMIT} entries degrades to "watermark only" —
 *    the frame then says exactly what it used to say, and the client re-reads the
 *    snapshot. An unbounded list would make the frame expensive on a large project
 *    precisely when the project is busiest.
 *
 * The task that consumes these ({@link DEVFLOW_COMMIT_TASK_KINDS}) is deliberately
 * the SUB-TASK for the rest, because "the task moved" is not a dispatch event: the
 * canvas animates dispatches, not statuses.
 * @module @xiaoxie-ide/dsh-devflow/change-set
 */
/** One semantic change, as the client receives it. */
export interface DevFlowCommitChange {
    /** Bounded kind; see {@link DEVFLOW_COMMIT_KINDS}. */
    readonly type: DevFlowCommitKind;
    /** Identity of the entity the kind refers to (task / execution / assignment / …). */
    readonly id: string;
    /** ISO-8601 time the change was committed, from the journal record. */
    readonly at: string;
}
/**
 * The closed vocabulary of committed changes.
 *
 * Each kind names a *dispatch-visible* fact the canvas already draws. Kinds the
 * canvas has no element for are deliberately absent: a change the UI cannot show
 * is noise in a frame whose whole purpose is to be a cheap hint.
 */
export declare const DEVFLOW_COMMIT_KINDS: readonly ["task-reviewing", "task-executing", "task-settled", "execution-started", "execution-settled", "assignment-created", "assignment-settled"];
/** One entry of {@link DEVFLOW_COMMIT_KINDS}. */
export type DevFlowCommitKind = typeof DEVFLOW_COMMIT_KINDS[number];
/**
 * The kinds that mean "the TASK moved".
 *
 * Kept as its own set because the raw status string is not the kind: the mapping
 * from a transition to one of these three is a decision, and it belongs in one
 * place rather than at each call site.
 */
export declare const DEVFLOW_COMMIT_TASK_KINDS: readonly DevFlowCommitKind[];
/** Max changes one frame may carry before it degrades to the watermark alone. */
export declare const DEVFLOW_COMMIT_CHANGE_LIMIT = 8;
/** A journal entry as this module needs to read it. */
export interface DevFlowChangeSource {
    readonly type: string;
    readonly data: unknown;
    readonly at: string;
}
/**
 * Project one committed journal record onto the bounded change vocabulary.
 *
 * Reads only the record's own `type` and a small set of identity fields: it never
 * re-reads a state file, so a busy project does not turn each frame into a burst of
 * I/O. A record outside the catalogue returns an empty list, which is the intended
 * "nothing the canvas draws changed" answer rather than an error.
 * @param entry - the committed journal record.
 * @returns zero or one change; the journal is one record per committed fact.
 */
export declare function commitChangeOf(entry: DevFlowChangeSource): DevFlowCommitChange | null;
