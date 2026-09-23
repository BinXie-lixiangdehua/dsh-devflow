import { describe, expect, it } from 'vitest'
import { DEFAULT_FIXED_AGENTS } from '../src/host/default-agents.ts'

/**
 * 真机实测（2026-09-23，`D:\公众号agent`）：项目把 `docs/04-阶段与进度.md` 写到"阶段 1–6 已完成"，
 * 而 `.devflow` 里 **12 个阶段全部停在 `planned`** —— Commander 手里虽有 `devflow_update_phase`，
 * prompt 却从没要求它推进阶段状态，面板于是整场显示「计划中」。
 *
 * 这些断言锁住"阶段状态纪律"的语义（不是措辞）：工具与两个目标状态、推进 `completed` 的验收闸门、
 * "面板读的是哪份记录"、以及"让面板好看"被点名为非理由。
 */
const commanderPrompt = (): string =>
  DEFAULT_FIXED_AGENTS.find(agent => agent.agentId === 'commander')?.prompt ?? ''

describe('Commander phase-status discipline', () => {
  it('names the tool and both target states', () => {
    const prompt = commanderPrompt()
    expect(prompt).toContain('devflow_update_phase')
    expect(prompt).toContain('in_progress')
    expect(prompt).toContain('completed')
  })

  it('gates `completed` on the phase’s tasks having been accepted by the user', () => {
    const prompt = commanderPrompt()
    expect(prompt).toContain('全部任务都已由用户验收收口')
    // The phase record starts here, and that is what the panel renders.
    expect(prompt).toContain('计划中')
  })

  it('says which record the panel reads, and that the two must agree', () => {
    const prompt = commanderPrompt()
    expect(prompt).toContain('面板读的是 `.devflow` 里的阶段记录')
    expect(prompt).toContain('docs/04-阶段与进度.md')
  })

  it('names "make the panel look good" as a non-reason for advancing a phase', () => {
    expect(commanderPrompt()).toContain('让面板好看')
  })

  it('keeps the tool reachable while still granting the Commander no writing tool', () => {
    const commander = DEFAULT_FIXED_AGENTS.find(agent => agent.agentId === 'commander')
    expect(commander?.tools).toContain('devflow_update_phase')
    for (const forbidden of ['write', 'edit', 'pwsh', 'str_replace_editor']) {
      expect(commander?.tools).not.toContain(forbidden)
    }
  })
})
