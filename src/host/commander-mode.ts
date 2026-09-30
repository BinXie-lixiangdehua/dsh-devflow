/** Current-session Commander persona lifecycle for DevFlow developer mode. */

import type { Agent } from '@deepseek-ai/dsh-agent'

/** The harness interaction mode: native chat or the DevFlow Commander persona. */
export type HarnessMode = 'chat' | 'commander'

/** The current Developer mode state projected into one session. */
export interface CommanderModeState {
  /** Current user interaction mode. */
  readonly mode: HarnessMode
  /** The current session agent identity, or null outside Commander mode. */
  readonly sessionId: string | null
  /** Project the current session Agent drives, or null outside Commander mode. */
  readonly projectId: string | null
  /** Mode transition timestamp, ISO 8601. */
  readonly changedAt: string
}

const COMMANDER_TOOL_NAMES = [
  'ask_user_question',
  'devflow_project_status', 'devflow_create_task', 'devflow_transition_task', 'devflow_submit_result',
  'devflow_create_task_package', 'devflow_export_task', 'devflow_import_result', 'devflow_resume',
  'devflow_create_phase', 'devflow_update_phase', 'devflow_set_scope', 'devflow_clear_scope', 'devflow_assign_agent',
  'devflow_request_decision', 'devflow_pause', 'devflow_resume_dispatch', 'devflow_dispatch_agent',
  // Employee registration. It must stay reachable through the Commander seat:
  // the tool's own allow-list is "the caller holds the Commander seat", so a
  // restriction that hid the tool would make it unreachable by its only
  // authorized caller.
  'devflow_agent_upsert',
  // Read-only navigation: the Commander reads the project's own navigation files
  // at kickoff (root rule file, then `docs/`). These three are the ONLY native
  // tools allowed through; no writing or shell tool may be appended here.
  'read', 'glob', 'grep',
] as const

/**
 * Tools the Commander seat must never EXECUTE: every mutating, shell, and
 * foreign-orchestration capability the native surface can offer. This is the
 * list the armed execution guard denies — see {@link CommanderMode.verify} and
 * {@link commanderDenialReason} for why the guarantee lives at execution rather
 * than in the visible schema set.
 *
 * Kept as an explicit DENY list rather than derived from the allow-list on
 * purpose: a tool that is neither allow-listed nor dangerous (an unrelated
 * preset's read-only helper) must not fail the activation, while a new native
 * writer must. Anything added here is a hard guarantee, so additions need the
 * same review a `restrict()` allow-list change gets.
 *
 * ⚠️ The native Agent-Team family (`spawn_teammate`, `wait_agent`,
 * `interrupt_agent`, `team_task_*`) was added 2026-10-01 from a MEASURED
 * sandbox `VISIBLE` list, not from a guess: `@deepseek-ai/dsh-tool-agent-team`
 * and `@deepseek-ai/dsh-tool-subagent-control` register those tools into each
 * Agent's OWN scope, where `tools.restrict()` cannot name or hide them (see the
 * `restrict()` note below), so before the guard existed they were executable
 * through the Commander seat even though `send_message`/`list_agents` were not.
 * A delegation hatch that can spawn a native subagent, or a second task board
 * competing with DevFlow's own, is exactly what this seat must not reach; the
 * addition is a STRICTNESS increase and never shortens this list.
 */
const COMMANDER_FORBIDDEN_TOOL_NAMES = [
  // File mutation.
  'write', 'edit', 'multi_edit', 'notebook_edit',
  // Shell / process execution.
  'bash', 'pwsh', 'run_command', 'run_code',
  // Non-devflow delegation and workflow escape hatches.
  'subagent', 'subagent_fork', 'subagent_codex', 'subagent_claude_code',
  'send_message', 'list_agents', 'workflow', 'ralph',
  // Native Agent-Team orchestration: an own-scope registration that no
  // `restrict()` can hide, and a competing delegation/task plane.
  'spawn_teammate', 'wait_agent', 'interrupt_agent',
  'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
  // Browser / web mutation and retrieval outside the Commander's remit.
  'web_search', 'web_fetch', 'browser', 'browser_use',
  // Harness-level state the Commander must not drive directly.
  'todo_write', 'exit_plan_mode', 'enter_plan_mode',
  'job_output', 'job_list', 'job_kill',
] as const

/**
 * The part of a tool execution the Commander guard reads.
 *
 * Declared structurally (rather than importing the host's `ToolExecution`) so
 * this module keeps compiling against any published `@deepseek-ai/dsh-tools`
 * snapshot: the registered guard is handed the full execution object, of which
 * only these two fields are ever consulted.
 */
interface CommanderGuardedExecution {
  /** The tool name the call names. */
  readonly name: string
  /** The Agent on whose behalf the call runs. */
  readonly agent?: Agent
}

/** The Commander seat's monotonic execution guard. */
type CommanderGuard = (execution: CommanderGuardedExecution) => string | undefined

/**
 * The armed guard's verdict for one execution.
 *
 * Returning a string DENIES the call: the executor materializes
 * `Error: ${denialReason}` with `isError: true` before the tool body runs
 * (`@deepseek-ai/dsh-tools` `ToolRuntime` `guardReason` → `execute`).
 *
 * This is the seat's actual security boundary. `tools.restrict()` cannot be:
 * a restriction filters only what a scope INHERITS, while a scope's own
 * registrations stay visible unconditionally (`view()`: "The scope's own
 * registrations last, shadowing an inherited name and OUTSIDE the filter
 * above"). `guard()` is evaluated along the whole scope chain
 * (`guardReason(exec)` iterates `chainLayers(exec.agent)`), so it denies a
 * capability no matter which layer registered it.
 * @param execution - the call about to run.
 * @returns the denial reason, or undefined to let the call through.
 */
function commanderDenialReason(execution: CommanderGuardedExecution): string | undefined {
  return (COMMANDER_FORBIDDEN_TOOL_NAMES as readonly string[]).includes(execution.name)
    ? `devflow: the Commander seat denies "${execution.name}" — no native write, shell, or foreign orchestration capability is reachable in Commander mode`
    : undefined
}

interface ActiveCommander {
  readonly projectId: string
  readonly disposePersona: () => void
  readonly disposeTools: () => void
  readonly disposeGuard: () => void
  /** The exact guard value registered above, so `verify` can probe it. */
  readonly guard: CommanderGuard
  readonly disposePresentation: () => void
  readonly changedAt: string
}

/**
 * Installs the Commander persona into the current session Agent's scoped
 * system prompt. It creates neither an Agent nor a Session: normal user input
 * remains in the same native conversation while DevFlow state stays in the
 * plugin-owned `.devflow` store.
 */
export class CommanderMode {
  private readonly active = new Map<string, ActiveCommander>()

  constructor(private readonly persona: string) {}

  /** Enter Commander mode for the current session Agent. */
  enter(agent: Agent, projectId: string): CommanderModeState {
    if (projectId.trim() === '') throw new Error('devflow: commander mode needs a non-empty projectId')
    // Re-selecting the SAME project for an already-bound Agent is a no-op: the
    // preset activation transaction relies on idempotent enter to avoid
    // re-installing persona/tool/presentation layers on repeat selection.
    const current = this.active.get(agent.id)
    if (current?.projectId === projectId) {
      return { mode: 'commander', sessionId: agent.id, projectId, changedAt: current.changedAt }
    }
    this.exit(agent)
    const changedAt = new Date().toISOString()
    const disposePresentation = agent.ctx.tools.presentAs('native')
    try {
      // `restrict()` is a usability optimization only — it keeps the Commander's
      // model-facing schema list small — and explicitly NOT the security
      // boundary: it cannot name or filter a scope's own registrations.
      const available = new Set(agent.ctx.tools.schemas(agent).map(tool => tool.name))
      const disposeTools = agent.ctx.tools.restrict({
        allow: COMMANDER_TOOL_NAMES.filter(name => available.has(name)),
      })
      try {
        // ...whereas the guard IS the boundary. It is chain-wide, so every name
        // on the deny list is denied whatever layer registered it.
        const guard: CommanderGuard = execution => commanderDenialReason(execution)
        const disposeGuard = agent.ctx.tools.guard(execution => guard(execution))
        try {
          const disposePersona = agent.ctx.systemPrompt.section({
            name: 'devflow-commander-persona',
            order: 1,
            text: this.persona,
          })
          this.active.set(agent.id, {
            projectId, disposePersona, disposeTools, disposeGuard, guard, disposePresentation, changedAt,
          })
        } catch (error) {
          disposeGuard()
          disposeTools()
          throw error
        }
      } catch (error) {
        disposeTools()
        throw error
      }
    } catch (error) {
      disposePresentation()
      throw error
    }
    return { mode: 'commander', sessionId: agent.id, projectId, changedAt }
  }

  /** Remove the Commander persona from the current session Agent. */
  exit(agent: Agent): CommanderModeState {
    const active = this.active.get(agent.id)
    if (active !== undefined) {
      this.active.delete(agent.id)
      try {
        active.disposePersona()
      } finally {
        try {
          active.disposeGuard()
        } finally {
          try {
            active.disposeTools()
          } finally {
            active.disposePresentation()
          }
        }
      }
    }
    return { mode: 'chat', sessionId: null, projectId: null, changedAt: new Date().toISOString() }
  }

  /** Read one session Agent's mode state. */
  current(agent: Agent): CommanderModeState {
    const active = this.active.get(agent.id)
    return active === undefined
      ? { mode: 'chat', sessionId: null, projectId: null, changedAt: '' }
      : { mode: 'commander', sessionId: agent.id, projectId: active.projectId, changedAt: active.changedAt }
  }

  /**
   * Verify that one Agent's Commander installation is live and complete.
   *
   * Map presence alone is not proof, and neither is the visible schema set: the
   * entry records that persona, tools, guard, and presentation disposers were
   * installed, but only evaluating the ARMED GUARD can confirm the seat still
   * refuses what it must.
   *
   * The visible-tool assertion this method used to carry ("every visible name is
   * allow-listed", later "no forbidden name is visible") is NOT satisfiable and
   * therefore cannot be the criterion. `tools.restrict()` masks only the
   * INHERITED surface — a scope's own registrations stay visible
   * unconditionally (`@deepseek-ai/dsh-tools` `view()`: "The scope's own
   * registrations last, shadowing an inherited name and OUTSIDE the filter
   * above"). A MEASURED sandbox activation (2026-10-01) showed exactly two
   * deny-listed names still visible after `restrict({ allow })` —
   * `send_message` and `list_agents`, both registered into the Agent's own
   * scope by the profile's Agent-Team rows — so every activation was refused
   * with {@link DEVFLOW_ACTIVATION_CODES.verificationFailed}, which exits
   * Commander and silently downgrades the session to the native persona. That
   * is the bug this criterion change fixes; the guarantee itself was never
   * lost, because it moved to the chain-wide execution guard.
   *
   * What is asserted instead is functional, not structural: the exact guard
   * value registered by {@link enter} must still deny EVERY name on
   * {@link COMMANDER_FORBIDDEN_TOOL_NAMES} and must not deny a reviewed
   * Commander tool. A guard that was never armed, was disarmed, or lost its
   * deny list fails the activation closed.
   * @param agent - the session Agent to verify.
   * @param projectId - when given, the entry must be bound to this project.
   */
  verify(agent: Agent, projectId?: string): { readonly ok: boolean; readonly failureCode?: 'devflow-mode-not-installed' | 'devflow-project-mismatch' | 'devflow-tool-restriction-missing' } {
    const active = this.active.get(agent.id)
    if (active === undefined) return { ok: false, failureCode: 'devflow-mode-not-installed' }
    if (projectId !== undefined && active.projectId !== projectId) {
      return { ok: false, failureCode: 'devflow-project-mismatch' }
    }
    for (const name of COMMANDER_FORBIDDEN_TOOL_NAMES) {
      if (active.guard({ name, agent }) === undefined) {
        return { ok: false, failureCode: 'devflow-tool-restriction-missing' }
      }
    }
    // Fail closed the other way too: a guard that denies everything would leave
    // the Commander unable to orchestrate at all, and would otherwise read as a
    // healthy activation because it satisfies the deny checks above.
    if (active.guard({ name: COMMANDER_TOOL_NAMES[0], agent }) !== undefined) {
      return { ok: false, failureCode: 'devflow-tool-restriction-missing' }
    }
    return { ok: true }
  }
}
