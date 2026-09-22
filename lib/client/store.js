import { parseDevFlowAuditResponse, parseDevFlowEvent, parseDevFlowResponse } from "./remote.js";
export const INITIAL_CONNECTION_STATE = {
    phase: 'connecting', sequence: null, revision: null, detail: null, attempts: 0,
};
/** Fixed fallback wording; never carries a raw transport error. */
export const CONNECTION_LOST_DETAIL = '实时连接已断开，正在使用轮询';
/** How long a live channel may stay silent before the panel treats it as lost. */
export const CHANNEL_SILENCE_MS = 45_000;
const INITIAL_STATE = { phase: 'loading', snapshot: null, error: null };
const INITIAL_AUDIT_STATE = { phase: 'idle', filter: null, page: null, error: null };
const AUDIT_UNAVAILABLE = { code: 'audit-unavailable', message: 'DevFlow audit is unavailable. Refresh to try again.' };
/** Per-session audit reader. It never participates in the regular snapshot poll. */
export class DevFlowAuditController {
    state = INITIAL_AUDIT_STATE;
    listeners = new Set();
    requestGeneration = 0;
    pending;
    remote;
    scopeKey = null;
    constructor(remote) { this.remote = remote; }
    setRemote(remote) { this.remote = remote; }
    getSnapshot = () => this.state;
    subscribe = (listener) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
    dispose() { this.requestGeneration++; this.listeners.clear(); }
    ensure(filter, scopeKey) {
        const nextScopeKey = scopeKey ?? this.scopeKey;
        const scopeChanged = nextScopeKey !== this.scopeKey;
        this.scopeKey = nextScopeKey;
        if (!scopeChanged && sameFilter(this.state.filter, filter) && this.state.phase !== 'idle')
            return this.pending ?? Promise.resolve();
        return this.reset(filter);
    }
    retry() {
        const filter = this.state.filter;
        if (filter === null)
            return Promise.resolve();
        return this.state.page === null ? this.reset(filter) : this.refresh();
    }
    refresh() {
        if (this.state.filter === null)
            return Promise.resolve();
        return this.load(this.state.filter, undefined, 'refreshing');
    }
    loadMore() {
        if (this.state.phase !== 'ready' || this.state.page.nextCursor === null)
            return Promise.resolve();
        return this.load(this.state.filter, this.state.page.nextCursor, 'loading-more');
    }
    reset(filter) {
        this.requestGeneration++;
        this.pending = undefined;
        return this.load(filter, undefined, 'loading');
    }
    load(filter, cursor, mode) {
        if (mode === 'loading')
            this.set({ phase: 'loading', filter, page: null, error: null });
        const remote = this.remote;
        if (remote === undefined || typeof remote['audit-page'] !== 'function') {
            this.fail(filter);
            return Promise.resolve();
        }
        if (mode !== 'loading' && this.state.page !== null)
            this.set({ phase: mode, filter, page: this.state.page, error: null });
        const generation = ++this.requestGeneration;
        const request = remote['audit-page']({ filter, ...(cursor === undefined ? {} : { cursor }) })
            .then(result => this.apply(generation, filter, cursor, result))
            .catch(() => this.fail(filter, generation))
            .finally(() => { if (generation === this.requestGeneration)
            this.pending = undefined; });
        this.pending = request;
        return request;
    }
    apply(generation, filter, cursor, result) {
        if (generation !== this.requestGeneration)
            return;
        if (!result.ok)
            return this.fail(filter, generation);
        let response;
        try {
            response = parseDevFlowAuditResponse(result.value);
        }
        catch {
            return this.fail(filter, generation);
        }
        if (response.kind === 'error') {
            // A stale cursor can only affect this audit state. Re-querying starts a
            // fresh pinned stream and leaves the P0 snapshot untouched.
            if (response.error.code === 'cursor-invalid' && cursor !== undefined) {
                void this.load(filter, undefined, this.state.page === null ? 'loading' : 'refreshing');
                return;
            }
            const page = sameFilter(this.state.filter, filter) ? this.state.page : null;
            this.set({ phase: 'error', filter, page, error: response.error });
            return;
        }
        if (this.scopeKey !== null && response.page.projectId !== this.scopeKey) {
            this.set({ phase: 'error', filter, page: null, error: AUDIT_UNAVAILABLE });
            return;
        }
        const page = mergeAuditPages(this.state.page, response.page);
        this.set({ phase: 'ready', filter, page, error: null });
    }
    fail(filter, generation = this.requestGeneration) {
        if (generation !== this.requestGeneration)
            return;
        const page = sameFilter(this.state.filter, filter) ? this.state.page : null;
        this.set({ phase: 'error', filter, page, error: AUDIT_UNAVAILABLE });
    }
    set(next) {
        this.state = next;
        for (const listener of this.listeners)
            listener();
    }
}
/** Per-session state reader; Host state remains the authority. */
export class DevFlowSnapshotController {
    sessionId;
    state = INITIAL_STATE;
    inspectorTab = 'flow';
    listeners = new Set();
    pending;
    remote;
    audit;
    constructor(remote, sessionId) {
        this.sessionId = sessionId;
        this.remote = remote;
        this.audit = new DevFlowAuditController(remote);
    }
    getInspectorTab() { return this.inspectorTab; }
    setInspectorTab(tab) { this.inspectorTab = tab; }
    setRemote(remote) {
        this.remote = remote;
        this.audit.setRemote(remote);
        if (remote !== undefined && this.state.phase === 'error')
            void this.refresh();
    }
    getSnapshot = () => this.state;
    subscribe = (listener) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
    ensure() { return this.pending ?? this.load('snapshot'); }
    refresh() { return this.pending ?? this.load('refresh'); }
    markStale() { if (this.state.snapshot === null || this.state.phase === 'refreshing')
        return; this.set({ phase: 'refreshing', snapshot: this.state.snapshot, error: null }); }
    dispose() { this.audit.dispose(); this.listeners.clear(); }
    /** Adopt a snapshot the live channel delivered; it is the same read model. */
    acceptSnapshot(snapshot) {
        if (snapshot.session.id !== this.sessionId)
            return;
        this.set({ phase: 'ready', snapshot, error: null });
    }
    load(method) {
        const remote = this.remote;
        if (remote === undefined) {
            this.fail();
            return Promise.resolve();
        }
        if (this.state.snapshot === null)
            this.set(INITIAL_STATE);
        else
            this.set({ phase: 'refreshing', snapshot: this.state.snapshot, error: null });
        const request = remote[method]().then(result => this.apply(result)).catch(() => this.fail()).finally(() => { this.pending = undefined; });
        this.pending = request;
        return request;
    }
    apply(result) {
        if (!result.ok)
            return this.fail();
        const response = parseDevFlowResponse(result.value);
        if (response.kind === 'error')
            return this.set({ phase: 'error', snapshot: this.state.snapshot, error: response.error });
        if (response.snapshot.session.id !== this.sessionId)
            return this.fail();
        this.set({ phase: 'ready', snapshot: response.snapshot, error: null });
    }
    fail() { this.set({ phase: 'error', snapshot: this.state.snapshot, error: { code: 'state-unavailable', message: 'DevFlow state is unavailable. Refresh to try again.' } }); }
    set(next) { if (this.state === next)
        return; this.state = next; for (const listener of this.listeners)
        listener(); }
}
function mergeAuditPages(previous, incoming) {
    if (previous === null || previous.capturedHeadSequence !== incoming.capturedHeadSequence || previous.range.from !== incoming.range.from || previous.range.to !== incoming.range.to)
        return incoming;
    const byId = new Map();
    for (const item of [...previous.items, ...incoming.items])
        byId.set(item.id, item);
    return { ...incoming, items: [...byId.values()].sort((left, right) => right.sequence - left.sequence || left.id.localeCompare(right.id)) };
}
function sameFilter(left, right) { return left?.kind === right.kind && ('id' in right ? ('id' in left && left.id === right.id) : !('id' in (left ?? {}))); }
/**
 * Per-session live channel over the `devflow/follow` stream Remote.
 *
 * Responsibilities are deliberately narrow: keep the subscription alive, decide
 * whether an arriving frame is worth acting on, and report the connection posture.
 * It does NOT derive state — a `changed` frame only schedules a re-read through the
 * existing snapshot path, which keeps one source of truth and makes duplicates and
 * out-of-order frames harmless.
 *
 * Ordering rule: frames carry the host's in-process `revision`, which strictly
 * increases within one host run but means nothing across a restart (the opening
 * frame of a new stream is always a fresh snapshot). A frame whose revision is not
 * newer than the newest one already seen is ignored, and re-opening the stream
 * resets the watermark.
 *
 * Frame rule: the subscription iterates the stream Remote's own frames — never a
 * `RemoteResult` envelope, which only unary calls produce. A frame the strict parser
 * refuses is not a state the panel may pass off as live, so it ends the subscription
 * and lets the announced fallback take over; the retry re-opens with a fresh snapshot.
 */
export class DevFlowLiveController {
    sessionId;
    apply;
    connection = INITIAL_CONNECTION_STATE;
    connectionListeners = new Set();
    controller = null;
    stopped = true;
    /** A subscription loop is in flight (it survives `stop()` until the abort lands). */
    active = false;
    remote;
    watermark = -1;
    retry = null;
    silence = null;
    retryDelayMs = 1_000;
    /** Injectable so tests can drive the retry ladder without real timers. */
    schedule;
    clear;
    constructor(remote, sessionId, apply, timers = {}) {
        this.sessionId = sessionId;
        this.apply = apply;
        this.remote = remote;
        this.schedule = timers.schedule ?? ((callback, ms) => setTimeout(callback, ms));
        this.clear = timers.clear ?? (handle => { clearTimeout(handle); });
    }
    /**
     * Framework-facing observable pair. The channel is injected as a host
     * observable source, so the slot binder reads it through exactly these two
     * names (`getSnapshot` / `subscribe`) and synthesizes the `useLive` hook.
     */
    getSnapshot = () => this.connection;
    subscribe = (listener) => {
        this.connectionListeners.add(listener);
        return () => { this.connectionListeners.delete(listener); };
    };
    /** Explicit alias of {@link DevFlowLiveController.getSnapshot} for call sites. */
    getConnection = () => this.connection;
    /** Explicit alias of {@link DevFlowLiveController.subscribe} for call sites. */
    subscribeConnection = (listener) => this.subscribe(listener);
    setRemote(remote) {
        this.remote = remote;
        if (remote === undefined) {
            this.stop();
            this.setConnection({ ...this.connection, phase: 'polling', detail: CONNECTION_LOST_DETAIL });
        }
        // The Remote mounts after this controller may already exist, so "not running"
        // (rather than "not stopped") decides whether to open the channel here.
        else if (!this.active)
            this.start();
    }
    /** Open the channel; a second call while a loop is in flight is a no-op. */
    start() {
        this.stopped = false;
        if (this.active)
            return;
        void this.run();
    }
    /** Close the channel deliberately (unmount, session change). */
    stop() {
        this.stopped = true;
        this.controller?.abort();
        this.controller = null;
        this.clearTimers();
    }
    dispose() {
        this.stop();
        this.connectionListeners.clear();
    }
    clearTimers() {
        if (this.retry !== null) {
            this.clear(this.retry);
            this.retry = null;
        }
        if (this.silence !== null) {
            this.clear(this.silence);
            this.silence = null;
        }
    }
    async run() {
        const remote = this.remote;
        if (remote === undefined || this.stopped)
            return;
        const abort = new AbortController();
        this.controller = abort;
        this.active = true;
        this.watermark = -1;
        this.setConnection({ ...this.connection, phase: this.connection.attempts === 0 ? 'connecting' : this.connection.phase });
        try {
            const request = { sequence: this.connection.sequence };
            for await (const frame of remote.follow(request, abort.signal)) {
                if (this.stopped)
                    break;
                // A stream Remote yields the frame itself. The `{ ok, value }` envelope only
                // exists on unary calls: the mux carrier yields `frame.value` for every `item`
                // (packages/api/gateway/src/client/stream-client.ts:104) and the connection's
                // generic RPC face passes it through, which is exactly how the long-lived
                // `session/follow` consumer reads its own stream
                // (packages/api/session-controller/src/client/transport.ts:179). Reading an
                // envelope here made `!result.ok` true on the very first frame, so the channel
                // threw, degraded and re-subscribed forever without ever going live.
                let event;
                try {
                    event = parseDevFlowEvent(frame);
                }
                catch {
                    throw new Error('devflow: live channel frame was not usable');
                }
                this.armSilence();
                if (event.kind === 'snapshot') {
                    if (event.snapshot.session.id !== this.sessionId)
                        continue;
                    this.apply.snapshot(event.snapshot);
                    this.watermark = Math.max(this.watermark, 0);
                    this.noteFrame(null, null);
                    continue;
                }
                if (event.revision <= this.watermark)
                    continue;
                this.watermark = event.revision;
                this.apply.frame(event);
                this.noteFrame(event.revision, event.sequence);
            }
            if (!this.stopped)
                this.degrade('实时连接已断开，正在使用轮询');
        }
        catch {
            if (!this.stopped)
                this.degrade(CONNECTION_LOST_DETAIL);
        }
        finally {
            this.active = false;
            if (this.controller === abort)
                this.controller = null;
        }
    }
    noteFrame(revision, sequence) {
        this.retryDelayMs = 1_000;
        this.setConnection({
            phase: 'live',
            sequence: sequence ?? this.connection.sequence,
            revision: revision ?? this.connection.revision,
            detail: null,
            attempts: 0,
        });
    }
    /** A dead carrier must be announced and retried, never silently replaced by polling. */
    degrade(detail) {
        this.clearTimers();
        const attempts = this.connection.attempts + 1;
        this.setConnection({ ...this.connection, phase: 'polling', detail, attempts });
        const delay = this.retryDelayMs;
        this.retryDelayMs = Math.min(this.retryDelayMs * 2, 15_000);
        this.retry = this.schedule(() => {
            this.retry = null;
            if (this.stopped)
                return;
            void this.run();
        }, delay);
    }
    /**
     * A live carrier that stops sending anything at all is indistinguishable from a
     * quiet project, so the channel proves liveness with its keepalive interval.
     * Silence past {@link CHANNEL_SILENCE_MS} is treated as a lost connection.
     */
    armSilence() {
        if (this.silence !== null)
            this.clear(this.silence);
        this.silence = this.schedule(() => {
            this.silence = null;
            if (this.stopped || this.connection.phase !== 'live')
                return;
            this.controller?.abort();
        }, CHANNEL_SILENCE_MS);
    }
    setConnection(next) {
        if (sameConnection(this.connection, next))
            return;
        this.connection = next;
        for (const listener of this.connectionListeners)
            listener();
    }
}
function sameConnection(left, right) {
    return left.phase === right.phase && left.sequence === right.sequence
        && left.revision === right.revision && left.detail === right.detail && left.attempts === right.attempts;
}
