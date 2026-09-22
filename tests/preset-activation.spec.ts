import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import type { DevFlowActivationInput } from '../src/host/preset-activation.ts'
import { CommanderMode } from '../src/host/commander-mode.ts'
import { DevFlowStore } from '../src/host/storage.ts'
import {
  DevFlowPresetActivation, DEVFLOW_PRESET_ID, DEVFLOW_ACTIVATION_CODES, activateWithSettle,
  type DevFlowBoundReport,
} from '../src/host/preset-activation.ts'
import { ACTIVATION_CODE_REASONS_ZH, ACTIVATION_PHASE_REASONS_ZH, activationReasonZh } from '../src/host/activation-reason.ts'

const COMMANDER_TOOL = 'devflow_create_task'
const NATIVE_TOOL = 'read'
const OTHER_TOOL = 'write'
const NOW = '2026-09-10T00:00:00.000Z'

/**
 * The Commander's restricted view: its DevFlow tools plus the read-only lookups
 * (`read`/`glob`/`grep`) that step 8 lets through for kickoff navigation reading.
 * `OTHER_TOOL` is `write`, which must never be visible through this seat.
 */
const COMMANDER_VIEW: string[] = [COMMANDER_TOOL, NATIVE_TOOL].sort()
/** The unrestricted view for these fixtures: everything they registered. */
const FULL_VIEW: string[] = [COMMANDER_TOOL, NATIVE_TOOL, OTHER_TOOL].sort()

function tool(name: string) {
  return defineTool({
    name,
    description: `${name} fixture`,
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { name: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.name }],
    },
    execute: async () => ({ name }),
  })
}

/** One isolated test environment: host ctx + file store + Commander + adapter. */
async function environment(presetOf: (agent: Agent) => string | undefined, rootHint = '') {
  const root = await mkdtemp(join(tmpdir(), `devflow-activation-${rootHint}-`))
  const ctx = new Context()
  new SystemPrompt(ctx, {})
  const tools = new ToolRuntime(ctx)
  tools.register(tool(COMMANDER_TOOL))
  tools.register(tool(NATIVE_TOOL))
  tools.register(tool(OTHER_TOOL))
  const store = new DevFlowStore(new LocalFileSystem(new Context(), { cwd: root, diffBasisMaxBytes: 1024 * 1024 }), './.devflow')
  const commander = new CommanderMode('你是 DevFlow 总指挥（fixture persona，不含凭据）')
  const activation = new DevFlowPresetActivation(store, commander, {
    composedPreset: agent => presetOf(agent),
    durablePreset: agent => presetOf(agent),
    now: () => NOW,
  })

  function makeAgent(id: string): Agent & { readonly ctx: Context; readonly dispose: () => Promise<void> } {
    const agent = { id } as Agent
    const scope = createScope(ctx, agent)
    Object.assign(agent, { ctx: scope.ctx })
    return Object.assign(agent, { dispose: () => scope.dispose() })
  }

  function input(agent: Agent, presetId = DEVFLOW_PRESET_ID, kind: 'initial' | 'recompose' = 'initial'): DevFlowActivationInput {
    return {
      agent,
      agentCtx: (agent as { ctx: Context }).ctx,
      preset: { id: presetId },
      kind,
    } as DevFlowActivationInput
  }

  return {
    ctx,
    tools,
    store,
    commander,
    activation,
    makeAgent,
    input,
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

function toolNames(tools: ToolRuntime, agent: Agent): string[] {
  return tools.schemas(agent).map(schema => schema.name).sort()
}

const devflow = (): string => DEVFLOW_PRESET_ID
const journalTypes = async (store: DevFlowStore): Promise<string[]> =>
  (await store.listJournal()).map(entry => entry.type)

describe('DevFlow preset activation adapter', () => {
  it('binds one Agent: preset identity, one shared project, persona+tools, journal record', async () => {
    const env = await environment(devflow, 'bound')
    try {
      const agent = env.makeAgent('session-bound')
      const provider = env.activation.createProvider()

      const lease = await provider.activate(env.input(agent))

      expect(lease).toBeDefined()
      expect(env.commander.current(agent)).toMatchObject({ mode: 'commander', sessionId: agent.id })
      expect(toolNames(env.tools, agent)).toEqual(COMMANDER_VIEW)
      const project = await env.store.loadProject()
      expect(project).toBeDefined()
      expect(project?.id).not.toBe('')
      expect(env.commander.verify(agent, project?.id).ok).toBe(true)

      const report = await env.activation.report(agent)
      expect(report).toMatchObject({
        presetId: DEVFLOW_PRESET_ID,
        commanderMode: 'commander',
        activation: 'bound',
        activationError: null,
        verifiedAt: NOW,
      })
      expect(report.projectId).toBe(project?.id)
      // Journal is audit-only and carries exactly session/project/preset ids.
      const entries = await env.store.listJournal()
      expect(entries.map(entry => entry.type)).toContain('devflow/preset/activated')
      const activationRecord = entries.find(entry => entry.type === 'devflow/preset/activated')
      expect(activationRecord?.data).toMatchObject({
        sessionId: agent.id, projectId: project?.id, presetId: DEVFLOW_PRESET_ID,
      })
    } finally {
      await env.cleanup()
    }
  })

  it('refuses to activate a session whose live preset is not devflow, with a stable code', async () => {
    const env = await environment(() => 'standard', 'mismatch')
    try {
      const agent = env.makeAgent('session-not-devflow')
      const failure = await env.activation.activate(env.input(agent)).then(
        () => null,
        (error: unknown) => error,
      )
      const activationCode = (failure as { activationCode?: unknown } | null)?.activationCode
      expect(activationCode).toBe(DEVFLOW_ACTIVATION_CODES.presetIdentityMismatch)
      expect(env.commander.current(agent).mode).toBe('chat')
      // "No journal noise" still means what it meant: a refused activation
      // publishes no activation lifecycle record. It now also leaves exactly
      // one REFUSAL record, which is the durable half of the self-evidence —
      // the refusal is the thing that must survive, not a claimed activation.
      const journal = await env.store.listJournal()
      expect(journal.filter(entry => entry.type === 'devflow/preset/activated' || entry.type === 'devflow/preset/deactivated')).toEqual([])
      expect(journal.filter(entry => entry.type === 'devflow/preset/activation-failed')).toHaveLength(1)
    } finally {
      await env.cleanup()
    }
  })

  it('surfaces a stable commander-install failure and leaves no active state behind', async () => {
    const env = await environment(devflow, 'install-fail')
    try {
      const agent = env.makeAgent('session-install-fail')
      // A persona section with the reserved name makes enter() reject.
      agent.ctx.systemPrompt.section({ name: 'devflow-commander-persona', order: 1, text: 'pre-installed' })

      const failure = await env.activation.activate(env.input(agent)).then(
        () => null,
        (error: unknown) => error,
      )
      const activationCode = (failure as { activationCode?: unknown } | null)?.activationCode
      expect(activationCode).toBe(DEVFLOW_ACTIVATION_CODES.commanderInstallFailed)
      expect(env.commander.current(agent).mode).toBe('chat')
      expect(toolNames(env.tools, agent)).toEqual(FULL_VIEW)
      const report = await env.activation.report(agent)
      expect(report.activation).toBe('error')
      // The report now names the refusal that actually happened. This
      // expectation used to read `commander-not-installed`, which was the old
      // conjunction's only vocabulary — it could not tell "the install was
      // attempted and failed" from "no install was ever attempted". Preserving
      // that difference is the whole point of the recorded refusal.
      expect(report.activationError?.code).toBe(DEVFLOW_ACTIVATION_CODES.commanderInstallFailed)
      expect(report.lastFailure).toMatchObject({
        code: DEVFLOW_ACTIVATION_CODES.commanderInstallFailed,
        phase: 'initial',
        attempts: 1,
      })
      // Bounded failure surface: no raw persona or error text.
      expect(JSON.stringify(report)).not.toContain('fixture persona')
    } finally {
      await env.cleanup()
    }
  })

  it('reports a stable project-unavailable error instead of a bound claim', async () => {
    // Fresh deployment: devflow preset is composed but no project was ever
    // created (e.g. activation never ran or was rolled back).
    const env = await environment(devflow, 'no-project')
    try {
      const agent = env.makeAgent('session-no-project')
      const report = await env.activation.report(agent)
      expect(report.activation).toBe('error')
      expect(report.activationError?.code).toBe(DEVFLOW_ACTIVATION_CODES.projectUnavailable)
      expect(JSON.stringify(report)).not.toContain('secret')
    } finally {
      await env.cleanup()
    }
  })

  it('repeated selection of the same session is a no-op: no second persona layer or journal noise', async () => {
    const env = await environment(devflow, 'idempotent')
    try {
      const agent = env.makeAgent('session-idempotent')
      const provider = env.activation.createProvider()

      await provider.activate(env.input(agent))
      const project = await env.store.loadProject()
      const firstState = env.commander.current(agent)

      const again = await provider.activate(env.input(agent))
      expect(env.commander.current(agent)).toMatchObject(firstState)
      expect(env.commander.current(agent).projectId).toBe(project?.id)

      const activated = (await env.store.listJournal())
        .filter(entry => entry.type === 'devflow/preset/activated')
      expect(activated).toHaveLength(1)
      expect(toolNames(env.tools, agent)).toEqual(COMMANDER_VIEW)
      const report = await env.activation.report(agent)
      expect(report.activation).toBe('bound')
      void again
    } finally {
      await env.cleanup()
    }
  })

  it('deactivate restores native tools/persona and unbound state; restore is idempotent and rebinds', async () => {
    const env = await environment(devflow, 'switch')
    try {
      const agent = env.makeAgent('session-switch')
      const provider = env.activation.createProvider()
      const lease = await provider.activate(env.input(agent))
      expect(toolNames(env.tools, agent)).toEqual(COMMANDER_VIEW)

      await lease.deactivate()
      expect(env.commander.current(agent).mode).toBe('chat')
      expect(toolNames(env.tools, agent)).toEqual(FULL_VIEW)
      const exited = await env.activation.report(agent)
      expect(exited.activation).toBe('unbound')

      // restore() rebinds this exact project and is idempotent on the next call.
      await lease.restore()
      expect(env.commander.verify(agent).ok).toBe(true)
      const restored = await env.activation.report(agent)
      expect(restored.activation).toBe('bound')
      const activatedCount = (await env.store.listJournal())
        .filter(entry => entry.type === 'devflow/preset/activated').length
      await lease.restore()
      const afterSecondRestore = (await env.store.listJournal())
        .filter(entry => entry.type === 'devflow/preset/activated').length
      expect(afterSecondRestore).toBe(activatedCount)
    } finally {
      await env.cleanup()
    }
  })

  it('cold resume: journal alone never reports bound; kind:initial reactivation binds again', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'devflow-activation-cold-'))
    const makeStore = () => new DevFlowStore(
      new LocalFileSystem(new Context(), { cwd: dir, diffBasisMaxBytes: 1024 * 1024 }),
      './.devflow',
    )
    let first: ReturnType<typeof build> | undefined
    let second: ReturnType<typeof build> | undefined
    function build(store: DevFlowStore) {
      const ctx = new Context()
      new SystemPrompt(ctx, {})
      const tools = new ToolRuntime(ctx)
      tools.register(tool(COMMANDER_TOOL))
      tools.register(tool(NATIVE_TOOL))
      const commander = new CommanderMode('persona')
      const activation = new DevFlowPresetActivation(store, commander, {
        composedPreset: devflow, durablePreset: devflow, now: () => NOW,
      })
      const agent = { id: 'cold-resume-session' } as Agent
      const scope = createScope(ctx, agent)
      Object.assign(agent, { ctx: scope.ctx })
      return {
        store, tools, commander, activation, agent,
        input: (kind: 'initial' | 'recompose' = 'initial') => ({
          agent, agentCtx: agent.ctx, preset: { id: DEVFLOW_PRESET_ID }, kind,
        } as DevFlowActivationInput),
        dispose: () => scope.dispose(),
      }
    }

    try {
      // First process: binds and journals an activation record.
      first = build(makeStore())
      await first.activation.activate(first.input('initial'))
      const activated = (await first.store.listJournal())
        .filter(entry => entry.type === 'devflow/preset/activated')
      expect(activated).toHaveLength(1)

      // Host restart: fresh store/Commander on the SAME durable dir, so the
      // old activation journal exists but nothing is installed in memory.
      second = build(makeStore())
      const before = await second.activation.report(second.agent)
      expect(before.activation).toBe('error')
      expect(before.activationError?.code).toBe(DEVFLOW_ACTIVATION_CODES.commanderNotInstalled)

      // Cold resume runs kind:'initial' again and verifiably re-binds; the
      // journal record alone was never the Bound evidence.
      await second.activation.activate(second.input('initial'))
      const after = await second.activation.report(second.agent)
      expect(after.activation).toBe('bound')
      expect(after.verifiedAt).toBe(NOW)
    } finally {
      first?.dispose()
      second?.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps A/B/A sessions isolated and never activates a child that was not mounted', async () => {
    const env = await environment(devflow, 'ab')
    try {
      const a = env.makeAgent('session-a')
      const b = env.makeAgent('session-b')
      const child = env.makeAgent('child-c')
      const provider = env.activation.createProvider()

      await provider.activate(env.input(a))
      expect((await env.activation.report(a)).activation).toBe('bound')

      // B (and a composeFrom child) are untouched by A's activation.
      expect(env.commander.current(b).mode).toBe('chat')
      expect(toolNames(env.tools, a)).toEqual(COMMANDER_VIEW)
      expect(toolNames(env.tools, b)).toEqual(FULL_VIEW)
      expect(toolNames(env.tools, child)).toEqual(FULL_VIEW)
      expect((await env.activation.report(child)).activation).not.toBe('bound')

      // B binds independently to the SAME shared project.
      await provider.activate(env.input(b))
      expect((await env.activation.report(b)).activation).toBe('bound')
      const projectA = (await env.activation.report(a)).projectId
      const projectB = (await env.activation.report(b)).projectId
      expect(projectA).toBe(projectB)

      // A exits; B stays bound (A/B/A). Re-requesting A's lease is the
      // idempotent no-op path and returns the same lifecycle lease.
      const leaseA = await provider.activate(env.input(a))
      await leaseA.deactivate()
      expect((await env.activation.report(a)).activation).toBe('unbound')
      expect((await env.activation.report(b)).activation).toBe('bound')

      // A re-enters through a fresh activation: still isolated from B.
      await provider.activate(env.input(a))
      expect((await env.activation.report(a)).activation).toBe('bound')
      expect(env.commander.current(b).mode).toBe('commander')
    } finally {
      await env.cleanup()
    }
  })

  it('creates no second loader or state source: two providers share one store and one project', async () => {
    const env = await environment(devflow, 'single-source')
    try {
      const firstProvider = env.activation.createProvider()
      const secondProvider = env.activation.createProvider()
      expect(firstProvider).not.toBe(secondProvider)
      const a = env.makeAgent('session-shared-a')
      const b = env.makeAgent('session-shared-b')

      await firstProvider.activate(env.input(a))
      await secondProvider.activate(env.input(b))

      const journals = await env.store.listJournal()
      expect(journals.filter(entry => entry.type === 'devflow/project/update')).toHaveLength(1)
      // Five fixed employees ship now: commander plus the four dispatched seats
      // (backend, frontend, architect, auditor). No second registration pass
      // happened — the roster is reconciled once and is then silent.
      expect(await env.store.listAgents()).toHaveLength(5)
      const reportA = await env.activation.report(a)
      const reportB = await env.activation.report(b)
      expect(reportA.projectId).toBe(reportB.projectId)
      // No extra DevFlow state file hierarchy was created beyond the one store.
      expect(await journalTypes(env.store)).not.toContain('devflow/devflow/loader')
    } finally {
      await env.cleanup()
    }
  })

  it('reports unbound with the real preset id when the session is not on devflow', async () => {
    const env = await environment(() => 'standard', 'unbound')
    try {
      const agent = env.makeAgent('session-unbound')
      const report = await env.activation.report(agent)
      expect(report).toMatchObject({
        presetId: 'standard', commanderMode: 'chat', activation: 'unbound',
        activationError: null, verifiedAt: null,
      })
    } finally {
      await env.cleanup()
    }
  })

  it('reports session-mismatch error when the live scope and the durable log disagree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devflow-activation-mismatch-'))
    const ctx = new Context()
    new SystemPrompt(ctx, {})
    const tools = new ToolRuntime(ctx)
    tools.register(tool(COMMANDER_TOOL))
    const store = new DevFlowStore(new LocalFileSystem(new Context(), { cwd: root, diffBasisMaxBytes: 1024 * 1024 }), './.devflow')
    const commander = new CommanderMode('persona')
    const activation = new DevFlowPresetActivation(store, commander, {
      // The live composition says devflow, but the durable log resolves away.
      composedPreset: devflow,
      durablePreset: () => 'standard',
    })
    const agent = { id: 'session-durable-mismatch' } as Agent
    const scope = createScope(ctx, agent)
    Object.assign(agent, { ctx: scope.ctx })
    try {
      const report = await activation.report(agent)
      expect(report.activation).toBe('error')
      expect(report.activationError?.code).toBe(DEVFLOW_ACTIVATION_CODES.sessionMismatch)
    } finally {
      await scope.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports verification-failed error when Commander points at a stale project', async () => {
    const env = await environment(devflow, 'stale-project')
    try {
      const agent = env.makeAgent('session-stale')
      // A project exists (created by a first successful binding on another
      // session), but Commander is bound to an old project id that no longer
      // matches the shared store record.
      const other = env.makeAgent('session-seed')
      await env.activation.activate(env.input(other))
      env.commander.exit(other)
      const project = await env.store.loadProject()
      env.commander.enter(agent, 'stale-project-id')

      // Report against a session that never bound (durable/composed devflow).
      const report = await env.activation.report(agent)
      expect(project).toBeDefined()
      expect(report.activation).toBe('error')
      expect(report.activationError?.code).toBe(DEVFLOW_ACTIVATION_CODES.verificationFailed)
    } finally {
      await env.cleanup()
    }
  })

  it('settles an Agent-owned tool the outgoing composition registered, without weakening verification', async () => {
    const env = await environment(devflow, 'settle')
    try {
      const agent = env.makeAgent('session-settle')
      // A preset row that samples a per-Agent tool definition (`tool-subagent`
      // does) registers it into the Agent's OWN scope, where `restrict()` cannot
      // mask it, and removes it when the harness publishes `tools/change` —
      // asynchronously, because the removal disposes a fiber. A switch into
      // devflow therefore meets that tool for one turn.
      const disposeOwnTool = agent.ctx.tools.register(tool('subagent'))
      agent.ctx.on('tools/change', () => { setTimeout(() => { disposeOwnTool() }, 0) })

      const lease = await activateWithSettle(
        env.activation.createProvider(),
        env.input(agent, DEVFLOW_PRESET_ID, 'recompose'),
      )

      expect(lease).toBeDefined()
      const project = await env.store.loadProject()
      expect(env.commander.verify(agent, project?.id).ok).toBe(true)
      expect(toolNames(env.tools, agent)).toEqual(COMMANDER_VIEW)
      expect((await env.activation.report(agent)).activation).toBe('bound')
    } finally {
      await env.cleanup()
    }
  })

  it('still refuses an Agent-owned tool that never leaves', async () => {
    const env = await environment(devflow, 'settle-refused')
    try {
      const agent = env.makeAgent('session-settle-refused')
      agent.ctx.tools.register(tool('subagent'))

      const failure = await activateWithSettle(env.activation.createProvider(), env.input(agent))
        .then(() => null, (error: unknown) => error)

      // The unchanged live verification is still the gate: an extra tool the
      // retry cannot outlast keeps the switch refused with the same code.
      expect((failure as { activationCode?: unknown } | null)?.activationCode)
        .toBe(DEVFLOW_ACTIVATION_CODES.verificationFailed)
      expect(env.commander.current(agent).mode).toBe('chat')
    } finally {
      await env.cleanup()
    }
  })

  it('exposes the settled attempt count when the whole settle budget is refused', async () => {
    const env = await environment(devflow, 'settle-attempts')
    try {
      const agent = env.makeAgent('session-settle-attempts')
      agent.ctx.tools.register(tool('subagent'))

      await activateWithSettle(env.activation.createProvider(), env.input(agent)).catch(() => undefined)

      // The wire only carries the code, so "refused on the first try" and
      // "refused after the whole budget" are indistinguishable there. The
      // durable record is where that difference has to survive, and only the
      // settle wrapper knows the count.
      const report = await env.activation.report(agent)
      expect(report.lastFailure?.attempts).toBe(4)
      expect(report.lastFailure?.phase).toBe('initial')
    } finally {
      await env.cleanup()
    }
  })

  it('records a first-try refusal as attempt 1 rather than as an exhausted budget', async () => {
    const env = await environment(devflow, 'first-try')
    try {
      const agent = env.makeAgent('session-first-try')
      // A direct provider call is one activation run, so the refusal is
      // attributable to the activation itself and not to the settle window.
      const failure = await env.activation.activate(env.input(agent, 'standard'))
        .then(() => null, (error: unknown) => error)
      expect((failure as { activationCode?: unknown } | null)?.activationCode)
        .toBe(DEVFLOW_ACTIVATION_CODES.presetIdentityMismatch)

      const report = await env.activation.report(agent)
      expect(report.lastFailure).toMatchObject({
        code: DEVFLOW_ACTIVATION_CODES.presetIdentityMismatch,
        phase: 'initial',
        attempts: 1,
      })
      expect(report.lastFailure?.reason).toBe(activationReasonZh(DEVFLOW_ACTIVATION_CODES.presetIdentityMismatch))
    } finally {
      await env.cleanup()
    }
  })

  it('replays a recorded refusal from a fresh adapter against the same store', async () => {
    const env = await environment(devflow, 'durable-refusal')
    try {
      const agent = env.makeAgent('session-durable-refusal')
      await env.activation.activate(env.input(agent, 'standard')).catch(() => undefined)
      expect((await env.activation.report(agent)).lastFailure?.code)
        .toBe(DEVFLOW_ACTIVATION_CODES.presetIdentityMismatch)

      // A second adapter over the same store stands in for a Host restart: the
      // in-memory mirror is gone, so a refusal that is still readable proves it
      // came from the journal rather than from this process's memory.
      const restarted = new DevFlowPresetActivation(env.store, env.commander, {
        composedPreset: devflow,
        durablePreset: devflow,
        now: () => NOW,
      })
      expect((await restarted.report(agent)).lastFailure).toMatchObject({
        code: DEVFLOW_ACTIVATION_CODES.presetIdentityMismatch,
        attempts: 1,
      })
    } finally {
      await env.cleanup()
    }
  })

  it('writes the refusal as its own durable journal record', async () => {
    const env = await environment(devflow, 'journal-refusal')
    try {
      const agent = env.makeAgent('session-journal-refusal')
      await env.activation.activate(env.input(agent, 'standard')).catch(() => undefined)

      const entries = await env.store.listJournal()
      const recorded = entries.filter(entry => entry.type === 'devflow/preset/activation-failed')
      expect(recorded).toHaveLength(1)
      expect(recorded[0]?.data).toMatchObject({
        sessionId: 'session-journal-refusal',
        activationCode: DEVFLOW_ACTIVATION_CODES.presetIdentityMismatch,
        phase: 'initial',
        attempts: 1,
      })
    } finally {
      await env.cleanup()
    }
  })

  it('keeps a refusal readable after a successful activation of the same session', async () => {
    const env = await environment(devflow, 'refusal-then-bound')
    try {
      const agent = env.makeAgent('session-refusal-then-bound')
      await env.activation.activate(env.input(agent, 'standard')).catch(() => undefined)
      const lease = await env.activation.activate(env.input(agent, 'devflow'))

      expect(lease).toBeDefined()
      const report = await env.activation.report(agent)
      expect(report.activation).toBe('bound')
      expect(report.activationError).toBeNull()
      // The recovery is reported alongside the refusal, not instead of it.
      expect(report.lastFailure?.code).toBe(DEVFLOW_ACTIVATION_CODES.presetIdentityMismatch)
    } finally {
      await env.cleanup()
    }
  })

  it('refuses every reason table entry with a non-empty Chinese sentence', () => {
    for (const [code, reason] of Object.entries(ACTIVATION_CODE_REASONS_ZH)) {
      expect(reason, code).toBeTypeOf('string')
      expect(reason.trim().length, code).toBeGreaterThan(0)
    }
    for (const [phase, reason] of Object.entries(ACTIVATION_PHASE_REASONS_ZH)) {
      expect(reason.trim().length, phase).toBeGreaterThan(0)
    }
    // An unrecognised code still has to say something readable rather than
    // render an empty sentence where the cause should be.
    expect(activationReasonZh('devflow-from-a-newer-build')).toContain('devflow-from-a-newer-build')
  })
})
