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
import { randomUUID } from 'node:crypto';
import { recordDevFlowChange } from "./journal.js";
import { deriveNewProjectIdentity } from "./session-store.js";
import { recordFixedRosterChanges } from "./default-agents.js";
import { ACTIVATION_CODE_REASONS_ZH, ACTIVATION_PHASE_REASONS_ZH, activationReasonZh } from "./activation-reason.js";
/** The one preset id this adapter will activate. */
export const DEVFLOW_PRESET_ID = 'devflow';
/** Whether a value can read one Session projection key. */
function isAgentPresetProjectionReader(value) {
    return typeof value === 'object' && value !== null
        && typeof value.stateOf === 'function';
}
/** Stable activationCodes this adapter may surface; never raw provider text. */
export const DEVFLOW_ACTIVATION_CODES = {
    presetIdentityMismatch: 'devflow-preset-identity-mismatch',
    sessionMismatch: 'devflow-session-mismatch',
    projectUnavailable: 'devflow-project-unavailable',
    projectInitFailed: 'devflow-project-init-failed',
    commanderInstallFailed: 'devflow-commander-install-failed',
    verificationFailed: 'devflow-activation-verification-failed',
    commanderNotInstalled: 'devflow-commander-not-installed',
    deactivationFailed: 'devflow-deactivation-failed',
    restoreFailed: 'devflow-restore-failed',
    journalFailed: 'devflow-journal-failed',
    hostUnavailable: 'devflow-host-unavailable',
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
export const CODE_MESSAGES = {
    'devflow-preset-identity-mismatch': 'DevFlow preset identity does not match this session.',
    'devflow-session-mismatch': 'DevFlow session identity does not match the live Agent.',
    'devflow-project-unavailable': 'DevFlow project is unavailable for this session.',
    'devflow-project-init-failed': 'DevFlow project could not be initialized for this session.',
    'devflow-commander-install-failed': 'DevFlow Commander could not be installed for this session.',
    'devflow-activation-verification-failed': 'DevFlow activation could not be verified for this session.',
    'devflow-commander-not-installed': 'DevFlow Commander is not installed for this session.',
    'devflow-deactivation-failed': 'DevFlow Commander could not be removed for this session.',
    'devflow-restore-failed': 'DevFlow Commander could not be restored for this session.',
    'devflow-journal-failed': 'DevFlow activation record could not be written.',
    'devflow-host-unavailable': 'DevFlow host is unavailable for this session.',
};
/** Lazily resolve the Harness Hook's fault constructor when module identity allows. */
let harnessFaultConstructor;
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
export async function activationFault(code, options) {
    if (harnessFaultConstructor === undefined) {
        try {
            const module = await import('@deepseek-ai/dsh-agent-presets');
            const candidate = module.AgentPresetActivationFault;
            harnessFaultConstructor = typeof candidate === 'function'
                ? candidate
                : null;
        }
        catch {
            harnessFaultConstructor = null;
        }
    }
    if (harnessFaultConstructor !== null)
        return new harnessFaultConstructor(code);
    const error = new Error('agent preset activation rejected', options);
    Object.defineProperty(error, 'activationCode', { value: code, enumerable: true });
    return error;
}
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
export function activationFaultCode(error) {
    const value = error?.activationCode;
    return typeof value === 'string' && value in ACTIVATION_CODE_REASONS_ZH
        ? value
        : undefined;
}
/** Preset lifecycle journal categories appended by the adapter. */
const ACTIVATED_JOURNAL = 'devflow/preset/activated';
const DEACTIVATED_JOURNAL = 'devflow/preset/deactivated';
const FAILED_JOURNAL = 'devflow/preset/activation-failed';
/** Per-store single-flight guard so concurrent activations share one project. */
const projectInitializations = new WeakMap();
/**
 * Last refusal per store, mirrored so a failed journal append cannot erase it.
 *
 * The journal is the authority a restart reads; this mirror only covers the
 * window where the append itself failed. It is deliberately keyed by store so
 * a second deployment in one process never inherits another's refusal.
 */
const lastFailures = new WeakMap();
/**
 * Normalize the constructor's store argument.
 *
 * A `DevFlowSessionStores` isolates per calling session; a plain `DevFlowStore`
 * is a single-store composition (tests and programmatic mounts) that says so by
 * passing the store itself.
 * @param source - either the session scope resolver or one fixed store.
 * @returns a function returning the store for one Agent.
 */
function scopeResolverOf(source) {
    return typeof source.resolve === 'function'
        ? agent => source.resolve(agent).store
        : () => source;
}
/**
 * Normalize the constructor's workspace argument for the same two shapes.
 *
 * A single-store composition has no session workspace at all, so it answers with
 * a value that is honestly unusable as a name — and `deriveProjectNameFromWorkspace`
 * turns that into the workspace verbatim rather than inventing a label. Such a
 * composition is a test or programmatic mount, never the shipped host, where the
 * resolver has already refused a workspace-less session outright.
 * @param source - either the session scope resolver or one fixed store.
 * @returns a function returning the workspace for one Agent.
 */
function workspaceResolverOf(source) {
    if (typeof source.resolve !== 'function')
        return () => '';
    return agent => {
        const scope = source.resolve(agent);
        // A store is only ever created from a session that HAD a workspace (the
        // resolver refuses otherwise), but the scope reports the pinned workspace
        // as nullable: treat the impossible case as absent rather than fabricating.
        return scope.workspacePath ?? '';
    };
}
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
export class DevFlowPresetActivation {
    commanderMode;
    options;
    /** One alias kept for composition rows and commands. */
    presetId = DEVFLOW_PRESET_ID;
    /** Resolve the store of the session being activated. */
    storeFor;
    /** Resolve the workspace directory of the session being activated. */
    workspaceFor;
    constructor(source, commanderMode, options = {}) {
        this.commanderMode = commanderMode;
        this.options = options;
        this.storeFor = scopeResolverOf(source);
        this.workspaceFor = workspaceResolverOf(source);
    }
    /** A provider value for the isolated `agentPresetActivation` composition row. */
    createProvider() {
        return { activate: (input) => this.activate(input) };
    }
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
    async refuse(code, options) {
        throw await activationFault(code, options);
    }
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
    async recordFailure(agent, code, phase, attempts) {
        const sessionId = String(agent.id);
        const at = this.options.now?.() ?? new Date().toISOString();
        const failure = { code, phase, attempts, reason: activationReasonZh(code), at };
        const store = this.storeFor(agent);
        const mirrored = lastFailures.get(store) ?? new Map();
        lastFailures.set(store, mirrored);
        mirrored.set(sessionId, failure);
        try {
            await recordDevFlowChange(store, FAILED_JOURNAL, { sessionId, activationCode: code, phase, attempts, reason: failure.reason, at });
        }
        catch {
            // The mirror above still answers `report()`; the durable half is best-effort
            // by design, because a journal we cannot write is exactly the failure this
            // record would have described.
        }
    }
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
    async readFailure(agent, sessionId) {
        const store = this.storeFor(agent);
        const mirrored = lastFailures.get(store)?.get(sessionId) ?? null;
        try {
            const entries = await store.listJournal();
            for (let index = entries.length - 1; index >= 0; index -= 1) {
                const entry = entries[index];
                if (entry === undefined || entry.type !== FAILED_JOURNAL)
                    continue;
                const data = entry.data;
                if (typeof data.sessionId !== 'string' || data.sessionId !== sessionId)
                    continue;
                // A record this build cannot decode (corrupt, or written by a newer
                // one) is skipped rather than returned, so an unreadable newest entry
                // does not mask an older usable one or the in-memory mirror.
                const decoded = readFailureRecord(entry.data, entry.at);
                if (decoded !== null)
                    return decoded;
            }
        }
        catch {
            // Fall through to the mirror: an unreadable journal must not look like
            // "no refusal ever happened" while the mirror still holds one.
        }
        return mirrored;
    }
    /**
     * Activate one Agent onto the shared DevFlow project, in the Harness
     * pre-publication window. Throws a stable activationCode on any failure.
     *
     * Every refusal is recorded to the durable journal before it is thrown, so
     * the reason survives both the Host boundary (which cannot carry it for an
     * initial activation) and a Host restart (which an in-memory field cannot).
     */
    async activate(input) {
        const { agent, preset } = input;
        // `initial` is the create-time mount and `recompose` the blank-session
        // switch; both are attributed as such, so the record says what was refused
        // and not merely which code came back.
        const phase = input.kind === 'recompose' ? 'recompose' : 'initial';
        const attempts = input.attempts ?? 1;
        // One closure so a refusal can never be thrown without first being
        // recorded: separating "record" from "throw" at each of the five refusal
        // sites is how one of them silently loses its trail.
        const refuse = async (code, options) => {
            await this.recordFailure(agent, code, phase, attempts);
            return await this.refuse(code, options);
        };
        if (preset.id !== DEVFLOW_PRESET_ID) {
            return await refuse(DEVFLOW_ACTIVATION_CODES.presetIdentityMismatch);
        }
        // Step 1: the LIVE composed scope must already be `devflow`; the request
        // alone is never trusted (no UI label, no bare selection event).
        if (this.composedPresetOf(agent) !== DEVFLOW_PRESET_ID) {
            return await refuse(DEVFLOW_ACTIVATION_CODES.presetIdentityMismatch);
        }
        // Already bound to this session's project is a no-op: no second persona/tool
        // layer, no duplicate journal stream, exactly the repeat-selection case.
        const existing = await this.readProject(agent);
        if (existing !== undefined) {
            const current = this.commanderMode.current(agent);
            if (current.mode === 'commander'
                && current.projectId === existing.id
                && this.commanderMode.verify(agent, existing.id).ok) {
                return this.lease(agent, existing.id);
            }
        }
        // Step 2: read or single-flight create the one project of THIS session's
        // workspace. The refusal is attributed here rather than inside the
        // initializer, because the initializer is shared by this adapter and the
        // command path and does not know which session's activation it is serving.
        let project;
        try {
            project = await this.ensureProject(agent);
        }
        catch (cause) {
            // The initializer already classifies its refusal; an unclassified error
            // falls back to the project-creation code rather than escaping unrecorded.
            return await refuse(activationFaultCode(cause) ?? DEVFLOW_ACTIVATION_CODES.projectInitFailed, { cause });
        }
        // Step 3: enter Commander for exactly this Agent.
        try {
            this.commanderMode.enter(agent, project.id);
        }
        catch (cause) {
            return await refuse(DEVFLOW_ACTIVATION_CODES.commanderInstallFailed, { cause });
        }
        // Step 4: verify the installation live (persona/tools/presentation state),
        // not the journal — never "we called enter, therefore bound".
        if (!this.commanderMode.verify(agent, project.id).ok) {
            try {
                this.commanderMode.exit(agent);
            }
            catch { /* best-effort cleanup */ }
            return await refuse(DEVFLOW_ACTIVATION_CODES.verificationFailed);
        }
        // Step 5: audit-only journal record. It is never used as Bound evidence.
        await this.journalActivated(agent, project.id);
        return this.lease(agent, project.id);
    }
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
    async report(agent) {
        const sessionId = String(agent.id);
        const lastFailure = await this.readFailure(agent, sessionId);
        const composed = this.composedPresetOf(agent);
        const durable = this.durablePresetOf(agent);
        if (composed !== DEVFLOW_PRESET_ID) {
            return {
                presetId: composed ?? null,
                commanderMode: this.commanderMode.current(agent).mode,
                projectId: null,
                activation: 'unbound',
                activationError: null,
                verifiedAt: null,
                lastFailure,
            };
        }
        if (durable !== DEVFLOW_PRESET_ID) {
            return this.errorReport(DEVFLOW_ACTIVATION_CODES.sessionMismatch, agent, lastFailure);
        }
        const project = await this.readProject(agent);
        if (project === undefined) {
            return this.errorReport(DEVFLOW_ACTIVATION_CODES.projectUnavailable, agent, lastFailure);
        }
        const current = this.commanderMode.current(agent);
        const installed = current.mode === 'commander' && current.projectId === project.id;
        const verified = installed && this.commanderMode.verify(agent, project.id).ok;
        if (verified) {
            return {
                presetId: DEVFLOW_PRESET_ID,
                commanderMode: 'commander',
                projectId: project.id,
                activation: 'bound',
                activationError: null,
                verifiedAt: this.options.now?.() ?? new Date().toISOString(),
                lastFailure,
            };
        }
        // DevFlow preset but Commander is not live: an explicit exit is `unbound`;
        // everything else (restart, partial install, missing record) is an error.
        const explicitlyExited = await this.sessionExplicitlyExited(agent, sessionId);
        if (explicitlyExited) {
            return {
                presetId: DEVFLOW_PRESET_ID,
                commanderMode: 'chat',
                projectId: project.id,
                activation: 'unbound',
                activationError: null,
                verifiedAt: null,
                lastFailure,
            };
        }
        return this.errorReport(current.mode === 'commander'
            ? DEVFLOW_ACTIVATION_CODES.verificationFailed
            : DEVFLOW_ACTIVATION_CODES.commanderNotInstalled, agent, lastFailure);
    }
    /** True when this session's latest lifecycle journal record is an exit. */
    async sessionExplicitlyExited(agent, sessionId) {
        const entries = await this.storeFor(agent).listJournal();
        for (let index = entries.length - 1; index >= 0; index -= 1) {
            const entry = entries[index];
            if (entry === undefined)
                continue;
            const data = entry.data;
            if (typeof data.sessionId !== 'string' || data.sessionId !== sessionId)
                continue;
            if (entry.type === DEACTIVATED_JOURNAL || entry.type === 'devflow/commander/mode-exit')
                return true;
            if (entry.type === ACTIVATED_JOURNAL || entry.type === 'devflow/commander/mode-enter')
                return false;
        }
        return false;
    }
    errorReport(conjunctCode, agent, lastFailure) {
        // A recorded refusal outranks the code this conjunction would infer: the
        // recorded one says WHY the attempt failed (a live-verification refusal, an
        // install that never happened), while the inferred one can only say that
        // Commander is not live right now. Without this, every recorded refusal
        // degrades to `commander-not-installed` on the next read and the
        // distinction the record exists to preserve is lost again.
        const code = lastFailure?.code ?? conjunctCode;
        return {
            presetId: DEVFLOW_PRESET_ID,
            commanderMode: this.commanderMode.current(agent).mode,
            projectId: null,
            activation: 'error',
            activationError: { code, message: CODE_MESSAGES[code] },
            verifiedAt: null,
            lastFailure,
        };
    }
    composedPresetOf(agent) {
        return this.options.composedPreset?.(agent);
    }
    durablePresetOf(agent) {
        if (this.options.durablePreset !== undefined)
            return this.options.durablePreset(agent);
        // The projection registry is a host-plane service the Agent scope inherits.
        // An absent registry leaves the durable preset UNKNOWN, which the caller's
        // identity check reports as `devflow-session-mismatch`; the composed scope
        // is never accepted as durable evidence in its place.
        const reader = agent.ctx.get('sessionProjections');
        if (!isAgentPresetProjectionReader(reader))
            return undefined;
        return reader.stateOf(agent.session, 'agentPreset') ?? undefined;
    }
    async readProject(agent) {
        return await this.storeFor(agent).loadProject();
    }
    /**
     * Read or single-flight create THIS SESSION'S project.
     *
     * The single-flight key is the session's STORE, so two sessions activating
     * concurrently inside one workspace still share one initialization, while two
     * projects initialize independently of each other.
     */
    async ensureProject(agent) {
        const store = this.storeFor(agent);
        const inFlight = projectInitializations.get(store);
        if (inFlight !== undefined)
            return inFlight;
        const attempt = this.ensureProjectNow(agent, store).finally(() => {
            projectInitializations.delete(store);
        });
        projectInitializations.set(store, attempt);
        return attempt;
    }
    async ensureProjectNow(agent, store) {
        const existing = await store.loadProject();
        if (existing !== undefined) {
            // The roster is seeded once, at first initialization, so a project created
            // by an older revision would keep a stale fixed-employee set forever: the
            // canvas renders the roster from `.devflow` and assignment/dispatch
            // validate against it. Reading the project is therefore also where
            // the shipped roster is reconciled. Only real changes are journalled, and
            // an unchanged roster writes nothing at all.
            //
            // The existing project's `name`/`goal` are NOT touched here: a project
            // that already exists keeps the identity it was created with, and
            // silently renaming one would rewrite an operator-visible fact behind
            // their back.
            try {
                await recordFixedRosterChanges(store);
            }
            catch (cause) {
                throw await activationFault(DEVFLOW_ACTIVATION_CODES.projectInitFailed, { cause });
            }
            return existing;
        }
        const now = this.options.now?.() ?? new Date().toISOString();
        // A new project is named after the workspace it lives in, and starts with
        // NO goal (see `deriveNewProjectIdentity`). The workspace is read through
        // the same resolver the store came from, so name and store root can never
        // disagree.
        const identity = deriveNewProjectIdentity(this.workspaceFor(agent));
        const project = {
            id: randomUUID(),
            name: identity.name,
            goal: identity.goal,
            currentStage: '',
            createdAt: now,
            updatedAt: now,
        };
        try {
            await store.saveProject(project);
            await recordDevFlowChange(store, 'devflow/project/update', { project });
            await recordFixedRosterChanges(store);
        }
        catch (cause) {
            throw await activationFault(DEVFLOW_ACTIVATION_CODES.projectInitFailed, { cause });
        }
        // A competing writer may have committed first; the committed record wins.
        const reread = await store.loadProject();
        return reread ?? project;
    }
    async journalActivated(agent, projectId) {
        try {
            await recordDevFlowChange(this.storeFor(agent), ACTIVATED_JOURNAL, {
                sessionId: String(agent.id),
                projectId,
                presetId: DEVFLOW_PRESET_ID,
                at: this.options.now?.() ?? new Date().toISOString(),
            });
        }
        catch (cause) {
            throw await activationFault(DEVFLOW_ACTIVATION_CODES.journalFailed, { cause });
        }
    }
    async journalDeactivated(agent, projectId) {
        await recordDevFlowChange(this.storeFor(agent), DEACTIVATED_JOURNAL, {
            sessionId: String(agent.id),
            projectId,
            presetId: DEVFLOW_PRESET_ID,
            at: this.options.now?.() ?? new Date().toISOString(),
        });
    }
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
    lease(agent, projectId) {
        return {
            deactivate: async () => {
                try {
                    this.commanderMode.exit(agent);
                }
                catch (cause) {
                    throw await activationFault(DEVFLOW_ACTIVATION_CODES.deactivationFailed, { cause });
                }
                await this.journalDeactivated(agent, projectId).catch(() => undefined);
            },
            restore: async () => {
                if (this.commanderMode.verify(agent, projectId).ok)
                    return;
                try {
                    this.commanderMode.enter(agent, projectId);
                    if (!this.commanderMode.verify(agent, projectId).ok) {
                        throw await activationFault(DEVFLOW_ACTIVATION_CODES.verificationFailed);
                    }
                }
                catch (cause) {
                    if (activationFaultCode(cause) !== undefined)
                        throw cause;
                    throw await activationFault(DEVFLOW_ACTIVATION_CODES.restoreFailed, { cause });
                }
                await this.journalActivated(agent, projectId).catch(() => undefined);
            },
        };
    }
}
/**
 * How many times one published activation re-runs after a live-verification
 * failure, and the wait between runs.
 *
 * The wait only has to cover the harness's own asynchronous removal of an
 * Agent-owned registration (a fiber disposal), never a state the deployment
 * could not reach, so the budget stays small and the failure path unchanged.
 */
const SETTLE_ATTEMPTS = 4;
const SETTLE_WAIT_MS = 40;
/** Whether a failure is the activation's own live-verification refusal. */
function isVerificationFailure(error) {
    return activationFaultCode(error) === DEVFLOW_ACTIVATION_CODES.verificationFailed;
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
export async function activateWithSettle(provider, input) {
    let lastError;
    for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt += 1) {
        try {
            return await provider.activate({ ...input, attempts: attempt + 1 });
        }
        catch (error) {
            if (!isVerificationFailure(error))
                throw error;
            lastError = error;
            await new Promise(resolve => { setTimeout(resolve, SETTLE_WAIT_MS); });
        }
    }
    throw lastError;
}
/**
 * Decode one journal record into a bounded refusal.
 *
 * The journal is on disk and therefore untrusted input: a hand-edited or
 * partially written entry must not be able to inject free text into the
 * operator-facing reason, so the code is re-derived from the fixed table and a
 * code outside it is refused outright (the caller then falls back to the
 * in-memory mirror). Only the code, phase, attempt count, and timestamp are
 * carried across; the reason is always this build's sentence for that code.
 * @param data - the record's `data` payload.
 * @param at - the record's own publication time, used when the payload has none.
 * @returns the decoded refusal, or null when the payload is not usable.
 */
function readFailureRecord(data, at) {
    if (typeof data !== 'object' || data === null)
        return null;
    const record = data;
    const code = typeof record.activationCode === 'string' ? activationFaultCode({ activationCode: record.activationCode }) : undefined;
    if (code === undefined)
        return null;
    const phase = typeof record.phase === 'string' && record.phase in ACTIVATION_PHASE_REASONS_ZH
        ? record.phase
        : 'initial';
    const attempts = typeof record.attempts === 'number' && Number.isSafeInteger(record.attempts) && record.attempts > 0
        ? record.attempts
        : 1;
    const time = typeof record.at === 'string' && record.at !== '' ? record.at : at;
    return { code, phase, attempts, reason: activationReasonZh(code), at: time };
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
export const devFlowActivationRow = {
    name: 'devflow-preset-activation',
    apply(ctx, config) {
        const controller = ctx.get('devflow');
        const provider = typeof controller?.createActivationProvider === 'function'
            ? controller.createActivationProvider()
            : undefined;
        if (provider === undefined) {
            throw new Error('devflow: preset activation requires the DevFlow host controller (devflow service)');
        }
        const published = {
            activate: (input) => activateWithSettle(provider, input),
        };
        ctx.effect(() => ctx.reflect.provide('agentPresetActivation', published));
    },
};
/** Named-entry surface so a preset row may load this module directly. */
export const name = devFlowActivationRow.name;
export function apply(ctx, config) {
    devFlowActivationRow.apply(ctx, config);
}
export default devFlowActivationRow;
