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
import { activationBannerMode, activationFoldKey, blockedBannerFolded, blockedExpandKey, safeStorage, storeActivationFold, storeBlockedFold } from '../src/client/activation-banner.ts'
import type { CurrentSessionSources } from '../src/client/tool-activity.ts'
import { DevFlowCanvas } from '../src/client/DevFlowCanvas.tsx'
import type { DevFlowClientActivationFailure, DevFlowClientSnapshot } from '../src/contract.ts'
import type { DevFlowClientLoadState, DevFlowInspectorTab } from '../src/client/store.ts'

/**
 * 槽位表（0-based，按渲染顺序）：0 选择 / 1 历史 / 2 选择提示 / 3 详情面板开关 /
 * **4 激活横幅的收起开关** / 5 详情页签 / …… 9? 名册展开。
 * 本用例强制的两个槽：5 = 详情页签（'flow'）、10 = 名册展开。
 */
const reactState = vi.hoisted(() => ({ stateIndex: 0, tabSlot: 5, rosterSlot: 10 }))

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
  // 锚在 class 前缀上而不是 `...failure"`：横幅折起来时类名后面还跟着 ` is-folded`。
  const start = html.indexOf('class="devflow-activation-failure')
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

/**
 * 临时装上假的 `window.localStorage` 再渲染：node 测试环境里 `window` 本就不存在，
 * 所以这是**唯一**能把"用户显式展开过"这条姿态喂进真实组件的方式。
 */
function withStorage<T>(storage: unknown, run: () => T): T {
  const scope = globalThis as { window?: unknown }
  const had = Object.prototype.hasOwnProperty.call(scope, 'window')
  const before = scope.window
  if (storage === null) delete scope.window
  else scope.window = { localStorage: storage }
  try {
    return run()
  } finally {
    if (had) scope.window = before
    else delete scope.window
  }
}

/** 一条内存 Storage，够 `safeStorage()` 的读写了。 */
function bannerStorage(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed))
  return {
    getItem: (key: string): string | null => store.get(key) ?? null,
    setItem: (key: string, value: string): void => { store.set(key, value) },
    removeItem: (key: string): void => { store.delete(key) },
  }
}

describe('激活失败横幅：默认只占一行，主文案是人话，内部编码降级但不删除', () => {
  it('默认收成一行：结论仍是人话，内部编码仍在 DOM 里，且一键可展开', () => {
    const html = render(base)
    const dom = banner(html)
    expect(dom).not.toBe('')

    // 主文案：人话，且绝不含内部编码。
    const head = headline(html)
    expect(head).toBe('DevFlow 激活未通过，重试后已恢复绑定（不影响当前会话）')
    expect(head).not.toContain('devflow-')

    // 真机反馈 2026-09-24：「横幅一直挡视野」。已恢复的拒绝属于历史，默认只占一行。
    expect(dom).toContain('data-activation-folded="true"')
    expect(dom).toContain('data-activation-toggle="expand"')
    expect(dom).toContain('展开')
    expect(dom).not.toContain('data-activation-toggle="fold"')

    // 红线：编码没有被删除 —— 仍可复制引用，只是降级为次要小字（这里在行尾）。
    expect(dom).toContain('devflow-activation-failure-code')
    expect(dom).toContain('title="内部编码：devflow-activation-verification-failed"')
    expect(dom).toContain('data-activation-code="devflow-activation-verification-failed"')
    expect(dom).toContain('〈devflow-activation-verification-failed〉')
    expect(dom).toContain('data-activation-recovered="true"')
    // 编码出现在主文案之后 ⇒ 不是主体信息。
    expect(dom.indexOf('devflow-activation-failure-code')).toBeGreaterThan(dom.indexOf('devflow-activation-failure-head'))

    // 前后对照：改前主文案就是编码本身，改后同样的数据读成一句人话。
    expect(legacyHeadline(FAILURE)).toBe('激活失败 devflow-activation-verification-failed')
    expect(head).not.toBe(legacyHeadline(FAILURE))

    process.stdout.write(`\n[BEFORE HEADLINE] ${legacyHeadline(FAILURE)}\n`)
    process.stdout.write(`[FOLDED BANNER DOM] ${dom}\n`)
  })

  it('用户显式展开后回到三层：结论 → 编码 → 事实，并可再次收起', () => {
    // 只有"显式展开"会被记住，所以存储里放下这条 key 就等于"用户点过展开"。
    const storage = bannerStorage({ [activationFoldKey(FAILURE)]: '1' })
    const html = withStorage(storage, () => render(base))
    const dom = banner(html)
    expect(dom).toContain('data-activation-folded="false"')
    expect(html).toContain('data-activation-toggle="fold"')
    expect(html).toContain('收起')

    expect(dom).toContain('devflow-activation-failure-code')
    expect(dom).toContain('内部编码 〈devflow-activation-verification-failed〉')
    expect(dom).toContain('title="内部编码：devflow-activation-verification-failed"')
    expect(dom).toContain('data-activation-code="devflow-activation-verification-failed"')
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

    process.stdout.write(`[EXPANDED BANNER DOM] ${dom}\n`)
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
      // 拒绝仍成立 ⇒ **不许**折叠：活的问题不能被"收掉"到看不见。
      expect(dom).not.toContain('data-activation-toggle')
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

/**
 * 收起记账：真机反馈是"横幅无法收掉，一直挡视野"。规则只有三条 ——
 * **只有 Host 已验证恢复的拒绝可以折**、**两个可折横幅默认就是折起来的**，
 * 以及**按"这一次事件"记账**（同一编码的下一次失败、或新来的一条受阻上报，都要重新展开）。
 */
describe('激活失败横幅的收起记账', () => {
  /** 一个最小的内存 Storage；`throwOn` 用来模拟隐私模式下会抛错的存储。 */
  function memory(seed: Record<string, string> = {}, throwOn: 'get' | 'set' | 'none' = 'none') {
    const store = new Map(Object.entries(seed))
    return {
      getItem(key: string): string | null {
        if (throwOn === 'get') throw new Error('blocked')
        return store.get(key) ?? null
      },
      setItem(key: string, value: string): void {
        if (throwOn === 'set') throw new Error('blocked')
        store.set(key, value)
      },
      removeItem(key: string): void { store.delete(key) },
      keys: (): string[] => [...store.keys()],
    }
  }

  it('按"这一次拒绝"记账：同一编码的不同时刻是两个 key，上一次的展开不继承', () => {
    const first = activationFoldKey({ code: FAILURE.code, at: FAILURE.at })
    const later = activationFoldKey({ code: FAILURE.code, at: '2026-09-24T01:00:00.000Z' })
    expect(first).not.toBe(later)
    // 上一次失败被显式展开过，不代表这一次也要摊开：新一次失败按默认（折起）出现。
    const storage = memory({ [first]: '1' })
    expect(activationBannerMode(FAILURE, 'bound', storage).folded).toBe(false)
    expect(activationBannerMode({ code: FAILURE.code, at: '2026-09-24T01:00:00.000Z' }, 'bound', storage).folded).toBe(true)
  })

  it('已恢复 ⇒ 默认折起、可再展开；拒绝仍成立 ⇒ 不可折（存储里的展开位也不认）', () => {
    const key = activationFoldKey(FAILURE)
    for (const activation of ['error', 'unbound'] as const) {
      const mode = activationBannerMode(FAILURE, activation, memory({ [key]: '1' }))
      expect(mode.collapsible).toBe(false)
      expect(mode.folded).toBe(false)
    }
    expect(activationBannerMode(FAILURE, 'bound', memory())).toEqual({ collapsible: true, folded: true })
    expect(activationBannerMode(FAILURE, 'bound', memory({ [key]: '1' }))).toEqual({ collapsible: true, folded: false })
    // 没有拒绝记录时没有横幅，也就没有可折之说。
    expect(activationBannerMode(null, 'bound', memory({ [key]: '1' }))).toEqual({ collapsible: false, folded: false })
  })

  it('存储不可用/会抛错时仍是默认折起，且不抛错', () => {
    expect(activationBannerMode(FAILURE, 'bound', null)).toEqual({ collapsible: true, folded: true })
    expect(activationBannerMode(FAILURE, 'bound', memory({}, 'get'))).toEqual({ collapsible: true, folded: true })
    expect(() => storeActivationFold(memory({}, 'set'), FAILURE, false)).not.toThrow()
    expect(() => storeActivationFold(null, FAILURE, false)).not.toThrow()
    expect(() => safeStorage()).not.toThrow()
  })

  it('展开写进存储，折起把它删掉（只有"显式展开"值得记住）', () => {
    const storage = memory()
    storeActivationFold(storage, FAILURE, false)
    expect(storage.keys()).toEqual([activationFoldKey(FAILURE)])
    expect(activationBannerMode(FAILURE, 'bound', storage).folded).toBe(false)
    storeActivationFold(storage, FAILURE, true)
    expect(storage.keys()).toEqual([])
    // 折起是默认：清掉记录后仍是折起的，重开页面不会又摊开。
    expect(activationBannerMode(FAILURE, 'bound', storage).folded).toBe(true)
  })

  /*
   * 受阻横幅：它报告的是"已经停下"的派发，而且原先 absolute 浮在面板顶部盖住画布
   * （真机反馈：盖住连线、影响体验）。现在①回到正常文档流的 CSS（见 flow-css.ts），
   * ②默认收成一行 —— 收起后仍要报出条数与最新一条。
   * key 用**整批上报**算：来一条新的就换 key ⇒ 自动重新展开。
   */
  const blockedRow = (id: string, at = '2026-09-24T01:00:00.000Z') => ({ id, at })

  it('受阻横幅按"这一批上报"记账，来了新的一条就重新展开', () => {
    const one = [blockedRow('b-1')]
    const two = [blockedRow('b-1'), blockedRow('b-2')]
    expect(blockedExpandKey(one)).not.toBe(blockedExpandKey(two))
    const storage = memory({ [blockedExpandKey(one)]: '1' })
    expect(blockedBannerFolded(one, storage)).toBe(false)
    expect(blockedBannerFolded(two, storage)).toBe(true)
    // 同一条上报重复渲染仍保持同一个 key（姿态稳定）。
    expect(blockedExpandKey([blockedRow('b-1')])).toBe(blockedExpandKey(one))
  })

  it('没有受阻行时不折；存储缺失或抛错时按默认折起，且不抛错', () => {
    expect(blockedBannerFolded([], memory({ [blockedExpandKey([blockedRow('b-1')])]: '1' }))).toBe(false)
    expect(blockedBannerFolded([blockedRow('b-1')], null)).toBe(true)
    expect(blockedBannerFolded([blockedRow('b-1')], memory({}, 'get'))).toBe(true)
    expect(() => storeBlockedFold(memory({}, 'set'), [blockedRow('b-1')], false)).not.toThrow()
    expect(() => storeBlockedFold(null, [blockedRow('b-1')], false)).not.toThrow()
  })

  it('受阻横幅展开写进存储，折起把它删掉', () => {
    const rows = [blockedRow('b-1')]
    const storage = memory()
    storeBlockedFold(storage, rows, false)
    expect(storage.keys()).toEqual([blockedExpandKey(rows)])
    expect(blockedBannerFolded(rows, storage)).toBe(false)
    storeBlockedFold(storage, rows, true)
    expect(storage.keys()).toEqual([])
    expect(blockedBannerFolded(rows, storage)).toBe(true)
  })
})
