import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentResult, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_FIXED_AGENTS } from '../src/host/default-agents.ts'
import { CommanderMode } from '../src/host/commander-mode.ts'
import { PROTOCOL_VERSION } from '../src/host/protocol.ts'
import { DevFlowStore } from '../src/host/storage.ts'
import { registerDevFlowTools } from '../src/host/tools.ts'
import { TaskWorkflow } from '../src/host/workflow.ts'
import { AgentWorkflow } from '../src/host/workflow-agent.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const SCOPE_CRITERIA = [
  'Collision is detected and reported.',
  'No self-collision false negative remains.',
  'Existing behaviour for food and score is unchanged.',
  'Movement speed stays constant.',
  'Wrap-around behaviour is preserved.',
  'Keyboard input still works.',
  'No new dependency is added.',
  'Focused tests cover the collision fix.',
  'The result document reports what changed.',
]

const REWORK_ISSUE = 'Self-collision is still missed when the head enters the body segment twice in one tick.'
const REWORK_NEXT = 'Handle the duplicate body segment case in the collision check.'

function nativeTool(name: string) {
  return defineTool({
    name,
    description: `${name} fixture`,
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.name }],
    },
    execute: async () => ({ name }),
  })
}

function resultDocument(taskId: string): string {
  return [
    '# DevFlow Result', '', '## Metadata', '', `Protocol Version: ${PROTOCOL_VERSION}`, `Task ID: ${taskId}`, 'Verdict: accepted', '',
    '## Summary', '', 'Fixed the returned defect.', '', '## Changes', '', '- Collision check.', '',
    '## Verification', '', '- Focused check.', '', '## Issues', '', '- None', '', '## Next Steps', '', '- None',
  ].join('\n')
}

/** Store + project + scope guard + one task, plus a `subagents` double. */
async function fixture(options: { readonly replies?: readonly string[] } = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), 'devflow-rework-chain-'))
  roots.push(rootDir)
  const ctx = new Context()
  const store = new DevFlowStore(new LocalFileSystem(ctx, { cwd: rootDir, diffBasisMaxBytes: 1024 * 1024 }), './.devflow')
  const workflow = new TaskWorkflow(store)
  const agentWorkflow = new AgentWorkflow(store, workflow)
  const now = '2026-09-10T00:00:00.000Z'
  await store.saveProject({ id: 'project-rework-chain', name: 'Snake', goal: 'Fix the returned defect', currentStage: 'implementation', createdAt: now, updatedAt: now })
  await store.updateScope({
    summary: 'Fix the collision defect only.', inScope: ['collision check', 'focused test'],
    maxModifiedFiles: 3, maxToolSteps: 20, completionCriteria: SCOPE_CRITERIA,
  })
  const child = await store.registerAgent({
    agentId: 'frontend-engineer', kind: 'fixed', role: 'frontend-engineer', delegationDepth: 0,
    prompt: 'Frontend fixture', modelConfig: { model: 'deepseek-chat' }, tools: ['read', 'write'], capabilities: [], skills: [],
  })
  const phase = await store.createPhase({ name: 'Fix', description: 'rework', status: 'in_progress' })

  const requests: SubagentStartRequest[] = []
  let callCount = 0
  const replies = options.replies ?? [resultDocument('__TASK_ID__')]
  const start = vi.fn(async (_provider: string, input: SubagentStartRequest) => {
    requests.push(input)
    const reply = replies[Math.min(callCount, replies.length - 1)] ?? ''
    callCount += 1
    const settled: SubagentResult = {
      stopReason: 'completed',
      output: [{ type: 'text', text: reply.replaceAll('__TASK_ID__', taskIdOf()) } satisfies ContentBlock],
    }
    return { id: `child-${callCount}` as never, localAgent: undefined, result: Promise.resolve(settled), dispose: async () => {} }
  })
  ctx.provide('subagents', { start })
  new SystemPrompt(ctx, {})
  const tools = new ToolRuntime(ctx)
  registerDevFlowTools(ctx, { store, workflow, agentWorkflow })
  await Promise.resolve()

  let taskId = ''
  const taskIdOf = (): string => taskId

  /** Create one task in `status` and assign the fixture employee to it. */
  async function createTask(status: 'planned' | 'reviewing' | 'executing' = 'planned') {
    const task = await store.createTask({ title: 'Fix the collision defect', description: 'Apply the returned finding.', status, assignedRole: 'frontend-engineer' })
    taskId = task.id
    const assignment = await store.createAssignment({ taskId: task.id, phaseId: phase.id, agentId: child.agentId, role: child.role, status: 'assigned' })
    return { task, assignment }
  }

  async function call(name: string, args: Record<string, unknown>, agent: Agent) {
    return await tools.execute({
      callId: `${name}-call` as never, name, arguments: args as never, agent, signal: new AbortController().signal,
    })
  }

  const parent = { id: 'commander-parent', options: {}, session: { header: {} }, ctx } as unknown as Agent
  return { ctx, store, workflow, agentWorkflow, tools, start, requests, child, phase, createTask, call, parent }
}

/** Record one changes-requested review result and its import journal entry. */
async function recordReworkReason(store: DevFlowStore, taskId: string) {
  const result = await store.saveResult({
    taskId, summary: 'The collision fix is incomplete.', changes: ['Touched the canvas layout.'],
    verification: ['Ran the focused test.'], issues: [REWORK_ISSUE], nextSteps: [REWORK_NEXT],
  })
  await store.appendJournal('devflow/bridge/import', {
    taskId, resultId: result.id, protocolVersion: PROTOCOL_VERSION, verdict: 'changes-requested', at: '2026-09-10T00:00:01.000Z',
  })
  return result
}

describe('Commander orchestration whitelist', () => {
  it('exposes devflow_transition_task, reads navigation read-only, and never a writing tool', () => {
    const commander = DEFAULT_FIXED_AGENTS.find(agent => agent.agentId === 'commander')
    expect(commander?.tools).toContain('devflow_transition_task')
    // Step 8: kickoff navigation reading is allowed through the Commander seat.
    for (const readOnly of ['read', 'glob', 'grep']) {
      expect(commander?.tools).toContain(readOnly)
    }
    // The restriction the seat exists for is unchanged: the Commander never
    // holds a tool that can write the workspace or run a command.
    for (const writing of ['write', 'edit', 'pwsh', 'str_replace_editor']) {
      expect(commander?.tools).not.toContain(writing)
    }
  })

  it('lets the Commander see the transition tool and the read-only lookups in its restricted view', () => {
    const ctx = new Context()
    new SystemPrompt(ctx, {})
    const tools = new ToolRuntime(ctx)
    for (const name of ['devflow_transition_task', 'devflow_dispatch_agent', 'read', 'glob', 'grep', 'write', 'pwsh']) tools.register(nativeTool(name))
    const agent = { id: 'commander-whitelist' } as Agent
    const scope = createScope(ctx, agent)
    Object.assign(agent, { ctx: scope.ctx })

    new CommanderMode('persona').enter(agent, 'project-1')

    const visible = tools.schemas(agent).map(schema => schema.name)
    expect(visible).toContain('devflow_transition_task')
    expect(visible).toContain('read')
    expect(visible).toContain('glob')
    expect(visible).toContain('grep')
    expect(visible).not.toContain('write')
    expect(visible).not.toContain('pwsh')
  })
})

describe('task package criteria synthesis', () => {
  it('fills acceptance criteria from the Scope Guard when the package carries none', async () => {
    const f = await fixture()
    const { task } = await f.createTask()

    const execution = await f.call('devflow_create_task_package', { taskId: task.id }, f.parent)

    expect(execution.isError).toBe(false)
    const value = execution.value as { acceptanceCriteria: string[]; instructions: string }
    expect(value.acceptanceCriteria).toHaveLength(SCOPE_CRITERIA.length)
    expect(value.acceptanceCriteria).toContain(SCOPE_CRITERIA[0])
    expect(value.instructions).toContain('Fix the collision defect only.')
    expect(value.instructions).toContain('Completion criteria:')
  })

  it('injects the previous review rejection into a rework package', async () => {
    const f = await fixture()
    const { task } = await f.createTask('reviewing')
    await recordReworkReason(f.store, task.id)

    const execution = await f.call('devflow_create_task_package', { taskId: task.id }, f.parent)

    expect(execution.isError).toBe(false)
    const value = execution.value as { acceptanceCriteria: string[]; instructions: string }
    expect(value.instructions).toContain(REWORK_ISSUE)
    expect(value.instructions).toContain(REWORK_NEXT)
    expect(value.instructions).toContain('Changes requested by the previous review')
    // Scope Guard criteria still carry the acceptance bar.
    expect(value.acceptanceCriteria).toHaveLength(SCOPE_CRITERIA.length)
  })
})

describe('rework dispatch prompt', () => {
  it('carries the required result template and the returned defect', async () => {
    const f = await fixture()
    const { task } = await f.createTask('reviewing')
    await recordReworkReason(f.store, task.id)

    const execution = await f.call('devflow_dispatch_agent', { agentId: f.child.agentId, taskId: task.id }, f.parent)

    expect(execution.isError).toBe(false)
    const prompt = (f.requests[0]?.prompt[0] as { text?: string } | undefined)?.text ?? ''
    expect(prompt).toContain('# DevFlow Result')
    expect(prompt).toContain('## Required Result Format')
    expect(prompt).toContain(REWORK_ISSUE)
    expect(prompt).toContain(REWORK_NEXT)
    expect(prompt).toContain(SCOPE_CRITERIA[0] ?? '')
  })
})
