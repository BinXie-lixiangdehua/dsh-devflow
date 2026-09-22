import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { registerDevFlowCommands } from '../src/host/commands.ts'
import { DEVFLOW_ACTIVATION_CODES } from '../src/host/preset-activation.ts'
import { activationReasonZh } from '../src/host/activation-reason.ts'

const signal = new AbortController().signal

interface Project {
  readonly id: string
  readonly name: string
  readonly goal: string
  readonly currentStage: string
  readonly createdAt: string
  readonly updatedAt: string
}

function agent(id = 'command-agent'): Agent & { readonly session: Session } {
  const session = Session.create(SessionId(id))
  return { id: SessionId(id), session } as Agent & { session: Session }
}

describe('/devflow command input', () => {
  it('distinguishes bare help, complete subcommands, and an unknown verb', async () => {
    const ctx = new Context()
    await ctx.plugin(CommandRuntime)
    const projects: Project[] = []
    let activeProjectId: string | null = null
    const store = {
      loadProject: vi.fn(async () => projects[0]),
      appendJournal: vi.fn(async (type: string, data: unknown) => ({
        sequence: 0, id: '00000000-0000-4000-8000-000000000000', type, data, at: 'now',
      })),
      saveProject: vi.fn(async (project: Project) => { projects.splice(0, projects.length, project) }),
      listAgents: vi.fn(async () => []),
      // Project creation reconciles the stored fixed-employee roster against the
      // shipped configuration before it returns, so the stub needs the same
      // single-agent read the reconciliation starts from.
      getAgent: vi.fn(async () => undefined),
      registerAgent: vi.fn(async input => input),
      listAgentInstances: vi.fn(async () => []),
      listTasks: vi.fn(async () => []),
      getTask: vi.fn(),
      updateAgentConfig: vi.fn(),
      readImportMarkdown: vi.fn(),
    }
    const workflow = { exportTask: vi.fn(), importResult: vi.fn(), resumeTask: vi.fn() }
    registerDevFlowCommands(ctx, {
      store: store as never,
      agentWorkflow: workflow as never,
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
    const current = agent()
    const scope = createScope(ctx, current)
    Object.assign(current, { ctx: scope.ctx })
    await Promise.resolve()
    expect(ctx.commands.find(current, 'devflow')).toMatchObject({
      input: { hint: expect.not.stringContaining('commander say') },
    })
    const run = (line: string) => ctx.commands.execute(current, line, [], signal)
    const runs = () => current.session.snapshotEvents().filter(event => event.type === 'command/run')
    const dones = () => current.session.snapshotEvents().filter(event => event.type === 'command/done')

    const bare = await run('/devflow')
    expect(bare?.result).toMatchObject({ kind: 'success' })
    const bareText = bare?.result.text ?? ''
    expect(bareText).toContain('DevFlow is loaded.')
    expect(bareText).toContain('Current session: command-agent')
    expect(bareText).toContain('Mode: chat')
    expect(bareText).toContain('/devflow commander enter')
    expect(bareText).toContain('fixed Agents only')
    expect(bareText).toContain('Host restart')
    expect(bareText).not.toContain('commander say')
    expect(projects).toHaveLength(0)
    const bareRun = runs().at(-1)
    const bareDone = dones().at(-1)
    expect(bareRun?.data).toMatchObject({ name: 'devflow', args: '' })
    expect(bareDone?.data).toMatchObject({ commandId: bareRun?.data.commandId, kind: 'success', text: bareText })

    const bareInit = await run('/devflow init')
    expect(bareInit?.result).toMatchObject({
      kind: 'error', text: expect.stringContaining('Usage: /devflow init <name>'),
    })
    expect(projects).toHaveLength(0)
    expect(store.saveProject).not.toHaveBeenCalled()
    expect(store.registerAgent).not.toHaveBeenCalled()
    expect(runs().at(-1)?.data).toMatchObject({ name: 'devflow', args: ' init' })

    const initialized = await run('/devflow init test-project')
    expect(initialized?.result.kind).toBe('success')
    expect(projects[0]).toMatchObject({ name: 'test-project' })
    expect(runs().at(-1)?.data).toMatchObject({ name: 'devflow', args: ' init test-project' })

    const repeatedInit = await run('/devflow init')
    expect(repeatedInit?.result).toMatchObject({
      kind: 'success', text: expect.stringContaining('Project already initialized'),
    })
    expect(projects).toHaveLength(1)
    expect(store.saveProject).toHaveBeenCalledTimes(1)
    expect(store.registerAgent).toHaveBeenCalledTimes(5)
    expect(runs().at(-1)?.data).toMatchObject({ name: 'devflow', args: ' init' })

    const status = await run('/devflow commander status')
    expect(status?.result).toMatchObject({ kind: 'success' })
    expect(status?.result.text).toContain('Mode: chat')
    expect(status?.result.text).toContain('Current session: command-agent')
    expect(status?.result.text).toContain('/devflow commander enter')
    expect(runs().at(-1)?.data).toMatchObject({ name: 'devflow', args: ' commander status' })

    const entered = await run('/devflow commander enter')
    expect(entered?.result).toMatchObject({ kind: 'success' })
    expect(entered?.result.text).toContain('Commander entered for this session: command-agent')
    expect(entered?.result.text).toContain('Send your request as a normal message')
    expect(entered?.result.text).toContain('fixed Agents only')
    expect(entered?.result.text).toContain('Host restart')
    expect(activeProjectId).toBe(projects[0]?.id)

    const activeStatus = await run('/devflow commander status')
    expect(activeStatus?.result.text).toContain('Mode: commander')
    expect(activeStatus?.result.text).toContain('Current session: command-agent')
    expect(activeStatus?.result.text).toContain('Send your request as a normal message')

    const legacySay = await run('/devflow commander say hello')
    expect(legacySay?.result).toMatchObject({ kind: 'error', text: expect.stringContaining('send the message as normal Chat input') })

    const exited = await run('/devflow commander exit')
    expect(exited?.result).toMatchObject({ kind: 'success' })
    expect(exited?.result.text).toContain('Commander exited for this session: command-agent')
    expect(exited?.result.text).toContain('Harness native Chat behavior is restored')
    expect(activeProjectId).toBeNull()

    const unknown = await run('/devflow frobnicate')
    expect(unknown?.result).toMatchObject({ kind: 'error', text: expect.stringContaining('Unknown /devflow verb') })
    await scope.dispose()
    await ctx.fiber.dispose()
  })

  /**
   * The refusal line is the whole point of the status read: a code alone tells
   * an operator nothing they can act on. This asserts the rendered text, not the
   * table, so a mapping that exists but is never printed still fails here.
   */
  it('prints the recorded refusal with its Chinese reason and settled attempt count', async () => {
    const ctx = new Context()
    await ctx.plugin(CommandRuntime)
    const store = {
      loadProject: vi.fn(async () => undefined),
      appendJournal: vi.fn(async (type: string, data: unknown) => ({
        sequence: 0, id: '00000000-0000-4000-8000-000000000000', type, data, at: 'now',
      })),
      listAgents: vi.fn(async () => []),
      listAgentInstances: vi.fn(async () => []),
    }
    registerDevFlowCommands(ctx, {
      store: store as never,
      agentWorkflow: { exportTask: vi.fn(), importResult: vi.fn(), resumeTask: vi.fn() } as never,
      getCommanderMode: () => ({
        enter: vi.fn(), exit: vi.fn(),
        current: (active: Agent) => ({ mode: 'chat' as const, projectId: null, sessionId: active.id, changedAt: '' }),
      }),
      readPresetActivation: async active => ({
        presetId: 'devflow',
        commanderMode: 'chat',
        projectId: null,
        activation: 'error',
        activationError: {
          code: DEVFLOW_ACTIVATION_CODES.verificationFailed,
          message: 'DevFlow activation could not be verified for this session.',
        },
        verifiedAt: null,
        lastFailure: {
          code: DEVFLOW_ACTIVATION_CODES.verificationFailed,
          phase: 'recompose',
          attempts: 4,
          reason: activationReasonZh(DEVFLOW_ACTIVATION_CODES.verificationFailed),
          at: '2026-09-16T12:00:00.000Z',
        },
      }),
    })
    const current = agent('status-agent')
    const scope = createScope(ctx, current)
    Object.assign(current, { ctx: scope.ctx })
    await Promise.resolve()

    const status = await ctx.commands.execute(current, '/devflow commander status', [], signal)
    const text = status?.result.text ?? ''
    expect(text).toContain(`Activation: error (${DEVFLOW_ACTIVATION_CODES.verificationFailed})`)
    expect(text).toContain(`Last activation failure: ${DEVFLOW_ACTIVATION_CODES.verificationFailed}`)
    expect(text).toContain('切换 preset')
    expect(text).toContain('第 4 次尝试')
    expect(text).toContain('原因：')
    expect(text).toContain(activationReasonZh(DEVFLOW_ACTIVATION_CODES.verificationFailed))

    await scope.dispose()
    await ctx.fiber.dispose()
  })
})
