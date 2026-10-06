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
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordDevFlowChange } from "./journal.js";
/** Skill ids and their project paths, with the bundled-fallback split. */
export const DEVFLOW_SKILLS = {
    // ── project-convention: the project's own rules; never bundled ─────────────
    'repository-conventions': {
        id: 'repository-conventions', sourcePath: 'AGENTS.md', kind: 'project-convention',
    },
    'defensive-patterns': {
        id: 'defensive-patterns', sourcePath: 'docs/defensive-patterns.md', kind: 'project-convention',
    },
    'testing-policy': {
        id: 'testing-policy', sourcePath: 'docs/testing.md', kind: 'project-convention',
    },
    // ── generic: shipped with the package, project copy wins ──────────────────
    // Bodies are verbatim upstream text; provenance and licences are recorded in
    // `skills/THIRD_PARTY_NOTICES.md` and in the round report. Nothing is rewritten.
    'pre-push-checks': {
        id: 'pre-push-checks', sourcePath: '.agents/skills/dsh-pre-push-checks/SKILL.md',
        kind: 'generic', bundledPath: 'skills/pre-push-checks/SKILL.md',
    },
    'code-review': {
        id: 'code-review', sourcePath: '.agents/skills/dsh-code-review/SKILL.md',
        kind: 'generic', bundledPath: 'skills/code-review/SKILL.md',
    },
    'find-simplifications': {
        id: 'find-simplifications', sourcePath: '.agents/skills/dsh-find-simplifications/SKILL.md',
        kind: 'generic', bundledPath: 'skills/find-simplifications/SKILL.md',
    },
    'archify': {
        id: 'archify', sourcePath: '.agents/skills/archify/SKILL.md',
        kind: 'generic', bundledPath: 'skills/archify/SKILL.md',
    },
    'advise-project-approach': {
        id: 'advise-project-approach', sourcePath: '.agents/skills/advise-project-approach/SKILL.md',
        kind: 'generic', bundledPath: 'skills/advise-project-approach/SKILL.md',
    },
    'api-and-interface-design': {
        id: 'api-and-interface-design', sourcePath: '.agents/skills/api-and-interface-design/SKILL.md',
        kind: 'generic', bundledPath: 'skills/api-and-interface-design/SKILL.md',
    },
    'documentation-and-adrs': {
        id: 'documentation-and-adrs', sourcePath: '.agents/skills/documentation-and-adrs/SKILL.md',
        kind: 'generic', bundledPath: 'skills/documentation-and-adrs/SKILL.md',
    },
    'frontend-ui-engineering': {
        id: 'frontend-ui-engineering', sourcePath: '.agents/skills/frontend-ui-engineering/SKILL.md',
        kind: 'generic', bundledPath: 'skills/frontend-ui-engineering/SKILL.md',
    },
    'browser-testing-with-devtools': {
        id: 'browser-testing-with-devtools', sourcePath: '.agents/skills/browser-testing-with-devtools/SKILL.md',
        kind: 'generic', bundledPath: 'skills/browser-testing-with-devtools/SKILL.md',
    },
};
/** Every Skill id the package ships a fallback body for, in catalog order. */
export const BUNDLED_SKILL_IDS = Object.values(DEVFLOW_SKILLS)
    .filter(definition => definition.bundledPath !== undefined)
    .map(definition => definition.id);
/** Reject unknown Skill ids before an agent record is persisted or projected. */
export function validateAgentSkills(skills, displayPath) {
    for (const skillId of skills) {
        if (!(skillId in DEVFLOW_SKILLS)) {
            throw new Error(`devflow: unknown skill id ${JSON.stringify(skillId)} in ${displayPath}`);
        }
    }
}
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
export function devflowPackageRoot() {
    let directory = dirname(fileURLToPath(import.meta.url));
    for (let depth = 0; depth < 8; depth += 1) {
        const manifest = join(directory, 'package.json');
        if (existsSync(manifest)) {
            try {
                const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
                if (parsed.name === '@xiaoxie-ide/dsh-devflow')
                    return directory;
            }
            catch { /* an unreadable candidate is not ours to claim; keep walking */ }
        }
        const parent = dirname(directory);
        if (parent === directory)
            break;
        directory = parent;
    }
    throw new Error('devflow: cannot locate the @xiaoxie-ide/dsh-devflow package root from this module');
}
/**
 * Read one Skill's bundled fallback body.
 *
 * A missing or unreadable file is reported as `undefined` rather than thrown:
 * the caller decides whether a missing fallback is fatal (generic) or just a
 * degradation, and it must be able to name the path in the diagnostic.
 * @param definition - catalog entry naming the bundled body.
 * @returns the body text, or undefined when it cannot be read.
 */
export function readBundledSkillBody(definition) {
    if (definition.bundledPath === undefined)
        return undefined;
    try {
        const file = join(devflowPackageRoot(), definition.bundledPath);
        if (!existsSync(file))
            return undefined;
        return readFileSync(file, 'utf8');
    }
    catch {
        return undefined;
    }
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
export function skillGapMessage(definition, reason, stillUsable) {
    const isConvention = definition.kind === 'project-convention';
    const headline = isConvention
        ? `技能缺失：${definition.id}（项目约定类，未随包内置）`
        : `技能缺失：${definition.id}（通用技能，内置副本也读不到）`;
    const what = isConvention
        ? `该员工绑定的 Skill「${definition.id}」在本项目里没有对应文件，且这类技能按设计不随插件内置`
        : `项目里没有该文件，插件包内的内置副本也读不到`;
    const expected = definition.bundledPath === undefined
        ? `${definition.sourcePath}（相对当前会话工作区）`
        : `优先 ${definition.sourcePath}（相对当前会话工作区）；兜底 <插件包>/${definition.bundledPath}`;
    const how = isConvention
        ? `在项目里创建 ${definition.sourcePath}（内容按你们团队的约定写），或把该员工 Skills 里的「${definition.id}」去掉`
        : `重新安装/升级插件（内置副本缺失通常是打包问题），或在项目里放一份 ${definition.sourcePath}`;
    const still = reason === 'project-and-bundled-missing'
        ? `本次派发默认**不继续**；确认知情后可用降级开关放行。该员工仍可解析其余 ${stillUsable} 条技能`
        : `本次派发**已继续**，但该员工没有这条项目约定；它仍可用其余 ${stillUsable} 条技能与全部已挂载工具`;
    return { headline, message: [headline, `· 缺什么：${what}`, `· 期望路径：${expected}`, `· 怎么补：${how}`, `· 现在还能做什么：${still}`].join('\n') };
}
/** Machine-readable + human-readable block appended to a degraded employee prompt. */
export function degradationSection(degradations) {
    if (degradations.length === 0)
        return '';
    return [
        '<!-- DEVFLOW SKILL DEGRADATION START -->',
        '以下是本次派发前**未能附加**的技能（其余技能与工具均已正常附加）：',
        '',
        degradations.map(item => item.message).join('\n\n'),
        '',
        '若缺少的约定影响本次任务，请按上面的"怎么补"处理，或声明 `outcome: blocked` 并说明缺哪一条。',
        '<!-- DEVFLOW SKILL DEGRADATION END -->',
    ].join('\n');
}
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
export function assembleAgentPrompt(agent, resolved) {
    validateAgentSkills(agent.skills, 'prompt assembly');
    const ids = resolved.map(item => item.id);
    const expected = agent.skills.filter(id => ids.includes(id));
    if (ids.length !== expected.length || expected.some((id, index) => id !== ids[index])) {
        throw new Error('devflow: resolved Skill contents do not match the agent Skill binding order');
    }
    if (resolved.length === 0)
        return agent.prompt;
    const sections = resolved.map(item => [
        `<!-- DEVFLOW SKILL START: ${item.id} -->`,
        item.content.trim(),
        `<!-- DEVFLOW SKILL END: ${item.id} -->`,
    ].join('\n'));
    return [agent.prompt.trim(), ...sections].join('\n\n');
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
export async function assembleSkillPrompt(store, agent, context = {}) {
    const report = await store.resolveAgentSkillsDetailed(agent);
    for (const gap of report.degradations) {
        await recordDevFlowChange(store, 'devflow/skill/degraded', {
            skillId: gap.id,
            kind: gap.kind,
            expectedPath: gap.expectedPath,
            bundledPath: gap.bundledPath ?? null,
            canContinue: gap.canContinue,
            acceptedByPolicy: !gap.canContinue && store.skillPolicy.allowMissingSkills,
            headline: gap.headline,
            executionId: context.executionId ?? null,
            taskId: context.taskId ?? null,
        });
    }
    const blocking = report.degradations.find(gap => !gap.canContinue);
    if (blocking !== undefined && !store.skillPolicy.allowMissingSkills) {
        throw new Error(`devflow: ${blocking.message}`);
    }
    const base = assembleAgentPrompt(agent, report.resolved);
    const section = degradationSection(report.degradations);
    return section === '' ? base : `${base}\n\n${section}`;
}
