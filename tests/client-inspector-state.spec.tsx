import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CurrentSessionSources } from '../src/client/tool-activity.ts'
import type { DevFlowClientSnapshot } from '../src/contract.ts'
import type { DevFlowClientLoadState, DevFlowInspectorTab } from '../src/client/store.ts'

const reactState = vi.hoisted(() => ({
  tab: 'tools' as DevFlowInspectorTab,
}))

vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    // The persisted inspector tab is injected into the one state slot that owns
    // it (the fifth `useState` of the canvas body) and every other slot keeps its
    // initial value, so a static render can address each tab without touching the
    // canvas's own local state.
    useState: <T,>(initial: T | (() => T)) => {
      const resolved = typeof initial === 'function' ? (initial as () => T)() : initial
      return [resolved === 'tools' ? reactState.tab : resolved, vi.fn()]
    },
    useEffect: vi.fn(),
    useRef: <T,>(initial: T) => ({ current: initial }),
    useId: () => ':test-id:',
  }
})

import { DevFlowCanvas } from '../src/client/DevFlowCanvas.tsx'

const devflowSnapshot: DevFlowClientSnapshot = {
  version: 1,
  generatedAt: '2026-08-30T10:00:00.000Z',
  session: { id: 'session-a', commanderMode: 'chat', presetId: null, activation: 'unbound', activationError: null, verifiedAt: null },
  paused: false,
  project: { id: 'project-a', name: 'DevFlow', goal: 'Selection isolation', currentStage: 'M7' },
  agents: [{ id: 'code-auditor', displayName: 'Auditor', role: 'reviewer', kind: 'fixed', status: 'active', model: 'model', skills: ['code-review'], capabilities: ['code-review'], delegationDepth: 0 }],
  tasks: [{ id: 'task-a', title: 'Task A', description: 'Test', status: 'executing', updatedAt: '2026-08-30T10:00:00.000Z' }],
  phases: [{ id: 'phase-a', name: 'Phase A', description: 'Test', status: 'in_progress' }],
  assignments: [{ id: 'assignment-a', phaseId: 'phase-a', taskId: 'task-a', agentId: 'code-auditor', role: 'reviewer', status: 'in_progress' }],
  executions: [{ id: 'execution-a', assignmentId: 'assignment-a', taskId: 'task-a', agentId: 'code-auditor', status: 'running', startedAt: '2026-08-30T10:00:00.000Z', completedAt: null }],
  decisions: [{ id: 'decision-a', type: 'continue', summary: 'Continue', nextAction: 'Continue', createdAt: '2026-08-30T10:00:00.000Z' }],
  decisionRequests: [],
}

const toolNode = {
  kind: 'tool-call', target: 'chat', anchorSeq: 1, visibility: 'visible', location: { kind: 'turn', turn: { status: 'open' } },
  data: { root: { callId: 'call-a', name: 'read', time: 1, argsRaw: 'RAW', turn: 1, step: 1, callView: null, subCalls: [] } },
}
const conversation = {
  session: { sessionId: 'session-a', running: true, subagent: null, openState: 'open', hasMore: false },
  chat: { order: ['tool-a'], nodes: { get: () => toolNode, values: () => [toolNode] } },
} as unknown as CurrentSessionSources

function renderCanvas(): string {
  const state: DevFlowClientLoadState = { phase: 'ready', snapshot: devflowSnapshot, error: null }
  return renderToStaticMarkup(createElement(DevFlowCanvas, {
    sessionId: 'session-a',
    useSession: <T,>(selector: (value: CurrentSessionSources['session']) => T) => selector(conversation.session),
    useChat: <T,>(selector: (value: CurrentSessionSources['chat']) => T) => selector(conversation.chat),
    useDevflow: <T,>(selector: (value: DevFlowClientLoadState) => T) => selector(state),
    refresh: vi.fn(async () => undefined),
    getInspectorTab: () => reactState.tab,
    setInspectorTab: vi.fn(),
    audit: { ensure: vi.fn(), refresh: vi.fn(), loadMore: vi.fn(), retry: vi.fn() },
    t: (key: string) => key,
  } as never))
}

describe('DevFlowCanvas inspector state isolation', () => {
  beforeEach(() => { reactState.tab = 'tools' })

  it('keeps the persisted tab authoritative and renders only that panel', () => {
    const tools = renderCanvas()
    expect(tools).toContain('本会话工具动态')
    expect(tools).toContain('read')
    expect(tools).not.toContain('devflow-flow-viewport')

    reactState.tab = 'flow'
    const flow = renderCanvas()
    expect(flow).toContain('devflow-flow-viewport')
    expect(flow).toContain('data-flow-node="commander"')
    expect(flow).not.toContain('本会话工具动态')

    reactState.tab = 'audit'
    const audit = renderCanvas()
    expect(audit).toContain('业务审计')
    expect(audit).not.toContain('devflow-flow-viewport')
    expect(audit).not.toContain('本会话工具动态')
  })
})
