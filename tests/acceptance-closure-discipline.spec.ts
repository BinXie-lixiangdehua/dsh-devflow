import { describe, expect, it } from 'vitest'
import { DEFAULT_FIXED_AGENTS, COMMANDER_NAVIGATION_SCOPE, COMMANDER_READ_ONLY_TOOLS } from '../src/host/default-agents.ts'
import { TRANSITIONS } from '../src/host/workflow.ts'

/**
 * The N5 acceptance gap, pinned in the one place it can be pinned without a
 * model call: the Commander's own prompt.
 *
 * N5 ran the whole pipeline end to end — dispatch, audit, rework, re-verification
 * — and still left all seven tasks in `reviewing`, because `reviewing` means
 * "waiting for the user to accept" and nothing in the prompt ever told the
 * Commander to close a task once the user said yes. These assertions are the
 * prompt's contract, not its wording: they check the semantics a rewrite must
 * preserve.
 */
const commanderPrompt = (): string =>
  DEFAULT_FIXED_AGENTS.find(agent => agent.agentId === 'commander')?.prompt ?? ''

describe('Commander acceptance closure', () => {
  it('names the closing tool and the state it closes from', () => {
    const prompt = commanderPrompt()
    expect(prompt).toContain('devflow_transition_task')
    expect(prompt).toContain('reviewing')
    expect(prompt).toContain('completed')
  })

  it('gates the closure on the USER saying they accept', () => {
    const prompt = commanderPrompt()
    // The trigger has to be the user's verdict, stated in the prompt itself.
    expect(prompt).toContain('用户明确表示接受')
    expect(prompt).toContain('验收通过')
    // ...and the prohibition has to be as explicit as the instruction.
    expect(prompt).toContain('不得由你自己判定验收通过')
    expect(prompt).toContain('用户没说接受，就不许 transition')
    // "Make the panel look better" is named as a non-reason, because that is the
    // shape this rule exists to stop (the 7 tasks sitting at 待验收 7).
    expect(prompt).toContain('让面板好看')
  })

  it('scopes the closure to the accepted task and sends a refusal down the rework path', () => {
    const prompt = commanderPrompt()
    expect(prompt).toContain('对应的那一个任务')
    expect(prompt).toContain('不许多收口')
    // Refusal adds no new flow: it reuses the existing reviewing → executing edge.
    expect(prompt).toContain('返工')
  })

  it('keeps the closure reachable: the transition tool and the legal edge both exist', () => {
    const commander = DEFAULT_FIXED_AGENTS.find(agent => agent.agentId === 'commander')
    expect(commander?.tools).toContain('devflow_transition_task')
    expect(TRANSITIONS.reviewing).toContain('completed')
    expect(TRANSITIONS.reviewing).toContain('executing')
  })

  it('changes the prompt only: the Commander still holds no writing tool', () => {
    const commander = DEFAULT_FIXED_AGENTS.find(agent => agent.agentId === 'commander')
    for (const forbidden of ['write', 'edit', 'pwsh', 'str_replace_editor']) {
      expect(commander?.tools).not.toContain(forbidden)
    }
    for (const readOnly of COMMANDER_READ_ONLY_TOOLS) {
      expect(commander?.tools).toContain(readOnly)
    }
    // The navigation boundary the closing instruction sits next to is unchanged.
    expect(commanderPrompt()).toContain(COMMANDER_NAVIGATION_SCOPE)
  })
})
