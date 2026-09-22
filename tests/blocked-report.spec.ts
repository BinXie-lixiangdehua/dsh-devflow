/**
 * 第八步修复｜受阻上报与熔断的单元取证。
 *
 * 这三个用例锁住三件事：
 *  1. 受阻结论**只能**来自员工自己声明的首行（不声明 ⇒ `unknown`，绝不猜成 `delivered`）；
 *  2. 缺口分类只用员工自己的措辞（说不清就是 `unstated`）；
 *  3. 熔断在**第 3 次**同缺口派发时拒绝，且不同缺口不会误伤。
 */
import { describe, expect, it } from 'vitest'
import {
  BLOCKED_REASON_LIMIT, blockedHeadline, blockedReportFrom, capabilityBreaker, classifyCapabilityGap, declaredOutcome, gapKey,
} from '../src/host/blocked-report.ts'
import type { BlockedReport } from '../src/host/types.ts'

describe('employee-declared outcome', () => {
  it('reads the declaration only from the first non-empty line', () => {
    expect(declaredOutcome('outcome: blocked — 没有 write 工具'))
      .toEqual({ outcome: 'blocked', detail: '没有 write 工具' })
    expect(declaredOutcome('\n\noutcome: delivered')).toEqual({ outcome: 'delivered', detail: '' })
    expect(declaredOutcome('outcome：failed — 构建失败')).toEqual({ outcome: 'failed', detail: '构建失败' })
    // A body mention is not a declaration: only the head of the reply counts.
    expect(declaredOutcome('# DevFlow Result\n\noutcome: blocked')).toBeUndefined()
  })

  it('reports nothing when the reply declared nothing at all', () => {
    expect(declaredOutcome('已完成全部改动。')).toBeUndefined()
    expect(declaredOutcome('')).toBeUndefined()
    expect(declaredOutcome('outcome: maybe')).toBeUndefined()
  })
})

describe('capability gap classification', () => {
  it('classifies from the employee words and says unstated when it cannot tell', () => {
    expect(classifyCapabilityGap('本会话没有 write / edit 工具')).toBe('tool')
    expect(classifyCapabilityGap('权限不足，审批被自动拒绝')).toBe('permission')
    expect(classifyCapabilityGap('缺少依赖，command not found')).toBe('dependency')
    expect(classifyCapabilityGap('我没做成')).toBe('unstated')
  })

  it('keeps the named capability and the owner, and bounds the reason', () => {
    const report = blockedReportFrom({
      taskId: 'task-1',
      agentId: 'architect',
      executionId: 'execution-1',
      detail: '本会话没有 `write` 工具，无法落盘；请 boss 在配置层放宽。',
      now: '2026-09-18T02:00:00.000Z',
    })
    expect(report.gapKind).toBe('tool')
    expect(report.missing).toBe('write')
    expect(report.suggestedOwner).toBe('boss')
    expect(report.createdAt).toBe('2026-09-18T02:00:00.000Z')
    // Nothing declared means nothing invented.
    const bare = blockedReportFrom({ taskId: 'task-2', agentId: 'architect', detail: '' })
    expect(bare.gapKind).toBe('unstated')
    expect(bare.missing).toBe('未标明')
    const long = blockedReportFrom({ taskId: 'task-3', agentId: 'architect', detail: 'x'.repeat(BLOCKED_REASON_LIMIT * 2) })
    expect(long.reason.length).toBeLessThanOrEqual(BLOCKED_REASON_LIMIT)
  })

  it('names the GAP, never the employee tool catalogue it contrasts with', () => {
    // The real reply shape: what is missing, then what it does have. A bare scan
    // for tool names reads the second list as the gap and reports the opposite of
    // the truth — which is exactly what the first runtime run produced.
    const detail = '缺的正是 `web_search`（联网检索）工具：当前可用工具集为 edit / glob / grep / pwsh / read / read_image / write，其中不含任何联网检索能力。'
    const report = blockedReportFrom({ taskId: 'task-4', agentId: 'architect', detail })
    expect(report.missing).toBe('web_search')
    expect(report.missing).not.toContain('edit')
    expect(report.missing).not.toContain('pwsh')
    // The user-facing reason must not carry the employee's own tool inventory.
    expect(report.reason).toContain('web_search')
    expect(report.reason).toContain('可用工具清单已略')
    expect(report.reason).not.toContain('read_image')
  })

  it('words one plain-language line the panel can show as-is', () => {
    const report = blockedReportFrom({
      taskId: 'task-1', agentId: 'architect', detail: '本会话没有 write 工具；请 boss 处理。',
    })
    expect(blockedHeadline(report, '架构师')).toContain('架构师')
    expect(blockedHeadline(report, '架构师')).toContain('缺少')
    expect(blockedHeadline(report, '架构师')).toContain('boss')
  })
})

describe('capability breaker', () => {
  const blocked = (gapKind: BlockedReport['gapKind'], missing: string, at: string): BlockedReport => ({
    blockedId: `blocked-${at}`, taskId: 'task-1', agentId: 'architect', gapKind, missing,
    suggestedOwner: '未标明', reason: 'r', createdAt: at,
  })

  it('lets the first retry through and refuses the THIRD dispatch', () => {
    // The breaker reads a task's blocked reports before dispatch, so its state
    // is "how many blocked turns this task already spent".
    const one = [blocked('tool', 'write / edit', '2026-09-18T02:00:00.000Z')]
    // One blocked turn behind it: the retry may run (and is how the second
    // blocked report — the one that arms the breaker — gets produced).
    expect(capabilityBreaker(one)).toBeUndefined()

    // Two blocked turns behind it: this is the THIRD dispatch attempt, refused.
    const two = [blocked('tool', 'write / edit', '2026-09-18T02:05:00.000Z'), one[0]!]
    const trip = capabilityBreaker(two)
    expect(trip?.trips).toBe(true)
    expect(trip?.reason).toContain('熔断')
  })

  it('does not trip on a different gap, so new information can still surface', () => {
    const mixed = [
      blocked('permission', '审批', '2026-09-18T02:10:00.000Z'),
      blocked('tool', 'write / edit', '2026-09-18T02:05:00.000Z'),
      blocked('tool', 'write / edit', '2026-09-18T02:00:00.000Z'),
    ]
    expect(capabilityBreaker(mixed)).toBeUndefined()
  })

  it('counts the same gap written in a different ORDER', () => {
    // Observed in production: two replies about the SAME missing capability listed
    // the employee's own tools in different orders, so an exact string compare
    // saw two different gaps and the breaker never armed.
    const one = blocked('tool', 'read / write / edit / glob / grep / pwsh / read_image', '2026-09-18T02:00:00.000Z')
    const two = blocked('tool', 'edit / glob / grep / pwsh / read / read_image / write', '2026-09-18T02:05:00.000Z')
    expect(gapKey(one)).toBe(gapKey(two))
    const trip = capabilityBreaker([two, one])
    expect(trip?.trips).toBe(true)
    expect(trip?.reason).toContain('熔断')
  })
})
