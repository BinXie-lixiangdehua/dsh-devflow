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
 * @module @xiaoxie-ide/dsh-devflow/activation-session-hook
 */
import { activateWithSettle, } from "./preset-activation.js";
/** The one preset id this fallback will activate. */
const DEVFLOW_PRESET_ID = 'devflow';
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
    const onAgentCreated = (payload) => {
        const agent = payload?.agent;
        if (agent === undefined)
            return;
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
        const lease = leases.get(key);
        if (lease === undefined)
            return;
        // Drop the entry BEFORE awaiting: teardown is best-effort and must never be
        // re-entered by a second disposal edge.
        leases.delete(key);
        void track((async () => {
            try {
                await lease.deactivate();
            }
            catch (error) {
                // A failed teardown must never block Agent disposal; it is a warning
                // because throwing into the disposal path would turn a cleanup problem
                // into a broken shutdown.
                warn(`devflow: session activation teardown failed for ${key}: ${describe(error)}`);
            }
        })());
    };
    return {
        attach(ctx) {
            if (attached)
                return;
            attached = true;
            ctx.on('agent/created', onAgentCreated);
            ctx.on('agent/disposed', onAgentDisposed);
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
