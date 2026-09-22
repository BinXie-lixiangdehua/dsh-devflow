/**
 * 第七步段三｜R11 / R12 的**工具级**取证。
 *
 * R12 的旧行为：`devflow_assign_agent` 的 `agentId` 参数带一个**启动时定死的 `enum`**
 * （4 个固定员工）。因此**任何后登记的员工都永远无法被派发** —— 而"加第 5 名员工"
 * 正是产品接下来要做的事。
 *
 * R11 的旧行为：`devflow_agent_upsert` 只写 `agents/`（`AgentInstance`），而
 * `assign` / `dispatch` 校验的是 `orchestration-agents/`（`OrchestrationAgent`）——
 * 两个命名空间互不相通，于是工具**报成功、员工却不可派发**。
 *
 * 本用例用**真 store + 真工具运行时**执行这两条工具，因此"名册有没有真的多出这个人"
 * 由磁盘与 journal 判定，而不是由文案判定。
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
import { DevFlowStore } from '../src/host/storage.ts'
import { authorizeAgentRegistration, registerDevFlowTools } from '../src/host/tools.ts'
import { TaskWorkflow } from '../src/host/workflow.ts'
import { AgentWorkflow } from '../src/host/workflow-agent.ts'
import { DEFAULT_FIXED_AGENTS, recordFixedRosterChanges } from '../src/host/default-agents.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/**
 * The Commander-seat check the host supplies. The fixture's calling agent is
 * `commander`, so this is the real production shape for the tool path; the
 * refusing shapes are driven directly in the identity cases below.
 */
const commanderSeat = (agent: { readonly id: string }): boolean => agent.id === 'commander'

async function fixture(isCommander: (agent: { readonly id: string }) => boolean = commanderSeat) {
  const rootDir = await mkdtemp(join(tmpdir(), 'devflow-agent-roster-'))
  roots.push(rootDir)
  const ctx = new Context()
  const store = new DevFlowStore(new LocalFileSystem(ctx, { cwd: rootDir, diffBasisMaxBytes: 1024 * 1024 }), './.devflow')
  const workflow = new TaskWorkflow(store)
  const agentWorkflow = new AgentWorkflow(store, workflow)
  const now = '2026-09-10T00:00:00.000Z'
  await store.saveProject({ id: 'project-roster', name: 'Roster', goal: 'register employees', currentStage: '', createdAt: now, updatedAt: now })
  for (const input of DEFAULT_FIXED_AGENTS) await store.registerAgent(input)
  new SystemPrompt(ctx, {})
  const tools = new ToolRuntime(ctx)
  registerDevFlowTools(ctx, {
    store, workflow, agentWorkflow,
    isCommander: (agent: Agent) => isCommander(agent as unknown as { readonly id: string }),
  })
  await Promise.resolve()
  const call = async <T>(name: string, args: unknown, agentId = 'commander'): Promise<T> => {
    const agent = { id: agentId, options: {}, session: { header: {} }, ctx } as unknown as Agent
    const execution = await tools.execute({
      callId: `call-${name}` as never, name, arguments: args as never, agent, signal: new AbortController().signal,
    })
    return execution as unknown as T
  }
  return { ctx, store, tools, call }
}

const EMPLOYEE = {
  id: 'security-auditor-probe',
  role: 'reviewer',
  displayName: '安全审计探针',
  description: '一次性登记的临时审计员工。',
  capabilities: ['security-review'],
}

describe('a registered temporary employee is dispatchable (R11 + R12)', () => {
  it('writes BOTH registries, so the employee appears in the orchestration roster', async () => {
    const f = await fixture()
    // Precondition: the id is NOT in the roster, so today's assign gate would reject it.
    expect(await f.store.getAgent(EMPLOYEE.id)).toBeUndefined()

    const result = await f.call<{ isError: boolean; content: { text: string }[] }>('devflow_agent_upsert', EMPLOYEE)
    expect(result.isError).toBe(false)
    expect(JSON.stringify(result.content)).toContain(EMPLOYEE.id)

    // The roster is the authority: the employee is now readable from disk.
    const registered = await f.store.getAgent(EMPLOYEE.id)
    expect(registered).toMatchObject({ agentId: EMPLOYEE.id, kind: 'temporary', role: 'reviewer', status: 'created' })
    // ...and the commit is journalled as a registration, not only as an instance upsert.
    const types = (await f.store.listJournal()).map(entry => entry.type)
    expect(types).toContain('devflow/agent/upsert')
    expect(types).toContain('devflow/agent/register')
  })

  it('works from the commander itself — every fixed employee sits at depth 0', async () => {
    const f = await fixture()
    // This is the product path: the user asks for one more team member, and the
    // commander (a depth-0 fixed employee, and the only agent holding DevFlow tools)
    // is who calls this. A depth-derived budget would make that impossible.
    expect(await f.store.getAgent('commander')).toMatchObject({ kind: 'fixed', delegationDepth: 0 })
    const result = await f.call<{ isError: boolean }>('devflow_agent_upsert', EMPLOYEE)
    expect(result.isError).toBe(false)
    // The new employee carries the ordinary employee budget: no children of its own.
    expect((await f.store.getAgent(EMPLOYEE.id))?.delegationDepth).toBe(0)
  })

  it('defaults to the READ-ONLY budget when no tools are declared, and still inherits the model', async () => {
    // 第十五步：默认从"按 role 整份继承"改成 fail-closed 的只读集。旧行为让一个临时
    // `planner` 拿到架构师的 `[read, write, edit, glob, grep, read_image, pwsh]` ——
    // 真机实测（超级玛丽库 2026-09-20T19:27:44Z）把只读调研派出去时就是握着 write/edit/pwsh。
    const f = await fixture()
    const result = await f.call<{ isError: boolean }>('devflow_agent_upsert', EMPLOYEE)
    expect(result.isError).toBe(false)
    const child = await f.store.getAgent(EMPLOYEE.id)
    expect(child?.tools).toEqual(['read', 'glob', 'grep', 'read_image'])
    for (const forbidden of ['write', 'edit', 'pwsh']) expect(child?.tools).not.toContain(forbidden)
    // The model still comes from the role peer: this change is about PERMISSION only.
    const peer = DEFAULT_FIXED_AGENTS.find(agent => agent.agentId === 'code-auditor')
    expect(child?.modelConfig.model).toBe(peer?.modelConfig.model)
  })

  it('grants a writing tool only when the caller declares it', async () => {
    const f = await fixture()
    const result = await f.call<{ isError: boolean }>('devflow_agent_upsert', {
      ...EMPLOYEE,
      tools: ['read', 'write', 'edit', 'pwsh'],
    })
    expect(result.isError).toBe(false)
    const child = await f.store.getAgent(EMPLOYEE.id)
    expect(child?.tools).toEqual(['read', 'write', 'edit', 'pwsh'])
    // The escalation is journalled explicitly, not inferred.
    const entries = await f.store.listJournal()
    const registered = entries.filter(entry => entry.type === 'devflow/agent/register').at(-1)
    expect(JSON.stringify(registered)).toContain('writeClassTools')
  })

  it('accepts the registered employee id at the assign gate', async () => {
    const f = await fixture()
    await f.call('devflow_agent_upsert', EMPLOYEE)
    expect(await f.store.getAgent(EMPLOYEE.id)).toBeDefined()

    const phase = await f.store.createPhase({ id: 'phase-roster', name: 'roster', description: 'd', status: 'planned', createdAt: 'now', updatedAt: 'now' })
    const task = await f.store.createTask({ id: 'task-roster', title: 't', description: 'd', status: 'created', createdAt: 'now', updatedAt: 'now' })
    const assigned = await f.call<{ isError: boolean; content: { text: string }[] }>('devflow_assign_agent', {
      phaseId: phase.id, taskId: task.id, agentId: EMPLOYEE.id, role: 'reviewer',
    })
    expect(assigned.isError).toBe(false)
    // The assignment is committed against the NEW employee.
    const assignments = await f.store.listAssignments()
    expect(assignments.map(item => item.agentId)).toContain(EMPLOYEE.id)
  })

  it('still refuses a genuinely unknown agent id, with the same message shape', async () => {
    const f = await fixture()
    const phase = await f.store.createPhase({ id: 'phase-reject', name: 'p', description: 'd', status: 'planned', createdAt: 'now', updatedAt: 'now' })
    const task = await f.store.createTask({ id: 'task-reject', title: 't', description: 'd', status: 'created', createdAt: 'now', updatedAt: 'now' })
    const refused = await f.call<{ isError: boolean; content: { text: string }[] }>('devflow_assign_agent', {
      phaseId: phase.id, taskId: task.id, agentId: 'nobody-at-all', role: 'reviewer',
    })
    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused.content)).toContain('unknown orchestration agent nobody-at-all')
    expect(await f.store.listAssignments()).toEqual([])
  })

  it('refuses to redefine a fixed employee through the upsert tool', async () => {
    // A temporary employee that DOES hold the Commander seat: this isolates the
    // fixed-employee guard from the caller-identity gate tested below.
    const f = await fixture(agent => agent.id === 'temp-parent-fixed')
    await f.store.registerAgent({
      agentId: 'temp-parent-fixed', kind: 'temporary', role: 'reviewer', prompt: 'parent',
      modelConfig: { model: 'deepseek-chat' }, tools: [], capabilities: [], skills: [], delegationDepth: 1,
    })
    const refused = await f.call<{ isError: boolean; content: { text: string }[] }>('devflow_agent_upsert', {
      id: 'code-auditor', role: 'reviewer', displayName: '冒充审计员',
    }, 'temp-parent-fixed')
    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused.content)).toContain('fixed employee')
    // The real fixed record is untouched.
    expect((await f.store.getAgent('code-auditor'))?.kind).toBe('fixed')
  })
})

describe('employee registration is restricted to an explicit caller identity', () => {
  it('refuses a registration with no calling agent at all', () => {
    // The gate reads the caller identity before anything else, so a call with no
    // caller can never reach the store: this is the shape the depth-derived
    // budget used to be the only check on.
    expect(() => authorizeAgentRegistration(commanderSeat, undefined))
      .toThrow('registering an employee requires a calling agent')
  })

  it('refuses a caller that does not hold the Commander seat', async () => {
    // A caller exists, but the seat check does not vouch for it — the fixture's
    // seat only ever recognizes `commander`.
    const caller = { id: 'backend-engineer' } as unknown as Agent
    expect(() => authorizeAgentRegistration(commanderSeat, caller))
      .toThrow('registering an employee is restricted to the Commander; caller backend-engineer is not authorized')

    // The same refusal on the real tool path: the employee must NOT appear in
    // the orchestration roster, so nothing was written.
    const f = await fixture(() => false)
    const refused = await f.call<{ isError: boolean; content: { text: string }[] }>('devflow_agent_upsert', EMPLOYEE)
    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused.content)).toContain('restricted to the Commander')
    expect(await f.store.getAgent(EMPLOYEE.id)).toBeUndefined()
  })

  it('keeps the ordinary employee depth budget for a Commander-authorized registration', async () => {
    const f = await fixture()
    const result = await f.call<{ isError: boolean }>('devflow_agent_upsert', EMPLOYEE)
    expect(result.isError).toBe(false)
    expect((await f.store.getAgent(EMPLOYEE.id))?.delegationDepth).toBe(0)
  })
})

describe('the store roster is reconciled against the shipped fixed employees', () => {
  it('is silent when the store already matches the shipped roster', async () => {
    const f = await fixture()
    // Every shipped fixed employee is already stored, so there is nothing to do
    // and — importantly — nothing is written.
    expect(await recordFixedRosterChanges(f.store)).toEqual({ added: [], refreshed: [] })
  })

  it('adds a shipped employee the store has never seen', async () => {
    // A store created before the architect existed: the project is there, the
    // roster is empty.
    const rootDir = await mkdtemp(join(tmpdir(), 'devflow-roster-empty-'))
    roots.push(rootDir)
    const store = new DevFlowStore(new LocalFileSystem(new Context(), { cwd: rootDir, diffBasisMaxBytes: 1024 * 1024 }), './.devflow')
    const now = '2026-09-10T00:00:00.000Z'
    await store.saveProject({ id: 'project-empty', name: 'Empty', goal: 'roster', currentStage: '', createdAt: now, updatedAt: now })

    const reconciliation = await recordFixedRosterChanges(store)
    expect(reconciliation.added).toEqual(DEFAULT_FIXED_AGENTS.map(agent => agent.agentId))
    expect(reconciliation.refreshed).toEqual([])
    // The new employee is a REAL roster entry, which is what makes the canvas
    // render it and what makes `devflow_assign_agent` accept its id.
    const architect = await store.getAgent('architect')
    const shipped = DEFAULT_FIXED_AGENTS.find(agent => agent.agentId === 'architect')
    expect(architect).toMatchObject({ kind: 'fixed', role: 'planner', delegationDepth: 0 })
    expect(architect?.tools).toEqual(shipped?.tools)
    expect(architect?.skills).toEqual(shipped?.skills)
    // Idempotent: a second pass has nothing left to do.
    expect(await recordFixedRosterChanges(store)).toEqual({ added: [], refreshed: [] })
  })

  it('refreshes a stored fixed employee whose tools or Skills drifted', async () => {
    const f = await fixture()
    // The exact store-vs-code drift this round backfills: an employee stored
    // with neither its tools nor its Skills.
    await f.store.updateAgentConfig('frontend-engineer', { tools: [], skills: [] })

    const reconciliation = await recordFixedRosterChanges(f.store)
    expect(reconciliation.added).toEqual([])
    expect(reconciliation.refreshed).toEqual(['frontend-engineer'])
    const frontend = await f.store.getAgent('frontend-engineer')
    const shipped = DEFAULT_FIXED_AGENTS.find(agent => agent.agentId === 'frontend-engineer')
    expect(frontend?.tools).toEqual(shipped?.tools)
    expect(frontend?.skills).toEqual(shipped?.skills)
    expect(await recordFixedRosterChanges(f.store)).toEqual({ added: [], refreshed: [] })
  })
})
