import { describe, expect, expectTypeOf, it } from 'vitest'
import type { TypertRemoteScopeApi } from '@deepseek-ai/dsh-typert-protocol'
import { DEVFLOW_REMOTE, parseDevFlowAuditResponse, parseDevFlowResponse, type DevFlowRemote } from '../src/client/remote.ts'

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    generatedAt: '2026-08-29T10:00:00.000Z',
    session: { id: 'session-a', commanderMode: 'chat' },
    paused: false,
    project: null,
    agents: [], tasks: [], phases: [], assignments: [], executions: [], decisions: [], decisionRequests: [],
    ...overrides,
  }
}

describe('DevFlow Remote contract', () => {
  it('uses the Harness Agent lookup wire field, including audit-page without a session parameter', () => {
    expectTypeOf<DevFlowRemote>().toEqualTypeOf<TypertRemoteScopeApi<'agent'>['devflow']>()
    expect(DEVFLOW_REMOTE.descriptors).toHaveLength(4)
    for (const descriptor of DEVFLOW_REMOTE.descriptors) {
      expect(descriptor.invocation).toEqual({ kind: 'direct' })
      expect(descriptor.scope).toEqual({ context: 'agent', wire: 'agentId' })
      expect(descriptor.parameters?.[0]).toEqual(expect.objectContaining({
        name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent',
      }))
    }
    const audit = DEVFLOW_REMOTE.descriptors.find(item => item.method === 'audit-page')
    expect(audit?.parameters).toHaveLength(2)
    expect(audit?.parameters?.[1]).toMatchObject({ name: 'query', wire: 'query', source: 'json' })
    // The live channel rides the same scoped Remote boundary as a stream, so the
    // carrier owns cancellation and the client never opens a side channel.
    const follow = DEVFLOW_REMOTE.descriptors.find(item => item.method === 'follow')
    expect(follow).toMatchObject({ mode: 'stream', cancellation: { parameter: 'signal' } })
    expect(follow?.parameters?.map(parameter => parameter.wire)).toEqual(['agentId', 'request'])
  })

  it('accepts an older V1 snapshot that lacks additive summaries', () => {
    const response = parseDevFlowResponse({ kind: 'snapshot', snapshot: snapshot() })
    expect(response).toMatchObject({ kind: 'snapshot', snapshot: { version: 1 } })
    if (response.kind === 'snapshot') expect(response.snapshot.results).toBeUndefined()
  })

  it('accepts bounded safe summaries while dropping unknown outer fields', () => {
    const response = parseDevFlowResponse({
      kind: 'snapshot',
      snapshot: snapshot({
        reports: [{ id: 'report-1', executionId: 'execution-1', agentId: 'agent-1', source: 'report', status: 'failed', at: 'now', summary: { text: 'safe', truncated: false, redacted: false }, leaked: 'not accepted' }],
        outerLeak: 'not accepted',
      }),
    })
    if (response.kind !== 'snapshot') throw new Error('expected snapshot')
    expect(JSON.stringify(response)).not.toContain('not accepted')
    expect(response.snapshot.reports?.[0]).toMatchObject({ id: 'report-1', summary: { text: 'safe' } })
  })

  it('validates safe bounded audit pages and drops unknown fields', () => {
    const response = parseDevFlowAuditResponse({
      kind: 'page', page: {
        version: 1, source: 'devflow-journal', projectId: 'project-a', range: { from: '2026-08-01T00:00:00.000Z', to: '2026-08-30T00:00:00.000Z' },
        items: [{ id: 'item-a', sequence: 4, category: 'task', action: 'transitioned', at: '2026-08-29T10:00:00.000Z', entity: { type: 'task', id: 'task-a', display: null, leaked: 'secret' }, related: { taskId: 'task-a', leaked: 'secret' }, status: 'completed', summary: { text: 'safe', truncated: false, redacted: false, leaked: 'secret' }, incomplete: false, leaked: 'secret' }],
        nextCursor: null, capturedHeadSequence: 5, omittedUnsafeCount: 0, truncated: false, leaked: 'secret',
      },
    })
    expect(response.kind).toBe('page')
    expect(JSON.stringify(response)).not.toContain('secret')
    expect(() => parseDevFlowAuditResponse({ kind: 'page', page: { version: 1, source: 'devflow-journal', projectId: null, range: { from: 'now', to: 'later' }, items: Array.from({ length: 21 }, () => ({})), nextCursor: null, capturedHeadSequence: null, omittedUnsafeCount: 0, truncated: false } })).toThrow('invalid DevFlow audit page')
  })

  it('rejects unbounded or unsafe summary payloads', () => {
    expect(() => parseDevFlowResponse({ kind: 'snapshot', snapshot: snapshot({
      reports: Array.from({ length: 21 }, (_, index) => ({ id: String(index), executionId: 'execution-1', agentId: 'agent-1', source: 'report', status: 'success', at: 'now', summary: { text: 'safe', truncated: false, redacted: false } })),
    }) })).toThrow('invalid DevFlow snapshot')
    expect(() => parseDevFlowResponse({ kind: 'snapshot', snapshot: snapshot({
      reports: [{ id: 'report-1', executionId: 'execution-1', agentId: 'agent-1', source: 'report', status: 'success', at: 'now', summary: { text: 'x'.repeat(501), truncated: false, redacted: false } }],
    }) })).toThrow('invalid DevFlow snapshot')
  })
})
