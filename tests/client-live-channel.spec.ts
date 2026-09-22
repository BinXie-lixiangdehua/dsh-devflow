import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { DEVFLOW_REMOTE, parseDevFlowEvent, parseFollowRequest, type DevFlowFollowRequest, type DevFlowRemote } from '../src/client/remote.ts'
import { CHANNEL_SILENCE_MS, CONNECTION_LOST_DETAIL, DevFlowLiveController } from '../src/client/store.ts'
import { createFlowModel } from '../src/client/flow-projection.ts'
import { createWorkspaceModel } from '../src/client/workspace.ts'
import { DEVFLOW_CLIENT_EVENT_CHANGE_LIMIT, DEVFLOW_CLIENT_EVENT_PATH_LIMIT, type DevFlowClientEvent, type DevFlowClientSnapshot } from '../src/contract.ts'
import { DevFlowChangeBus } from '../src/host/change-bus.ts'
import { recordDevFlowChange } from '../src/host/journal.ts'
import { DevFlowStore } from '../src/host/storage.ts'
import type { Project } from '../src/host/types.ts'

const AT = '2026-09-14T00:00:00.000Z'
/** Pinned instant for the projection: the stale execution must stay stale. */
const PROJECTION_NOW = Date.parse('2026-09-14T06:00:00.000Z')

function snapshot(id = 'session-a'): DevFlowClientSnapshot {
  return {
    version: 1, generatedAt: AT, session: { id, commanderMode: 'chat' }, paused: false,
    project: null, agents: [], tasks: [], phases: [], assignments: [], executions: [], decisions: [], decisionRequests: [],
  }
}

/**
 * The shape the real `.devflow` store produces: a running execution that stopped
 * four days ago (`9dcc3ba6`, `completedAt = null`) behind a later completion.
 */
function staleSnapshot(): DevFlowClientSnapshot {
  return {
    version: 1, generatedAt: AT,
    session: { id: 'session-a', commanderMode: 'commander' },
    paused: false,
    project: { id: 'project-a', name: 'DevFlow', goal: 'Ship', currentStage: 'M7' },
    agents: [
      { id: 'commander', role: 'planner', kind: 'fixed', status: 'active', displayName: '总指挥', model: 'm', skills: [], capabilities: ['task-dispatch'], delegationDepth: 0 },
      { id: 'backend-engineer', role: 'backend-engineer', kind: 'fixed', status: 'active', displayName: '后端', model: 'm', skills: ['repository-conventions'], capabilities: ['backend-implementation'], delegationDepth: 0 },
      { id: 'code-auditor', role: 'reviewer', kind: 'fixed', status: 'active', displayName: '审计', model: 'm', skills: [], capabilities: ['code-review'], delegationDepth: 0 },
    ],
    tasks: [
      { id: 'task-a', title: 'Stale dispatch', description: 'A', status: 'executing', updatedAt: '2026-09-10T14:00:00.000Z' },
      { id: 'task-b', title: 'Finished dispatch', description: 'B', status: 'completed', updatedAt: '2026-09-13T18:00:00.000Z' },
    ],
    phases: [],
    assignments: [
      { id: 'assignment-a', taskId: 'task-a', phaseId: 'phase-a', agentId: 'backend-engineer', role: 'backend-engineer', status: 'assigned' },
      { id: 'assignment-b', taskId: 'task-b', phaseId: 'phase-a', agentId: 'code-auditor', role: 'reviewer', status: 'completed' },
    ],
    executions: [
      { id: 'execution-a', assignmentId: 'assignment-a', taskId: 'task-a', agentId: 'backend-engineer', status: 'running', startedAt: '2026-09-10T14:08:14.298Z', completedAt: null },
      { id: 'execution-b', assignmentId: 'assignment-b', taskId: 'task-b', agentId: 'code-auditor', status: 'completed', startedAt: '2026-09-13T18:00:00.000Z', completedAt: '2026-09-13T18:38:45.005Z' },
    ],
    decisions: [], decisionRequests: [],
  }
}

function changed(revision: number, sequence: number | null = revision): DevFlowClientEvent {
  return { kind: 'changed', revision, sequence, changed: ['tasks/task-a.json'], changes: [], at: AT }
}

/**
 * A controllable stand-in for the Typert stream carrier, shaped like the real one.
 *
 * A stream Remote yields the frame itself: the mux carrier yields `frame.value` for
 * every `item` (`packages/api/gateway/src/client/stream-client.ts`) and the generated
 * Remote type is `AsyncIterable<T>`, never `AsyncIterable<RemoteResult<T>>`. Standing
 * in with an `{ ok, value }` envelope is how the browser defect stayed invisible here.
 */
function fakeCarrier() {
  let queue: unknown[] = []
  let notify: (() => void) | null = null
  let ending: 'end' | 'throw' | null = null
  const requests: DevFlowFollowRequest[] = []
  const remote = {
    follow: (request: DevFlowFollowRequest, signal: AbortSignal): AsyncIterable<unknown> => {
      requests.push(request)
      return (async function* frames(): AsyncGenerator<unknown> {
        for (;;) {
          if (signal.aborted) return
          if (queue.length > 0) { yield queue.shift(); continue }
          if (ending === 'throw') { ending = null; throw new Error('carrier died') }
          if (ending === 'end') { ending = null; return }
          await new Promise<void>(resolve => {
            notify = resolve
            signal.addEventListener('abort', () => { resolve() }, { once: true })
          })
          notify = null
        }
      })()
    },
  } as unknown as DevFlowRemote
  return {
    remote,
    requests,
    push(event: DevFlowClientEvent): void { queue.push(event); notify?.() },
    /** Deliver a value the strict parser must refuse (a hostile or drifted carrier). */
    pushRaw(value: unknown): void { queue.push(value); notify?.() },
    end(): void { ending = 'end'; notify?.() },
    fail(): void { ending = 'throw'; notify?.() },
  }
}

/** Deterministic timer ladder so the retry/silence behaviour is observable. */
function fakeTimers() {
  let time = 0
  let nextId = 1
  const tasks = new Map<number, { at: number; run: () => void }>()
  return {
    schedule(callback: () => void, ms: number): ReturnType<typeof setTimeout> {
      const id = nextId++
      tasks.set(id, { at: time + ms, run: callback })
      return id as unknown as ReturnType<typeof setTimeout>
    },
    clear(handle: ReturnType<typeof setTimeout>): void { tasks.delete(handle as unknown as number) },
    get pending(): number { return tasks.size },
    async advance(ms: number): Promise<void> {
      const target = time + ms
      for (;;) {
        const due = [...tasks.entries()].filter(([, task]) => task.at <= target).sort(([, left], [, right]) => left.at - right.at)[0]
        if (due === undefined) break
        tasks.delete(due[0])
        time = due[1].at
        due[1].run()
        await new Promise<void>(resolve => { setImmediate(resolve) })
      }
      time = target
      await new Promise<void>(resolve => { setImmediate(resolve) })
      await new Promise<void>(resolve => { setImmediate(resolve) })
    },
  }
}

function liveHarness() {
  const carrier = fakeCarrier()
  const timers = fakeTimers()
  const applied = { snapshots: [] as DevFlowClientSnapshot[], frames: [] as number[] }
  const controller = new DevFlowLiveController(carrier.remote, 'session-a', {
    snapshot: value => { applied.snapshots.push(value) },
    frame: event => { applied.frames.push(event.revision) },
  }, { schedule: timers.schedule, clear: timers.clear })
  return { carrier, timers, applied, controller }
}

describe('DevFlow change bus', () => {
  it('coalesces a burst of writes into one signal and keeps the newest journal sequence', async () => {
    vi.useFakeTimers()
    try {
      const bus = new DevFlowChangeBus({ windowMs: 200, pathLimit: 2, now: () => AT })
      const seen: { revision: number; sequence: number | null; changed: readonly string[] }[] = []
      bus.subscribe(signal => { seen.push(signal) })
      bus.report('tasks/task-a.json')
      bus.report('tasks/task-b.json')
      bus.report('tasks/task-c.json')
      bus.report('journal/head.json', 7)
      bus.report('journal/head.json', 3)
      expect(seen).toHaveLength(0)
      vi.advanceTimersByTime(199)
      expect(seen).toHaveLength(0)
      vi.advanceTimersByTime(1)
      expect(seen).toHaveLength(1)
      expect(seen[0]!.revision).toBe(1)
      expect(seen[0]!.sequence).toBe(7)
      // Capped at the diagnostic limit: the payload is a signal, not the change list.
      expect(seen[0]!.changed).toEqual(['tasks/task-a.json', 'tasks/task-b.json'])
      expect(bus.currentRevision).toBe(1)
      expect(bus.currentSequence).toBe(7)
    } finally { vi.useRealTimers() }
  })

  it('publishes nothing for an idle window and stops after disposal', () => {
    const bus = new DevFlowChangeBus({ windowMs: 0 })
    const seen: number[] = []
    bus.subscribe(signal => { seen.push(signal.revision) })
    bus.flush()
    expect(seen).toEqual([])
    bus.report('tasks/task-a.json')
    bus.flush()
    expect(seen).toEqual([1])
    bus.dispose()
    bus.report('tasks/task-b.json')
    bus.flush()
    expect(seen).toEqual([1])
  })

  it('reports every committed write, journal-only records included', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devflow-live-seam-'))
    try {
      const reported: { path: string; sequence: number | undefined }[] = []
      const store = new DevFlowStore(
        new LocalFileSystem(new Context(), { cwd: root, diffBasisMaxBytes: 1024 * 1024 }),
        // An absolute root, as a deployment that configures `devflowDir` uses: the
        // reporter must still recover the root-relative path from an absolute
        // backend display path.
        join(root, '.devflow'),
        (path, sequence) => { reported.push({ path, sequence }) },
      )
      const project: Project = {
        id: 'project-1', name: 'M3', goal: 'live channel', currentStage: 'host',
        createdAt: AT, updatedAt: AT,
      }
      await store.saveProject(project)
      expect(reported.map(item => item.path)).toContain('project.json')
      reported.length = 0
      await recordDevFlowChange(store, 'devflow/project/update', { project })
      // A journal publish writes the entry and the head cursor; the head write is
      // what carries the durable sequence the client can resume from.
      expect(reported.map(item => item.path)).toContain('journal/head.json')
      expect(reported.find(item => item.path === 'journal/head.json')?.sequence).toBe(1)
      expect(reported.some(item => item.path.startsWith('journal/'))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('resolves the store root the same way for the default relative devflowDir', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devflow-live-relative-'))
    try {
      const reported: string[] = []
      const store = new DevFlowStore(
        new LocalFileSystem(new Context(), { cwd: root, diffBasisMaxBytes: 1024 * 1024 }),
        // The plugin's default config is `./.devflow`; the backend still answers
        // with absolute display paths, so the relative form must work too.
        './.devflow',
        path => { reported.push(path) },
      )
      await store.saveProject({
        id: 'project-1', name: 'M3', goal: 'live channel', currentStage: 'host', createdAt: AT, updatedAt: AT,
      })
      expect(reported).toContain('project.json')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('DevFlow live channel contract', () => {
  it('declares the follow stream Remote next to the unary reads', () => {
    expect(DEVFLOW_REMOTE.descriptors).toHaveLength(4)
    const follow = DEVFLOW_REMOTE.descriptors.find(item => item.method === 'follow')
    expect(follow).toMatchObject({
      id: '@xiaoxie-ide/dsh-devflow#devflowClient/follow',
      service: 'devflowClient', namespace: 'devflow', mode: 'stream', invocation: { kind: 'direct' },
      cancellation: { parameter: 'signal' },
    })
    expect(follow?.parameters?.map(parameter => parameter.wire)).toEqual(['agentId', 'request'])
  })

  it('degrades an unusable cursor to a full read instead of failing the subscription', () => {
    expect(parseFollowRequest({ sequence: 4 })).toEqual({ sequence: 4 })
    expect(parseFollowRequest({ sequence: null })).toEqual({ sequence: null })
    expect(parseFollowRequest(undefined)).toEqual({ sequence: null })
    expect(parseFollowRequest({ sequence: -1 })).toEqual({ sequence: null })
    expect(parseFollowRequest({ sequence: 1.5 })).toEqual({ sequence: null })
    expect(parseFollowRequest({ sequence: '4' })).toEqual({ sequence: null })
  })

  it('accepts a snapshot frame and a bounded change frame', () => {
    expect(parseDevFlowEvent({ kind: 'snapshot', snapshot: snapshot() })).toMatchObject({ kind: 'snapshot' })
    expect(parseDevFlowEvent(changed(3, 9))).toEqual(changed(3, 9))
    expect(parseDevFlowEvent({ kind: 'changed', revision: 3, sequence: null, changed: [], at: AT })).toMatchObject({ sequence: null })
  })

  it('reads the semantic change list when the host sends one', () => {
    const parsed = parseDevFlowEvent({
      kind: 'changed', revision: 4, sequence: 12, changed: ['tasks/t1.json'], at: AT,
      changes: [{ type: 'execution-started', id: 'e1', at: AT }, { type: 'task-executing', id: 't1', at: AT }],
    })
    expect(parsed).toMatchObject({ changes: [{ type: 'execution-started', id: 'e1', at: AT }, { type: 'task-executing', id: 't1', at: AT }] })
  })

  it('treats an ABSENT change list as the older watermark-only frame, not as a break', () => {
    // A host that predates the field must keep working: the frame then means exactly
    // what it meant before, so the client degrades to "re-read the snapshot".
    const parsed = parseDevFlowEvent({ kind: 'changed', revision: 5, sequence: 3, changed: [], at: AT })
    expect(parsed).toMatchObject({ kind: 'changed', changes: [] })
    expect(parseDevFlowEvent({ kind: 'changed', revision: 5, sequence: 3, changed: [], changes: null, at: AT }))
      .toMatchObject({ changes: [] })
  })

  it('refuses a MALFORMED or unknown change list instead of quietly reading it as empty', () => {
    const base = { kind: 'changed', revision: 6, sequence: 4, changed: [], at: AT }
    // Present-but-unreadable is a contract break: answering `[]` would let a broken
    // host keep looking like an idle canvas, which is the exact confusion this field
    // exists to remove.
    expect(() => parseDevFlowEvent({ ...base, changes: 'nope' })).toThrow('invalid DevFlow event changes')
    expect(() => parseDevFlowEvent({ ...base, changes: [{ type: 'execution-started', id: 'e1' }] })).toThrow('invalid DevFlow event change')
    expect(() => parseDevFlowEvent({ ...base, changes: [{ type: 'not-a-kind', id: 'e1', at: AT }] })).toThrow('invalid DevFlow event change')
    expect(() => parseDevFlowEvent({
      ...base,
      changes: Array.from({ length: DEVFLOW_CLIENT_EVENT_CHANGE_LIMIT + 1 }, () => ({ type: 'execution-started', id: 'e1', at: AT })),
    })).toThrow('invalid DevFlow event changes')
  })

  it('rejects a frame it cannot trust', () => {
    expect(() => parseDevFlowEvent({ kind: 'changed', revision: -1, sequence: null, changed: [], at: AT })).toThrow('invalid DevFlow event')
    expect(() => parseDevFlowEvent({ kind: 'changed', revision: 1, sequence: null, changed: [], at: 'not-a-time' })).toThrow('invalid DevFlow event')
    expect(() => parseDevFlowEvent({
      kind: 'changed', revision: 1, sequence: null, at: AT,
      changed: Array.from({ length: DEVFLOW_CLIENT_EVENT_PATH_LIMIT + 1 }, (_, index) => `tasks/${index}.json`),
    })).toThrow('invalid DevFlow event paths')
    expect(() => parseDevFlowEvent({ kind: 'other' })).toThrow('invalid DevFlow event kind')
  })
})

describe('DevFlowLiveController', () => {
  it('subscribes to the carrier own frames — not a RemoteResult envelope — and reports the cursor', async () => {
    // Declared exactly as the generated stream signature and the real mux carrier are:
    // a stream yields `DevFlowClientEvent` values. A consumer that reads `{ ok, value }`
    // cannot type-check against this stand-in, and at runtime it would throw on the very
    // first frame — which is what the browser did while this suite stayed green.
    const requests: DevFlowFollowRequest[] = []
    let release: (() => void) | null = null
    const remote = {
      follow: (request: DevFlowFollowRequest): AsyncIterable<DevFlowClientEvent> => {
        requests.push(request)
        return (async function* carrier(): AsyncGenerator<DevFlowClientEvent> {
          yield { kind: 'snapshot', snapshot: snapshot() }
          yield changed(7, 42)
          await new Promise<void>(resolve => { release = resolve })
        })()
      },
    } as unknown as DevFlowRemote
    const applied = { snapshots: [] as DevFlowClientSnapshot[], frames: [] as number[] }
    const controller = new DevFlowLiveController(remote, 'session-a', {
      snapshot: value => { applied.snapshots.push(value) },
      frame: event => { applied.frames.push(event.revision) },
    })

    controller.start()
    await vi.waitFor(() => { expect(applied.frames).toEqual([7]) })
    expect(requests).toEqual([{ sequence: null }])
    expect(applied.snapshots).toHaveLength(1)
    expect(controller.getConnection()).toMatchObject({ phase: 'live', sequence: 42, revision: 7, attempts: 0, detail: null })
    release?.()
    controller.dispose()
  })

  it('announces a channel whose frames cannot be trusted instead of passing it off as live', async () => {
    const { carrier, timers, applied, controller } = liveHarness()
    controller.start()
    // A hostile or drifted carrier: a shape the strict parser refuses. The channel must
    // not claim `live` over data it cannot read, and it must still recover afterwards.
    carrier.pushRaw({ kind: 'changed', revision: -1, sequence: null, changed: [], at: AT })
    await vi.waitFor(() => { expect(controller.getConnection().phase).toBe('polling') })
    expect(controller.getConnection().detail).toBe(CONNECTION_LOST_DETAIL)
    expect(controller.getConnection().attempts).toBe(1)
    expect(applied.snapshots).toHaveLength(0)
    expect(applied.frames).toEqual([])

    await timers.advance(1_000)
    carrier.push({ kind: 'snapshot', snapshot: snapshot() })
    await vi.waitFor(() => { expect(controller.getConnection().phase).toBe('live') })
    expect(controller.getConnection().attempts).toBe(0)
    controller.dispose()
  })

  it('opens with a snapshot, then folds newer revisions in and ignores the rest', async () => {
    const { carrier, applied, controller } = liveHarness()
    controller.start()
    carrier.push({ kind: 'snapshot', snapshot: snapshot() })
    await vi.waitFor(() => { expect(controller.getConnection().phase).toBe('live') })
    expect(applied.snapshots).toHaveLength(1)
    expect(controller.getConnection()).toMatchObject({ phase: 'live', attempts: 0, detail: null })

    carrier.push(changed(1, 4))
    await vi.waitFor(() => { expect(applied.frames).toEqual([1]) })
    expect(controller.getConnection().sequence).toBe(4)

    // Duplicate and out-of-order frames are droppable: the channel is a signal,
    // and the snapshot path behind it stays the single source of truth.
    carrier.push(changed(1, 4))
    carrier.push(changed(0, 2))
    await new Promise<void>(resolve => { setImmediate(resolve) })
    expect(applied.frames).toEqual([1])

    carrier.push(changed(2, 5))
    await vi.waitFor(() => { expect(applied.frames).toEqual([1, 2]) })
    controller.dispose()
  })

  it('ignores a snapshot for another session instead of showing foreign state', async () => {
    const { carrier, applied, controller } = liveHarness()
    controller.start()
    carrier.push({ kind: 'snapshot', snapshot: snapshot('session-b') })
    await new Promise<void>(resolve => { setImmediate(resolve) })
    expect(applied.snapshots).toHaveLength(0)
    expect(controller.getConnection().phase).toBe('connecting')
    controller.dispose()
  })

  it('announces a dead carrier, keeps polling, and recovers on the retry ladder', async () => {
    const { carrier, timers, controller } = liveHarness()
    controller.start()
    carrier.push({ kind: 'snapshot', snapshot: snapshot() })
    await vi.waitFor(() => { expect(controller.getConnection().phase).toBe('live') })

    carrier.end()
    await vi.waitFor(() => { expect(controller.getConnection().phase).toBe('polling') })
    expect(controller.getConnection().detail).toBe('实时连接已断开，正在使用轮询')
    expect(controller.getConnection().attempts).toBe(1)
    expect(timers.pending).toBe(1)

    await timers.advance(1_000)
    expect(carrier.requests).toHaveLength(2)
    carrier.push({ kind: 'snapshot', snapshot: snapshot() })
    await vi.waitFor(() => { expect(controller.getConnection().phase).toBe('live') })
    expect(controller.getConnection().attempts).toBe(0)
    expect(timers.pending).toBe(1)
    controller.dispose()
  })

  it('backs off while the carrier keeps failing and stops retrying after disposal', async () => {
    const { carrier, timers, controller } = liveHarness()
    controller.start()
    carrier.fail()
    await vi.waitFor(() => { expect(controller.getConnection().phase).toBe('polling') })
    expect(controller.getConnection().detail).toBe(CONNECTION_LOST_DETAIL)
    await timers.advance(1_000)
    carrier.fail()
    await vi.waitFor(() => { expect(controller.getConnection().attempts).toBe(2) })
    // Second failure waits longer than the first.
    await timers.advance(1_000)
    expect(carrier.requests).toHaveLength(2)
    await timers.advance(1_000)
    expect(carrier.requests).toHaveLength(3)
    controller.dispose()
    await timers.advance(60_000)
    expect(carrier.requests).toHaveLength(3)
  })

  it('treats a silent live channel as a lost one', async () => {
    const { carrier, timers, controller } = liveHarness()
    controller.start()
    carrier.push({ kind: 'snapshot', snapshot: snapshot() })
    await vi.waitFor(() => { expect(controller.getConnection().phase).toBe('live') })

    await timers.advance(CHANNEL_SILENCE_MS - 1)
    expect(controller.getConnection().phase).toBe('live')
    await timers.advance(1)
    await vi.waitFor(() => { expect(controller.getConnection().phase).toBe('polling') })
    controller.dispose()
  })

  it('opens the channel once the Remote mounts after the controller exists', async () => {
    const carrier = fakeCarrier()
    const timers = fakeTimers()
    const controller = new DevFlowLiveController(undefined, 'session-a', {
      snapshot: () => {}, frame: () => {},
    }, { schedule: timers.schedule, clear: timers.clear })
    controller.start()
    expect(carrier.requests).toHaveLength(0)
    expect(controller.getConnection().phase).toBe('connecting')

    controller.setRemote(carrier.remote)
    await vi.waitFor(() => { expect(carrier.requests).toHaveLength(1) })
    expect(carrier.requests[0]).toEqual({ sequence: null })

    // A Remote that goes away is announced and never silently treated as live.
    controller.setRemote(undefined)
    expect(controller.getConnection()).toMatchObject({ phase: 'polling', detail: CONNECTION_LOST_DETAIL })
    controller.dispose()
  })

  it('keeps the five-state judgement unchanged while events update the data', async () => {
    const source = staleSnapshot()
    const before = createFlowModel(createWorkspaceModel(source), PROJECTION_NOW)
    // The real `.devflow` shape: one running execution four days old, plus a later
    // completion ⇒ the hard "earlier than a later completion" rule applies.
    expect(before.history.edges.map(edge => edge.state)).toEqual(['lost', 'done'])

    const { carrier, applied, controller } = liveHarness()
    controller.start()
    carrier.push({ kind: 'snapshot', snapshot: source })
    await vi.waitFor(() => { expect(applied.snapshots).toHaveLength(1) })
    carrier.push(changed(1, 6))
    await vi.waitFor(() => { expect(applied.frames).toEqual([1]) })

    // The channel delivered a snapshot through the strict parser; the judgement it
    // feeds is the same one the previous round fixed.
    const after = createFlowModel(createWorkspaceModel(applied.snapshots[0]!), PROJECTION_NOW)
    expect(after.history.edges.map(edge => edge.state)).toEqual(before.history.edges.map(edge => edge.state))
    expect(after.history.edges.filter(edge => edge.state === 'executing')).toHaveLength(0)
    expect(after.lostCount).toBe(1)
    expect(after.current.edges.filter(edge => edge.state === 'executing')).toHaveLength(0)
    controller.dispose()
  })

  it('notifies connection subscribers only when the posture changes', async () => {
    const { carrier, controller } = liveHarness()
    let notifications = 0
    const unsubscribe = controller.subscribe(() => { notifications += 1 })
    expect(controller.getSnapshot().phase).toBe('connecting')
    controller.start()
    carrier.push({ kind: 'snapshot', snapshot: snapshot() })
    await vi.waitFor(() => { expect(controller.getConnection().phase).toBe('live') })
    const afterFirst = notifications
    carrier.push({ kind: 'changed', revision: 1, sequence: 1, changed: [], at: AT })
    carrier.push({ kind: 'changed', revision: 2, sequence: 1, changed: [], at: AT })
    await vi.waitFor(() => { expect(controller.getConnection().revision).toBe(2) })
    expect(notifications).toBeGreaterThan(afterFirst)
    unsubscribe()
    controller.dispose()
  })
})
