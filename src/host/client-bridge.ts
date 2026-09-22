/** Public Typert Remote bridge for the DevFlow client snapshot. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  DevFlowClientAuditPageResponse,
  DevFlowClientAuditQuery,
  DevFlowClientEvent,
  DevFlowClientSnapshotResponse,
} from '../contract.ts'
import type { DevflowController } from './index.ts'
import { DevFlowSessionScopeError } from './session-store.ts'
import type { DevFlowChangeSignal } from './change-bus.ts'
import { DevFlowAuditPager } from './client-audit.ts'
import { createDevFlowClientSnapshot } from './client-snapshot.ts'

const STATE_UNAVAILABLE = {
  code: 'state-unavailable',
  message: 'DevFlow state is unavailable. Refresh to try again.',
} as const

/**
 * The 第九步 refusal: this session has no workspace, so it has no project.
 *
 * It is a DIFFERENT code from the generic one on purpose. "Could not be
 * isolated" and "failed to load" call for different responses, and a shared
 * library served under the generic code would be indistinguishable from an
 * isolated read.
 */
const SCOPE_UNAVAILABLE = {
  code: 'scope-unavailable',
  message: 'DevFlow cannot isolate this session: it has no project workspace. Shared state is not shown.',
} as const

/** What the client tells the channel it already holds. */
export interface DevFlowFollowRequest {
  /** Durable journal head the client's last snapshot was read at, or null when unknown. */
  readonly sequence: number | null
}

/** How long a quiet channel waits before proving itself with one signal. */
const KEEPALIVE_MS = 15_000

/** Gateway-discoverable, path-free read/refresh service for the Canvas. */
export class DevFlowClientBridge extends TypertRemoteService {
  static inject = ['devflow']

  constructor(ctx: Context) {
    super(ctx, 'devflowClient', { namespace: 'devflow' })
  }

  @Remote('snapshot')
  async snapshot(agent: Agent): Promise<DevFlowClientSnapshotResponse> {
    return this.read(agent)
  }

  @Remote('refresh')
  async refresh(agent: Agent): Promise<DevFlowClientSnapshotResponse> {
    return this.read(agent)
  }

  @Remote('audit-page')
  async auditPage(agent: Agent, query: DevFlowClientAuditQuery): Promise<DevFlowClientAuditPageResponse> {
    // The pager is built per call over the CALLING session's store: an audit
    // panel opened in project B pages through project B's journal only.
    try {
      const scope = this.ctx.devflow.resolveSessionScope(agent)
      return await new DevFlowAuditPager(scope.store).page(query)
    } catch {
      return { kind: 'error', error: { code: 'audit-unavailable', message: 'DevFlow audit is unavailable. Refresh to try again.' } }
    }
  }

  /**
   * Follow the committed DevFlow state: one opening snapshot, then one signal per
   * coalesced change batch.
   *
   * The channel is intentionally thin. It never sends derived state — only the
   * read model the client could have fetched itself, plus "the state moved on".
   * That is what makes a frame droppable and a replay harmless: the client decides
   * what to re-read, and the existing snapshot path stays the single source of
   * truth. A quiet channel still emits a keepalive signal, so a dead carrier is
   * noticed rather than looking like "nothing is happening".
   *
   * @param agent - the scoped Agent whose session is being followed.
   * @param request - what the client already holds (`sequence`).
   * @param signal - cancellation owned by the Remote stream carrier.
   * @returns the opening snapshot followed by ordered change signals.
   */
  @Remote({ mode: 'stream' })
  async *follow(
    agent: Agent,
    request: DevFlowFollowRequest,
    signal: AbortSignal,
  ): AsyncIterable<DevFlowClientEvent> {
    const bus = this.ctx.devflow.changeBus
    // Which project this channel follows. The key is resolved once per stream:
    // a session's scope is pinned for its lifetime, so the subscription below
    // can drop every frame that belongs to another project's store.
    let sessionKey: string
    try {
      sessionKey = this.ctx.devflow.resolveSessionScope(agent).sessionKey
    } catch {
      // A session that cannot be scoped has nothing to follow, and the stream
      // carries no error frame shape: it ends unopened rather than forwarding
      // another project's changes. The unary snapshot path names the refusal
      // (`scope-unavailable`), which is what the panel shows.
      return
    }
    // The opening frame is always the read model: whether the client is behind, or
    // the host restarted (its in-process revision means nothing to a fresh client),
    // a snapshot is the only correct starting point.
    let baseline: DevFlowClientSnapshotResponse
    try {
      baseline = { kind: 'snapshot', snapshot: await createDevFlowClientSnapshot(this.ctx.devflow, agent) }
    } catch {
      baseline = { kind: 'error', error: STATE_UNAVAILABLE }
    }
    if (baseline.kind === 'error') return
    yield { kind: 'snapshot', snapshot: baseline.snapshot }
    void request

    // One queue, so a burst of signals is drained in order without piling up: the
    // consumer's pace decides, and the bus has already coalesced by window.
    const pending: DevFlowChangeSignal[] = []
    let wake: (() => void) | null = null
    const unsubscribe = bus.subscribe(signal => {
      // Another project's committed write is not this channel's news. The frame
      // is dropped rather than forwarded, so project A's canvas can never redraw
      // because project B wrote something.
      if (signal.sessionKey !== undefined && signal.sessionKey !== sessionKey) return
      pending.push(signal)
      wake?.()
    })
    const onAbort = (): void => { wake?.() }
    signal.addEventListener('abort', onAbort)
    try {
      while (!signal.aborted) {
        if (pending.length === 0) {
          await new Promise<void>(resolve => {
            let settled = false
            const finish = (): void => {
              if (settled) return
              settled = true
              clearTimeout(timer)
              wake = null
              resolve()
            }
            const timer = setTimeout(finish, KEEPALIVE_MS)
            wake = finish
          })
        }
        if (signal.aborted) break
        // Collapse the whole drained batch into its newest signal: the client only
        // needs "the state moved to revision N", never each intermediate step. The
        // newest signal also carries the newest change list, which is a hint about
        // WHAT moved — never a replacement for the snapshot the client re-reads.
        let latest = pending.pop()
        pending.length = 0
        if (latest === undefined) latest = { revision: bus.currentRevision, sequence: bus.currentSequence, changed: [], changes: [], at: new Date().toISOString() }
        yield {
          kind: 'changed',
          revision: latest.revision,
          sequence: latest.sequence,
          changed: latest.changed,
          changes: latest.changes.map(change => ({ type: change.type, id: change.id, at: change.at })),
          at: latest.at,
        }
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      unsubscribe()
    }
  }

  private async read(agent: Agent): Promise<DevFlowClientSnapshotResponse> {
    try {
      return { kind: 'snapshot', snapshot: await createDevFlowClientSnapshot(this.ctx.devflow, agent) }
    } catch (cause) {
      // A session that cannot be scoped is refused BY NAME: the panel must be
      // able to tell "this session has no project to isolate" from a plain read
      // failure, because only the first one means nothing is being shown that
      // belongs to another project.
      if (cause instanceof DevFlowSessionScopeError) return { kind: 'error', error: SCOPE_UNAVAILABLE }
      return { kind: 'error', error: STATE_UNAVAILABLE }
    }
  }
}
