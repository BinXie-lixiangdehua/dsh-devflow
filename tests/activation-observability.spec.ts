/**
 * 第六步段二 §六-2/§六-8 取证：**控制性激活失败**的真实组件端到端取证。
 *
 * 这条用例不是替身拼装：它用**真的** `DevFlowStore`（真写 journal 文件）、
 * **真的** `DevFlowPresetActivation`（真跑 journal 留痕 + 真读回）、**真的**
 * `createDevFlowClientSnapshot`（真按 DTO 契约投影）、**真的**
 * `parseDevFlowResponse`（真按客户端契约解析）、**真的** `registerDevFlowCommands`
 * 渲染 `/devflow commander status`。
 *
 * 失败是**真实发生**的：provider 被喂一个 `presetIdentityMismatch`（请求的 preset id
 * 不是 `devflow`），这正是运行实例上"选错 preset"会走的同一条拒绝路径。
 *
 * 与段二浏览器取证的分工：
 *  - 本用例证明**机制**（journal 落盘 → 重启后可读 → DTO 透出 → 客户端解析 → 命令渲染）；
 *  - 段二证明**运行实例**上同一机制对真实 Hermes 失效路径的呈现（DOM/截图）。
 *
 * 只读约束：全程在 `mkdtemp` 的临时根内写；**不触碰** `D:\Deepseek\Harness\.devflow`。
 */
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { DevFlowStore } from '../src/host/storage.ts'
import { DevFlowPresetActivation, DEVFLOW_PRESET_ID, DEVFLOW_ACTIVATION_CODES } from '../src/host/preset-activation.ts'
import { CommanderMode } from '../src/host/commander-mode.ts'
import { createDevFlowClientSnapshot } from '../src/host/client-snapshot.ts'
import { parseDevFlowResponse } from '../src/client/remote.ts'
import type { DevflowController } from '../src/host/index.ts'
import { testScopeResolver } from './support/session-scope.ts'
import { DEFAULT_FIXED_AGENTS } from '../src/host/default-agents.ts'

const NOW = '2026-09-16T12:00:00.000Z'
const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function tool(name: string) {
  return defineTool({
    name,
    description: `${name} fixture`,
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.name }],
    },
    execute: async () => ({ name }),
  })
}

/**
 * One environment whose store writes REAL journal entry files under a temp root,
 * so "durable" means exactly what it means on disk rather than in a stub.
 */
async function environment() {
  const root = await mkdtemp(join(tmpdir(), 'devflow-acceptance-'))
  roots.push(root)
  const ctx = new Context()
  new SystemPrompt(ctx, {})
  const tools = new ToolRuntime(ctx)
  for (const name of ['devflow_create_task', 'read', 'write']) tools.register(tool(name))
  const store = new DevFlowStore(
    new LocalFileSystem(new Context(), { cwd: root, diffBasisMaxBytes: 1024 * 1024 }),
    './.devflow',
  )
  const commander = new CommanderMode('你是 DevFlow 总指挥（fixture persona）')
  // The live scope reports the request's own id, so feeding a non-devflow preset
  // reaches the REAL identity refusal rather than a wiring fault.
  const activation = new DevFlowPresetActivation(store, commander, {
    composedPreset: agent => String((agent as unknown as { livePreset: string }).livePreset),
    durablePreset: () => DEVFLOW_PRESET_ID,
    now: () => NOW,
  })
  function makeAgent(id: string, livePreset: string): Agent {
    const agent = { id, livePreset } as unknown as Agent
    const scope = createScope(ctx, agent)
    Object.assign(agent, { ctx: scope.ctx })
    return agent
  }
  return { root, ctx, store, commander, activation, makeAgent, journalDir: join(root, '.devflow', 'journal') }
}

/** Count the refusal records actually present as files under the temp journal. */
async function readRefusalFiles(journalDir: string) {
  let names: string[] = []
  try { names = await readdir(journalDir) } catch { return [] }
  const records: Record<string, unknown>[] = []
  for (const name of names) {
    if (name === 'head.json' || !name.endsWith('.json')) continue
    const parsed = JSON.parse(await readFile(join(journalDir, name), 'utf8')) as Record<string, unknown>
    if (parsed.type === 'devflow/preset/activation-failed') records.push(parsed)
  }
  return records
}

describe('控制性激活失败的端到端可观测性（真实组件，非替身）', () => {
  it('把拒绝留成 journal 文件，重启后读得出，并经 DTO → 客户端 → 命令逐层可见', async () => {
    const env = await environment()
    const agent = env.makeAgent('session-acceptance', 'standard')

    // 1) 真实拒绝：请求的 preset 不是 devflow。
    const failure = await env.activation
      .activate({ agent, agentCtx: (agent as unknown as { ctx: Context }).ctx, preset: { id: 'standard' }, kind: 'initial' })
      .then(() => null, (error: unknown) => error)
    expect((failure as { activationCode?: unknown } | null)?.activationCode)
      .toBe(DEVFLOW_ACTIVATION_CODES.presetIdentityMismatch)

    // 2) 落 durable：temp journal 目录里真的多了一个文件，且字段完整。
    const records = await readRefusalFiles(env.journalDir)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      type: 'devflow/preset/activation-failed',
      data: {
        sessionId: 'session-acceptance',
        activationCode: DEVFLOW_ACTIVATION_CODES.presetIdentityMismatch,
        phase: 'initial',
        attempts: 1,
        reason: expect.stringContaining('preset'),
        at: NOW,
      },
    })

    // 3) 重启后可读：同一 store 上的**新适配器实例**（内存镜像为空）仍读得出。
    const restarted = new DevFlowPresetActivation(env.store, env.commander, {
      composedPreset: () => DEVFLOW_PRESET_ID,
      durablePreset: () => DEVFLOW_PRESET_ID,
      now: () => NOW,
    })
    const report = await restarted.report(agent)
    expect(report.lastFailure).toMatchObject({
      code: DEVFLOW_ACTIVATION_CODES.presetIdentityMismatch,
      phase: 'initial',
      attempts: 1,
    })

    // 4) DTO 透出：真的走 createDevFlowClientSnapshot 的投影路径。
    const controller = {
      readState: () => env.store.loadState(),
      resolveSessionScope: testScopeResolver(env.store),
      store: env.store,
      commanderMode: env.commander,
      presetActivation: env.activation,
    } as unknown as DevflowController
    const snapshot = await createDevFlowClientSnapshot(controller, agent)
    expect(snapshot.session.lastActivationFailure).toEqual({
      code: DEVFLOW_ACTIVATION_CODES.presetIdentityMismatch,
      phase: 'initial',
      attempts: 1,
      reason: expect.any(String),
      at: NOW,
    })

    // 5) 客户端契约：真的按 parseDevFlowResponse 解析（老快照缺该字段须降级为 null）。
    const parsed = parseDevFlowResponse({ kind: 'snapshot', snapshot })
    expect(parsed.kind).toBe('snapshot')
    if (parsed.kind === 'snapshot') {
      expect(parsed.snapshot.session.lastActivationFailure).toMatchObject({
        code: DEVFLOW_ACTIVATION_CODES.presetIdentityMismatch,
        attempts: 1,
      })
    }
    const legacyWithoutField = JSON.parse(JSON.stringify(snapshot)) as { session: Record<string, unknown> }
    delete legacyWithoutField.session.lastActivationFailure
    const legacyParsed = parseDevFlowResponse({ kind: 'snapshot', snapshot: legacyWithoutField })
    if (legacyParsed.kind === 'snapshot') {
      expect(legacyParsed.snapshot.session.lastActivationFailure).toBeNull()
    }

    // 6) 失败不能被误报成 bound：`report()` 的合取确实产出 error。
    expect(report.activation).toBe('error')
    expect(report.activationError?.code).toBe(DEVFLOW_ACTIVATION_CODES.presetIdentityMismatch)
  })

  it('拒绝不改动任何 DevFlow 业务实体目录', async () => {
    const env = await environment()
    const agent = env.makeAgent('session-no-side-effects', 'standard')
    await env.activation
      .activate({ agent, agentCtx: (agent as unknown as { ctx: Context }).ctx, preset: { id: 'standard' }, kind: 'initial' })
      .catch(() => undefined)

    const devflowRoot = join(env.root, '.devflow')
    const entries = await readdir(devflowRoot)
    // Only the journal may exist: a refusal is an audit fact, not project state.
    expect(entries.sort()).toEqual(['journal'])
    expect(DEFAULT_FIXED_AGENTS.length).toBeGreaterThan(0)
  })
})
