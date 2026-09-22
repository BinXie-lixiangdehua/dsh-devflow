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
/**
 * The closed vocabulary of committed changes.
 *
 * Each kind names a *dispatch-visible* fact the canvas already draws. Kinds the
 * canvas has no element for are deliberately absent: a change the UI cannot show
 * is noise in a frame whose whole purpose is to be a cheap hint.
 */
export const DEVFLOW_COMMIT_KINDS = [
    /** A task entered the reviewing state — the dispatch now has a deliverable to audit. */
    'task-reviewing',
    /** A task entered the executing state — its dispatch is under way. */
    'task-executing',
    /** A task left the executing state for good (completed / failed / cancelled). */
    'task-settled',
    /** An execution started running. */
    'execution-started',
    /** An execution reached a terminal state (completed / failed / closed). */
    'execution-settled',
    /** A phase → agent assignment was created: a handoff exists that had none. */
    'assignment-created',
    /** A phase → agent assignment reached its terminal state. */
    'assignment-settled',
];
/**
 * The kinds that mean "the TASK moved".
 *
 * Kept as its own set because the raw status string is not the kind: the mapping
 * from a transition to one of these three is a decision, and it belongs in one
 * place rather than at each call site.
 */
export const DEVFLOW_COMMIT_TASK_KINDS = [
    'task-reviewing', 'task-executing', 'task-settled',
];
/** Max changes one frame may carry before it degrades to the watermark alone. */
export const DEVFLOW_COMMIT_CHANGE_LIMIT = 8;
/** Identity fields to probe, in order, to name the entity a record refers to. */
const ID_FIELDS = ['taskId', 'executionId', 'assignmentId', 'attemptId', 'reportId', 'phaseId', 'decisionId'];
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
export function commitChangeOf(entry) {
    const kind = kindOf(entry.type, entry.data);
    if (kind === null)
        return null;
    const id = entityIdOf(entry.data);
    if (id === null)
        return null;
    return { type: kind, id, at: entry.at };
}
/** Map one durable record type (plus its payload) onto a kind, or null. */
function kindOf(type, data) {
    if (type === 'devflow/task/transition') {
        const to = stringField(data, 'to');
        if (to === 'reviewing')
            return 'task-reviewing';
        if (to === 'executing')
            return 'task-executing';
        if (to === 'completed' || to === 'failed' || to === 'cancelled')
            return 'task-settled';
        return null;
    }
    if (type === 'devflow/execution/start')
        return 'execution-started';
    if (type === 'devflow/execution/complete' || type === 'devflow/execution/fail' || type === 'devflow/execution/close')
        return 'execution-settled';
    if (type === 'devflow/orchestration/assign')
        return 'assignment-created';
    if (type === 'devflow/orchestration/close')
        return 'assignment-settled';
    // `devflow/orchestration/update` is deliberately NOT mapped: it carries every
    // intermediate status change, so treating it as a dispatch event would fire the
    // canvas for bookkeeping that has no visual meaning.
    return null;
}
/** The identity one record refers to, checked against the bounded id shape. */
function entityIdOf(data) {
    for (const field of ID_FIELDS) {
        const value = stringField(data, field);
        if (value !== null)
            return value;
    }
    // A record may nest its subject, e.g. `{ execution: { executionId } }`.
    if (typeof data === 'object' && data !== null) {
        for (const nested of Object.values(data)) {
            if (typeof nested !== 'object' || nested === null)
                continue;
            for (const field of ID_FIELDS) {
                const value = stringField(nested, field);
                if (value !== null)
                    return value;
            }
        }
    }
    return null;
}
function stringField(value, field) {
    if (typeof value !== 'object' || value === null)
        return null;
    const raw = value[field];
    return typeof raw === 'string' && raw !== '' && raw.length <= 128 ? raw : null;
}
