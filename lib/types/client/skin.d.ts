/**
 * The dispatch-flow panel's two skins.
 *
 * The brief fixes the palette: a flat iOS-like **light** skin and a dark skin with
 * **restrained dark-gold** accents. Both reuse the harness' semantic state colours,
 * only tuned for contrast on their own background — the five dispatch states and
 * the four relation line styles are never re-coloured by the skin.
 *
 * Default: **dark gold** (step 3C). The panel used to follow
 * `prefers-color-scheme`, but the host exposes no readable light/dark marker (three
 * probes: no theme data attribute or class, and its `--dsw-alias-*` tokens are
 * identical under both media preferences), so following the OS could disagree with
 * the host's own appearance. That follow-the-system branch is therefore REMOVED —
 * there is no longer any trigger for it — and the default is a constant; an
 * explicit user choice is still remembered in `localStorage`.
 *
 * The skin is applied as an attribute on `documentElement` so a rule can also reach
 * the plugin's own pane wrapper (which is the canvas' PARENT, and therefore cannot
 * be styled by a descendant selector).
 */
export type FlowSkin = 'light' | 'gold';
/** Where an explicit user choice is remembered. */
export declare const FLOW_SKIN_STORAGE_KEY = "devflow.flow.skin";
/** The attribute the panel publishes on `documentElement`. */
export declare const FLOW_SKIN_ATTRIBUTE = "data-devflow-skin";
/** What a first-time visitor sees, and what a cleared storage falls back to. */
export declare const FLOW_DEFAULT_SKIN: FlowSkin;
/** Stable, bounded labels for the toggle (zh-CN first). */
export declare const FLOW_SKIN_LABELS: Readonly<Record<FlowSkin, {
    readonly label: string;
    readonly hint: string;
}>>;
/** The next skin in the two-state cycle. */
export declare function nextSkin(current: FlowSkin): FlowSkin;
/** The remembered choice, or the constant default when nothing is stored. */
export declare function resolveSkin(stored: FlowSkin | null): FlowSkin;
/** Read the remembered choice, or null when the user never made one. */
export declare function readStoredSkin(storage: Pick<Storage, 'getItem'> | null): FlowSkin | null;
/** Remember an explicit choice; a failing storage is ignored, not fatal. */
export declare function storeSkin(storage: Pick<Storage, 'setItem'> | null, skin: FlowSkin): void;
/** Publish the skin where CSS can read it. */
export declare function applySkinAttribute(root: Pick<HTMLElement, 'setAttribute'>, skin: FlowSkin): void;
