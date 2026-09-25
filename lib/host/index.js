/**
 * DevFlow: Agent Team Workflow Orchestrator.
 * v0.1 owns the `devflow` service key, file-backed store, tools, and commands.
 * @module @xiaoxie-ide/dsh-devflow
 */
import { Service } from '@deepseek-ai/cordis';
import { DevFlowStore } from "./storage.js";
import { initialDevFlowState } from "./state.js";
import { DevFlowSessionStores } from "./session-store.js";
import { TaskWorkflow } from "./workflow.js";
import { AgentWorkflow } from "./workflow-agent.js";
import { registerDevFlowTools } from "./tools.js";
import { registerDevFlowCommands } from "./commands.js";
import { CommanderMode } from "./commander-mode.js";
import { DevFlowPresetActivation } from "./preset-activation.js";
import { createDevFlowSessionActivation, } from "./activation-session-hook.js";
import { DevFlowClientBridge } from "./client-bridge.js";
import { DevFlowChangeBus, committedWriteObserver } from "./change-bus.js";
import { DEFAULT_FIXED_AGENTS } from "./default-agents.js";
const DEFAULT_DEVFLOW_DIR = './.devflow';
/**
 * Validate deployment-owned config. Unknown keys fail at load rather than
 * being silently ignored.
 * @param config - raw plugin config.
 * @returns a detached validated config.
 */
export function resolveConfig(config) {
    const devflowDir = config.devflowDir
        ?? config.stateDir
        ?? DEFAULT_DEVFLOW_DIR;
    if (typeof devflowDir !== 'string' || devflowDir.trim() === '') {
        throw new Error('DevFlowConfig needs a non-empty string `devflowDir` or `stateDir`');
    }
    const sessionActivation = config.sessionActivation ?? 'auto';
    if (sessionActivation !== 'auto' && sessionActivation !== 'host' && sessionActivation !== 'preset-row') {
        throw new Error(`DevFlowConfig.sessionActivation must be "auto", "host" or "preset-row"; got ${JSON.stringify(sessionActivation)}`);
    }
    const unknown = Object.keys(config)
        .filter(key => key !== 'devflowDir' && key !== 'stateDir' && key !== 'sessionActivation');
    if (unknown.length > 0) {
        throw new Error(`DevFlowConfig has unknown key(s) ${unknown.join(', ')}; config is { devflowDir?, stateDir?, sessionActivation? }`);
    }
    return { devflowDir, sessionActivation };
}
/**
 * DevFlow orchestration service: owns project context, the task lifecycle,
 * Agent handoff state, and their file-backed store.
 */
export class DevflowController extends Service {
    static inject = ['fs', 'tools'];
    /**
     * The retained mixed library at the host process cwd (`./.devflow`).
     *
     * Since 第九步 this is NOT the store any session uses: every session resolves
     * its own `<workspace>/.devflow` through {@link sessionStores}. It is kept
     * constructed because the existing mixed library must stay readable as-is
     * (decision 3: no moving, splitting, or re-attributing), and because a
     * session that carries no workspace fact at all is exactly what it holds.
     */
    store;
    /** Per-session-workspace store resolution: the isolation this round adds. */
    sessionStores;
    /** Task lifecycle manager over the file-backed store. */
    workflow;
    /**
     * Committed-write notification seam behind the live event channel. It carries no
     * business state: subscribers learn only that the committed `.devflow` state moved.
     */
    changeBus;
    /** Planner 闁?DevFlow 闁?Executor collaboration flow. */
    agentWorkflow;
    /** Interactive Commander controller; absent without the complete host services. */
    commanderMode;
    /**
     * The `devflow` preset activation adapter. It consumes the Harness generic
     * activation Hook for this deployment's single host controller: the preset
     * composition row calls {@link createActivationProvider} and provides the
     * returned value as the isolated `agentPresetActivation` service. No second
     * loader, service, Remote, or state source is created.
     */
    presetActivation;
    /**
     * A provider value for one `devflow` preset composition's isolated row.
     * Each composition mount receives its own plain provider value, all sharing
     * this one host controller and the one `.devflow` store.
     */
    createActivationProvider() {
        return this.presetActivation?.createProvider();
    }
    /** Read one session's verified activation posture for commands and snapshots. */
    readPresetActivation(agent) {
        return this.presetActivation?.report(agent);
    }
    /** Last hydrated mixed-library read model (diagnostics only; see {@link store}). */
    durableState = initialDevFlowState();
    /**
     * Read the last successful snapshot of the RETAINED MIXED LIBRARY.
     *
     * This is deliberately not any session's read model: since 第九步 a session's
     * state is read through {@link resolveSessionScope}, and this accessor only
     * serves diagnostics over the pre-isolation library that must stay visible
     * and unmodified.
     */
    readState() {
        return this.durableState;
    }
    /**
     * Resolve the store, workspace, and identity of one calling session.
     *
     * Every stateful surface — tools, commands, the client bridge, the preset
     * activation adapter — goes through here, so there is exactly one place where
     * "which project is this session" is decided.
     * @param agent - the calling Agent, when the runtime supplied one.
     * @returns the session's store scope.
     * @throws DevFlowSessionScopeError when the session cannot be scoped.
     */
    resolveSessionScope(agent) {
        return this.sessionStores.resolve(agent);
    }
    constructor(ctx, config = {}) {
        super(ctx, 'devflow');
        // The change bus is the store's committed-write observer: every `.devflow`
        // mutation reaches it through the store's single `writeJson` seam. Since
        // 第九步 the observer is built per resolved session, so each frame carries
        // the project whose state moved and no project's frame reaches another's
        // subscriber.
        this.changeBus = new DevFlowChangeBus();
        ctx.effect(() => () => { this.changeBus.dispose(); }, 'devflow: change bus');
        const { devflowDir, sessionActivation } = resolveConfig(config);
        this.sessionStores = new DevFlowSessionStores(ctx.fs, devflowDir, (sessionKey, relativePath, sequence, record) => {
            this.changeBus.report(relativePath, sequence, record, sessionKey);
        }, 
        // Every write of a session-scoped store states which session's workspace
        // it belongs to. A project workspace typically lives outside the host
        // process cwd, and the host filesystem fences a policy-less write against
        // its deployment default root — so without this the project's own
        // `.devflow` would be refused exactly where the project lives.
        agent => {
            if (agent === undefined)
                return undefined;
            const policy = ctx.get('sandboxPolicy')?.resolve({ session: agent.session });
            return policy === undefined ? undefined : { mode: policy.mode, workspaceRoot: policy.workspaceRoot };
        });
        this.store = new DevFlowStore(ctx.fs, devflowDir, committedWriteObserver(this.changeBus));
        this.workflow = new TaskWorkflow(this.store);
        this.agentWorkflow = new AgentWorkflow(this.store, this.workflow);
        const commander = DEFAULT_FIXED_AGENTS.find(agent => agent.agentId === 'commander');
        if (commander === undefined)
            throw new Error('devflow: default commander configuration is missing');
        this.commanderMode = new CommanderMode(commander.prompt);
        registerDevFlowTools(ctx, {
            store: this.store,
            sessionStores: this.sessionStores,
            workflow: this.workflow,
            agentWorkflow: this.agentWorkflow,
            // The explicit registration allow-list: the caller must hold the live
            // Commander seat. Read through `this` so the check always sees the
            // current seat map and stays correct after an exit or a project switch.
            isCommander: agent => this.commanderMode?.current(agent).mode === 'commander',
        });
        // Bound the shared project, Commander, and live-scope readers into one
        // adapter. Composed-preset reads go through the Harness agentPresets
        // service on the Agent's own context, so the check is always live.
        this.presetActivation = new DevFlowPresetActivation(this.sessionStores, this.commanderMode, {
            composedPreset: agent => agent.ctx.get('agentPresets')?.composedPreset(agent.ctx),
        });
        new DevFlowClientBridge(ctx);
        // The per-Agent activation fallback. On a host that still drives preset
        // activation itself this yields (resolves to `preset-row`), so `0.1.5`
        // behavior is unchanged; where the contract is gone it installs the
        // Commander from `agent/created`, which is the only seam left.
        createDevFlowSessionActivation({
            createActivationProvider: () => this.createActivationProvider(),
            composedPreset: agent => agent.ctx.get('agentPresets')?.composedPreset(agent.ctx),
            // Read live, not captured: the loader provides this service after the
            // controller is constructed, and the hook asks its SHAPE (which mechanism
            // the host runs) rather than caching the answer.
            presetService: () => ctx.get('agentPresets'),
            warn: message => { ctx.logger('devflow').warn(message); },
        }, sessionActivation).attach(ctx);
        void this.store.loadState()
            .then(state => { this.durableState = state; })
            .catch(() => { this.durableState = initialDevFlowState(); });
        registerDevFlowCommands(ctx, {
            store: this.store,
            sessionStores: this.sessionStores,
            agentWorkflow: this.agentWorkflow,
            getCommanderMode: () => this.commanderMode,
            readPresetActivation: agent => this.presetActivation?.report(agent),
        });
        // M3 owns state in `.devflow/`; M5 will expose this read model to the browser.
    }
}
export default DevflowController;
