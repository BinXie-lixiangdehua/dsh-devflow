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
export declare const TOGGLE_CLEARANCE = 44;
/** The shell's native window-controls overlay, as the platform exposes it. */
export interface WindowControlsOverlay {
    readonly visible?: boolean;
    readonly getTitlebarAreaRect?: () => {
        readonly x: number;
        readonly y: number;
        readonly width: number;
        readonly height: number;
    };
}
/** What the decision needs from the platform. */
export interface WindowControlsEnvironment {
    /** Viewport width in CSS pixels. */
    readonly width: number;
    /** The overlay handle, or undefined when the shell has none (a browser tab). */
    readonly overlay?: WindowControlsOverlay | undefined;
    /** The shell's reserved titlebar height in CSS pixels; 0 when it reserves none. */
    readonly titlebarHeight: number;
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
export declare function windowControlsClearance(env?: WindowControlsEnvironment): number;
