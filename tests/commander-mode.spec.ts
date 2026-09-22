import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { CommanderMode } from '../src/host/commander-mode.ts'

const COMMANDER_TOOL = 'devflow_create_task'
const NATIVE_TOOL = 'read'
const OTHER_READ_ONLY_TOOL = 'glob'
const CHILD_TOOL = 'write'
const SHELL_TOOL = 'pwsh'

/** The Commander's restricted view: DevFlow tools plus the read-only lookups. */
const COMMANDER_VIEW = [COMMANDER_TOOL, NATIVE_TOOL, OTHER_READ_ONLY_TOOL].sort()
/** The unrestricted view: every tool this fixture registers. */
const FULL_VIEW = [COMMANDER_TOOL, NATIVE_TOOL, OTHER_READ_ONLY_TOOL, CHILD_TOOL, SHELL_TOOL].sort()

interface ScopedAgentFixture {
  readonly agent: Agent
  readonly dispose: () => Promise<void>
}

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

function fixture(): { root: Context; tools: ToolRuntime; makeAgent: (id: string) => ScopedAgentFixture } {
  const root = new Context()
  new SystemPrompt(root, {})
  const tools = new ToolRuntime(root)
  root.tools.register(tool(COMMANDER_TOOL))
  root.tools.register(tool(NATIVE_TOOL))
  root.tools.register(tool(OTHER_READ_ONLY_TOOL))
  root.tools.register(tool(CHILD_TOOL))
  root.tools.register(tool(SHELL_TOOL))

  return {
    root,
    tools,
    makeAgent: id => {
      const agent = { id } as Agent
      const scope = createScope(root, agent)
      Object.assign(agent, { ctx: scope.ctx })
      return { agent, dispose: scope.dispose }
    },
  }
}

function names(tools: ToolRuntime, agent: Agent): string[] {
  return tools.schemas(agent).map(tool => tool.name).sort()
}

async function execute(tools: ToolRuntime, agent: Agent, name: string) {
  return tools.execute({
    callId: `${agent.id}:${name}` as never,
    name,
    arguments: {},
    agent,
    signal: new AbortController().signal,
  })
}

describe('CommanderMode scoped tool restriction', () => {
  it('shows the DevFlow tools plus read-only lookups, and restores the full native set on exit', async () => {
    const { tools, makeAgent } = fixture()
    const { agent, dispose } = makeAgent('commander-1')
    const commander = new CommanderMode('Commander persona')
    try {
      expect(names(tools, agent)).toEqual(FULL_VIEW)

      commander.enter(agent, 'project-1')
      expect(names(tools, agent)).toEqual(COMMANDER_VIEW)
      await expect(execute(tools, agent, COMMANDER_TOOL)).resolves.toMatchObject({ isError: false })
      // Step 8: the read-only lookups stay callable — kickoff navigation reads
      // the project's own rule file and `docs/` through the Commander seat.
      await expect(execute(tools, agent, NATIVE_TOOL)).resolves.toMatchObject({ isError: false })
      await expect(execute(tools, agent, OTHER_READ_ONLY_TOOL)).resolves.toMatchObject({ isError: false })
      // The boundary the restriction exists for is unchanged: no write, no shell.
      await expect(execute(tools, agent, CHILD_TOOL)).resolves.toMatchObject({
        isError: true,
        error: { info: { code: 'UNKNOWN_TOOL' } },
      })
      await expect(execute(tools, agent, SHELL_TOOL)).resolves.toMatchObject({
        isError: true,
        error: { info: { code: 'UNKNOWN_TOOL' } },
      })

      commander.exit(agent)
      expect(names(tools, agent)).toEqual(FULL_VIEW)
      await expect(execute(tools, agent, NATIVE_TOOL)).resolves.toMatchObject({ isError: false })
      await expect(execute(tools, agent, CHILD_TOOL)).resolves.toMatchObject({ isError: false })
    } finally {
      commander.exit(agent)
      await dispose()
    }
  })

  it('rolls back a partially installed restriction when persona installation fails', async () => {
    const { tools, makeAgent } = fixture()
    const { agent, dispose } = makeAgent('commander-rollback')
    const commander = new CommanderMode('Commander persona')
    const disposeExistingPersona = agent.ctx.systemPrompt.section({
      name: 'devflow-commander-persona',
      order: 1,
      text: 'Existing persona',
    })
    try {
      expect(() => commander.enter(agent, 'project-1')).toThrow('devflow-commander-persona')
      expect(commander.current(agent)).toMatchObject({ mode: 'chat', projectId: null })
      expect(names(tools, agent)).toEqual(FULL_VIEW)
      await expect(execute(tools, agent, NATIVE_TOOL)).resolves.toMatchObject({ isError: false })
    } finally {
      disposeExistingPersona()
      commander.exit(agent)
      await dispose()
    }
  })

  it('keeps repeated enter and exit idempotent for one Commander agent', async () => {
    const { tools, makeAgent } = fixture()
    const { agent, dispose } = makeAgent('commander-idempotent')
    const commander = new CommanderMode('Commander persona')
    try {
      commander.enter(agent, 'project-1')
      const replacement = commander.enter(agent, 'project-2')
      expect(replacement).toMatchObject({ mode: 'commander', projectId: 'project-2', sessionId: agent.id })
      expect(names(tools, agent)).toEqual(COMMANDER_VIEW)

      commander.exit(agent)
      commander.exit(agent)
      expect(names(tools, agent)).toEqual(FULL_VIEW)
    } finally {
      commander.exit(agent)
      await dispose()
    }
  })

  it('does not leak Commander restrictions to another session or a child-scoped agent', async () => {
    const { tools, makeAgent } = fixture()
    const commanderFixture = makeAgent('commander-parent')
    const siblingFixture = makeAgent('commander-sibling')
    const childFixture = makeAgent('child-agent')
    const commander = new CommanderMode('Commander persona')
    const disposeChildFilter = childFixture.agent.ctx.tools.restrict({ allow: [NATIVE_TOOL, CHILD_TOOL] })
    try {
      commander.enter(commanderFixture.agent, 'project-1')

      expect(names(tools, commanderFixture.agent)).toEqual(COMMANDER_VIEW)
      expect(names(tools, siblingFixture.agent)).toEqual(FULL_VIEW)
      expect(names(tools, childFixture.agent)).toEqual([NATIVE_TOOL, CHILD_TOOL].sort())
      await expect(execute(tools, childFixture.agent, NATIVE_TOOL)).resolves.toMatchObject({ isError: false })
      await expect(execute(tools, childFixture.agent, COMMANDER_TOOL)).resolves.toMatchObject({
        isError: true,
        error: { info: { code: 'UNKNOWN_TOOL' } },
      })
    } finally {
      disposeChildFilter()
      commander.exit(commanderFixture.agent)
      await Promise.all([commanderFixture.dispose(), siblingFixture.dispose(), childFixture.dispose()])
    }
  })
})

describe('CommanderMode verifiable activation', () => {
  it('verifies a live installation and reports the project mismatch', async () => {
    const { makeAgent } = fixture()
    const { agent, dispose } = makeAgent('verify-1')
    const commander = new CommanderMode('Commander persona')
    try {
      expect(commander.verify(agent, 'project-1')).toEqual({ ok: false, failureCode: 'devflow-mode-not-installed' })

      commander.enter(agent, 'project-1')
      expect(commander.verify(agent, 'project-1')).toEqual({ ok: true })
      expect(commander.verify(agent, 'project-2')).toEqual({ ok: false, failureCode: 'devflow-project-mismatch' })

      commander.exit(agent)
      expect(commander.verify(agent, 'project-1')).toEqual({ ok: false, failureCode: 'devflow-mode-not-installed' })
    } finally {
      commander.exit(agent)
      await dispose()
    }
  })

  it('keeps a healthy installation verifiable after entry', async () => {
    const { tools, makeAgent } = fixture()
    const { agent, dispose } = makeAgent('verify-2')
    const commander = new CommanderMode('Commander persona')
    try {
      commander.enter(agent, 'project-1')
      expect(commander.verify(agent, 'project-1').ok).toBe(true)
      expect(names(tools, agent)).toEqual(COMMANDER_VIEW)
      expect(commander.current(agent).mode).toBe('commander')
    } finally {
      commander.exit(agent)
      await dispose()
    }
  })

  it('same-project re-enter is a no-op and keeps one installation', async () => {
    const { tools, makeAgent } = fixture()
    const { agent, dispose } = makeAgent('verify-3')
    const commander = new CommanderMode('Commander persona')
    try {
      const first = commander.enter(agent, 'project-1')
      const second = commander.enter(agent, 'project-1')
      expect(second.changedAt).toBe(first.changedAt)
      expect(names(tools, agent)).toEqual(COMMANDER_VIEW)
      expect(commander.verify(agent, 'project-1').ok).toBe(true)

      const switched = commander.enter(agent, 'project-2')
      expect(switched.projectId).toBe('project-2')
      expect(commander.verify(agent, 'project-2').ok).toBe(true)
      expect(commander.verify(agent, 'project-1').ok).toBe(false)
    } finally {
      commander.exit(agent)
      await dispose()
    }
  })
})
