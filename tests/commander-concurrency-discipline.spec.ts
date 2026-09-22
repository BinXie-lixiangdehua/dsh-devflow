import { describe, expect, it } from 'vitest'
import { DEVFLOW_CONCURRENCY_LIMIT } from '../src/contract.ts'
import { DEFAULT_FIXED_AGENTS } from '../src/host/default-agents.ts'
import { DEVFLOW_DISPATCH_AGENT_DESCRIPTION } from '../src/host/tools.ts'

/**
 * 第十三步 · 编排侧并发引导的**契约**（不是措辞）。
 *
 * 真机实测（N5 库 2026-09-20T18:20:50.621Z / .697Z）暴露的失败形状：总指挥在**同一轮里
 * 建了两个任务**，却只把第一个走完三件套并派出去 —— 第二个一直停在 `created`、连
 * `assign_agent` 都没做。原因不是宿主拦着（宿主额度 10、DevFlow 上限 5、谓词实测放行），
 * 而是**旧 prompt 自己在打架**：并发段要求"同一轮一起派"，而派活硬流程那句写着
 * 「**每创建一个任务，立即调一次 dispatch_agent，不要等所有任务创建完再统一 dispatch**」。
 * 总指挥照的是后者 ⇒ 建一个派一个 ⇒ 永远排成一前一后。
 *
 * 所以这里钉住三件事，缺任何一件真机就会退回串行：
 *  1. 硬流程必须是「先建齐 → 再绑边界 → 同一轮一起派」，且**明令不要建一个派一个**；
 *  2. 并行的**唯一**否决条件是「产物重叠」，且有先后依赖的任务必须分开派；
 *  3. 上限必须来自 host/client 共用的单点常量（不是又写一个 5）。
 */
const commanderPrompt = (): string =>
  DEFAULT_FIXED_AGENTS.find(agent => agent.agentId === 'commander')?.prompt ?? ''

describe('Commander concurrent-dispatch discipline', () => {
  it('says to create the whole batch and assign before dispatching, never one-at-a-time', () => {
    const prompt = commanderPrompt()
    // The three steps stay explicit and unskippable.
    expect(prompt).toContain('create_task')
    expect(prompt).toContain('assign_agent')
    expect(prompt).toContain('dispatch_agent')
    expect(prompt).toContain('三步不可省')
    // ...but the ORDER is batch-first, and the old "dispatch each one immediately" rule
    // is gone. Both halves matter: an instruction is only as strong as the absence of
    // the opposite one right next to it.
    expect(prompt).toContain('先建齐、再统一派')
    expect(prompt).toContain('不要建一个就立刻派一个')
    expect(prompt).not.toContain('每创建一个任务，立即调一次')
  })

  it('makes same-turn dispatch the DEFAULT, and names product overlap as the only veto', () => {
    const prompt = commanderPrompt()
    expect(prompt).toContain('默认工作方式，不是特例')
    expect(prompt).toContain('在同一轮里被派出去')
    // The judgement that decides it, stated as one sentence the model can apply.
    expect(prompt).toContain('产物重叠')
    expect(prompt).toContain('产物不重叠、彼此不依赖')
    // Both reasons to split the batch are named: overlapping products, and a real
    // ordering dependency (a task that needs the previous task's output).
    expect(prompt).toContain('有先后依赖的任务也必须分开派')
  })

  it('kills the "dispatch one, wait for it" default that made every dispatch a solo step', () => {
    const prompt = commanderPrompt()
    // The measured root cause: the prompt used to say 「4. 等待结果并汇总给用户」, which
    // framed dispatch as a blocking one-at-a-time action. Measured in production: across
    // 17 dispatch steps, a dispatch NEVER shared a step with another call. The wait is per
    // BATCH now, and both halves are asserted — the new framing present, the old absent.
    expect(prompt).toContain('收齐结果后汇总给用户')
    expect(prompt).not.toContain('等待结果并汇总给用户')
    expect(prompt).toContain('第 3 步不是"一次一个"')
    expect(prompt).toContain('等的是这一批，不是某一个')
    // ...and the standing prohibition against serializing by waiting.
    expect(prompt).toContain('不要"派一个 → 等它回来 → 再派下一个"')
    expect(prompt).toContain('整批一起等')
  })

  it('gives the model a mechanical self-check it can apply at dispatch time', () => {
    // The experiment that worked needed the user to spell out "emit both in one reply".
    // The rule now carries that phrasing itself, so it no longer depends on the user.
    const prompt = commanderPrompt()
    expect(prompt).toContain('并列写在同一条回复里')
    expect(prompt).toContain('一条回复的并列工具调用里出现多个')
    expect(prompt).toContain('说明你漏了同批的就绪任务')
  })

  it('keeps the limits and the anti-padding rules next to the permission', () => {
    const prompt = commanderPrompt()
    // The ceiling comes from the SINGLE shared definition, so the prompt cannot drift
    // from the host's admission predicate.
    expect(prompt).toContain(`**${DEVFLOW_CONCURRENCY_LIMIT}**`)
    expect(prompt).toContain('已达并发上限')
    expect(prompt).toContain('排队是正常的')
    expect(prompt).toContain('不要为了凑数把任务拆碎')
    expect(prompt).toContain('也不要把同一个任务重复派')
    // Concurrency may never be used as a reason to shorten the audit chain.
    expect(prompt).toContain('因为并发可用就缩短审计 / 复核链路')
    expect(prompt).toContain('验收口径与串行时完全一致')
  })

  it('keeps the Commander on its read-only tool plane (prompt change only)', () => {
    const commander = DEFAULT_FIXED_AGENTS.find(agent => agent.agentId === 'commander')
    for (const forbidden of ['write', 'edit', 'pwsh', 'str_replace_editor']) {
      expect(commander?.tools).not.toContain(forbidden)
    }
    expect(commander?.tools).toContain('devflow_dispatch_agent')
  })

  it('★ tells the model AT THE CALL SITE that dispatches may overlap', () => {
    // The prompt is not the only surface the model reads when it decides: it also sees
    // the tool description at the moment it emits the call. It used to describe a single
    // dispatch and say nothing about overlap — which is where the one-at-a-time default
    // was formed. The description is exported, so this pins the real shipped text.
    expect(DEVFLOW_DISPATCH_AGENT_DESCRIPTION).toContain('OVERLAP')
    expect(DEVFLOW_DISPATCH_AGENT_DESCRIPTION).toContain('parallel calls in ONE reply')
    expect(DEVFLOW_DISPATCH_AGENT_DESCRIPTION).toContain('do not dispatch one and wait for it')
    // The sequential exception stays stated, so the permission is not unconditional.
    expect(DEVFLOW_DISPATCH_AGENT_DESCRIPTION).toContain('must stay sequential')
  })
})

/**
 * 真机实测（超级玛丽库，2026-09-20T19:27:40Z）：名册**一个临时员工都没有**，两件只读调研
 * 却派给了固定员工（`architect` / `frontend-engineer`），而且子代理拿到的 `toolFilter` 是
 * **完整写权限** `[read, write, edit, glob, grep, read_image, pwsh]` —— 给一个只需要读的任务
 * 发了写权限。这是**流程违背**，不是系统拦截：`devflow_assign_agent` 只校验 phase / agent /
 * task 存在（tools.ts:1379-1389），没有任何"这类任务只能派临时员工"的守卫。
 *
 * 修法（boss 2026-09-21 选 A）：只改 prompt —— 把"调研类必须派临时子代理、固定员工不接调研"
 * 写成硬规则，并把 `devflow_agent_upsert` 从"例外"改成"调研类任务的必经步骤"。
 */
describe('Commander research-vs-delivery staffing discipline', () => {
  it('splits work into 交付 (fixed employees) vs 调研 (temporary sub-agents)', () => {
    const prompt = commanderPrompt()
    // The rule has to NAME both kinds and their owners.
    expect(prompt).toContain('先分清"交付"还是"调研"')
    expect(prompt).toContain('必须派给临时子代理')
    expect(prompt).toContain('固定员工不接调研类任务')
    // The reason is stated, not just the prohibition — that is what makes it stick.
    expect(prompt).toContain('给一个只需要读的任务发写权限')
    // Mixed tasks are split rather than half-assigned.
    expect(prompt).toContain('混合型任务')
  })

  it('names the research kinds that must NOT go to a fixed employee', () => {
    const prompt = commanderPrompt()
    for (const kind of ['用户需求', '使用习惯', '使用场景', '同类产品', '玩法要素偏好', '竞品对比']) {
      expect(prompt).toContain(kind)
    }
  })

  it('makes devflow_agent_upsert a required step for research, not an exception', () => {
    const prompt = commanderPrompt()
    expect(prompt).toContain('调研类任务的必经步骤')
    // The old wording made upsert sound like something to avoid, which is exactly how a
    // research task ended up on a fixed employee. It must be gone.
    expect(prompt).not.toContain('禁止调用 `devflow_agent_upsert`')
    expect(prompt).not.toContain('例外：用户明确要求增加一名团队成员时')
    // ...and the "don't take the shortcut" clause is stated explicitly.
    expect(prompt).toContain('太麻烦')
    expect(prompt).toContain('退而派给固定员工')
  })

  it('keeps the architect on OUTPUT work and sends its research half to a sub-agent', () => {
    const prompt = commanderPrompt()
    expect(prompt).toContain('调研本身不要派给架构师')
    expect(prompt).toContain('必须先由临时子代理做完')
  })

  it('keeps the fixed employees on the work they actually own', () => {
    const prompt = commanderPrompt()
    // Delivery ownership is unchanged: the split must not blur who writes what.
    expect(prompt).toContain('后端→`backend-engineer`')
    expect(prompt).toContain('前端→`frontend-engineer`')
    expect(prompt).toContain('架构与技术选型→`architect`')
    expect(prompt).toContain('审计与质量→`code-auditor`')
  })
})
