import { describe, expect, it } from 'vitest'
import {
  FLOW_DASH_HEAD,
  FLOW_DASH_PERIOD,
  FLOW_DASH_TAIL,
  FLOW_DONE_SWEEP_MS,
  FLOW_ENTER_HISTORY_START,
  FLOW_ENTER_MS,
  FLOW_FLOW_OPACITY_WEAK,
  FLOW_FLOW_WIDTH,
  FLOW_FLOW_WIDTH_WEAK,
  FLOW_GLOW_GOLD,
  FLOW_GLOW_LIGHT,
  FLOW_GLOW_REWORK_GOLD,
  FLOW_GLOW_REWORK_LIGHT,
  FLOW_LINE_SPEED_BASE,
  changedEdges,
  freshlyDoneEdges,
  motionProfile,
  motionRate,
  newlyEnteredNodes,
  nodeIdSet,
} from '../src/client/motion.ts'
import { DEVFLOW_FLOW_CSS } from '../src/client/flow-css.ts'
import type { FlowEdgeState } from '../src/client/flow-projection.ts'

const FLOWING: readonly FlowEdgeState[] = ['executing', 'rework', 'queued']
const STILL: readonly FlowEdgeState[] = ['done', 'lost']

/**
 * Step 3C's iron rule: **moving = happening, still = finished.** These assertions
 * pin the rule, the speed band the brief fixes (执行中 45–60 px/s, 返工 1.3–1.5×,
 * 排队 0.4–0.6×) and the fact that the animation itself is CSS/SVG only.
 */
describe('dispatch-flow motion profile', () => {
  it('keeps the baseline inside the band the brief fixes', () => {
    expect(FLOW_LINE_SPEED_BASE).toBeGreaterThanOrEqual(45)
    expect(FLOW_LINE_SPEED_BASE).toBeLessThanOrEqual(60)
  })

  it('moves a running dispatch at the baseline speed', () => {
    const profile = motionProfile('executing')
    expect(profile.flowing).toBe(true)
    expect(profile.speed).toBe(FLOW_LINE_SPEED_BASE)
    expect(profile.speed).toBeGreaterThanOrEqual(45)
    expect(profile.speed).toBeLessThanOrEqual(60)
  })

  it('moves a rework edge at 1.3–1.5x the baseline', () => {
    const profile = motionProfile('rework')
    expect(profile.flowing).toBe(true)
    expect(profile.speed / FLOW_LINE_SPEED_BASE).toBeGreaterThanOrEqual(1.3)
    expect(profile.speed / FLOW_LINE_SPEED_BASE).toBeLessThanOrEqual(1.5)
  })

  it('moves a queued edge at 0.4–0.6x the baseline, and weaker', () => {
    const profile = motionProfile('queued')
    expect(profile.flowing).toBe(true)
    const ratio = profile.speed / FLOW_LINE_SPEED_BASE
    expect(ratio).toBeGreaterThanOrEqual(0.4)
    expect(ratio).toBeLessThanOrEqual(0.6)
    expect(profile.opacity).toBeLessThan(motionProfile('executing').opacity)
    expect(profile.opacity).toBeGreaterThanOrEqual(0.4)
    expect(profile.opacity).toBeLessThanOrEqual(0.6)
  })

  it('never moves a finished or unwrapped dispatch', () => {
    for (const state of STILL) {
      const profile = motionProfile(state)
      expect(profile.flowing).toBe(false)
      expect(profile.speed).toBe(0)
      expect(profile.durationSeconds).toBe(0)
      expect(profile.multiplier).toBe(0)
    }
  })

  it('derives the cycle duration from the fixed dash period', () => {
    for (const state of [...FLOWING, ...STILL]) {
      const profile = motionProfile(state)
      if (!profile.flowing) continue
      // duration = period / speed, so the measured px/s equals the declared speed.
      expect(profile.durationSeconds * profile.speed).toBeCloseTo(FLOW_DASH_PERIOD, 1)
      expect(profile.durationSeconds).toBeGreaterThan(0)
    }
  })

  it('is a pure function of the state', () => {
    for (const state of [...FLOWING, ...STILL]) {
      expect(motionProfile(state)).toEqual(motionProfile(state))
    }
  })

  it('names the measured rate for the stylesheet', () => {
    expect(motionRate(motionProfile('executing'))).toBe('base')
    expect(motionRate(motionProfile('rework'))).toBe('strong')
    expect(motionRate(motionProfile('queued'))).toBe('weak')
    expect(motionRate(motionProfile('done'))).toBe('still')
    expect(motionRate(motionProfile('lost'))).toBe('still')
  })
})

describe('one-shot sweep for a dispatch that just finished', () => {
  const edge = (id: string, state: FlowEdgeState) => ({ id, state })

  it('never sweeps an edge that was ALREADY finished when first seen', () => {
    const previous = new Map<string, FlowEdgeState>()
    expect(freshlyDoneEdges(previous, [edge('e1', 'done')])).toEqual([])
    // ...and it still does not sweep on the next refresh.
    expect(freshlyDoneEdges(previous, [edge('e1', 'done')])).toEqual([])
  })

  it('sweeps exactly once, at the transition into finished', () => {
    const previous = new Map<string, FlowEdgeState>()
    expect(freshlyDoneEdges(previous, [edge('e1', 'executing')])).toEqual([])
    expect(freshlyDoneEdges(previous, [edge('e1', 'done')])).toEqual(['e1'])
    expect(freshlyDoneEdges(previous, [edge('e1', 'done')])).toEqual([])
  })

  it('treats any change into finished as the moment it happened', () => {
    for (const before of ['queued', 'executing', 'rework', 'lost'] as const) {
      const previous = new Map<string, FlowEdgeState>([[edge('e1', before).id, before]])
      expect(freshlyDoneEdges(previous, [edge('e1', 'done')])).toEqual(['e1'])
    }
  })

  it('does not sweep a transition that is not into finished', () => {
    const previous = new Map<string, FlowEdgeState>([['e1', 'executing']])
    expect(freshlyDoneEdges(previous, [edge('e1', 'rework')])).toEqual([])
    expect(freshlyDoneEdges(previous, [edge('e1', 'lost')])).toEqual([])
    expect(freshlyDoneEdges(previous, [edge('e1', 'queued')])).toEqual([])
  })

  it('reports every edge that finished in the same refresh', () => {
    const previous = new Map<string, FlowEdgeState>([['e1', 'executing'], ['e2', 'queued'], ['e3', 'done']])
    const fresh = freshlyDoneEdges(previous, [edge('e1', 'done'), edge('e2', 'done'), edge('e3', 'done')])
    expect([...fresh].sort()).toEqual(['e1', 'e2'])
  })

  it('forgets edges that left the model, so their return is a fresh appearance', () => {
    const previous = new Map<string, FlowEdgeState>()
    freshlyDoneEdges(previous, [edge('e1', 'done')])
    expect(previous.has('e1')).toBe(true)
    freshlyDoneEdges(previous, [])
    expect(previous.has('e1')).toBe(false)
  })
})

/**
 * 第七步 任务 2：动效由**真实事件**驱动，而不是由定时器或"元素存在"驱动。
 *
 * 这两个纯函数是本轮"真实驱动 vs 状态驱动"命题的可断言内核：
 *  - `changedEdges` 只在**投影状态真的变了**时报出该边（首见不算"变"）；
 *  - `newlyEnteredNodes` 报出"本次渲染里还没见过的 id"：首帧（历史为空 Set）**全量入场**
 *    （boss 2026-09-18 裁决 A：打开画布 / 刷新 / 切换会话 / 切换皮肤都会全量入场一次），
 *    同一批节点重复渲染则一个都不报。
 * 于是画布不会自我驱动：空闲画布（节点集合不变）永远不再播第二次入场。
 */
describe('real-event drive for the canvas', () => {
  const edge = (id: string, state: FlowEdgeState) => ({ id, state })

  it('re-arms only the edges whose state actually changed', () => {
    const previous = new Map<string, FlowEdgeState>()
    expect(changedEdges(previous, [edge('e1', 'executing')])).toEqual([])
    expect(changedEdges(previous, [edge('e1', 'executing')])).toEqual([])
    expect(changedEdges(previous, [edge('e1', 'done')])).toEqual(['e1'])
    expect(changedEdges(previous, [edge('e1', 'done')])).toEqual([])
  })

  it('never treats a first sighting as a change', () => {
    const previous = new Map<string, FlowEdgeState>()
    // A refresh or a session switch hands us a full set with no history: nothing
    // may animate, because nothing the user was watching actually moved.
    expect(changedEdges(previous, [edge('e1', 'executing'), edge('e2', 'queued')])).toEqual([])
    // An edge seen for the first time in a LATER render is still a first sighting,
    // not a change: it appeared, it did not move. (Its card gets the entrance; its
    // line must not claim a transition that never happened.)
    expect(changedEdges(previous, [edge('e1', 'executing'), edge('e2', 'queued'), edge('e3', 'executing')])).toEqual([])
    // Only a state that differs from what this edge was last seen as is a change.
    expect(changedEdges(previous, [edge('e1', 'done'), edge('e2', 'queued'), edge('e3', 'executing')])).toEqual(['e1'])
  })

  it('reports every edge that moved in one refresh, and forgets the ones that left', () => {
    const previous = new Map<string, FlowEdgeState>([['e1', 'queued'], ['e2', 'executing'], ['e3', 'done']])
    expect([...changedEdges(previous, [edge('e1', 'executing'), edge('e2', 'executing'), edge('e3', 'done')])]).toEqual(['e1'])
    expect(previous.has('e3')).toBe(true)
    changedEdges(previous, [])
    expect(previous.has('e3')).toBe(false)
  })

  it('marks every node of the first frame with the entrance (boss 裁决 A：首帧也入场)', () => {
    // 入场历史的起点是**空 Set**（不是 null）：首帧没有任何 id 被见过 ⇒ 每个节点各走一次。
    // 这正是"打开画布 / 刷新 / 切换会话 / 切换皮肤都会全量入场一次"的可断言边界。
    expect(FLOW_ENTER_HISTORY_START.size).toBe(0)
    const first = [{ id: 'n1' }, { id: 'n2' }, { id: 'n3' }]
    expect(newlyEnteredNodes(FLOW_ENTER_HISTORY_START, first)).toEqual(['n1', 'n2', 'n3'])
    // 空节点集合仍然是空的（画布还没有卡时不播，也不抛）。
    expect(newlyEnteredNodes(FLOW_ENTER_HISTORY_START, [])).toEqual([])
    // 入场时长是首帧那一次全量入场要付的代价，仍受 ≤600ms 约束。
    expect(FLOW_ENTER_MS).toBeGreaterThan(0)
    expect(FLOW_ENTER_MS).toBeLessThanOrEqual(600)
  })

  it('plays the card entrance for every node the view has not seen yet', () => {
    // 先声明裁决后的新边界：**空历史 = 全量入场**（旧语义"空历史 ⇒ 不播"已按新边界改写，
    // 断言未删，只换期望值），刷新、切会话、切皮肤、首帧都落在这条上。
    expect(newlyEnteredNodes(FLOW_ENTER_HISTORY_START, [{ id: 'n1' }, { id: 'n2' }])).toEqual(['n1', 'n2'])
    // 同一批节点再渲染一次：一个都不报（空闲画布不会自我驱动）。
    const seen = nodeIdSet([{ id: 'n1' }, { id: 'n2' }])
    expect(newlyEnteredNodes(seen, [{ id: 'n1' }, { id: 'n2' }])).toEqual([])
    // 这次视图里**新增**的节点仍然只报它自己（原来的语义原样保留）。
    expect(newlyEnteredNodes(seen, [{ id: 'n1' }, { id: 'n2' }, { id: 'n3' }])).toEqual(['n3'])
  })

  it('keeps the entrance selector inside the reduced-motion kill switch', () => {
    // The entrance rides `.devflow-flow-card`, which the existing rule already turns
    // off wholesale — this asserts the two stay coupled instead of assuming it. The
    // block is located by its own content: the stylesheet has more than one
    // reduced-motion query (the glass fallback has one too).
    const marker = '@media (prefers-reduced-motion:reduce){\n  .devflow-flow-edge,.devflow-flow-card,.devflow-flow-card::after{animation:none!important}'
    expect(DEVFLOW_FLOW_CSS).toContain(marker)
    expect(DEVFLOW_FLOW_CSS).toContain('.devflow-flow-card[data-enter=true]{animation:devflow-flow-enter')
  })

  it('keeps the entrance short and non-displacing, and off unless data-enter is true', () => {
    expect(FLOW_ENTER_MS).toBeLessThanOrEqual(600)
    expect(DEVFLOW_FLOW_CSS).toContain(`devflow-flow-enter ${(FLOW_ENTER_MS / 1000).toFixed(3)}s ease-out 1 both`)
    // It must not touch geometry: opacity + a scale that cannot push a neighbour.
    const rule = DEVFLOW_FLOW_CSS.slice(DEVFLOW_FLOW_CSS.indexOf('@keyframes devflow-flow-enter'))
    const body = rule.slice(0, rule.indexOf('}') + 1)
    expect(body).not.toContain('translate')
    expect(body).not.toContain('rotate')
    expect(body).not.toContain('scale(1.0')
  })
})

describe('motion stylesheet', () => {
  it('carries the dash period and the sweep duration from motion.ts', () => {
    expect(DEVFLOW_FLOW_CSS).toContain('stroke-dashoffset:-' + String(FLOW_DASH_PERIOD))
    expect(DEVFLOW_FLOW_CSS).toContain(`${(FLOW_DONE_SWEEP_MS / 1000).toFixed(2)}s ease-out 1 both`)
  })

  it('hides the moving layer for every still state instead of removing it', () => {
    // §一·前.2 widened the still set: a PAUSED dispatch is not happening either, so it
    // hides its motion layer exactly like a finished or lost one.
    expect(DEVFLOW_FLOW_CSS).toContain('g[data-flow-rate=still] .devflow-flow-flow,g[data-flow-rate=paused] .devflow-flow-flow{visibility:hidden;animation:none}')
    expect(DEVFLOW_FLOW_CSS).toContain('g[data-fresh=true] .devflow-flow-sweep')
  })

  it('lifts the moving highlight without touching the period or the speed formula', () => {
    // §一·前.1: 12px ⇒ 32px, thicker stroke, full opacity, brighter same-hue colour per skin.
    expect(DEVFLOW_FLOW_CSS).toContain(`stroke-dasharray:${FLOW_DASH_HEAD} ${FLOW_DASH_TAIL}`)
    expect(FLOW_DASH_HEAD).toBe(32)
    expect(FLOW_DASH_HEAD + FLOW_DASH_TAIL).toBe(FLOW_DASH_PERIOD)
    expect(DEVFLOW_FLOW_CSS).toContain(`stroke-width:${FLOW_FLOW_WIDTH}`)
    expect(FLOW_FLOW_WIDTH).toBeGreaterThan(2.6)
    // Both skins carry an explicit bright head colour, and they differ (a light
    // background needs a deeper cyan than a dark one to stay visible).
    expect(DEVFLOW_FLOW_CSS).toContain(`--flow-glow:${FLOW_GLOW_GOLD}`)
    expect(DEVFLOW_FLOW_CSS).toContain(`--flow-glow:${FLOW_GLOW_LIGHT}`)
    expect(FLOW_GLOW_LIGHT).not.toBe(FLOW_GLOW_GOLD)
    expect(DEVFLOW_FLOW_CSS).toContain(`--flow-glow-rework:${FLOW_GLOW_REWORK_GOLD}`)
    expect(DEVFLOW_FLOW_CSS).toContain(`--flow-glow-rework:${FLOW_GLOW_REWORK_LIGHT}`)
  })

  it('keeps the hierarchy: queued stays the weakest highlight', () => {
    // The base rule carries the full-opacity moving head...
    expect(DEVFLOW_FLOW_CSS).toContain('stroke-dasharray:' + String(FLOW_DASH_HEAD) + ' ' + String(FLOW_DASH_TAIL) + ';opacity:1')
    // ...and only the queued rate dims and thins it.
    expect(DEVFLOW_FLOW_CSS).toContain(`stroke-width:${FLOW_FLOW_WIDTH_WEAK};opacity:${FLOW_FLOW_OPACITY_WEAK}`)
    expect(FLOW_FLOW_WIDTH_WEAK).toBeLessThan(FLOW_FLOW_WIDTH)
    expect(FLOW_FLOW_OPACITY_WEAK).toBeLessThan(1)
    expect(motionProfile('queued').opacity).toBeLessThan(motionProfile('executing').opacity)
  })

  it('freezes every in-flight state under the shared pause, and only those', () => {
    for (const state of ['executing', 'rework', 'queued'] as const) {
      const paused = motionProfile(state, true)
      expect(paused.flowing).toBe(false)
      expect(paused.speed).toBe(0)
      expect(paused.paused).toBe(true)
      expect(motionRate(paused)).toBe('paused')
      // ...and it comes back exactly as it was once the pause is lifted.
      expect(motionProfile(state, false)).toEqual(motionProfile(state))
    }
    // A finished or lost dispatch keeps its own posture: the pause changes nothing.
    expect(motionProfile('done', true)).toEqual(motionProfile('done'))
    expect(motionProfile('lost', true)).toEqual(motionProfile('lost'))
  })

  it('pauses the motion while an edge is highlighted or selected', () => {
    expect(DEVFLOW_FLOW_CSS).toContain('g[data-highlight=true] .devflow-flow-flow,.devflow-flow-edge[data-selected=true]~.devflow-flow-flow{animation-play-state:paused')
  })

  it('turns every animation off under prefers-reduced-motion', () => {
    const block = DEVFLOW_FLOW_CSS.slice(DEVFLOW_FLOW_CSS.indexOf('@media (prefers-reduced-motion:reduce)'))
    expect(block).toContain('.devflow-flow-edge,.devflow-flow-card,.devflow-flow-card::after{animation:none!important}')
    expect(block).toContain('.devflow-flow-flow,.devflow-flow-sweep{animation:none!important;visibility:hidden!important}')
  })

  it('animates only cards that are actually happening', () => {
    expect(DEVFLOW_FLOW_CSS).toContain('.devflow-flow-card[data-state=active]::after')
    expect(DEVFLOW_FLOW_CSS).toContain('.devflow-flow-card[data-state=rework]::after')
    expect(DEVFLOW_FLOW_CSS).not.toContain('.devflow-flow-card[data-state=done]::after')
    expect(DEVFLOW_FLOW_CSS).not.toContain('.devflow-flow-card[data-state=lost]::after')
    // Queued cards advertise waiting with a STATIC dashed border, not with motion.
    expect(DEVFLOW_FLOW_CSS).toContain('.devflow-flow-card[data-state=planned]:not([data-kind=requirement]){border-style:dashed;border-color:var(--flow-line-soft)}')
  })
})
