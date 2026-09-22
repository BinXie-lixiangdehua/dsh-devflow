import { describe, expect, it } from 'vitest'
import { parseResultMarkdown, renderTaskMarkdown } from '../src/host/markdown-bridge.ts'
import { PROTOCOL_VERSION, type AgentTaskPackage } from '../src/host/protocol.ts'

function taskPackage(taskId: string): AgentTaskPackage {
  const now = '2026-08-31T00:00:00.000Z'
  return {
    protocolVersion: PROTOCOL_VERSION,
    taskId,
    role: 'backend-engineer',
    projectContext: {
      id: 'project-m8', name: 'M8', goal: 'Verify scripts', currentStage: 'acceptance', createdAt: now, updatedAt: now,
    },
    task: {
      id: taskId, title: 'Inspect package scripts', description: 'Read package.json scripts without modifying files.',
      status: 'executing', assignedRole: 'backend-engineer', createdAt: now, updatedAt: now,
    },
    instructions: 'Return the required result document only.',
    acceptanceCriteria: ['List the available package scripts.', 'Do not modify files.'],
  }
}

function resultDocument(taskId: string): string {
  return [
    '# DevFlow Result',
    '',
    '## Metadata',
    '',
    `Protocol Version: ${PROTOCOL_VERSION}`,
    `Task ID: ${taskId}`,
    'Verdict: accepted',
    '',
    '## Summary',
    '',
    'Inspected package.json scripts without modifying files.',
    '',
    '## Changes',
    '',
    '- None',
    '',
    '## Verification',
    '',
    '- Confirmed the scripts entries by reading package.json.',
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

describe('fixed Agent Markdown result handoff', () => {
  it('appends one exact task-specific Required Result Format deterministically', () => {
    const pkg = taskPackage('task-m8-readonly')
    const first = renderTaskMarkdown(pkg)
    const second = renderTaskMarkdown(pkg)

    expect(second).toBe(first)
    expect(first.match(/# DevFlow Result/g)).toHaveLength(1)
    expect(first).toContain('## Required Result Format')
    expect(first).toContain(`Protocol Version: ${pkg.protocolVersion}`)
    expect(first).toContain(`Task ID: ${pkg.taskId}`)
    expect(first).toContain('Verdict: accepted|changes-requested|rejected')
    expect(first).not.toMatch(/Verdict: completed\|blocked\|failed/)
    for (const heading of ['## Summary', '## Changes', '## Verification', '## Issues', '## Next Steps']) {
      expect(first).toContain(heading)
    }
    expect(first).toContain('- <change or None>')
    expect(first).toContain('Do not output any text or fenced code block before or after the result document.')
  })

  it('injects each export task id without reusing a previous package value', () => {
    const first = renderTaskMarkdown(taskPackage('task-first'))
    const second = renderTaskMarkdown(taskPackage('task-second'))

    expect(first).toContain('Task ID: task-first')
    expect(first).not.toContain('Task ID: task-second')
    expect(second).toContain('Task ID: task-second')
    expect(second).not.toContain('Task ID: task-first')
  })

  it('parses a completed read-only result that follows the rendered format', () => {
    const taskId = 'task-m8-readonly'
    const rendered = renderTaskMarkdown(taskPackage(taskId))
    expect(rendered).toContain(resultDocument(taskId).split('\n').slice(0, 7).join('\n'))

    expect(parseResultMarkdown(resultDocument(taskId))).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      taskId,
      verdict: 'accepted',
      summary: 'Inspected package.json scripts without modifying files.',
      changes: ['None'],
      verification: ['Confirmed the scripts entries by reading package.json.'],
      issues: ['None'],
      nextSteps: ['None'],
    })
  })

  it('accepts all three review verdicts without weakening the required fields', () => {
    for (const verdict of ['accepted', 'changes-requested', 'rejected'] as const) {
      const parsed = parseResultMarkdown(resultDocument('task-verdicts').replace('Verdict: accepted', `Verdict: ${verdict}`))
      expect(parsed.verdict).toBe(verdict)
      expect(parsed.taskId).toBe('task-verdicts')
      expect(parsed.summary).not.toBe('')
    }
    expect(() => parseResultMarkdown(resultDocument('task-verdicts').replace('Verdict: accepted', 'Verdict: done')))
      .toThrow(/verdict/)
  })
})
