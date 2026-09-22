/**
 * DevFlow human commands: `/devflow init|status|tasks|roles|show|agents|
 * export|import|resume`, a direct command-plane entry that never routes
 * through a model turn. The command child activates only when a command
 * registry is composed.
 * @module @xiaoxie-ide/dsh-devflow/commands
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { BUILTIN_AGENT_ROLES, type AgentRoleId } from './protocol.ts'
import { ROLE_DISPLAY, displayRole } from './display.ts'
import { recordFixedRosterChanges } from './default-agents.ts'
import type { DevFlowStore } from './storage.ts'
import type { DevFlowSessionStores } from './session-store.ts'
import { deriveNewProjectIdentity } from './session-store.ts'
import type { AgentWorkflow } from './workflow-agent.ts'
import { AgentWorkflow as AgentWorkflowClass } from './workflow-agent.ts'
import { TaskWorkflow } from './workflow.ts'
import type { CommanderMode } from './commander-mode.ts'
import type { DevFlowBoundReport } from './preset-activation.ts'
import { ACTIVATION_PHASE_REASONS_ZH } from './activation-reason.ts'
import type { DecisionAnswer, Project } from './types.ts'

/** Services the commands delegate to. */
import { recordDevFlowChange } from './journal.ts'
export interface DevFlowCommandServices {
  /** The retained mixed-library store (host-cwd `./.devflow`). */
  readonly store: DevFlowStore
  /**
   * Per-session-workspace store resolution, when the composition isolates.
   *
   * Every command runs inside one session, so it resolves that session's own
   * project before reading or writing anything: `/devflow tasks` in project B
   * must never list project A's tasks.
   */
  readonly sessionStores?: DevFlowSessionStores
  readonly agentWorkflow: AgentWorkflow
  /** Read the interactive Commander mode after optional host composition settles. */
  readonly getCommanderMode: () => CommanderMode | undefined
  /** Read one session's verified preset activation report, when composed. */
  readonly readPresetActivation?: (agent: Agent) => Promise<DevFlowBoundReport> | undefined
}

/** Render one agent instance's display block: Chinese name, English ids. */
function renderInstance(id: string, role: AgentRoleId, displayName: string): string {
  return `${displayRole(role)} (${displayName})\nid: ${id}\nrole: ${role}`
}

const DEVFLOW_INPUT = {
  hint: 'init <name> | commander enter|exit|status | decision-answer <id> <json> | agent-config <id> <json> | pause | resume-dispatch | status | tasks | roles | show <taskId> | agents | export <taskId> | import <taskId> | resume <taskId>',
  bareBehavior: 'execute' as const,
}
const DEVFLOW_USAGE = `Usage: /devflow ${DEVFLOW_INPUT.hint}`

/**
 * Render current-session activation state and its single next step.
 *
 * The refusal line is the whole point of this read: when an activation was
 * refused, the code alone says nothing an operator can act on, so the fixed
 * Chinese reason and the attempt count are printed beside it. A refusal that
 * happened on the first try and one that survived the whole settle budget read
 * identically otherwise, and they call for different responses.
 */
function renderCommanderStatus(agent: Agent, commanderMode: CommanderMode, report?: DevFlowBoundReport): string {
  const state = commanderMode.current(agent)
  const next = state.mode === 'commander'
    ? 'Send your request as a normal message in this conversation.'
    : 'Run /devflow commander enter in this conversation, then send your request as a normal message.'
  const activationLines = report === undefined ? [] : [
    `Preset: ${report.presetId ?? '(none)'}`,
    `Activation: ${report.activation}${report.activationError === null ? '' : ` (${report.activationError.code})`}${report.verifiedAt === null ? '' : ` · verified ${report.verifiedAt}`}`,
  ]
  const failureLines = report?.lastFailure == null ? [] : [
    `Last activation failure: ${report.lastFailure.code} · ${ACTIVATION_PHASE_REASONS_ZH[report.lastFailure.phase]} · 第 ${report.lastFailure.attempts} 次尝试 · ${report.lastFailure.at}`,
    `原因：${report.lastFailure.reason}`,
  ]
  return [
    'DevFlow is loaded.',
    `Current session: ${agent.session.id}`,
    `Mode: ${state.mode}`,
    `Project: ${state.projectId ?? '(none)'}`,
    ...activationLines,
    ...failureLines,
    next,
    'This release currently dispatches fixed Agents only.',
    'Commander bindings are in memory; enter again after a Host restart.',
  ].join('\n')
}

/**
 * Register the `/devflow` command family on `ctx.commands`.
 * @param ctx - registrant context; the command registers only when a command
 *   registry is composed.
 * @param services - the store, workflow, and optional Commander controller the commands delegate to.
 */
export function registerDevFlowCommands(ctx: Context, services: DevFlowCommandServices): void {
  const { store, sessionStores, agentWorkflow, getCommanderMode, readPresetActivation } = services
  /**
   * The store of the session that is running this command.
   *
   * A single-store composition cannot isolate and says so by omitting
   * `sessionStores`; every real host resolves the command's own workspace, so
   * a command typed in project B reads only project B.
   */
  const storeFor = (agent: Agent): DevFlowStore => sessionStores === undefined ? store : sessionStores.resolve(agent).store

  /**
   * The workspace directory of the session running this command.
   *
   * A new project is NAMED after it, so the name and the store root come from
   * one resolution and cannot disagree. A single-store composition (no
   * `sessionStores`) has no session workspace and answers with the empty string,
   * which the derivation turns into the empty string rather than a made-up name.
   */
  const workspaceFor = (agent: Agent): string => {
    if (sessionStores === undefined) return ''
    return sessionStores.resolve(agent).workspacePath ?? ''
  }

  /**
   * The agent workflow of the session running this command.
   *
   * A store's workflow wrappers are per-store: export/import/resume must run
   * against the SESSION's own project, so a session on another workspace gets
   * its own pair rather than the mixed library's.
   */
  const commandWorkflows = new Map<DevFlowStore, AgentWorkflow>()
  const workflowFor = (agent: Agent): AgentWorkflow => {
    const sessionStore = storeFor(agent)
    if (sessionStore === store) return agentWorkflow
    let sessionWorkflow = commandWorkflows.get(sessionStore)
    if (sessionWorkflow === undefined) {
      sessionWorkflow = new AgentWorkflowClass(sessionStore, new TaskWorkflow(sessionStore))
      commandWorkflows.set(sessionStore, sessionWorkflow)
    }
    return sessionWorkflow
  }

  /** Append shared project and Agent registry facts to the plugin-owned journal. */
  async function hydrateProjectJournal(project: Project, sessionStore: DevFlowStore): Promise<void> {
    await recordDevFlowChange(sessionStore, 'devflow/project/update', { project })
    for (const registered of await sessionStore.listAgents()) {
      await recordDevFlowChange(sessionStore, 'devflow/agent/register', { agent: registered })
    }
  }

  /**
   * Create a project and register the fixed employees that belong to it.
   *
   * A project created WITHOUT an explicit operator name is named after the
   * session workspace it lives in, through the same derivation the preset
   * activation path uses — one function, so the two creation paths can never
   * disagree. `/devflow init <name>` is the explicit case: the operator typed
   * that name, so it is used verbatim.
   * @param sessionStore - the calling session's store.
   * @param workspace - the calling session's workspace directory.
   * @param explicitName - the operator-supplied name, when there was one.
   * @param explicitGoal - the operator-supplied goal, when there was one.
   * @returns the created project.
   */
  async function ensureProject(
    sessionStore: DevFlowStore,
    workspace: string,
    explicitName?: string,
    explicitGoal?: string,
  ): Promise<Project> {
    const derived = deriveNewProjectIdentity(workspace)
    const now = new Date().toISOString()
    const project: Project = {
      id: randomUUID(),
      name: explicitName ?? derived.name,
      // No placeholder ever: an absent goal means "未设定", and writing a
      // meaningful-looking word there would read as a real objective.
      goal: explicitGoal ?? derived.goal,
      currentStage: '',
      createdAt: now,
      updatedAt: now,
    }
    await sessionStore.saveProject(project)
    await recordDevFlowChange(sessionStore, 'devflow/project/update', { project })
    await syncFixedRoster(sessionStore)
    return project
  }

  /**
   * Make the stored fixed-employee roster agree with the shipped configuration.
   *
   * An existing project was initialized by an older revision, so its roster is
   * what the canvas renders and what assignment/dispatch validate against: a
   * fixed employee added or corrected in code afterwards would otherwise stay
   * invisible and undispatchable in production. Only the changed records are
   * journalled, so an unchanged roster writes nothing.
   */
  async function syncFixedRoster(sessionStore: DevFlowStore): Promise<void> {
    await recordFixedRosterChanges(sessionStore)
  }

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'devflow',
      description: 'DevFlow project, task, and agent management',
      input: DEVFLOW_INPUT,
      handler: async ({ agent, rawInput }) => {
        const [verb, ...rest] = rawInput.trim().split(/\s+/)
        const sessionStore = storeFor(agent)
        const commanderMode = getCommanderMode()
        if (verb === '') {
          if (commanderMode === undefined) return { kind: 'error', text: 'devflow: commander mode requires a full Harness host' }
          const report = await readPresetActivation?.(agent)
          return { kind: 'success', text: `${renderCommanderStatus(agent, commanderMode, report)}\n${DEVFLOW_USAGE}` }
        }
        switch (verb) {
          case 'init': {
            const existing = await sessionStore.loadProject()
            if (existing !== undefined) {
              return { kind: 'success', text: `Project already initialized (${existing.id}). Use /devflow commander enter to start.` }
            }
            const input = rest.join(' ').trim()
            if (input === '') return { kind: 'error', text: 'Usage: /devflow init <name> — a project name is required to initialize DevFlow.' }
            const [name = '', ...goalParts] = input.split(/\s+/)
            if (name === '') return { kind: 'error', text: 'Usage: /devflow init <name> — a project name is required to initialize DevFlow.' }
            const goal = goalParts.join(' ').trim()
            const project = await ensureProject(sessionStore, workspaceFor(agent), name, goal)
            return { kind: 'success', text: `Project ${JSON.stringify(project.name)} created (${project.id}) with its fixed agents.` }
          }
          case 'commander': {
            const action = rest[0]
            if (commanderMode === undefined) {
              return { kind: 'error', text: 'devflow: commander mode requires a full Harness host' }
            }
            if (action === 'enter') {
              const existingProject = await sessionStore.loadProject()
              // Prefer the stored project's OWN name in the reply: an existing
              // project keeps the identity it was created with, and echoing a
              // freshly derived name would report a rename that never happened.
              const project = existingProject ?? await ensureProject(sessionStore, workspaceFor(agent))
              if (existingProject !== undefined) await hydrateProjectJournal(project, sessionStore)
              await syncFixedRoster(sessionStore)
              const state = commanderMode.enter(agent, project.id)
              await recordDevFlowChange(sessionStore, 'devflow/commander/mode-enter', { projectId: state.projectId!, sessionId: agent.session.id, at: state.changedAt })
              const initialized = existingProject === undefined ? `项目 ${JSON.stringify(project.name)} 已初始化（按会话工作区派生）。\n` : ''
              return {
                kind: 'success',
                text: `${initialized}Commander entered for this session: ${agent.session.id}\nProject: ${state.projectId}\nSend your request as a normal message in this conversation.\nThis release currently dispatches fixed Agents only.\nEnter Commander again after a Host restart.`,
              }
            }
            if (action === 'exit') {
              const state = commanderMode.exit(agent)
              await recordDevFlowChange(sessionStore, 'devflow/commander/mode-exit', { at: state.changedAt, sessionId: agent.session.id })
              return { kind: 'success', text: `Commander exited for this session: ${agent.session.id}\nHarness native Chat behavior is restored for normal messages.` }
            }
            if (action === 'status') {
              const report = await readPresetActivation?.(agent)
              return { kind: 'success', text: renderCommanderStatus(agent, commanderMode, report) }
            }
            if (action === 'say') {
              const input = rest.slice(1).join(' ').trim()
              if (input === '') return { kind: 'error', text: '/devflow commander say is no longer a command; send the message as normal Chat input.' }
              return { kind: 'error', text: 'Commander requests are normal Chat input; send the message as normal Chat input without /devflow commander say.' }
            }
            return { kind: 'error', text: 'Usage: /devflow commander enter | exit | status' }
          }
          case 'decision-answer': {
            const requestId = (rest[0] ?? '').trim()
            const rawAnswer = rest.slice(1).join(' ').trim()
            if (requestId === '' || rawAnswer === '') return { kind: 'error', text: '/devflow decision-answer needs a request id and answer.' }
            let answer: DecisionAnswer
            try {
              const parsed: unknown = JSON.parse(rawAnswer)
              if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('object required')
              if ('optionId' in parsed && typeof parsed.optionId === 'string') answer = { optionId: parsed.optionId }
              else if ('custom' in parsed && typeof parsed.custom === 'string') answer = { custom: parsed.custom }
              else throw new Error('optionId or custom required')
            } catch {
              return { kind: 'error', text: '/devflow decision-answer received invalid JSON.' }
            }
            await recordDevFlowChange(sessionStore, 'devflow/decision/answer', { requestId, answer, at: new Date().toISOString() })
            return { kind: 'success', text: `Decision ${requestId} answered.` }
          }
          case 'agent-config': {
            const agentId = (rest[0] ?? '').trim()
            const rawPatch = rest.slice(1).join(' ').trim()
            if (agentId === '' || rawPatch === '') return { kind: 'error', text: '/devflow agent-config needs an agent id and JSON patch.' }
            let patch: unknown
            try { patch = JSON.parse(rawPatch) } catch { return { kind: 'error', text: '/devflow agent-config received invalid JSON.' } }
            if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return { kind: 'error', text: '/devflow agent-config needs a JSON object.' }
            const updated = await sessionStore.updateAgentConfig(agentId, patch as { modelConfig?: Record<string, unknown> })
            await recordDevFlowChange(sessionStore, 'devflow/agent/update-config', { agentId, patch: { modelConfig: updated.modelConfig }, at: updated.updatedAt })
            return { kind: 'success', text: `Agent ${agentId} model configuration updated.` }
          }
          case 'pause': {
            await recordDevFlowChange(sessionStore, 'devflow/control/pause', { at: new Date().toISOString() })
            return { kind: 'success', text: 'DevFlow dispatches pause after the current work group.' }
          }
          case 'resume-dispatch': {
            await recordDevFlowChange(sessionStore, 'devflow/control/resume', { at: new Date().toISOString() })
            return { kind: 'success', text: 'DevFlow dispatches resumed.' }
          }
          case 'status': {
            const project = await sessionStore.loadProject()
            if (project === undefined) return { kind: 'success', text: 'No project initialized.' }
            return {
              kind: 'success',
              text: `项目 ${project.name} (${project.id}) ｜ 工作区 ${sessionStore.rootPath}\n阶段：${project.currentStage || '(none)'} ｜ 目标：${project.goal || '(none)'}`,
            }
          }
          case 'tasks': {
            const tasks = await sessionStore.listTasks()
            if (tasks.length === 0) return { kind: 'success', text: `项目 ${sessionStore.rootPath}（本会话工作区）：No tasks.` }
            const lines = tasks.map(task => `${task.id}  ${task.status.padEnd(9)}  ${task.title}`)
            return { kind: 'success', text: `项目 ${sessionStore.rootPath}（本会话工作区）Tasks (${tasks.length}):\n${lines.join('\n')}` }
          }
          case 'roles': {
            const lines = Object.values(BUILTIN_AGENT_ROLES)
              .map(role => `${role.roleId} — ${role.name}: ${role.capabilities.join(', ')}`)
            return { kind: 'success', text: lines.join('\n') }
          }
          case 'show': {
            const taskId = (rest[0] ?? '').trim()
            if (taskId === '') return { kind: 'error', text: '/devflow show needs a task id.' }
            const task = await sessionStore.getTask(taskId)
            if (task === undefined) return { kind: 'error', text: `Unknown task ${taskId}.` }
            return { kind: 'success', text: JSON.stringify(task, null, 2) }
          }
          case 'agents': {
            const instances = await sessionStore.listAgentInstances()
            if (instances.length === 0) {
              const builtins = Object.values(ROLE_DISPLAY)
                .map(display => `${display.icon} ${display.displayName}`)
                .join(' / ')
              return { kind: 'success', text: `No agent instances. Built-in roles: ${builtins}` }
            }
            const blocks = instances.map(instance => renderInstance(instance.id, instance.role, instance.displayName))
            return { kind: 'success', text: blocks.join('\n\n') }
          }
          case 'export': {
            const taskId = (rest[0] ?? '').trim()
            if (taskId === '') return { kind: 'error', text: '/devflow export needs a task id.' }
            const { markdown } = await workflowFor(agent).exportTask(taskId)
            await recordDevFlowChange(sessionStore, 'devflow/bridge/export', { taskId, bridge: 'markdown', at: new Date().toISOString() })
            return { kind: 'success', text: markdown }
          }
          case 'import': {
            const taskId = (rest[0] ?? '').trim()
            if (taskId === '') return { kind: 'error', text: '/devflow import needs a task id.' }
            const markdown = await sessionStore.readImportMarkdown(taskId)
            if (markdown === undefined) {
              return {
                kind: 'success',
                text: `No result document yet. Place the Executor's result at ${sessionStore.rootPath}/imports/${taskId}.md, then run /devflow import ${taskId} again.`,
              }
            }
            const submission = await workflowFor(agent).importResult(taskId, markdown)
            await recordDevFlowChange(sessionStore, 'devflow/task/transition', {
              ...submission.transition.change,
              title: submission.transition.task.title,
            })
            await recordDevFlowChange(sessionStore, 'devflow/bridge/import', {
              taskId,
              resultId: submission.result.id,
              protocolVersion: submission.protocolVersion,
              verdict: submission.verdict,
              at: submission.result.createdAt,
            })
            return {
              kind: 'success',
              text: `Imported result ${submission.result.id} for task ${taskId}; task is now ${submission.transition.task.status}.`,
            }
          }
          case 'resume': {
            const taskId = (rest[0] ?? '').trim()
            if (taskId === '') return { kind: 'error', text: '/devflow resume needs a task id.' }
            const { resume } = await workflowFor(agent).resumeTask(taskId)
            await recordDevFlowChange(sessionStore, 'devflow/planner/resume', { taskId, at: new Date().toISOString() })
            return { kind: 'success', text: resume }
          }
          default:
            return {
              kind: 'error',
              text: `Unknown /devflow verb. ${DEVFLOW_USAGE}`,
            }
        }
      },
    })
  })
}
