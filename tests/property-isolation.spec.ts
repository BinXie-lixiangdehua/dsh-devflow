/**
 * 第九步 · 项目隔离（按会话工作区派生 `.devflow`）的回归断言。
 *
 * 这一轮的产品判据是 boss 的原话：「a 项目和 b 项目的数据是不互通的」。
 * 因此这些用例只用真实组件（真 `LocalFileSystem`、真 `DevFlowStore`、
 * 真 `registerDevFlowTools`、真 `DevFlowPresetActivation`），不用替身拼状态：
 * 替身拼出来的"隔离"证明不了任何一条真实读取路径。
 *
 * 覆盖三件事：
 *  1. **派生**：store 根 = `<会话工作区>\.devflow`，两个工作区互不可见；
 *  2. **会话级锁定**：同一会话中途换工作区不换库；
 *  3. **显式拒绝**：拿不到工作区的会话**不许**静默退回共享库。
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { DevFlowSessionStores, DEVFLOW_SESSION_SCOPE_UNAVAILABLE, DevFlowSessionScopeError } from '../src/host/session-store.ts'
import { DevFlowChangeBus } from '../src/host/change-bus.ts'
import { CommanderMode } from '../src/host/commander-mode.ts'
import { DevFlowPresetActivation } from '../src/host/preset-activation.ts'
import { DevFlowStore } from '../src/host/storage.ts'
import { registerDevFlowTools } from '../src/host/tools.ts'
import { TaskWorkflow } from '../src/host/workflow.ts'
import { AgentWorkflow } from '../src/host/workflow-agent.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** A workspace-shaped temp directory, registered for teardown. */
async function workspace(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `devflow-isolation-${label}-`))
  roots.push(root)
  return root
}

/** A live-Agent stand-in carrying only the session facts the resolver reads. */
function sessionAgent(id: string, cwd: string | undefined): Agent {
  return { id, session: { id, header: cwd === undefined ? {} : { cwd } } } as unknown as Agent
}

/** One tool result as the runtime hands it back. */
type ToolCallResult = { readonly isError: boolean; readonly value: unknown; readonly content: readonly { readonly text?: string }[] }

/** The tool runtime the session's tool calls go through. */
async function toolRuntime(defaultRoot: string): Promise<{
  readonly sessionStores: DevFlowSessionStores
  readonly store: DevFlowStore
  readonly call: (name: string, args: Record<string, unknown>, agent: Agent) => Promise<ToolCallResult>
}> {
  const ctx = new Context()
  const fs = new LocalFileSystem(ctx, { cwd: defaultRoot, diffBasisMaxBytes: 1024 * 1024 })
  const sessionStores = new DevFlowSessionStores(fs, './.devflow')
  const mixed = new DevFlowStore(fs, './.devflow')
  new SystemPrompt(ctx, {})
  const tools = new ToolRuntime(ctx)
  registerDevFlowTools(ctx, {
    store: mixed,
    sessionStores,
    workflow: new TaskWorkflow(mixed),
    agentWorkflow: new AgentWorkflow(mixed, new TaskWorkflow(mixed)),
  })
  await Promise.resolve()
  return {
    sessionStores,
    store: mixed,
    call: async (name, args, agent) => await tools.execute({
      callId: `${name}-${agent.id}` as never,
      name,
      arguments: args as never,
      agent,
      signal: new AbortController().signal,
    }) as unknown as ToolCallResult,
  }
}

/** Whether the path exists, for absence assertions. */
async function exists(path: string): Promise<boolean> {
  const { stat } = await import('node:fs/promises')
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

describe('第九步 项目隔离：按会话工作区派生 .devflow', () => {
  it('derives one store per session workspace and refuses a workspace-less session instead of sharing', async () => {
    const workspaceA = await workspace('a')
    const workspaceB = await workspace('b')
    const defaultRoot = await workspace('host')
    const resolver = new DevFlowSessionStores(
      new LocalFileSystem(new Context(), { cwd: defaultRoot, diffBasisMaxBytes: 1024 * 1024 }),
      './.devflow',
    )

    const scopeA = resolver.resolve(sessionAgent('session-a', workspaceA))
    const scopeB = resolver.resolve(sessionAgent('session-b', workspaceB))
    expect(scopeA.storeRoot).toBe(join(workspaceA, '.devflow'))
    expect(scopeB.storeRoot).toBe(join(workspaceB, '.devflow'))
    expect(scopeA.storeRoot).not.toBe(scopeB.storeRoot)
    expect(scopeA.store).not.toBe(scopeB.store)

    // Same workspace ⇒ SAME store: one project, one state, one journal gate.
    expect(resolver.resolve(sessionAgent('session-a-2', workspaceA)).store).toBe(scopeA.store)

    // No workspace fact at all is a REFUSAL, never a fallback to the mixed library.
    expect(() => resolver.resolve(sessionAgent('session-no-cwd', undefined))).toThrow(DevFlowSessionScopeError)
    expect(() => resolver.resolve(undefined)).toThrow(DEVFLOW_SESSION_SCOPE_UNAVAILABLE)
    // The mixed library was never opened by this resolver: nothing to leak.
    expect(resolver.openedRoots).toHaveLength(2)
  })

  it('keeps project A and project B mutually invisible through the real tools', async () => {
    const workspaceA = await workspace('a')
    const workspaceB = await workspace('b')
    const defaultRoot = await workspace('host')
    const runtime = await toolRuntime(defaultRoot)
    const agentA = sessionAgent('session-a', workspaceA)
    const agentB = sessionAgent('session-b', workspaceB)

    const createdA = await runtime.call('devflow_create_task', { title: 'A 贪吃蛇', description: 'snake only' }, agentA)
    expect(createdA.isError).toBe(false)
    const createdB = await runtime.call('devflow_create_task', { title: 'B 网页', description: 'web only' }, agentB)
    expect(createdB.isError).toBe(false)
    await runtime.call('devflow_create_phase', { name: 'A 阶段', description: 'a' }, agentA)
    await runtime.call('devflow_create_phase', { name: 'B 阶段', description: 'b' }, agentB)

    // Cross-check: B's Commander asking for its own state sees B's data ONLY.
    const statusB = await runtime.call('devflow_project_status', {}, agentB)
    const statusA = await runtime.call('devflow_project_status', {}, agentA)
    expect(statusA.value).toEqual({ project: null })
    expect(statusB.value).toEqual({ project: null })
    expect((await readdir(join(workspaceA, '.devflow', 'tasks'))).length).toBe(1)
    expect((await readdir(join(workspaceB, '.devflow', 'tasks'))).length).toBe(1)
    expect((await readdir(join(workspaceA, '.devflow', 'phases'))).length).toBe(1)
    expect((await readdir(join(workspaceB, '.devflow', 'phases'))).length).toBe(1)

    // A's task id must be unknown in B: the ids are the same namespace, the
    // states are not.
    const taskAId = (createdA.value as { id: string }).id
    const taskBId = (createdB.value as { id: string }).id
    expect(taskAId).not.toBe(taskBId)
    const inB = await runtime.call('devflow_transition_task', { taskId: taskAId, transition: 'planned' }, agentB)
    expect(inB.isError).toBe(true)
    expect(JSON.stringify(inB.content)).toContain(taskAId)
    const inA = await runtime.call('devflow_transition_task', { taskId: taskBId, transition: 'planned' }, agentA)
    expect(inA.isError).toBe(true)

    // The host's retained mixed library never received any of it.
    await expect(exists(join(defaultRoot, '.devflow'))).resolves.toBe(false)
    expect(runtime.store.rootPath).toBe('./.devflow')
  })

  it('locks one session to the workspace it started on, even after its cwd moves', async () => {
    const workspaceA = await workspace('a')
    const workspaceB = await workspace('b')
    const resolver = new DevFlowSessionStores(
      new LocalFileSystem(new Context(), { cwd: workspaceA, diffBasisMaxBytes: 1024 * 1024 }),
      './.devflow',
    )
    const agent = sessionAgent('session-locked', workspaceA)
    const first = resolver.resolve(agent)
    // The same session is now observed with another cwd (a workspace switch
    // inside the session). The pin must hold.
    ;(agent.session as unknown as { header: { cwd: string } }).header.cwd = workspaceB
    const second = resolver.resolve(agent)
    expect(second.store).toBe(first.store)
    expect(second.storeRoot).toBe(join(workspaceA, '.devflow'))
    expect(resolver.pinnedRoot('session-locked')).toBe(join(workspaceA, '.devflow'))
  })

  it('names the refusal on the wire instead of answering from shared state', async () => {    const root = await workspace('host')
    const ctx = new Context()
    const fs = new LocalFileSystem(ctx, { cwd: root, diffBasisMaxBytes: 1024 * 1024 })
    const resolver = new DevFlowSessionStores(fs, './.devflow')
    // A project exists in the mixed library: a silent fallback would find it.
    const mixed = new DevFlowStore(fs, './.devflow')
    await mixed.saveProject({ id: 'mixed-project', name: 'Mixed', goal: 'legacy', currentStage: '', createdAt: 'a', updatedAt: 'b' })
    await writeFile(join(root, 'sentinel.txt'), 'present', 'utf8')

    let raised: unknown
    try {
      resolver.resolve(sessionAgent('session-no-cwd', undefined))
    } catch (error) {
      raised = error
    }
    expect(raised).toBeInstanceOf(DevFlowSessionScopeError)
    const refusal = raised as DevFlowSessionScopeError
    expect(refusal.code).toBe(DEVFLOW_SESSION_SCOPE_UNAVAILABLE)
    // The refusal says WHICH session and WHY, in the open.
    expect(refusal.message).toContain('session-no-cwd')
    expect(refusal.message).toContain('no workspace')
    expect(refusal.message).toContain('refusing to fall back to the shared library')
    // Nothing was opened, so the mixed project above was never reachable.
    expect(resolver.openedRoots).toHaveLength(0)
  })

  it('binds each session to its own project through the real preset activation adapter', async () => {
    const workspaceA = await workspace('a')
    const workspaceB = await workspace('b')
    const ctx = new Context()
    new SystemPrompt(ctx, {})
    const tools = new ToolRuntime(ctx)
    tools.register(defineTool({
      name: 'devflow_create_task',
      description: 'commander fixture',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', required: true } } },
        render: (_args, value) => [{ type: 'text', text: value.name }],
      },
      execute: async () => ({ name: 'devflow_create_task' }),
    }))
    const fs = new LocalFileSystem(new Context(), { cwd: workspaceA, diffBasisMaxBytes: 1024 * 1024 })
    const sessionStores = new DevFlowSessionStores(fs, './.devflow')
    const commander = new CommanderMode('你是 DevFlow 总指挥（fixture persona，不含凭据）')
    const activation = new DevFlowPresetActivation(sessionStores, commander, {
      composedPreset: () => 'devflow',
      durablePreset: () => 'devflow',
      now: () => '2026-09-19T00:00:00.000Z',
    })
    /** A scoped Agent whose session header names its workspace. */
    const scopedAgent = (id: string, cwd: string): Agent => {
      const agent = { id, session: { id, header: { cwd } } } as unknown as Agent
      const scope = createScope(ctx, agent)
      Object.assign(agent, { ctx: scope.ctx })
      return agent
    }
    const agentA = scopedAgent('session-a', workspaceA)
    const agentB = scopedAgent('session-b', workspaceB)

    await activation.activate({ agent: agentA, agentCtx: (agentA as { ctx: Context }).ctx, preset: { id: 'devflow' }, kind: 'initial' })
    await activation.activate({ agent: agentB, agentCtx: (agentB as { ctx: Context }).ctx, preset: { id: 'devflow' }, kind: 'initial' })

    // Each project exists in its OWN workspace, and the two records differ: the
    // Commander seat of A is bound to A's project id, not to B's.
    const projectA = JSON.parse(await readFile(join(workspaceA, '.devflow', 'project.json'), 'utf8')) as { id: string }
    const projectB = JSON.parse(await readFile(join(workspaceB, '.devflow', 'project.json'), 'utf8')) as { id: string }
    expect(projectA.id).not.toBe(projectB.id)
    expect(commander.current(agentA).projectId).toBe(projectA.id)
    expect(commander.current(agentB).projectId).toBe(projectB.id)

    // A's activation journal is in A's journal only, and B's in B's: the two
    // journals are different files with the same shape.
    const journalA = (await sessionStores.resolve(agentA).store.listJournal()).map(entry => entry.type)
    const journalB = (await sessionStores.resolve(agentB).store.listJournal()).map(entry => entry.type)
    expect(journalA).toContain('devflow/preset/activated')
    expect(journalB).toContain('devflow/preset/activated')
    expect(journalA.length).toBe(journalB.length)
  })

  it('tags each committed-write signal with its own project, so the live channel can filter', async () => {
    const workspaceA = await workspace('a')
    const workspaceB = await workspace('b')
    const fs = new LocalFileSystem(new Context(), { cwd: workspaceA, diffBasisMaxBytes: 1024 * 1024 })
    const signals: { sessionKey: string | undefined; paths: readonly string[] }[] = []
    const bus = new DevFlowChangeBus({ windowMs: 0, now: () => '2026-09-19T00:00:00.000Z' })
    const resolver = new DevFlowSessionStores(fs, './.devflow', (sessionKey, relativePath, sequence, record) => {
      bus.report(relativePath, sequence, record, sessionKey)
    })
    const unsubscribe = bus.subscribe(signal => signals.push({ sessionKey: signal.sessionKey, paths: signal.changed }))

    const scopeA = resolver.resolve(sessionAgent('session-a', workspaceA))
    const scopeB = resolver.resolve(sessionAgent('session-b', workspaceB))
    await scopeA.store.saveProject({ id: 'project-a', name: 'A', goal: 'a', currentStage: '', createdAt: 'a', updatedAt: 'b' })
    bus.flush()
    await scopeB.store.saveProject({ id: 'project-b', name: 'B', goal: 'b', currentStage: '', createdAt: 'a', updatedAt: 'b' })
    bus.flush()

    expect(signals).toHaveLength(2)
    expect(signals[0]?.sessionKey).toBe(scopeA.sessionKey)
    expect(signals[1]?.sessionKey).toBe(scopeB.sessionKey)
    // The keys are the two projects' roots, and they differ: a subscriber can
    // tell them apart without knowing anything about how they were derived.
    expect(scopeA.sessionKey).toBe(join(workspaceA, '.devflow'))
    expect(scopeB.sessionKey).toBe(join(workspaceB, '.devflow'))
    unsubscribe()
    bus.dispose()
  })
})
