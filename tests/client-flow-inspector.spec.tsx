import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { DevFlowClientSnapshot } from '../src/contract.ts'
import { createWorkspaceModel } from '../src/client/workspace.ts'
import { createFlowModel, layoutEdges, type FlowEdge, type LayoutBox } from '../src/client/flow-projection.ts'
import { FlowInspector } from '../src/client/FlowCanvas.tsx'

/**
 * The right-hand inspector is where the correction round moved every long field:
 * node record, dispatch handoff and 阶段关联. These renders assert the panel's
 * content directly, so the acceptance does not depend on driving pointer events.
 */

const NOW = Date.parse('2026-09-14T06:00:00.000Z')

function snapshot(overrides: Partial<DevFlowClientSnapshot> = {}): DevFlowClientSnapshot {
  return {
    version: 1,
    generatedAt: '2026-09-14T04:00:00.000Z',
    session: { id: 'session-a', commanderMode: 'commander', presetId: 'devflow', activation: 'bound', activationError: null, verifiedAt: null },
    paused: false,
    project: { id: 'project-a', name: 'DevFlow', goal: '把画布做得一眼可读', currentStage: 'M7' },
    agents: [
      { id: 'commander', role: 'planner', kind: 'fixed', status: 'active', displayName: '总指挥', model: 'deepseek-chat', provider: 'deepseek', skills: [], capabilities: ['task-dispatch'], delegationDepth: 0 },
      { id: 'backend-engineer', role: 'backend-engineer', kind: 'fixed', status: 'active', displayName: '后端', model: 'm', skills: ['repository-conventions', 'testing-policy'], capabilities: ['backend-implementation'], delegationDepth: 0 },
      { id: 'code-auditor', role: 'reviewer', kind: 'fixed', status: 'active', displayName: '审计', model: 'm', skills: ['code-review'], capabilities: ['code-review'], delegationDepth: 0 },
    ],
    tasks: [
      { id: 'task-a', title: '实现分层布局', description: '验收：默认视图 0 越界', status: 'completed', updatedAt: '2026-09-14T03:00:00.000Z' },
    ],
    phases: [
      { id: 'phase-a', name: '画布布局', description: '分层 DAG', status: 'in_progress' },
    ],
    assignments: [
      { id: 'assignment-a', taskId: 'task-a', phaseId: 'phase-a', agentId: 'backend-engineer', role: 'backend-engineer', status: 'completed' },
    ],
    executions: [
      { id: 'execution-a', assignmentId: 'assignment-a', taskId: 'task-a', agentId: 'backend-engineer', status: 'completed', startedAt: '2026-09-14T03:00:00.000Z', completedAt: '2026-09-14T03:10:00.000Z' },
    ],
    results: [],
    reports: [],
    attempts: [],
    failures: [],
    decisions: [],
    decisionRequests: [],
    ...overrides,
  }
}

interface Fixture {
  readonly flow: ReturnType<typeof createFlowModel>
  readonly edges: readonly FlowEdge[]
}

function fixture(source: DevFlowClientSnapshot = snapshot(), scope: 'current' | 'history' = 'history'): Fixture {
  const model = createWorkspaceModel(source)
  const flow = createFlowModel(model, NOW, {}, scope)
  const boxes = new Map<string, LayoutBox>(flow.nodes.map(node => [node.id, {
    x: node.x, y: node.y, width: node.id === 'requirement' ? 208 : 172, height: 118,
  }]))
  return { flow, edges: layoutEdges(flow.edges, boxes) }
}

function inspector(html: {
  readonly flow: Fixture['flow']
  readonly edges: readonly FlowEdge[]
}, selection: { kind: 'node'; id: string } | { kind: 'edge'; id: string } | { kind: 'phase'; id: string }): string {
  const node = selection.kind === 'node' ? html.flow.nodes.find(item => item.id === selection.id) ?? null : null
  const edge = selection.kind === 'edge' ? html.edges.find(item => item.id === selection.id) ?? null : null
  const band = selection.kind === 'phase' ? html.flow.bands.find(item => item.id === selection.id) ?? null : null
  return renderToStaticMarkup(createElement(FlowInspector, {
    mode: 'dock',
    flow: html.flow,
    edges: html.edges,
    node,
    edge,
    band,
    highlightTaskId: null,
    onClose: () => undefined,
    onSelectNode: () => undefined,
    onSelectEdge: () => undefined,
    onSelectBand: () => undefined,
    onHighlightTask: () => undefined,
  }))
}

describe('canvas inspector (node detail / handoff detail / 阶段关联)', () => {
  it('shows the full node record for the commander', () => {
    const html = inspector(fixture(), { kind: 'node', id: 'commander' })
    expect(html).toContain('节点详情')
    expect(html).toContain('角色 / id')
    expect(html).toContain('总指挥 · commander')
    expect(html).toContain('委派深度 0 · 不能再派子代理')
    expect(html).toContain('子代理：只可由总指挥现场创建')
    expect(html).toContain('<dt>能力</dt>')
    expect(html).toContain('task-dispatch')
    expect(html).toContain('deepseek · deepseek-chat')
    expect(html).toContain('已交付')
    expect(html).toContain('data-inspector-edge="dispatch:assignment-a"')
    // 总指挥不接派发 ⇒ 本任务技能行必须明说，而不是留空或误报注入。
    expect(html).toContain('<dt>本任务技能</dt>')
    expect(html).toContain('不适用（总指挥不接派发）')
  })

  it('shows the employee record with skills, and keeps 委派深度 separate from the 子代理 note', () => {
    const html = inspector(fixture(), { kind: 'node', id: 'backend-engineer' })
    expect(html).toContain('代码工程师 · backend-engineer')
    expect(html).toContain('技能')
    expect(html).toContain('repository-conventions、testing-policy')
    // The two facts are separate rows: the old build glued them into one line with
    // a doubled/contradictory parenthesis.
    expect(html).toContain('<dt>委派深度</dt>')
    expect(html).toContain('<dt>子代理</dt>')
    expect(html).toContain('委派深度 0 · 不能再派子代理')
    expect(html).toContain('子代理：固定员工没有委派能力')
    expect(html).not.toMatch(/委派深度[^<]*（/)
    expect(html).toContain('当前任务')
    expect(html).toContain('实现分层布局')
    expect(html).toContain('验收：默认视图 0 越界')
    // 本轮新增：把"本次派发注入了哪些技能"和名册的"绑定技能"分两行呈现。注入是可观测事实
    // （宿主在启动子代理前解析全部绑定技能，缺一个就中止派发），不是模型自述。
    expect(html).toContain('<dt>绑定技能</dt>')
    expect(html).toContain('<dt>本任务技能</dt>')
    expect(html).toContain('repository-conventions、testing-policy（本次派发已注入 2 项）')
  })

  it('shows the requirement node as read-only and never as an input', () => {
    const html = inspector(fixture(), { kind: 'node', id: 'requirement' })
    expect(html).toContain('用户需求')
    expect(html).toContain('来源：用户（只读状态节点）')
    expect(html).toContain('把画布做得一眼可读')
    expect(html).toContain('需求全文')
    expect(html).toContain('用户需求节点不承载派发任务，只承载需求全文与来源。')
    expect(html).not.toContain('<input')
    expect(html).not.toContain('<textarea')
  })

  it('shows the dispatch handoff detail on one edge', () => {
    const html = inspector(fixture(), { kind: 'edge', id: 'dispatch:assignment-a' })
    expect(html).toContain('交接详情')
    expect(html).toContain('交付 · 汇报（员工 → 总指挥）')
    expect(html).toContain('task-a')
    expect(html).toContain('验收标准摘要')
    expect(html).toContain('交接双方')
    expect(html).toContain('返工次数')
  })

  it('shows the 阶段关联 block with the phase task list and its dispatches', () => {
    const html = inspector(fixture(), { kind: 'phase', id: 'phase-a' })
    expect(html).toContain('阶段关联')
    expect(html).toContain('画布布局')
    expect(html).toContain('进行中')
    expect(html).toContain('该阶段的任务（1）')
    expect(html).toContain('data-inspector-task="task-a"')
    expect(html).toContain('该阶段的派发（1）')
    expect(html).toContain('data-inspector-edge="dispatch:assignment-a"')
    expect(html).toContain('画布上不再画任何阶段元素；阶段关联只在这里列出')
  })

  it('lists every 阶段关联 with its counts and highlights the phase on click', () => {
    const html = inspector(fixture(), { kind: 'node', id: 'commander' })
    // The canvas no longer draws any phase element, so this list is the only
    // place phase association appears.
    expect(html).toContain('阶段关联（1）')
    expect(html).toContain('data-inspector-band="phase-a"')
    expect(html).toContain('画布布局')
    expect(html).toContain('进行中 · 1/1')
    expect(html).toContain('data-highlight="false"')
  })

  it('names every relation in the legend panel copy consistently (no leftover English)', () => {
    const html = inspector(fixture(), { kind: 'node', id: 'commander' })
    // A canvas-side panel must not leak an English sentence into the UI.
    expect(html).not.toMatch(/The shared project changed/)
    expect(html).not.toMatch(/Showing the project overview/)
  })
})
