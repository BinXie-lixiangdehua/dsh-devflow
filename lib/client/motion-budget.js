/**
 * §11.1 — the glass × motion performance fallback.
 *
 * Measured in step 3C on this machine's SOFTWARE rasteriser (no GPU acceleration):
 * a `backdrop-filter` glass layer over a CANVAS THAT IS BEING REPAINTED costs about
 * 6fps, because the compositor re-samples the moving background for every frame;
 * switching off either the animation or the glass returns it to 60fps.
 *
 * The policy here is deliberately the simple, verifiable one from the round brief —
 * *degrade while the animation is running* — with a second, adaptive guard for the
 * case the animation itself is what is slow:
 *
 *  - **动画期间降级**: while a flow layer is actually animating (`data-flow-rate` is
 *    `base`/`strong`/`weak` and its computed `animation-name` is not `none`), the
 *    glass overlays fall back to the solid path the B round already shipped. It is
 *    restored {@link MOTION_QUIET_MS} after the last animated frame, so a paused or
 *    finished canvas is always seen in its accepted glass skin.
 *  - **自适应长帧兜底**: if the CANVAS still averages above
 *    {@link LONG_FRAME_MS} per frame for {@link LONG_FRAME_STREAK} consecutive
 *    samples while idle, degradation is held until the average recovers below
 *    {@link RECOVER_MS} for the same streak. This is the machine-level guard the
 *    round asked for: a window too slow to run the panel at all must not be handed
 *    the expensive path.
 *
 * Both are pure switches of background + blur: no layout, no colour semantics and
 * no animation is ever changed, and `prefers-reduced-motion` is untouched.
 *
 * The value is published on the canvas root as `data-glass-budget` (`degrade` /
 * `auto`) plus `data-motion` (`idle` / `active` / `degraded`), so the browser
 * evidence can assert the exact window each rule fired in.
 */
/** Frame budget a canvas still has to beat while idle before degradation is held. */
export const LONG_FRAME_MS = 20;
/** Consecutive samples that must all miss the budget before the adaptive rule fires. */
export const LONG_FRAME_STREAK = 6;
/** Average frame time at which the adaptive rule releases again. */
export const RECOVER_MS = 17;
/** Sampling cadence of the adaptive guard; frame times are averaged within a sample. */
export const SAMPLE_MS = 250;
/** Grace period after the last animated frame before the glass skin is restored. */
export const MOTION_QUIET_MS = 1200;
/**
 * Read the `?devflow-glass=` override.
 * @param search - the document's query string.
 * @returns `degrade` for `solid`/`degrade`, `glass` for `glass`, otherwise `auto`.
 */
export function readGlassOverride(search) {
    const value = new URLSearchParams(search).get('devflow-glass');
    if (value === 'solid' || value === 'degrade')
        return 'degrade';
    if (value === 'glass' || value === 'off')
        return 'glass';
    return 'auto';
}
/** Pure holder of the two guards; the caller owns sampling and the DOM write. */
export class MotionBudget {
    slow = false;
    fast = 0;
    long = 0;
    /**
     * Fold one sample into the posture.
     * @param sample - whether motion is running and how long frames took.
     * @returns the posture to publish.
     */
    sample(sample) {
        if (Number.isFinite(sample.meanFrameMs)) {
            if (sample.meanFrameMs > LONG_FRAME_MS) {
                this.long++;
                this.fast = 0;
            }
            else if (sample.meanFrameMs < RECOVER_MS) {
                this.fast++;
                this.long = 0;
            }
            else {
                this.long = 0;
                this.fast = 0;
            }
            // The streak counters only ever release their own flag, and the release needs
            // its FULL streak of healthy samples — a single fast sample proves nothing.
            if (this.long >= LONG_FRAME_STREAK)
                this.slow = true;
            else if (this.fast >= LONG_FRAME_STREAK)
                this.slow = false;
        }
        const budget = sample.animating || this.slow ? 'degrade' : 'auto';
        const motion = this.slow ? 'degraded' : sample.animating ? 'active' : 'idle';
        return { budget, motion, slow: this.slow };
    }
}
/** Mean of a frame-gap list; `null` when nothing was sampled. */
export function meanFrameMs(gaps) {
    if (gaps.length === 0)
        return null;
    let total = 0;
    for (const gap of gaps)
        total += gap;
    return total / gaps.length;
}
