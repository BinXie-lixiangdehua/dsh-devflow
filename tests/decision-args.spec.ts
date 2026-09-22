import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DevFlowStore } from '../src/host/storage.ts'
import { parseDecisionRequestArgs, registerDevFlowTools } from '../src/host/tools.ts'
import { TaskWorkflow } from '../src/host/workflow.ts'
import { AgentWorkflow } from '../src/host/workflow-agent.ts'
import type { DecisionRequest } from '../src/host/types.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/**
 * The product shape, now including the declared intent every popup rule is
 * checked against (`kind`). One option must always halt the work, so the third
 * slot carries `stop` here; the other rules are exercised separately below.
 */
const THREE = [
  { id: 'parallel', label: 'Parallel', description: 'Run both sides at once.', kind: 'proceed' },
  { id: 'backend-first', label: 'Backend first', description: 'Finish the API before the UI.', kind: 'proceed' },
  { id: 'frontend-first', label: '停下不做', description: 'Stop here and let the user decide outside this flow.', kind: 'stop' },
]

/** Tools + store + a `userQuestions` double that selects one label. */
async function fixture(selected: string | undefined, custom?: string) {
  const rootDir = await mkdtemp(join(tmpdir(), 'devflow-decision-'))
  roots.push(rootDir)
  const ctx = new Context()
  const store = new DevFlowStore(new LocalFileSystem(ctx, { cwd: rootDir, diffBasisMaxBytes: 1024 * 1024 }), './.devflow')
  const workflow = new TaskWorkflow(store)
  const agentWorkflow = new AgentWorkflow(store, workflow)
  const now = '2026-09-10T00:00:00.000Z'
  await store.saveProject({ id: 'project-decision', name: 'Decision', goal: 'Ask before choosing', currentStage: 'planning', createdAt: now, updatedAt: now })
  const askRequests: unknown[] = []
  const ask = vi.fn(async (request: unknown) => {
    askRequests.push(request)
    return { answers: [{ selected: selected === undefined ? [] : [selected], ...(custom === undefined ? {} : { custom }) }] }
  })
  ctx.provide('userQuestions', { ask })
  new SystemPrompt(ctx, {})
  const tools = new ToolRuntime(ctx)
  registerDevFlowTools(ctx, { store, workflow, agentWorkflow })
  await Promise.resolve()
  const parent = { id: 'commander-parent', options: {}, session: { header: {} }, ctx } as unknown as Agent
  const call = async (args: unknown) => await tools.execute({
    callId: 'decision-call' as never, name: 'devflow_request_decision', arguments: args as never,
    agent: parent, signal: new AbortController().signal,
  })
  const requests = async (): Promise<DecisionRequest[]> => (await store.listJournal())
    .filter(entry => entry.type === 'devflow/decision/request')
    .map(entry => (entry.data as { request: DecisionRequest }).request)
  return { ctx, store, tools, ask, askRequests, call, requests }
}

const base = { trigger: 'development-order', question: 'Which order?', recommendedOption: 'parallel' }

describe('devflow_request_decision option contract', () => {
  it('accepts the three recommended options and appends the custom one server-side', async () => {
    const f = await fixture('Parallel (Recommended)')
    const execution = await f.call({ ...base, options: THREE })

    expect(execution.isError).toBe(false)
    const [request] = await f.requests()
    expect(request?.options).toHaveLength(4)
    expect(request?.options.filter(option => option.recommended).map(option => option.id)).toEqual(['parallel'])
    expect(request?.options.at(-1)).toMatchObject({ id: 'custom', recommended: false })
    expect(request?.allowCustom).toBe(true)
    expect((execution.value as { answer: { optionId: string } }).answer).toEqual({ optionId: 'parallel' })
  })

  it('localizes the custom option copy and keeps it out of the popup option list', async () => {
    const f = await fixture('Parallel (Recommended)')
    await f.call({ ...base, options: THREE })

    // Durable record: the appended custom option carries Chinese copy, and no
    // English literal survives anywhere in the request.
    const [request] = await f.requests()
    expect(request?.options.at(-1)).toMatchObject({ id: 'custom', label: '自定义', description: '不在上述选项中，由我自行填写' })
    const durableOptions = JSON.stringify(request?.options)
    expect(durableOptions).not.toContain('Custom')
    expect(durableOptions).not.toContain('Provide a custom decision.')

    // Popup payload: only the concrete options — the composer's own free-text
    // answer is the single custom entry point, so no competing "自定义" row.
    const payload = f.askRequests[0] as { questions: { options: { label: string; description: string }[] }[] }
    const popupOptions = payload.questions[0]?.options ?? []
    expect(popupOptions).toHaveLength(3)
    expect(popupOptions.map(option => option.label)).toEqual(['Parallel (Recommended)', 'Backend first', '停下不做'])
    expect(JSON.stringify(popupOptions)).not.toContain('自定义')
    expect(JSON.stringify(popupOptions)).not.toContain('Custom')
  })

  it('accepts four options instead of rejecting the call', async () => {
    const f = await fixture('Parallel (Recommended)')
    const execution = await f.call({ ...base, options: [...THREE, { id: 'custom', label: 'Custom', description: 'User decides.' }] })

    expect(execution.isError).toBe(false)
    const [request] = await f.requests()
    // The caller's own custom entry is kept and NOT duplicated by the server.
    expect(request?.options).toHaveLength(4)
    expect(request?.options.filter(option => option.id === 'custom')).toHaveLength(1)
  })

  it('names the received value and the known ids when recommendedOption is unknown', async () => {
    const f = await fixture('Parallel')
    const execution = await f.call({ ...base, recommendedOption: 'fastest', options: THREE })

    expect(execution.isError).toBe(true)
    const message = JSON.stringify(execution)
    expect(message).toContain('fastest')
    expect(message).toContain('parallel')
    expect(message).toContain('recommendedOption')
  })

  it('names the received count when the option count is outside 3-5', async () => {
    const f = await fixture('Parallel')
    const execution = await f.call({ ...base, options: THREE.slice(0, 2) })

    expect(execution.isError).toBe(true)
    const message = JSON.stringify(execution)
    expect(message).toContain('2')
    expect(message).toContain('3-5')
  })

  it('parses options that arrive as a JSON text string', async () => {
    const f = await fixture('Parallel (Recommended)')
    const execution = await f.call({ ...base, options: JSON.stringify(THREE) })

    expect(execution.isError).toBe(false)
    const [request] = await f.requests()
    expect(request?.options.map(option => option.id)).toEqual(['parallel', 'backend-first', 'frontend-first', 'custom'])
  })

  it('keeps the durable request and answer journal on the success path', async () => {
    const f = await fixture(undefined, 'Do it my way')
    const execution = await f.call({ ...base, options: THREE })

    expect(execution.isError).toBe(false)
    expect((execution.value as { answer: { custom: string } }).answer).toEqual({ custom: 'Do it my way' })
    const types = (await f.store.listJournal()).map(entry => entry.type)
    expect(types).toContain('devflow/decision/request')
    expect(types).toContain('devflow/decision/answer')
  })
})

describe('parseDecisionRequestArgs (tool entry contract)', () => {
  it('accepts 3-5 options, marks the recommended one, and appends Custom once', () => {
    const three = parseDecisionRequestArgs({ ...base, options: THREE })
    expect(three.options.map(option => option.id)).toEqual(['parallel', 'backend-first', 'frontend-first', 'custom'])
    expect(three.options.filter(option => option.recommended).map(option => option.id)).toEqual(['parallel'])

    const five = parseDecisionRequestArgs({
      ...base,
      options: [
        ...THREE,
        { id: 'spike', label: 'Spike', description: 'Timebox a spike.', kind: 'proceed' },
        { id: 'ask', label: 'Ask', description: 'Ask again.', kind: 'retry' },
      ],
    })
    expect(five.options.map(option => option.id)).toEqual(['parallel', 'backend-first', 'frontend-first', 'spike', 'ask', 'custom'])
    expect(five.options).toHaveLength(6)
  })

  it('does not duplicate a caller-supplied custom entry', () => {
    // A caller may supply its own custom row; it is kept exactly once and is the
    // service's own row, so it never has to declare an intent.
    const args = parseDecisionRequestArgs({
      ...base,
      recommendedOption: THREE[2].id,
      options: [THREE[0], THREE[2], { id: 'custom', label: 'Custom', description: 'Mine.' }],
    })
    expect(args.options.filter(option => option.id === 'custom')).toHaveLength(1)
    expect(args.options).toHaveLength(3)
  })

  it('refuses a popup that offers no way to stop the work', () => {
    // A menu whose every route continues the work gives a user who does not
    // understand the system nothing safe to click.
    expect(() => parseDecisionRequestArgs({
      ...base,
      recommendedOption: 'a',
      options: [
        { id: 'a', label: 'A', description: 'a', kind: 'proceed' },
        { id: 'b', label: 'B', description: 'b', kind: 'retry' },
        { id: 'c', label: 'C', description: 'c', kind: 'proceed' },
      ],
    })).toThrow(/kind "stop"/)
  })

  it('refuses a popup whose recommendation is a retry', () => {
    // The production defect: "try again" was the recommended option, so the
    // default click led straight back into the wall it had just hit.
    expect(() => parseDecisionRequestArgs({
      ...base,
      recommendedOption: 'again',
      options: [
        { id: 'again', label: '再派一次', description: 'Retry the same thing.', kind: 'retry' },
        { id: 'b', label: 'B', description: 'b', kind: 'proceed' },
        { id: 'halt', label: '停下', description: 'stop', kind: 'stop' },
      ],
    })).toThrow(/may never be a retry/)
  })

  it('requires every concrete option to declare what it does', () => {
    expect(() => parseDecisionRequestArgs({
      ...base,
      recommendedOption: 'halt',
      options: [
        { id: 'a', label: 'A', description: 'a' },
        { id: 'b', label: 'B', description: 'b', kind: 'proceed' },
        { id: 'halt', label: '停下', description: 'stop', kind: 'stop' },
      ],
    })).toThrow(/kind/)
    expect(() => parseDecisionRequestArgs({
      ...base,
      recommendedOption: 'halt',
      options: [
        { id: 'a', label: 'A', description: 'a', kind: 'maybe' },
        { id: 'halt', label: '停下', description: 'stop', kind: 'stop' },
        { id: 'c', label: 'C', description: 'c', kind: 'proceed' },
      ],
    })).toThrow(/use one of proceed, retry, stop/)
  })

  it('reports the received option count and ids when outside 3-5', () => {
    expect(() => parseDecisionRequestArgs({ ...base, options: THREE.slice(0, 2) })).toThrow(/received 2 options \(parallel, backend-first\)/)
    expect(() => parseDecisionRequestArgs({
      ...base,
      options: [...THREE, { id: 'd', label: 'D', description: 'd' }, { id: 'e', label: 'E', description: 'e' }, { id: 'f', label: 'F', description: 'f' }],
    })).toThrow(/received 6 options/)
  })

  it('reports the received recommendedOption and the known ids', () => {
    expect(() => parseDecisionRequestArgs({ ...base, recommendedOption: 'fastest', options: THREE }))
      .toThrow(/recommendedOption "fastest".*parallel, backend-first, frontend-first/)
    expect(() => parseDecisionRequestArgs({ ...base, recommendedOption: '', options: THREE }))
      .toThrow(/recommendedOption ""/)
  })

  it('rejects duplicate or unusable option entries with the received values', () => {
    expect(() => parseDecisionRequestArgs({ ...base, options: [THREE[0], THREE[0], THREE[1]] }))
      .toThrow(/duplicate option id "parallel"/)
    expect(() => parseDecisionRequestArgs({ ...base, options: [THREE[0], THREE[1], { id: 'x' }] }))
      .toThrow(/options\[2\] without a usable id\/label/)
    expect(() => parseDecisionRequestArgs({ ...base, options: 'not json at all[' }))
      .toThrow(/options\[0\] must be an object|received "options" as/)
  })

  it('recovers a stringified arguments object and a stringified options array', () => {
    const args = parseDecisionRequestArgs(JSON.stringify({ ...base, options: THREE }))
    expect(args.options.map(option => option.id)).toEqual(['parallel', 'backend-first', 'frontend-first', 'custom'])

    const withText = parseDecisionRequestArgs({ ...base, options: JSON.stringify(THREE) })
    expect(withText.options).toHaveLength(4)

    expect(() => parseDecisionRequestArgs('{ not json'))
      .toThrow(/arguments.*JSON text that could not be parsed/)
    expect(() => parseDecisionRequestArgs({ ...base, options: '{ not json' }))
      .toThrow(/options.*JSON text that could not be parsed/)
  })

  it('names a bad trigger and a missing question', () => {
    expect(() => parseDecisionRequestArgs({ ...base, trigger: 'made-up', options: THREE }))
      .toThrow(/received trigger "made-up"; use one of ambiguity/)
    expect(() => parseDecisionRequestArgs({ ...base, question: '   ', options: THREE }))
      .toThrow(/non-empty "question"/)
    expect(parseDecisionRequestArgs({ ...base, options: THREE, taskId: 'task-1' }).taskId).toBe('task-1')
  })
})
