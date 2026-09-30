/**
 * Host-side per-Agent activation fallback for the DevFlow preset.
 *
 * ## Why this module exists
 *
 * `0.1.5` hands a preset an ISOLATED `agentPresetActivation` provider and calls
 * `activate()` itself, in the pre-publication window, once per Agent — and tears
 * it down per Agent again (`packages/preset/agent-presets/src/activation.ts`).
 * `0.1.7-rc.1` **deleted that contract entirely**: preset plugin trees are mounted
 * ONCE at registration and every Agent merely binds to that shared revision, so
 * nothing ever calls `activate()`. The preset row still applies, still provides
 * its service, and the roster reports no problem — the Commander simply never
 * gets installed. That is a SILENT failure, which is what this fallback removes.
 *
 * ## Why a host listener is a sound seam (measured, not assumed)
 *
 * `agent/created` exists in both versions and is `@mode serial` in `0.1.7`: the
 * listener is awaited before `create()` resolves and before the Agent's first
 * model request is assembled. 第二十步 measured this FUNCTIONALLY — a tool
 * registered inside that listener reached the model's own tool list and was
 * successfully called (`D:\_dsh_probe_017\probe20-headless-final.txt` for
 * `0.1.7`, `-015.txt` for `0.1.5`). "The event exists" was never the criterion;
 * "what I changed actually reached the Agent" is.
 *
 * ## How double-running on `0.1.5` is prevented
 *
 * Not by guessing a version, and NOT by "is the preset row mounted" — the row mounts
 * under BOTH mechanisms, which is exactly how a first cut of this yielded on `0.1.7`
 * and reproduced the very silent failure it exists to remove. The decision is made
 * from the host's own preset SERVICE, whose method set identifies the mechanism (see
 * {@link hostDrivesPerAgentActivation}): a directory roster that calls `activate()`
 * itself makes us yield; a declaration registry that never calls it makes us act.
 *
 * A per-Agent lease Map plus an in-flight guard backs that up: whichever mode
 * resolves, an Agent that already holds a lease is never activated a second time.
 *
 * ## The reversal edge (added 2026-10-01)
 *
 * Installing on `agent/created` is only half the lifecycle: a session may switch
 * preset while it is still blank, and `agent/disposed` never fires for that. The
 * measured consequence was a session that read `标准模式` while still running the
 * Commander persona and its deny-guard. The hook therefore also listens for the
 * preset registry's `agent-preset/selected` signal — switching away releases the
 * lease, switching back re-installs — and re-evaluates the per-Agent DevFlow
 * capability scope on the same edge.
 *
 * @module @xiaoxie-ide/dsh-devflow/activation-session-hook
 */
import { activateWithSettle, } from "./preset-activation.js";
import { DEVFLOW_CAPABILITY_PRESET_ID, DEVFLOW_TOOL_NAMES, shouldHideDevFlowTools, } from "./capability-scope.js";
/** The one preset id this fallback will activate. */
const DEVFLOW_PRESET_ID = DEVFLOW_CAPABILITY_PRESET_ID;
/**
 * Report whether THIS host drives per-Agent preset activation by itself.
 *
 * The two mechanisms are told apart by the service that implements them, which is
 * the durable difference — NOT a version string, and NOT "is the preset row
 * mounted". That last one is the trap this function exists to avoid: under BOTH
 * mechanisms the row mounts and provides its service, so "row is mounted" answers
 * `true` on `0.1.7` too, where nothing ever calls `activate()`. Yielding on that
 * signal is exactly the silent failure this whole module exists to remove.
 *
 * | host | service | marker |
 * |---|---|---|
 * | `0.1.5` | `AgentPresets` — directory roster; calls `provider.activate()` per Agent | has `standingKeyFor` |
 * | `0.1.7+` | `AgentPresetRegistry` — declaration registry; mounts ONE shared tree and only binds Agents | has `register` |
 *
 * An unknown shape answers `true` (yield): that preserves today's behavior, and a
 * wrong "host should act" on a host that also acts would double-activate.
 * @param service - the host's preset service, when reachable.
 * @returns true when the host calls `activate()` itself and we must yield.
 */
export function hostDrivesPerAgentActivation(service) {
    if (service === undefined || service === null)
        return true;
    const probe = service;
    if (typeof probe.register === 'function')
        return false;
    if (typeof probe.standingKeyFor === 'function')
        return true;
    return true;
}
/**
 * Resolve the mode for one decision.
 *
 * `auto` re-reads the live fact on every call rather than caching it at
 * construction: the controller may build this hook before the profile's loader has
 * provided the preset service, and a stale read would decide against a mechanism
 * that has not appeared yet.
 * @param mode - the configured mode.
 * @param presetService - live read of the host's preset service.
 * @returns the mode to act under.
 */
export function resolveActivationMode(mode, presetService) {
    if (mode === 'host')
        return 'host';
    if (mode === 'preset-row')
        return 'preset-row';
    return hostDrivesPerAgentActivation(presetService()) ? 'preset-row' : 'host';
}
/**
 * Build the per-Agent activation fallback.
 *
 * @param deps - the controller capabilities this hook consumes.
 * @param mode - configured activation mode.
 * @returns the hook the host bundle attaches.
 */
export function createDevFlowSessionActivation(deps, mode = 'auto') {
    const leases = new Map();
    /**
     * Per-Agent DevFlow-capability visibility restrictions.
     *
     * Separate from {@link leases} on purpose. A lease is the installed Commander
     * (persona + guard + tool narrowing) and only exists in `host` mode; the
     * restriction is "this Agent may not even SEE the `devflow_*` family" and
     * applies under BOTH activation mechanisms, because the family is registered by
     * the host bundle regardless of who drives activation. Owning both here keeps
     * one place that answers "what DevFlow state does this Agent hold right now".
     */
    const scopes = new Map();
    /** The host context, captured on attach so a preset edge can resolve its Agent. */
    let host;
    /**
     * Agents whose activation is currently in flight.
     *
     * `leases` alone is not enough: two `agent/created` edges for one Agent can
     * arrive before the first activation resolves, and both would pass the
     * `leases.has` check. This guard makes the second edge a no-op, which is what
     * keeps a racing host from installing the Commander twice.
     */
    const inFlight = new Set();
    const pending = new Set();
    const modeListeners = new Set();
    const warn = deps.warn ?? (() => { });
    let attached = false;
    let announced;
    /** Track one asynchronous edge so {@link DevFlowSessionActivationHook.settled} can await it. */
    const track = (work) => {
        pending.add(work);
        void work.catch(() => { }).finally(() => { pending.delete(work); });
        return work;
    };
    /** Publish a mode change once, so listeners never see duplicates. */
    const noteMode = (value) => {
        if (announced === value)
            return;
        announced = value;
        for (const listener of modeListeners)
            listener(value);
    };
    /** Activate one Agent, remembering the lease on success. */
    const activateOne = async (agent, key) => {
        if (leases.has(key) || inFlight.has(key))
            return;
        inFlight.add(key);
        try {
            if (deps.composedPreset(agent) !== DEVFLOW_PRESET_ID)
                return;
            const provider = deps.createActivationProvider();
            if (provider === undefined) {
                warn(`devflow: host session activation skipped for ${key}: this deployment has no activation adapter`);
                return;
            }
            try {
                const lease = await activateWithSettle(provider, {
                    agent,
                    agentCtx: agent.ctx,
                    preset: { id: DEVFLOW_PRESET_ID },
                    kind: 'initial',
                });
                leases.set(key, lease);
            }
            catch (error) {
                // The refusal is recorded durably by the adapter (`recordFailure` runs
                // before every throw), which is what makes it visible to the tools, the
                // roster, and a restart. This line only adds the host edge.
                warn(`devflow: host session activation refused for ${key}: ${describe(error)}`);
            }
        }
        finally {
            inFlight.delete(key);
        }
    };
    /**
     * Release one Agent's activation lease, exactly once.
     *
     * Shared by the disposal edge and the preset-change edge so both reverse the
     * SAME installation through the SAME path — the reversal is the lease's own
     * `deactivate()` (persona + execution guard + tool narrowing), and it must not
     * be re-entered by a second edge for the same Agent. The map entry is dropped
     * BEFORE awaiting.
     * @param key - the Agent identity holding the lease.
     */
    const releaseLease = (key) => {
        const lease = leases.get(key);
        if (lease === undefined)
            return;
        leases.delete(key);
        void track((async () => {
            try {
                await lease.deactivate();
            }
            catch (error) {
                // A failed teardown must never block the caller (disposal, or a preset
                // switch); it is a warning because throwing would turn a cleanup problem
                // into a broken session.
                warn(`devflow: session activation teardown failed for ${key}: ${describe(error)}`);
            }
        })());
    };
    /**
     * Re-evaluate one Agent's DevFlow-capability visibility.
     *
     * Hides the `devflow_*` family from an Agent that is not a live DevFlow
     * session, and lifts the hide again when it becomes one. Idempotent by
     * construction: the installed state is compared with the wanted state, so
     * repeated edges never stack restrictions.
     * @param agent - the Agent whose model-facing surface is being scoped.
     */
    const syncCapabilityScope = (agent) => {
        const key = String(agent.id);
        const installed = scopes.get(key);
        const shouldHide = shouldHideDevFlowTools(agent);
        if (shouldHide === (installed !== undefined))
            return;
        if (!shouldHide) {
            scopes.delete(key);
            try {
                installed?.();
            }
            catch (error) {
                warn(`devflow: capability scope release failed for ${key}: ${describe(error)}`);
            }
            return;
        }
        try {
            // Intersect with what this Agent can actually see: `restrict()` refuses an
            // unknown global name, and an Agent whose surface was already narrowed by
            // its dispatch filter needs no second restriction for names it cannot see.
            const present = new Set(agent.ctx.tools.schemas(agent).map(tool => tool.name));
            const deny = DEVFLOW_TOOL_NAMES.filter(name => present.has(name));
            if (deny.length === 0)
                return;
            scopes.set(key, agent.ctx.tools.restrict({ deny: [...deny] }));
        }
        catch (error) {
            // Hiding is an optimization ON TOP of the execution guard, so a refusal
            // here must not break the Agent: the guard still denies every call.
            warn(`devflow: capability scoping failed for ${key}: ${describe(error)}`);
        }
    };
    /** Resolve one Agent by its session identity, when the host exposes a registry. */
    const agentById = (sessionId) => {
        if (host === undefined)
            return undefined;
        try {
            const agents = host.get('agents');
            return agents?.get?.(sessionId);
        }
        catch {
            return undefined;
        }
    };
    const onAgentCreated = (payload) => {
        const agent = payload?.agent;
        if (agent === undefined)
            return;
        // Capability scoping is host-independent: the tool family is registered by
        // this bundle for every composition, so the surface is narrowed here for
        // BOTH activation mechanisms.
        syncCapabilityScope(agent);
        const resolved = resolveActivationMode(mode, deps.presetService);
        noteMode(resolved);
        // The yield: a live preset row means the Harness drives `activate()` for this
        // Agent, and the host must not do it a second time.
        if (resolved !== 'host')
            return;
        void track(activateOne(agent, String(agent.id)));
    };
    const onAgentDisposed = (payload) => {
        const agent = payload?.agent;
        if (agent === undefined)
            return;
        const key = String(agent.id);
        const release = scopes.get(key);
        if (release !== undefined) {
            scopes.delete(key);
            try {
                release();
            }
            catch (error) {
                warn(`devflow: capability scope release failed for ${key}: ${describe(error)}`);
            }
        }
        releaseLease(key);
    };
    /**
     * One session's preset changed while it was still blank.
     *
     * This is the edge the fallback was missing. 2026-10-01 measured the failure it
     * removes: a session created on `devflow` and switched to `standard` kept the
     * Commander persona AND the deny-guard installed, because installation happened
     * on `agent/created` and only `agent/disposed` ever reversed it — the session
     * read `标准模式` while it still ran DevFlow (`probe-leak-switch.jsonl`,
     * `AFTER-SWITCH`: `composedPreset: "standard"` with
     * `commanderMode: "commander"` and `pwshGuardDenial: true`).
     *
     * The preset registry emits this from its own `session/event` listener AFTER the
     * recompose committed (`Harness-017
     * packages/preset/agent-preset-registry/src/index.ts:68-70`, and `select()`
     * recomposes before it appends at `:325-326`), so every read below already sees
     * the NEW composition.
     * @param sessionId - the session whose preset moved.
     * @param agentPreset - the preset it moved to.
     */
    const onPresetSelected = (sessionId, agentPreset) => {
        const key = typeof sessionId === 'string' ? sessionId : '';
        if (key === '')
            return;
        const agent = agentById(key);
        if (agent !== undefined)
            syncCapabilityScope(agent);
        const resolved = resolveActivationMode(mode, deps.presetService);
        noteMode(resolved);
        // Same yield as `agent/created`: on a host that drives activation itself, the
        // roster owns both the installation and its reversal.
        if (resolved !== 'host')
            return;
        if (agentPreset === DEVFLOW_PRESET_ID) {
            // Switching BACK must re-install; `activateOne` is a no-op when this Agent
            // already holds a lease or one is in flight.
            if (agent !== undefined)
                void track(activateOne(agent, key));
            return;
        }
        releaseLease(key);
    };
    return {
        attach(ctx) {
            if (attached)
                return;
            attached = true;
            host = ctx;
            ctx.on('agent/created', onAgentCreated);
            ctx.on('agent/disposed', onAgentDisposed);
            ctx
                .on('agent-preset/selected', onPresetSelected);
            noteMode(resolveActivationMode(mode, deps.presetService));
        },
        async settled() {
            // An edge can enqueue a follow-up (a teardown after a refused activation),
            // so drain until the queue stops growing.
            for (let pass = 0; pass < 4; pass += 1) {
                await Promise.allSettled([...pending]);
                if (pending.size === 0)
                    break;
            }
        },
        get liveCount() {
            return leases.size;
        },
        get scopedCount() {
            return scopes.size;
        },
        get mode() {
            return resolveActivationMode(mode, deps.presetService);
        },
        onModeChange(listener) {
            modeListeners.add(listener);
            return () => { modeListeners.delete(listener); };
        },
    };
}
/** One bounded line of error text; never a raw stack in a log line. */
function describe(error) {
    if (error instanceof Error)
        return `${error.name}: ${error.message}`;
    return String(error);
}
