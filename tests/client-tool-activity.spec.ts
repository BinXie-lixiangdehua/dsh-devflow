import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import type { CurrentSessionSources } from '../src/client/tool-activity.ts'
import {
  equalCurrentSessionToolsState,
  mapCurrentSessionTools,
  type SafeOfficialToolActivity,
} from '../src/client/tool-activity.ts'

const SESSION_A = 'session-a'
const START_TIME = Date.UTC(2026, 7, 30, 10, 0, 0)

function snapshot(nodes: readonly unknown[], overrides: Record<string, unknown> = {}): CurrentSessionSources {
  const entries = nodes.map((node, index) => [`node-${index}`, node] as const)
  const byKey = new Map(entries)
  const { chat, ...sessionOverrides } = overrides
  return {
    session: {
      sessionId: SESSION_A,
      running: true,
      subagent: null,
      openState: 'open',
      hasMore: false,
      ...sessionOverrides,
    },
    chat: chat ?? {
      order: entries.map(([key]) => key),
      nodes: { get: (key: string) => byKey.get(key), values: () => nodes },
    },
  } as unknown as CurrentSessionSources
}

function runningNode(callId: string, anchorSeq: number, options: Record<string, unknown> = {}): unknown {
  return {
    key: `tool-call:${callId}`,
    kind: 'tool-call',
    id: callId,
    target: 'chat',
    anchorSeq,
    location: { kind: 'turn', turn: { status: 'open' } },
    visibility: 'visible',
    data: {
      root: {
        callId,
        name: `tool-${callId}`,
        argsRaw: 'RAW_ARGUMENT_MARKER',
        turn: 1,
        step: 1,
        time: START_TIME + anchorSeq,
        callView: null,
        subCalls: [],
        ...options,
      },
    },
  }
}

function resultNode(callId: string, startSeq: number, resultSeq: number, options: Record<string, unknown> = {}): unknown {
  return {
    key: `tool-call:${callId}`,
    kind: 'tool-call',
    id: callId,
    target: 'chat',
    anchorSeq: startSeq,
    location: { kind: 'turn', turn: { status: 'open' } },
    visibility: 'visible',
    data: {
      root: {
        kind: 'tool-result',
        seq: resultSeq,
        time: START_TIME + resultSeq,
        callId,
        call: { name: `tool-${callId}`, argsRaw: 'RAW_ARGUMENT_MARKER' },
        callTime: START_TIME + startSeq,
        content: [{ type: 'text', text: 'RAW_CONTENT_MARKER' }],
        isError: false,
        error: { name: 'RAW_ERROR_NAME_MARKER', code: 'RAW_ERROR_CODE_MARKER' },
        meta: { secret: 'RAW_META_MARKER' },
        callView: { kind: 'RAW_CALL_VIEW_MARKER' },
        resultView: { kind: 'RAW_RESULT_VIEW_MARKER' },
        subCalls: [],
        ...options,
      },
    },
  }
}

function onlyItem(nodes: readonly unknown[], overrides: Record<string, unknown> = {}): SafeOfficialToolActivity {
  const state = mapCurrentSessionTools(SESSION_A, snapshot(nodes, overrides))
  expect(state.items).toHaveLength(1)
  return state.items[0]!
}

function containsReference(value: unknown, targets: ReadonlySet<object>, seen = new Set<object>()): boolean {
  if (value === null || typeof value !== 'object') return false
  if (targets.has(value)) return true
  if (seen.has(value)) return false
  seen.add(value)
  return Object.values(value).some(child => containsReference(child, targets, seen))
}

describe('current-session official tool activity mapper', () => {
  it('maps an official paired result with valid status, sequence, and duration', () => {
    const item = onlyItem([resultNode('paired', 10, 12, {
      callTime: START_TIME,
      time: START_TIME + 750,
    })])

    expect(item).toEqual({
      id: 'session-a:paired',
      source: 'harness-official-tool',
      sessionId: 'session-a',
      callId: 'paired',
      toolName: 'tool-paired',
      status: 'succeeded',
      startedAt: new Date(START_TIME).toISOString(),
      endedAt: new Date(START_TIME + 750).toISOString(),
      durationMs: 750,
      startSeq: 10,
      resultSeq: 12,
      resultSummary: 'completed',
      devflowRelation: { kind: 'unknown' },
    })
  })

  it('upgrades a late result under the same identity without a duplicate card', () => {
    const running = mapCurrentSessionTools(SESSION_A, snapshot([runningNode('late', 20)]))
    const settled = mapCurrentSessionTools(SESSION_A, snapshot([
      runningNode('late', 20),
      resultNode('late', 20, 21),
    ]))

    expect(running.items).toHaveLength(1)
    expect(running.items[0]).toMatchObject({ id: 'session-a:late', status: 'running' })
    expect(settled.items).toHaveLength(1)
    expect(settled.items[0]).toMatchObject({ id: 'session-a:late', status: 'succeeded', resultSeq: 21 })
  })

  it('maps an in-flight root as running without result facts', () => {
    expect(onlyItem([runningNode('active', 30)])).toMatchObject({
      status: 'running',
      startSeq: 30,
      resultSeq: null,
      endedAt: null,
      durationMs: null,
      resultSummary: 'running',
    })
  })

  it('omits an unconfirmed historical call without claiming it is running', () => {
    const state = mapCurrentSessionTools(SESSION_A, snapshot([runningNode('historical', 31)], { running: false }))

    expect(state).toMatchObject({ phase: 'ready', incompleteCount: 1, items: [] })
    expect(JSON.stringify(state)).not.toContain('historical')
  })

  it('maps a result without a visible call without guessing call facts', () => {
    const item = onlyItem([resultNode('orphan', 40, 40, {
      call: null,
      callTime: null,
      isError: true,
    })])

    expect(item).toMatchObject({
      toolName: 'Unknown tool',
      status: 'result-without-call',
      startedAt: null,
      startSeq: null,
      resultSeq: 40,
      durationMs: null,
      resultSummary: 'result received without visible call',
    })
  })

  it('maps failures to fixed output and treats synthetic interruption as an unconfirmed result', () => {
    const failed = onlyItem([resultNode('failed', 50, 51, { isError: true })])
    const interrupted = mapCurrentSessionTools(SESSION_A, snapshot([resultNode('interrupted', 60, 61.01, {
      isError: true,
      time: START_TIME + 9_999,
    })]))

    expect(failed).toMatchObject({ status: 'failed', resultSummary: 'failed', resultSeq: 51 })
    expect(JSON.stringify(failed)).not.toMatch(/RAW_ERROR_(?:NAME|CODE)_MARKER/)
    expect(interrupted).toMatchObject({ phase: 'ready', incompleteCount: 1, items: [] })
    expect(JSON.stringify(interrupted)).not.toContain('interrupted')
  })

  it('validates tool names by Unicode length and control characters', () => {
    const accepted = '工'.repeat(127) + '🛠'
    const overlong = '🛠'.repeat(129)
    const state = mapCurrentSessionTools(SESSION_A, snapshot([
      runningNode('accepted', 1, { name: accepted }),
      runningNode('overlong', 2, { name: overlong }),
      runningNode('control', 3, { name: 'read\u0000secret' }),
      runningNode('format', 4, { name: 'read\u202esecret' }),
      runningNode('empty', 5, { name: '' }),
    ]))

    expect(state.items.find(item => item.callId === 'accepted')?.toolName).toBe(accepted)
    expect(state.items.filter(item => item.callId !== 'accepted').map(item => item.toolName)).toEqual([
      'Unknown tool', 'Unknown tool', 'Unknown tool', 'Unknown tool',
    ])
  })

  it('drops invalid call identities and keeps malformed scalar facts null', () => {
    const state = mapCurrentSessionTools(SESSION_A, snapshot([
      runningNode('', 1),
      runningNode('x'.repeat(129), 2),
      runningNode('bad\u0000id', 3),
      runningNode('safe', Number.NaN, { time: -1 }),
      resultNode('reversed-time', 5, 6, { callTime: START_TIME + 20, time: START_TIME + 10 }),
      resultNode('reversed-sequence', 8, 7),
      resultNode('malformed-result', 9, Number.NaN),
    ]))

    expect(state.items.map(item => item.callId)).toEqual(['reversed-time', 'safe'])
    expect(state.items.find(item => item.callId === 'safe')).toMatchObject({ startSeq: null, startedAt: null })
    expect(state.items.find(item => item.callId === 'reversed-time')?.durationMs).toBeNull()
  })

  it('never reads or retains forbidden raw fields', () => {
    const accesses: string[] = []
    const rawCall = { name: 'safe-tool' } as { name: string; argsRaw?: string }
    Object.defineProperty(rawCall, 'argsRaw', { enumerable: true, get: () => { accesses.push('argsRaw'); return 'CREDENTIAL_TOKEN_PATH_PROMPT_MARKER' } })
    const rawRoot = {
      kind: 'tool-result', seq: 71, time: START_TIME + 71, callId: 'secure', call: rawCall,
      callTime: START_TIME + 70, isError: true,
    } as Record<string, unknown>
    const forbiddenObjects: object[] = [rawCall]
    for (const key of ['content', 'meta', 'error', 'callView', 'resultView', 'subCalls', 'futureMetadata']) {
      const value = { marker: `FORBIDDEN_${key}_CREDENTIAL_TOKEN_PATH_PROMPT` }
      forbiddenObjects.push(value)
      Object.defineProperty(rawRoot, key, { enumerable: true, get: () => { accesses.push(key); return value } })
    }
    const rawNode = {
      key: 'tool-call:secure', kind: 'tool-call', id: 'secure', target: 'chat', anchorSeq: 70,
      location: { kind: 'turn', turn: { status: 'open' } }, visibility: 'visible', data: { root: rawRoot },
    }
    forbiddenObjects.push(rawRoot, rawNode, rawNode.data)

    const mapped = mapCurrentSessionTools(SESSION_A, snapshot([rawNode]))
    const serialized = JSON.stringify(mapped)

    expect(accesses).toEqual([])
    expect(serialized).not.toMatch(/FORBIDDEN|CREDENTIAL|TOKEN|PATH|PROMPT|RAW_/)
    expect(serialized).not.toMatch(/argsRaw|content|meta|error|callView|resultView|subCalls|futureMetadata/)
    expect(containsReference(mapped, new Set(forbiddenObjects))).toBe(false)
    rawCall.name = 'mutated-raw-tool'
    expect(mapped.items[0]?.toolName).toBe('safe-tool')
  })

  it('deduplicates, sorts stably, and retains only the latest 20 safe activities', () => {
    const nodes = Array.from({ length: 25 }, (_, index) => runningNode(`call-${String(index).padStart(2, '0')}`, index))
    nodes.push(runningNode('tie-b', 30), runningNode('tie-a', 30))
    nodes.push(resultNode('call-24', 24, 40))

    const state = mapCurrentSessionTools(SESSION_A, snapshot(nodes))

    expect(state.items).toHaveLength(20)
    expect(state.items.slice(0, 3).map(item => [item.callId, item.resultSeq ?? item.startSeq])).toEqual([
      ['call-24', 40], ['tie-a', 30], ['tie-b', 30],
    ])
    expect(new Set(state.items.map(item => item.id)).size).toBe(20)
    expect(state.items.find(item => item.callId === 'call-24')?.status).toBe('succeeded')
    expect(state.items.at(-1)?.callId).toBe('call-07')
  })

  it('fails closed across session mismatch, subagent scope, and A-B-A mapping', () => {
    const a = mapCurrentSessionTools('session-a', snapshot([runningNode('same-call', 1)]))
    const bSnapshot = snapshot([runningNode('same-call', 2)], { sessionId: 'session-b' })
    const mismatch = mapCurrentSessionTools('session-a', bSnapshot)
    const b = mapCurrentSessionTools('session-b', bSnapshot)
    const aAgain = mapCurrentSessionTools('session-a', snapshot([runningNode('a-return', 3)]))
    const child = mapCurrentSessionTools('session-a', snapshot([runningNode('child-call', 4)], {
      subagent: { address: {}, parentAvailable: true },
    }))

    expect(a.items[0]?.id).toBe('session-a:same-call')
    expect(mismatch).toMatchObject({ phase: 'unavailable', items: [] })
    expect(b.items[0]?.id).toBe('session-b:same-call')
    expect(aAgain.items.map(item => item.id)).toEqual(['session-a:a-return'])
    expect(child).toMatchObject({ phase: 'unavailable', items: [] })
  })

  it('represents loaded-window lifecycle and capability failures honestly', () => {
    const empty = mapCurrentSessionTools(SESSION_A, snapshot([]))
    const loading = mapCurrentSessionTools(SESSION_A, snapshot([runningNode('visible', 1)], { openState: 'loading', hasMore: true }))
    const unavailable = mapCurrentSessionTools(SESSION_A, snapshot([runningNode('safe-stale', 2)], { openState: 'error' }))
    const badStore = mapCurrentSessionTools(SESSION_A, snapshot([], { chat: { order: ['bad'], nodes: { get: () => { throw new Error('RAW_HOST_PATH') } } } }))
    const missingStore = mapCurrentSessionTools(SESSION_A, snapshot([], { chat: { order: [] } }))

    expect(empty).toMatchObject({ phase: 'ready', items: [], hasMore: false, staleSafeItems: false })
    expect(loading).toMatchObject({ phase: 'loading', hasMore: true, staleSafeItems: true })
    expect(loading.items).toHaveLength(1)
    expect(unavailable).toMatchObject({ phase: 'unavailable', staleSafeItems: true })
    expect(unavailable.items).toHaveLength(1)
    expect(badStore).toMatchObject({ phase: 'unavailable', items: [] })
    expect(missingStore).toMatchObject({ phase: 'unavailable', items: [] })
    expect(JSON.stringify(badStore)).not.toContain('RAW_HOST_PATH')
  })

  it('skips hidden and unsupported future lifecycle nodes', () => {
    const hidden = runningNode('hidden', 1) as { visibility: string }
    hidden.visibility = 'hidden'
    const future = resultNode('future', 2, 3, { kind: 'cancelled' })
    const malformedOutcome = resultNode('bad-outcome', 4, 5, { isError: 'true' })
    const state = mapCurrentSessionTools(SESSION_A, snapshot([
      hidden, future, malformedOutcome, runningNode('visible-safe', 6),
    ]))

    expect(state.items.map(item => item.callId)).toEqual(['visible-safe'])
  })

  it('skips an envelope with throwing getters without hiding safe peers', () => {
    const malformed = runningNode('envelope', 1) as Record<string, unknown>
    Object.defineProperty(malformed, 'kind', { get: () => { throw new Error('RAW_ENVELOPE_FIELD') } })
    const state = mapCurrentSessionTools(SESSION_A, snapshot([malformed, runningNode('safe-envelope-peer', 2)]))

    expect(state.phase).toBe('ready')
    expect(state.items.map(item => item.callId)).toEqual(['safe-envelope-peer'])
    expect(JSON.stringify(state)).not.toContain('RAW_ENVELOPE_FIELD')
  })

  it('fails closed when extreme valid Unicode scalars exceed the 32 KiB safe-state budget', () => {
    const sessionId = '会'.repeat(128)
    const nodes = Array.from({ length: 20 }, (_, index) => runningNode(`${'号'.repeat(126)}${String(index).padStart(2, '0')}`, index, {
      name: '工'.repeat(128),
    }))
    const state = mapCurrentSessionTools(sessionId, snapshot(nodes, { sessionId }))

    expect(state).toMatchObject({ phase: 'unavailable', items: [] })
  })

  it('skips one malformed future tool node without hiding safe peers', () => {
    const malformed = runningNode('malformed', 1) as { data: { root: Record<string, unknown> } }
    Object.defineProperty(malformed.data.root, 'name', { get: () => { throw new Error('RAW_FUTURE_FIELD') } })
    const state = mapCurrentSessionTools(SESSION_A, snapshot([malformed, runningNode('safe-peer', 2)]))

    expect(state.phase).toBe('ready')
    expect(state.items.map(item => item.callId)).toEqual(['safe-peer'])
    expect(JSON.stringify(state)).not.toContain('RAW_FUTURE_FIELD')
  })

  it('compares only the bounded safe state', () => {
    const left = mapCurrentSessionTools(SESSION_A, snapshot([runningNode('equal', 1)]))
    const right = mapCurrentSessionTools(SESSION_A, snapshot([runningNode('equal', 1)]))
    const changed = mapCurrentSessionTools(SESSION_A, snapshot([resultNode('equal', 1, 2)]))

    expect(equalCurrentSessionToolsState(left, right)).toBe(true)
    expect(equalCurrentSessionToolsState(left, changed)).toBe(false)
  })

  it('keeps a large raw window bounded without copying raw content', () => {
    const marker = `RAW_LARGE_CONTENT_CREDENTIAL_PROMPT_${'x'.repeat(64 * 1024)}`
    const nodes = Array.from({ length: 4_000 }, (_, index) => resultNode(`large-${index}`, index * 2, index * 2 + 1, {
      content: [{ type: 'text', text: marker }],
      meta: { marker },
      error: { name: marker, code: marker },
      subCalls: [{ callId: `nested-${index}`, name: marker, argsRaw: marker, time: START_TIME }],
    }))

    const started = performance.now()
    const state = mapCurrentSessionTools(SESSION_A, snapshot(nodes, { hasMore: true }))
    const elapsedMs = performance.now() - started
    const serialized = JSON.stringify(state)

    expect(elapsedMs).toBeLessThan(5_000)
    expect(state.items).toHaveLength(20)
    expect(state.items[0]?.resultSeq).toBe(7_999)
    expect(serialized.length).toBeLessThan(32 * 1024)
    expect(serialized).not.toContain('RAW_LARGE_CONTENT_CREDENTIAL_PROMPT')
    expect(serialized).not.toContain('nested-')
  }, 10_000)
})
