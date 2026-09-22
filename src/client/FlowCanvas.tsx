/**
 * Canvas body of the right column's third tab ("派发流").
 *
 * Interaction model (design §2/§11, correction round):
 *   * pan, wheel + button zoom, fit, node drag, edge inspection;
 *   * cards carry a SUMMARY only — the full node record lives in the canvas'
 *     right-hand inspector, so clicking a card never changes its height and never
 *     squeezes the routing;
 *   * one inspector serves all three selections: a node, a dispatch edge
 *     (交接详情) and a 阶段关联带 (阶段关联);
 *   * the inspector is docked beside the canvas when the pane is wide enough and
 *     becomes an overlay drawer at the narrow end, so the canvas is never crushed.
 *
 * Layout and view stay decoupled from data:
 *   * a data refresh only re-projects the model and re-draws the edges;
 *   * node positions the user moved are "user placed" and a refresh never re-lays
 *     them out — only the explicit 重置布局 action returns to auto layout;
 *   * the viewport transform is recomputed only by 适配视图, a real resize of the
 *     canvas box, a scope switch, or the first fit after the cards were measured —
 *     never by a text-only refresh;
 *   * once the operator pans, zooms or drags, automatic fitting stops.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CONNECTION_LOST_DETAIL, type DevFlowConnectionState, type DevFlowClientLoadState, type DevFlowInspectorTab } from './store.ts'
import {
  FLOW_NODE_WIDTH,
  FLOW_SEMANTIC_LABELS,
  createFlowModel,
  layoutEdges,
  type FlowBand,
  type FlowEdge,
  type FlowEdgeSemantic,
  type FlowEdgeState,
  type FlowModel,
  type FlowNode,
  type FlowNodeState,
} from './flow-projection.ts'
import { flowAgentName, shortId, workspaceBasename, type WorkspaceModel } from './workspace.ts'
import {
  FLOW_SKIN_LABELS,
  applySkinAttribute,
  readStoredSkin,
  resolveSkin,
  nextSkin,
  storeSkin,
  type FlowSkin,
} from './skin.ts'
import { FLOW_DONE_SWEEP_MS, FLOW_ENTER_HISTORY_START, FLOW_ENTER_MS, changedEdges, freshlyDoneEdges, motionProfile, motionRate, newlyEnteredNodes, nodeIdSet } from './motion.ts'
import {
  MOTION_QUIET_MS,
  MotionBudget,
  SAMPLE_MS,
  meanFrameMs,
  readGlassOverride,
} from './motion-budget.ts'
import { applyPausePresentation } from './pause-presentation.ts'
import { OVERVIEW_REOPEN_EVENT } from './overview.ts'

interface FlowCanvasProps {
  readonly model: WorkspaceModel
  readonly phase: DevFlowClientLoadState['phase']
  readonly tab: DevFlowInspectorTab
  readonly onTabChange: (tab: DevFlowInspectorTab) => void
  readonly auditPanel: React.ReactNode
  readonly toolsPanel: React.ReactNode
  /** Clock used for the stale-dispatch judgement; injectable for tests. */
  readonly now?: number
  /**
   * Posture of the session's live event channel, read by the panel's owner and
   * passed down as plain data (the canvas never subscribes itself). `null` means
   * the channel is not part of this client build.
   */
  readonly connection?: DevFlowConnectionState | null
  /**
   * Session-level notice (e.g. the shared project changed). It is rendered in the
   * canvas' own notice line — never as a bar across the drawing area.
   */
  readonly notice?: string | null
  /**
   * §二·3: reopen the top-right overview float from the panel's own header. The
   * panel is the documented way back in after the float was explicitly closed.
   */
  readonly onReopenOverview?: () => void
}

/** One task picked in the 阶段关联 list, or a whole phase, highlighted on the canvas. */
type FlowHighlight =
  | { readonly kind: 'task'; readonly id: string }
  | { readonly kind: 'phase'; readonly id: string }
  | null

/** What the canvas' right-hand inspector is currently showing. */
type FlowSelection =
  | { readonly kind: 'node'; readonly id: string }
  | { readonly kind: 'edge'; readonly id: string }
  | { readonly kind: 'phase'; readonly id: string }

const NODE_HEIGHT = 118
/**
 * Zoom floor. The round brief fixes the range at 0.4×–1.8×, and with the phase
 * rail gone (correction R2) the canvas is narrow enough that 0.4 still fits the
 * whole chain at the 420px column.
 */
const MIN_SCALE = 0.4
const MAX_SCALE = 1.8
const FIT_PADDING = 16
/** Vertical space the floating overlays occupy at the top / bottom of the canvas. */
const FIT_TOP_RESERVE = 96
const FIT_BOTTOM_RESERVE = 150
/** Least amount of the world that must stay inside the viewport while panning. */
const MIN_VISIBLE = 96
const RESIZE_EPSILON = 12
/** Above this many edges, per-edge badges would cover the lanes; only these stay. */
const EDGE_LABEL_LIMIT = 12
/** A single row wider than this is a data-density problem, and the panel says so. */
const WIDE_ROW_LIMIT = 6
/**
 * Below this canvas width the inspector floats over the canvas instead of docking
 * (see the R2 measurement in the round report), so the drawing is never crushed.
 */
const INSPECTOR_DOCK_MIN = 680
const VIEW_LABELS: Readonly<Record<DevFlowInspectorTab, string>> = {
  flow: '派发流', audit: '审计', tools: '本会话',
}
/**
 * The five states the LEGEND lists, in the order the round's design fixes them. The
 * 收尾终态 (closed) is deliberately a sixth, separate presentation: it is not one of the
 * five dispatch states, it is the statement that a dispatch was wrapped up. It is
 * therefore named by the badges/edges themselves and by the overview's own count, and
 * the five-state legend is left exactly as the previous rounds shipped it.
 */
const EDGE_STATES: readonly FlowEdgeState[] = ['queued', 'executing', 'done', 'rework', 'lost']
const EDGE_STATE_TEXT: Readonly<Record<FlowEdgeState, string>> = {
  queued: '排队/已接收', executing: '执行中', done: '已完成', rework: '返工', lost: '未收尾/失联', paused: '已暂停', closed: '已收尾',
}
const SEMANTIC_ORDER: readonly FlowEdgeSemantic[] = ['requirement', 'dispatch', 'delivery', 'rework', 'subagent']
const NODE_STATE_CLASS: Readonly<Record<FlowNodeState, string>> = {
  idle: '', active: 'run', blocked: 'wait', done: 'done', rework: 'bad', planned: 'queue', lost: 'lost', paused: 'paused', closed: 'closed',
}
/** What the canvas shows per relation, in words, next to the line sample. */
const SEMANTIC_SHAPE: Readonly<Record<FlowEdgeSemantic, string>> = {
  requirement: '点线 · 指向总指挥',
  dispatch: '实线 · 指向员工',
  delivery: '点划线 · 指回总指挥',
  rework: '长虚线 · 指向原员工',
  subagent: '点线 · 双向',
}

interface Transform { readonly scale: number; readonly x: number; readonly y: number }
type Positions = Readonly<Record<string, { readonly x: number; readonly y: number }>>

/** Render the dispatch-flow canvas plus its overlays, inspector and the secondary views. */
export function FlowCanvas(props: FlowCanvasProps) {
  const { model, phase, tab, onTabChange, auditPanel, toolsPanel, now, connection: channel, notice, onReopenOverview } = props
  const [heights, setHeights] = useState<Readonly<Record<string, number>>>({})
  const [showHistory, setShowHistory] = useState(false)
  const [legendOpen, setLegendOpen] = useState(false)
  const scope = showHistory ? 'history' as const : 'current' as const
  /**
   * §一·前.2: the pause posture is part of what the canvas SHOWS, so it is folded
   * into the same model the cards and the inspector read — one source of truth, no
   * second reading of the flag anywhere in the view.
   */
  const paused = model.snapshot.paused
  const flow = useMemo(
    () => applyPausePresentation(createFlowModel(model, now, heights, scope), paused),
    [model, now, heights, scope, paused],
  )
  // The channel posture drives the polling fallback notice and the status line.
  const connection = channel ?? null
  const viewportRef = useRef<HTMLDivElement | null>(null)
  /**
   * The viewport element itself, as state, so the ResizeObserver is re-attached
   * when the dock re-creates the pane (which it does when the right column
   * switches layout at narrow widths). Watching a detached node meant a resize
   * never re-fitted the canvas below ~1180px.
   */
  const [viewportHost, setViewportHost] = useState<HTMLDivElement | null>(null)
  const bindViewport = useCallback((element: HTMLDivElement | null) => {
    viewportRef.current = element
    setViewportHost(element)
  }, [])
  /** Canvas host width, used to decide dock vs overlay drawer for the inspector. */
  const [hostWidth, setHostWidth] = useState(0)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const boxRefs = useRef(new Map<string, HTMLDivElement>())
  const sizeRef = useRef({ w: 0, h: 0 })
  /** Set as soon as the operator pans, zooms or drags; stops automatic fitting. */
  const viewTouchedRef = useRef(false)
  const [transform, setTransform] = useState<Transform>({ scale: 0.75, x: 12, y: 12 })
  const [positions, setPositions] = useState<Positions>(() => seedPositions(flow))
  const [pinned, setPinned] = useState<readonly string[]>([])
  const [selection, setSelection] = useState<FlowSelection | null>(null)
  /** What the 阶段关联 list currently highlights on the canvas. */
  const [highlight, setHighlight] = useState<FlowHighlight>(null)
  const [rosterOpen, setRosterOpen] = useState(false)
  const [rosterCards, setRosterCards] = useState<readonly string[]>([])
  const [panning, setPanning] = useState(false)
  /**
   * Skin: the default is the dark-gold skin (step 3C); an explicit choice wins and
   * is remembered. The old "follow the system" branch is gone on purpose (see
   * `skin.ts` for the measured reason).
   */
  const [skin, setSkin] = useState<FlowSkin>(() => resolveSkin(readStoredSkin(safeStorage())))
  /** The canvas root, where the §11.1 glass budget posture is published for CSS. */
  const rootRef = useRef<HTMLDivElement | null>(null)
  /**
   * Edges that JUST became 已完成, which may play the single pass-through sweep.
   * The map is a ref so a data refresh never rebuilds the animation elements.
   */
  const previousStatesRef = useRef(new Map<string, FlowEdge['state']>())
  /**
   * A SECOND history for the flowing re-arm, deliberately not shared with the sweep
   * above: both walk "previous vs current" and both mutate their map, so one shared
   * map would make whichever effect ran second compare against states the first had
   * already overwritten — the re-arm would then never see a change at all.
   */
  const changedStatesRef = useRef(new Map<string, FlowEdge['state']>())
  const [freshDone, setFreshDone] = useState<readonly string[]>([])
  /**
   * Edges a REAL state change moved in the last render. The flowing layer is
   * re-armed only for these, so animation phase is anchored to committed events
   * rather than to the render loop: an idle canvas re-arms nothing at all.
   */
  const [rearmedEdges, setRearmedEdges] = useState<readonly string[]>([])
  /**
   * Bumped once per re-arm so the re-armed element's key actually changes. The
   * epoch is what makes a REPEATED change to the same edge restart its animation; a
   * key derived from the edge id alone would keep the element across renders and
   * leave the flow running from wherever it happened to be.
   */
  const [rearmEpoch, setRearmEpoch] = useState(0)
  const nodes = useMemo(
    () => flow.nodes.map(node => ({ ...node, ...(positions[node.id] ?? { x: node.x, y: node.y }) })),
    [flow, positions],
  )
  /**
   * Node ids 的历史，以及此刻正在播入场的 id 集合。
   *
   * 初值是**空 Set**（{@link FLOW_ENTER_HISTORY_START}），不是 `null`：这是 boss
   * 2026-09-18 裁决的产品口径 A —— **首帧也入场**（当帧每个节点各走一次
   * {@link FLOW_ENTER_MS} 的入场动效）。触发范围**只有节点集合的变化**：
   * **打开画布 / 刷新**（都是重新挂载 ⇒ 当帧全部节点入场），以及**切换会话**后本视图
   * **没见过的 id**（新会话带来的新节点逐个入场；若新会话的节点集合与旧的完全相同，
   * 则一个也不入场）。**切换皮肤不在这个范围里**：`toggleSkin` 只改 `skin` state 与
   * documentElement 上的 `data-skin`（颜色/CSS 变量），`nodes` 的引用不变 ⇒ 入场 effect
   * 的依赖（`[nodes]`）没变、不会重跑，也不会有新的 id 被写进 `enteringNodes`；
   * 皮肤换色 ≠ 重播入场。
   * 产品理由：面板刚刚出现时若整屏卡片是"静止"的，用户看不出这些卡是刚生成的；裁决取
   * "全量播一次"换掉早先"首帧不播"的抑制。需要重新抑制时改这个初值，别改判定语义。
   */
  const previousNodeIdsRef = useRef<ReadonlySet<string>>(FLOW_ENTER_HISTORY_START)
  /** 首次渲染的节点集只在挂载时取一次，供入场标记的初值使用。 */
  const initialNodesRef = useRef<readonly { readonly id: string }[] | null>(null)
  if (initialNodesRef.current === null) initialNodesRef.current = nodes
  /**
   * 首帧的入场标记在**首次渲染时**就算好，让第一批 DOM 自带的 `data-enter="true"`；
   * effect 在挂载时只会看到"这几个 id 已经在 enteringNodes 里"，因此不会重复又播一遍。
   */
  const [enteringNodes, setEnteringNodes] = useState<readonly string[]>(
    () => newlyEnteredNodes(FLOW_ENTER_HISTORY_START, initialNodesRef.current ?? []),
  )

  const heightOf = (nodeId: string): number => heights[nodeId] ?? NODE_HEIGHT
  const boxes = useMemo(() => new Map(nodes.map(node => [node.id, {
    x: node.x, y: node.y, width: node.kind === 'requirement' ? 208 : FLOW_NODE_WIDTH,
    height: heights[node.id] ?? NODE_HEIGHT,
  }])), [nodes, heights])
  const edges = useMemo(() => layoutEdges(flow.edges, boxes), [flow, boxes])
  const requirementEdge = useMemo(
    () => (flow.requirementEdge === null ? null : layoutEdges([flow.requirementEdge], boxes)[0] ?? null),
    [flow, boxes],
  )
  const heightsSignature = Object.entries(heights)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, value]) => `${id}:${value}`)
    .join('|')

  // Auto layout only places nodes the user has NOT placed by hand, so a refresh
  // can never snap a dragged node back (it is "pinned" until 重置布局).
  useEffect(() => {
    const manual = new Set(pinned)
    setPositions(previous => {
      let changed = false
      const next: Record<string, { x: number; y: number }> = { ...previous }
      const seen = new Set<string>()
      for (const node of flow.nodes) {
        seen.add(node.id)
        if (manual.has(node.id)) continue
        const current = next[node.id]
        if (current === undefined || current.x !== node.x || current.y !== node.y) {
          next[node.id] = { x: node.x, y: node.y }
          changed = true
        }
      }
      for (const id of Object.keys(next)) {
        if (!seen.has(id)) { delete next[id]; changed = true }
      }
      return changed ? next : previous
    })
  }, [flow, pinned, heightsSignature])

  // Measure after paint so edge anchors and the fit action use real geometry.
  useEffect(() => {
    setHeights(previous => {
      let changed = false
      const next: Record<string, number> = { ...previous }
      boxRefs.current.forEach((element, id) => {
        // `offsetHeight` is the UNTRANSFORMED layout height. Measuring the bounding
        // rect here would read back the world's own scale, so every fit would inflate
        // the next one (and the cards would grow past the canvas).
        const measured = Math.round(element.offsetHeight)
        if (measured > 0 && next[id] !== measured) { next[id] = measured; changed = true }
      })
      return changed ? next : previous
    })
  }, [flow, transform.scale])

  // Docking decision: the inspector docks only while it can sit beside a canvas
  // that is still usable; otherwise it becomes an overlay drawer.
  useEffect(() => {
    const host = hostRef.current
    if (host === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => { setHostWidth(host.getBoundingClientRect().width) })
    observer.observe(host)
    setHostWidth(host.getBoundingClientRect().width)
    return () => { observer.disconnect() }
  }, [tab])

  // Fit only on a real box change: a text-only refresh must not move the view.
  // The observer always calls the LATEST fit through a ref, because the closure
  // captured when the observer was installed would still hold the first render's
  // canvas box (an empty-heights model) and would therefore fit the wrong size.
  const fittedForRef = useRef(0)
  const fitRef = useRef<() => void>(() => undefined)
  fitRef.current = fit
  useEffect(() => {
    if (viewportHost === null || typeof ResizeObserver === 'undefined') return
    // A newly attached element starts from a clean baseline, so attaching always
    // produces one fit for the size it actually has.
    sizeRef.current = { w: 0, h: 0 }
    const observer = new ResizeObserver(() => {
      const rect = viewportHost.getBoundingClientRect()
      const previous = sizeRef.current
      const first = previous.w === 0 && previous.h === 0
      sizeRef.current = { w: rect.width, h: rect.height }
      if (!first && Math.abs(rect.width - previous.w) < RESIZE_EPSILON && Math.abs(rect.height - previous.h) < RESIZE_EPSILON) return
      fitRef.current()
    })
    observer.observe(viewportHost)
    return () => { observer.disconnect() }
    // `fit` reads live geometry through refs; the host element is the only input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewportHost])

  // Cards are measured after paint, so the FIRST fit still used the fallback
  // height. Re-fit whenever the measured layout no longer matches what fit
  // assumed, so the whole chain stays visible at any column width. A view the
  // operator already moved is never re-fitted automatically.
  useEffect(() => {
    if (pinned.length > 0 || viewTouchedRef.current) return
    if (Math.abs(flow.canvasHeight - fittedForRef.current) < 24) return
    fitRef.current()
    // `canvasHeight` covers the measured card heights, the corridor and the bands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heights, pinned, edges, flow.canvasHeight])

  function fit(): void {
    const viewport = viewportRef.current
    if (viewport === null) return
    const rect = viewport.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    // Fit the WHOLE canvas box, not just the card extents: the 阶段关联带 rail and
    // the leftmost lane live to the left of the leftmost card, and a fit that
    // ignores them hides exactly the structure this round added.
    const width = flow.canvasWidth
    const height = flow.canvasHeight
    fittedForRef.current = height
    const top = FIT_TOP_RESERVE
    const bottom = FIT_BOTTOM_RESERVE
    const usableWidth = Math.max(80, rect.width - FIT_PADDING * 2)
    const usableHeight = Math.max(80, rect.height - top - bottom)
    const scale = clamp(Math.min(
      usableWidth / Math.max(width, 1),
      usableHeight / Math.max(height, 1),
    ), MIN_SCALE, MAX_SCALE)
    setTransform({
      scale,
      x: FIT_PADDING + Math.max(0, (usableWidth - width * scale) / 2),
      y: top + Math.max(0, (usableHeight - height * scale) / 2),
    })
  }

  /** Explicit reset: drop user placement and return to the computed layout. */
  const resetLayout = useCallback((): void => {
    viewTouchedRef.current = false
    setPinned([])
    setPositions(seedPositions(flow))
    setHeights({})
    window.requestAnimationFrame(() => { fitRef.current() })
    // `fit` reads live geometry through refs and is intentionally not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow])

  // Escape closes the inspector, so a keyboard user is never trapped in it.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { setSelection(null); setHighlight(null); setLegendOpen(false) }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [])

  // Publish the skin where CSS can read it (the pane wrapper is this element's
  // PARENT, so the theme attribute has to live on the document root).
  useEffect(() => {
    applySkinAttribute(document.documentElement, skin)
  }, [skin])

  /**
   * The ONLY scripted part of the motion: notice when a dispatch turns 已完成 so it
   * can play its single sweep. The sweep itself is a CSS animation (no frame loop),
   * and the flag is cleared by one timer shortly after it starts.
   */
  useEffect(() => {
    const fresh = freshlyDoneEdges(previousStatesRef.current, edges)
    if (fresh.length === 0) return
    // Union: a second dispatch finishing inside the window must not cut the first
    // one's sweep short (the flag is what drives the one-shot CSS animation).
    setFreshDone(previous => [...new Set([...previous, ...fresh])])
    const timer = window.setTimeout(() => { setFreshDone([]) }, FLOW_DONE_SWEEP_MS)
    return () => { window.clearTimeout(timer) }
  }, [edges])

  /**
   * Re-arm the flowing layer for the edges a real change moved.
   *
   * `changedEdges` is a pure diff over the projected states, so this fires exactly
   * when the committed state actually changed — never on a timer, and never for an
   * edge merely because it is present. That is what "真实事件驱动" means here: the
   * frame tells us the state moved, the snapshot tells us how, and only the
   * difference produces motion.
   */
  useEffect(() => {
    const changed = changedEdges(changedStatesRef.current, edges)
    if (changed.length === 0) return
    setRearmedEdges(changed)
    setRearmEpoch(epoch => epoch + 1)
  }, [edges])

  /**
   * Play the entrance for nodes that appeared while this view was live.
   *
   * `previousNodeIdsRef` starts as an EMPTY set (boss 2026-09-18 裁决 A：首帧也入场),
   * so every node of the first render counts as new and plays one entrance — the markers
   * are already computed in the initial state, which is why this effect adds nothing on
   * mount and simply takes over the history for the renders after it. 首帧那一次的全量
   * 入场是**产品决策**（见 {@link FLOW_ENTER_HISTORY_START}），代价是首帧同时跑一遍全场动效。
   * 本 effect 的唯一依赖是 `nodes`：**只有节点集合变了才会重跑**，所以入场只发生在
   * 打开画布 / 刷新（挂载）与"新会话带来的、本视图没见过的 id"这两类情形上；
   * **切换皮肤不触发**——它只换 `data-skin`/CSS 变量，`nodes` 还是同一个引用，effect 不重跑，
   * 也就不会产生新的 `data-enter=true`。空闲画布（节点集合不变）因此永远不会自我驱动。
   */
  useEffect(() => {
    const entered = newlyEnteredNodes(previousNodeIdsRef.current, nodes)
    previousNodeIdsRef.current = nodeIdSet(nodes)
    if (entered.length === 0) return
    setEnteringNodes(entered)
    const timer = window.setTimeout(() => { setEnteringNodes([]) }, FLOW_ENTER_MS)
    return () => { window.clearTimeout(timer) }
  }, [nodes])

  /** Flip the skin and remember the choice from now on. */
  function toggleSkin(): void {
    const next = nextSkin(skin)
    storeSkin(safeStorage(), next)
    setSkin(next)
  }

  /**
   * §11.1 玻璃 × 动效的降级策略：动画运行期间把叠加的玻璃层降级为实色，动画停下
   * {@link MOTION_QUIET_MS} 后恢复；另加一道"持续长帧"的自适应兜底。判定结果写在
   * 画布根节点的 data-glass-budget / data-motion 上，供样式与取证读取。
   * 这里只切换背景与模糊，绝不改动布局、语义色或动效本身。
   */
  useGlassMotionBudget(rootRef)

  /**
   * The wheel over the canvas ZOOMS and must never scroll anything else.
   *
   * Root cause measured in correction R2: React attaches `onWheel` as a PASSIVE
   * listener, so `event.preventDefault()` inside the JSX handler was a no-op and
   * the wheel bubbled into the dock's pane body (`overflow-y:auto`,
   * `scrollHeight 916 > clientHeight 862`), which shifted the whole panel by 54px.
   * The listener therefore has to be registered natively with `passive: false`.
   */
  useEffect(() => {
    if (viewportHost === null) return
    const onWheel = (event: WheelEvent): void => {
      // Always consume the gesture: zoom in/out, never scroll the pane or the page.
      event.preventDefault()
      event.stopPropagation()
      zoomAt(event.deltaY < 0 ? 1.08 : 0.92, event.clientX, event.clientY)
    }
    viewportHost.addEventListener('wheel', onWheel, { passive: false })
    return () => { viewportHost.removeEventListener('wheel', onWheel) }
    // `zoomAt` reads live geometry through refs and is intentionally not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewportHost])

  /** Clamp panning so a slice of the canvas always stays reachable. */
  function panTo(next: Transform): Transform {
    const viewport = viewportRef.current
    if (viewport === null) return next
    const rect = viewport.getBoundingClientRect()
    const worldW = flow.canvasWidth * next.scale
    const worldH = flow.canvasHeight * next.scale
    return {
      scale: next.scale,
      x: clamp(next.x, Math.min(MIN_VISIBLE, rect.width) - worldW, Math.max(0, rect.width - MIN_VISIBLE)),
      y: clamp(next.y, Math.min(MIN_VISIBLE, rect.height) - worldH, Math.max(0, rect.height - MIN_VISIBLE)),
    }
  }

  function zoomBy(delta: number): void {
    const viewport = viewportRef.current
    if (viewport === null) return
    const rect = viewport.getBoundingClientRect()
    const anchorX = rect.width / 2
    const anchorY = rect.height / 2
    viewTouchedRef.current = true
    setTransform(current => {
      const scale = clamp(current.scale + delta, MIN_SCALE, MAX_SCALE)
      return panTo({
        scale,
        x: anchorX - (anchorX - current.x) * (scale / current.scale),
        y: anchorY - (anchorY - current.y) * (scale / current.scale),
      })
    })
  }

  function zoomAt(factor: number, clientX: number, clientY: number): void {
    const viewport = viewportRef.current
    if (viewport === null) return
    const rect = viewport.getBoundingClientRect()
    const anchorX = clientX - rect.left
    const anchorY = clientY - rect.top
    viewTouchedRef.current = true
    setTransform(current => {
      const scale = clamp(current.scale * factor, MIN_SCALE, MAX_SCALE)
      return panTo({
        scale,
        x: anchorX - (anchorX - current.x) * (scale / current.scale),
        y: anchorY - (anchorY - current.y) * (scale / current.scale),
      })
    })
  }

  function startPan(event: React.PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest('[data-flow-node]') !== null) return
    if (target.closest('[data-flow-edge]') !== null) return
    if (target.closest('.devflow-flow-float') !== null) return
    const startX = event.clientX
    const startY = event.clientY
    const origin = transform
    let moved = 0
    setPanning(true)
    const move = (moveEvent: PointerEvent) => {
      moved += Math.abs(moveEvent.clientX - startX) + Math.abs(moveEvent.clientY - startY)
      viewTouchedRef.current = true
      setTransform(panTo({
        scale: origin.scale,
        x: origin.x + (moveEvent.clientX - startX),
        y: origin.y + (moveEvent.clientY - startY),
      }))
    }
    const up = () => {
      setPanning(false)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      // A plain background click means "dismiss", the usual inspector behaviour.
      if (moved < 4) setSelection(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  function startNodeDrag(nodeId: string, event: React.PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return
    event.stopPropagation()
    const startX = event.clientX
    const startY = event.clientY
    const origin = positions[nodeId] ?? { x: 0, y: 0 }
    let moved = 0
    const move = (moveEvent: PointerEvent) => {
      const dx = (moveEvent.clientX - startX) / transform.scale
      const dy = (moveEvent.clientY - startY) / transform.scale
      moved += Math.abs(dx) + Math.abs(dy)
      viewTouchedRef.current = true
      setPositions(current => ({ ...current, [nodeId]: { x: origin.x + dx, y: origin.y + dy } }))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (moved < 4) selectNode(nodeId)
      else setPinned(current => current.includes(nodeId) ? current : [...current, nodeId])
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  /** A tap on a card opens its detail in the inspector — the card itself never grows. */
  function selectNode(nodeId: string): void {
    setSelection({ kind: 'node', id: nodeId })
  }

  function selectEdge(edgeId: string): void {
    setSelection({ kind: 'edge', id: edgeId })
  }

  function toggleRosterCard(agentId: string): void {
    setRosterCards(current => current.includes(agentId)
      ? current.filter(id => id !== agentId)
      : [...current, agentId])
  }

  const selectedEdge = selection?.kind === 'edge'
    ? edges.find(edge => edge.id === selection.id) ?? null
    : null
  const selectedNode = selection?.kind === 'node'
    ? nodes.find(node => node.id === selection.id) ?? null
    : null
  const selectedBand = selection?.kind === 'phase'
    ? flow.bands.find(band => band.id === selection.id) ?? null
    : null
  const docked = hostWidth >= INSPECTOR_DOCK_MIN
  const inspectorMode = selection === null ? 'closed' : docked ? 'dock' : 'drawer'
  /**
   * Which nodes/edges the 阶段关联 list currently highlights: a single task, or
   * every task and dispatch of one phase.
   */
  const highlightedTasks = highlight === null
    ? new Set<string>()
    : highlight.kind === 'task'
      ? new Set([highlight.id])
      : new Set((flow.bands.find(band => band.id === highlight.id)?.tasks ?? []).map(task => task.id))
  const highlightedPhase = highlight !== null && highlight.kind === 'phase' ? highlight.id : null
  const isHighlighted = (taskId: string | null, phaseId: string | null): boolean =>
    taskId !== null && (highlightedTasks.has(taskId) || (phaseId !== null && phaseId === highlightedPhase))
  const roster = model.agents.filter(item => item.agent.kind === 'fixed')
  const temporaryRoster = model.agents.filter(item => item.agent.kind === 'temporary')
  const runningIds = new Set(nodes.filter(node => node.state === 'active').map(node => node.id))
  const session = model.snapshot.session
  /**
   * The panel's project identifier (第九步).
   *
   * It names THIS session's project — the workspace the session is isolated to —
   * not a machine-wide shared root. The project name comes from the durable
   * project record; the workspace path is what makes two same-named projects
   * distinguishable, and the full path is carried verbatim so an operator can
   * copy it. `（未初始化）` keeps meaning "no project record in this workspace".
   */
  const projectName = model.snapshot.project?.name ?? '（未初始化）'
  const workspacePath = session.workspacePath ?? null
  const workspaceLabel = workspacePath === null ? null : workspaceBasename(workspacePath)
  const identityLine = [
    workspacePath === null
      ? `本项目 ${projectName}`
      : `本项目 ${projectName} @ ${workspaceLabel}`,
    session.commanderMode === 'commander' ? '本会话已绑定总指挥' : '本会话未绑定总指挥',
    `会话 ${shortId(session.id, 12)}`,
    model.snapshot.paused ? '派发已暂停' : '派发中',
    freshnessLine(phase, model.snapshot.generatedAt),
    channelLine(connection),
  ].join(' ｜ ')
  const labelled = (edge: FlowEdge): boolean => edges.length <= EDGE_LABEL_LIMIT
    || edge.id === selection?.id
    || edge.semantic === 'rework'

  return <div className={'devflow-flow'} data-skin={skin} data-paused={paused} ref={rootRef}>
    {tab !== 'flow' && <div className={'devflow-flow-panel devflow-flow-secondary'} role="tabpanel">
      <header className={'devflow-flow-secondaryhead'}>
        <button type="button" onClick={() => { onTabChange('flow') }}>← 返回派发流画布</button>
        <strong>{VIEW_LABELS[tab]}</strong>
      </header>
      <div className={'devflow-flow-secondarybody'}>
        {tab === 'audit' ? auditPanel : toolsPanel}
      </div>
    </div>}

    {tab === 'flow' && <div className={'devflow-flow-canvas'} role="tabpanel" data-inspector={inspectorMode} ref={hostRef}>
      <div
        className={'devflow-flow-viewport'}
        data-panning={panning}
        ref={bindViewport}
        onPointerDown={startPan}
      >
        <div className={'devflow-flow-grid'} aria-hidden="true" />
        <div
          className={'devflow-flow-world'}
          style={{
            width: flow.canvasWidth,
            height: flow.canvasHeight,
            transform: `translate(${Math.round(transform.x)}px, ${Math.round(transform.y)}px) scale(${transform.scale})`,
          }}
        >
          {/* Correction R2: 阶段关联 是分层与通道分配的内部依据，**画布上不再画任何**阶段元素
              （无框、无名、无计数、无左侧栏）；明细在右侧栏的「阶段关联」列表里。 */}
          <svg className={'devflow-flow-edges'} width={flow.canvasWidth} height={flow.canvasHeight} aria-hidden="true">
            {requirementEdge !== null && requirementEdge.path !== '' && <g key={requirementEdge.id}>
              {/* 需求下达不是一次派发，所以它不带派发状态，也不参与派发计数。 */}
              <path
                className={'devflow-flow-edge'}
                data-edge-semantic={requirementEdge.semantic}
                data-edge-id={requirementEdge.id}
                data-edge-from={requirementEdge.from}
                data-edge-to={requirementEdge.to}
                d={requirementEdge.path}
              />
              <path className={'devflow-flow-arrow'} data-edge-semantic={requirementEdge.semantic} d={requirementEdge.arrowPath} />
            </g>}
            {edges.filter(edge => edge.path !== '').map(edge => {
              const motion = motionProfile(edge.state, paused)
              const fresh = freshDone.includes(edge.id)
              // A real change re-arms the flow: the key makes React replace the
              // element, which restarts the CSS animation from its first frame. An
              // unchanged edge keeps its element, so its phase is never reset and an
              // idle canvas never re-triggers anything.
              const rearmed = rearmedEdges.includes(edge.id)
              return <g
                key={edge.id}
                data-flow-rate={motionRate(motion)}
                data-highlight={isHighlighted(edge.taskId, edge.phaseId)}
                data-fresh={fresh ? 'true' : 'false'}
                data-rearmed={rearmed ? 'true' : 'false'}
                style={{ opacity: motion.opacity }}
              >
                <path
                  className={'devflow-flow-edge'}
                  data-edge-state={edge.state}
                  data-edge-semantic={edge.semantic}
                  data-edge-id={edge.id}
                  data-edge-from={edge.from}
                  data-edge-to={edge.to}
                  data-selected={edge.id === selection?.id}
                  d={edge.path}
                />
                <path className={'devflow-flow-arrow'} data-edge-semantic={edge.semantic} data-arrow-state={edge.state} d={edge.arrowPath} />
                {/* 动效层：只有"正在发生"的派发才有一条流动的虚线在线上跑。
                    元素恒定存在（身份不随数据刷新重建），静止状态只是被 CSS 隐藏；
                    它的 key 只为"真实状态变化"而变，因此相位由事件驱动，而非定时器。 */}
                <path
                  key={rearmed ? `${edge.id}:${rearmEpoch}` : edge.id}
                  className={'devflow-flow-flow'}
                  data-flow-overlay={edge.id}
                  style={motion.flowing ? { animationDuration: `${motion.durationSeconds}s` } : undefined}
                  d={edge.path}
                />
                {/* 刚刚完成：只走一次扫光（≤1.1s，由 FLOW_DONE_SWEEP_MS 定时撤下），此后永久静止。 */}
                <path className={'devflow-flow-sweep'} data-flow-sweep={edge.id} pathLength={100} d={edge.path} />
                <path
                  className={'devflow-flow-edge-hit'}
                  data-flow-edge={edge.id}
                  data-stale-reason={edge.handoff.statusLabel}
                  d={edge.path}
                  onClick={event => {
                    event.stopPropagation()
                    selectEdge(edge.id)
                  }}
                />
                {labelled(edge) && <text className={'devflow-flow-edge-label'} x={edge.labelX} y={edge.labelY} textAnchor="middle">{edge.badge}</text>}
              </g>
            })}
          </svg>

          {nodes.map(node => <div
            key={node.id}
            ref={element => {
              if (element === null) boxRefs.current.delete(node.id)
              else boxRefs.current.set(node.id, element)
            }}
            className={'devflow-flow-card'}
            data-flow-node={node.id}
            data-kind={node.kind}
            data-state={node.state}
            data-enter={enteringNodes.includes(node.id) ? 'true' : 'false'}
            data-selected={selectedNode?.id === node.id}
            data-highlight={isHighlighted(node.taskId, null)}
            data-card-h={heightOf(node.id)}
            style={{ left: node.x, top: node.y, width: node.kind === 'requirement' ? 208 : FLOW_NODE_WIDTH }}
            onPointerDown={event => { startNodeDrag(node.id, event) }}
          >
            {/* 卡片只放摘要：详情一律进右侧栏，卡片高度因此不随点击变化。 */}
            <p className={'devflow-flow-name'}>
              {node.label}
              {node.kind === 'requirement' && <span className={'devflow-flow-tag user'}>{node.sourceLabel}</span>}
              {node.kind === 'temporary' && <span className={'devflow-flow-tag subagent'}>子代理</span>}
            </p>
            <p className={'devflow-flow-sub'}>{nodeSubtitle(node)}</p>
            {node.taskTitle !== null && <p className={'devflow-flow-task'}>{node.taskTitle}</p>}
            <span className={`devflow-flow-badge ${NODE_STATE_CLASS[node.state]}`}>{node.stateLabel}</span>
          </div>)}
        </div>

        <div className={'devflow-flow-float devflow-flow-info'} data-freshness={phase} data-connection={connection?.phase ?? 'off'} data-skin={skin}>
          <div className={'devflow-flow-identrow'}>
            <span
              className={'devflow-flow-ident devflow-freshness'}
              data-freshness={phase}
              data-connection={connection?.phase ?? 'off'}
              data-project-workspace={workspacePath ?? 'none'}
              title={workspacePath === null ? session.id : `${session.id} · ${workspacePath}`}
            >{identityLine}</span>
            {/* 皮肤属于整个面板的属性，放在身份行右侧（画布工具栏只留缩放/历史/重置/审计/本会话）。 */}
            <button
              type="button"
              className={'devflow-flow-skin'}
              data-skin={skin}
              aria-label={FLOW_SKIN_LABELS[skin].label}
              title={`${FLOW_SKIN_LABELS[skin].label} · ${FLOW_SKIN_LABELS[skin].hint}`}
              onClick={toggleSkin}
            >
              <span className={'devflow-flow-skinicon'} data-shape={skin === 'light' ? 'moon' : 'ring'} aria-hidden="true" />
            </button>
            {/* §二·3：浮层被关闭后，第三栏保留一个重新打开的入口（就放在同一行的右侧）。
                走面板自己的注入回调；注入缺失时退回同一个窗口事件，行为不变。 */}
            <button
              type="button"
              className={'devflow-flow-skin'}
              data-role="overview-reopen"
              aria-label="重新打开右上角概览浮层"
              title="重新打开右上角概览浮层"
              onClick={() => { onReopenOverview === undefined ? window.dispatchEvent(new Event(OVERVIEW_REOPEN_EVENT)) : onReopenOverview() }}
            >
              <span className={'devflow-flow-overviewicon'} aria-hidden="true" />
            </button>
          </div>
          {connection?.phase === 'polling' && <span className={'devflow-flow-channel'} data-connection="polling" role="status">
            {connection.detail ?? CONNECTION_LOST_DETAIL}（画布仍在每 5 秒拉取快照，重连成功后自动恢复实时更新）
          </span>}
          {connection?.phase === 'connecting' && <span className={'devflow-flow-channel'} data-connection="connecting" role="status">
            正在建立实时通道…（当前按 5 秒轮询快照）
          </span>}
          <span className={'devflow-flow-zoomchip'}>缩放 {Math.round(transform.scale * 100)}%</span>
        </div>

        {/* 底部一个纵向栈：提示行 / 图例 / （花名册 + 工具条）。三者同在一个 flex 列里，
            高度随内容增长，彼此永远不可能像上一轮那样互相压住。 */}
        <div className={'devflow-flow-float devflow-flow-bottomstack'}>
        <div className={'devflow-flow-bottom'}>
          <span className={'devflow-flow-hint'}>拖动空白处平移 · 滚轮缩放 · 拖动卡片 · 点卡片看详情 · <b>点连线看这次派发的任务</b></span>
          <span className={'devflow-flow-notices'}>
            {notice !== null && notice !== undefined && <span role="status">{notice}</span>}
            {flow.visibleAgentIds.length === 0 && <span role="status">画布初始只有总指挥：用到谁才会被调用下来并连线。</span>}
            {flow.visibleAgentIds.length > WIDE_ROW_LIMIT && <span role="status">同层 {flow.visibleAgentIds.length} 位员工落在同一行，画布会变宽；这是数据侧密度问题，不是连线问题。</span>}
            {flow.lostCount > 0 && <span role="status">其中 {flow.lostCount} 条派发没有正在运行的执行记录，已按「未收尾 · 已失联」标出（历史数据未清理）</span>}
            {flow.unroutedCount > 0 && <span role="status">另有 {flow.unroutedCount} 条派发的员工不在当前快照，无法落点（不画悬空连线）</span>}
            {flow.history.edges.length > flow.current.edges.length && <span role="status">
              {showHistory
                ? `正在显示全部 ${flow.history.edges.length} 条历史派发边（每次交接各自一条，未合并）`
                : `已隐藏 ${flow.history.edges.length - flow.current.edges.length} 条历史派发边（工具栏 ⇥ 全部历史可展开）`}
            </span>}
          </span>
        </div>

        <span className={'devflow-flow-legend'} aria-label="连线图例">
          <span className={'devflow-flow-legendgroup'} data-legend-group="semantic">
            {SEMANTIC_ORDER.map(semantic => <span key={semantic} data-legend-kind="semantic" data-semantic={semantic} title={`关系：${FLOW_SEMANTIC_LABELS[semantic]}（${SEMANTIC_SHAPE[semantic]}）`}>
              <i className={`devflow-flow-line is-${semantic}`} aria-hidden="true" />
              {FLOW_SEMANTIC_LABELS[semantic]}
            </span>)}
          </span>
          <span className={'devflow-flow-legendgroup'} data-legend-group="state">
            {EDGE_STATES.map(value => <span key={value} data-legend-kind="state" data-state={value}>
              <i className={`devflow-flow-swatch is-${value}`} aria-hidden="true" />
              {EDGE_STATE_TEXT[value]}
            </span>)}
          </span>
          <button type="button" className={'devflow-flow-legendtoggle'} aria-expanded={legendOpen} onClick={() => { setLegendOpen(open => !open) }}>
            {legendOpen ? '收起图例' : '图例说明'}
          </button>
        </span>

        <div className={'devflow-flow-bottomrow'}>
          {/*
            并发上限（boss 2026-09-21 明确要求）：与名册同区，`N` 由快照里的
            「running 执行记录」**数出来**（不是估算），`5` 来自 host/client 共用的
            单点常量 `DEVFLOW_CONCURRENCY_LIMIT`。到顶时明说「后续排队」，并且被挡下的
            派发仍然显示为「排队中」——「看不见的拖时间」正是这次立项的痛点。
          */}
          <span
            className={'devflow-flow-concurrency'}
            data-at-limit={flow.concurrency.atLimit}
            role="status"
            aria-label={`并发上限 ${flow.concurrency.running}/${flow.concurrency.limit}`}
            title={`同时最多 ${flow.concurrency.limit} 个派发在执行；达到上限后新的派发排队等待，不会丢`}
          >
            <b>并发 {flow.concurrency.running}/{flow.concurrency.limit}</b>
            {flow.concurrency.atLimit && <span className={'devflow-flow-concurrencynote'}>已达并发上限 · 后续排队</span>}
          </span>
          <div className={'devflow-flow-roster'} data-open={rosterOpen}>
            <button
              type="button"
              className={'devflow-flow-rosterhead'}
              aria-expanded={rosterOpen}
              onClick={() => { setRosterOpen(open => !open) }}
            >
              <span className={'devflow-flow-rosterkicker'}>员工名册</span>
              {/* Both counts ride the collapsed header: the canvas draws temporary
                  sub-agents like any other employee, so the count has to be visible
                  without expanding the roster. */}
              <strong>固定员工 · {roster.length} 人 / 临时子代理 · {temporaryRoster.length} 人</strong>
              <span className={'devflow-flow-rosterhint'}>{rosterOpen ? '收起' : '展开'}</span>
            </button>
            {rosterOpen && <div className={'devflow-flow-rosterbody'}>
              {roster.map(item => <div
                key={item.agent.id}
                className={'devflow-flow-pcard'}
                data-open={rosterCards.includes(item.agent.id)}
              >
                <button type="button" className={'devflow-flow-pcardbutton'} onClick={() => { toggleRosterCard(item.agent.id) }}>
                  <strong>{flowAgentName(item.agent.id, item.agent.displayName)}</strong>
                  {runningIds.has(item.agent.id) && <span className={'devflow-flow-tag live'}>运行中</span>}
                  {item.agent.id !== flow.commanderId && (item.agent.skills ?? []).length === 0 && <span className={'devflow-flow-tag'}>暂未绑定</span>}
                  <small>{rosterCountLabel(item.agent.id, item.executions.filter(execution => execution.status === 'completed').length)}</small>
                </button>
                {rosterCards.includes(item.agent.id) && <div className={'devflow-flow-pdet'}>
                  <p>技能：{rosterSkillsLabel(item.agent.id, item.agent.skills)}</p>
                  <p>能力：{rosterCapabilitiesLabel(item.agent.id, item.agent.capabilities)}</p>
                  <p>模型：{item.agent.provider === undefined ? item.agent.model : `${item.agent.provider} · ${item.agent.model}`}</p>
                  <p>{rosterDelegationLabel(item.agent.id, item.agent.delegationDepth)}</p>
                  <p>状态：{agentWorkStateLabel(item.workState)}</p>
                </div>}
              </div>)}
              {/*
                The temporary sub-agents the Commander created on the spot. They are
                drawn on the canvas like any other employee (第十一步), so the roster
                has to name them: a canvas card with no roster line would read as an
                employee nobody can look up.
              */}
              <div className={'devflow-flow-rostergroup'}>
                <strong>临时子代理 · {temporaryRoster.length} 人</strong>
                {temporaryRoster.length === 0
                  ? <small>本次会话尚未创建临时子代理（只能由总指挥现场创建 · 1–2 层）。</small>
                  : temporaryRoster.map(item => <div
                    key={item.agent.id}
                    className={'devflow-flow-pcard'}
                    data-open={rosterCards.includes(item.agent.id)}
                  >
                    <button type="button" className={'devflow-flow-pcardbutton'} onClick={() => { toggleRosterCard(item.agent.id) }}>
                      <strong>{flowAgentName(item.agent.id, item.agent.displayName)}</strong>
                      <span className={'devflow-flow-tag'}>临时子代理</span>
                      {runningIds.has(item.agent.id) && <span className={'devflow-flow-tag live'}>运行中</span>}
                      <small>{rosterCountLabel(item.agent.id, item.executions.filter(execution => execution.status === 'completed').length)}</small>
                    </button>
                    {rosterCards.includes(item.agent.id) && <div className={'devflow-flow-pdet'}>
                      <p>技能：{rosterSkillsLabel(item.agent.id, item.agent.skills)}</p>
                      <p>能力：{rosterCapabilitiesLabel(item.agent.id, item.agent.capabilities)}</p>
                      <p>模型：{item.agent.provider === undefined ? item.agent.model : `${item.agent.provider} · ${item.agent.model}`}</p>
                      <p>{rosterDelegationLabel(item.agent.id, item.agent.delegationDepth)}</p>
                      <p>状态：{agentWorkStateLabel(item.workState)}</p>
                    </div>}
                  </div>)}
              </div>
              <div className={'devflow-flow-pcard'} data-plan="true">
                <strong>临时子代理 <span className={'devflow-flow-tag live'}>{temporaryRoster.length > 0 ? `已启用 · ${temporaryRoster.length} 人` : '设计目标'}</span></strong>
                <small>只能由总指挥现场创建 · 1–2 层</small>
                <div className={'devflow-flow-pdet'}>
                  <p>创建者是总指挥（固定员工 <code>delegationDepth = 0</code>，没有委派能力）。</p>
                  <p>临时子代理由总指挥现场创建并派发；其生命周期状态（运行中 / 已终止）尚未与面板联动，节点状态暂按执行记录推导。当前快照有 {temporaryRoster.length} 个临时 Agent 记录。</p>
                </div>
              </div>
            </div>}
          </div>
          <div className={'devflow-flow-toolbar'}>
            <button type="button" className={'devflow-flow-action'} data-primary="true" title="适配视图（重置缩放并平移到全部节点可见）" aria-label="适配视图" onClick={() => { fit() }}>⤢</button>
            <button type="button" className={'devflow-flow-action'} title="放大" aria-label="放大" onClick={() => { zoomBy(0.15) }}>＋</button>
            <button type="button" className={'devflow-flow-action'} title="缩小" aria-label="缩小" onClick={() => { zoomBy(-0.15) }}>－</button>
            <button
              type="button"
              className={'devflow-flow-action'}
              data-primary={showHistory}
              aria-pressed={showHistory}
              title={showHistory ? '只看当前链路' : '显示全部历史链路'}
              aria-label={showHistory ? '只看当前链路' : '全部历史链路'}
              onClick={() => { setShowHistory(value => !value); window.requestAnimationFrame(() => { fit() }) }}
            >{showHistory ? '⇤ 当前链路' : '⇥ 全部历史'}</button>
            <button type="button" className={'devflow-flow-action'} title="重置布局（回到自动布局并恢复自动适配）" aria-label="重置布局" onClick={resetLayout}>⟳ 重置布局</button>
            <span className={'devflow-flow-viewswitch'}>
              {(['audit', 'tools'] as const).map(view => <button
                key={view}
                type="button"
                className={'devflow-flow-action'}
                onClick={() => { onTabChange(view) }}
              >{VIEW_LABELS[view]}</button>)}
            </span>
          </div>
        </div>
        </div>

        {legendOpen && <section className={'devflow-flow-float devflow-flow-legendpanel'} aria-label="图例说明">
          <h3>关系（看线型与箭头方向）</h3>
          <ul>
            {SEMANTIC_ORDER.map(semantic => <li key={semantic}>
              <i className={`devflow-flow-line is-${semantic}`} aria-hidden="true" />
              {semanticLine(semantic)}
            </li>)}
          </ul>
          <h3>状态（只看颜色）</h3>
          <ul>
            {EDGE_STATES.map(value => <li key={value}><i className={`devflow-flow-swatch is-${value}`} aria-hidden="true" />{EDGE_STATE_TEXT[value]}</li>)}
          </ul>
          <p className={'devflow-flow-legendnote'}>阶段关联带按阶段把同阶段的派发分组显示；每一次交接都各自成边，不做合并。</p>
          <button type="button" className={'devflow-flow-xferclose'} onClick={() => { setLegendOpen(false) }}>收起</button>
        </section>}

        {flow.concurrency.running > 1 && <p className={'devflow-flow-float devflow-flow-note'} role="status">
          快照中有 {flow.concurrency.running} 条执行记录正在运行，画布如实把每一条都标为「执行中」。同轮派发彼此独立、同时推进；同时最多 {flow.concurrency.limit} 条，达到上限后新的派发按「排队中」等待，不会悄悄延后。
        </p>}
      </div>

      {selection !== null && <FlowInspector
        mode={docked ? 'dock' : 'drawer'}
        flow={flow}
        edges={edges}
        node={selectedNode}
        edge={selectedEdge}
        band={selectedBand}
        highlight={highlight}
        onClose={() => { setSelection(null); setHighlight(null) }}
        onSelectNode={selectNode}
        onSelectEdge={selectEdge}
        onSelectBand={bandId => { setSelection({ kind: 'phase', id: bandId }); setHighlight({ kind: 'phase', id: bandId }) }}
        onHighlightTask={taskId => { setHighlight(current => current?.kind === 'task' && current.id === taskId ? null : { kind: 'task', id: taskId }) }}
      />}
    </div>}
  </div>
}

/**
 * The canvas' right-hand inspector: one panel for node detail, dispatch handoff
 * detail and 阶段关联 — exactly one of them at a time.
 *
 * Correction R2 moved EVERY phase visual here: the canvas no longer draws a box,
 * a name, a count badge or a rail for 阶段关联, so this list is the only place
 * phase association is shown.
 *
 * Exported so the panel's content can be rendered and asserted directly, without
 * driving the canvas' pointer interactions.
 */
export function FlowInspector(props: {
  readonly mode: 'dock' | 'drawer'
  readonly flow: FlowModel
  readonly edges: readonly FlowEdge[]
  readonly node: FlowNode | null
  readonly edge: FlowEdge | null
  readonly band: FlowBand | null
  readonly highlight: FlowHighlight
  readonly onClose: () => void
  readonly onSelectNode: (nodeId: string) => void
  readonly onSelectEdge: (edgeId: string) => void
  readonly onSelectBand: (bandId: string) => void
  readonly onHighlightTask: (taskId: string) => void
}) {
  const { mode, flow, edges, node, edge, band, highlight, onClose, onSelectNode: _onSelectNode, onSelectEdge, onSelectBand, onHighlightTask } = props
  const title = node !== null ? node.label : edge !== null ? edge.handoff.title : band !== null ? band.name : '详情'
  const kicker = node !== null ? '节点详情' : edge !== null ? '交接详情' : '阶段关联'
  const relatedEdges = node === null ? [] : edges.filter(item => item.from === node.id || item.to === node.id)
  const bandEdges = band === null ? [] : edges.filter(item => item.phaseId === band.id)

  return <aside className={'devflow-flow-inspector'} data-mode={mode} aria-label={kicker}>
    <header className={'devflow-flow-inspectorhead'}>
      <div>
        <p className={'devflow-kicker'}>{kicker}</p>
        <h3>{title}</h3>
      </div>
      <button type="button" className={'devflow-flow-inspectorclose'} aria-label="关闭详情" onClick={onClose}>✕</button>
    </header>

    {node !== null && <>
      <dl className={'devflow-flow-table'}>
        <div><dt>角色 / id</dt><dd>{node.roleLabel} · {node.id}</dd></div>
        {node.sourceLabel !== null && <div><dt>来源</dt><dd>{node.sourceLabel}（只读状态节点）</dd></div>}
        <div><dt>委派深度</dt><dd>{node.delegationLabel}</dd></div>
        <div><dt>子代理</dt><dd>{node.subagentNote}</dd></div>
        <div><dt>能力</dt><dd>{node.capabilitiesLabel}</dd></div>
        <div><dt>模型</dt><dd>{node.modelLabel === '' ? '不适用' : node.modelLabel}</dd></div>
        <div><dt>绑定技能</dt><dd>{node.skillsLabel}</dd></div>
        <div><dt>已交付</dt><dd>{node.deliveryCount} 次</dd></div>
        <div><dt>状态</dt><dd>{node.stateLabel}{node.taskStateLabel === null ? '' : ` · ${node.taskStateLabel}`}</dd></div>
        {node.executionLabel !== null && <div><dt>执行</dt><dd>{node.executionLabel}</dd></div>}
      </dl>

      <h4 className={'devflow-flow-inspectorsection'}>{node.kind === 'requirement' ? '需求全文' : '当前任务'}</h4>
      {node.taskTitle === null
        ? <p className={'devflow-flow-mutedline'}>当前没有关联的派发任务。</p>
        : <>
          <p className={'devflow-flow-inspectortask'}>{node.taskTitle}{node.taskId === null ? '' : `（${shortId(node.taskId, 14)}）`}</p>
          {node.taskDescription !== null && <p className={'devflow-flow-xferdetail'}>{node.taskDescription}</p>}
          {node.kind === 'requirement' && <p className={'devflow-flow-mutedline'}>用户需求节点不承载派发任务，只承载需求全文与来源。</p>}
        </>}

      <h4 className={'devflow-flow-inspectorsection'}>相关边（{relatedEdges.length}）</h4>
      {relatedEdges.length === 0
        ? <p className={'devflow-flow-mutedline'}>该节点当前没有画出的边。</p>
        : <ul className={'devflow-flow-inspectorlist'}>
          {relatedEdges.map(item => <li key={item.id}>
            <button type="button" data-inspector-edge={item.id} onClick={() => { onSelectEdge(item.id) }}>
              <i className={`devflow-flow-line is-${item.semantic}`} aria-hidden="true" />
              <span className={'devflow-flow-inspectorlinetitle'}>{FLOW_SEMANTIC_LABELS[item.semantic]} · {item.fromLabel} → {item.toLabel}</span>
              <small>{item.badge}</small>
            </button>
          </li>)}
        </ul>}
    </>}

    {edge !== null && <>
      <dl className={'devflow-flow-table'}>
        <div><dt>关系</dt><dd>{FLOW_SEMANTIC_LABELS[edge.semantic]}（{edge.semantic === 'delivery' ? '员工 → 总指挥' : '总指挥 → 员工'}）</dd></div>
        <div><dt>taskId</dt><dd>{edge.handoff.taskId ?? '未记录'}</dd></div>
        <div><dt>{edge.handoff.acceptance.label}</dt><dd>{edge.handoff.acceptance.value}{edge.handoff.acceptance.truncated ? '（已截断）' : ''}</dd></div>
        <div><dt>交接双方</dt><dd>{edge.handoff.fromLabel} → {edge.handoff.toLabel}</dd></div>
        <div><dt>状态</dt><dd>{edge.handoff.statusLabel}</dd></div>
        <div><dt>时间</dt><dd>{edge.handoff.at ?? '未记录'}</dd></div>
        <div><dt>返工次数</dt><dd>{edge.handoff.retryCount}</dd></div>
      </dl>
      {edge.handoff.detail !== null && <p className={'devflow-flow-xferdetail'}>{edge.handoff.detail}</p>}
    </>}

    {band !== null && <>
      <dl className={'devflow-flow-table'}>
        <div><dt>阶段</dt><dd>{band.name}</dd></div>
        <div><dt>状态</dt><dd>{band.statusLabel}</dd></div>
        <div><dt>任务数 / 派发数</dt><dd>{band.taskCount} / {band.dispatchCount}</dd></div>
      </dl>

      <h4 className={'devflow-flow-inspectorsection'}>该阶段的任务（{band.tasks.length}）</h4>
      {band.tasks.length === 0
        ? <p className={'devflow-flow-mutedline'}>该阶段当前没有关联任务。</p>
        : <ul className={'devflow-flow-inspectorlist'}>
          {band.tasks.map(task => <li key={task.id}>
            <button
              type="button"
              data-inspector-task={task.id}
              data-highlight={highlight?.kind === 'task' && highlight.id === task.id}
              onClick={() => { onHighlightTask(task.id) }}
            >
              <span className={'devflow-flow-inspectorlinetitle'}>{task.title}</span>
              <small>{task.stateLabel}</small>
            </button>
          </li>)}
        </ul>}

      <h4 className={'devflow-flow-inspectorsection'}>该阶段的派发（{bandEdges.length}）</h4>
      {bandEdges.length === 0
        ? <p className={'devflow-flow-mutedline'}>该阶段当前没有画出的派发边（默认视图只画每位员工的当前链路）。</p>
        : <ul className={'devflow-flow-inspectorlist'}>
          {bandEdges.map(item => <li key={item.id}>
            <button type="button" data-inspector-edge={item.id} onClick={() => { onSelectEdge(item.id) }}>
              <i className={`devflow-flow-line is-${item.semantic}`} aria-hidden="true" />
              <span className={'devflow-flow-inspectorlinetitle'}>{item.taskLabel}</span>
              <small>{item.badge}</small>
            </button>
          </li>)}
        </ul>}
      <p className={'devflow-flow-mutedline'}>画布上不再画任何阶段元素；阶段关联只在这里列出。点一项即高亮画布上对应的节点与边。</p>
    </>}

    {band === null && <h4 className={'devflow-flow-inspectorsection'}>阶段关联（{flow.bands.length}）</h4>}
    {band === null && <ul className={'devflow-flow-inspectorlist'}>
      {flow.bands.map(item => <li key={item.id}>
        <button
          type="button"
          data-inspector-band={item.id}
          data-highlight={highlight?.kind === 'phase' && highlight.id === item.id}
          title={`${item.name} · ${item.statusLabel} · 任务 ${item.taskCount} · 派发 ${item.dispatchCount}`}
          onClick={() => { onSelectBand(item.id) }}
        >
          <i className={'devflow-flow-banddot'} data-status={item.status} aria-hidden="true" />
          <span className={'devflow-flow-inspectorlinetitle'}>{item.name}</span>
          <small>{item.statusLabel} · {item.taskCount}/{item.dispatchCount}</small>
        </button>
      </li>)}
    </ul>}

    <button type="button" className={'devflow-flow-xferclose'} onClick={onClose}>关闭</button>
  </aside>
}

function semanticLine(semantic: FlowEdgeSemantic): string {
  if (semantic === 'requirement') return '需求下达：用户需求 → 总指挥（只读来源）'
  if (semantic === 'dispatch') return '派发：总指挥 → 员工 / 审计（箭头指向接收方）'
  if (semantic === 'delivery') return '交付 · 汇报：员工 / 审计 → 总指挥（箭头指回总指挥）'
  if (semantic === 'rework') return '返工：总指挥 → 原员工（同一任务的再次派发，边上标注返工次数）'
  return '子代理创建 / 回传：总指挥 ↔ 临时子代理（总指挥现场创建后即由本面板呈现）'
}

function agentWorkStateLabel(state: string): string {
  if (state === 'working') return '工作中'
  if (state === 'blocked') return '等待决策'
  if (state === 'done') return '已完成作业'
  if (state === 'idle') return '空闲'
  if (state === 'archived') return '已归档'
  return '未知'
}

function freshnessLine(phase: DevFlowClientLoadState['phase'], generatedAt: string): string {
  if (phase === 'refreshing') return `更新中…（上次 ${clock(generatedAt)}）`
  if (phase === 'error') return `上次成功 ${clock(generatedAt)}`
  return `更新 ${clock(generatedAt)}`
}

/**
 * Name the data path the panel is actually on. This is an honesty line, not a
 * decoration: while the channel is down the panel says so instead of letting the
 * 5-second polling pass as realtime.
 */
function channelLine(connection: DevFlowConnectionState | null): string {
  if (connection === null) return '实时通道未启用 · 轮询快照'
  if (connection.phase === 'live') return `实时通道已连接${connection.sequence === null ? '' : ` · 游标 #${connection.sequence}`}`
  if (connection.phase === 'connecting') return '实时通道连接中 · 轮询快照'
  return '实时通道已断开 · 轮询兜底'
}

function clock(at: string): string {
  const parsed = Date.parse(at)
  if (Number.isNaN(parsed)) return at
  return new Date(parsed).toLocaleTimeString('zh-CN', { hour12: false })
}

function nodeSubtitle(node: FlowNode): string {
  if (node.kind === 'requirement') return '用户需求 · 只读状态节点'
  if (node.kind === 'commander') return '拆解 · 派发 · 组织审计 · 验收'
  if (node.kind === 'temporary') return '临时子代理 · 由总指挥现场创建'
  return `固定员工 · 已交付 ${node.deliveryCount} 次`
}

function rosterSkillsLabel(agentId: string, skills: readonly string[] | undefined): string {
  if (agentId === 'commander') return '不适用（总指挥不写代码）'
  if (skills === undefined || skills.length === 0) return '暂未绑定'
  return skills.join('、')
}

function rosterCapabilitiesLabel(agentId: string, capabilities: readonly string[] | undefined): string {
  if (agentId === 'commander') return '需求分析、任务拆解、派发、验收'
  if (capabilities === undefined || capabilities.length === 0) return '未记录'
  return capabilities.join('、')
}

function rosterDelegationLabel(agentId: string, depth: number | undefined): string {
  const value = depth ?? 0
  if (agentId === 'commander') return `委派深度 ${value}：可以现场创建临时子代理（生命周期状态尚未与面板联动）`
  if (value <= 0) return `委派深度 ${value}：不能再派子代理`
  return `委派深度 ${value}：可继续派子代理`
}

function rosterCountLabel(agentId: string, count: number): string {
  if (agentId === 'commander') return `已派出 ${count} 次执行`
  if (agentId === 'code-auditor') return `已复核 ${count} 次`
  return `已交付 ${count} 次`
}

function seedPositions(flow: { readonly nodes: readonly FlowNode[] }): Positions {
  const positions: Record<string, { x: number; y: number }> = {}
  for (const node of flow.nodes) positions[node.id] = { x: node.x, y: node.y }
  return positions
}

/** `localStorage` access that never throws (private mode, disabled storage). */
function safeStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (minimum > maximum) return (minimum + maximum) / 2
  return Math.min(maximum, Math.max(minimum, value))
}

/**
 * `true` when at least one flow layer inside `root` is actually animating right now.
 *
 * The selector is the MOTION, not the state: an element hidden by CSS still carries
 * `data-flow-rate`, so the class list alone would keep the glass degraded forever.
 * A 25-element scan at {@link SAMPLE_MS} cadence is a bounded, cheap read that never
 * touches layout (`getComputedStyle(...).animationName` only re-resolves style).
 */
function motionRunning(root: HTMLElement): boolean {
  for (const group of root.querySelectorAll<SVGGElement>('g[data-flow-rate]')) {
    const rate = group.getAttribute('data-flow-rate')
    if (rate !== 'base' && rate !== 'strong' && rate !== 'weak') continue
    const layer = group.querySelector('.devflow-flow-flow')
    if (layer === null) continue
    if (window.getComputedStyle(layer).animationName !== 'none') return true
  }
  return false
}

/**
 * §11.1: publish the glass-vs-motion posture on the canvas root.
 *
 * Sampling is one `requestAnimationFrame` loop plus a {@link SAMPLE_MS} DOM read; it
 * neither renders nor notifies React, so a refresh cannot be triggered by the guard
 * itself. A manual `?devflow-glass=solid|glass` override short-circuits the automatic
 * rules so a reviewer can hold either path in a real browser.
 */
function useGlassMotionBudget(root: React.RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    const element = root.current
    if (element === null || typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') return
    const override = readGlassOverride(window.location.search)
    const budget = new MotionBudget()
    let frame = 0
    let timer: number | null = null
    let gaps: number[] = []
    let lastFrame = 0
    let lastMotionAt = 0
    let stopped = false

    const publish = (decision: { budget: 'auto' | 'degrade'; motion: 'idle' | 'active' | 'degraded' }): void => {
      const next = override === 'degrade' ? 'degrade' : override === 'glass' ? 'auto' : decision.budget
      const motion = override === 'degrade' ? 'degraded' : override === 'glass' ? 'idle' : decision.motion
      if (element.dataset.glassBudget !== next) element.dataset.glassBudget = next
      if (element.dataset.motion !== motion) element.dataset.motion = motion
      element.dataset.glassOverride = override
    }

    const read = (): void => {
      const running = motionRunning(element)
      const now = window.performance.now()
      if (running) lastMotionAt = now
      // "动画期间降级" holds for a short grace period after the last animated frame,
      // so a one-shot sweep or a two-frame repaint does not restore glass and then
      // degrade again (a visible flash).
      const active = running || now - lastMotionAt < MOTION_QUIET_MS
      publish(budget.sample({ animating: active, meanFrameMs: meanFrameMs(gaps) ?? Number.NaN }))
      gaps = []
    }

    const tick = (now: number): void => {
      if (stopped) return
      if (lastFrame !== 0) gaps.push(now - lastFrame)
      lastFrame = now
      frame = window.requestAnimationFrame(tick)
    }

    const start = (): void => {
      if (stopped || timer !== null) return
      lastFrame = 0
      gaps = []
      frame = window.requestAnimationFrame(tick)
      timer = window.setInterval(read, SAMPLE_MS)
      read()
    }
    const stop = (): void => {
      if (timer === null) return
      window.clearInterval(timer)
      timer = null
      if (frame !== 0) { window.cancelAnimationFrame(frame); frame = 0 }
      // Leaving the tab must not leave the canvas in a degraded skin the user never
      // sees restored: the posture is recomputed from scratch on the way back.
      lastMotionAt = 0
      gaps = []
    }
    const onVisibility = (): void => { if (document.visibilityState === 'hidden') stop(); else start() }

    if (document.visibilityState !== 'hidden') start()
    else publish({ budget: 'auto', motion: 'idle' })
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stopped = true
      document.removeEventListener('visibilitychange', onVisibility)
      stop()
    }
  // The posture follows the element only; every input is read live from the DOM.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
