import { describe, expect, it, vi } from 'vitest'
import { DevFlowAuditController } from '../src/client/store.ts'
import type { DevFlowClientAuditPageResponse } from '../src/contract.ts'
import type { DevFlowRemote } from '../src/client/remote.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(inner => { resolve = inner })
  return { promise, resolve }
}

const filter = { kind: 'project' as const }
function page(sequences: number[], cursor: string | null = null): DevFlowClientAuditPageResponse {
  return { kind: 'page', page: { version: 1, source: 'devflow-journal', projectId: 'project-a', range: { from: '2026-08-01T00:00:00.000Z', to: '2026-08-30T00:00:00.000Z' }, items: sequences.map(sequence => ({ id: `entry-${sequence}`, sequence, category: 'task' as const, action: 'transitioned' as const, at: '2026-08-29T10:00:00.000Z', entity: { type: 'task' as const, id: `task-${sequence}`, display: null }, related: { taskId: `task-${sequence}` }, status: 'executing', summary: null, incomplete: false })), nextCursor: cursor, capturedHeadSequence: 100, omittedUnsafeCount: 0, truncated: false } }
}

describe('DevFlowAuditController', () => {
  it('does not repeat a failed query until the user explicitly retries', async () => {
    const remote = { 'audit-page': vi.fn(async () => ({ ok: false as const, error: { code: 'offline', message: 'offline', details: {} } })) } as unknown as DevFlowRemote
    const controller = new DevFlowAuditController(remote)

    await controller.ensure(filter)
    await controller.ensure({ kind: 'project' })

    expect(controller.getSnapshot()).toMatchObject({ phase: 'error', filter, page: null })
    expect(remote['audit-page']).toHaveBeenCalledTimes(1)

    await controller.retry()
    expect(remote['audit-page']).toHaveBeenCalledTimes(2)
  })

  it('loads more with dedupe and stable descending sequence order', async () => {
    const remote = { 'audit-page': vi.fn()
      .mockResolvedValueOnce({ ok: true as const, value: page([5, 4, 3], 'older') })
      .mockResolvedValueOnce({ ok: true as const, value: page([3, 2, 1]) }) } as unknown as DevFlowRemote
    const controller = new DevFlowAuditController(remote)
    await controller.ensure(filter)
    await controller.loadMore()
    expect(controller.getSnapshot()).toMatchObject({ phase: 'ready', page: { items: [{ sequence: 5 }, { sequence: 4 }, { sequence: 3 }, { sequence: 2 }, { sequence: 1 }] } })
    expect(remote['audit-page']).toHaveBeenNthCalledWith(1, { filter })
    expect(remote['audit-page']).toHaveBeenNthCalledWith(2, { filter, cursor: 'older' })
  })

  it('keeps a per-controller stale page on failure and does not cross sessions', async () => {
    const remoteA = { 'audit-page': vi.fn(async () => ({ ok: true as const, value: page([5]) })) } as unknown as DevFlowRemote
    const remoteB = { 'audit-page': vi.fn(async () => ({ ok: false as const, error: { code: 'offline', message: 'offline', details: {} } })) } as unknown as DevFlowRemote
    const a = new DevFlowAuditController(remoteA)
    const b = new DevFlowAuditController(remoteB)
    await a.ensure(filter)
    await a.refresh()
    await b.ensure(filter)
    expect(a.getSnapshot()).toMatchObject({ phase: 'ready', page: { items: [{ id: 'entry-5' }] } })
    expect(b.getSnapshot()).toMatchObject({ phase: 'error', page: null, error: { code: 'audit-unavailable' } })
  })

  it('resets the page when the shared project scope changes under the same filter', async () => {
    const remote = { 'audit-page': vi.fn()
      .mockResolvedValueOnce({ ok: true as const, value: page([5]) })
      .mockResolvedValueOnce({ ok: true as const, value: { kind: 'page', page: { ...page([3]).page, projectId: 'project-b' } } }) } as unknown as DevFlowRemote
    const controller = new DevFlowAuditController(remote)

    await controller.ensure(filter, 'project-a')
    await controller.ensure(filter, 'project-b')

    expect(remote['audit-page']).toHaveBeenCalledTimes(2)
    expect(controller.getSnapshot()).toMatchObject({ phase: 'ready', filter, page: { items: [{ sequence: 3 }] } })
  })

  it('rejects a page returned for a different project scope', async () => {
    const remote = { 'audit-page': vi.fn(async () => ({ ok: true as const, value: page([5]) })) } as unknown as DevFlowRemote
    const controller = new DevFlowAuditController(remote)

    await controller.ensure(filter, 'project-b')

    expect(controller.getSnapshot()).toMatchObject({ phase: 'error', page: null, error: { code: 'audit-unavailable' } })
  })

  it('clears the old project page when scope changes while the Remote is unavailable', async () => {
    const remote = { 'audit-page': vi.fn(async () => ({ ok: true as const, value: page([5]) })) } as unknown as DevFlowRemote
    const controller = new DevFlowAuditController(remote)
    await controller.ensure(filter, 'project-a')
    controller.setRemote(undefined)

    await controller.ensure(filter, 'project-b')

    expect(controller.getSnapshot()).toMatchObject({ phase: 'error', filter, page: null })
  })

  it('does not carry a stale page across filters when the Remote is unavailable', async () => {
    const remote = { 'audit-page': vi.fn(async () => ({ ok: true as const, value: page([5]) })) } as unknown as DevFlowRemote
    const controller = new DevFlowAuditController(remote)
    await controller.ensure({ kind: 'task', id: 'task-a' })
    controller.setRemote(undefined)

    await controller.ensure({ kind: 'task', id: 'task-b' })

    expect(controller.getSnapshot()).toMatchObject({ phase: 'error', filter: { kind: 'task', id: 'task-b' }, page: null })
  })

  it('ignores late responses after a filter reset', async () => {
    const first = deferred<{ ok: true; value: DevFlowClientAuditPageResponse }>()
    const second = deferred<{ ok: true; value: DevFlowClientAuditPageResponse }>()
    const remote = { 'audit-page': vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise) } as unknown as DevFlowRemote
    const controller = new DevFlowAuditController(remote)
    const firstLoad = controller.ensure({ kind: 'task', id: 'task-a' })
    const secondLoad = controller.ensure({ kind: 'agent', id: 'agent-a' })
    first.resolve({ ok: true, value: page([4]) })
    second.resolve({ ok: true, value: page([3]) })
    await Promise.all([firstLoad, secondLoad])
    expect(controller.getSnapshot()).toMatchObject({ filter: { kind: 'agent', id: 'agent-a' }, page: { items: [{ sequence: 3 }] } })
  })
})
