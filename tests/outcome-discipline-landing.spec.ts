/**
 * 段一取证：`outcome` 纪律的**落点**必须落在解析器真正读到的那个分区里。
 *
 * 旧文案要求写「文档正文最前面那一行」，而 `declaredOutcome(parsed.summary)`
 * （`tools.ts:1571`）读的 `parsed.summary` ＝ `sectionText('Summary')`
 * （`markdown-bridge.ts:187`）＝ **只有 `## Summary` 分区内的文字**。
 * `splitSections` 丢弃第一个 `##` 之前的所有行（`markdown-bridge.ts:107`），
 * 所以那一行**永远**进不了 `parsed.summary`。
 *
 * 本用例把这条不相交钉死在两处：
 * ① 文案本身：落点写「`## Summary` 分区的第一行」，且不再要求把结论写在标题之前；
 * ② 行为：同一句结论，写在 `## Summary` 第一行 → 解析得出来；写在第一个 `##`
 *    之前（旧落点）→ 解析不出来。解析器与 Result 文档契约都**未改**。
 */
import { describe, expect, it } from 'vitest'
import { declaredOutcome } from '../src/host/blocked-report.ts'
import { DEFAULT_FIXED_AGENTS, EMPLOYEE_OUTCOME_DISCIPLINE } from '../src/host/default-agents.ts'
import { parseResultMarkdown } from '../src/host/markdown-bridge.ts'
import { PROTOCOL_VERSION } from '../src/host/protocol.ts'

const DECLARATION = 'outcome: delivered — 汇率速览已落盘'

/** A well-formed result document whose `## Summary` holds `summaryLines` verbatim. */
function resultDocument(summaryLines: readonly string[], preamble: readonly string[] = []): string {
  return [
    '# DevFlow Result',
    '',
    ...preamble,
    '## Metadata',
    '',
    `Protocol Version: ${PROTOCOL_VERSION}`,
    'Task ID: task-outcome-landing',
    'Verdict: accepted',
    '',
    '## Summary',
    '',
    ...summaryLines,
    '',
    '## Changes',
    '',
    '- None',
    '',
    '## Verification',
    '',
    '- None',
    '',
    '## Issues',
    '',
    '- None',
    '',
    '## Next Steps',
    '',
    '- None',
  ].join('\n')
}

/** The four dispatched employees whose prompt carries the discipline. */
const DISCIPLINED_EMPLOYEES = ['architect', 'backend-engineer', 'frontend-engineer', 'code-auditor'] as const

describe('the outcome discipline lands inside the section the parser reads', () => {
  it('names the first line of the `## Summary` section and drops the old body-first-line wording', () => {
    expect(EMPLOYEE_OUTCOME_DISCIPLINE).toContain('`## Summary`')
    expect(EMPLOYEE_OUTCOME_DISCIPLINE).toContain('分区的第一行')
    // The retired landing point: no copy may still ask for a line outside a section.
    expect(EMPLOYEE_OUTCOME_DISCIPLINE).not.toContain('首行')
    expect(EMPLOYEE_OUTCOME_DISCIPLINE).not.toContain('正文')
  })

  it('reaches every dispatched employee prompt, so all four share the new landing point', () => {
    for (const agentId of DISCIPLINED_EMPLOYEES) {
      const employee = DEFAULT_FIXED_AGENTS.find(agent => agent.agentId === agentId)
      expect(employee?.prompt, `${agentId} is a shipped fixed employee`).toContain(EMPLOYEE_OUTCOME_DISCIPLINE)
      expect(employee?.prompt).toContain('`## Summary`')
    }
  })

  it('reads the declaration back when it is the first line of `## Summary`', () => {
    const parsed = parseResultMarkdown(resultDocument([DECLARATION, '', '详情见产物。']))

    expect(parsed.summary.startsWith(DECLARATION)).toBe(true)
    expect(declaredOutcome(parsed.summary)).toEqual({ outcome: 'delivered', detail: '汇率速览已落盘' })
  })

  it('cannot see the declaration written before the first heading, which is the retired landing point', () => {
    // Same declaration, old position: the body's first line, above `## Metadata`.
    const parsed = parseResultMarkdown(resultDocument(['已按纪律回传。'], [DECLARATION, '']))

    expect(parsed.summary).not.toContain('outcome:')
    expect(declaredOutcome(parsed.summary)).toBeUndefined()
  })

  it('still fails loud on an empty `## Summary`, so the new requirement conflicts with nothing', () => {
    // An empty section is already a hard failure, so asking for its FIRST line adds
    // a requirement to a document that could not parse without that line anyway.
    expect(() => parseResultMarkdown(resultDocument([]))).toThrow('missing summary')
    expect(() => parseResultMarkdown(resultDocument(['', '   ']))).toThrow('missing summary')
  })
})
