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
import type { DevFlowActivationCode, DevFlowActivationFailurePhase } from './types.ts';
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
export declare const ACTIVATION_CODE_REASONS_ZH: Record<DevFlowActivationCode, string>;
/** One fixed phrase per refused act, so the operator learns what was attempted. */
export declare const ACTIVATION_PHASE_REASONS_ZH: Record<DevFlowActivationFailurePhase, string>;
/** Every code this build can report, in one place for completeness tests. */
export declare const DEVFLOW_ACTIVATION_CODE_LIST: readonly DevFlowActivationCode[];
/**
 * The fixed Chinese reason for one refusal code.
 *
 * An unknown code can only arrive from a newer build's journal replayed by an
 * older one; it degrades to the code itself rather than to an empty sentence,
 * so the reader still sees which refusal it was.
 * @param code - the refusal code to explain.
 * @returns one non-empty Chinese sentence.
 */
export declare function activationReasonZh(code: string): string;
