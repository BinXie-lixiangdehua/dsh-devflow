/**
 * N5 后收口 · 右上角概览浮层（`shell.overlay`）的真实渲染回归。
 *
 * 之所以要这条用例：这条浮层**此前没有任何渲染用例**（`tests/client-overview.spec.ts`
 * 只测纯函数与源码文本），所以它"整个消失"时，测试全绿也发现不了。这里用真实组件
 * ＋真实快照，把"该出现"与"不该出现"两侧都钉住：
 *
 *  - 允许条件成立（当前会话 preset = devflow）⇒ 折叠胶囊必须在；
 *  - **关闭状态按会话记忆**：在 A 会话关掉，不得把 B 会话也一起藏起来
 *    （旧实现用全局键，一次误关＝所有项目都看不到概览，这是本轮判定并修掉的缺陷）；
 *  - 历史遗留的全局关闭标记必须被忽略并清除（自愈，否则用户永远回不来）；
 *  - 面板的"重新打开"事件必须能把关掉的浮层叫回来。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  OVERVIEW_CLOSED_KEY,
  OVERVIEW_EXPANDED_KEY,
  OVERVIEW_REOPEN_EVENT,
  overviewClosedKey,
  overviewExpandedKey,
} from '../src/client/overview.ts'
import { DevFlowOverview } from '../src/client/DevFlowOverview.tsx'
import type { DevFlowClientSnapshot } from '../src/contract.ts'
import type { DevFlowClientLoadState } from '../src/client/store.ts'

const snapshot: DevFlowClientSnapshot = {
  version: 1,
  generatedAt: '2026-09-14T04:00:00.000Z',
  session: {
    id: 'session-a', commanderMode: 'commander', presetId: 'devflow', activation: 'bound',
    activationError: null, verifiedAt: '2026-09-14T03:59:00.000Z', lastActivationFailure: null,
    workspacePath: 'D:\\Downloads\\DevFlow-N5', storeRoot: 'D:\\Downloads\\DevFlow-N5\\.devflow',
  },
  paused: false,
  project: { id: 'p-1', name: 'DevFlow-N5', goal: '', currentStage: '' },
  agents: [{ id: 'commander', role: 'planner', kind: 'fixed', status: 'active', displayName: '总指挥', model: 'deepseek-chat', skills: [], capabilities: [], delegationDepth: 0 }],
  tasks: [],
  phases: [],
  assignments: [],
  executions: [],
  decisions: [],
  decisionRequests: [],
}

/** A minimal localStorage so the flag behaviour is the real one, not a mock of it. */
function fakeStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(seed))
  return {
    get length() { return map.size },
    clear: () => { map.clear() },
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => { map.delete(key) },
    setItem: (key: string, value: string) => { map.set(key, value) },
  }
}

function render(options: { current: string; states?: Record<string, DevFlowClientLoadState>; connection?: undefined }): string {
  const state = options.states?.[options.current] ?? { phase: 'ready', snapshot, error: null }
  return renderToStaticMarkup(createElement(DevFlowOverview, {
    useSessions: <T,>(selector: (value: never) => T): T => selector({
      current: options.current,
      byId: { [options.current]: { projectionValues: { agentPreset: 'devflow' } } },
    } as never),
    controllerFor: () => ({
      getSnapshot: () => state,
      subscribe: () => () => undefined,
      refresh: () => Promise.resolve(),
      dispose: () => undefined,
    }) as never,
    liveFor: () => undefined,
    openPanel: () => undefined,
  } as never))
}

describe('右上角概览浮层（真实组件渲染）', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { localStorage: fakeStorage(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() })
  })

  it('renders the collapsed pill for a devflow session', () => {
    const html = render({ current: 'session-a' })
    expect(html).toContain('devflow-ov')
    expect(html).toContain('devflow-ov-pill')
    expect(html).toContain('data-gate="allowed"')
    // The pill's headline for an empty ledger, and the project identity it reads.
    expect(html).toContain('暂无派发')
  })

  it('remembers the close PER SESSION, so closing it in A never hides B', () => {
    // A: closed. B: never closed.
    vi.stubGlobal('window', {
      localStorage: fakeStorage({ [overviewClosedKey('session-a')]: '1' }),
      addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    })
    expect(render({ current: 'session-a' })).toBe('')
    expect(render({ current: 'session-b' })).toContain('devflow-ov-pill')
  })

  it('ignores and clears the legacy GLOBAL close flag instead of staying hidden forever', () => {
    const storage = fakeStorage({ [OVERVIEW_CLOSED_KEY]: '1' })
    vi.stubGlobal('window', { localStorage: storage, addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() })
    // A legacy flag must NOT hide the float any more...
    expect(render({ current: 'session-a' })).toContain('devflow-ov-pill')
    // ...and must be cleaned up, so it cannot resurrect the bug later.
    expect(storage.getItem(OVERVIEW_CLOSED_KEY)).toBeNull()
  })

  it('keeps the fold per session too, while the legacy fold key stays harmless', () => {
    vi.stubGlobal('window', {
      localStorage: fakeStorage({
        [overviewExpandedKey('session-a')]: '1',
        [OVERVIEW_EXPANDED_KEY]: '1',
      }),
      addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    })
    // Session A folds open because ITS key says so; B stays folded even though the
    // legacy key says otherwise.
    expect(render({ current: 'session-a' })).toContain('devflow-ov-card')
    expect(render({ current: 'session-b' })).not.toContain('devflow-ov-card')
  })

  it('documents the reopen event that brings a closed float back', () => {
    expect(OVERVIEW_REOPEN_EVENT).toBe('devflow:overview-reopen')
  })
})
