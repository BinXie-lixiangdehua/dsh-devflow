/**
 * DevFlow agent-plane preset activation adapter.
 *
 * This module implements the consumer side of the Harness generic preset
 * activation Hook for the `devflow` preset. The composition row provides an
 * isolated `agentPresetActivation` service (the provider), and `AgentPresets`
 * calls `activate()` inside the pre-publication mount/recompose window. The
 * adapter never creates a second loader, service, Remote, or state source: it
 * drives the single host {@link DevflowController} (Commander mode + the one
 * `.devflow` store) that the deployment already composed.
 *
 * Activation only succeeds after, in order: the preset identity is `devflow`
 * both by request and by the live composed scope; the shared project exists
 * (single-flight initialization reuses the store's own concurrency-safe
 * journaling); Commander is entered for this exact Agent; the installation is
 * verified live (not merely recorded); and an audit-only journal record is
 * appended. Any failure throws a stable activationCode so the Hook blocks
 * publication or selection commit — never a silent native fallback.
 *
 * The returned lease reverses exactly that state: `deactivate()` exits
 * Commander and restores the native persona/presentation, `restore()` re-enters
 * this lease's project after a blank-session switch is rolled back. Both are
 * idempotent and never leak raw exceptions.
 * @module @xiaoxie-ide/dsh-devflow/preset-activation
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { CommanderMode } from './commander-mode.ts';
import type { DevFlowStore } from './storage.ts';
import type { DevFlowSessionStores } from './session-store.ts';
import type { DevFlowActivationCode, DevFlowActivationFailurePhase } from './types.ts';
export type { DevFlowActivationCode } from './types.ts';
/** The one preset id this adapter will activate. */
export declare const DEVFLOW_PRESET_ID = "devflow";
/**
 * Structural view of the Harness activation input. Kept local (with no runtime
 * import from agent-presets) so the adapter compiles against any published
 * agent-presets snapshot; at runtime the Harness Hook passes its own object,
 * which is structurally identical for the fields this adapter reads.
 */
export interface DevFlowActivationInput {
    readonly agent: Agent;
    readonly agentCtx: Context;
    readonly preset: Readonly<{
        readonly id: string;
    }>;
    readonly kind: 'initial' | 'recompose';
    readonly previousPresetId?: string;
    /**
     * Activation runs consumed so far, when a settle wrapper is driving retries.
     *
     * Optional and absent for a single direct run: the provider must stay
     * callable exactly as the Harness Hook calls it, and an attempt count is a
     * property of the caller's retry policy rather than of the activation itself.
     */
    readonly attempts?: number;
}
/** Structural view of the per-Agent lease the Hook expects back. */
export interface DevFlowActivationLease {
    deactivate(): Promise<void>;
    restore(): Promise<void>;
}
/** Structural view of the isolated activation provider value. */
export interface DevFlowActivationProvider {
    activate(input: DevFlowActivationInput): Promise<DevFlowActivationLease>;
}
/** Stable activationCodes this adapter may surface; never raw provider text. */
export declare const DEVFLOW_ACTIVATION_CODES: {
    readonly presetIdentityMismatch: "devflow-preset-identity-mismatch";
    readonly sessionMismatch: "devflow-session-mismatch";
    readonly projectUnavailable: "devflow-project-unavailable";
    readonly projectInitFailed: "devflow-project-init-failed";
    readonly commanderInstallFailed: "devflow-commander-install-failed";
    readonly verificationFailed: "devflow-activation-verification-failed";
    readonly commanderNotInstalled: "devflow-commander-not-installed";
    readonly deactivationFailed: "devflow-deactivation-failed";
    readonly restoreFailed: "devflow-restore-failed";
    readonly journalFailed: "devflow-journal-failed";
    readonly hostUnavailable: "devflow-host-unavailable";
};
/**
 * Fixed bounded English messages; session/preset/project ids are not free text.
 *
 * This is the ENGLISH half of the reason vocabulary: it is what the wire and
 * the DTO carry as `activationError.message`, while
 * {@link ACTIVATION_CODE_REASONS_ZH} holds the Chinese sentence the human
 * surfaces print. Both tables are complete over the same code union, and the
 * reason-table test in `tests/preset-activation.spec.ts` asserts that.
 */
export declare const CODE_MESSAGES: Record<DevFlowActivationCode, string>;
/**
 * Produce a stable activationCode-carrying fault for the Harness Hook.
 *
 * When the running agent-presets copy exposes its `AgentPresetActivationFault`
 * (the Hook-enabled build sharing this process), the thrown value is an
 * instance of it so the Hook preserves the DevFlow code in its bounded
 * details. When that class is absent (a stale published snapshot, or a
 * separate module copy), a structurally equivalent fault with the same
 * `activationCode` is thrown; the Hook still fails the activation closed with
 * its generic code, and DevFlow's own reporting surface keeps the stable code.
 *
 * The fault class itself is the Harness's shape, so it carries the code and
 * nothing else; this module's own durable record is where phase, attempt count,
 * and the operator-facing reason live.
 * @param code - the stable refusal code.
 * @param options - optional `cause` chain kept for in-process debugging.
 * @returns the fault to throw.
 */
export declare function activationFault(code: DevFlowActivationCode, options?: ErrorOptions): Promise<unknown>;
/**
 * The refusal code carried by a thrown activation failure.
 *
 * Deliberately structural rather than `instanceof`: the fault class is loaded
 * through an async dynamic import (see {@link activationFault}), so an adapter
 * that reads it must not add a second, independent identity dependency. A
 * non-refusal error (a real bug on our side) answers `undefined` and is
 * reported under its own fallback code by the caller.
 * @param error - any thrown value.
 * @returns the stable code, or undefined when this is not an activation fault.
 */
export declare function activationFaultCode(error: unknown): DevFlowActivationCode | undefined;
/** One durable activation refusal, as the journal replays it. */
export interface DevFlowActivationFailure {
    /** The refusal code the provider classified. */
    readonly code: DevFlowActivationCode;
    /** The act that was refused. */
    readonly phase: DevFlowActivationFailurePhase;
    /** Activation runs consumed before the refusal settled (1 = refused first try). */
    readonly attempts: number;
    /** Fixed Chinese sentence for the operator. */
    readonly reason: string;
    /** ISO-8601 time the refusal settled. */
    readonly at: string;
}
/** The verified activation posture of one session. */
export interface DevFlowBoundReport {
    readonly presetId: string | null;
    readonly commanderMode: 'chat' | 'commander';
    readonly projectId: string | null;
    readonly activation: 'bound' | 'unbound' | 'error';
    readonly activationError: {
        readonly code: DevFlowActivationCode;
        readonly message: string;
    } | null;
    readonly verifiedAt: string | null;
    /**
     * The last refusal this session recorded, replayed from the durable journal.
     *
     * Absent means either no refusal was ever recorded or the record could not be
     * read; it never means "no refusal happened" when `activation` is `error`
     * with a conjunct-derived code. Kept separate from {@link activationError}
     * because that one describes the *current* posture while this one describes
     * the *last attempt*, and conflating them would let a stale refusal speak for
     * a healthy session.
     */
    readonly lastFailure: DevFlowActivationFailure | null;
}
/** One adapter's optional live-scope readers. */
export interface DevFlowPresetActivationOptions {
    /** Read the preset the live Agent scope is actually composed from. */
    readonly composedPreset?: (agent: Agent) => string | undefined;
    /** Read the preset the session's durable log resolves to. */
    readonly durablePreset?: (agent: Agent) => string | undefined;
    /** Clock override for deterministic tests. */
    readonly now?: () => string;
}
/** The read end of the session-scope resolver, as this module uses it. */
export type DevFlowActivationScopeResolver = (agent: Agent) => DevFlowStore;
/**
 * The workspace behind one session, as this module uses it.
 *
 * A project's NAME is derived from the workspace directory (see
 * {@link deriveNewProjectIdentity}), so project creation needs the workspace
 * that the store came from — one resolver, so root and name can never disagree.
 */
export type DevFlowActivationWorkspaceResolver = (agent: Agent) => string;
/**
 * The DevFlow preset activation adapter bound to one host controller instance.
 *
 * One instance is constructed per host {@link DevflowController}; every preset
 * composition row asks the controller for a provider via
 * {@link createProvider}. The provider is a plain value with no service
 * registration of its own, so no second host service or state source exists.
 *
 * Since 第九步 the adapter reaches state through the CALLING SESSION's own
 * store: activating project B registers employees and journals into
 * `<B>/.devflow` and never into project A's, so one project's Commander can
 * never inherit another project's roster or memory.
 */
export declare class DevFlowPresetActivation {
    private readonly commanderMode;
    private readonly options;
    /** One alias kept for composition rows and commands. */
    readonly presetId = "devflow";
    /** Resolve the store of the session being activated. */
    private readonly storeFor;
    /** Resolve the workspace directory of the session being activated. */
    private readonly workspaceFor;
    constructor(source: DevFlowStore | DevFlowSessionStores, commanderMode: CommanderMode, options?: DevFlowPresetActivationOptions);
    /** A provider value for the isolated `agentPresetActivation` composition row. */
    createProvider(): DevFlowActivationProvider;
    /**
     * Turn one refusal into the fault the Harness Hook classifies.
     *
     * Centralised so every refusal site reports the SAME shape: a fault carrying
     * `activationCode` (see {@link activationFault}). A plain Error would be
     * indistinguishable in-process but would lose the code at the Hook boundary,
     * where only a fault is recognised.
     * @param code - the stable refusal code.
     * @param options - optional `cause` chain kept for in-process debugging.
     * @returns a rejection carrying that code.
     */
    private refuse;
    /**
     * Append one refusal to the durable journal and mirror it for this session.
     *
     * Never throws: this runs while an activation is already failing, and a
     * second failure raised from the reporting path would replace the real cause
     * with a bookkeeping error. When the append fails the mirror keeps the
     * refusal readable until the next Host restart replays the (absent) record.
     * @param agent - the Agent whose session was refused.
     * @param code - the stable refusal code.
     * @param phase - the act that was refused.
     * @param attempts - activation runs consumed before the refusal settled.
     */
    private recordFailure;
    /**
     * Read the last refusal this session recorded, newest record first.
     *
     * The journal is append-only, so the newest *usable* matching entry is the
     * current answer. Only that session's records are considered: a refusal
     * belongs to the session that suffered it, and a shared read model would let
     * one bad session explain another.
     * @param sessionId - the session whose refusal is wanted.
     * @returns the durable refusal, or the mirror when no usable record exists.
     */
    private readFailure;
    /**
     * Activate one Agent onto the shared DevFlow project, in the Harness
     * pre-publication window. Throws a stable activationCode on any failure.
     *
     * Every refusal is recorded to the durable journal before it is thrown, so
     * the reason survives both the Host boundary (which cannot carry it for an
     * initial activation) and a Host restart (which an in-memory field cannot).
     */
    activate(input: DevFlowActivationInput): Promise<DevFlowActivationLease>;
    /**
     * Verify one session's activation posture. `bound` is a conjunction; any
     * failed conjunct is `error` (or `unbound` after an explicit exit), and a
     * journal record alone can never produce `bound`.
     *
     * The recorded refusal rides along on every outcome, including a healthy one:
     * a session that failed and then succeeded is exactly the case where an
     * operator needs both facts, and hiding the earlier refusal once the session
     * recovers would re-create the blind spot this report exists to close.
     * @param agent - the live Agent whose session is being reported.
     */
    report(agent: Agent): Promise<DevFlowBoundReport>;
    /** True when this session's latest lifecycle journal record is an exit. */
    private sessionExplicitlyExited;
    private errorReport;
    private composedPresetOf;
    private durablePresetOf;
    private readProject;
    /**
     * Read or single-flight create THIS SESSION'S project.
     *
     * The single-flight key is the session's STORE, so two sessions activating
     * concurrently inside one workspace still share one initialization, while two
     * projects initialize independently of each other.
     */
    private ensureProject;
    private ensureProjectNow;
    private journalActivated;
    private journalDeactivated;
    /**
     * One Agent-private lease: reversal of exactly this activation.
     *
     * A reversal that fails is reported as a fault rather than a bare error for
     * the same reason the forward path is: the Harness Hook is the reader, and it
     * classifies a fault's own code. `restore()` deliberately does NOT append a
     * refusal record: it runs inside the Hook's own rollback, where a second
     * journal write could fail for the same reason the rollback is running, and
     * the rollback outcome is already reported as recovery-required.
     */
    private lease;
}
/**
 * Run one activation, re-running it while a composition switch is still
 * settling.
 *
 * Leaving a preset does not remove the tools that preset registered into each
 * Agent's OWN scope: a preset row that samples a per-Agent tool definition
 * (`tool-subagent` does) owns an Agent-scope registration, and
 * `tools.restrict()` never filters a scope's own registrations — it masks only
 * what the scope inherits. That owner removes its registration when the
 * harness publishes `tools/change`, which a recompose emits after the swap and
 * this activation's own install publishes too, so for one turn the outgoing
 * preset's Agent-owned tool is still visible to `verify()`. A session created
 * under `standard` and switched to DevFlow was therefore refused with
 * `devflow-activation-verification-failed`, intermittently, depending on
 * whether that registration had landed before the switch.
 *
 * The retry decides nothing: every run re-enters Commander and re-runs the
 * unchanged live verification, and the last refusal is what surfaces — a
 * genuinely wrong tool set still fails with the same code after the bounded
 * number of runs.
 *
 * Each run is told which attempt it is, so the durable refusal record can
 * separate "refused on the first try" from "still refused after the whole
 * settle budget". Those two read identically from the outside otherwise, and
 * they call for opposite responses: a first-try refusal is a real
 * configuration fault, while an exhausted budget points at the settling window
 * this wrapper exists to absorb.
 * @param provider - the activation provider the preset plane publishes.
 * @param input - the activation input the Harness Hook supplied.
 * @returns the lease of the first run whose live verification passed.
 * @throws the last failure, unchanged, when every run is refused.
 */
export declare function activateWithSettle(provider: DevFlowActivationProvider, input: DevFlowActivationInput): Promise<DevFlowActivationLease>;
/**
 * The host capability this preset row consumes from the composed `devflow`
 * service. Declaring it structurally keeps the read independent of the host
 * class and makes the missing-capability case explicit.
 */
export interface DevFlowHostController {
    createActivationProvider(): DevFlowActivationProvider | undefined;
}
/**
 * The `devflow` preset composition row. The preset mounts exactly this one
 * agent-plane plugin; it never loads the DevFlow host bundle, never registers
 * a second `devflow` service, Remote, client slot, or `.devflow` store. It
 * reads the already-composed host controller and provides the activation
 * provider value under the isolated `agentPresetActivation` service that the
 * Harness Hook resolves per standing subtree.
 *
 * The host controller MUST be read from the global service store
 * (`ctx.get('devflow')`), never through the context's namespace-property proxy
 * (`ctx` + the service name). A preset's standing subtree is plugged under the
 * current Agent context, so its fibers are SIBLINGS of the deployment bundle
 * that provides `devflow`; the cordis property proxy resolves only along the
 * ancestor fiber chain and therefore fails with `cannot get property ... without
 * inject` for a correctly composed host. `ctx.get` reads the global store and
 * is topology-independent (the documented rule for optional services). A
 * missing controller must stay a hard mount failure — never a silent downgrade
 * to a hook-less activation.
 */
export declare const devFlowActivationRow: {
    name: string;
    apply(ctx: Context, config?: unknown): void;
};
/** Named-entry surface so a preset row may load this module directly. */
export declare const name: string;
export declare function apply(ctx: Context, config?: unknown): void;
export default devFlowActivationRow;
