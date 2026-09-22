/**
 * DevFlow Skill binding catalog and prompt assembly. Skill text is supplied
 * by the caller after reading the catalog's repository file references.
 * @module @xiaoxie-ide/dsh-devflow/skill-binding
 */

import type { OrchestrationAgent } from './types.ts'

/** One repository-backed Skill available to DevFlow agents. */
export interface DevFlowSkillDefinition {
  /** Stable Skill id stored on OrchestrationAgent. */
  readonly id: string
  /** Repository-relative Markdown source path. */
  readonly sourcePath: string
}

/** Skill ids and existing repository files approved for permanent prompt injection. */
export const DEVFLOW_SKILLS: Readonly<Record<string, DevFlowSkillDefinition>> = {
  'repository-conventions': { id: 'repository-conventions', sourcePath: 'AGENTS.md' },
  'defensive-patterns': { id: 'defensive-patterns', sourcePath: 'docs/defensive-patterns.md' },
  'testing-policy': { id: 'testing-policy', sourcePath: 'docs/testing.md' },
  'pre-push-checks': { id: 'pre-push-checks', sourcePath: '.agents/skills/dsh-pre-push-checks/SKILL.md' },
  'code-review': { id: 'code-review', sourcePath: '.agents/skills/dsh-code-review/SKILL.md' },
  'find-simplifications': { id: 'find-simplifications', sourcePath: '.agents/skills/dsh-find-simplifications/SKILL.md' },
  // Architect skills, vendored under the agent skill root this deployment's
  // filesystem resolves against (see `docs/` step-8 report for provenance and
  // pinned commits). Each directory is a verbatim upstream skill body: the
  // binding names its entry file and nothing in the directory is rewritten.
  'archify': { id: 'archify', sourcePath: '.agents/skills/archify/SKILL.md' },
  'advise-project-approach': { id: 'advise-project-approach', sourcePath: '.agents/skills/advise-project-approach/SKILL.md' },
  'api-and-interface-design': { id: 'api-and-interface-design', sourcePath: '.agents/skills/api-and-interface-design/SKILL.md' },
  'documentation-and-adrs': { id: 'documentation-and-adrs', sourcePath: '.agents/skills/documentation-and-adrs/SKILL.md' },
  // Frontend-engineer skills, same root and same vendoring rule.
  'frontend-ui-engineering': { id: 'frontend-ui-engineering', sourcePath: '.agents/skills/frontend-ui-engineering/SKILL.md' },
  'browser-testing-with-devtools': { id: 'browser-testing-with-devtools', sourcePath: '.agents/skills/browser-testing-with-devtools/SKILL.md' },
}

/** Reject unknown Skill ids before an agent record is persisted or projected. */
export function validateAgentSkills(skills: readonly string[], displayPath: string): void {
  for (const skillId of skills) {
    if (!(skillId in DEVFLOW_SKILLS)) {
      throw new Error(`devflow: unknown skill id ${JSON.stringify(skillId)} in ${displayPath}`)
    }
  }
}

/** Skill content supplied to prompt assembly by the repository-file loader. */
export interface ResolvedSkillContent {
  /** Skill id whose source was read. */
  readonly id: string
  /** Complete Markdown content read from the catalog sourcePath. */
  readonly content: string
}

/**
 * Append bound Skill contents to an agent's configured prompt. The caller
 * must resolve every id in agent.skills and preserve that order.
 * @param agent - agent whose configured prompt and Skill ids are authoritative.
 * @param resolved - repository file contents corresponding to agent.skills.
 * @returns the complete system prompt sent at every agent start.
 */
export function assembleAgentPrompt(
  agent: Pick<OrchestrationAgent, 'prompt' | 'skills'>,
  resolved: readonly ResolvedSkillContent[],
): string {
  validateAgentSkills(agent.skills, 'prompt assembly')
  if (resolved.length !== agent.skills.length || resolved.some((item, index) => item.id !== agent.skills[index])) {
    throw new Error('devflow: resolved Skill contents do not match the agent Skill binding order')
  }
  if (resolved.length === 0) return agent.prompt
  const sections = resolved.map(item => [
    `<!-- DEVFLOW SKILL START: ${item.id} -->`,
    item.content.trim(),
    `<!-- DEVFLOW SKILL END: ${item.id} -->`,
  ].join('\n'))
  return [agent.prompt.trim(), ...sections].join('\n\n')
}
