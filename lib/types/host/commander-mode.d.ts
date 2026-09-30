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
     * Map presence alone is not proof, and neither is the visible schema set: the
     * entry records that persona, tools, guard, and presentation disposers were
     * installed, but only evaluating the ARMED GUARD can confirm the seat still
     * refuses what it must.
     *
     * The visible-tool assertion this method used to carry ("every visible name is
     * allow-listed", later "no forbidden name is visible") is NOT satisfiable and
     * therefore cannot be the criterion. `tools.restrict()` masks only the
     * INHERITED surface — a scope's own registrations stay visible
     * unconditionally (`@deepseek-ai/dsh-tools` `view()`: "The scope's own
     * registrations last, shadowing an inherited name and OUTSIDE the filter
     * above"). A MEASURED sandbox activation (2026-10-01) showed exactly two
     * deny-listed names still visible after `restrict({ allow })` —
     * `send_message` and `list_agents`, both registered into the Agent's own
     * scope by the profile's Agent-Team rows — so every activation was refused
     * with {@link DEVFLOW_ACTIVATION_CODES.verificationFailed}, which exits
     * Commander and silently downgrades the session to the native persona. That
     * is the bug this criterion change fixes; the guarantee itself was never
     * lost, because it moved to the chain-wide execution guard.
     *
     * What is asserted instead is functional, not structural: the exact guard
     * value registered by {@link enter} must still deny EVERY name on
     * {@link COMMANDER_FORBIDDEN_TOOL_NAMES} and must not deny a reviewed
     * Commander tool. A guard that was never armed, was disarmed, or lost its
     * deny list fails the activation closed.
     * @param agent - the session Agent to verify.
     * @param projectId - when given, the entry must be bound to this project.
     */
    verify(agent: Agent, projectId?: string): {
        readonly ok: boolean;
        readonly failureCode?: 'devflow-mode-not-installed' | 'devflow-project-mismatch' | 'devflow-tool-restriction-missing';
    };
}
