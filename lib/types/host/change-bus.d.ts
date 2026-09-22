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
import { type DevFlowCommitChange } from './change-set.ts';
/** One coalesced change signal. */
export interface DevFlowChangeSignal {
    /** In-process revision; strictly increasing for the lifetime of this host run. */
    readonly revision: number;
    /** Durable journal head sequence at the time of the signal, or null when none was written yet. */
    readonly sequence: number | null;
    /** Root-relative paths that changed in this batch, capped and de-duplicated. */
    readonly changed: readonly string[];
    /**
     * Bounded semantic changes committed in this batch.
     *
     * Empty when the batch carried nothing the canvas draws, AND empty when it
     * carried more than {@link DEVFLOW_COMMIT_CHANGE_LIMIT} entries: an oversized
     * batch degrades to "watermark only" rather than shipping an unbounded frame.
     */
    readonly changes: readonly DevFlowCommitChange[];
    /**
     * The store whose committed state moved, when the observer knew it.
     *
     * Since 第九步 the bus serves every project session at once, so a subscriber
     * must be able to tell "this project moved" from "some other project moved".
     * It is opaque: the channel compares it, never parses it.
     */
    readonly sessionKey?: string;
    readonly at: string;
}
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
export declare function committedWriteObserver(bus: DevFlowChangeBus): (relativePath: string, sequence?: number, record?: {
    readonly type: string;
    readonly data: unknown;
    readonly at: string;
}) => void;
export interface DevFlowChangeBusOptions {
    readonly windowMs?: number;
    /** Max paths kept per signal for diagnostics. */
    readonly pathLimit?: number;
    /** Max semantic changes kept per signal; exceeding it drops the whole list. */
    readonly changeLimit?: number;
    /** Clock, injectable for tests. */
    readonly now?: () => string;
}
/**
 * Collect writes and publish at most one signal per window.
 *
 * `report` may be called from any write path; it is synchronous and cheap. The
 * first report in a window arms a timer, later reports join the batch, and the
 * flush publishes exactly one signal to every subscriber.
 */
export declare class DevFlowChangeBus {
    private readonly windowMs;
    private readonly pathLimit;
    private readonly changeLimit;
    private readonly now;
    private readonly listeners;
    private readonly paths;
    private readonly changes;
    /** Session keys seen in this batch; more than one degrades to "project unknown". */
    private sessionKeys;
    /** Set once the batch outgrows the change limit; the list is then dropped whole. */
    private changesOverflowed;
    private timer;
    private revision;
    private sequence;
    private disposed;
    constructor(options?: DevFlowChangeBusOptions);
    /** Current in-process revision (0 before the first flushed signal). */
    get currentRevision(): number;
    /** Last durable journal sequence the bus observed, or null. */
    get currentSequence(): number | null;
    /** Subscribe to coalesced signals; the disposer is idempotent. */
    subscribe(listener: (signal: DevFlowChangeSignal) => void): () => void;
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
    report(relativePath: string, sequence?: number, record?: {
        readonly type: string;
        readonly data: unknown;
        readonly at: string;
    }, sessionKey?: string): void;
    /** Publish the pending batch immediately (used by tests and on teardown). */
    flush(): void;
    /** Release every subscriber and drop pending work. */
    dispose(): void;
}
