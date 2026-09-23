/**
 * Fold bookkeeping for the canvas' two standing banners: the activation refusal and the
 * 受阻 (blocked) report.
 *
 * Both must exist — a session that recovered still has to explain the failure the user just
 * watched, and an employee that reported it could not work must be visible without opening
 * the conversation — but neither may occupy the top of the canvas forever. Folding is
 * therefore allowed, under rules that keep it honest rather than cosmetic:
 *
 *  * the activation refusal is foldable ONLY once the Host recovered from it
 *    (`activation === 'bound'`); a standing refusal is a live problem. The 受阻 banner IS
 *    foldable, because it reports work that already stopped and it sits above the flow the
 *    user came to read — but it folds to a line that still names the count and the latest
 *    report, and one click reopens it;
 *  * BOTH foldable banners start folded once the user has seen them: a recovered refusal is
 *    history, and a 受阻 line still shows its count and its latest report. Only an explicit
 *    expansion is remembered, so re-folding needs no stored state at all;
 *  * a fold is remembered per EVENT (`code` + moment for a refusal; the id set for blocked
 *    reports), never per banner, so the next failure or the next blocked report opens
 *    expanded again.
 *
 * @module @xiaoxie-ide/dsh-devflow/client/activation-banner
 */
import type { DevFlowClientActivation, DevFlowClientActivationFailure, DevFlowClientBlocked } from '../contract.ts';
/** The refusal fields the fold bookkeeping reads. */
type RefusalIdentity = Pick<DevFlowClientActivationFailure, 'code' | 'at'>;
/** The blocked-report fields the fold bookkeeping keys on. */
type BlockedIdentity = readonly Pick<DevFlowClientBlocked, 'id' | 'at'>[];
/** `localStorage` access that never throws (private mode, disabled storage). */
export declare function safeStorage(): Storage | null;
/**
 * Storage key for ONE refusal. The moment is part of the key on purpose: a later refusal
 * with the same code is a different event and must open expanded again.
 *
 * The flag means "the user explicitly EXPANDED this banner": a recovered refusal starts
 * folded (it is history, and a two-line notice above the canvas is what the live feedback
 * complained about), so folding again is the default rather than a remembered choice.
 */
export declare function activationFoldKey(failure: RefusalIdentity): string;
/**
 * What the banner should offer for one recorded refusal.
 *
 * A refusal the Host RECOVERED from starts folded: it is history, and a two-line notice
 * above the canvas is exactly what the live feedback complained about. A standing refusal
 * is a live problem, so it is neither foldable nor folded.
 * @param failure - the refusal the snapshot carries, or null when there is none.
 * @param activation - the Host-verified posture of the same session.
 * @param storage - storage to read the remembered expansion from, or null when unavailable.
 * @returns whether the banner may be folded, and whether it starts folded.
 */
export declare function activationBannerMode(failure: RefusalIdentity | null, activation: DevFlowClientActivation, storage: Pick<Storage, 'getItem'> | null): {
    readonly collapsible: boolean;
    readonly folded: boolean;
};
/**
 * Remember the fold, or forget it when the user reopens the banner.
 *
 * A storage that refuses the write is ignored, not fatal: the fold still applies for the
 * rest of the session through component state.
 * @param storage - storage to write, or null when unavailable.
 * @param failure - the refusal being folded or reopened.
 * @param folded - true to remember the fold, false to forget it.
 */
export declare function storeActivationFold(storage: Pick<Storage, 'setItem' | 'removeItem'> | null, failure: RefusalIdentity, folded: boolean): void;
/**
 * Storage key for one SET of blocked reports.
 *
 * The whole id set is hashed, so the request survives a re-render and a reload but a NEW
 * blocked report changes the key and the banner opens expanded again. djb2 keeps the key
 * short without pulling in a hash dependency, and the count is part of the key so an
 * emptied-then-refilled banner cannot inherit the old request.
 *
 * Like the refusal key, the flag means "the user explicitly EXPANDED this banner": the
 * 受阻 line starts compact on purpose, because the panel sits directly above the flow the
 * user came to read.
 * @param rows - the blocked reports the snapshot carries.
 * @returns the storage key for that exact set.
 */
export declare function blockedExpandKey(rows: BlockedIdentity): string;
/**
 * Whether the 受阻 banner starts folded for this exact set of reports.
 * @param rows - the blocked reports the snapshot carries.
 * @param storage - storage to read the remembered expansion from, or null when unavailable.
 * @returns true unless the user explicitly expanded THIS set.
 */
export declare function blockedBannerFolded(rows: BlockedIdentity, storage: Pick<Storage, 'getItem'> | null): boolean;
/**
 * Remember the 受阻 expansion, or forget it when the user folds the banner again.
 * @param storage - storage to write, or null when unavailable.
 * @param rows - the blocked reports the banner is showing.
 * @param folded - true to forget the expansion, false to remember it.
 */
export declare function storeBlockedFold(storage: Pick<Storage, 'setItem' | 'removeItem'> | null, rows: BlockedIdentity, folded: boolean): void;
export {};
