/**
 * DevFlow: Agent Team Workflow Orchestrator.
 * v0.1 owns the `devflow` service key, file-backed store, tools, and commands.
 * @module @xiaoxie-ide/dsh-devflow
 */
import { Context, Service } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { DevFlowStore, type DevFlowStoreState } from './storage.ts';
import { DevFlowSessionStores, type DevFlowSessionScope } from './session-store.ts';
import { TaskWorkflow } from './workflow.ts';
import { AgentWorkflow } from './workflow-agent.ts';
import { CommanderMode } from './commander-mode.ts';
import { DevFlowPresetActivation, type DevFlowBoundReport } from './preset-activation.ts';
import { type DevFlowSessionActivationMode } from './activation-session-hook.ts';
import { DevFlowChangeBus } from './change-bus.ts';
declare module '@deepseek-ai/cordis' {
    interface Context {
        devflow: DevflowController;
    }
}
/** DevFlow deployment configuration. */
export interface DevFlowConfig {
    /** The `.devflow` root; a relative path resolves against the fs backend's cwd. Defaults to `./.devflow`. */
    devflowDir?: string;
    /** Bundle-facing alias for {@link devflowDir}. */
    stateDir?: string;
    /**
     * Who runs the per-Agent preset activation.
     *
     * `auto` (the default) asks the loaded Harness whether the per-Agent
     * activation contract is still present: while it is (`0.1.5`), the Harness
     * drives `activate()` through the preset row and the host **yields**; once it
     * is gone (`0.1.7+`) the host drives it from `agent/created`. `host` and
     * `preset-row` pin the choice for a deployment that needs to recover without
     * waiting for a release.
     */
    sessionActivation?: DevFlowSessionActivationMode;
}
/**
 * Validate deployment-owned config. Unknown keys fail at load rather than
 * being silently ignored.
 * @param config - raw plugin config.
 * @returns a detached validated config.
 */
export declare function resolveConfig(config: DevFlowConfig): {
    devflowDir: string;
    sessionActivation: DevFlowSessionActivationMode;
};
/**
 * DevFlow orchestration service: owns project context, the task lifecycle,
 * Agent handoff state, and their file-backed store.
 */
export declare class DevflowController extends Service {
    static inject: string[];
    /**
     * The retained mixed library at the host process cwd (`./.devflow`).
     *
     * Since 第九步 this is NOT the store any session uses: every session resolves
     * its own `<workspace>/.devflow` through {@link sessionStores}. It is kept
     * constructed because the existing mixed library must stay readable as-is
     * (decision 3: no moving, splitting, or re-attributing), and because a
     * session that carries no workspace fact at all is exactly what it holds.
     */
    readonly store: DevFlowStore;
    /** Per-session-workspace store resolution: the isolation this round adds. */
    readonly sessionStores: DevFlowSessionStores;
    /** Task lifecycle manager over the file-backed store. */
    readonly workflow: TaskWorkflow;
    /**
     * Committed-write notification seam behind the live event channel. It carries no
     * business state: subscribers learn only that the committed `.devflow` state moved.
     */
    readonly changeBus: DevFlowChangeBus;
    /** Planner 闁?DevFlow 闁?Executor collaboration flow. */
    readonly agentWorkflow: AgentWorkflow;
    /** Interactive Commander controller; absent without the complete host services. */
    commanderMode: CommanderMode | undefined;
    /**
     * The `devflow` preset activation adapter. It consumes the Harness generic
     * activation Hook for this deployment's single host controller: the preset
     * composition row calls {@link createActivationProvider} and provides the
     * returned value as the isolated `agentPresetActivation` service. No second
     * loader, service, Remote, or state source is created.
     */
    presetActivation: DevFlowPresetActivation | undefined;
    /**
     * A provider value for one `devflow` preset composition's isolated row.
     * Each composition mount receives its own plain provider value, all sharing
     * this one host controller and the one `.devflow` store.
     */
    createActivationProvider(): import("./preset-activation.ts").DevFlowActivationProvider | undefined;
    /** Read one session's verified activation posture for commands and snapshots. */
    readPresetActivation(agent: Agent): Promise<DevFlowBoundReport> | undefined;
    /** Last hydrated mixed-library read model (diagnostics only; see {@link store}). */
    private durableState;
    /**
     * Read the last successful snapshot of the RETAINED MIXED LIBRARY.
     *
     * This is deliberately not any session's read model: since 第九步 a session's
     * state is read through {@link resolveSessionScope}, and this accessor only
     * serves diagnostics over the pre-isolation library that must stay visible
     * and unmodified.
     */
    readState(): DevFlowStoreState;
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
    resolveSessionScope(agent: Agent | undefined): DevFlowSessionScope;
    constructor(ctx: Context, config?: DevFlowConfig);
}
export type * from './types.ts';
export default DevflowController;
