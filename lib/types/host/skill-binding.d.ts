/**
 * DevFlow Skill binding catalog, bundled fallback, and prompt assembly.
 *
 * Two kinds of Skill are bound to an employee:
 *
 *  * **generic** — a capability that is the same everywhere (code review,
 *    architecture advice, frontend engineering …). The package SHIPS a body for
 *    these, so a project that never vendored them still gets a complete
 *    employee prompt. The project always wins when it has its own copy.
 *  * **project-convention** — the project's OWN rules (`AGENTS.md`,
 *    `docs/defensive-patterns.md`, `docs/testing.md`). These are deliberately
 *    NOT bundled: shipping another team's conventions as if they were ours would
 *    be inventing project state. A missing one degrades WITH A SIGNAL instead.
 *
 * @module @xiaoxie-ide/dsh-devflow/skill-binding
 */
import type { OrchestrationAgent } from './types.ts';
import { type JournalWriter } from './journal.ts';
/** Which contract a bound Skill follows. */
export type DevFlowSkillKind = 'generic' | 'project-convention';
/** One Skill available to DevFlow agents. */
export interface DevFlowSkillDefinition {
    /** Stable Skill id stored on OrchestrationAgent. */
    readonly id: string;
    /** Session-workspace-relative path read FIRST. */
    readonly sourcePath: string;
    /** Whether the package ships a fallback body for this Skill. */
    readonly kind: DevFlowSkillKind;
    /** Package-relative path of the bundled fallback body (generic Skills only). */
    readonly bundledPath?: string;
}
/** Skill ids and their project paths, with the bundled-fallback split. */
export declare const DEVFLOW_SKILLS: Readonly<Record<string, DevFlowSkillDefinition>>;
/** Every Skill id the package ships a fallback body for, in catalog order. */
export declare const BUNDLED_SKILL_IDS: readonly string[];
/** Reject unknown Skill ids before an agent record is persisted or projected. */
export declare function validateAgentSkills(skills: readonly string[], displayPath: string): void;
/**
 * The installed package's own directory.
 *
 * Walked, not computed from a fixed `../` offset: the same source runs as
 * `src/host/*.ts` in the repository and as the bundled `lib/index.js` in an
 * install, and the two sit at different depths. The package manifest's `name`
 * is checked so a parent profile's `package.json` can never be mistaken for ours.
 * @returns absolute path of the directory holding this package's manifest.
 * @throws when no ancestor manifest names this package.
 */
export declare function devflowPackageRoot(): string;
/**
 * Read one Skill's bundled fallback body.
 *
 * A missing or unreadable file is reported as `undefined` rather than thrown:
 * the caller decides whether a missing fallback is fatal (generic) or just a
 * degradation, and it must be able to name the path in the diagnostic.
 * @param definition - catalog entry naming the bundled body.
 * @returns the body text, or undefined when it cannot be read.
 */
export declare function readBundledSkillBody(definition: DevFlowSkillDefinition): string | undefined;
/** Where one Skill's content came from. */
export type SkillOrigin = 'project' | 'bundled';
/** Skill content supplied to prompt assembly by the resolver. */
export interface ResolvedSkillContent {
    /** Skill id whose source was read. */
    readonly id: string;
    /** Complete Markdown content. */
    readonly content: string;
    /** Which copy was read; `project` always wins when both exist. */
    readonly origin: SkillOrigin;
}
/** One Skill that could not be supplied, with everything needed to act on it. */
export interface SkillDegradation {
    readonly id: string;
    readonly kind: DevFlowSkillKind;
    /** Session-workspace-relative path that was expected first. */
    readonly expectedPath: string;
    /** Package-relative fallback path, when the catalog declares one. */
    readonly bundledPath?: string;
    /** Whether this degradation may proceed WITHOUT the explicit opt-in. */
    readonly canContinue: boolean;
    /** One-line headline for the panel. */
    readonly headline: string;
    /** 缺什么 · 期望路径 · 怎么补 · 现在还能做什么 (S4). */
    readonly message: string;
}
/** The complete outcome of binding one employee's Skills. */
export interface SkillResolutionReport {
    readonly resolved: readonly ResolvedSkillContent[];
    readonly degradations: readonly SkillDegradation[];
}
/**
 * Build the four-part, actionable message for one missing Skill (S4).
 *
 * A blocked employee needs to know WHAT is missing, WHERE it was expected, HOW
 * to supply it, and WHAT IT CAN STILL DO — a message that only says "missing"
 * turns a recoverable gap into a dead end.
 * @param definition - the Skill that could not be resolved.
 * @param reason - why the fallback chain ended without content.
 * @param stillUsable - how many of this employee's Skills DID resolve.
 * @returns the headline and the full message.
 */
export declare function skillGapMessage(definition: DevFlowSkillDefinition, reason: 'project-and-bundled-missing' | 'project-missing', stillUsable: number): {
    readonly headline: string;
    readonly message: string;
};
/** Machine-readable + human-readable block appended to a degraded employee prompt. */
export declare function degradationSection(degradations: readonly SkillDegradation[]): string;
/**
 * Append bound Skill contents to an agent's configured prompt.
 *
 * The caller must pass the resolved contents in the agent's own binding order.
 * A SHORTER list is legal — that is what a signalled degradation produces (the
 * missing ids are appended by {@link degradationSection} instead) — but the
 * entries present must be a prefix-preserving subset of `agent.skills`, so a
 * reordered or foreign id can never silently attach the wrong text.
 * @param agent - agent whose configured prompt and Skill ids are authoritative.
 * @param resolved - resolved contents, in binding order, possibly missing some.
 * @returns the complete system prompt sent at every agent start.
 */
export declare function assembleAgentPrompt(agent: Pick<OrchestrationAgent, 'prompt' | 'skills'>, resolved: readonly ResolvedSkillContent[]): string;
/**
 * Everything {@link assembleSkillPrompt} needs from a store.
 *
 * Structural on purpose: `storage.ts` imports this module, so naming `DevFlowStore`
 * here would close the cycle, and a unit test can supply the resolver's report
 * directly instead of having to arrange a real packaging fault.
 */
export interface SkillPromptStore extends JournalWriter {
    readonly skillPolicy: {
        readonly allowMissingSkills: boolean;
    };
    resolveAgentSkillsDetailed(agent: Pick<OrchestrationAgent, 'skills'>): Promise<SkillResolutionReport>;
}
/**
 * Resolve an employee's Skills, journal every degradation, and assemble its prompt.
 *
 * The journal write happens BEFORE the decision to continue, so a degradation is
 * auditable even when the dispatch is then refused (or fails later for an
 * unrelated reason). The default policy refuses a missing GENERIC Skill (a
 * packaging fault); a missing project convention only degrades, because a project
 * that defines no such rule is a legitimate state — and the employee is then told
 * what is missing, where it was expected, how to supply it, and what it can still
 * do (S4), never silently.
 * @param store - the store that resolves the Skills and receives the journal rows.
 * @param agent - the employee whose prompt is being assembled.
 * @param context - execution identity carried by the journal rows.
 * @returns the complete prompt, degradation section included.
 * @throws when a gap requires the explicit opt-in and the policy does not grant it.
 */
export declare function assembleSkillPrompt(store: SkillPromptStore, agent: Pick<OrchestrationAgent, 'prompt' | 'skills'>, context?: {
    readonly executionId?: string;
    readonly taskId?: string | null;
}): Promise<string>;
