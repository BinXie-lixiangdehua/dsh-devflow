/**
 * DevFlow Skill binding catalog and prompt assembly. Skill text is supplied
 * by the caller after reading the catalog's repository file references.
 * @module @xiaoxie-ide/dsh-devflow/skill-binding
 */
import type { OrchestrationAgent } from './types.ts';
/** One repository-backed Skill available to DevFlow agents. */
export interface DevFlowSkillDefinition {
    /** Stable Skill id stored on OrchestrationAgent. */
    readonly id: string;
    /** Repository-relative Markdown source path. */
    readonly sourcePath: string;
}
/** Skill ids and existing repository files approved for permanent prompt injection. */
export declare const DEVFLOW_SKILLS: Readonly<Record<string, DevFlowSkillDefinition>>;
/** Reject unknown Skill ids before an agent record is persisted or projected. */
export declare function validateAgentSkills(skills: readonly string[], displayPath: string): void;
/** Skill content supplied to prompt assembly by the repository-file loader. */
export interface ResolvedSkillContent {
    /** Skill id whose source was read. */
    readonly id: string;
    /** Complete Markdown content read from the catalog sourcePath. */
    readonly content: string;
}
/**
 * Append bound Skill contents to an agent's configured prompt. The caller
 * must resolve every id in agent.skills and preserve that order.
 * @param agent - agent whose configured prompt and Skill ids are authoritative.
 * @param resolved - repository file contents corresponding to agent.skills.
 * @returns the complete system prompt sent at every agent start.
 */
export declare function assembleAgentPrompt(agent: Pick<OrchestrationAgent, 'prompt' | 'skills'>, resolved: readonly ResolvedSkillContent[]): string;
