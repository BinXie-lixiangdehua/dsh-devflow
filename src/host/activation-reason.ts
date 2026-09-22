/**
 * The one reason vocabulary for a refused DevFlow preset activation.
 *
 * Two surfaces read the same refusal and must never disagree about it:
 *
 *  - the **durable audit record** (`devflow/preset/activation-failed`) proves
 *    *that* it happened, and survives a Host restart;
 *  - the **human surfaces** (`/devflow commander status`, the panel) must say
 *    *why* without a debugger, so each code carries one fixed Chinese sentence
 *    and one bounded English one.
 *
 * Both live here rather than beside either reader, because a second copy of
 * this table is exactly how "what the log says" and "what the operator is told"
 * drift apart. The Chinese sentence is the product-facing text the PM asked
 * for; the English one is what the DTO carries to a non-Chinese locale.
 * @module @xiaoxie-ide/dsh-devflow/activation-reason
 */

import type { DevFlowActivationCode, DevFlowActivationFailurePhase } from './types.ts'

/**
 * Fixed Chinese explanation per refusal code.
 *
 * These are the strings `/devflow commander status` prints and the panel shows,
 * so each one must name the *actionable* fact (what to check) rather than
 * restate the code in prose. A mapped value must never be empty: the reason
 * table is the last place a real cause can survive, and an empty sentence would
 * silently reintroduce the fixed-blank-message problem this module exists to
 * remove.
 */
export const ACTIVATION_CODE_REASONS_ZH: Record<DevFlowActivationCode, string> = {
  'devflow-preset-identity-mismatch': '请求的 preset 与当前会话实际组合的 preset 不一致。',
  'devflow-session-mismatch': '会话记录的 preset 与运行中的 Agent 不一致。',
  'devflow-project-unavailable': '此会话读不到共享的 DevFlow 项目。',
  'devflow-project-init-failed': 'DevFlow 项目无法为此会话初始化。',
  'devflow-commander-install-failed': 'DevFlow 总指挥无法装入此会话。',
  'devflow-activation-verification-failed': 'DevFlow 激活未通过实时校验（工具集尚未结算，或工具集不符）。',
  'devflow-commander-not-installed': '此会话尚未装入 DevFlow 总指挥。',
  'devflow-deactivation-failed': 'DevFlow 总指挥无法从此会话移除。',
  'devflow-restore-failed': 'DevFlow 总指挥无法恢复到此会话。',
  'devflow-journal-failed': 'DevFlow 激活记录写入失败。',
  'devflow-host-unavailable': 'DevFlow 宿主服务不可用。',
}

/** One fixed phrase per refused act, so the operator learns what was attempted. */
export const ACTIVATION_PHASE_REASONS_ZH: Record<DevFlowActivationFailurePhase, string> = {
  initial: '首次激活',
  recompose: '切换 preset',
  deactivate: '撤销激活',
  restore: '回滚恢复',
  journal: '留痕写入',
}

/** Every code this build can report, in one place for completeness tests. */
export const DEVFLOW_ACTIVATION_CODE_LIST: readonly DevFlowActivationCode[] = Object.keys(
  ACTIVATION_CODE_REASONS_ZH,
) as DevFlowActivationCode[]

/**
 * The fixed Chinese reason for one refusal code.
 *
 * An unknown code can only arrive from a newer build's journal replayed by an
 * older one; it degrades to the code itself rather than to an empty sentence,
 * so the reader still sees which refusal it was.
 * @param code - the refusal code to explain.
 * @returns one non-empty Chinese sentence.
 */
export function activationReasonZh(code: string): string {
  return ACTIVATION_CODE_REASONS_ZH[code as DevFlowActivationCode] ?? `激活被拒绝（未识别的代码：${code}）。`
}
