/**
 * Employee blockers: turn an employee's own "I could not do this" reply into a
 * durable, structured record, and decide when a task must stop being
 * re-dispatched because the same capability is missing each time.
 *
 * The whole point of this module is that a blocker is a FACT REPORTED BY THE
 * EMPLOYEE, never something the orchestrator infers. A reply that does not say
 * it is blocked produces `unstated`, and an unreadable reply produces nothing
 * at all — guessing here would be exactly the "fabricated state" the product
 * forbids.
 * @module @xiaoxie-ide/dsh-devflow/blocked-report
 */

import { randomUUID } from 'node:crypto'
import type { CapabilityGapKind, BlockedReport } from './types.ts'

/** How a reply declares its own business conclusion, when it declares one. */
export interface DeclaredOutcome {
  /** The declared conclusion. */
  readonly outcome: 'delivered' | 'blocked' | 'failed'
  /** Everything the reply said after the marker, verbatim. */
  readonly detail: string
}

/** Longest excerpt of the employee's reason kept in the durable record. */
export const BLOCKED_REASON_LIMIT = 400

/**
 * Read an employee's declared outcome from the first line of its reply.
 *
 * The contract asked of every fixed employee is one leading declaration:
 * `outcome: delivered|blocked|failed` optionally followed by ` — <reason>`. It
 * is read only from the FIRST non-empty line so a passing mention inside body
 * prose can never be mistaken for the declaration.
 * @param text - the employee's reply, verbatim.
 * @returns the declaration, or undefined when the reply declared nothing.
 */
export function declaredOutcome(text: string): DeclaredOutcome | undefined {
  const firstLine = text.split(/\r?\n/).map(line => line.trim()).find(line => line !== '')
  if (firstLine === undefined) return undefined
  const match = /^outcome\s*[:：]\s*(delivered|blocked|failed)\b([\s\S]*)$/i.exec(firstLine)
  if (match === null) return undefined
  const outcome = match[1]?.toLowerCase() as DeclaredOutcome['outcome']
  const detail = (match[2] ?? '').replace(/^\s*[—\-–:：]\s*/, '').trim()
  return { outcome, detail }
}

/** One tool name the employee named as missing, when it named one. */
const MISSING_TOOL = /\b(?:write|edit|str_replace_editor|read_image|pwsh|read|glob|grep|bash)\b/g

/**
 * Classify which capability the employee said it was missing.
 *
 * Only the employee's own words are classified. "no write/edit" is a missing
 * tool; "permission"/"审批"/"提权" is a permission; anything else is
 * `unstated` — the honest answer when the reply did not say.
 * @param detail - the employee's reason text.
 * @returns the gap kind.
 */
export function classifyCapabilityGap(detail: string): CapabilityGapKind {
  const text = detail.toLowerCase()
  if (/权限|授权|审批|提权|permission|not allowed|denied|forbidden/.test(text)) return 'permission'
  if (TOOL_NAME.test(text) && /没有|缺少|缺|missing|no\s+(?:write|edit)|without|未挂载|不可用/.test(text)) return 'tool'
  if (/依赖|dependency|not installed|未安装|找不到命令|command not found/.test(text)) return 'dependency'
  return 'unstated'
}

/** One tool name, tested WITHOUT the `g` flag: a global regex carries `lastIndex`
 * across `test()` calls, which would make detection depend on call order. */
const TOOL_NAME = /(?:write|edit|str_replace_editor|read_image|pwsh|read|glob|grep|bash|web_search|web_fetch|skill|workflow)/
/** The same names, for scanning one string exhaustively. */
const TOOL_NAME_ALL = /\b(?:write|edit|str_replace_editor|read_image|pwsh|read|glob|grep|bash|web_search|web_fetch|skill|workflow)\b/g

/**
 * The tool named IMMEDIATELY after an absence marker.
 *
 * Employees explain a blocker by contrasting what they lack with what they have
 * ("缺的正是 `web_search` 工具：当前可用工具集为 edit / glob / …"). Matching only
 * the name the absence marker points at is what keeps `missing` about the gap;
 * a bare scan for tool names reads the contrast list as the gap and reports the
 * exact opposite of the truth.
 */
const ABSENT_TOOL = /(?:没有|缺少|缺|无|未挂载|未注册|不可用|not\s+available|missing|without|no)[^A-Za-z0-9_`"']{0,8}[`"']?\s*(write|edit|str_replace_editor|read_image|pwsh|read|glob|grep|bash|web_search|web_fetch|skill|workflow)\b/g

/** The tool names the employee named as absent, deduplicated and in order. */
function missingTools(detail: string): readonly string[] {
  const names: string[] = []
  for (const match of detail.matchAll(ABSENT_TOOL)) {
    if (match[1] !== undefined) names.push(match[1])
  }
  if (names.length > 0) return [...new Set(names)]
  // No absence marker pointed at a tool: fall back to the tool names in the FIRST
  // sentence only, never to every tool name anywhere in the reply.
  const firstSentence = detail.split(/[。;；\n]/)[0] ?? detail
  const found = firstSentence.match(TOOL_NAME_ALL)
  return found === null ? [] : [...new Set(found)]
}

/**
 * The employee's reason with any "these are the tools I HAVE" tail removed.
 *
 * The durable record is shown to a user, and an inventory of the employee's own
 * tool catalogue is not part of the gap. The tail is dropped only after an
 * absence statement, so a reply that never lists its tools is kept verbatim.
 */
function gapReason(detail: string): string {
  if (!/(?:没有|缺少|缺|无|未挂载|不可用)/.test(detail)) return detail
  const cut = detail.split(/当前(?:可)?用工具集为|可用工具(?:集)?为|现有工具为|当前工具集为/)
  return cut.length > 1 ? `${cut[0]!.trim()}（可用工具清单已略）` : detail
}

/** Who the reply itself says could clear the blocker. */
function suggestedOwner(detail: string): string {
  if (/boss|用户|你执行|需要你|请用户/.test(detail)) return 'boss'
  if (/配置|preset|派发策略|宿主|DSH/.test(detail)) return 'DevFlow 配置层'
  if (/总指挥/.test(detail)) return '总指挥'
  return '未标明'
}

/**
 * Canonical form of a named capability, used for BOTH storage and comparison.
 *
 * Employees write the same gap differently from turn to turn — one reply lists
 * "read / write / edit / …", the next "edit / glob / … / write" — so an exact
 * string comparison treats one gap as two and the breaker never arms. Sorting and
 * deduplicating makes the stored value and the comparison key the same canonical
 * text, which is what lets "the same capability, again" actually match.
 * @param missing - the raw capability text.
 * @returns the canonical, order-independent form.
 */
export function normalizeMissing(missing: string): string {
  const names = [...new Set(missing.split(/[\/、,，\s]+/).map(part => part.trim()).filter(part => part !== ''))]
  if (names.length <= 1) return names[0] ?? '未标明'
  return [...names].sort().join(' / ')
}

/** The identity of a capability gap: what must match for the breaker to arm. */
export function gapKey(report: Pick<BlockedReport, 'gapKind' | 'missing'>): string {
  return `${report.gapKind}::${normalizeMissing(report.missing)}`
}

/** Bounded, whitespace-normalized excerpt of the employee's reason. */
function boundedReason(detail: string): string {
  const flat = detail.replace(/\s+/g, ' ').trim()
  return flat.length <= BLOCKED_REASON_LIMIT ? flat : `${flat.slice(0, BLOCKED_REASON_LIMIT - 1)}…`
}

/**
 * Build a blocked record from an employee reply that declared `blocked`.
 *
 * Nothing is invented: an undeclared tool list becomes `missing: '未标明'`, not
 * a guess at what the employee probably lacked.
 * @param input - the task, employee, execution identity, and the reply text.
 * @returns the durable blocked record.
 */
export function blockedReportFrom(input: {
  readonly taskId: string
  readonly agentId: string
  readonly executionId?: string
  readonly sessionId?: string
  readonly detail: string
  readonly now?: string
}): BlockedReport {
  const detail = input.detail.trim() === '' ? '未标明' : input.detail
  const gapKind = classifyCapabilityGap(detail)
  const tools = missingTools(detail)
  return {
    blockedId: randomUUID(),
    taskId: input.taskId,
    agentId: input.agentId,
    ...(input.executionId === undefined ? {} : { executionId: input.executionId }),
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    gapKind,
    missing: tools.length === 0 ? '未标明' : normalizeMissing(tools.join(' / ')),
    suggestedOwner: suggestedOwner(detail),
    reason: boundedReason(gapReason(detail)),
    createdAt: input.now ?? new Date().toISOString(),
  }
}

/** One line of human-facing Chinese, shown on the panel where a user will see it. */
export function blockedHeadline(report: BlockedReport, displayName: string): string {
  const gap = report.gapKind === 'tool'
    ? `缺少${report.missing} 工具`
    : report.gapKind === 'permission'
      ? '权限不足'
      : report.gapKind === 'dependency'
        ? '缺少所需组件'
        : '受阻（原因未标明）'
  const owner = report.suggestedOwner === '未标明' ? '' : `— 需 ${report.suggestedOwner} 处理`
  return `${displayName}${gap}，无法继续本次派发${owner}`
}

/**
 * Whether a dispatch must be refused because the same capability gap keeps
 * blocking this task.
 *
 * The breaker trips on the THIRD attempt: two blocked reports already spent two
 * turns reaching the same wall, and the third dispatch is what gets refused.
 * Only reports naming the SAME gap kind and the SAME missing capability count —
 * a new, different blocker is new information and must still be able to surface.
 * @param blocked - this task's blocked reports, newest first.
 * @returns the reason the dispatch is refused, or undefined when it may proceed.
 */
export function capabilityBreaker(
  blocked: readonly BlockedReport[],
): { readonly trips: true; readonly reason: string } | undefined {
  const newest = blocked[0]
  if (newest === undefined) return undefined
  const key = gapKey(newest)
  const sameGap = blocked.filter(item => gapKey(item) === key)
  if (sameGap.length < 2) return undefined
  return {
    trips: true,
    reason: `同一能力缺口已连续 ${sameGap.length} 次导致派发受阻（${newest.gapKind}: ${newest.missing}）；`
      + '已熔断，请先修复配置或权限后再派发',
  }
}
