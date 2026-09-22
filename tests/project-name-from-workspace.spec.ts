/**
 * N5 前收口 · 段二：新项目的 `name` 按会话工作区派生、`goal` 为空。
 *
 * 两条**生产接线**各一条用例（不是手搓 props）：
 *  - preset 激活路径：`DevFlowPresetActivation` + 真 `DevFlowSessionStores` + 真 store；
 *  - 命令路径：`/devflow commander enter`（命令注册表真跑一遍 `ctx.commands.execute`）。
 *
 * 命名规则本身（basename / 根路径回退 / 空串）另有一条纯函数用例。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Session, SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { registerDevFlowCommands } from '../src/host/commands.ts'
import { CommanderMode } from '../src/host/commander-mode.ts'
import { DevFlowPresetActivation } from '../src/host/preset-activation.ts'
import { DevFlowSessionStores, deriveNewProjectIdentity, deriveProjectNameFromWorkspace } from '../src/host/session-store.ts'
import { DevFlowStore } from '../src/host/storage.ts'
import { TaskWorkflow } from '../src/host/workflow.ts'
import { AgentWorkflow } from '../src/host/workflow-agent.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** A workspace-shaped temp directory whose LAST SEGMENT is the name under test. */
async function workspaceNamed(leaf: string): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'devflow-name-'))
  roots.push(parent)
  const workspace = join(parent, leaf)
  await mkdirp(workspace)
  return workspace
}

async function mkdirp(path: string): Promise<void> {
  const { mkdir } = await import('node:fs/promises')
  await mkdir(path, { recursive: true })
}

/** The raw project record a store wrote, read straight off disk. */
async function projectRecordOnDisk(workspace: string): Promise<{ name: string; goal: string }> {
  return JSON.parse(await readFile(join(workspace, '.devflow', 'project.json'), 'utf8')) as { name: string; goal: string }
}

const commanderTool = defineTool({
  name: 'devflow_create_task',
  description: 'commander-view fixture',
  parameters: {},
  output: {
    schema: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', required: true } } },
    render: (_args, value) => [{ type: 'text', text: value.name }],
  },
  execute: async () => ({ name: 'devflow_create_task' }),
})

describe('N5 前收口 · 新项目名按工作区派生', () => {
  it('derives the name from the workspace last segment, with a total rule', () => {
    expect(deriveProjectNameFromWorkspace('D:\\Desktop\\贪吃蛇')).toBe('贪吃蛇')
    expect(deriveProjectNameFromWorkspace('D:\\Desktop\\贪吃蛇\\')).toBe('贪吃蛇')
    expect(deriveProjectNameFromWorkspace('/home/xiebin/DevFlow-N5')).toBe('DevFlow-N5')
    // A drive / filesystem root has no last SEGMENT: fall back to the path's own
    // last non-empty piece rather than inventing a label.
    expect(deriveProjectNameFromWorkspace('C:\\')).toBe('C:')
    expect(deriveProjectNameFromWorkspace('/')).toBe('/')
    // Nothing usable at all (a single-store composition) ⇒ the input verbatim,
    // never a hard-coded placeholder name.
    expect(deriveProjectNameFromWorkspace('')).toBe('')
    // `goal` is EMPTY by construction: no placeholder is written.
    expect(deriveNewProjectIdentity('D:\\Desktop\\贪吃蛇')).toEqual({ name: '贪吃蛇', goal: '' })
  })

  it('preset activation names a new project after its workspace and leaves the goal empty', async () => {
    const workspace = await workspaceNamed('贪吃蛇')
    const ctx = new Context()
    new SystemPrompt(ctx, {})
    const tools = new ToolRuntime(ctx)
    tools.register(commanderTool)
    const fs = new LocalFileSystem(new Context(), { cwd: workspace, diffBasisMaxBytes: 1024 * 1024 })
    const sessionStores = new DevFlowSessionStores(fs, './.devflow')
    const commander = new CommanderMode('你是 DevFlow 总指挥（fixture persona）')
    const activation = new DevFlowPresetActivation(sessionStores, commander, {
      composedPreset: () => 'devflow',
      durablePreset: () => 'devflow',
      now: () => '2026-09-19T00:00:00.000Z',
    })
    const agent = {
      id: 'session-name-preset',
      session: { id: 'session-name-preset', header: { cwd: workspace } },
    } as unknown as Agent
    Object.assign(agent, { ctx: createScope(ctx, agent).ctx })

    await activation.activate({
      agent,
      agentCtx: (agent as { ctx: Context }).ctx,
      preset: { id: 'devflow' },
      kind: 'initial',
    })

    const record = await projectRecordOnDisk(workspace)
    expect(record.name).toBe('贪吃蛇')
    expect(record.goal).toBe('')
  })

  it('`/devflow commander enter` names a new project after its workspace too', async () => {
    const workspace = await workspaceNamed('DevFlow-N5')
    const ctx = new Context()
    await ctx.plugin(CommandRuntime)
    const fs = new LocalFileSystem(new Context(), { cwd: workspace, diffBasisMaxBytes: 1024 * 1024 })
    const sessionStores = new DevFlowSessionStores(fs, './.devflow')
    const mixed = new DevFlowStore(fs, './.devflow')
    let activeProjectId: string | null = null
    registerDevFlowCommands(ctx, {
      store: mixed,
      sessionStores,
      agentWorkflow: new AgentWorkflow(mixed, new TaskWorkflow(mixed)),
      getCommanderMode: () => ({
        enter: (active: Agent, projectId: string) => {
          activeProjectId = projectId
          return { mode: 'commander' as const, projectId, sessionId: active.id, changedAt: 'entered' }
        },
        exit: () => {
          activeProjectId = null
          return { mode: 'chat' as const, projectId: null, sessionId: null, changedAt: 'exited' }
        },
        current: (active: Agent) => activeProjectId === null
          ? { mode: 'chat' as const, projectId: null, sessionId: null, changedAt: '' }
          : { mode: 'commander' as const, projectId: activeProjectId, sessionId: active.id, changedAt: 'entered' },
      }),
    })
    // The session's own cwd IS the workspace (carried on its immutable header),
    // so the command resolves its store through the same session fact the host
    // uses — no hand-built scope object anywhere.
    const session = Session.create(SessionId('session-name-command'), [], {
      version: SESSION_FORMAT_VERSION,
      id: SessionId('session-name-command'),
      createdAt: 1,
      isSeeded: false,
      cwd: workspace,
    })
    const agent = { id: SessionId('session-name-command'), session } as unknown as Agent & { session: Session }
    Object.assign(agent, { ctx: createScope(ctx, agent).ctx })
    await Promise.resolve()

    const result = await ctx.commands.execute(agent, '/devflow commander enter', [], new AbortController().signal)
    expect(result?.result).toMatchObject({ kind: 'success' })

    const record = await projectRecordOnDisk(workspace)
    expect(record.name).toBe('DevFlow-N5')
    expect(record.goal).toBe('')
    // An EXISTING project must not be renamed by a second enter.
    Object.assign(record, { name: '手改名字' })
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(workspace, '.devflow', 'project.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    activeProjectId = null
    await ctx.commands.execute(agent, '/devflow commander enter', [], new AbortController().signal)
    expect((await projectRecordOnDisk(workspace)).name).toBe('手改名字')
  })
})
