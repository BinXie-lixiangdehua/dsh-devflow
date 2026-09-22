/**
 * In-process latency measurement for the live event channel.
 *
 * This is the 段一 (pre-restart) half of the evidence: it uses the REAL change bus,
 * the REAL file-backed store and the REAL client live/snapshot controllers with
 * real timers, so the numbers cover the commit -> signal -> client-state path. The
 * transport is a stand-in that mirrors the host bridge's shape (opening snapshot,
 * then coalesced change frames), because the Typert carrier and the browser are
 * only exercised by the 段二 measurement after the host restart.
 *
 * Bounds are the product acceptance bar (<= 2s), never a tight timing assertion, so
 * the file cannot become a flake.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { DevFlowClientEvent, DevFlowClientSnapshot, DevFlowClientSnapshotResponse } from '../src/contract.ts'
import type { DevFlowFollowRequest, DevFlowRemote } from '../src/client/remote.ts'
import { DevFlowLiveController, DevFlowSnapshotController } from '../src/client/store.ts'
import { DevFlowChangeBus } from '../src/host/change-bus.ts'
import { DevFlowStore } from '../src/host/storage.ts'
import type { Project } from '../src/host/types.ts'

const ACCEPTANCE_MS = 2_000

function project(name: string): Project {
  return { id: 'project-1', name, goal: 'live channel', currentStage: 'host', createdAt: '2026-09-14T00:00:00.000Z', updatedAt: '2026-09-14T00:00:00.000Z' }
}

function clientSnapshot(name: string | null): DevFlowClientSnapshot {
  return {
    version: 1, generatedAt: new Date().toISOString(), session: { id: 'session-a', commanderMode: 'chat' }, paused: false,
    project: name === null ? null : { id: 'project-1', name, goal: 'live channel', currentStage: 'host' },
    agents: [], tasks: [], phases: [], assignments: [], executions: [], decisions: [], decisionRequests: [],
  }
}

/**
 * Mirrors the host bridge: an opening snapshot, then one frame per bus signal.
 *
 * `snapshot`/`refresh` are unary, so they answer with a `RemoteResult` envelope; `follow`
 * is a stream, so it yields the frames themselves — exactly what the mux carrier does.
 */
function bridgeLikeCarrier(bus: DevFlowChangeBus, read: () => Promise<DevFlowClientSnapshot>) {
  const remote = {
    snapshot: async (): Promise<RemoteResult<DevFlowClientSnapshotResponse>> => ({ ok: true, value: { kind: 'snapshot', snapshot: await read() } }),
    refresh: async (): Promise<RemoteResult<DevFlowClientSnapshotResponse>> => ({ ok: true, value: { kind: 'snapshot', snapshot: await read() } }),
    follow: (_request: DevFlowFollowRequest, signal: AbortSignal) => (async function* frames(): AsyncGenerator<DevFlowClientEvent> {
      yield { kind: 'snapshot', snapshot: await read() }
      const pending: DevFlowClientEvent[] = []
      let wake: (() => void) | null = null
      const unsubscribe = bus.subscribe(signal => {
        pending.push({ kind: 'changed', revision: signal.revision, sequence: signal.sequence, changed: signal.changed, at: signal.at })
        wake?.()
      })
      try {
        while (!signal.aborted) {
          if (pending.length === 0) {
            await new Promise<void>(resolve => {
              wake = resolve
              signal.addEventListener('abort', () => { resolve() }, { once: true })
            })
            wake = null
          }
          if (signal.aborted) return
          const latest = pending.pop()
          pending.length = 0
          if (latest !== undefined) yield latest
        }
      } finally { unsubscribe() }
    })(),
  } as unknown as DevFlowRemote
  return remote
}

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('live channel metrics (real timers)', () => {
  it('measures commit -> bus signal -> client state within the 2s acceptance bar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devflow-live-metrics-'))
    roots.push(root)
    const bus = new DevFlowChangeBus({ windowMs: 200 })
    const fs = new LocalFileSystem(new Context(), { cwd: root, diffBasisMaxBytes: 1024 * 1024 })
    const store = new DevFlowStore(fs, join(root, '.devflow'), path => { bus.report(path) })
    const read = async (): Promise<DevFlowClientSnapshot> => clientSnapshot((await store.loadProject())?.name ?? null)
    const remote = bridgeLikeCarrier(bus, read)

    const controller = new DevFlowSnapshotController(remote, 'session-a')
    await controller.ensure()
    const live = new DevFlowLiveController(remote, 'session-a', {
      snapshot: snapshot => { controller.acceptSnapshot(snapshot) },
      frame: () => { void controller.refresh() },
    })
    live.start()
    await new Promise<void>(resolve => { setTimeout(resolve, 50) })
    expect(live.getConnection().phase).toBe('live')

    const samples: number[] = []
    for (let index = 0; index < 5; index += 1) {
      const name = `live-${index}`
      const commitAt = performance.now()
      await store.saveProject(project(name))
      while (controller.getSnapshot().snapshot?.project?.name !== name) {
        if (performance.now() - commitAt > ACCEPTANCE_MS) break
        await new Promise<void>(resolve => { setTimeout(resolve, 5) })
      }
      const latency = performance.now() - commitAt
      samples.push(latency)
      expect(controller.getSnapshot().snapshot?.project?.name).toBe(name)
    }
    const worst = Math.max(...samples)
    console.log(`[live-metrics] commit->state ms: ${samples.map(value => value.toFixed(1)).join(', ')} | worst ${worst.toFixed(1)}`)
    expect(worst).toBeLessThan(ACCEPTANCE_MS)
    expect(controller.getSnapshot().snapshot?.project?.name).toBe('live-4')
    expect(bus.currentRevision).toBe(5)
    live.dispose()
  })

  it('coalesces a burst so one write burst costs one client re-read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devflow-live-burst-'))
    roots.push(root)
    await mkdir(join(root, '.devflow'), { recursive: true })
    const bus = new DevFlowChangeBus({ windowMs: 200 })
    const fs = new LocalFileSystem(new Context(), { cwd: root, diffBasisMaxBytes: 1024 * 1024 })
    const store = new DevFlowStore(fs, join(root, '.devflow'), path => { bus.report(path) })
    const read = async (): Promise<DevFlowClientSnapshot> => clientSnapshot((await store.loadProject())?.name ?? null)
    const remote = bridgeLikeCarrier(bus, read)

    const controller = new DevFlowSnapshotController(remote, 'session-a')
    await controller.ensure()
    let reads = 0
    // Count client re-reads on the same Remote the snapshot controller uses, so a
    // signal storm would show up as a fan-out of unary reads.
    const counted = {
      snapshot: () => remote.snapshot(),
      refresh: async () => { reads += 1; return remote.refresh() },
      follow: (request: DevFlowFollowRequest, signal: AbortSignal) => remote.follow(request, signal),
    } as unknown as DevFlowRemote
    controller.setRemote(counted)
    const live = new DevFlowLiveController(counted, 'session-a', {
      snapshot: snapshot => { controller.acceptSnapshot(snapshot) },
      frame: () => { void controller.refresh() },
    })
    live.start()
    await new Promise<void>(resolve => { setTimeout(resolve, 50) })
    expect(live.getConnection().phase).toBe('live')
    reads = 0

    const started = performance.now()
    for (let index = 0; index < 20; index += 1) await store.saveProject(project(`burst-${index}`))
    while (controller.getSnapshot().snapshot?.project?.name !== 'burst-19') {
      if (performance.now() - started > ACCEPTANCE_MS) break
      await new Promise<void>(resolve => { setTimeout(resolve, 5) })
    }
    const settled = performance.now() - started
    console.log(`[live-metrics] 20 writes -> ${bus.currentRevision} signal(s), ${reads} client re-read(s), settled in ${settled.toFixed(1)} ms`)
    expect(controller.getSnapshot().snapshot?.project?.name).toBe('burst-19')
    // A burst must not fan out into one re-read per file write.
    expect(bus.currentRevision).toBeLessThanOrEqual(3)
    expect(reads).toBeLessThanOrEqual(3)
    expect(settled).toBeLessThan(ACCEPTANCE_MS)
    live.dispose()
  })
})
