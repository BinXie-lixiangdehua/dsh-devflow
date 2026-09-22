import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CurrentSessionSources } from '../src/client/tool-activity.ts'
import type { DevFlowClientSnapshot } from '../src/contract.ts'
import type { DevFlowClientLoadState } from '../src/client/store.ts'

const controls = vi.hoisted(() => ({
  effectIndex: 0,
  dependencies: new Map<number, readonly unknown[] | undefined>(),
  tab: 'audit' as 'audit' | 'tools',
  projectRef: { current: 'project-a' as string | undefined },
}))

vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useState: <T,>(initial: T | (() => T)) => {
      const resolved = typeof initial === 'function' ? (initial as () => T)() : initial
      return [resolved === 'audit' ? controls.tab : resolved, vi.fn()]
    },
    useRef: <T,>(initial: T) => controls.projectRef as { current: T },
    useId: () => ':test-id:',
    useEffect: (effect: () => void, dependencies?: readonly unknown[]) => {
      const index = controls.effectIndex++
      if (index !== 2) return
      const previous = controls.dependencies.get(index)
      controls.dependencies.set(index, dependencies)
      const changed = previous === undefined || dependencies === undefined || previous.length !== dependencies.length
        || dependencies.some((value, dependencyIndex) => !Object.is(value, previous[dependencyIndex]))
      if (changed) effect()
    },
  }
})

import { DevFlowCanvas } from '../src/client/DevFlowCanvas.tsx'

const snapshot: DevFlowClientSnapshot = {
  version: 1,
  generatedAt: '2026-08-30T10:00:00.000Z',
  session: { id: 'session-a', commanderMode: 'chat' },
  paused: false,
  project: { id: 'project-a', name: 'DevFlow', goal: 'Audit', currentStage: 'M7' },
  agents: [], tasks: [], phases: [], assignments: [], executions: [], decisions: [], decisionRequests: [],
}

const conversation = {
  session: { sessionId: 'session-a', running: false, subagent: null, openState: 'open', hasMore: false },
  chat: { order: [], nodes: { get: () => undefined, values: () => [] } },
} as unknown as CurrentSessionSources

function beginRender(): void { controls.effectIndex = 0 }

describe('DevFlowCanvas audit effect', () => {
  beforeEach(() => {
    controls.effectIndex = 0
    controls.dependencies.clear()
    controls.tab = 'audit'
    controls.projectRef.current = 'project-a'
  })

  it('does not repeat ensure for a replacement snapshot from the same session', () => {
    let state: DevFlowClientLoadState = { phase: 'ready', snapshot, error: null }
    const ensure = vi.fn(async () => undefined)
    const audit = { ensure, refresh: vi.fn(async () => undefined), loadMore: vi.fn(async () => undefined), retry: vi.fn(async () => undefined) }
    const props = {
      sessionId: 'session-a',
      useSession: <T,>(selector: (value: CurrentSessionSources['session']) => T) => selector(conversation.session),
      useChat: <T,>(selector: (value: CurrentSessionSources['chat']) => T) => selector(conversation.chat),
      useDevflow: <T,>(selector: (value: DevFlowClientLoadState) => T) => selector(state),
      refresh: vi.fn(async () => undefined),
      getInspectorTab: () => controls.tab,
      setInspectorTab: vi.fn(),
      audit,
      t: (key: string) => key,
    } as never

    beginRender()
    DevFlowCanvas(props)
    state = { phase: 'ready', snapshot: { ...snapshot, generatedAt: '2026-08-30T10:00:05.000Z' }, error: null }
    beginRender()
    DevFlowCanvas(props)

    expect(ensure).toHaveBeenCalledTimes(1)
    expect(ensure).toHaveBeenCalledWith({ kind: 'project' }, 'project-a')

    state = { phase: 'ready', snapshot: { ...snapshot, session: { ...snapshot.session, id: 'session-b' } }, error: null }
    beginRender()
    DevFlowCanvas(props)
    expect(ensure).toHaveBeenCalledTimes(2)
  })

  it('resets audit scope when the shared project changes in the same session', () => {
    let state: DevFlowClientLoadState = { phase: 'ready', snapshot, error: null }
    const ensure = vi.fn(async () => undefined)
    const props = {
      sessionId: 'session-a',
      useSession: <T,>(selector: (value: CurrentSessionSources['session']) => T) => selector(conversation.session),
      useChat: <T,>(selector: (value: CurrentSessionSources['chat']) => T) => selector(conversation.chat),
      useDevflow: <T,>(selector: (value: DevFlowClientLoadState) => T) => selector(state),
      refresh: vi.fn(async () => undefined),
      getInspectorTab: () => 'audit' as const,
      setInspectorTab: vi.fn(),
      audit: { ensure, refresh: vi.fn(), loadMore: vi.fn(), retry: vi.fn() },
      t: (key: string) => key,
    } as never

    beginRender()
    DevFlowCanvas(props)
    state = { phase: 'ready', snapshot: { ...snapshot, project: { ...snapshot.project!, id: 'project-b' } }, error: null }
    beginRender()
    DevFlowCanvas(props)

    expect(ensure).toHaveBeenNthCalledWith(1, { kind: 'project' }, 'project-a')
    expect(ensure).toHaveBeenNthCalledWith(2, { kind: 'project' }, 'project-b')
  })

  it('does not query Business audit while Current session tools is active', () => {
    controls.tab = 'tools'
    const ensure = vi.fn(async () => undefined)
    const props = {
      sessionId: 'session-a',
      useSession: <T,>(selector: (value: CurrentSessionSources['session']) => T) => selector(conversation.session),
      useChat: <T,>(selector: (value: CurrentSessionSources['chat']) => T) => selector(conversation.chat),
      useDevflow: <T,>(selector: (value: DevFlowClientLoadState) => T) => selector({ phase: 'ready', snapshot, error: null }),
      refresh: vi.fn(async () => undefined),
      getInspectorTab: () => controls.tab,
      setInspectorTab: vi.fn(),
      audit: { ensure, refresh: vi.fn(), loadMore: vi.fn(), retry: vi.fn() },
      t: (key: string) => key,
    } as never

    beginRender()
    DevFlowCanvas(props)
    expect(ensure).not.toHaveBeenCalled()

    controls.tab = 'audit'
    beginRender()
    DevFlowCanvas(props)
    expect(ensure).toHaveBeenCalledOnce()
    expect(ensure).toHaveBeenCalledWith({ kind: 'project' }, 'project-a')
  })
})
