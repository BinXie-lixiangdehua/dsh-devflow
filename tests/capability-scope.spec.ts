/**
 * The DevFlow capability boundary (段二).
 *
 * Why this suite exists: the `devflow_*` family is registered by the DevFlow HOST
 * bundle, so a session running any other preset still SEES all eighteen tools and
 * could call them — measured 2026-10-01 (`probe-default-standard.jsonl`:
 * `composed:"standard"`, `devflowToolCount:18`). The boundary is therefore an
 * EXECUTION guard, and every case below asserts an observable effect: a real
 * `tools.execute()` refusal, or the predicate that decides it — never "a guard was
 * registered".
 *
 * @module tests/capability-scope.spec
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import {
  DEVFLOW_TOOL_NAMES,
  devflowCapabilityDenialReason,
  isDevFlowToolName,
  liveComposedPreset,
  ownsDevFlowCapability,
  presetPlaneOf,
  shouldHideDevFlowTools,
} from '../src/host/capability-scope.ts'
import { registerDevFlowTools } from '../src/host/tools.ts'

/** The denial text every refusal must carry, so a caller can attribute it. */
const DENIAL_MARKER = 'DevFlow-session capability'

interface CallerOptions {
  /** Preset its live plane answers; `null` means "plane present, composition unreadable". */
  readonly composed?: string | null
  /** Set false to model a deployment that composes no preset service at all. */
  readonly plane?: boolean
  readonly depth?: number
  readonly origin?: string
}

/**
 * A structural caller: only the two reads the boundary performs.
 *
 * `ctx.get('agentPresets')` is the live composition, and `session.header` carries
 * the lineage facts. Nothing else about an Agent is consulted.
 */
function caller(id: string, options: CallerOptions = {}): Agent {
  const plane = options.plane === false
    ? undefined
    : { composedPreset: () => (options.composed === null ? undefined : options.composed ?? 'devflow') }
  const header = {
    ...options.depth === undefined ? {} : { delegationDepth: options.depth },
    ...options.origin === undefined ? {} : { origin: options.origin },
  }
  return {
    id,
    ctx: { get: (name: string) => (name === 'agentPresets' ? plane : undefined) },
    session: { header },
  } as unknown as Agent
}

describe('工具族的名单本身就是边界', () => {
  it('★ 源码里注册的 devflow_* 与能力名单一一对应（新增工具不登记就红）', () => {
    // Static on purpose: one tool in the family is registered behind
    // `ctx.inject(['subagents'])`, so a runtime read of a fixture without that
    // service cannot see it. The source is the complete list either way, and this
    // is the check that a NEW `devflow_*` tool cannot slip past unlisted.
    const source = readFileSync(new URL('../src/host/tools.ts', import.meta.url), 'utf8')
    const declared = [...source.matchAll(/name: '(devflow_[a-z_]+)'/g)].map(match => match[1]!)
    expect([...new Set(declared)].sort()).toEqual([...DEVFLOW_TOOL_NAMES].sort())
  })

  it('运行期：注册出的 devflow_* 与名单一致（只有 dispatch 需要 subagents 服务）', () => {
    const root = new Context()
    new SystemPrompt(root, {})
    const runtime = new ToolRuntime(root)
    registerDevFlowTools(root, {} as never)

    const registered = runtime.schemas()
      .map(tool => tool.name)
      .filter(isDevFlowToolName)
      .sort()

    // `devflow_dispatch_agent` only registers when the `subagents` service is
    // composed; every other member of the family registers unconditionally.
    expect(registered).toEqual([...DEVFLOW_TOOL_NAMES].filter(name => name !== 'devflow_dispatch_agent').sort())
    expect(registered).toHaveLength(17)
    for (const name of registered) expect(DEVFLOW_TOOL_NAMES).toContain(name)
  })

  it('名单判定：devflow_* 命中，原生工具不命中', () => {
    expect(isDevFlowToolName('devflow_project_status')).toBe(true)
    expect(isDevFlowToolName('devflow_dispatch_agent')).toBe(true)
    expect(isDevFlowToolName('read')).toBe(false)
    expect(isDevFlowToolName('write')).toBe(false)
    expect(isDevFlowToolName('devflow_unknown')).toBe(false)
  })
})

describe('谁能用：按活组合与谱系判定', () => {
  it('devflow 顶层会话 ⇒ 有权', () => {
    expect(ownsDevFlowCapability(caller('commander', { composed: 'devflow' }))).toBe(true)
  })

  it('别的预设 ⇒ 无权（这就是越权的一半）', () => {
    expect(ownsDevFlowCapability(caller('standard-session', { composed: 'standard' }))).toBe(false)
  })

  it('★ 被派发的子代理/员工 ⇒ 无权，即使它 join 的是 devflow 组合（红线 3）', () => {
    expect(ownsDevFlowCapability(caller('employee', { composed: 'devflow', depth: 1 }))).toBe(false)
    expect(ownsDevFlowCapability(caller('employee-origin', { composed: 'devflow', origin: 'subagent' }))).toBe(false)
  })

  it('没有调用者身份 ⇒ 无权（默认拒绝）', () => {
    expect(ownsDevFlowCapability(undefined)).toBe(false)
  })

  it('预设平面存在但组合读不到 ⇒ 无权（不是 devflow 会话）', () => {
    expect(presetPlaneOf(caller('unbound', { composed: null }))).toBeDefined()
    expect(liveComposedPreset(caller('unbound', { composed: null }))).toBeUndefined()
    expect(ownsDevFlowCapability(caller('unbound', { composed: null }))).toBe(false)
  })

  it('整个部署根本没有预设平面 ⇒ 有权（没有可比对的预设身份，不能把自家编排打死）', () => {
    expect(presetPlaneOf(caller('no-plane', { plane: false }))).toBeUndefined()
    expect(ownsDevFlowCapability(caller('no-plane', { plane: false }))).toBe(true)
  })
})

describe('可见性收窄：只在能确证"非 devflow"时动手', () => {
  it('standard 会话 ⇒ 隐藏 devflow_*', () => {
    expect(shouldHideDevFlowTools(caller('s', { composed: 'standard' }))).toBe(true)
  })

  it('devflow 会话 ⇒ 不隐藏（判据 2-2 是硬门槛）', () => {
    expect(shouldHideDevFlowTools(caller('d', { composed: 'devflow' }))).toBe(false)
  })

  it('组合读不到 / 没有预设平面 ⇒ 不隐藏（隐藏是优化，宁可不动）', () => {
    expect(shouldHideDevFlowTools(caller('u', { composed: null }))).toBe(false)
    expect(shouldHideDevFlowTools(caller('n', { plane: false }))).toBe(false)
  })
})

describe('拒绝理由必须可归因', () => {
  it('devflow 顶层会话不被拒', () => {
    expect(devflowCapabilityDenialReason({ name: 'devflow_project_status', agent: caller('d', { composed: 'devflow' }) }))
      .toBeUndefined()
  })

  it('非 devflow 会话被拒，理由里点出工具名与实际预设', () => {
    const reason = devflowCapabilityDenialReason({
      name: 'devflow_project_status',
      agent: caller('s', { composed: 'standard' }),
    })
    expect(reason).toContain(DENIAL_MARKER)
    expect(reason).toContain('devflow_project_status')
    expect(reason).toContain('"standard"')
  })

  it('子代理被拒，理由点明是委派调用者', () => {
    const reason = devflowCapabilityDenialReason({
      name: 'devflow_dispatch_agent',
      agent: caller('e', { composed: 'devflow', depth: 2 }),
    })
    expect(reason).toContain('delegated Agent')
  })

  it('没有调用者身份被拒，理由点明无会话', () => {
    expect(devflowCapabilityDenialReason({ name: 'devflow_pause' })).toContain('no calling session')
  })

  it('非 devflow_* 名字一律放行（不得过度拒绝）', () => {
    expect(devflowCapabilityDenialReason({ name: 'read', agent: caller('s', { composed: 'standard' }) }))
      .toBeUndefined()
    expect(devflowCapabilityDenialReason({ name: 'write', agent: caller('s', { composed: 'standard' }) }))
      .toBeUndefined()
  })
})

describe('执行面：同一工具、两种预设的真实对照', () => {
  /** One runtime carrying the real family plus a scriptable preset plane. */
  function runtime() {
    const root = new Context()
    new SystemPrompt(root, {})
    const tools = new ToolRuntime(root)
    registerDevFlowTools(root, {} as never)
    let composed = 'devflow'
    root.provide('agentPresets', { composedPreset: () => composed } as never)
    const agentFor = (id: string, options: { depth?: number } = {}) => {
      const agent = {
        id,
        session: { header: options.depth === undefined ? {} : { delegationDepth: options.depth } },
      } as unknown as Agent
      const scope = createScope(root, agent)
      Object.assign(agent, { ctx: scope.ctx })
      return { agent, dispose: () => scope.dispose() }
    }
    const call = async (agent: Agent, name: string) => await tools.execute({
      callId: `${name}-${String(agent.id)}` as never,
      name,
      arguments: {},
      agent,
      signal: new AbortController().signal,
    })
    return {
      call,
      agentFor,
      setComposed: (value: string) => { composed = value },
    }
  }

  it('★ 同一工具：standard 会话被拒，devflow 会话不被这条规则拒', async () => {
    const { call, agentFor, setComposed } = runtime()
    const commander = agentFor('commander')
    const standard = agentFor('standard-session')
    try {
      setComposed('standard')
      const refused = await call(standard.agent, 'devflow_project_status')
      expect(refused.isError).toBe(true)
      expect(JSON.stringify(refused.content)).toContain(DENIAL_MARKER)

      setComposed('devflow')
      const allowed = await call(commander.agent, 'devflow_project_status')
      // The capability rule must not be what stops this call. The tool body still
      // fails here because this fixture composes no store — which is exactly why
      // the assertion is about the DENIAL TEXT rather than about `isError`.
      expect(JSON.stringify(allowed.content)).not.toContain(DENIAL_MARKER)
    } finally {
      commander.dispose()
      standard.dispose()
    }
  })

  it('★ 子代理拿同一个工具：即使 join 了 devflow 组合也被拒（红线 3 落在执行面）', async () => {
    const { call, agentFor, setComposed } = runtime()
    const employee = agentFor('employee', { depth: 1 })
    try {
      setComposed('devflow')
      const refused = await call(employee.agent, 'devflow_pause')
      expect(refused.isError).toBe(true)
      expect(JSON.stringify(refused.content)).toContain('delegated Agent')
    } finally {
      employee.dispose()
    }
  })
})
