import { describe, expect, it, vi } from 'vitest'
import {
  FLOW_DEFAULT_SKIN,
  FLOW_SKIN_ATTRIBUTE,
  FLOW_SKIN_LABELS,
  FLOW_SKIN_STORAGE_KEY,
  applySkinAttribute,
  nextSkin,
  readStoredSkin,
  resolveSkin,
  storeSkin,
  type FlowSkin,
} from '../src/client/skin.ts'

/**
 * The skin's defaults and persistence, kept pure so they can be asserted without a
 * browser: an explicit choice wins and is remembered; with nothing stored the panel
 * uses the constant dark-gold default (step 3C dropped the follow-the-system branch,
 * because the host exposes no readable light/dark marker).
 */
describe('dispatch-flow skin', () => {
  it('cycles between exactly two skins', () => {
    expect(nextSkin('light')).toBe('gold')
    expect(nextSkin('gold')).toBe('light')
  })

  it('defaults to dark gold regardless of any system preference', () => {
    expect(FLOW_DEFAULT_SKIN).toBe('gold')
    // A cleared storage is the acceptance case of step 3C: gold, every time.
    expect(resolveSkin(null)).toBe('gold')
    expect(resolveSkin('gold')).toBe('gold')
  })

  it('lets an explicit choice beat the default', () => {
    expect(resolveSkin('light')).toBe('light')
    expect(nextSkin(resolveSkin('light'))).toBe('gold')
  })

  it('reads only a remembered, valid choice', () => {
    const storage = (value: string | null) => ({ getItem: vi.fn(() => value) })
    expect(readStoredSkin(storage('light'))).toBe('light')
    expect(readStoredSkin(storage('gold'))).toBe('gold')
    expect(readStoredSkin(storage('sepia'))).toBeNull()
    expect(readStoredSkin(storage(null))).toBeNull()
    expect(readStoredSkin(null)).toBeNull()
  })

  it('never throws when the storage is blocked', () => {
    const hostile = {
      getItem: vi.fn(() => { throw new Error('blocked') }),
      setItem: vi.fn(() => { throw new Error('blocked') }),
    }
    expect(readStoredSkin(hostile)).toBeNull()
    expect(() => { storeSkin(hostile, 'light') }).not.toThrow()
  })

  it('writes the chosen skin under the stable key', () => {
    const setItem = vi.fn()
    storeSkin({ setItem }, 'gold')
    expect(setItem).toHaveBeenCalledWith(FLOW_SKIN_STORAGE_KEY, 'gold')
  })

  it('publishes the skin as an attribute for CSS', () => {
    const setAttribute = vi.fn()
    applySkinAttribute({ setAttribute }, 'light')
    expect(setAttribute).toHaveBeenCalledWith(FLOW_SKIN_ATTRIBUTE, 'light')
  })

  it('labels both skins in Chinese-first copy', () => {
    const skins: readonly FlowSkin[] = ['light', 'gold']
    for (const skin of skins) {
      expect(FLOW_SKIN_LABELS[skin].label).toMatch(/[\u4e00-\u9fa5]/)
      expect(FLOW_SKIN_LABELS[skin].hint).toMatch(/[\u4e00-\u9fa5]/)
    }
  })
})
