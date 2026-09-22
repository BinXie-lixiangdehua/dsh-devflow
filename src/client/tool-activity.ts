import type {
  ChatConversationViewNode,
  ChatNode,
  ChatSnapshot,
} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  RunningToolCall,
  ToolResultNode,
} from '@deepseek-ai/dsh-client-ui-conversation/client'

export type OfficialToolActivityStatus = 'running' | 'succeeded' | 'failed' | 'result-without-call'

export interface SafeOfficialToolActivity {
  readonly id: string
  readonly source: 'harness-official-tool'
  readonly sessionId: string
  readonly callId: string
  readonly toolName: string
  readonly status: OfficialToolActivityStatus
  readonly startedAt: string | null
  readonly endedAt: string | null
  readonly durationMs: number | null
  readonly startSeq: number | null
  readonly resultSeq: number | null
  readonly resultSummary: 'running' | 'completed' | 'failed' | 'result received without visible call'
  readonly devflowRelation: { readonly kind: 'unknown' }
}

export interface CurrentSessionToolsState {
  readonly phase: 'loading' | 'ready' | 'unavailable'
  readonly source: 'harness-official-tool'
  readonly window: 'current-loaded-window'
  readonly hasMore: boolean
  readonly staleSafeItems: boolean
  readonly incompleteCount: number
  readonly items: readonly SafeOfficialToolActivity[]
}

interface SafeItemRead {
  readonly items: SafeOfficialToolActivity[]
  readonly storeUnavailable: boolean
  readonly incompleteCount: number
}

interface SafeTime {
  readonly epochMs: number
  readonly iso: string
}

const MAX_ITEMS = 20
const MAX_SAFE_STATE_BYTES = 32 * 1024
const MAX_ID_LENGTH = 128
const MAX_TOOL_NAME_LENGTH = 128
const CONTROL_CHARACTER = /[\p{Cc}\p{Cf}]/u
const SOURCE = 'harness-official-tool' as const
const WINDOW = 'current-loaded-window' as const
const UNKNOWN_RELATION = { kind: 'unknown' } as const

/**
 * The two framework targets the official tool window reads.
 *
 * Harness 0.1.5 splits what one client-runtime snapshot used to bundle: session
 * lifecycle state comes from the Session Controller adapter (`useSession`),
 * loaded Chat nodes from the Chat target (`useChat`). Both are selected
 * separately by the view and joined here.
 */
export interface CurrentSessionSources {
  readonly session: SessionSnapshot
  readonly chat: ChatSnapshot
}

export function mapCurrentSessionTools(expectedSessionId: string, sources: CurrentSessionSources): CurrentSessionToolsState {
  const { session, chat } = sources
  if (!isSafeIdentifier(expectedSessionId)) return unavailableState()

  try {
    if (session.sessionId !== expectedSessionId || !isSafeIdentifier(String(session.sessionId))) return unavailableState()
    if (session.subagent !== null) return unavailableState()

    const read = readSafeItems(expectedSessionId, session, chat)
    if (read === null) return unavailableState()
    const { items, incompleteCount } = read
    const hasMore = session.hasMore === true

    if (read.storeUnavailable) return state('unavailable', items, hasMore, items.length > 0, incompleteCount)
    if (session.openState === 'open') return state('ready', items, hasMore, false, incompleteCount)
    if (session.openState === 'cold' || session.openState === 'loading') {
      return state('loading', items, hasMore, items.length > 0, incompleteCount)
    }
    if (session.openState === 'error') return state('unavailable', items, hasMore, items.length > 0, incompleteCount)
    return unavailableState()
  } catch {
    return unavailableState()
  }
}

export function equalCurrentSessionToolsState(left: CurrentSessionToolsState, right: CurrentSessionToolsState): boolean {
  if (left === right) return true
  if (left.phase !== right.phase || left.hasMore !== right.hasMore || left.staleSafeItems !== right.staleSafeItems || left.incompleteCount !== right.incompleteCount || left.items.length !== right.items.length) return false
  return left.items.every((item, index) => equalActivity(item, right.items[index]))
}

function readSafeItems(sessionId: string, session: SessionSnapshot, chat: ChatSnapshot): SafeItemRead | null {
  const nodes = chat.nodes
  if (nodes === null || typeof nodes !== 'object' || typeof nodes.get !== 'function') return null
  const order: unknown = chat.order
  if (!Array.isArray(order) || !order.every(key => typeof key === 'string')) return null

  const items: SafeOfficialToolActivity[] = []
  let storeUnavailable = false
  let incompleteCount = 0
  for (const key of order) {
    let value: unknown
    try {
      value = nodes.get(key)
    } catch {
      storeUnavailable = true
      continue
    }
    if (!isToolChatNode(value)) continue
    try {
      if (isUnconfirmedToolNode(value, session)) {
        incompleteCount++
        continue
      }
      const candidate = mapToolNode(sessionId, value)
      if (candidate !== null) insertBounded(items, candidate)
    } catch {
      continue
    }
  }
  return serializedStateSize(items, incompleteCount) <= MAX_SAFE_STATE_BYTES ? { items, storeUnavailable, incompleteCount } : null
}

function isUnconfirmedToolNode(node: ChatNode<'tool-call'>, session: SessionSnapshot): boolean {
  const root = node.data.root
  if ('kind' in root) return root.kind === 'tool-result' && isFiniteFraction(root.seq)
  if (session.running !== true) return true
  const location = node.location
  if (location.kind === 'step') return location.step.status !== 'open' || location.turn.status !== 'open'
  if (location.kind === 'turn') return location.turn.status !== 'open'
  return true
}

function mapToolNode(sessionId: string, node: ChatNode<'tool-call'>): SafeOfficialToolActivity | null {
  const root = node.data.root
  const callId = root.callId
  if (!isSafeIdentifier(callId)) return null
  if (!('kind' in root)) return mapRunning(sessionId, callId, node.anchorSeq, root)
  if (root.kind !== 'tool-result') return null
  return mapSettled(sessionId, callId, node.anchorSeq, root)
}

function mapRunning(sessionId: string, callId: string, anchorSeq: number, root: RunningToolCall): SafeOfficialToolActivity {
  const start = safeTime(root.time)
  return activity({
    sessionId,
    callId,
    toolName: safeToolName(root.name),
    status: 'running',
    startedAt: start?.iso ?? null,
    endedAt: null,
    durationMs: null,
    startSeq: safeSequence(anchorSeq),
    resultSeq: null,
    resultSummary: 'running',
  })
}

function mapSettled(sessionId: string, callId: string, anchorSeq: number, root: ToolResultNode): SafeOfficialToolActivity | null {
  if (typeof root.isError !== 'boolean') return null
  const resultSeq = safeSequence(root.seq)
  if (root.call === null) {
    if (resultSeq === null) return null
    const end = safeTime(root.time)
    return activity({
      sessionId,
      callId,
      toolName: 'Unknown tool',
      status: 'result-without-call',
      startedAt: null,
      endedAt: end?.iso ?? null,
      durationMs: null,
      startSeq: null,
      resultSeq,
      resultSummary: 'result received without visible call',
    })
  }

  const startSeq = safeSequence(anchorSeq)
  const start = safeTime(root.callTime)
  if (resultSeq === null) return null
  if (startSeq !== null && resultSeq <= startSeq) return null

  const end = safeTime(root.time)
  const failed = root.isError === true
  return activity({
    sessionId,
    callId,
    toolName: safeToolName(root.call.name),
    status: failed ? 'failed' : 'succeeded',
    startedAt: start?.iso ?? null,
    endedAt: end?.iso ?? null,
    durationMs: start !== null && end !== null && end.epochMs >= start.epochMs ? end.epochMs - start.epochMs : null,
    startSeq,
    resultSeq,
    resultSummary: failed ? 'failed' : 'completed',
  })
}

function activity(input: Omit<SafeOfficialToolActivity, 'id' | 'source' | 'devflowRelation'>): SafeOfficialToolActivity {
  return {
    id: `${input.sessionId}:${input.callId}`,
    source: SOURCE,
    sessionId: input.sessionId,
    callId: input.callId,
    toolName: input.toolName,
    status: input.status,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    durationMs: input.durationMs,
    startSeq: input.startSeq,
    resultSeq: input.resultSeq,
    resultSummary: input.resultSummary,
    devflowRelation: UNKNOWN_RELATION,
  }
}

function insertBounded(items: SafeOfficialToolActivity[], candidate: SafeOfficialToolActivity): void {
  const duplicateIndex = items.findIndex(item => item.id === candidate.id)
  if (duplicateIndex >= 0) items[duplicateIndex] = preferredActivity(items[duplicateIndex]!, candidate)
  else if (items.length < MAX_ITEMS) items.push(candidate)
  else if (compareActivity(candidate, items[MAX_ITEMS - 1]!) < 0) items[MAX_ITEMS - 1] = candidate
  else return

  items.sort(compareActivity)
  if (items.length > MAX_ITEMS) items.length = MAX_ITEMS
}

function preferredActivity(left: SafeOfficialToolActivity, right: SafeOfficialToolActivity): SafeOfficialToolActivity {
  const leftRank = evidenceRank(left.status)
  const rightRank = evidenceRank(right.status)
  if (leftRank !== rightRank) return leftRank > rightRank ? left : right

  const leftSeq = sortSequence(left)
  const rightSeq = sortSequence(right)
  if (leftSeq !== rightSeq) return leftSeq > rightSeq ? left : right
  if (left.status !== right.status && (left.status === 'failed' || right.status === 'failed')) return left.status === 'failed' ? left : right
  return compareCodeUnits(activityFingerprint(left), activityFingerprint(right)) <= 0 ? left : right
}

function evidenceRank(status: OfficialToolActivityStatus): number {
  if (status === 'running') return 0
  if (status === 'result-without-call') return 1
  return 2
}

function compareActivity(left: SafeOfficialToolActivity, right: SafeOfficialToolActivity): number {
  const leftSeq = sortSequence(left)
  const rightSeq = sortSequence(right)
  if (leftSeq !== rightSeq) return leftSeq > rightSeq ? -1 : 1
  return compareCodeUnits(left.callId, right.callId)
}

function sortSequence(item: SafeOfficialToolActivity): number {
  return item.resultSeq ?? item.startSeq ?? -1
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function activityFingerprint(item: SafeOfficialToolActivity): string {
  return JSON.stringify([
    item.status,
    item.toolName,
    item.startedAt,
    item.endedAt,
    item.durationMs,
    item.startSeq,
    item.resultSeq,
    item.resultSummary,
  ])
}

function isToolChatNode(value: unknown): value is ChatNode<'tool-call'> {
  try {
    if (value === null || typeof value !== 'object') return false
    const node = value as Partial<ChatConversationViewNode> & { readonly data?: unknown }
    if (node.kind !== 'tool-call' || node.target !== 'chat' || node.visibility !== 'visible' || node.data === null || typeof node.data !== 'object') return false
    const data = node.data as { readonly root?: unknown }
    if (data.root === null || typeof data.root !== 'object') return false
    const root = data.root as { readonly callId?: unknown }
    return typeof root.callId === 'string'
  } catch {
    return false
  }
}

function serializedStateSize(items: readonly SafeOfficialToolActivity[], incompleteCount: number): number {
  return new TextEncoder().encode(JSON.stringify({
    phase: 'unavailable',
    source: SOURCE,
    window: WINDOW,
    hasMore: true,
    staleSafeItems: true,
    incompleteCount,
    items,
  })).byteLength
}

function isSafeIdentifier(value: string): boolean {
  return value.length > 0 && codePointLengthAtMost(value, MAX_ID_LENGTH) && !CONTROL_CHARACTER.test(value)
}

function safeToolName(value: unknown): string {
  return typeof value === 'string' && value.length > 0 && codePointLengthAtMost(value, MAX_TOOL_NAME_LENGTH) && !CONTROL_CHARACTER.test(value)
    ? value
    : 'Unknown tool'
}

function codePointLengthAtMost(value: string, maximum: number): boolean {
  let length = 0
  for (const _character of value) {
    length++
    if (length > maximum) return false
  }
  return true
}

function safeSequence(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function isFiniteFraction(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && !Number.isInteger(value)
}

function safeTime(value: unknown): SafeTime | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return { epochMs: value, iso: date.toISOString() }
}

function equalActivity(left: SafeOfficialToolActivity, right: SafeOfficialToolActivity | undefined): boolean {
  return right !== undefined
    && left.id === right.id
    && left.toolName === right.toolName
    && left.status === right.status
    && left.startedAt === right.startedAt
    && left.endedAt === right.endedAt
    && left.durationMs === right.durationMs
    && left.startSeq === right.startSeq
    && left.resultSeq === right.resultSeq
    && left.resultSummary === right.resultSummary
}

function state(
  phase: CurrentSessionToolsState['phase'],
  items: readonly SafeOfficialToolActivity[],
  hasMore: boolean,
  staleSafeItems: boolean,
  incompleteCount = 0,
): CurrentSessionToolsState {
  return { phase, source: SOURCE, window: WINDOW, hasMore, staleSafeItems, incompleteCount, items }
}

function unavailableState(): CurrentSessionToolsState {
  return state('unavailable', [], false, false)
}
