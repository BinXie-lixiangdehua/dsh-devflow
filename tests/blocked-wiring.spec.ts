/**
 * 段三 P0 接线覆盖：受阻记录从**真实 store/journal**一路走到**真实面板 DTO**。
 *
 * 这条用例存在的理由是一个已经发生过的缺陷：host 侧 5 条受阻记录确实到了
 * `snapshot.blocked`，但客户端线协议解析器按字段重建快照时没有搬 `blocked`，
 * 于是面板永远拿不到受阻行、横幅永远不出现。**手写中间对象**的用例抓不到它——
 * 手写 props 直接从 DTO 类型开始，跳过了 journal → loadState → 快照函数 →
 * 线协议解析这条唯一真实路径。
 *
 * 因此这里不构造任何中间快照：录一条受阻记录走生产写入函数（`blockedReportFrom`
 * + `recordDevFlowChange` → 真 journal 文件），再由 `loadState()` 折回、
 * `createDevFlowClientSnapshot()` 投影、`parseDevFlowResponse()` 解析。
 * 全程只读真实代码路径，临时目录之外不写任何文件。
 */
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { createScope } from '@deepseek-ai/dsh-scope'
import { DevFlowStore } from '../src/host/storage.ts'
import { DevFlowPresetActivation, DEVFLOW_PRESET_ID } from '../src/host/preset-activation.ts'
import { CommanderMode } from '../src/host/commander-mode.ts'
import { blockedReportFrom } from '../src/host/blocked-report.ts'
import { recordDevFlowChange } from '../src/host/journal.ts'
import { createDevFlowClientSnapshot } from '../src/host/client-snapshot.ts'
import { parseDevFlowResponse } from '../src/client/remote.ts'
import type { DevflowController } from '../src/host/index.ts'
import { testScopeResolver } from './support/session-scope.ts'

const NOW = '2026-09-18T02:00:00.000Z'
const TASK_ID = '3f1c4d5e-6a7b-4c8d-9e0f-1a2b3c4d5e6f'
const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** A real file-backed store plus the real controller surface the snapshot reads. */
async function environment() {
  const root = await mkdtemp(join(tmpdir(), 'devflow-blocked-wiring-'))
  roots.push(root)
  const ctx = new Context()
  const store = new DevFlowStore(
    new LocalFileSystem(new Context(), { cwd: root, diffBasisMaxBytes: 1024 * 1024 }),
    './.devflow',
  )
  const commander = new CommanderMode('你是 DevFlow 总指挥（fixture persona）')
  const activation = new DevFlowPresetActivation(store, commander, {
    composedPreset: () => DEVFLOW_PRESET_ID,
    now: () => NOW,
  })
  const agent = { id: 'session-blocked-wiring' } as unknown as Agent
  Object.assign(agent, { ctx: createScope(ctx, agent).ctx })
  const controller = {
    readState: () => store.loadState(),
    resolveSessionScope: testScopeResolver(store),
    store,
    commanderMode: commander,
    presetActivation: activation,
  } as unknown as DevflowController
  return { store, controller, agent, root }
}

/** Write one blocked report the way a real dispatch does: production builder, real journal. */
async function recordBlocked(store: DevFlowStore): Promise<void> {
  const blocked = blockedReportFrom({
    taskId: TASK_ID,
    agentId: 'architect',
    executionId: 'execution-blocked-wiring',
    detail: '本会话没有 `web_search` 工具，无法联网检索；请 boss 在配置层放宽。',
    now: NOW,
  })
  await recordDevFlowChange(store, 'devflow/blocked/report', { blocked })
}

describe('受阻记录的真实接线', () => {
  it('state.blockedReports 有记录 ⇒ 真实快照构造函数产出非空 blocked', async () => {
    const env = await environment()
    await recordBlocked(env.store)

    // 1) 真 journal 文件 → loadState 折回。
    const state = await env.store.loadState()
    expect(Object.values(state.blockedReports)).toHaveLength(1)
    expect(Object.values(state.blockedReports)[0]?.taskId).toBe(TASK_ID)

    // 2) 真快照构造函数（不手写中间对象）。
    const snapshot = await createDevFlowClientSnapshot(env.controller, env.agent)
    expect(snapshot.blocked).toBeDefined()
    expect(snapshot.blocked).toHaveLength(1)
    expect(snapshot.blocked?.[0]).toMatchObject({
      taskId: TASK_ID,
      agentId: 'architect',
      gapKind: 'tool',
      missing: 'web_search',
      at: NOW,
    })
    expect(snapshot.blocked?.[0]?.headline).toBe('架构师缺少web_search 工具，无法继续本次派发— 需 boss 处理')

    // 3) 真线协议解析：面板实际读到的快照必须仍带这条受阻行。
    const parsed = parseDevFlowResponse({ kind: 'snapshot', snapshot })
    expect(parsed.kind).toBe('snapshot')
    if (parsed.kind !== 'snapshot') return
    expect(parsed.snapshot.blocked).toHaveLength(1)
    expect(parsed.snapshot.blocked?.[0]?.missing).toBe('web_search')
    expect(parsed.snapshot.blocked?.[0]?.reason.text).toContain('web_search')
  })

  it('没有受阻记录时线协议不合成该字段', async () => {
    const env = await environment()
    const snapshot = await createDevFlowClientSnapshot(env.controller, env.agent)
    expect(snapshot.blocked).toEqual([])
    const parsed = parseDevFlowResponse({ kind: 'snapshot', snapshot })
    if (parsed.kind !== 'snapshot') throw new Error('expected a snapshot')
    expect(parsed.snapshot.blocked).toEqual([])
  })
})
