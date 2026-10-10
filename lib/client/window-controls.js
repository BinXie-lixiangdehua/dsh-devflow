/**
 * Platform window-controls geometry for the overview float.
 *
 * Two facts make this a module of its own:
 *
 * 1. A desktop shell paints its own window controls (─ □ ✕) as a **native overlay
 *    above the page**. They are not DOM nodes, so no `z-index` reaches them and a
 *    click that lands on them never reaches the float. The only fix is to keep the
 *    float out of that band.
 * 2. The band only exists in some shells. A browser tab has none, and that is the
 *    shell DevFlow's panel was designed for — so every rule here must reduce to
 *    exactly today's geometry when there is no band.
 *
 * The decision is kept pure (an explicit environment parameter) because it is the
 * difference between "the float is usable" and "the float is under a native
 * button", and it has to be unit-testable without a real Electron window.
 *
 * @module devflow/client/window-controls
 */
/**
 * Gap kept to the right of whatever the float must clear.
 *
 * The column's own toggle button is 28px wide and sits at the frame's right edge
 * while the column is collapsed, so the float has to clear the button PLUS this
 * margin — a bare "column width" offset put the float on top of it at every narrow
 * viewport (measured at 420/600/720px in the first evidence pass). The same margin
 * pads the native window-controls band for the same reason.
 */
export const TOGGLE_CLEARANCE = 44;
/**
 * Width of the Windows caption-button band, used only when the platform reserves a
 * titlebar band but reports no usable rectangle for it.
 *
 * The three buttons (─ □ ✕) are 46 DIP each, so a 100%-scale window reserves
 * 138 CSS pixels. Measured on the dsh desktop 2026-10-10: `getTitlebarAreaRect()`
 * left the page 1143 of 1280 pixels (137), i.e. one pixel inside the DIP
 * arithmetic — which is why the toggle margin above is kept as well.
 */
const WINDOWS_CAPTION_WIDTH = 138;
/** Read the ambient platform facts; a shell without a DOM reserves nothing. */
function platformEnvironment() {
    if (typeof navigator === 'undefined' || typeof window === 'undefined')
        return { width: 0, titlebarHeight: 0 };
    const overlay = navigator.windowControlsOverlay;
    const reserved = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dsh-windows-titlebar-height'));
    return { width: window.innerWidth, overlay, titlebarHeight: Number.isFinite(reserved) ? reserved : 0 };
}
/**
 * How far the float must stay clear of the right edge so it never lands under the
 * shell's own window controls.
 *
 * Two sources, in order, because the platform's own answer is not always there:
 *
 * 1. `windowControlsOverlay.getTitlebarAreaRect()` when the overlay is **visible**
 *    and the rectangle is plausible — the exact band, whatever the scale.
 * 2. Otherwise, a shell that *does* reserve a titlebar band
 *    (`--dsh-windows-titlebar-height` > 0) gets {@link WINDOWS_CAPTION_WIDTH}.
 *    This branch is not theoretical: on the dsh desktop the very same window
 *    answered `visible: true, width: 1143` on one reading and `visible: false,
 *    width: 0` on the next (both recorded 2026-10-10), and a zero reading that
 *    skipped the band would leave the float under ─ □ ✕.
 *
 * A shell with neither — a browser tab — gets 0, which is exactly today's
 * geometry. An impossible rectangle is ignored for the same reason: treating
 * `width: 0` as a full-width band would fling the float to the left edge.
 *
 * @param env - the platform facts; injectable for tests.
 * @returns clearance in CSS pixels, this module's padding included.
 */
export function windowControlsClearance(env = platformEnvironment()) {
    const band = reportedBand(env) ?? (env.titlebarHeight > 0 ? WINDOWS_CAPTION_WIDTH : 0);
    return band <= 0 ? 0 : band + TOGGLE_CLEARANCE;
}
/** The band the platform reports for this frame, or null when it reports none. */
function reportedBand(env) {
    const overlay = env.overlay;
    if (overlay?.visible !== true || typeof overlay.getTitlebarAreaRect !== 'function')
        return null;
    try {
        const rect = overlay.getTitlebarAreaRect();
        const right = rect.x + rect.width;
        if (!(rect.width > 0) || right > env.width)
            return null;
        return Math.max(0, Math.round(env.width - right));
    }
    catch {
        return null;
    }
}
