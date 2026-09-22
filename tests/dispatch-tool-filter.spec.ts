import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentResult, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DECLARED_EMPLOYEE_TOOL_NAMES, DEFAULT_FIXED_AGENTS, dispatchableToolNames } from '../src/host/default-agents.ts'
import { DevFlowStore } from '../src/host/storage.ts'
import { registerDevFlowTools } from '../src/host/tools.ts'
import { TaskWorkflow } from '../src/host/workflow.ts'
import { AgentWorkflow } from '../src/host/workflow-agent.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** A minimal accepted result document for the dispatched child. */
function resultDocument(taskId: string): string {
  return [
    '# DevFlow Result', '', '## Metadata', '', 'Protocol Version: 0.4', `Task ID: ${taskId}`, 'Verdict: accepted', '',
    '## Summary', '', 'Fixed Agent dispatch fixture result.', '', '## Changes', '', '- None', '',
    '## Verification', '', '- Fixture result.', '', '## Issues', '', '- None', '', '## Next Steps', '', '- None',
  ].join('\n')
}

/** A no-op tool used to simulate a runtime tool that really exists. */
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

/**
 * Dispatch one task for a child whose stored `tools` list is `childTools`.
 *
 * The `subagents.start` double mirrors the real provider's pre-start
 * validation: a `toolFilter.allow` naming a tool the runtime does not have is
 * rejected exactly the way `tools.restrict()` rejects it, so a dispatch that
 * forwards unknown names fails here the way it fails in production.
 *
 * `parentRestrict` applies the Commander's own tool restriction to the calling
 * scope before dispatch, which is the production shape that used to collapse
 * every employee to the parent's read-only tools.
 */
async function dispatch(childTools: string[], runtimeTools: string[] = [], parentRestrict?: readonly string[]) {
  const rootDir = await mkdtemp(join(tmpdir(), 'devflow-dispatch-filter-'))
  roots.push(rootDir)
  const ctx = new Context()
  const store = new DevFlowStore(new LocalFileSystem(ctx, { cwd: rootDir, diffBasisMaxBytes: 1024 * 1024 }), './.devflow')
  const workflow = new TaskWorkflow(store)
  const agentWorkflow = new AgentWorkflow(store, workflow)
  const now = '2026-09-10T00:00:00.000Z'
  await store.saveProject({ id: 'project-filter', name: 'Filter', goal: 'Unblock dispatch', currentStage: 'implementation', createdAt: now, updatedAt: now })
  const child = await store.registerAgent({
    agentId: 'backend-engineer', kind: 'fixed', role: 'backend-engineer', delegationDepth: 0,
    prompt: 'Backend fixture', modelConfig: { model: 'deepseek-chat' }, tools: childTools, capabilities: [], skills: [],
  })
  const phase = await store.createPhase({ name: 'Implementation', description: 'filter', status: 'in_progress' })
  const task = await store.createTask({ title: 'Inspect package scripts', description: 'Read package scripts only', status: 'planned', assignedRole: 'backend-engineer' })
  const assignment = await store.createAssignment({ taskId: task.id, phaseId: phase.id, agentId: child.agentId, role: child.role, status: 'assigned' })

  let request: SubagentStartRequest | undefined
  const start = vi.fn(async (_provider: string, input: SubagentStartRequest) => {
    request = input
    const allow = input.toolFilter?.allow
    if (allow !== undefined) {
      // What the child's own scope knows: the runtime's registered tools plus
      // every name the employee roster declares (those are the preset
      // capability rows the child inherits). A name in neither is the unknown
      // global `tools.restrict()` refuses.
      const known = new Set([...tools.schemas(parent).map(schema => schema.name), ...DECLARED_EMPLOYEE_TOOL_NAMES])
      const unknown = allow.filter(name => !known.has(name))
      if (unknown.length > 0) {
        throw new Error(`tools.restrict() names unknown global tools ${unknown.map(name => `"${name}"`).join(',')}`)
      }
    }
    const settled: SubagentResult = {
      stopReason: 'completed',
      output: [{ type: 'text', text: resultDocument(task.id) } satisfies ContentBlock],
    }
    return {
      id: 'child-run' as never,
      localAgent: undefined,
      result: Promise.resolve(settled),
      dispose: async () => {},
    }
  })
  ctx.provide('subagents', { start })
  new SystemPrompt(ctx, {})
  const tools = new ToolRuntime(ctx)
  for (const name of runtimeTools) tools.register(tool(name))
  registerDevFlowTools(ctx, { store, workflow, agentWorkflow })
  await Promise.resolve()
  // The calling agent gets its OWN scope, so a restriction applies to the caller
  // alone — the same shape `CommanderMode.enter()` installs in production.
  const parent = { id: 'commander-parent', options: {}, session: { header: {} } } as unknown as Agent
  const parentScope = createScope(ctx, parent)
  Object.assign(parent, { ctx: parentScope.ctx })
  if (parentRestrict !== undefined) parent.ctx.tools.restrict({ allow: [...parentRestrict] })

  const execution = await tools.execute({
    callId: 'dispatch-filter' as never,
    name: 'devflow_dispatch_agent',
    arguments: { agentId: child.agentId, taskId: task.id },
    agent: parent,
    signal: new AbortController().signal,
  })
  return { execution, request, start, tools, parent, child, store, task, assignment }
}

describe('DevFlow child dispatch tool filter', () => {
  it('keeps a name the parent cannot see but the roster declares', async () => {
    // The contract of the vocabulary: the caller's own view may only ADD names,
    // never remove one the roster declares. This is asserted directly on the
    // production helper, so a future edit cannot quietly reintroduce the
    // parent-view intersection.
    const declared = ['read', 'write', 'edit', 'pwsh']
    expect(dispatchableToolNames(declared, new Set(['read', 'glob', 'grep']))).toEqual(declared)
    // A name in neither the caller's view nor the roster is still dropped.
    expect(dispatchableToolNames(['read', 'ghost'], new Set(['read']))).toEqual(['read'])
    // And the caller's view can add a name the roster does not declare.
    expect(dispatchableToolNames(['read', 'host-only'], new Set(['read', 'host-only']))).toEqual(['read', 'host-only'])
  })

  it('drops a stored name the roster never declares, instead of forwarding it', async () => {
    const f = await dispatch(['read', 'not-a-real-tool'], ['read', 'write', 'edit', 'glob', 'grep', 'pwsh'])

    expect(f.execution.isError).toBe(false)
    expect(f.start).toHaveBeenCalledTimes(1)
    expect(f.request?.toolFilter).toEqual({ allow: ['read'] })
  })

  it('keeps the employee tool set complete when the PARENT is restricted', async () => {
    // The defect this test exists for: deriving "available" from the calling
    // agent's own view. A restricted Commander sees only its navigation tools
    // plus its own DevFlow tools, and the intersection used to hand every
    // employee a read-only tool set.
    // The roster's own chain: `str_replace_editor` is NOT here because this
    // runtime no longer registers it, and forwarding a retired name aborts the
    // whole dispatch (`tools.restrict()` rejects unknown globals).
    const childTools = ['read', 'write', 'edit', 'glob', 'grep', 'read_image', 'pwsh']
    const commanderView = ['read', 'glob', 'grep', 'devflow_dispatch_agent']
    const f = await dispatch(childTools, childTools, commanderView)

    expect(f.execution.isError).toBe(false)
    expect(f.start).toHaveBeenCalledTimes(1)
    // The child keeps every declared tool...
    expect(f.request?.toolFilter?.allow).toEqual(childTools)
    expect(f.request?.toolFilter?.allow).toContain('write')
    expect(f.request?.toolFilter?.allow).toContain('pwsh')
    // ...while the caller stays exactly as restricted as it was. If the filter
    // were still read off this view, only read/glob/grep would survive.
    expect(f.parent.ctx.tools.schemas(f.parent).map(schema => schema.name).sort())
      .toEqual([...commanderView].sort())
  })

  it('omits the filter for an empty stored list instead of sending an empty allow', async () => {
    const f = await dispatch([])

    expect(f.execution.isError).toBe(false)
    expect(f.start).toHaveBeenCalledTimes(1)
    expect(f.request?.toolFilter).toBeUndefined()
  })
})

describe('default fixed employee tool lists', () => {
  it('names the real capability tools the preset registers', () => {
    const byId = new Map(DEFAULT_FIXED_AGENTS.map(agent => [agent.agentId, agent]))
    const backend = byId.get('backend-engineer')?.tools ?? []
    expect(backend).toContain('read')
    expect(backend).toContain('write')
    expect(backend).toContain('edit')
    expect(backend).toContain('pwsh')
    const auditor = byId.get('code-auditor')?.tools ?? []
    // The auditor reviews; it must not be granted a writer.
    expect(auditor).toContain('read')
    expect(auditor).not.toContain('write')
    // The Commander keep its DevFlow tool allowlist: those names do exist.
    expect(byId.get('commander')?.tools).toContain('devflow_create_task')
  })

  it('keeps upsert and read round-trips working for the new defaults', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'devflow-dispatch-defaults-'))
    roots.push(rootDir)
    const store = new DevFlowStore(new LocalFileSystem(new Context(), { cwd: rootDir, diffBasisMaxBytes: 1024 * 1024 }), './.devflow')
    for (const input of DEFAULT_FIXED_AGENTS) await store.registerAgent(input)
    const stored = await store.listAgents()
    expect(stored).toHaveLength(DEFAULT_FIXED_AGENTS.length)
    const backend = await store.getAgent('backend-engineer')
    expect(backend?.tools).toContain('write')
    expect((await store.getAgent('commander'))?.tools).toContain('devflow_dispatch_agent')
  })
})
