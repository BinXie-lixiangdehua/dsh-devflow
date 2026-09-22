/**
 * 段四 · 激活失败提示文案可读化（client）——真实组件渲染取证。
 *
 * 本用例不测"内部编码还在不在"这一句话，而是测**主次关系**：
 *  - 主文案必须是可读结论（人话），且**不含内部编码**；
 *  - `devflow-activation-verification-failed` 必须仍在 DOM 里（可观测性红线），
 *    但只能出现在次要小字里（`devflow-activation-failure-code`）；
 *  - 「已自动重试成功」只有在 Host 的**已验证绑定姿态**（`activation === 'bound'`）
 *    为真时才允许出现；未被验证恢复的会话**不得**被写成已恢复。
 *
 * 渲染走真的 `DevFlowCanvas`（`renderToStaticMarkup`），只把三个官方 hook 换成
 * 取值函数 —— 与 `tests/client-canvas.spec.tsx` 同一套最小替身。
 *
 * 用例最后把两段 DOM 原文打印到 stdout（`[BEFORE/AFTER BANNER DOM]`），
 * 供执行者直接引用为"改后真实 DOM 原文"证据。
 */
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CurrentSessionSources } from '../src/client/tool-activity.ts'
import { DevFlowCanvas } from '../src/client/DevFlowCanvas.tsx'
import type { DevFlowClientActivationFailure, DevFlowClientSnapshot } from '../src/contract.ts'
import type { DevFlowClientLoadState, DevFlowInspectorTab } from '../src/client/store.ts'

const reactState = vi.hoisted(() => ({ stateIndex: 0, tabSlot: 4, rosterSlot: 9 }))

vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useState: <T,>(initial: T | (() => T)) => {
      const index = reactState.stateIndex++
      const resolved = typeof initial === 'function' ? (initial as () => T)() : initial
      if (index === reactState.tabSlot) return ['flow' as DevFlowInspectorTab, vi.fn()]
      if (index === reactState.rosterSlot) return [true, vi.fn()]
      return [resolved, vi.fn()]
    },
  }
})

const t = (key: string) => key
const NOW = Date.parse('2026-09-18T17:16:22.491Z')

/** The refusal the real panel showed: 切换 preset 被实时校验拒绝，第 3 次尝试。 */
const FAILURE: DevFlowClientActivationFailure = {
  code: 'devflow-activation-verification-failed',
  phase: 'recompose',
  attempts: 3,
  reason: 'DevFlow 激活未通过实时校验（工具集尚未结算，或工具集不符）。',
  at: '2026-09-18T17:16:22.491Z',
}

const base: DevFlowClientSnapshot = {
  version: 1,
  generatedAt: '2026-09-18T17:16:23.000Z',
  session: {
    id: 'session-a',
    commanderMode: 'commander',
    presetId: 'devflow',
    activation: 'bound',
    activationError: null,
    verifiedAt: '2026-09-18T17:16:23.000Z',
    lastActivationFailure: FAILURE,
  },
  paused: false,
  project: { id: 'project-a', name: 'Migration', goal: 'Ship the bridge', currentStage: 'M7' },
  agents: [
    { id: 'commander', role: 'planner', kind: 'fixed', status: 'active', displayName: '总指挥', model: 'deepseek-chat', skills: [], capabilities: ['task-planning'], delegationDepth: 0 },
  ],
  tasks: [],
  phases: [],
  assignments: [],
  executions: [],
  results: [],
  reports: [],
  attempts: [],
  failures: [],
  decisions: [],
  decisionRequests: [],
  blocked: [],
}

function conversation(): CurrentSessionSources {
  return {
    session: { sessionId: 'session-a', running: true, subagent: null, openState: 'open', hasMore: false },
    chat: { order: [], nodes: { get: () => undefined, values: () => [] } },
  } as unknown as CurrentSessionSources
}

function render(snapshot: DevFlowClientSnapshot): string {
  reactState.stateIndex = 0
  const sources = conversation()
  const state: DevFlowClientLoadState = { phase: 'ready', snapshot, error: null }
  return renderToStaticMarkup(createElement(DevFlowCanvas, {
    sessionId: snapshot.session.id,
    useSession: <S,>(selector: (value: CurrentSessionSources['session']) => S) => selector(sources.session),
    useChat: <S,>(selector: (value: CurrentSessionSources['chat']) => S) => selector(sources.chat),
    useDevflow: <S,>(selector: (value: DevFlowClientLoadState) => S) => selector(state),
    useAudit: <S,>(selector: (value: unknown) => S) => selector({ phase: 'ready', filter: { kind: 'project' }, page: null, error: null }),
    refresh: async () => undefined,
    getInspectorTab: () => 'flow' as DevFlowInspectorTab,
    setInspectorTab: () => undefined,
    now: NOW,
    audit: { ensure: async () => undefined, refresh: async () => undefined, loadMore: async () => undefined, retry: async () => undefined },
    t,
  } as never))
}

/** Cut the activation banner out of the full panel markup, in source order. */
function banner(html: string): string {
  const start = html.indexOf('devflow-activation-failure"')
  if (start < 0) return ''
  const open = html.lastIndexOf('<div', start)
  const close = html.indexOf('</div>', start)
  return html.slice(open, close + '</div>'.length)
}

/** The readable headline of the banner: the first span's text, no tags. */
function headline(html: string): string {
  const match = /<span class="devflow-activation-failure-head">([^<]*)<\/span>/.exec(html)
  return match?.[1] ?? ''
}

/**
 * 改前的渲染器（逐字保留 `git show HEAD:src/client/DevFlowCanvas.tsx` 的主文案一行），
 * 只用来产出"前"对照，不参与任何断言。
 */
function legacyHeadline(failure: DevFlowClientActivationFailure): string {
  return `激活失败 ${failure.code}`
}

describe('激活失败横幅：主文案是人话，内部编码降级但不删除', () => {
  it('把可读结论写成主文案，并把内部编码降级为次要小字（仍留在 DOM 里）', () => {
    const html = render(base)
    const dom = banner(html)
    expect(dom).not.toBe('')

    // 主文案：人话，且绝不含内部编码。
    const head = headline(html)
    expect(head).toBe('DevFlow 激活未通过，重试后已恢复绑定（不影响当前会话）')
    expect(head).not.toContain('devflow-')

    // 红线：编码没有被删除 —— 仍在正文里、仍可复制引用，只是降级为次要小字。
    expect(dom).toContain('devflow-activation-failure-code')
    expect(dom).toContain('内部编码 〈devflow-activation-verification-failed〉')
    expect(dom).toContain('title="内部编码：devflow-activation-verification-failed"')
    expect(dom).toContain('data-activation-code="devflow-activation-verification-failed"')
    // 编码出现在主文案之前 ⇒ 不是主体信息。
    expect(dom.indexOf('devflow-activation-failure-code')).toBeGreaterThan(dom.indexOf('devflow-activation-failure-head'))

    // 可读原因与可读阶段仍在（次要行），次数/时刻如实体现在 meta 里。
    expect(dom).toContain('切换 preset')
    expect(dom).toContain('已自动重试 2 次')
    expect(dom).toContain('3 次尝试')
    expect(dom).toContain('2026-09-18T17:16:22.491Z')
    expect(dom).toContain('data-activation-recovered="true"')
    // 三层结构：结论 → 编码 → 事实。编码只以 data 属性 + 次要小字（正文与 `title`）
    // 出现，原因句由结论承担，不重复第二遍、也不第三遍。
    const codeMentions = [...dom.matchAll(/devflow-activation-verification-failed/g)].length
    expect(codeMentions).toBe(3)

    // 前后对照：改前主文案就是编码本身，改后同样的数据读成一句人话。
    expect(legacyHeadline(FAILURE)).toBe('激活失败 devflow-activation-verification-failed')
    expect(head).not.toBe(legacyHeadline(FAILURE))

    process.stdout.write(`\n[BEFORE HEADLINE] ${legacyHeadline(FAILURE)}\n`)
    process.stdout.write(`[AFTER BANNER DOM] ${dom}\n`)
  })

  it('未被验证恢复的会话不许写成"已重试成功"：只有 Host 报 bound 才出恢复结论', () => {
    for (const activation of ['error', 'unbound'] as const) {
      const html = render({ ...base, session: { ...base.session, activation, activationError: null } })
      const dom = banner(html)
      const head = headline(html)
      process.stdout.write(`[STANDING BANNER DOM ${activation}] ${dom}\n`)
      expect(head).toBe('DevFlow 激活未通过（原因：DevFlow 激活未通过实时校验（工具集尚未结算，或工具集不符）。）')
      expect(head).not.toContain('恢复')
      expect(head).not.toContain('重试后')
      // 拒绝仍然成立时，可读原因必须出现在主文案里（不是只藏在次要行）。
      expect(head).toContain('原因：')
      expect(head).toContain('DevFlow 激活未通过实时校验（工具集尚未结算，或工具集不符）。')
      expect(dom).toContain('data-activation-recovered="false"')
      // 编码仍在，仍然只占次要位置。
      expect(dom).toContain('devflow-activation-verification-failed')
      // 首次尝试即被拒绝时不许说"已自动重试"。
      const firstTry = render({
        ...base,
        session: { ...base.session, activation, lastActivationFailure: { ...FAILURE, attempts: 1 } },
      })
      expect(firstTry).toContain('首次尝试即被拒绝')
      expect(banner(firstTry)).not.toContain('已自动重试')
    }
  })

  it('没有拒绝记录时不渲染横幅：老快照缺该字段仍然照常出面板', () => {
    const clean = render({ ...base, session: { ...base.session, lastActivationFailure: null } })
    expect(clean).not.toContain('devflow-activation-failure')
    const withoutField = JSON.parse(JSON.stringify(base)) as { session: Record<string, unknown> }
    delete withoutField.session.lastActivationFailure
    const legacy = render(withoutField as unknown as DevFlowClientSnapshot)
    expect(legacy).not.toContain('devflow-activation-failure')
    expect(legacy).toContain('devflow-flow-canvas')
  })
})
