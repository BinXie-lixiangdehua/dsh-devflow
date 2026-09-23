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
/** One remembered fold flag. */
function readFlag(storage, key) {
    if (storage === null)
        return false;
    try {
        return storage.getItem(key) === '1';
    }
    catch {
        return false;
    }
}
/** Write or remove one remembered fold flag; a failing storage is ignored, not fatal. */
function writeFlag(storage, key, folded) {
    if (storage === null)
        return;
    try {
        if (folded)
            storage.setItem(key, '1');
        else
            storage.removeItem(key);
    }
    catch { /* ignored: the banner still folds for this session */ }
}
/** `localStorage` access that never throws (private mode, disabled storage). */
export function safeStorage() {
    try {
        return typeof window === 'undefined' ? null : window.localStorage;
    }
    catch {
        return null;
    }
}
/**
 * Storage key for ONE refusal. The moment is part of the key on purpose: a later refusal
 * with the same code is a different event and must open expanded again.
 *
 * The flag means "the user explicitly EXPANDED this banner": a recovered refusal starts
 * folded (it is history, and a two-line notice above the canvas is what the live feedback
 * complained about), so folding again is the default rather than a remembered choice.
 */
export function activationFoldKey(failure) {
    return `devflow.activation-expanded.${failure.code}@${failure.at}`;
}
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
export function activationBannerMode(failure, activation, storage) {
    if (failure === null)
        return { collapsible: false, folded: false };
    const collapsible = activation === 'bound';
    if (!collapsible)
        return { collapsible, folded: false };
    return { collapsible, folded: !readFlag(storage, activationFoldKey(failure)) };
}
/**
 * Remember the fold, or forget it when the user reopens the banner.
 *
 * A storage that refuses the write is ignored, not fatal: the fold still applies for the
 * rest of the session through component state.
 * @param storage - storage to write, or null when unavailable.
 * @param failure - the refusal being folded or reopened.
 * @param folded - true to remember the fold, false to forget it.
 */
export function storeActivationFold(storage, failure, folded) {
    // Only the explicit EXPANSION is worth remembering; folding again is the default.
    writeFlag(storage, activationFoldKey(failure), !folded);
}
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
export function blockedExpandKey(rows) {
    const digest = rows.map(row => `${row.id}@${row.at}`).join('|');
    let hash = 5381;
    for (let index = 0; index < digest.length; index += 1)
        hash = ((hash << 5) + hash + digest.charCodeAt(index)) >>> 0;
    return `devflow.blocked-expanded.${rows.length}.${hash.toString(36)}`;
}
/**
 * Whether the 受阻 banner starts folded for this exact set of reports.
 * @param rows - the blocked reports the snapshot carries.
 * @param storage - storage to read the remembered expansion from, or null when unavailable.
 * @returns true unless the user explicitly expanded THIS set.
 */
export function blockedBannerFolded(rows, storage) {
    if (rows.length === 0)
        return false;
    return !readFlag(storage, blockedExpandKey(rows));
}
/**
 * Remember the 受阻 expansion, or forget it when the user folds the banner again.
 * @param storage - storage to write, or null when unavailable.
 * @param rows - the blocked reports the banner is showing.
 * @param folded - true to forget the expansion, false to remember it.
 */
export function storeBlockedFold(storage, rows, folded) {
    if (rows.length === 0)
        return;
    // Only the explicit EXPANSION is worth remembering; folding again is the default.
    writeFlag(storage, blockedExpandKey(rows), !folded);
}
