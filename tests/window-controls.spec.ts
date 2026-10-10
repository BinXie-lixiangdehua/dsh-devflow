import { describe, expect, it } from 'vitest'
import { TOGGLE_CLEARANCE, windowControlsClearance } from '../src/client/window-controls.ts'

/**
 * The overview float must clear the shell's own window controls, and must not move
 * at all in a shell that has none.
 *
 * Both readings used here come from the dsh desktop on 2026-10-10: the platform
 * answered `visible: true, width: 1143` (of 1280) on one call and
 * `visible: false, width: 0` on the next, from the same window. The second one is
 * why "the platform said nothing" may not mean "there is no band".
 */
describe('window-controls clearance', () => {
  const band = (width: number) => ({ x: 0, y: 0, width, height: 40 })

  it('adds nothing in a shell that reserves no titlebar band', () => {
    expect(windowControlsClearance({ width: 1280, titlebarHeight: 0 })).toBe(0)
    expect(windowControlsClearance({ width: 1280, titlebarHeight: 0, overlay: { visible: false, getTitlebarAreaRect: () => band(1143) } })).toBe(0)
    expect(windowControlsClearance({ width: 1280, titlebarHeight: 0, overlay: { visible: true } })).toBe(0)
    expect(windowControlsClearance({ width: 0, titlebarHeight: 0 })).toBe(0)
    expect(windowControlsClearance({ width: 1280, titlebarHeight: Number.NaN })).toBe(0)
  })

  it('prefers the band the platform measures when it reports a usable one', () => {
    const clearance = windowControlsClearance({
      width: 1280,
      titlebarHeight: 40,
      overlay: { visible: true, getTitlebarAreaRect: () => band(1143) },
    })
    expect(clearance).toBe(1280 - 1143 + TOGGLE_CLEARANCE)
    // The float's right edge lands left of the band, which is the whole point.
    expect(1280 - clearance).toBeLessThan(1143)
  })

  it('still clears the caption buttons when a titlebar is reserved but no rectangle is reported', () => {
    const overlays = [
      undefined,
      { visible: false, getTitlebarAreaRect: () => band(1143) },
      { visible: true, getTitlebarAreaRect: () => band(0) },
    ] as const
    for (const overlay of overlays) {
      const clearance = windowControlsClearance({ width: 1280, titlebarHeight: 40, overlay })
      expect(clearance).toBe(138 + TOGGLE_CLEARANCE)
      expect(1280 - clearance).toBeLessThan(1143)
    }
  })

  it('ignores an impossible rectangle instead of flinging the float to the left edge', () => {
    // A rectangle that reaches past the viewport cannot describe a band; with a
    // reserved titlebar the fallback still protects the buttons, and without one
    // the float must not move at all.
    expect(windowControlsClearance({
      width: 1280,
      titlebarHeight: 40,
      overlay: { visible: true, getTitlebarAreaRect: () => ({ x: 900, y: 0, width: 400, height: 40 }) },
    })).toBe(138 + TOGGLE_CLEARANCE)
    expect(windowControlsClearance({
      width: 1280,
      titlebarHeight: 0,
      overlay: { visible: true, getTitlebarAreaRect: () => { throw new Error('no rectangle this frame') } },
    })).toBe(0)
  })
})
