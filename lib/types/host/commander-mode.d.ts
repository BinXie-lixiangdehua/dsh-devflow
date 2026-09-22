/** Current-session Commander persona lifecycle for DevFlow developer mode. */
import type { Agent } from '@deepseek-ai/dsh-agent';
/** The harness interaction mode: native chat or the DevFlow Commander persona. */
export type HarnessMode = 'chat' | 'commander';
/** The current Developer mode state projected into one session. */
export interface CommanderModeState {
    /** Current user interaction mode. */
    readonly mode: HarnessMode;
    /** The current session agent identity, or null outside Commander mode. */
    readonly sessionId: string | null;
    /** Project the current session Agent drives, or null outside Commander mode. */
    readonly projectId: string | null;
    /** Mode transition timestamp, ISO 8601. */
    readonly changedAt: string;
}
/**
 * Installs the Commander persona into the current session Agent's scoped
 * system prompt. It creates neither an Agent nor a Session: normal user input
 * remains in the same native conversation while DevFlow state stays in the
 * plugin-owned `.devflow` store.
 */
export declare class CommanderMode {
    private readonly persona;
    private readonly active;
    constructor(persona: string);
    /** Enter Commander mode for the current session Agent. */
    enter(agent: Agent, projectId: string): CommanderModeState;
    /** Remove the Commander persona from the current session Agent. */
    exit(agent: Agent): CommanderModeState;
    /** Read one session Agent's mode state. */
    current(agent: Agent): CommanderModeState;
    /**
     * Verify that one Agent's Commander installation is live and complete.
     *
     * Map presence alone is not proof: the entry records that persona, tools,
     * and presentation disposers were installed, but only a live scope read can
     * confirm the tool restriction still hides native tools. Cold-restart and
     * recompose verification therefore checks both the entry and the visible
     * schema set before anything may be reported `bound`.
     * @param agent - the session Agent to verify.
     * @param projectId - when given, the entry must be bound to this project.
     */
    verify(agent: Agent, projectId?: string): {
        readonly ok: boolean;
        readonly failureCode?: 'devflow-mode-not-installed' | 'devflow-project-mismatch' | 'devflow-tool-restriction-missing';
    };
}
