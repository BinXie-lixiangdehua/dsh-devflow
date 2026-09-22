/**
 * DevFlow display layer: Chinese-facing role presentation. Machine
 * identifiers (role ids, agent ids, protocol fields, storage keys, event
 * types) stay English forever; this module is the only place that maps them
 * to display names and icons for CLI/Web/Canvas.
 * @module @xiaoxie-ide/dsh-devflow/display
 */
import type { AgentRoleId } from './protocol.ts';
/** One display presentation for a role. */
export interface RoleDisplay {
    /** Chinese display name. */
    readonly displayName: string;
    /** Emoji icon. */
    readonly icon: string;
}
/** Built-in role presentations. */
export declare const ROLE_DISPLAY: Readonly<Record<AgentRoleId, RoleDisplay>>;
/**
 * Per-employee display names, keyed by agent id.
 *
 * Role is not enough to name an employee: the architect sits on the `planner`
 * role (the assigned-role enum has no `architect`), so a role lookup would call
 * it 总指挥 — the same name as the commander — both in the panel and on the
 * canvas. A fixed employee without an entry here falls back to its agent id,
 * which is the honest display for a machine identifier.
 */
export declare const FIXED_AGENT_DISPLAY_NAMES: Readonly<Record<string, string>>;
/**
 * Resolve one orchestration agent's display name.
 * @param agentId - the machine agent id.
 * @returns the Chinese display name, or the id itself when unmapped.
 */
export declare function fixedAgentDisplayName(agentId: string): string;
/**
 * Render one role's display line, e.g. `🧠 产品规划师`.
 * @param role - the machine role id.
 * @returns the display line.
 */
export declare function displayRole(role: AgentRoleId): string;
