/**
 * Host-side change bus behind the live event channel.
 *
 * `.devflow` has no notification seam of its own: every mutation is a JSON file
 * write through `storage.ts`'s single `writeJson` helper. This bus is that seam —
 * storage reports each committed file, the bus coalesces reports into one signal
 * per window, and the streaming Remote turns signals into frames.
 *
 * The bus carries no business state: a signal says "the committed state moved to
 * revision N", never "task X is now done". A signal MAY additionally carry a
 * bounded set of committed change KINDS (see `change-set.ts`), which is a hint the
 * client uses to tell a busy canvas from an idle one — the client still re-reads
 * the read model through the existing snapshot path, so a dropped or duplicated
 * signal can never produce a state the model does not have.
 */
import { commitChangeOf, DEVFLOW_COMMIT_CHANGE_LIMIT } from "./change-set.js";
/**
 * The committed-write observer handed to `DevFlowStore`, i.e. the wiring that turns
 * a durable write into a live-channel signal.
 *
 * It is EXPORTED on purpose, and it lives beside the bus rather than inline in the
 * controller. The frame's `changes` field was empty on the wire for a whole round
 * because this callback dropped the record argument while the test that "proved"
 * the wiring built its own, correct, callback — so the test never touched the line
 * that was broken. One exported production function means a test can consume the
 * real wiring instead of a look-alike.
 * @param bus - the live-channel change bus.
 * @returns the observer the store reports every committed write to.
 */
export function committedWriteObserver(bus) {
    return (relativePath, sequence, record) => {
        // The committed RECORD travels with the watermark: the bus derives the frame's
        // semantic change set from it, and it is the only place the "what moved" hint
        // can come from. Dropping it leaves `changes` permanently empty on the wire
        // while every layer beneath stays correct.
        bus.report(relativePath, sequence, record);
    };
}
/**
 * Collect writes and publish at most one signal per window.
 *
 * `report` may be called from any write path; it is synchronous and cheap. The
 * first report in a window arms a timer, later reports join the batch, and the
 * flush publishes exactly one signal to every subscriber.
 */
export class DevFlowChangeBus {
    windowMs;
    pathLimit;
    changeLimit;
    now;
    listeners = new Set();
    paths = new Set();
    changes = [];
    /** Session keys seen in this batch; more than one degrades to "project unknown". */
    sessionKeys = new Set();
    /** Set once the batch outgrows the change limit; the list is then dropped whole. */
    changesOverflowed = false;
    timer = null;
    revision = 0;
    sequence = null;
    disposed = false;
    constructor(options = {}) {
        this.windowMs = Math.max(0, options.windowMs ?? 200);
        this.pathLimit = Math.max(1, options.pathLimit ?? 12);
        this.changeLimit = Math.max(1, options.changeLimit ?? DEVFLOW_COMMIT_CHANGE_LIMIT);
        this.now = options.now ?? (() => new Date().toISOString());
    }
    /** Current in-process revision (0 before the first flushed signal). */
    get currentRevision() { return this.revision; }
    /** Last durable journal sequence the bus observed, or null. */
    get currentSequence() { return this.sequence; }
    /** Subscribe to coalesced signals; the disposer is idempotent. */
    subscribe(listener) {
        this.listeners.add(listener);
        let active = true;
        return () => {
            if (!active)
                return;
            active = false;
            this.listeners.delete(listener);
        };
    }
    /**
     * Report one committed write.
     * @param relativePath - root-relative `.devflow` path, e.g. `tasks/<id>.json`.
     * @param sequence - durable journal head after this write, when the write was a journal publish.
     * @param record - the committed journal record, when this write published one. Only
     *   records are turned into semantic changes: a plain state-file write has no
     *   committed meaning of its own, and inferring one from its path would be a guess.
     * @param sessionKey - the store whose state moved, when the observer knows it. A
     *   batch that spans more than one store drops the key rather than naming one
     *   project for another project's change.
     */
    report(relativePath, sequence, record, sessionKey) {
        if (this.disposed)
            return;
        // Every reported path is a real committed write, including journal entries:
        // some records live only in the journal, and a batch must still carry a signal
        // for them. Paths are capped because they are diagnostics, not the payload.
        if (this.paths.size < this.pathLimit)
            this.paths.add(relativePath);
        else
            this.paths.add('…');
        if (sessionKey !== undefined)
            this.sessionKeys.add(sessionKey);
        if (sequence !== undefined && (this.sequence === null || sequence > this.sequence))
            this.sequence = sequence;
        if (record !== undefined && !this.changesOverflowed) {
            const change = commitChangeOf(record);
            if (change !== null) {
                if (this.changes.length < this.changeLimit)
                    this.changes.push(change);
                // An oversized batch drops the list ENTIRELY rather than truncating it: a
                // half-list would silently under-report which dispatches moved, and the
                // client cannot tell a truncated hint from a complete one. Watermark-only
                // is the honest degradation, and it is exactly the pre-existing contract.
                else
                    this.changesOverflowed = true;
            }
        }
        if (this.timer !== null)
            return;
        this.timer = setTimeout(() => { this.flush(); }, this.windowMs);
        if (typeof this.timer === 'object' && this.timer !== null && 'unref' in this.timer) {
            this.timer.unref();
        }
    }
    /** Publish the pending batch immediately (used by tests and on teardown). */
    flush() {
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        const paths = [...this.paths];
        const changes = this.changesOverflowed ? [] : [...this.changes];
        const sequence = this.sequence;
        // One store in the batch names itself; a mixed batch names none, so no
        // subscriber is told that another project's write was its own.
        const sessionKeys = [...this.sessionKeys];
        const sessionKey = sessionKeys.length === 1 ? sessionKeys[0] : undefined;
        this.paths.clear();
        this.changes.length = 0;
        this.sessionKeys = new Set();
        this.changesOverflowed = false;
        if (paths.length === 0 && sequence === null)
            return;
        this.revision += 1;
        const signal = {
            revision: this.revision,
            sequence,
            changed: paths.slice(0, this.pathLimit),
            changes,
            ...(sessionKey === undefined ? {} : { sessionKey }),
            at: this.now(),
        };
        for (const listener of [...this.listeners]) {
            try {
                listener(signal);
            }
            catch { /* one listener's failure must not stop the others */ }
        }
    }
    /** Release every subscriber and drop pending work. */
    dispose() {
        this.disposed = true;
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.paths.clear();
        this.changes.length = 0;
        this.changesOverflowed = false;
        this.listeners.clear();
    }
}
