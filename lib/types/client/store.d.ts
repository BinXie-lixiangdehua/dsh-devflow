import type { DevFlowClientAuditError, DevFlowClientAuditFilter, DevFlowClientAuditPage, DevFlowClientEvent, DevFlowClientSnapshot, DevFlowClientStateError } from '../contract.ts';
import type { DevFlowRemote } from './remote.ts';
export type DevFlowInspectorTab = 'flow' | 'audit' | 'tools';
/**
 * Live-channel posture.
 *
 * `live` means the event stream is open; `polling` means it is not, and says why.
 * The distinction is user-visible on purpose: the round's contract forbids a silent
 * fallback, so a dropped channel must be announced rather than hidden behind data
 * that still happens to be refreshing.
 */
export type DevFlowConnectionPhase = 'connecting' | 'live' | 'polling';
export interface DevFlowConnectionState {
    readonly phase: DevFlowConnectionPhase;
    /** Durable journal head the channel last reported, or null. */
    readonly sequence: number | null;
    /** In-process revision the channel last reported, or null. */
    readonly revision: number | null;
    /** Fixed, user-facing reason while `phase` is `polling`; null otherwise. */
    readonly detail: string | null;
    /** Consecutive failed opens; resets once a frame arrives. */
    readonly attempts: number;
}
export declare const INITIAL_CONNECTION_STATE: DevFlowConnectionState;
/** Fixed fallback wording; never carries a raw transport error. */
export declare const CONNECTION_LOST_DETAIL = "\u5B9E\u65F6\u8FDE\u63A5\u5DF2\u65AD\u5F00\uFF0C\u6B63\u5728\u4F7F\u7528\u8F6E\u8BE2";
/** How long a live channel may stay silent before the panel treats it as lost. */
export declare const CHANNEL_SILENCE_MS = 45000;
export type DevFlowClientLoadState = {
    readonly phase: 'loading';
    readonly snapshot: null;
    readonly error: null;
} | {
    readonly phase: 'ready';
    readonly snapshot: DevFlowClientSnapshot;
    readonly error: null;
} | {
    readonly phase: 'refreshing';
    readonly snapshot: DevFlowClientSnapshot;
    readonly error: null;
} | {
    readonly phase: 'error';
    readonly snapshot: DevFlowClientSnapshot | null;
    readonly error: DevFlowClientStateError;
};
export type DevFlowClientAuditLoadState = {
    readonly phase: 'idle';
    readonly filter: DevFlowClientAuditFilter | null;
    readonly page: null;
    readonly error: null;
} | {
    readonly phase: 'loading';
    readonly filter: DevFlowClientAuditFilter;
    readonly page: null;
    readonly error: null;
} | {
    readonly phase: 'ready';
    readonly filter: DevFlowClientAuditFilter;
    readonly page: DevFlowClientAuditPage;
    readonly error: null;
} | {
    readonly phase: 'loading-more' | 'refreshing';
    readonly filter: DevFlowClientAuditFilter;
    readonly page: DevFlowClientAuditPage;
    readonly error: null;
} | {
    readonly phase: 'error';
    readonly filter: DevFlowClientAuditFilter;
    readonly page: DevFlowClientAuditPage | null;
    readonly error: DevFlowClientAuditError;
};
/** Per-session audit reader. It never participates in the regular snapshot poll. */
export declare class DevFlowAuditController {
    private state;
    private readonly listeners;
    private requestGeneration;
    private pending;
    private remote;
    private scopeKey;
    constructor(remote: DevFlowRemote | undefined);
    setRemote(remote: DevFlowRemote | undefined): void;
    getSnapshot: () => DevFlowClientAuditLoadState;
    subscribe: (listener: () => void) => (() => void);
    dispose(): void;
    ensure(filter: DevFlowClientAuditFilter, scopeKey?: string): Promise<void>;
    retry(): Promise<void>;
    refresh(): Promise<void>;
    loadMore(): Promise<void>;
    private reset;
    private load;
    private apply;
    private fail;
    private set;
}
/** Per-session state reader; Host state remains the authority. */
export declare class DevFlowSnapshotController {
    private readonly sessionId;
    private state;
    private inspectorTab;
    private readonly listeners;
    private pending;
    private remote;
    readonly audit: DevFlowAuditController;
    constructor(remote: DevFlowRemote | undefined, sessionId: string);
    getInspectorTab(): DevFlowInspectorTab;
    setInspectorTab(tab: DevFlowInspectorTab): void;
    setRemote(remote: DevFlowRemote | undefined): void;
    getSnapshot: () => DevFlowClientLoadState;
    subscribe: (listener: () => void) => (() => void);
    ensure(): Promise<void>;
    refresh(): Promise<void>;
    markStale(): void;
    dispose(): void;
    /** Adopt a snapshot the live channel delivered; it is the same read model. */
    acceptSnapshot(snapshot: DevFlowClientSnapshot): void;
    private load;
    private apply;
    private fail;
    private set;
}
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
export declare class DevFlowLiveController {
    private readonly sessionId;
    private readonly apply;
    private connection;
    private readonly connectionListeners;
    private controller;
    private stopped;
    /** A subscription loop is in flight (it survives `stop()` until the abort lands). */
    private active;
    private remote;
    private watermark;
    private retry;
    private silence;
    private retryDelayMs;
    /** Injectable so tests can drive the retry ladder without real timers. */
    private readonly schedule;
    private readonly clear;
    constructor(remote: DevFlowRemote | undefined, sessionId: string, apply: {
        /** One change signal arrived; the consumer decides how to fold it in. */
        readonly frame: (event: Extract<DevFlowClientEvent, {
            kind: 'changed';
        }>) => void;
        /** The channel delivered a full read model. */
        readonly snapshot: (snapshot: DevFlowClientSnapshot) => void;
    }, timers?: {
        readonly schedule?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
        readonly clear?: (handle: ReturnType<typeof setTimeout>) => void;
    });
    /**
     * Framework-facing observable pair. The channel is injected as a host
     * observable source, so the slot binder reads it through exactly these two
     * names (`getSnapshot` / `subscribe`) and synthesizes the `useLive` hook.
     */
    getSnapshot: () => DevFlowConnectionState;
    subscribe: (listener: () => void) => (() => void);
    /** Explicit alias of {@link DevFlowLiveController.getSnapshot} for call sites. */
    getConnection: () => DevFlowConnectionState;
    /** Explicit alias of {@link DevFlowLiveController.subscribe} for call sites. */
    subscribeConnection: (listener: () => void) => (() => void);
    setRemote(remote: DevFlowRemote | undefined): void;
    /** Open the channel; a second call while a loop is in flight is a no-op. */
    start(): void;
    /** Close the channel deliberately (unmount, session change). */
    stop(): void;
    dispose(): void;
    private clearTimers;
    private run;
    private noteFrame;
    /** A dead carrier must be announced and retried, never silently replaced by polling. */
    private degrade;
    /**
     * A live carrier that stops sending anything at all is indistinguishable from a
     * quiet project, so the channel proves liveness with its keepalive interval.
     * Silence past {@link CHANNEL_SILENCE_MS} is treated as a lost connection.
     */
    private armSilence;
    private setConnection;
}
