/**
 * 第十五步｜临时子代理工具集按需授权（P10 · 方案甲）—— **工具层面的取证**。
 *
 * 真机缺陷（超级玛丽库 2026-09-20T19:27:44Z，第十三步评审 §三）：`tools.ts` 的
 * `inheritedTools(role)` 让临时员工**按 role 整份继承**固定员工的工具集。调研员用
 * `role: 'planner'` 登记 ⇒ 同伴是 `architect` ⇒ 拿到
 * `[read, write, edit, glob, grep, read_image, pwsh]` ⇒ **一个"只读调研"拿到了写权限**。
 * `e37ec04` 只解决了"调研派给谁"，没解决"给了什么权限" —— 溢出只是从固定员工搬到了临时子代理。
 *
 * 本轮把默认改成 **fail-closed**：不声明 `tools` ⇒ 只读集；`write` / `edit` / `pwsh` /
 * `str_replace_editor` **只有显式声明才下发**，且声明要在 journal 里留痕。
 *
 * 本用例用**真 store + 真工具运行时**执行 `devflow_agent_upsert`，所以"到底给了哪几个工具"
 * 由磁盘上的 roster 记录与 journal 判定，不由文案判定。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_FIXED_AGENTS, TEMPORARY_READ_ONLY_TOOLS } from '../src/host/default-agents.ts'
import { DevFlowStore } from '../src/host/storage.ts'
import { registerDevFlowTools } from '../src/host/tools.ts'
import { AgentWorkflow } from '../src/host/workflow-agent.ts'
import { TaskWorkflow } from '../src/host/workflow.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const commanderSeat = (agent: { readonly id: string }): boolean => agent.id === 'commander'

/** The writing capabilities the whole round exists to stop handing out by default. */
const WRITE_CLASS = ['write', 'edit', 'pwsh'] as const

async function fixture() {
  const rootDir = await mkdtemp(join(tmpdir(), 'devflow-tool-budget-'))
  roots.push(rootDir)
  const ctx = new Context()
  const store = new DevFlowStore(new LocalFileSystem(ctx, { cwd: rootDir, diffBasisMaxBytes: 1024 * 1024 }), './.devflow')
  const workflow = new TaskWorkflow(store)
  const agentWorkflow = new AgentWorkflow(store, workflow)
  const now = '2026-09-21T00:00:00.000Z'
  await store.saveProject({ id: 'project-budget', name: 'Budget', goal: 'grant the smallest set', currentStage: '', createdAt: now, updatedAt: now })
  for (const input of DEFAULT_FIXED_AGENTS) await store.registerAgent(input)
  new SystemPrompt(ctx, {})
  const tools = new ToolRuntime(ctx)
  registerDevFlowTools(ctx, {
    store, workflow, agentWorkflow,
    isCommander: (agent: Agent) => commanderSeat(agent as unknown as { readonly id: string }),
  })
  await Promise.resolve()
  const call = async <T>(name: string, args: unknown, agentId = 'commander'): Promise<T> => {
    const agent = { id: agentId, options: {}, session: { header: {} }, ctx } as unknown as Agent
    const execution = await tools.execute({
      callId: `call-${name}-${Math.random()}` as never, name, arguments: args as never, agent, signal: new AbortController().signal,
    })
    return execution as unknown as T
  }
  return { ctx, store, tools, call }
}

/** A temporary employee whose `role` is the one that used to inherit the architect's set. */
const RESEARCHER = {
  id: 'researcher-probe',
  role: 'planner' as const,
  displayName: '只读调研探针',
  description: '只读信息收集，没有文件产出。',
  capabilities: ['requirements-analysis'],
}

describe('第十五步 · 临时子代理工具集按需授权', () => {
  it('★ 不传 tools ⇒ 只读集，且不含 write / edit / pwsh', async () => {
    const f = await fixture()
    const result = await f.call<{ isError: boolean; tools: string[] }>('devflow_agent_upsert', RESEARCHER)
    expect(result.isError).toBe(false)
    // The persisted roster record is the authority, not the tool's own reply.
    const child = await f.store.getAgent(RESEARCHER.id)
    expect(child?.tools).toEqual([...TEMPORARY_READ_ONLY_TOOLS])
    for (const forbidden of WRITE_CLASS) {
      expect(child?.tools).not.toContain(forbidden)
    }
    // The role peer's full set is exactly what must NOT leak in: this role's peer is the
    // architect, who holds write / edit / pwsh.
    const architect = DEFAULT_FIXED_AGENTS.find(agent => agent.agentId === 'architect')
    expect(architect?.tools).toContain('write')
    expect(child?.tools).not.toEqual(architect?.tools)
  })

  it('显式传只读集 ⇒ 与默认等价（幂等）', async () => {
    const f = await fixture()
    const declared = [...TEMPORARY_READ_ONLY_TOOLS]
    const result = await f.call<{ isError: boolean; tools: string[] }>('devflow_agent_upsert', { ...RESEARCHER, tools: declared })
    expect(result.isError).toBe(false)
    const child = await f.store.getAgent(RESEARCHER.id)
    expect(child?.tools).toEqual([...TEMPORARY_READ_ONLY_TOOLS])
    // Re-registering with the same declaration must not accumulate or reorder anything.
    const again = await f.call<{ isError: boolean; tools: string[] }>('devflow_agent_upsert', { ...RESEARCHER, tools: declared })
    expect(again.isError).toBe(false)
    expect((await f.store.getAgent(RESEARCHER.id))?.tools).toEqual([...TEMPORARY_READ_ONLY_TOOLS])
  })

  it('显式传写类工具 ⇒ 下发，但求交后不越权（调用方没有的裁掉）', async () => {
    const f = await fixture()
    const declared = ['read', 'write', 'edit', 'pwsh', 'ghost-tool-not-in-vocabulary']
    const result = await f.call<{ isError: boolean; value: { tools: string[] } }>('devflow_agent_upsert', { ...RESEARCHER, tools: declared })
    expect(result.isError).toBe(false)
    const child = await f.store.getAgent(RESEARCHER.id)
    // Declared writing capabilities DO arrive...
    for (const name of WRITE_CLASS) expect(child?.tools).toContain(name)
    // ...and the unavailable name is trimmed rather than granted.
    expect(child?.tools).not.toContain('ghost-tool-not-in-vocabulary')
    // The tool reports the GRANTED list back, so a trim is visible instead of inferred.
    expect(result.value.tools).toEqual(['read', 'write', 'edit', 'pwsh'])
    expect(result.value.tools).not.toContain('ghost-tool-not-in-vocabulary')
    expect(child?.tools).toEqual(result.value.tools)
  })

  it('求交边界：调用方没有、名册也不认识的名字被裁掉 —— 不报错，也不悄悄放行', async () => {
    const f = await fixture()
    const result = await f.call<{ isError: boolean; value: { tools: string[] } }>('devflow_agent_upsert', {
      ...RESEARCHER,
      // `not-a-real-tool` is in neither the roster vocabulary nor the Commander's view.
      tools: ['read', 'not-a-real-tool'],
    })
    expect(result.isError).toBe(false)
    expect(result.value.tools).toEqual(['read'])
    expect((await f.store.getAgent(RESEARCHER.id))?.tools).toEqual(['read'])
    // The trim is total: the unavailable name leaves no trace on the roster record.
    expect((await f.store.getAgent(RESEARCHER.id))?.tools).not.toContain('not-a-real-tool')
  })

  it('★ 固定员工不受影响：五人工具集逐字段不变（code-auditor 仍为只读集）', async () => {
    const f = await fixture()
    // Exercising the temporary path must not touch the fixed roster.
    await f.call('devflow_agent_upsert', { ...RESEARCHER, tools: ['read', 'write'] })
    for (const shipped of DEFAULT_FIXED_AGENTS) {
      const stored = await f.store.getAgent(shipped.agentId)
      expect(stored?.tools).toEqual([...shipped.tools])
      expect(stored?.role).toBe(shipped.role)
      expect(stored?.prompt).toBe(shipped.prompt)
    }
    // The auditor's roster decision is a READ-ONLY set, and it stays that way.
    const auditor = await f.store.getAgent('code-auditor')
    expect(auditor?.tools).toEqual(['read', 'glob', 'grep', 'read_image', 'pwsh'])
    expect(auditor?.tools).not.toContain('write')
    expect(auditor?.tools).not.toContain('edit')
    // This is why the write-class rule is about `write` / `edit`, not about `pwsh` alone:
    // pwsh is a writing capability, so it is listed — and the auditor holds it by an
    // explicit roster decision, not by inheriting a default.
    expect(DEFAULT_FIXED_AGENTS.find(agent => agent.agentId === 'code-auditor')?.tools).toContain('pwsh')
  })

  it('写类声明在 journal 里留痕（沿用既有事件类型，只加字段）', async () => {
    const f = await fixture()
    await f.call('devflow_agent_upsert', { ...RESEARCHER, tools: ['read', 'write', 'pwsh'] })
    const entries = await f.store.listJournal()
    const register = entries.filter(entry => entry.type === 'devflow/agent/register').at(-1)
    expect(register).toBeDefined()
    const data = register?.data as { writeClassTools?: string[]; agent?: { tools?: string[] } }
    expect(data.writeClassTools).toEqual(['write', 'pwsh'])
    expect(data.agent?.tools).toEqual(['read', 'write', 'pwsh'])
    // No new event type was introduced for this.
    expect(entries.some(entry => entry.type === 'devflow/agent/register')).toBe(true)
  })

  it('只读登记不产生写类留痕字段（空数组，不是缺失）', async () => {
    const f = await fixture()
    await f.call('devflow_agent_upsert', RESEARCHER)
    const entries = await f.store.listJournal()
    const register = entries.filter(entry => entry.type === 'devflow/agent/register').at(-1)
    const data = register?.data as { writeClassTools?: string[] }
    expect(data.writeClassTools).toEqual([])
  })

  it('拒绝畸形的 tools 入参，而不是悄悄退化成只读默认', async () => {
    const f = await fixture()
    const refused = await f.call<{ isError: boolean; content: { text: string }[] }>('devflow_agent_upsert', {
      ...RESEARCHER,
      tools: 'read,write',
    })
    expect(refused.isError).toBe(true)
    // The runtime's own argument schema refuses it first (fail-closed), naming the field.
    expect(JSON.stringify(refused.content)).toContain('tools')
    expect(JSON.stringify(refused.content)).toContain('must be an array')
    // Nothing was written: a malformed declaration must not leave a half-registered employee,
    // and it must NOT be silently coerced into the read-only default either.
    expect(await f.store.getAgent(RESEARCHER.id)).toBeUndefined()
  })
})
