import type {
  DevFlowClientActivationFailure,
  DevFlowClientAttemptSummary,
  DevFlowClientAuditError,
  DevFlowClientAuditFilter,
  DevFlowClientAuditItem,
  DevFlowClientAuditPage,
  DevFlowClientAuditPageResponse,
  DevFlowClientAuditQuery,
  DevFlowClientBlocked,
  DevFlowClientChange,
  DevFlowClientEvent,
  DevFlowClientFailureSummary,
  DevFlowClientReportSummary,
  DevFlowClientResultSummary,
  DevFlowClientSafeText,
  DevFlowClientSession,
  DevFlowClientSnapshot,
  DevFlowClientSnapshotResponse,
} from '../contract.ts'
import {
  DEVFLOW_CLIENT_AUDIT_PAGE_BYTES,
  DEVFLOW_CLIENT_AUDIT_PAGE_LIMIT,
  DEVFLOW_CLIENT_AUDIT_PAGE_VERSION,
  DEVFLOW_CLIENT_AUDIT_TEXT_LIMIT,
  DEVFLOW_CLIENT_CHANGE_KINDS,
  DEVFLOW_CLIENT_EVENT_CHANGE_LIMIT,
  DEVFLOW_CLIENT_EVENT_PATH_LIMIT,
} from '../contract.ts'
import type { RemoteResult, TypertRemoteContribution, TypertRemoteScopeApi } from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/dsh-typert-protocol' {
  // A stream Remote yields its frames directly. The generator emits exactly this
  // shape (`emitter.ts`: `AsyncIterable<T>` for `mode: 'stream'`,
  // `Promise<RemoteResult<T>>` for unary), and the mux carrier yields `frame.value`
  // per `item` (`stream-client.ts`). Declaring the envelope here is what let the
  // controller read `result.ok` off a raw frame and never go live.
  interface TypertRemoteMap {
    'devflow/snapshot': (sessionId: string) => Promise<RemoteResult<DevFlowClientSnapshotResponse>>
    'devflow/refresh': (sessionId: string) => Promise<RemoteResult<DevFlowClientSnapshotResponse>>
    'devflow/audit-page': (sessionId: string, query: DevFlowClientAuditQuery) => Promise<RemoteResult<DevFlowClientAuditPageResponse>>
    'devflow/follow': (sessionId: string, request: DevFlowFollowRequest) => AsyncIterable<DevFlowClientEvent>
  }
  interface TypertRemoteNamespaceMap {
    devflow: TypertRemoteNamespace
  }
  interface TypertRemoteScopeMap {
    'agent:devflow/snapshot': () => Promise<RemoteResult<DevFlowClientSnapshotResponse>>
    'agent:devflow/refresh': () => Promise<RemoteResult<DevFlowClientSnapshotResponse>>
    'agent:devflow/audit-page': (query: DevFlowClientAuditQuery) => Promise<RemoteResult<DevFlowClientAuditPageResponse>>
    'agent:devflow/follow': (request: DevFlowFollowRequest, signal: AbortSignal) => AsyncIterable<DevFlowClientEvent>
  }
}

/** What the client tells the live channel it already holds. */
export interface DevFlowFollowRequest {
  /** Durable journal head the client's last snapshot was read at, or null when unknown. */
  readonly sequence: number | null
}

export interface TypertRemoteNamespace {
  snapshot(sessionId: string): Promise<RemoteResult<DevFlowClientSnapshotResponse>>
  refresh(sessionId: string): Promise<RemoteResult<DevFlowClientSnapshotResponse>>
  auditPage(sessionId: string, query: DevFlowClientAuditQuery): Promise<RemoteResult<DevFlowClientAuditPageResponse>>
  /** Streams the frames themselves; there is no `RemoteResult` envelope on a stream. */
  follow(sessionId: string, request: DevFlowFollowRequest, signal: AbortSignal): AsyncIterable<DevFlowClientEvent>
}

export type DevFlowRemote = TypertRemoteScopeApi<'agent'>['devflow']

const agentParameter = {
  name: 'agent', wire: 'agentId', source: 'lookup' as const, lookup: 'agent',
  codec: { mode: 'strict' as const, typeSymbol: 'session-id', schema: { parse: (value: unknown) => requireString(value, 'session id') } },
}

/** Client-side Remote contribution for DevFlow's narrow public bridge. */
export const DEVFLOW_REMOTE: TypertRemoteContribution = {
  package: '@xiaoxie-ide/dsh-devflow',
  descriptors: [
    {
      id: '@xiaoxie-ide/dsh-devflow#devflowClient/snapshot',
      service: 'devflowClient', namespace: 'devflow', method: 'snapshot', invocation: { kind: 'direct' },
      scope: { context: 'agent', wire: 'agentId' },
      parameters: [agentParameter],
      result: { mode: 'strict', typeSymbol: 'devflow-client-snapshot-response', schema: { parse: parseDevFlowResponse } },
    },
    {
      id: '@xiaoxie-ide/dsh-devflow#devflowClient/refresh',
      service: 'devflowClient', namespace: 'devflow', method: 'refresh', invocation: { kind: 'direct' },
      scope: { context: 'agent', wire: 'agentId' },
      parameters: [agentParameter],
      result: { mode: 'strict', typeSymbol: 'devflow-client-snapshot-response', schema: { parse: parseDevFlowResponse } },
    },
    {
      id: '@xiaoxie-ide/dsh-devflow#devflowClient/audit-page',
      service: 'devflowClient', namespace: 'devflow', method: 'audit-page', implementation: 'auditPage', invocation: { kind: 'direct' },
      scope: { context: 'agent', wire: 'agentId' },
      parameters: [agentParameter, {
        name: 'query', wire: 'query', source: 'json',
        codec: { mode: 'strict', typeSymbol: 'devflow-client-audit-query', schema: { parse: parseAuditQuery } },
      }],
      result: { mode: 'strict', typeSymbol: 'devflow-client-audit-page-response', schema: { parse: parseDevFlowAuditResponse } },
    },
    {
      // The live channel: one opening snapshot, then coalesced change signals. It is
      // a stream Remote, so the carrier owns cancellation and the client's `signal`
      // closes the subscription when the panel unmounts or the session changes.
      id: '@xiaoxie-ide/dsh-devflow#devflowClient/follow',
      service: 'devflowClient', namespace: 'devflow', method: 'follow', mode: 'stream', invocation: { kind: 'direct' },
      scope: { context: 'agent', wire: 'agentId' },
      parameters: [agentParameter, {
        name: 'request', wire: 'request', source: 'json',
        codec: { mode: 'strict', typeSymbol: 'devflow-client-follow-request', schema: { parse: parseFollowRequest } },
      }],
      cancellation: { parameter: 'signal' },
      result: { mode: 'strict', typeSymbol: 'devflow-client-event', schema: { parse: parseDevFlowEvent } },
    },
  ],
}

/**
 * Strictly parse the follow request. The cursor is advisory — a channel that cannot
 * read it still opens with a full snapshot — so anything unrecognized degrades to
 * `null` rather than failing the subscription.
 */
export function parseFollowRequest(value: unknown): DevFlowFollowRequest {
  if (!isRecord(value)) return { sequence: null }
  const sequence = value.sequence
  return { sequence: typeof sequence === 'number' && Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : null }
}

/** Strictly parse one live-channel frame; an unknown shape is dropped by the caller. */
export function parseDevFlowEvent(value: unknown): DevFlowClientEvent {
  if (!isRecord(value) || typeof value.kind !== 'string') throw new Error('invalid DevFlow event')
  if (value.kind === 'snapshot') {
    const parsed = parseDevFlowResponse({ kind: 'snapshot', snapshot: value.snapshot })
    if (parsed.kind !== 'snapshot') throw new Error('invalid DevFlow event snapshot')
    return { kind: 'snapshot', snapshot: parsed.snapshot }
  }
  if (value.kind !== 'changed') throw new Error('invalid DevFlow event kind')
  const revision = value.revision
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) throw new Error('invalid DevFlow event revision')
  const sequence = value.sequence
  if (sequence !== null && (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 0)) {
    throw new Error('invalid DevFlow event sequence')
  }
  if (typeof value.at !== 'string' || !validTime(value.at)) throw new Error('invalid DevFlow event time')
  if (!Array.isArray(value.changed) || value.changed.length > DEVFLOW_CLIENT_EVENT_PATH_LIMIT
    || !value.changed.every(item => isBoundedString(item, 240))) throw new Error('invalid DevFlow event paths')
  return {
    kind: 'changed',
    revision,
    sequence: sequence === null ? null : sequence,
    changed: value.changed as readonly string[],
    changes: parseChanges(value.changes),
    at: value.at,
  }
}

/**
 * Read the optional semantic change list off one frame.
 *
 * Absent is the ordinary case for an older host and answers `[]` — the frame then
 * means exactly what it meant before this field existed. A PRESENT but malformed
 * list throws, because "the host sent a shape we cannot read" is the contract-break
 * the caller must degrade on; quietly returning `[]` would let a broken contract
 * keep looking like an idle canvas. An unknown `type` is likewise a contract break:
 * the vocabulary is closed, so a new kind means a newer host and this build must not
 * guess at it.
 * @param value - the raw `changes` value.
 * @returns the bounded change list, or `[]` when the field is absent.
 */
function parseChanges(value: unknown): readonly DevFlowClientChange[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > DEVFLOW_CLIENT_EVENT_CHANGE_LIMIT) {
    throw new Error('invalid DevFlow event changes')
  }
  return value.map((item) => {
    if (!isRecord(item) || !isBoundedString(item.type, 64) || !DEVFLOW_CLIENT_CHANGE_KINDS.includes(item.type)
      || !isBoundedString(item.id, 128) || !validTime(item.at)) {
      throw new Error('invalid DevFlow event change')
    }
    return { type: item.type, id: item.id, at: item.at }
  })
}

export function parseDevFlowResponse(value: unknown): DevFlowClientSnapshotResponse {
  if (!isRecord(value) || typeof value.kind !== 'string') throw new Error('invalid DevFlow bridge response')
  if (value.kind === 'error') {
    if (!isRecord(value.error)) throw new Error('invalid DevFlow bridge error')
    // The isolation refusal is its own code: it means "this session has no
    // project workspace", which the panel words differently from a plain read
    // failure. An unknown code is still a contract break.
    if (value.error.code === 'scope-unavailable'
      && value.error.message === 'DevFlow cannot isolate this session: it has no project workspace. Shared state is not shown.') {
      return { kind: 'error', error: { code: 'scope-unavailable', message: 'DevFlow cannot isolate this session: it has no project workspace. Shared state is not shown.' } }
    }
    if (value.error.code !== 'state-unavailable'
      || value.error.message !== 'DevFlow state is unavailable. Refresh to try again.') throw new Error('invalid DevFlow bridge error')
    return { kind: 'error', error: { code: 'state-unavailable', message: 'DevFlow state is unavailable. Refresh to try again.' } }
  }
  if (value.kind !== 'snapshot' || !isRecord(value.snapshot)) throw new Error('invalid DevFlow bridge response')
  const snapshot = value.snapshot
  if (snapshot.version !== 1 || typeof snapshot.generatedAt !== 'string' || !isRecord(snapshot.session)
    || typeof snapshot.session.id !== 'string'
    || (snapshot.session.commanderMode !== 'chat' && snapshot.session.commanderMode !== 'commander')
    || typeof snapshot.paused !== 'boolean' || !Array.isArray(snapshot.agents) || !Array.isArray(snapshot.tasks)
    || !Array.isArray(snapshot.phases) || !Array.isArray(snapshot.assignments) || !Array.isArray(snapshot.executions)
    || !Array.isArray(snapshot.decisions) || !Array.isArray(snapshot.decisionRequests)
    || (snapshot.project !== null && !isRecord(snapshot.project)) || !optionalSummaries(snapshot)
    || !optionalArray(snapshot.blocked, isBlockedRow)) throw new Error('invalid DevFlow snapshot')
  return {
    kind: 'snapshot', snapshot: {
      version: 1, generatedAt: snapshot.generatedAt,
      session: normalizeSessionState(snapshot.session), paused: snapshot.paused,
      project: snapshot.project as DevFlowClientSnapshot['project'], agents: snapshot.agents as DevFlowClientSnapshot['agents'],
      tasks: snapshot.tasks as DevFlowClientSnapshot['tasks'], phases: snapshot.phases as DevFlowClientSnapshot['phases'],
      assignments: snapshot.assignments as DevFlowClientSnapshot['assignments'], executions: snapshot.executions as DevFlowClientSnapshot['executions'],
      ...(snapshot.results === undefined ? {} : { results: (snapshot.results as unknown[]).map(normalizeResultSummary) }),
      ...(snapshot.reports === undefined ? {} : { reports: (snapshot.reports as unknown[]).map(normalizeReportSummary) }),
      ...(snapshot.attempts === undefined ? {} : { attempts: (snapshot.attempts as unknown[]).map(normalizeAttemptSummary) }),
      ...(snapshot.failures === undefined ? {} : { failures: (snapshot.failures as unknown[]).map(normalizeFailureSummary) }),
      // This rebuild keeps only the fields it names, so the optional 受阻 rows
      // the host sends would otherwise never reach the canvas.
      ...(snapshot.blocked === undefined ? {} : { blocked: (snapshot.blocked as unknown[]).map(normalizeBlockedRow) }),
      decisions: snapshot.decisions as DevFlowClientSnapshot['decisions'], decisionRequests: snapshot.decisionRequests as DevFlowClientSnapshot['decisionRequests'],
    },
  }
}

/** Strictly parse a browser-supplied safe page query; unknown fields are dropped. */
export function parseAuditQuery(value: unknown): DevFlowClientAuditQuery {
  if (!isRecord(value)) throw new Error('invalid DevFlow audit query')
  const cursor = value.cursor === undefined ? undefined : requireBoundedString(value.cursor, 'cursor', 2_048)
  const filter = value.filter === undefined ? undefined : parseAuditFilter(value.filter)
  let range: DevFlowClientAuditQuery['range']
  if (value.range !== undefined) {
    if (!isRecord(value.range)) throw new Error('invalid DevFlow audit range')
    const from = value.range.from === undefined ? undefined : requireTime(value.range.from)
    const to = value.range.to === undefined ? undefined : requireTime(value.range.to)
    range = { ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) }
  }
  return { ...(cursor === undefined ? {} : { cursor }), ...(filter === undefined ? {} : { filter }), ...(range === undefined ? {} : { range }) }
}

export function parseDevFlowAuditResponse(value: unknown): DevFlowClientAuditPageResponse {
  if (!isRecord(value) || typeof value.kind !== 'string') throw new Error('invalid DevFlow audit response')
  if (value.kind === 'error') return { kind: 'error', error: parseAuditError(value.error) }
  if (value.kind !== 'page' || !isRecord(value.page)) throw new Error('invalid DevFlow audit response')
  const page = value.page
  if (page.version !== DEVFLOW_CLIENT_AUDIT_PAGE_VERSION || page.source !== 'devflow-journal'
    || (page.projectId !== null && !isBoundedId(page.projectId)) || !isRecord(page.range)
    || !validTime(page.range.from) || !validTime(page.range.to) || !Array.isArray(page.items)
    || page.items.length > DEVFLOW_CLIENT_AUDIT_PAGE_LIMIT || (page.nextCursor !== null && !isBoundedString(page.nextCursor, 2_048))
    || (page.capturedHeadSequence !== null && !isSequence(page.capturedHeadSequence))
    || !isNonNegativeInteger(page.omittedUnsafeCount) || typeof page.truncated !== 'boolean' || !page.items.every(isAuditItem)) throw new Error('invalid DevFlow audit page')
  const normalized: DevFlowClientAuditPage = {
    version: DEVFLOW_CLIENT_AUDIT_PAGE_VERSION, source: 'devflow-journal', projectId: page.projectId as string | null,
    range: { from: page.range.from as string, to: page.range.to as string }, items: (page.items as unknown[]).map(normalizeAuditItem),
    nextCursor: page.nextCursor as string | null, capturedHeadSequence: page.capturedHeadSequence as number | null,
    omittedUnsafeCount: page.omittedUnsafeCount as number, truncated: page.truncated,
  }
  if (new TextEncoder().encode(JSON.stringify(normalized)).byteLength > DEVFLOW_CLIENT_AUDIT_PAGE_BYTES) throw new Error('invalid DevFlow audit page')
  return { kind: 'page', page: normalized }
}

function parseAuditError(value: unknown): DevFlowClientAuditError {
  if (!isRecord(value)) throw new Error('invalid DevFlow audit error')
  if (value.code === 'audit-unavailable' && value.message === 'DevFlow audit is unavailable. Refresh to try again.') return { code: value.code, message: value.message }
  if (value.code === 'cursor-invalid' && value.message === 'DevFlow audit history changed. Refresh to try again.') return { code: value.code, message: value.message }
  throw new Error('invalid DevFlow audit error')
}

function parseAuditFilter(value: unknown): DevFlowClientAuditFilter {
  if (!isRecord(value) || typeof value.kind !== 'string') throw new Error('invalid DevFlow audit filter')
  if (value.kind === 'project') return { kind: 'project' }
  if (['phase', 'task', 'agent', 'execution', 'decision'].includes(value.kind) && isBoundedId(value.id)) {
    return { kind: value.kind as Exclude<DevFlowClientAuditFilter['kind'], 'project'>, id: value.id }
  }
  throw new Error('invalid DevFlow audit filter')
}

function normalizeSafeText(value: Record<string, unknown>): DevFlowClientSafeText {
  return { text: value.text as string, truncated: value.truncated as boolean, redacted: value.redacted as boolean }
}

/** Tolerantly normalize one session state; missing activation fields degrade to unbound. */
function normalizeSessionState(value: Record<string, unknown>): DevFlowClientSession {
  if (typeof value.id !== 'string' || (value.commanderMode !== 'chat' && value.commanderMode !== 'commander')) {
    throw new Error('invalid DevFlow session state')
  }
  const presetId = value.presetId === undefined || value.presetId === null ? null : value.presetId
  if (presetId !== null && !isBoundedString(presetId, 128)) throw new Error('invalid DevFlow session presetId')
  const rawActivation = value.activation === undefined || value.activation === null ? 'unbound' : value.activation
  if (rawActivation !== 'bound' && rawActivation !== 'unbound' && rawActivation !== 'error') {
    throw new Error('invalid DevFlow session activation')
  }
  let activationError: DevFlowClientSession['activationError'] = null
  if (value.activationError !== undefined && value.activationError !== null) {
    const error = value.activationError as Record<string, unknown>
    if (!isBoundedString(error.code, 128) || !isBoundedString(error.message, 240) || error.code === undefined) {
      throw new Error('invalid DevFlow activation error')
    }
    activationError = { code: error.code, message: error.message }
  }
  const verifiedAt = value.verifiedAt === undefined || value.verifiedAt === null ? null : value.verifiedAt
  if (verifiedAt !== null && !validTime(verifiedAt)) throw new Error('invalid DevFlow session verifiedAt')
  // The project identifier (第九步): absent in older host snapshots, which is a
  // legitimate "host does not name its project" rather than a broken frame.
  const workspacePath = value.workspacePath === undefined || value.workspacePath === null ? null : value.workspacePath
  if (workspacePath !== null && !isBoundedString(workspacePath, 512)) throw new Error('invalid DevFlow session workspacePath')
  const storeRoot = value.storeRoot === undefined || value.storeRoot === null ? null : value.storeRoot
  if (storeRoot !== null && !isBoundedString(storeRoot, 512)) throw new Error('invalid DevFlow session storeRoot')
  return {
    id: value.id,
    commanderMode: value.commanderMode,
    workspacePath,
    storeRoot,
    presetId,
    activation: rawActivation,
    activationError,
    verifiedAt,
    lastActivationFailure: normalizeActivationFailure(value.lastActivationFailure),
  }
}

/**
 * Read one recorded activation refusal off the wire.
 *
 * Absent is the ordinary case (no refusal recorded) and answers null. A present
 * but malformed record is dropped rather than thrown: this field accompanies
 * the session, and rejecting the whole snapshot would hide every other panel
 * fact because one optional diagnosis was unreadable.
 * @param value - the wire value for the record.
 * @returns the bounded record, or null.
 */
function normalizeActivationFailure(value: unknown): DevFlowClientActivationFailure | null {
  if (value === undefined || value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (!isBoundedString(record.code, 128) || !isBoundedString(record.reason, 240)
    || !isBoundedString(record.phase, 32) || !validTime(record.at)
    || typeof record.attempts !== 'number' || !Number.isSafeInteger(record.attempts) || record.attempts < 1) {
    return null
  }
  return { code: record.code, phase: record.phase, attempts: record.attempts, reason: record.reason, at: record.at }
}
function normalizeResultSummary(value: unknown): DevFlowClientResultSummary { const item = value as Record<string, unknown>; return { id: item.id as string, taskId: item.taskId as string, source: 'result', at: item.at as string, summary: normalizeSafeText(item.summary as Record<string, unknown>) } }
function normalizeReportSummary(value: unknown): DevFlowClientReportSummary { const item = value as Record<string, unknown>; return { id: item.id as string, executionId: item.executionId as string, ...(item.taskId === undefined ? {} : { taskId: item.taskId as string }), agentId: item.agentId as string, source: 'report', status: item.status as DevFlowClientReportSummary['status'], at: item.at as string, summary: normalizeSafeText(item.summary as Record<string, unknown>) } }
function normalizeAttemptSummary(value: unknown): DevFlowClientAttemptSummary { const item = value as Record<string, unknown>; return { id: item.id as string, executionId: item.executionId as string, source: 'attempt', status: item.status as DevFlowClientAttemptSummary['status'], isRetry: item.isRetry as boolean, at: item.at as string, completedAt: item.completedAt as string | null } }
function normalizeFailureSummary(value: unknown): DevFlowClientFailureSummary { const item = value as Record<string, unknown>; return { id: item.id as string, executionId: item.executionId as string, ...(item.taskId === undefined ? {} : { taskId: item.taskId as string }), agentId: item.agentId as string, source: item.source as DevFlowClientFailureSummary['source'], status: item.status as DevFlowClientFailureSummary['status'], at: item.at as string, summary: item.summary === null ? null : normalizeSafeText(item.summary as Record<string, unknown>) } }

function normalizeAuditItem(value: unknown): DevFlowClientAuditItem {
  const item = value as Record<string, unknown>
  const entity = item.entity as Record<string, unknown>
  const related = item.related as Record<string, unknown>
  return {
    id: item.id as string, sequence: item.sequence as number, category: item.category as DevFlowClientAuditItem['category'], action: item.action as DevFlowClientAuditItem['action'], at: item.at as string,
    entity: { type: entity.type as DevFlowClientAuditItem['entity']['type'], id: entity.id as string | null, display: entity.display === null ? null : normalizeSafeText(entity.display as Record<string, unknown>) },
    related: pickRelated(related), status: item.status as string | null, summary: item.summary === null ? null : normalizeSafeText(item.summary as Record<string, unknown>), incomplete: item.incomplete as boolean,
  }
}
function pickRelated(value: Record<string, unknown>): DevFlowClientAuditItem['related'] { const allowed = ['projectId', 'taskId', 'phaseId', 'agentId', 'assignmentId', 'executionId', 'attemptId', 'reportId', 'decisionId', 'requestId'] as const; return Object.fromEntries(allowed.flatMap(key => typeof value[key] === 'string' ? [[key, value[key]]] : [])) as DevFlowClientAuditItem['related'] }

function optionalSummaries(snapshot: Record<string, unknown>): boolean { return optionalArray(snapshot.results, isResultSummary) && optionalArray(snapshot.reports, isReportSummary) && optionalArray(snapshot.attempts, isAttemptSummary) && optionalArray(snapshot.failures, isFailureSummary) }
function optionalArray<T>(value: unknown, predicate: (item: unknown) => item is T): boolean { return value === undefined || (Array.isArray(value) && value.length <= 20 && value.every(predicate)) }
function isSafeText(value: unknown): value is DevFlowClientSafeText { return isRecord(value) && typeof value.text === 'string' && value.text.length <= 500 && typeof value.truncated === 'boolean' && typeof value.redacted === 'boolean' }
function isResultSummary(value: unknown): value is DevFlowClientResultSummary { return isRecord(value) && typeof value.id === 'string' && typeof value.taskId === 'string' && value.source === 'result' && typeof value.at === 'string' && isSafeText(value.summary) }
function isReportSummary(value: unknown): value is DevFlowClientReportSummary { return isRecord(value) && typeof value.id === 'string' && typeof value.executionId === 'string' && (value.taskId === undefined || typeof value.taskId === 'string') && typeof value.agentId === 'string' && value.source === 'report' && (value.status === 'success' || value.status === 'failed' || value.status === 'blocked') && typeof value.at === 'string' && isSafeText(value.summary) }
function isAttemptSummary(value: unknown): value is DevFlowClientAttemptSummary { return isRecord(value) && typeof value.id === 'string' && typeof value.executionId === 'string' && value.source === 'attempt' && (value.status === 'created' || value.status === 'running' || value.status === 'completed' || value.status === 'failed') && typeof value.isRetry === 'boolean' && typeof value.at === 'string' && (value.completedAt === null || typeof value.completedAt === 'string') }
function isFailureSummary(value: unknown): value is DevFlowClientFailureSummary { return isRecord(value) && typeof value.id === 'string' && typeof value.executionId === 'string' && (value.taskId === undefined || typeof value.taskId === 'string') && typeof value.agentId === 'string' && (value.source === 'execution' || value.source === 'report') && (value.status === 'failed' || value.status === 'blocked') && typeof value.at === 'string' && (value.summary === null || isSafeText(value.summary)) }
function isBlockedRow(value: unknown): value is DevFlowClientBlocked { return isRecord(value) && typeof value.id === 'string' && typeof value.taskId === 'string' && typeof value.agentId === 'string' && typeof value.agentName === 'string' && GAP_KINDS.includes(value.gapKind as string) && typeof value.missing === 'string' && typeof value.suggestedOwner === 'string' && isSafeText(value.reason) && typeof value.headline === 'string' && validTime(value.at) }
function normalizeBlockedRow(value: unknown): DevFlowClientBlocked {
  const item = value as Record<string, unknown>
  return {
    id: item.id as string, taskId: item.taskId as string, agentId: item.agentId as string, agentName: item.agentName as string,
    gapKind: item.gapKind as DevFlowClientBlocked['gapKind'], missing: item.missing as string, suggestedOwner: item.suggestedOwner as string,
    reason: normalizeSafeText(item.reason as Record<string, unknown>), headline: item.headline as string, at: item.at as string,
  }
}



const CATEGORIES = ['project', 'task', 'phase', 'agent', 'assignment', 'execution', 'attempt', 'report', 'decision', 'control', 'scope', 'bridge-review', 'runtime', 'commander-action']
const GAP_KINDS = ['tool', 'permission', 'dependency', 'unstated']
const ACTIONS = ['updated', 'created', 'removed', 'transitioned', 'assigned', 'unassigned', 'started', 'completed', 'failed', 'blocked', 'requested', 'answered', 'paused', 'resumed', 'imported', 'exported', 'boundary-hit', 'executed', 'closed']
const ENTITY_TYPES = ['project', 'task', 'phase', 'agent', 'assignment', 'execution', 'attempt', 'report', 'decision-request', 'decision', 'batch', 'runtime-session', 'review', 'action', 'unknown']
function isAuditItem(value: unknown): value is DevFlowClientAuditItem { if (!isRecord(value) || !isBoundedId(value.id) || !isSequence(value.sequence) || !CATEGORIES.includes(value.category as string) || !ACTIONS.includes(value.action as string) || !validTime(value.at) || !isRecord(value.entity) || !ENTITY_TYPES.includes(value.entity.type as string) || (value.entity.id !== null && !isBoundedId(value.entity.id)) || (value.entity.display !== null && !isSafeText(value.entity.display)) || !isRecord(value.related) || (value.status !== null && (!isBoundedString(value.status, 64))) || (value.summary !== null && !isSafeText(value.summary)) || typeof value.incomplete !== 'boolean') return false; return Object.values(value.related).every(isBoundedId) }
function requireTime(value: unknown): string { if (!validTime(value)) throw new Error('invalid DevFlow audit time'); return value }
function requireString(value: unknown, label: string): string { if (typeof value !== 'string' || value === '') throw new Error(`invalid ${label}`); return value }
function requireBoundedString(value: unknown, label: string, max: number): string { if (!isBoundedString(value, max)) throw new Error(`invalid ${label}`); return value }
function isBoundedString(value: unknown, max: number): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1F]/.test(value) }
function isBoundedId(value: unknown): value is string { return isBoundedString(value, 128) }
function validTime(value: unknown): value is string { return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value)) }
function isSequence(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }
function isNonNegativeInteger(value: unknown): value is number { return isSequence(value) }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
