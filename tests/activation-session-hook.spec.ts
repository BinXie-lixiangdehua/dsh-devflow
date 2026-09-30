/**
 * The host-side per-Agent activation fallback.
 *
 * Why this suite exists: the failure it guards against is SILENT. `0.1.7-rc.1`
 * deleted the per-Agent activation contract, so the preset row still applies,
 * still provides its service, and the roster reports nothing wrong — the
 * Commander simply never gets installed. Every case below therefore asserts an
 * OBSERVABLE effect (an activation happened, a teardown happened, a refusal was
 * reported), never "a listener was registered".
 *
 * The yield cases matter just as much: `0.1.5` behavior must stay what it was,
 * and the only way that breaks is a double activation — once by the Harness
 * through the preset row, once by this host fallback.
 *
 * @module tests/activation-session-hook.spec
 */
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  createDevFlowSessionActivation,
  hostDrivesPerAgentActivation,
  resolveActivationMode,
  type DevFlowSessionActivationMode,
} from '../src/host/activation-session-hook.ts'
import type {
  DevFlowActivationInput,
  DevFlowActivationLease,
  DevFlowActivationProvider,
} from '../src/host/preset-activation.ts'
import { DEVFLOW_TOOL_NAMES } from '../src/host/capability-scope.ts'

// ── The two host mechanisms, as the hook sees them ──────────────────────────
// Shapes only: the hook must never call through these, just read their identity.

/** `0.1.7+` `AgentPresetRegistry`: mounts one shared tree, never calls `activate()`. */
const SERVICE_017 = {
  register: () => Promise.resolve(() => Promise.resolve()),
  resolve: () => Promise.resolve({ id: 'devflow' }),
  mount: () => Promise.resolve({ id: 'devflow' }),
  composedPreset: () => 'devflow',
}

/** `0.1.5` `AgentPresets`: directory roster that calls `activate()` per Agent. */
const SERVICE_015 = {
  standingKeyFor: () => Promise.resolve({}),
  mount: () => Promise.resolve({ id: 'devflow' }),
  composedPreset: () => 'devflow',
}

// ── A minimal fake Cordis context: this suite is about the hook's own logic ──

/** One subscribed listener. */
type Listener = (...args: unknown[]) => void

/** The fake context plus the handles a test drives it with. */
interface FakeHost {
  readonly ctx: Context
  /** Publish one service, as the host's loader would. */
  provide(name: string, value: unknown): void
  /** Fire `agent/created`, exactly as the host does. */
  created(agent: Agent): void
  /** Fire `agent/disposed`, exactly as the host does. */
  disposed(agent: Agent): void
  /** Fire the preset registry's `agent-preset/selected` signal (two positional args). */
  presetSelected(sessionId: string, agentPreset: string): void
  /** Every listener currently subscribed for one event name. */
  listeners(event: string): readonly Listener[]
}

function fakeHost(): FakeHost {
  const listeners = new Map<string, Listener[]>()
  const services = new Map<string, unknown>()
  const ctx = {
    on(event: string, listener: Listener) {
      const bucket = listeners.get(event) ?? []
      bucket.push(listener)
      listeners.set(event, bucket)
      return () => {}
    },
    provide(name: string, value: unknown) { services.set(name, value) },
    get(name: string) { return services.get(name) },
  } as unknown as Context
  const fire = (event: string, ...args: unknown[]): void => {
    for (const listener of listeners.get(event) ?? []) listener(...args)
  }
  return {
    ctx,
    provide: (name, value) => { services.set(name, value) },
    created: agent => fire('agent/created', { agent }),
    disposed: agent => fire('agent/disposed', { agent }),
    presetSelected: (sessionId, agentPreset) => fire('agent-preset/selected', sessionId, agentPreset),
    listeners: event => listeners.get(event) ?? [],
  }
}

/** What one fake Agent's capability scoping did, for the assertions. */
interface FakeAgentSurface {
  readonly agent: Agent
  /** Every `restrict()` filter the hook applied to this Agent. */
  readonly restrictions: unknown[]
  /** How many applied restrictions were released again. */
  readonly releases: () => number
  /** Change what this Agent's live preset plane answers. */
  readonly setComposed: (preset: string | undefined) => void
}

/**
 * A fake Agent carrying only what the hook reads: `id`, `session.header`, and the
 * live preset plane plus the tool runtime the capability scope touches.
 */
function fakeAgentSurface(id: string, composed: string | undefined = 'devflow'): FakeAgentSurface {
  const state = { composed, restrictions: [] as unknown[], releases: 0 }
  const ctx = {
    get: (name: string) => (name === 'agentPresets' ? { composedPreset: () => state.composed } : undefined),
    tools: {
      // The whole family is visible to the fixture, plus two native names, so a
      // `deny` filter is exercised exactly as it would be on a standard session.
      schemas: () => [...DEVFLOW_TOOL_NAMES, 'read', 'write'].map(name => ({ name })),
      restrict: (filter: unknown) => {
        state.restrictions.push(filter)
        return () => { state.releases += 1 }
      },
    },
  }
  return {
    agent: { id, ctx, session: { header: {} } } as unknown as Agent,
    restrictions: state.restrictions,
    releases: () => state.releases,
    setComposed: preset => { state.composed = preset },
  }
}

/** A fake Agent carrying only what the hook reads: `id` and `ctx`. */
function fakeAgent(id: string): Agent {
  return fakeAgentSurface(id).agent
}

/** A provider whose activation outcome the test scripts. */
function fakeProvider(options: {
  readonly fail?: Error
  readonly onActivate?: (input: DevFlowActivationInput) => void
  readonly onDeactivate?: () => void
} = {}): { provider: DevFlowActivationProvider, leases: () => DevFlowActivationLease[] } {
  const issued: DevFlowActivationLease[] = []
  const provider: DevFlowActivationProvider = {
    async activate(input) {
      options.onActivate?.(input)
      if (options.fail !== undefined) throw options.fail
      const lease: DevFlowActivationLease = {
        async deactivate() { options.onDeactivate?.() },
        async restore() {},
      }
      issued.push(lease)
      return lease
    },
  }
  return { provider, leases: () => issued }
}

/** Build a hook over fixed preset answers. */
function build(options: {
  readonly mode?: DevFlowSessionActivationMode
  readonly presetService?: unknown
  readonly preset?: (agent: Agent) => string | undefined
  readonly provider?: DevFlowActivationProvider | undefined
  readonly warn?: (message: string) => void
} = {}) {
  const host = fakeHost()
  const hook = createDevFlowSessionActivation(
    {
      createActivationProvider: () => options.provider,
      composedPreset: options.preset ?? (() => 'devflow'),
      // 默认按 0.1.7 注册表形态（宿主接管）；需要让位的用例显式传 SERVICE_015。
      presetService: () => options.presetService ?? SERVICE_017,
      ...(options.warn === undefined ? {} : { warn: options.warn }),
    },
    options.mode ?? 'auto',
  )
  hook.attach(host.ctx)
  return { host, hook }
}

describe('宿主侧激活兜底：装与卸', () => {
  it('agent/created 且预设是 devflow ⇒ 装一次，并持有 lease', async () => {
    const { provider, leases } = fakeProvider()
    const { host, hook } = build({ provider })
    const agent = fakeAgent('session-a')

    host.created(agent)
    await hook.settled()

    expect(leases()).toHaveLength(1)
    expect(hook.liveCount).toBe(1)
    expect(hook.mode).toBe('host')
  })

  it('传给激活的 input 形状正确（agent / agentCtx / preset.id / kind）', async () => {
    const seen: DevFlowActivationInput[] = []
    const { provider } = fakeProvider({ onActivate: input => seen.push(input) })
    const { host, hook } = build({ provider })
    const agent = fakeAgent('session-shape')

    host.created(agent)
    await hook.settled()

    expect(seen).toHaveLength(1)
    expect(seen[0]!.agent).toBe(agent)
    expect(seen[0]!.agentCtx).toBe(agent.ctx)
    expect(seen[0]!.preset).toEqual({ id: 'devflow' })
    expect(seen[0]!.kind).toBe('initial')
  })

  it('agent/disposed ⇒ 卸一次并清空登记（不会泄漏 lease）', async () => {
    let deactivations = 0
    const { provider } = fakeProvider({ onDeactivate: () => { deactivations += 1 } })
    const { host, hook } = build({ provider })
    const agent = fakeAgent('session-b')

    host.created(agent)
    await hook.settled()
    expect(hook.liveCount).toBe(1)

    host.disposed(agent)
    await hook.settled()

    expect(deactivations).toBe(1)
    expect(hook.liveCount).toBe(0)
  })

  it('重复的 agent/disposed 不会重复卸载（同一 lease 只卸一次）', async () => {
    let deactivations = 0
    const { provider } = fakeProvider({ onDeactivate: () => { deactivations += 1 } })
    const { host, hook } = build({ provider })
    const agent = fakeAgent('session-c')

    host.created(agent)
    await hook.settled()
    host.disposed(agent)
    host.disposed(agent)
    await hook.settled()

    expect(deactivations).toBe(1)
  })

  it('两个 Agent 各自独立装/卸（不是一次全局）', async () => {
    const { provider, leases } = fakeProvider()
    const { host, hook } = build({ provider })
    const a = fakeAgent('session-d1')
    const b = fakeAgent('session-d2')

    host.created(a)
    host.created(b)
    await hook.settled()
    expect(leases()).toHaveLength(2)
    expect(hook.liveCount).toBe(2)

    host.disposed(a)
    await hook.settled()
    expect(hook.liveCount).toBe(1)
  })
})

describe('非 devflow 预设一律不动', () => {
  it('预设是别的 id ⇒ 既不装也不卸', async () => {
    const { provider, leases } = fakeProvider()
    const { host, hook } = build({ provider, preset: () => 'standard' })
    const agent = fakeAgent('session-e')

    host.created(agent)
    host.disposed(agent)
    await hook.settled()

    expect(leases()).toHaveLength(0)
    expect(hook.liveCount).toBe(0)
  })

  it('读不到预设（注册表缺席）⇒ 不动，且不报错', async () => {
    const { provider, leases } = fakeProvider()
    const { host, hook } = build({ provider, preset: () => undefined })

    host.created(fakeAgent('session-f'))
    await hook.settled()

    expect(leases()).toHaveLength(0)
  })
})

describe('0.1.5 让位：不得双跑', () => {
  it('auto + 预设行仍在（Harness 在驱动）⇒ 宿主一次都不装', async () => {
    const { provider, leases } = fakeProvider()
    const { host, hook } = build({ provider, presetService: SERVICE_015 })
    const agent = fakeAgent('session-g')

    host.created(agent)
    await hook.settled()

    expect(leases()).toHaveLength(0)
    expect(hook.mode).toBe('preset-row')
  })

  it('auto + 预设行不存在（声明式预设）⇒ 宿主接管', async () => {
    const { provider, leases } = fakeProvider()
    const { host, hook } = build({ provider, presetService: SERVICE_017 })

    host.created(fakeAgent('session-h'))
    await hook.settled()

    expect(leases()).toHaveLength(1)
    expect(hook.mode).toBe('host')
  })

  it('宿主机制在进程内才出现 ⇒ 后续 Agent 立刻让位（读活事实，不读构造快照）', async () => {
    // 这是"0.1.5 上不得双跑"的核心：控制器可能先构造，宿主服务之后才 provide。
    // 若把构造那一刻的答案快照下来判错，就会装两次。
    const { provider, leases } = fakeProvider()
    let service = SERVICE_017 // 先看到"声明式注册表" ⇒ 宿主接管
    const host = fakeHost()
    const hook = createDevFlowSessionActivation(
      { createActivationProvider: () => provider, composedPreset: () => 'devflow', presetService: () => service },
      'auto',
    )
    hook.attach(host.ctx)
    expect(hook.mode).toBe('host')

    // 宿主机制换成了 0.1.5 形态（目录式名册）⇒ 必须立刻让位
    service = SERVICE_015
    host.created(fakeAgent('session-i'))
    await hook.settled()

    expect(leases()).toHaveLength(0)
    expect(hook.mode).toBe('preset-row')
  })

  it('已装过的 Agent 不会被重复装（lease Map 兜底）', async () => {
    const { provider, leases } = fakeProvider()
    let service = SERVICE_017
    const host = fakeHost()
    const hook = createDevFlowSessionActivation(
      { createActivationProvider: () => provider, composedPreset: () => 'devflow', presetService: () => service },
      'auto',
    )
    hook.attach(host.ctx)
    const agent = fakeAgent('session-i2')

    host.created(agent)
    await hook.settled()
    expect(leases()).toHaveLength(1)

    // 之后同 Agent 再来一次边缘（例如重连）⇒ 不得再装
    service = SERVICE_015
    host.created(agent)
    await hook.settled()
    expect(leases()).toHaveLength(1)
  })

  it('同一 Agent 的重复 created 边缘不会重复装（并发也只有一个 lease）', async () => {
    const { provider, leases } = fakeProvider()
    const { host, hook } = build({ provider })
    const agent = fakeAgent('session-i3')

    host.created(agent)
    host.created(agent)
    host.created(agent)
    await hook.settled()

    expect(leases()).toHaveLength(1)
  })
})

describe('开关：host / preset-row 覆盖判定', () => {
  it("mode='host' 即使预设行仍在也照装（人工兜底）", async () => {
    const { provider, leases } = fakeProvider()
    const { host, hook } = build({ provider, mode: 'host', presetService: SERVICE_015 })

    host.created(fakeAgent('session-k'))
    await hook.settled()

    expect(leases()).toHaveLength(1)
    expect(hook.mode).toBe('host')
  })

  it("mode='preset-row' 即使预设行不在也不装（强制回旧路径）", async () => {
    const { provider, leases } = fakeProvider()
    const { host, hook } = build({ provider, mode: 'preset-row', presetService: SERVICE_017 })

    host.created(fakeAgent('session-l'))
    await hook.settled()

    expect(leases()).toHaveLength(0)
    expect(hook.mode).toBe('preset-row')
  })

  it('resolveActivationMode 的判定表（auto 看机制形状，显式值胜出）', () => {
    expect(resolveActivationMode('host', () => SERVICE_015)).toBe('host')
    expect(resolveActivationMode('preset-row', () => SERVICE_017)).toBe('preset-row')
    // auto：0.1.5 形态（目录式名册）⇒ 让位
    expect(resolveActivationMode('auto', () => SERVICE_015)).toBe('preset-row')
    // auto：0.1.7 形态（声明式注册表）⇒ 宿主接管
    expect(resolveActivationMode('auto', () => SERVICE_017)).toBe('host')
    // auto：服务缺席 ⇒ 保守让位
    expect(resolveActivationMode('auto', () => undefined)).toBe('preset-row')
  })

  it('模式变化会通知订阅者（诊断用）', () => {
    let service: unknown = SERVICE_017
    const host = fakeHost()
    const hook = createDevFlowSessionActivation(
      {
        createActivationProvider: () => fakeProvider().provider,
        composedPreset: () => 'devflow',
        presetService: () => service,
      },
      'auto',
    )
    const seen: string[] = []
    hook.onModeChange(value => seen.push(value))
    hook.attach(host.ctx)
    service = SERVICE_015
    host.created(fakeAgent('session-mode'))
    expect(seen).toEqual(['host', 'preset-row'])
  })
})

describe('让位判据：按宿主「预设机制的形状」判定', () => {
  it('0.1.7 的注册表（有 register、无 standingKeyFor）⇒ 宿主接管', () => {
    expect(hostDrivesPerAgentActivation(SERVICE_017)).toBe(false)
  })

  it('0.1.5 的目录式名册（有 standingKeyFor）⇒ 让位', () => {
    expect(hostDrivesPerAgentActivation(SERVICE_015)).toBe(true)
  })

  it('未知形状 / 服务缺席 ⇒ 让位（保守默认，宁可不动也不能双跑）', () => {
    expect(hostDrivesPerAgentActivation(undefined)).toBe(true)
    expect(hostDrivesPerAgentActivation(null)).toBe(true)
    expect(hostDrivesPerAgentActivation({})).toBe(true)
    expect(hostDrivesPerAgentActivation({ somethingElse: 1 })).toBe(true)
  })

  it('★ 回归钉子：预设行「挂载了」绝不能推出「宿主应让位」', () => {
    // 这是本轮踩到的真坑：0.1.7 上声明式预设行**照样挂载**（apply 会跑、服务会提供），
    // 但没有任何人调用 activate()。早期实现用「行是否挂载」当让位判据 ⇒ 在 0.1.7 上
    // 让位 ⇒ 复现了它本该消除的静默失效。判据必须来自「哪一个机制」。
    const on017 = SERVICE_017
    expect(hostDrivesPerAgentActivation(on017)).toBe(false)
    // 同一个「行已挂载」的事实在两版都为真，因此它不能作为判据：
    const rowMountedInBothVersions = true
    expect(rowMountedInBothVersions).toBe(true)
    expect(hostDrivesPerAgentActivation(on017)).toBe(false)
    expect(hostDrivesPerAgentActivation(SERVICE_015)).toBe(true)
  })

  it('控制器以活读取方式把 presetService 交给兜底', () => {
    const bundle = readFileSync(new URL('../src/host/index.ts', import.meta.url), 'utf8')
    expect(bundle).toContain("presetService: () => ctx.get('agentPresets')")
  })

  it('预设行仍保留（0.1.5 的让位路径靠它提供 provider）', () => {
    const row = readFileSync(new URL('../src/host/preset-activation.ts', import.meta.url), 'utf8')
    expect(row).toContain("ctx.reflect.provide('agentPresetActivation', published)")
  })
})

describe('失败必须响亮：不得静默', () => {
  it('激活被拒 ⇒ 记一条 warning，且不把异常抛进生命周期', async () => {
    const warn = vi.fn()
    const refusal = Object.assign(new Error('agent preset activation rejected'), {
      activationCode: 'devflow-commander-install-failed',
    })
    const { provider, leases } = fakeProvider({ fail: refusal })
    const { host, hook } = build({ provider, warn })
    const agent = fakeAgent('session-m')

    expect(() => { host.created(agent) }).not.toThrow()
    await hook.settled()

    expect(leases()).toHaveLength(0)
    expect(hook.liveCount).toBe(0)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('agent preset activation rejected')
  })

  it('卸载失败 ⇒ 记 warning，仍然清空登记（不得阻塞销毁）', async () => {
    const warn = vi.fn()
    const provider: DevFlowActivationProvider = {
      async activate() {
        return {
          async deactivate() { throw new Error('teardown blew up') },
          async restore() {},
        }
      },
    }
    const { host, hook } = build({ provider, warn })
    const agent = fakeAgent('session-n')

    host.created(agent)
    await hook.settled()
    expect(() => { host.disposed(agent) }).not.toThrow()
    await hook.settled()

    expect(hook.liveCount).toBe(0)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('teardown blew up')
  })

  it('没有激活适配器时 ⇒ 记 warning 而不是静默跳过', async () => {
    const warn = vi.fn()
    const { host, hook } = build({ provider: undefined, warn })

    host.created(fakeAgent('session-o'))
    await hook.settled()

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('no activation adapter')
  })
})

describe('接线本身', () => {
  it('attach 订阅两个生命周期边缘，且重复 attach 不重复订阅', () => {
    const { host, hook } = build({ provider: fakeProvider().provider })
    hook.attach(host.ctx)

    expect(host.listeners('agent/created')).toHaveLength(1)
    expect(host.listeners('agent/disposed')).toHaveLength(1)
  })

  it('事件载荷缺 agent 时不炸（防御性）', async () => {
    const { host, hook } = build({ provider: fakeProvider().provider })
    expect(() => {
      for (const listener of host.listeners('agent/created')) listener({})
      for (const listener of host.listeners('agent/disposed')) listener({})
    }).not.toThrow()
    await hook.settled()
  })
})

describe('预设变更边缘：换出去就卸，换回来就装', () => {
  it('★ devflow → 别的预设：立刻卸租约、登记清空，且不重装', async () => {
    let deactivations = 0
    const { provider, leases } = fakeProvider({ onDeactivate: () => { deactivations += 1 } })
    let composed = 'devflow'
    const { host, hook } = build({ provider, preset: () => composed })
    const agent = fakeAgent('session-switch-out')
    host.provide('agents', { get: (id: string) => (id === agent.id ? agent : undefined) })

    host.created(agent)
    await hook.settled()
    expect(hook.liveCount).toBe(1)

    composed = 'standard'
    host.presetSelected(agent.id, 'standard')
    await hook.settled()

    expect(deactivations).toBe(1)
    expect(hook.liveCount).toBe(0)
    expect(leases()).toHaveLength(1)
  })

  it('★ 别的预设 → devflow：立刻装回来', async () => {
    const { provider, leases } = fakeProvider()
    let composed = 'standard'
    const { host, hook } = build({ provider, preset: () => composed })
    const agent = fakeAgent('session-switch-in')
    host.provide('agents', { get: () => agent })

    host.created(agent)
    await hook.settled()
    expect(hook.liveCount).toBe(0)

    composed = 'devflow'
    host.presetSelected(agent.id, 'devflow')
    await hook.settled()

    expect(leases()).toHaveLength(1)
    expect(hook.liveCount).toBe(1)
  })

  it('反复切换：租约不泄漏，回到 devflow 每次只装一个', async () => {
    let deactivations = 0
    const { provider, leases } = fakeProvider({ onDeactivate: () => { deactivations += 1 } })
    let composed = 'devflow'
    const { host, hook } = build({ provider, preset: () => composed })
    const agent = fakeAgent('session-switch-loop')
    host.provide('agents', { get: () => agent })

    for (let round = 0; round < 3; round += 1) {
      host.created(agent)
      await hook.settled()
      composed = 'standard'
      host.presetSelected(agent.id, 'standard')
      await hook.settled()
      composed = 'devflow'
      host.presetSelected(agent.id, 'devflow')
      await hook.settled()
    }

    expect(hook.liveCount).toBe(1)
    expect(deactivations).toBe(3)
    expect(leases()).toHaveLength(4)
  })

  it('同一方向的重复信号不重复装卸（幂等）', async () => {
    let deactivations = 0
    const { provider, leases } = fakeProvider({ onDeactivate: () => { deactivations += 1 } })
    const { host, hook } = build({ provider })
    const agent = fakeAgent('session-switch-idem')
    host.provide('agents', { get: () => agent })

    host.created(agent)
    await hook.settled()
    host.presetSelected(agent.id, 'devflow')
    host.presetSelected(agent.id, 'devflow')
    await hook.settled()
    expect(leases()).toHaveLength(1)
    expect(hook.liveCount).toBe(1)

    host.presetSelected(agent.id, 'standard')
    host.presetSelected(agent.id, 'standard')
    await hook.settled()
    expect(deactivations).toBe(1)
    expect(hook.liveCount).toBe(0)
  })

  it('让位模式下（0.1.5 形态）预设变更不动租约（不得双跑）', async () => {
    const { provider, leases } = fakeProvider()
    const { host, hook } = build({ provider, presetService: SERVICE_015 })
    const agent = fakeAgent('session-switch-yield')
    host.provide('agents', { get: () => agent })

    host.created(agent)
    host.presetSelected(agent.id, 'devflow')
    host.presetSelected(agent.id, 'standard')
    await hook.settled()

    expect(leases()).toHaveLength(0)
    expect(hook.liveCount).toBe(0)
  })

  it('attach 也会订阅预设变更边缘，重复 attach 不重复订阅', () => {
    const { host, hook } = build({ provider: fakeProvider().provider })
    hook.attach(host.ctx)

    expect(host.listeners('agent/created')).toHaveLength(1)
    expect(host.listeners('agent/disposed')).toHaveLength(1)
    expect(host.listeners('agent-preset/selected')).toHaveLength(1)
  })

  it('预设变更事件的载荷不合法时不炸（防御性）', async () => {
    const { host, hook } = build({ provider: fakeProvider().provider })
    expect(() => {
      for (const listener of host.listeners('agent-preset/selected')) listener(undefined)
      for (const listener of host.listeners('agent-preset/selected')) listener('session-x', 42)
    }).not.toThrow()
    await hook.settled()
  })
})

describe('能力可见性：随预设收窄与释放', () => {
  it('★ standard 会话创建即收窄；切到 devflow 释放', async () => {
    const { provider } = fakeProvider()
    let composed = 'standard'
    const { host, hook } = build({ provider, preset: () => composed })
    const surface = fakeAgentSurface('session-scope', 'standard')
    host.provide('agents', { get: () => surface.agent })

    host.created(surface.agent)
    await hook.settled()
    expect(hook.scopedCount).toBe(1)
    expect(surface.restrictions).toHaveLength(1)
    expect(surface.restrictions[0]).toEqual({ deny: [...DEVFLOW_TOOL_NAMES] })

    composed = 'devflow'
    surface.setComposed('devflow')
    host.presetSelected(surface.agent.id, 'devflow')
    await hook.settled()

    expect(hook.scopedCount).toBe(0)
    expect(surface.releases()).toBe(1)
  })

  it('devflow 会话从头到尾都不动可见性（判据 2-2 的硬门槛）', async () => {
    const { provider } = fakeProvider()
    const { host, hook } = build({ provider })
    const surface = fakeAgentSurface('session-scope-devflow', 'devflow')

    host.created(surface.agent)
    await hook.settled()

    expect(hook.scopedCount).toBe(0)
    expect(surface.restrictions).toHaveLength(0)
  })

  it('agent/disposed 释放能力收窄（不泄漏）', async () => {
    const { provider } = fakeProvider()
    const { host, hook } = build({ provider, preset: () => 'standard' })
    const surface = fakeAgentSurface('session-scope-dispose', 'standard')

    host.created(surface.agent)
    await hook.settled()
    expect(hook.scopedCount).toBe(1)

    host.disposed(surface.agent)
    await hook.settled()
    expect(hook.scopedCount).toBe(0)
    expect(surface.releases()).toBe(1)
  })

  it('同方向的重复信号不叠加收窄（幂等）', async () => {
    const { provider } = fakeProvider()
    const { host, hook } = build({ provider, preset: () => 'standard' })
    const surface = fakeAgentSurface('session-scope-idem', 'standard')
    host.provide('agents', { get: () => surface.agent })

    host.created(surface.agent)
    for (let round = 0; round < 3; round += 1) {
      host.presetSelected(surface.agent.id, 'standard')
      host.presetSelected(surface.agent.id, 'standard')
    }
    await hook.settled()

    expect(hook.scopedCount).toBe(1)
    expect(surface.restrictions).toHaveLength(1)
  })

  it('收窄失败只是一条 warning，不会把 Agent 弄坏', async () => {
    const warn = vi.fn()
    const { provider } = fakeProvider()
    const { host, hook } = build({ provider, preset: () => 'standard', warn })
    const surface = fakeAgentSurface('session-scope-throws', 'standard')
    ;(surface.agent.ctx as unknown as { tools: { restrict: () => never } }).tools.restrict = () => {
      throw new Error('restrict refused')
    }

    expect(() => { host.created(surface.agent) }).not.toThrow()
    await hook.settled()

    expect(hook.scopedCount).toBe(0)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('restrict refused')
  })
})
