/**
 * DevFlow human commands: `/devflow init|status|tasks|roles|show|agents|
 * export|import|resume`, a direct command-plane entry that never routes
 * through a model turn. The command child activates only when a command
 * registry is composed.
 * @module @xiaoxie-ide/dsh-devflow/commands
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { DevFlowStore } from './storage.ts';
import type { DevFlowSessionStores } from './session-store.ts';
import type { AgentWorkflow } from './workflow-agent.ts';
import type { CommanderMode } from './commander-mode.ts';
import type { DevFlowBoundReport } from './preset-activation.ts';
export interface DevFlowCommandServices {
    /** The retained mixed-library store (host-cwd `./.devflow`). */
    readonly store: DevFlowStore;
    /**
     * Per-session-workspace store resolution, when the composition isolates.
     *
     * Every command runs inside one session, so it resolves that session's own
     * project before reading or writing anything: `/devflow tasks` in project B
     * must never list project A's tasks.
     */
    readonly sessionStores?: DevFlowSessionStores;
    readonly agentWorkflow: AgentWorkflow;
    /** Read the interactive Commander mode after optional host composition settles. */
    readonly getCommanderMode: () => CommanderMode | undefined;
    /** Read one session's verified preset activation report, when composed. */
    readonly readPresetActivation?: (agent: Agent) => Promise<DevFlowBoundReport> | undefined;
}
/**
 * Register the `/devflow` command family on `ctx.commands`.
 * @param ctx - registrant context; the command registers only when a command
 *   registry is composed.
 * @param services - the store, workflow, and optional Commander controller the commands delegate to.
 */
export declare function registerDevFlowCommands(ctx: Context, services: DevFlowCommandServices): void;
