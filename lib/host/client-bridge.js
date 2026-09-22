/** Public Typert Remote bridge for the DevFlow client snapshot. */
var __runInitializers = (this && this.__runInitializers) || function (thisArg, initializers, value) {
    var useValue = arguments.length > 2;
    for (var i = 0; i < initializers.length; i++) {
        value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
    }
    return useValue ? value : void 0;
};
var __esDecorate = (this && this.__esDecorate) || function (ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
    function accept(f) { if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected"); return f; }
    var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
    var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
    var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
    var _, done = false;
    for (var i = decorators.length - 1; i >= 0; i--) {
        var context = {};
        for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
        for (var p in contextIn.access) context.access[p] = contextIn.access[p];
        context.addInitializer = function (f) { if (done) throw new TypeError("Cannot add initializers after decoration has completed"); extraInitializers.push(accept(f || null)); };
        var result = (0, decorators[i])(kind === "accessor" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
        if (kind === "accessor") {
            if (result === void 0) continue;
            if (result === null || typeof result !== "object") throw new TypeError("Object expected");
            if (_ = accept(result.get)) descriptor.get = _;
            if (_ = accept(result.set)) descriptor.set = _;
            if (_ = accept(result.init)) initializers.unshift(_);
        }
        else if (_ = accept(result)) {
            if (kind === "field") initializers.unshift(_);
            else descriptor[key] = _;
        }
    }
    if (target) Object.defineProperty(target, contextIn.name, descriptor);
    done = true;
};
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { DevFlowSessionScopeError } from "./session-store.js";
import { DevFlowAuditPager } from "./client-audit.js";
import { createDevFlowClientSnapshot } from "./client-snapshot.js";
const STATE_UNAVAILABLE = {
    code: 'state-unavailable',
    message: 'DevFlow state is unavailable. Refresh to try again.',
};
/**
 * The 第九步 refusal: this session has no workspace, so it has no project.
 *
 * It is a DIFFERENT code from the generic one on purpose. "Could not be
 * isolated" and "failed to load" call for different responses, and a shared
 * library served under the generic code would be indistinguishable from an
 * isolated read.
 */
const SCOPE_UNAVAILABLE = {
    code: 'scope-unavailable',
    message: 'DevFlow cannot isolate this session: it has no project workspace. Shared state is not shown.',
};
/** How long a quiet channel waits before proving itself with one signal. */
const KEEPALIVE_MS = 15_000;
/** Gateway-discoverable, path-free read/refresh service for the Canvas. */
let DevFlowClientBridge = (() => {
    let _classSuper = TypertRemoteService;
    let _instanceExtraInitializers = [];
    let _snapshot_decorators;
    let _refresh_decorators;
    let _auditPage_decorators;
    let _follow_decorators;
    return class DevFlowClientBridge extends _classSuper {
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            _snapshot_decorators = [Remote('snapshot')];
            _refresh_decorators = [Remote('refresh')];
            _auditPage_decorators = [Remote('audit-page')];
            _follow_decorators = [Remote({ mode: 'stream' })];
            __esDecorate(this, null, _snapshot_decorators, { kind: "method", name: "snapshot", static: false, private: false, access: { has: obj => "snapshot" in obj, get: obj => obj.snapshot }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _refresh_decorators, { kind: "method", name: "refresh", static: false, private: false, access: { has: obj => "refresh" in obj, get: obj => obj.refresh }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _auditPage_decorators, { kind: "method", name: "auditPage", static: false, private: false, access: { has: obj => "auditPage" in obj, get: obj => obj.auditPage }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _follow_decorators, { kind: "method", name: "follow", static: false, private: false, access: { has: obj => "follow" in obj, get: obj => obj.follow }, metadata: _metadata }, null, _instanceExtraInitializers);
            if (_metadata) Object.defineProperty(this, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        }
        static inject = ['devflow'];
        constructor(ctx) {
            super(ctx, 'devflowClient', { namespace: 'devflow' });
            __runInitializers(this, _instanceExtraInitializers);
        }
        async snapshot(agent) {
            return this.read(agent);
        }
        async refresh(agent) {
            return this.read(agent);
        }
        async auditPage(agent, query) {
            // The pager is built per call over the CALLING session's store: an audit
            // panel opened in project B pages through project B's journal only.
            try {
                const scope = this.ctx.devflow.resolveSessionScope(agent);
                return await new DevFlowAuditPager(scope.store).page(query);
            }
            catch {
                return { kind: 'error', error: { code: 'audit-unavailable', message: 'DevFlow audit is unavailable. Refresh to try again.' } };
            }
        }
        /**
         * Follow the committed DevFlow state: one opening snapshot, then one signal per
         * coalesced change batch.
         *
         * The channel is intentionally thin. It never sends derived state — only the
         * read model the client could have fetched itself, plus "the state moved on".
         * That is what makes a frame droppable and a replay harmless: the client decides
         * what to re-read, and the existing snapshot path stays the single source of
         * truth. A quiet channel still emits a keepalive signal, so a dead carrier is
         * noticed rather than looking like "nothing is happening".
         *
         * @param agent - the scoped Agent whose session is being followed.
         * @param request - what the client already holds (`sequence`).
         * @param signal - cancellation owned by the Remote stream carrier.
         * @returns the opening snapshot followed by ordered change signals.
         */
        async *follow(agent, request, signal) {
            const bus = this.ctx.devflow.changeBus;
            // Which project this channel follows. The key is resolved once per stream:
            // a session's scope is pinned for its lifetime, so the subscription below
            // can drop every frame that belongs to another project's store.
            let sessionKey;
            try {
                sessionKey = this.ctx.devflow.resolveSessionScope(agent).sessionKey;
            }
            catch {
                // A session that cannot be scoped has nothing to follow, and the stream
                // carries no error frame shape: it ends unopened rather than forwarding
                // another project's changes. The unary snapshot path names the refusal
                // (`scope-unavailable`), which is what the panel shows.
                return;
            }
            // The opening frame is always the read model: whether the client is behind, or
            // the host restarted (its in-process revision means nothing to a fresh client),
            // a snapshot is the only correct starting point.
            let baseline;
            try {
                baseline = { kind: 'snapshot', snapshot: await createDevFlowClientSnapshot(this.ctx.devflow, agent) };
            }
            catch {
                baseline = { kind: 'error', error: STATE_UNAVAILABLE };
            }
            if (baseline.kind === 'error')
                return;
            yield { kind: 'snapshot', snapshot: baseline.snapshot };
            void request;
            // One queue, so a burst of signals is drained in order without piling up: the
            // consumer's pace decides, and the bus has already coalesced by window.
            const pending = [];
            let wake = null;
            const unsubscribe = bus.subscribe(signal => {
                // Another project's committed write is not this channel's news. The frame
                // is dropped rather than forwarded, so project A's canvas can never redraw
                // because project B wrote something.
                if (signal.sessionKey !== undefined && signal.sessionKey !== sessionKey)
                    return;
                pending.push(signal);
                wake?.();
            });
            const onAbort = () => { wake?.(); };
            signal.addEventListener('abort', onAbort);
            try {
                while (!signal.aborted) {
                    if (pending.length === 0) {
                        await new Promise(resolve => {
                            let settled = false;
                            const finish = () => {
                                if (settled)
                                    return;
                                settled = true;
                                clearTimeout(timer);
                                wake = null;
                                resolve();
                            };
                            const timer = setTimeout(finish, KEEPALIVE_MS);
                            wake = finish;
                        });
                    }
                    if (signal.aborted)
                        break;
                    // Collapse the whole drained batch into its newest signal: the client only
                    // needs "the state moved to revision N", never each intermediate step. The
                    // newest signal also carries the newest change list, which is a hint about
                    // WHAT moved — never a replacement for the snapshot the client re-reads.
                    let latest = pending.pop();
                    pending.length = 0;
                    if (latest === undefined)
                        latest = { revision: bus.currentRevision, sequence: bus.currentSequence, changed: [], changes: [], at: new Date().toISOString() };
                    yield {
                        kind: 'changed',
                        revision: latest.revision,
                        sequence: latest.sequence,
                        changed: latest.changed,
                        changes: latest.changes.map(change => ({ type: change.type, id: change.id, at: change.at })),
                        at: latest.at,
                    };
                }
            }
            finally {
                signal.removeEventListener('abort', onAbort);
                unsubscribe();
            }
        }
        async read(agent) {
            try {
                return { kind: 'snapshot', snapshot: await createDevFlowClientSnapshot(this.ctx.devflow, agent) };
            }
            catch (cause) {
                // A session that cannot be scoped is refused BY NAME: the panel must be
                // able to tell "this session has no project to isolate" from a plain read
                // failure, because only the first one means nothing is being shown that
                // belongs to another project.
                if (cause instanceof DevFlowSessionScopeError)
                    return { kind: 'error', error: SCOPE_UNAVAILABLE };
                return { kind: 'error', error: STATE_UNAVAILABLE };
            }
        }
    };
})();
export { DevFlowClientBridge };
