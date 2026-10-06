/**
 * Employee Skills shipped with the package (S1–S4, S6).
 *
 * These run the REAL resolver over a REAL store and a REAL temporary project, so
 * "no `.agents/skills` in the project ⇒ the employee is still complete" is proven
 * by executing the code path a dispatch executes, not by reading the catalog.
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { DevFlowStore } from '../src/host/storage.ts'
import {
  BUNDLED_SKILL_IDS,
  DEVFLOW_SKILLS,
  assembleSkillPrompt,
  degradationSection,
  readBundledSkillBody,
  skillGapMessage,
  type SkillPromptStore,
  type SkillResolutionReport,
} from '../src/host/skill-binding.ts'
import { blockedHeadline, blockedReportFrom, classifyCapabilityGap } from '../src/host/blocked-report.ts'

/** The real fixed-employee bindings (src/host/default-agents.ts). */
const ARCHITECT = ['archify', 'advise-project-approach', 'api-and-interface-design', 'documentation-and-adrs']
const BACKEND = ['repository-conventions', 'defensive-patterns', 'testing-policy', 'pre-push-checks']
const CONVENTIONS = ['repository-conventions', 'defensive-patterns', 'testing-policy']

/** A store over a temporary project root, capturing the journal types it writes. */
async function withProject(
  files: Readonly<Record<string, string>>,
  body: (context: { root: string; store: DevFlowStore; journaled: readonly string[] }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'devflow-skills-'))
  try {
    for (const [relative, content] of Object.entries(files)) {
      const target = join(root, relative)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content, 'utf8')
    }
    const journaled: string[] = []
    const store = new DevFlowStore(
      new LocalFileSystem(new Context(), { cwd: root, diffBasisMaxBytes: 1024 * 1024 }),
      './.devflow',
      (_path, _sequence, record) => { if (record !== undefined) journaled.push(record.type) },
    )
    await body({ root, store, journaled })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('S1 — 通用技能随包内置：干净项目里不再缺失', () => {
  it('每个通用技能都真的带正文（打包守卫）', () => {
    expect(BUNDLED_SKILL_IDS).toHaveLength(9)
    for (const id of BUNDLED_SKILL_IDS) {
      const definition = DEVFLOW_SKILLS[id]
      expect(definition, `catalog 缺 ${id}`).toBeDefined()
      expect(definition!.kind).toBe('generic')
      const body = readBundledSkillBody(definition!)
      expect(body, `${id} 的内置正文读不到`).toBeTypeOf('string')
      expect((body ?? '').trim().length).toBeGreaterThan(100)
    }
  })

  it('项目里没有 .agents/skills ⇒ 9 个通用技能全部可用，且全部来自内置副本，零降级', async () => {
    await withProject({}, async ({ store }) => {
      const report = await store.resolveAgentSkillsDetailed({ skills: [...BUNDLED_SKILL_IDS] })
      expect(report.degradations).toEqual([])
      expect(report.resolved.map(item => item.id)).toEqual([...BUNDLED_SKILL_IDS])
      expect(report.resolved.every(item => item.origin === 'bundled')).toBe(true)
    })
  })

  it('架构师（4 个通用技能）在干净项目里提示词完整、不中止', async () => {
    await withProject({}, async ({ store }) => {
      const prompt = await assembleSkillPrompt(store, { prompt: 'BASE', skills: [...ARCHITECT] }, {})
      expect(prompt).toContain('BASE')
      for (const id of ARCHITECT) expect(prompt).toContain(`DEVFLOW SKILL START: ${id}`)
      expect(prompt).not.toContain('DEVFLOW SKILL DEGRADATION START')
    })
  })
})

describe('S2 — 项目优先：项目里的同名文件必须赢（内置只是兜底）', () => {
  it('项目放一份内容不同的同名 SKILL.md ⇒ 用的是项目那份', async () => {
    const projectBody = '# 本项目自己的 archify 约定\n\n这条正文只存在于项目里，内置副本里没有。\n'
    await withProject({ '.agents/skills/archify/SKILL.md': projectBody }, async ({ store }) => {
      const bundled = readBundledSkillBody(DEVFLOW_SKILLS['archify']!)
      expect(bundled).toBeDefined()
      // 先证明这个对照真的"内容不同"，否则用例会假绿。
      expect(bundled).not.toContain('这条正文只存在于项目里')

      const report = await store.resolveAgentSkillsDetailed({ skills: ['archify'] })
      expect(report.degradations).toEqual([])
      expect(report.resolved).toHaveLength(1)
      expect(report.resolved[0]!.origin).toBe('project')
      expect(report.resolved[0]!.content).toBe(projectBody)

      const prompt = await assembleSkillPrompt(store, { prompt: 'BASE', skills: ['archify'] }, {})
      expect(prompt).toContain('这条正文只存在于项目里')
      expect(prompt).not.toContain(bundled!.slice(0, 60))
    })
  })

  it('项目里没有时立刻回落到内置副本（两种来源可分辨）', async () => {
    await withProject({}, async ({ store }) => {
      const report = await store.resolveAgentSkillsDetailed({ skills: ['archify'] })
      expect(report.resolved[0]!.origin).toBe('bundled')
    })
  })
})

describe('S3 — 项目约定类不内置：缺失时有信号降级，绝不中止', () => {
  it('后端员工（3 约定 + 1 通用）在干净项目里：通用来自内置，3 条约定各留一条降级', async () => {
    await withProject({}, async ({ store, journaled }) => {
      const report = await store.resolveAgentSkillsDetailed({ skills: [...BACKEND] })
      expect(report.resolved.map(item => item.id)).toEqual(['pre-push-checks'])
      expect(report.resolved[0]!.origin).toBe('bundled')
      expect(report.degradations.map(item => item.id)).toEqual([...CONVENTIONS])
      // 约定类缺失是合法状态 ⇒ 允许继续；通用类缺内置正文才是打包故障。
      expect(report.degradations.every(item => item.canContinue)).toBe(true)

      const prompt = await assembleSkillPrompt(store, { prompt: 'BASE', skills: [...BACKEND] }, { executionId: 'exec-1' })
      expect(prompt).toContain('DEVFLOW SKILL DEGRADATION START')
      expect(prompt).toContain('DEVFLOW SKILL START: pre-push-checks')
      // 台账留痕：一条降级一条 journal。
      expect(journaled.filter(type => type === 'devflow/skill/degraded')).toHaveLength(3)
    })
  })

  it('降级段落四要素齐全（缺什么 · 期望路径 · 怎么补 · 现在还能做什么）', async () => {
    const { message } = skillGapMessage(DEVFLOW_SKILLS['testing-policy']!, 'project-missing', 1)
    for (const part of ['缺什么', '期望路径', '怎么补', '现在还能做什么']) expect(message).toContain(part)
    expect(message).toContain('docs/testing.md')
    expect(degradationSection([])).toBe('')
  })
})

describe('S4 — 技能 / 工具 / 权限三类可分辨，且文案可操作', () => {
  it('三类分类互不混淆', () => {
    expect(classifyCapabilityGap('缺少 skill：archify 技能文件读不到')).toBe('skill')
    expect(classifyCapabilityGap('本会话没有 write 工具')).toBe('tool')
    expect(classifyCapabilityGap('没有写权限，被拒绝了')).toBe('permission')
    expect(classifyCapabilityGap('状态正常')).toBe('unstated')
  })

  it('技能缺失的标题与"缺什么/期望路径/怎么补/还能做什么"都在', () => {
    const report = blockedReportFrom({
      taskId: 'task-1', agentId: 'architect', detail: '缺少 skill：.agents/skills/archify/SKILL.md 读不到',
    })
    expect(report.gapKind).toBe('skill')
    // 必须报出技能名，而不是类别词 "skill"（否则标题会变成"缺少技能「skill」"）。
    expect(report.missing).toBe('archify')
    expect(blockedHeadline(report, '架构师')).toBe('架构师缺少技能「archify」，无法继续本次派发')
    const { message } = skillGapMessage(DEVFLOW_SKILLS['archify']!, 'project-missing', 3)
    expect(message).toContain('.agents/skills/archify/SKILL.md')
    expect(message).toContain('仍可用其余 3 条技能')
  })
})

describe('S6 — 显式降级开关：默认关，开了要留痕', () => {
  const genericGap: SkillResolutionReport = {
    resolved: [],
    degradations: [{
      id: 'archify', kind: 'generic', expectedPath: '.agents/skills/archify/SKILL.md',
      bundledPath: 'skills/archify/SKILL.md', canContinue: false,
      headline: 'x', message: 'y',
    }],
  }
  /** A store stub: the packaging fault is arranged as data, not by breaking the real package. */
  function stub(allowMissingSkills: boolean, journaled: string[]): SkillPromptStore {
    return {
      skillPolicy: { allowMissingSkills },
      resolveAgentSkillsDetailed: async () => genericGap,
      appendJournal: async (type: string) => { journaled.push(type); return {} as never },
    } as unknown as SkillPromptStore
  }

  it('默认策略：通用技能缺内置正文 ⇒ 直接拒绝（不静默继续）', async () => {
    const journaled: string[] = []
    await expect(assembleSkillPrompt(stub(false, journaled), { prompt: 'B', skills: ['archify'] }, {}))
      .rejects.toThrow(/devflow: /)
    // 拒绝之前也已经留痕：台账不因为"没继续"而少一条。
    expect(journaled).toEqual(['devflow/skill/degraded'])
  })

  it('显式打开后放行，且 journal 明确记下"这是被策略放行的"', async () => {
    const rows: { type: string; data: unknown }[] = []
    const store = {
      skillPolicy: { allowMissingSkills: true },
      resolveAgentSkillsDetailed: async () => genericGap,
      appendJournal: async (type: string, data: unknown) => { rows.push({ type, data }); return {} as never },
    } as unknown as SkillPromptStore
    const prompt = await assembleSkillPrompt(store, { prompt: 'B', skills: ['archify'] }, {})
    expect(prompt).toContain('DEVFLOW SKILL DEGRADATION START')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.type).toBe('devflow/skill/degraded')
    expect((rows[0]!.data as { acceptedByPolicy?: unknown }).acceptedByPolicy).toBe(true)
  })

  it('store 默认策略 = 关；配置层确实暴露了这个键', async () => {
    // `src/host/index.ts` cannot be value-imported here: it transitively pulls
    // `client-bridge.ts` → `@deepseek-ai/dsh-typert-protocol`, which this environment
    // cannot parse (pre-existing, unrelated to this round). The store default is the
    // behaviour that matters; the config key is asserted from the module text.
    await withProject({}, async ({ store }) => {
      expect(store.skillPolicy.allowMissingSkills).toBe(false)
    })
    const source = await readFile(new URL('../src/host/index.ts', import.meta.url), 'utf8')
    expect(source).toContain('allowMissingSkills?: boolean')
    expect(source).toContain('config is { devflowDir?, stateDir?, sessionActivation?, allowMissingSkills? }')
  })
})
