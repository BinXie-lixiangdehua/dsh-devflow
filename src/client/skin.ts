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

export type FlowSkin = 'light' | 'gold'

/** Where an explicit user choice is remembered. */
export const FLOW_SKIN_STORAGE_KEY = 'devflow.flow.skin'
/** The attribute the panel publishes on `documentElement`. */
export const FLOW_SKIN_ATTRIBUTE = 'data-devflow-skin'
/** What a first-time visitor sees, and what a cleared storage falls back to. */
export const FLOW_DEFAULT_SKIN: FlowSkin = 'gold'

/** Stable, bounded labels for the toggle (zh-CN first). */
export const FLOW_SKIN_LABELS: Readonly<Record<FlowSkin, { readonly label: string; readonly hint: string }>> = {
  light: { label: '浅色皮肤（iOS 扁平 + 液态玻璃）', hint: '点按切换到暗金皮肤' },
  gold: { label: '暗金皮肤（液态玻璃）', hint: '点按切换到浅色皮肤' },
}

/** The next skin in the two-state cycle. */
export function nextSkin(current: FlowSkin): FlowSkin {
  return current === 'light' ? 'gold' : 'light'
}

/** The remembered choice, or the constant default when nothing is stored. */
export function resolveSkin(stored: FlowSkin | null): FlowSkin {
  return stored ?? FLOW_DEFAULT_SKIN
}

/** Read the remembered choice, or null when the user never made one. */
export function readStoredSkin(storage: Pick<Storage, 'getItem'> | null): FlowSkin | null {
  if (storage === null) return null
  try {
    const value = storage.getItem(FLOW_SKIN_STORAGE_KEY)
    return value === 'light' || value === 'gold' ? value : null
  } catch {
    // A blocked storage (private mode, disabled cookies) must never break the panel.
    return null
  }
}

/** Remember an explicit choice; a failing storage is ignored, not fatal. */
export function storeSkin(storage: Pick<Storage, 'setItem'> | null, skin: FlowSkin): void {
  if (storage === null) return
  try {
    storage.setItem(FLOW_SKIN_STORAGE_KEY, skin)
  } catch {
    // Ignored on purpose: the skin still applies for this session.
  }
}

/** Publish the skin where CSS can read it. */
export function applySkinAttribute(root: Pick<HTMLElement, 'setAttribute'>, skin: FlowSkin): void {
  root.setAttribute(FLOW_SKIN_ATTRIBUTE, skin)
}
