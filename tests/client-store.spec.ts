import { describe, expect, it, vi } from 'vitest'
import { DevFlowSnapshotController } from '../src/client/store.ts'
import type { DevFlowClientSnapshot, DevFlowClientSnapshotResponse } from '../src/contract.ts'
import type { DevFlowRemote } from '../src/client/remote.ts'

const snapshot = (id: string): DevFlowClientSnapshot => ({
  version: 1, generatedAt: 'now', session: { id, commanderMode: 'chat' }, paused: false,
  project: null, agents: [], tasks: [], phases: [], assignments: [], executions: [], decisions: [], decisionRequests: [],
})

describe('DevFlowSnapshotController', () => {
  it('deduplicates initial loads and publishes the response', async () => {
    let resolve: ((value: { ok: true; value: DevFlowClientSnapshotResponse }) => void) | undefined
    const remote = { snapshot: vi.fn(() => new Promise(r => { resolve = r })), refresh: vi.fn() } as unknown as DevFlowRemote
    const controller = new DevFlowSnapshotController(remote, 'session-a')
    const first = controller.ensure()
    const second = controller.ensure()
    expect(first).toBe(second)
    resolve?.({ ok: true, value: { kind: 'snapshot', snapshot: snapshot('session-a') } })
    await first
    expect(controller.getSnapshot()).toMatchObject({ phase: 'ready', snapshot: { session: { id: 'session-a' } } })
    expect(remote.snapshot).toHaveBeenCalledWith()
    expect(remote.refresh).not.toHaveBeenCalled()
  })

  it('keeps stale data visible on a refresh error and exposes a retryable state', async () => {
    const remote = {
      snapshot: vi.fn(async () => ({ ok: true as const, value: { kind: 'snapshot' as const, snapshot: snapshot('session-a') } })),
      refresh: vi.fn(async () => ({ ok: false as const, error: { code: 'internal', message: 'offline', details: {} } })),
    } as unknown as DevFlowRemote
    const controller = new DevFlowSnapshotController(remote, 'session-a')
    await controller.ensure()
    controller.markStale()
    expect(controller.getSnapshot().phase).toBe('refreshing')
    await controller.refresh()
    expect(controller.getSnapshot()).toMatchObject({ phase: 'error', snapshot: { session: { id: 'session-a' } }, error: { code: 'state-unavailable' } })
  })

  it('exposes a retryable error until the Remote is mounted, then refreshes through it', async () => {
    const remote = {
      snapshot: vi.fn(async () => ({ ok: true as const, value: { kind: 'snapshot' as const, snapshot: snapshot('session-a') } })),
      refresh: vi.fn(async () => ({ ok: true as const, value: { kind: 'snapshot' as const, snapshot: snapshot('session-a') } })),
    } as unknown as DevFlowRemote
    const controller = new DevFlowSnapshotController(undefined, 'session-a')

    await controller.refresh()
    expect(controller.getSnapshot()).toMatchObject({ phase: 'error', error: { code: 'state-unavailable' } })

    controller.setRemote(remote)
    await vi.waitFor(() => { expect(controller.getSnapshot().phase).toBe('ready') })
    expect(remote.refresh).toHaveBeenCalledWith()
  })

  it('rejects a snapshot returned for another session', async () => {
    const remote = {
      snapshot: vi.fn(async () => ({ ok: true as const, value: { kind: 'snapshot' as const, snapshot: snapshot('session-b') } })),
      refresh: vi.fn(),
    } as unknown as DevFlowRemote
    const controller = new DevFlowSnapshotController(remote, 'session-a')

    await controller.ensure()

    expect(controller.getSnapshot()).toMatchObject({ phase: 'error', snapshot: null, error: { code: 'state-unavailable' } })
  })

  it('keeps Inspector tabs isolated and restorable across A-B-A remounts', () => {
    const a = new DevFlowSnapshotController(undefined, 'session-a')
    const b = new DevFlowSnapshotController(undefined, 'session-b')

    // The dispatch-flow canvas is the default view of the third tab.
    expect(a.getInspectorTab()).toBe('flow')
    expect(b.getInspectorTab()).toBe('flow')
    a.setInspectorTab('tools')
    b.setInspectorTab('audit')

    expect(a.getInspectorTab()).toBe('tools')
    expect(b.getInspectorTab()).toBe('audit')
    expect(a.getInspectorTab()).toBe('tools')
  })

  it('keeps two session controllers independent', async () => {
    const remoteA = {
      snapshot: vi.fn(async () => ({ ok: true as const, value: { kind: 'snapshot' as const, snapshot: snapshot('session-a') } })),
      refresh: vi.fn(),
    } as unknown as DevFlowRemote
    const remoteB = {
      snapshot: vi.fn(async () => ({ ok: true as const, value: { kind: 'snapshot' as const, snapshot: snapshot('session-b') } })),
      refresh: vi.fn(),
    } as unknown as DevFlowRemote
    const a = new DevFlowSnapshotController(remoteA, 'session-a')
    const b = new DevFlowSnapshotController(remoteB, 'session-b')
    await Promise.all([a.ensure(), b.ensure()])
    expect(a.getSnapshot()).toMatchObject({ snapshot: { session: { id: 'session-a' } } })
    expect(b.getSnapshot()).toMatchObject({ snapshot: { session: { id: 'session-b' } } })
    expect(remoteA.snapshot).toHaveBeenCalledWith()
    expect(remoteB.snapshot).toHaveBeenCalledWith()
  })
})
