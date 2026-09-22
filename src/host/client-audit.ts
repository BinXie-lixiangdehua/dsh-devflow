/** Safe, bounded projection of the plugin-owned DevFlow journal for the Canvas. */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  DEVFLOW_CLIENT_AUDIT_PAGE_BYTES,
  DEVFLOW_CLIENT_AUDIT_PAGE_LIMIT,
  DEVFLOW_CLIENT_AUDIT_PAGE_VERSION,
  DEVFLOW_CLIENT_AUDIT_TEXT_LIMIT,
  type DevFlowClientAuditAction,
  type DevFlowClientAuditCategory,
  type DevFlowClientAuditError,
  type DevFlowClientAuditFilter,
  type DevFlowClientAuditItem,
  type DevFlowClientAuditPage,
  type DevFlowClientAuditPageResponse,
  type DevFlowClientAuditQuery,
  type DevFlowClientAuditEntityType,
  type DevFlowClientSafeText,
} from '../contract.ts'
import type { DevFlowJsonValue } from './json.ts'
import type { DevFlowJournalEntry, DevFlowStore } from './storage.ts'

export const DEVFLOW_AUDIT_CANDIDATE_SCAN_LIMIT = 200
export const DEVFLOW_AUDIT_DEFAULT_RANGE_MS = 30 * 24 * 60 * 60 * 1_000
export const DEVFLOW_AUDIT_MAX_RANGE_MS = 90 * 24 * 60 * 60 * 1_000

const AUDIT_UNAVAILABLE: DevFlowClientAuditError = {
  code: 'audit-unavailable', message: 'DevFlow audit is unavailable. Refresh to try again.',
}
const CURSOR_INVALID: DevFlowClientAuditError = {
  code: 'cursor-invalid', message: 'DevFlow audit history changed. Refresh to try again.',
}
const REDACTED_TEXT = 'Sensitive content is hidden.'
const LEGACY_TEXT = 'Unknown / legacy record'
const SENSITIVE_TEXT = /(?:\b(?:prompt|system[\s_-]*prompt|credential|token|cookie|authorization|api[\s_-]*key|secret|password|raw\s*(?:tool\s*)?(?:input|output)|tool\s*(?:input|output)|stack\s*trace|outputReference|modifiedFiles)\b|(?:[A-Za-z]:\\|\\\\|\/Users\/|\/home\/|\/tmp\/|\/var\/tmp\/|\/private\/var\/)|(?:Bearer\s+\S+))/i
const MAX_CURSOR_LENGTH = 2_048
const MAX_ID_LENGTH = 128

type Related = DevFlowClientAuditItem['related']
type CursorPayload = {
  readonly v: 1
  readonly projectId: string | null
  readonly filter: DevFlowClientAuditFilter
  readonly from: string
  readonly to: string
  readonly head: number
  readonly next: number
}

type NormalizedQuery = {
  readonly filter: DevFlowClientAuditFilter
  readonly from: string
  readonly to: string
}

/** A private, per-service cursor signer prevents clients changing page meaning. */
export class DevFlowAuditPager {
  private readonly secret = randomBytes(32)
  private readonly storeFor: () => DevFlowStore

  /**
   * @param source - the session's store, or a supplier resolving it per call.
   *   The supplier form is what keeps the audit page inside the CALLING
   *   session's project: one audit panel must not page through another
   *   project's journal.
   */
  constructor(source: DevFlowStore | (() => DevFlowStore)) {
    this.storeFor = typeof source === 'function' ? source : () => source
  }

  async page(query: DevFlowClientAuditQuery = {}): Promise<DevFlowClientAuditPageResponse> {
    try {
      const store = this.storeFor()
      const project = await store.loadProject()
      const cursor = query.cursor === undefined ? undefined : this.decodeCursor(query.cursor)
      if (query.cursor !== undefined && cursor === undefined) return { kind: 'error', error: CURSOR_INVALID }
      const normalized = normalizeQuery(query, cursor)
      if (normalized === undefined) return { kind: 'error', error: CURSOR_INVALID }
      if (cursor !== undefined && cursor.projectId !== (project?.id ?? null)) return { kind: 'error', error: CURSOR_INVALID }

      const scan = await store.readCommittedJournalSequencePage(
        cursor?.head,
        cursor?.next,
        DEVFLOW_AUDIT_CANDIDATE_SCAN_LIMIT,
      )
      const page = this.buildPage(project?.id ?? null, normalized, scan.entries, scan.capturedHeadSequence, scan.nextExclusiveSequence)
      return { kind: 'page', page }
    } catch {
      return { kind: 'error', error: AUDIT_UNAVAILABLE }
    }
  }

  private buildPage(
    projectId: string | null,
    query: NormalizedQuery,
    entries: readonly DevFlowJournalEntry[],
    capturedHeadSequence: number,
    scanNext: number | null,
  ): DevFlowClientAuditPage {
    const items: DevFlowClientAuditItem[] = []
    let omittedUnsafeCount = 0
    let truncated = false
    let nextSequence = scanNext
    let stoppedEarly = false
    for (const entry of entries) {
      const item = toSafeAuditItem(entry)
      if (item === undefined) {
        omittedUnsafeCount++
        continue
      }
      if (!inRange(item.at, query) || !matchesFilter(item, query.filter)) continue
      if (items.length === DEVFLOW_CLIENT_AUDIT_PAGE_LIMIT) {
        nextSequence = entry.sequence + 1
        stoppedEarly = true
        break
      }
      const candidate = [...items, item]
      // Check whole items against the wire size budget. The final cursor is at
      // most a few KB and the placeholder gives a conservative fixed allowance.
      if (serializedBytes({ items: candidate, nextCursor: 'x'.repeat(MAX_CURSOR_LENGTH) }) > DEVFLOW_CLIENT_AUDIT_PAGE_BYTES) {
        truncated = true
        nextSequence = entry.sequence + 1
        stoppedEarly = true
        break
      }
      items.push(item)
      nextSequence = entry.sequence
    }
    const hasNext = stoppedEarly || scanNext !== null
    const cursor = hasNext && nextSequence !== null && nextSequence > 0
      ? this.encodeCursor({
        v: 1,
        projectId,
        filter: query.filter,
        from: query.from,
        to: query.to,
        head: capturedHeadSequence,
        next: nextSequence!,
      })
      : null
    const page: DevFlowClientAuditPage = {
      version: DEVFLOW_CLIENT_AUDIT_PAGE_VERSION,
      source: 'devflow-journal',
      projectId,
      range: { from: query.from, to: query.to },
      items,
      nextCursor: cursor,
      capturedHeadSequence,
      omittedUnsafeCount,
      truncated,
    }
    // An invariant guard: a future DTO addition cannot silently breach the contract.
    if (serializedBytes(page) > DEVFLOW_CLIENT_AUDIT_PAGE_BYTES) throw new Error('audit page exceeds response budget')
    return page
  }

  private encodeCursor(payload: CursorPayload): string {
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const signature = createHmac('sha256', this.secret).update(encoded).digest('base64url')
    return `${encoded}.${signature}`
  }

  private decodeCursor(value: string): CursorPayload | undefined {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_CURSOR_LENGTH) return undefined
    const [encoded, signature, extra] = value.split('.')
    if (encoded === undefined || signature === undefined || extra !== undefined) return undefined
    const expected = createHmac('sha256', this.secret).update(encoded).digest('base64url')
    const received = Buffer.from(signature)
    const expectedBytes = Buffer.from(expected)
    if (received.length !== expectedBytes.length || !timingSafeEqual(received, expectedBytes)) return undefined
    try {
      const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown
      return isCursorPayload(value) ? value : undefined
    } catch {
      return undefined
    }
  }
}

/** Converts only explicit, reviewed journal payload fields into the browser DTO. */
export function toSafeAuditItem(entry: DevFlowJournalEntry): DevFlowClientAuditItem | undefined {
  if (!validId(entry.id) || !Number.isSafeInteger(entry.sequence) || entry.sequence < 0 || !validTime(entry.at)) return undefined
  const data = record(entry.data)
  if (data === undefined) return undefined
  const known = (category: DevFlowClientAuditCategory, action: DevFlowClientAuditAction, entityType: DevFlowClientAuditEntityType, entityId: string | null, related: Related, status: string | null = null, summary: string | null = null, incomplete = false): DevFlowClientAuditItem => ({
    id: entry.id,
    sequence: entry.sequence,
    category,
    action,
    at: entry.at,
    entity: {
      type: entityType,
      id: entityId,
      display: entityId === null ? safeText(LEGACY_TEXT) : null,
    },
    related,
    status,
    summary: summary === null ? null : safeText(summary),
    incomplete,
  })
  const id = (key: string): string | undefined => stringField(data, key)
  const status = (key: string, allowed: readonly string[]): string | null => enumField(data, key, allowed)

  switch (entry.type) {
    case 'devflow/project/update': {
      const project = record(data.project)
      const projectId = project === undefined ? undefined : stringField(project, 'id')
      return known('project', 'updated', projectId === undefined ? 'unknown' : 'project', projectId ?? null, projectId === undefined ? {} : { projectId }, null, null, projectId === undefined)
    }
    case 'devflow/task/transition': {
      const taskId = id('taskId')
      const to = status('to', ['created', 'planned', 'executing', 'reviewing', 'completed', 'failed', 'cancelled'])
      return known('task', 'transitioned', taskId === undefined ? 'unknown' : 'task', taskId ?? null, taskId === undefined ? {} : { taskId }, to, stringField(data, 'title') ?? null, taskId === undefined)
    }
    case 'devflow/phase/create': {
      const phase = record(data.phase)
      const phaseId = phase === undefined ? undefined : stringField(phase, 'id')
      return known('phase', 'created', phaseId === undefined ? 'unknown' : 'phase', phaseId ?? null, phaseId === undefined ? {} : { phaseId }, phase === undefined ? null : enumField(phase, 'status', ['planned', 'in_progress', 'completed']), null, phaseId === undefined)
    }
    case 'devflow/phase/update': {
      const phaseId = id('phaseId')
      return known('phase', 'updated', phaseId === undefined ? 'unknown' : 'phase', phaseId ?? null, phaseId === undefined ? {} : { phaseId }, status('status', ['planned', 'in_progress', 'completed']), null, phaseId === undefined)
    }
    case 'devflow/agent/register': {
      const agent = record(data.agent)
      const agentId = agent === undefined ? undefined : stringField(agent, 'agentId')
      return known('agent', 'created', agentId === undefined ? 'unknown' : 'agent', agentId ?? null, agentId === undefined ? {} : { agentId }, agent === undefined ? null : enumField(agent, 'status', ['active', 'created', 'running', 'terminated']), null, agentId === undefined)
    }
    case 'devflow/agent/remove': {
      const agentId = id('agentId')
      return known('agent', 'removed', agentId === undefined ? 'unknown' : 'agent', agentId ?? null, agentId === undefined ? {} : { agentId }, null, null, agentId === undefined)
    }
    case 'devflow/agent/transition': {
      const agentId = id('agentId')
      return known('agent', 'transitioned', agentId === undefined ? 'unknown' : 'agent', agentId ?? null, agentId === undefined ? {} : { agentId }, status('to', ['created', 'running', 'terminated']), null, agentId === undefined)
    }
    case 'devflow/orchestration/assign': {
      const assignment = record(data.assignment)
      return assignmentItem(known, assignment, 'assigned')
    }
    case 'devflow/orchestration/unassign': {
      const assignmentId = id('assignmentId')
      return known('assignment', 'unassigned', assignmentId === undefined ? 'unknown' : 'assignment', assignmentId ?? null, assignmentId === undefined ? {} : { assignmentId }, null, null, assignmentId === undefined)
    }
    case 'devflow/orchestration/update': {
      const assignmentId = id('assignmentId')
      return known('assignment', 'updated', assignmentId === undefined ? 'unknown' : 'assignment', assignmentId ?? null, assignmentId === undefined ? {} : { assignmentId }, status('status', ['assigned', 'in_progress', 'completed', 'closed']), null, assignmentId === undefined)
    }
    case 'devflow/orchestration/close': {
      const assignmentId = id('assignmentId')
      return known('assignment', 'closed', assignmentId === undefined ? 'unknown' : 'assignment', assignmentId ?? null, assignmentId === undefined ? {} : { assignmentId }, 'closed', null, assignmentId === undefined)
    }
    case 'devflow/execution/start': {
      const execution = record(data.execution)
      return executionItem(known, execution, 'started')
    }
    case 'devflow/execution/update':
    case 'devflow/execution/complete':
    case 'devflow/execution/fail':
    case 'devflow/execution/close': {
      const executionId = id('executionId')
      const action = entry.type.endsWith('/complete') ? 'completed' : entry.type.endsWith('/fail') ? 'failed' : entry.type.endsWith('/close') ? 'closed' : 'updated'
      return known('execution', action, executionId === undefined ? 'unknown' : 'execution', executionId ?? null, executionId === undefined ? {} : { executionId }, status('status', ['pending', 'running', 'completed', 'failed', 'closed']), null, executionId === undefined)
    }
    case 'devflow/execution/attempt/create': {
      const attempt = record(data.attempt)
      return attemptItem(known, attempt, 'created')
    }
    case 'devflow/execution/attempt/start':
    case 'devflow/execution/attempt/complete':
    case 'devflow/execution/attempt/fail': {
      const attemptId = id('attemptId')
      const action = entry.type.endsWith('/start') ? 'started' : entry.type.endsWith('/complete') ? 'completed' : 'failed'
      return known('attempt', action, attemptId === undefined ? 'unknown' : 'attempt', attemptId ?? null, attemptId === undefined ? {} : { attemptId }, null, null, attemptId === undefined)
    }
    case 'devflow/agent/report/create': {
      const report = record(data.report)
      return reportItem(known, report, 'created')
    }
    case 'devflow/agent/report/update': {
      const reportId = id('reportId')
      return known('report', 'updated', reportId === undefined ? 'unknown' : 'report', reportId ?? null, reportId === undefined ? {} : { reportId }, null, null, reportId === undefined)
    }
    case 'devflow/decision/request': {
      const request = record(data.request)
      const requestId = request === undefined ? undefined : stringField(request, 'requestId')
      const taskId = request === undefined ? undefined : nullableStringField(request, 'taskId')
      return known('decision', 'requested', requestId === undefined ? 'unknown' : 'decision-request', requestId ?? null, { ...(requestId === undefined ? {} : { requestId }), ...(taskId === undefined || taskId === null ? {} : { taskId }) }, request === undefined ? null : enumField(request, 'status', ['pending', 'answered', 'dismissed']), request === undefined ? null : stringField(request, 'question') ?? null, requestId === undefined)
    }
    case 'devflow/decision/answer': {
      const requestId = id('requestId')
      return known('decision', 'answered', requestId === undefined ? 'unknown' : 'decision-request', requestId ?? null, requestId === undefined ? {} : { requestId }, 'answered', null, requestId === undefined)
    }
    case 'devflow/commander/decision/create': {
      const decision = record(data.decision)
      const decisionId = decision === undefined ? undefined : stringField(decision, 'decisionId')
      return known('decision', 'created', decisionId === undefined ? 'unknown' : 'decision', decisionId ?? null, decisionId === undefined ? {} : { decisionId }, decision === undefined ? null : enumField(decision, 'decisionType', ['continue', 'retry', 'pause', 'request_user']), decision === undefined ? null : stringField(decision, 'summary') ?? null, decisionId === undefined)
    }
    case 'devflow/commander/decision/update': {
      const decisionId = id('decisionId')
      return known('decision', 'updated', decisionId === undefined ? 'unknown' : 'decision', decisionId ?? null, decisionId === undefined ? {} : { decisionId }, null, null, decisionId === undefined)
    }
    case 'devflow/control/pause': return known('control', 'paused', 'project', null, {}, 'paused')
    case 'devflow/control/resume': return known('control', 'resumed', 'project', null, {}, 'live')
    case 'devflow/scope/boundary-hit': {
      const hit = record(data.hit)
      const taskId = hit === undefined ? undefined : stringField(hit, 'taskId')
      return known('scope', 'boundary-hit', taskId === undefined ? 'unknown' : 'task', taskId ?? null, taskId === undefined ? {} : { taskId }, hit === undefined ? null : enumField(hit, 'boundary', ['modified_files', 'tool_steps', 'completion_criteria']), null, taskId === undefined)
    }
    case 'devflow/bridge/export': {
      const taskId = id('taskId')
      return known('bridge-review', 'exported', taskId === undefined ? 'unknown' : 'task', taskId ?? null, taskId === undefined ? {} : { taskId }, null, null, taskId === undefined)
    }
    case 'devflow/bridge/import': {
      const taskId = id('taskId')
      const resultId = id('resultId')
      return known('bridge-review', 'imported', taskId === undefined ? 'unknown' : 'task', taskId ?? null, { ...(taskId === undefined ? {} : { taskId }), ...(resultId === undefined ? {} : { reportId: resultId }) }, status('verdict', ['accepted', 'changes-requested', 'rejected']), null, taskId === undefined)
    }
    case 'devflow/commander/review/create': {
      const review = record(data.review)
      const reviewId = review === undefined ? undefined : stringField(review, 'reviewId')
      const executionId = review === undefined ? undefined : stringField(review, 'executionId')
      return known('bridge-review', 'created', reviewId === undefined ? 'unknown' : 'review', reviewId ?? null, { ...(reviewId === undefined ? {} : { reportId: reviewId }), ...(executionId === undefined ? {} : { executionId }) }, review === undefined ? null : enumField(review, 'status', ['pending', 'reviewed']), review === undefined ? null : stringField(review, 'summary') ?? null, reviewId === undefined)
    }
    case 'devflow/commander/review/complete': {
      const reviewId = id('reviewId')
      return known('bridge-review', 'completed', reviewId === undefined ? 'unknown' : 'review', reviewId ?? null, reviewId === undefined ? {} : { reportId: reviewId }, 'reviewed', null, reviewId === undefined)
    }
    case 'devflow/runtime/session/create': {
      const session = record(data.session)
      return runtimeItem(known, session, 'created')
    }
    case 'devflow/runtime/session/start':
    case 'devflow/runtime/session/complete':
    case 'devflow/runtime/session/fail': {
      const sessionId = id('sessionId')
      const action = entry.type.endsWith('/start') ? 'started' : entry.type.endsWith('/complete') ? 'completed' : 'failed'
      return known('runtime', action, sessionId === undefined ? 'unknown' : 'runtime-session', sessionId ?? null, sessionId === undefined ? {} : { executionId: sessionId }, null, null, sessionId === undefined)
    }
    case 'devflow/commander/action/create': {
      const action = record(data.action)
      return actionItem(known, action, 'created')
    }
    case 'devflow/commander/action/execute':
    case 'devflow/commander/action/complete': {
      const actionId = id('actionId')
      return known('commander-action', entry.type.endsWith('/execute') ? 'executed' : 'completed', actionId === undefined ? 'unknown' : 'action', actionId ?? null, actionId === undefined ? {} : { decisionId: actionId }, null, null, actionId === undefined)
    }
    case 'devflow/commander/action-execution/create': {
      const execution = record(data.execution)
      const executionId = execution === undefined ? undefined : stringField(execution, 'executionId')
      const actionId = execution === undefined ? undefined : stringField(execution, 'actionId')
      return known('commander-action', 'executed', executionId === undefined ? 'unknown' : 'action', executionId ?? null, { ...(executionId === undefined ? {} : { executionId }), ...(actionId === undefined ? {} : { decisionId: actionId }) }, execution === undefined ? null : enumField(execution, 'status', ['running', 'completed', 'failed']), null, executionId === undefined)
    }
    case 'devflow/commander/action-execution/complete':
    case 'devflow/commander/action-execution/fail': {
      const executionId = id('executionId')
      return known('commander-action', entry.type.endsWith('/complete') ? 'completed' : 'failed', executionId === undefined ? 'unknown' : 'action', executionId ?? null, executionId === undefined ? {} : { executionId }, null, null, executionId === undefined)
    }
    default: return undefined
  }
}

function assignmentItem(known: (category: DevFlowClientAuditCategory, action: DevFlowClientAuditAction, entityType: DevFlowClientAuditEntityType, entityId: string | null, related: Related, status?: string | null, summary?: string | null, incomplete?: boolean) => DevFlowClientAuditItem, assignment: Record<string, DevFlowJsonValue> | undefined, action: DevFlowClientAuditAction): DevFlowClientAuditItem {
  const assignmentId = assignment === undefined ? undefined : stringField(assignment, 'assignmentId')
  const taskId = assignment === undefined ? undefined : stringField(assignment, 'taskId')
  const phaseId = assignment === undefined ? undefined : stringField(assignment, 'phaseId')
  const agentId = assignment === undefined ? undefined : stringField(assignment, 'agentId')
  return known('assignment', action, assignmentId === undefined ? 'unknown' : 'assignment', assignmentId ?? null, { ...(assignmentId === undefined ? {} : { assignmentId }), ...(taskId === undefined ? {} : { taskId }), ...(phaseId === undefined ? {} : { phaseId }), ...(agentId === undefined ? {} : { agentId }) }, assignment === undefined ? null : enumField(assignment, 'status', ['assigned', 'in_progress', 'completed', 'closed']), null, assignmentId === undefined)
}

function executionItem(known: (category: DevFlowClientAuditCategory, action: DevFlowClientAuditAction, entityType: DevFlowClientAuditEntityType, entityId: string | null, related: Related, status?: string | null, summary?: string | null, incomplete?: boolean) => DevFlowClientAuditItem, execution: Record<string, DevFlowJsonValue> | undefined, action: DevFlowClientAuditAction): DevFlowClientAuditItem {
  const executionId = execution === undefined ? undefined : stringField(execution, 'executionId')
  const taskId = execution === undefined ? undefined : stringField(execution, 'taskId')
  const agentId = execution === undefined ? undefined : stringField(execution, 'agentId')
  const assignmentId = execution === undefined ? undefined : stringField(execution, 'assignmentId')
  return known('execution', action, executionId === undefined ? 'unknown' : 'execution', executionId ?? null, { ...(executionId === undefined ? {} : { executionId }), ...(taskId === undefined ? {} : { taskId }), ...(agentId === undefined ? {} : { agentId }), ...(assignmentId === undefined ? {} : { assignmentId }) }, execution === undefined ? null : enumField(execution, 'status', ['pending', 'running', 'completed', 'failed', 'closed']), null, executionId === undefined)
}

function attemptItem(known: (category: DevFlowClientAuditCategory, action: DevFlowClientAuditAction, entityType: DevFlowClientAuditEntityType, entityId: string | null, related: Related, status?: string | null, summary?: string | null, incomplete?: boolean) => DevFlowClientAuditItem, attempt: Record<string, DevFlowJsonValue> | undefined, action: DevFlowClientAuditAction): DevFlowClientAuditItem {
  const attemptId = attempt === undefined ? undefined : stringField(attempt, 'attemptId')
  const executionId = attempt === undefined ? undefined : stringField(attempt, 'executionId')
  return known('attempt', action, attemptId === undefined ? 'unknown' : 'attempt', attemptId ?? null, { ...(attemptId === undefined ? {} : { attemptId }), ...(executionId === undefined ? {} : { executionId }) }, attempt === undefined ? null : enumField(attempt, 'status', ['created', 'running', 'completed', 'failed']), null, attemptId === undefined)
}

function reportItem(known: (category: DevFlowClientAuditCategory, action: DevFlowClientAuditAction, entityType: DevFlowClientAuditEntityType, entityId: string | null, related: Related, status?: string | null, summary?: string | null, incomplete?: boolean) => DevFlowClientAuditItem, report: Record<string, DevFlowJsonValue> | undefined, action: DevFlowClientAuditAction): DevFlowClientAuditItem {
  const reportId = report === undefined ? undefined : stringField(report, 'reportId')
  const executionId = report === undefined ? undefined : stringField(report, 'executionId')
  const agentId = report === undefined ? undefined : stringField(report, 'agentId')
  return known('report', action, reportId === undefined ? 'unknown' : 'report', reportId ?? null, { ...(reportId === undefined ? {} : { reportId }), ...(executionId === undefined ? {} : { executionId }), ...(agentId === undefined ? {} : { agentId }) }, report === undefined ? null : enumField(report, 'status', ['success', 'failed', 'blocked']), report === undefined ? null : stringField(report, 'summary') ?? null, reportId === undefined)
}

function runtimeItem(known: (category: DevFlowClientAuditCategory, action: DevFlowClientAuditAction, entityType: DevFlowClientAuditEntityType, entityId: string | null, related: Related, status?: string | null, summary?: string | null, incomplete?: boolean) => DevFlowClientAuditItem, session: Record<string, DevFlowJsonValue> | undefined, action: DevFlowClientAuditAction): DevFlowClientAuditItem {
  const sessionId = session === undefined ? undefined : stringField(session, 'sessionId')
  const executionId = session === undefined ? undefined : stringField(session, 'executionId')
  const agentId = session === undefined ? undefined : stringField(session, 'agentId')
  return known('runtime', action, sessionId === undefined ? 'unknown' : 'runtime-session', sessionId ?? null, { ...(executionId === undefined ? {} : { executionId }), ...(agentId === undefined ? {} : { agentId }) }, session === undefined ? null : enumField(session, 'status', ['created', 'running', 'completed', 'failed']), null, sessionId === undefined)
}

function actionItem(known: (category: DevFlowClientAuditCategory, action: DevFlowClientAuditAction, entityType: DevFlowClientAuditEntityType, entityId: string | null, related: Related, status?: string | null, summary?: string | null, incomplete?: boolean) => DevFlowClientAuditItem, actionValue: Record<string, DevFlowJsonValue> | undefined, action: DevFlowClientAuditAction): DevFlowClientAuditItem {
  const actionId = actionValue === undefined ? undefined : stringField(actionValue, 'actionId')
  const decisionId = actionValue === undefined ? undefined : stringField(actionValue, 'decisionId')
  return known('commander-action', action, actionId === undefined ? 'unknown' : 'action', actionId ?? null, { ...(decisionId === undefined ? {} : { decisionId }) }, actionValue === undefined ? null : enumField(actionValue, 'status', ['created', 'executing', 'completed']), null, actionId === undefined)
}

function normalizeQuery(query: DevFlowClientAuditQuery, cursor: CursorPayload | undefined): NormalizedQuery | undefined {
  const filter = query.filter ?? cursor?.filter ?? { kind: 'project' as const }
  if (!validFilter(filter) || (cursor !== undefined && !sameFilter(filter, cursor.filter))) return undefined
  const now = new Date()
  const fromValue = query.range?.from ?? cursor?.from ?? new Date(now.getTime() - DEVFLOW_AUDIT_DEFAULT_RANGE_MS).toISOString()
  const toValue = query.range?.to ?? cursor?.to ?? now.toISOString()
  if (!validTime(fromValue) || !validTime(toValue) || (cursor !== undefined && (fromValue !== cursor.from || toValue !== cursor.to))) return undefined
  const from = Date.parse(fromValue)
  const to = Date.parse(toValue)
  if (from > to || to - from > DEVFLOW_AUDIT_MAX_RANGE_MS) return undefined
  return { filter, from: new Date(from).toISOString(), to: new Date(to).toISOString() }
}

function matchesFilter(item: DevFlowClientAuditItem, filter: DevFlowClientAuditFilter): boolean {
  if (filter.kind === 'project') return true
  const id = filter.id
  if (filter.kind === 'phase') return item.entity.type === 'phase' && item.entity.id === id || item.related.phaseId === id
  if (filter.kind === 'task') return item.entity.type === 'task' && item.entity.id === id || item.related.taskId === id
  if (filter.kind === 'agent') return item.entity.type === 'agent' && item.entity.id === id || item.related.agentId === id
  if (filter.kind === 'execution') return item.entity.type === 'execution' && item.entity.id === id || item.related.executionId === id
  return item.entity.type === 'decision' && item.entity.id === id || item.related.decisionId === id || item.related.requestId === id
}

function inRange(at: string, query: NormalizedQuery): boolean {
  const time = Date.parse(at)
  return Number.isFinite(time) && time >= Date.parse(query.from) && time <= Date.parse(query.to)
}

function safeText(value: string): DevFlowClientSafeText {
  if (SENSITIVE_TEXT.test(value)) return { text: REDACTED_TEXT, truncated: false, redacted: true }
  if (value.length <= DEVFLOW_CLIENT_AUDIT_TEXT_LIMIT) return { text: value, truncated: false, redacted: false }
  return { text: value.slice(0, DEVFLOW_CLIENT_AUDIT_TEXT_LIMIT), truncated: true, redacted: false }
}

function record(value: unknown): Record<string, DevFlowJsonValue> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, DevFlowJsonValue> : undefined
}

function stringField(value: Record<string, DevFlowJsonValue>, key: string): string | undefined {
  const candidate = value[key]
  return typeof candidate === 'string' && validId(candidate) ? candidate : undefined
}

function nullableStringField(value: Record<string, DevFlowJsonValue>, key: string): string | null | undefined {
  const candidate = value[key]
  if (candidate === null) return null
  return typeof candidate === 'string' && validId(candidate) ? candidate : undefined
}

function enumField(value: Record<string, DevFlowJsonValue>, key: string, allowed: readonly string[]): string | null {
  const candidate = value[key]
  return typeof candidate === 'string' && allowed.includes(candidate) ? candidate : null
}

function validId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_ID_LENGTH && !/[\x00-\x1F]/.test(value)
}

function validTime(value: string): boolean {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value))
}

function validFilter(value: DevFlowClientAuditFilter): boolean {
  return value.kind === 'project' || validId(value.id)
}

function sameFilter(left: DevFlowClientAuditFilter, right: DevFlowClientAuditFilter): boolean {
  return left.kind === right.kind && ('id' in left ? left.id === ('id' in right ? right.id : undefined) : !('id' in right))
}

function isCursorPayload(value: unknown): value is CursorPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return candidate.v === 1 && (candidate.projectId === null || typeof candidate.projectId === 'string')
    && isFilter(candidate.filter) && validTime(candidate.from as string) && validTime(candidate.to as string)
    && validSequence(candidate.head) && validSequence(candidate.next)
}

function isFilter(value: unknown): value is DevFlowClientAuditFilter {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return item.kind === 'project' || (typeof item.kind === 'string' && ['phase', 'task', 'agent', 'execution', 'decision'].includes(item.kind) && typeof item.id === 'string' && validId(item.id))
}

function validSequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}
