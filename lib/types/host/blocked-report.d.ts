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
import type { CapabilityGapKind, BlockedReport } from './types.ts';
/** How a reply declares its own business conclusion, when it declares one. */
export interface DeclaredOutcome {
    /** The declared conclusion. */
    readonly outcome: 'delivered' | 'blocked' | 'failed';
    /** Everything the reply said after the marker, verbatim. */
    readonly detail: string;
}
/** Longest excerpt of the employee's reason kept in the durable record. */
export declare const BLOCKED_REASON_LIMIT = 400;
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
export declare function declaredOutcome(text: string): DeclaredOutcome | undefined;
/**
 * Classify which capability the employee said it was missing.
 *
 * Only the employee's own words are classified. "no write/edit" is a missing
 * tool; "permission"/"审批"/"提权" is a permission; anything else is
 * `unstated` — the honest answer when the reply did not say.
 * @param detail - the employee's reason text.
 * @returns the gap kind.
 */
export declare function classifyCapabilityGap(detail: string): CapabilityGapKind;
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
export declare function normalizeMissing(missing: string): string;
/** The identity of a capability gap: what must match for the breaker to arm. */
export declare function gapKey(report: Pick<BlockedReport, 'gapKind' | 'missing'>): string;
/**
 * Build a blocked record from an employee reply that declared `blocked`.
 *
 * Nothing is invented: an undeclared tool list becomes `missing: '未标明'`, not
 * a guess at what the employee probably lacked.
 * @param input - the task, employee, execution identity, and the reply text.
 * @returns the durable blocked record.
 */
export declare function blockedReportFrom(input: {
    readonly taskId: string;
    readonly agentId: string;
    readonly executionId?: string;
    readonly sessionId?: string;
    readonly detail: string;
    readonly now?: string;
}): BlockedReport;
/** One line of human-facing Chinese, shown on the panel where a user will see it. */
export declare function blockedHeadline(report: BlockedReport, displayName: string): string;
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
export declare function capabilityBreaker(blocked: readonly BlockedReport[]): {
    readonly trips: true;
    readonly reason: string;
} | undefined;
