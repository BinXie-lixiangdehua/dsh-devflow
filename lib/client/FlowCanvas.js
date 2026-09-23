import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CONNECTION_LOST_DETAIL } from "./store.js";
import { FLOW_NODE_WIDTH, FLOW_SEMANTIC_LABELS, createFlowModel, layoutEdges, } from "./flow-projection.js";
import { flowAgentName, shortId, workspaceBasename } from "./workspace.js";
import { FLOW_SKIN_LABELS, applySkinAttribute, readStoredSkin, resolveSkin, nextSkin, storeSkin, } from "./skin.js";
import { FLOW_DONE_SWEEP_MS, FLOW_ENTER_HISTORY_START, FLOW_ENTER_MS, changedEdges, freshlyDoneEdges, motionProfile, motionRate, newlyEnteredNodes, nodeIdSet } from "./motion.js";
import { MOTION_QUIET_MS, MotionBudget, SAMPLE_MS, meanFrameMs, readGlassOverride, } from "./motion-budget.js";
import { applyPausePresentation } from "./pause-presentation.js";
import { OVERVIEW_REOPEN_EVENT } from "./overview.js";
const NODE_HEIGHT = 118;
/**
 * Zoom floor. The round brief fixes the range at 0.4×–1.8×, and with the phase
 * rail gone (correction R2) the canvas is narrow enough that 0.4 still fits the
 * whole chain at the 420px column.
 */
const MIN_SCALE = 0.4;
const MAX_SCALE = 1.8;
const FIT_PADDING = 16;
/** Vertical space the floating overlays occupy at the top / bottom of the canvas. */
const FIT_TOP_RESERVE = 96;
const FIT_BOTTOM_RESERVE = 150;
/** Least amount of the world that must stay inside the viewport while panning. */
const MIN_VISIBLE = 96;
const RESIZE_EPSILON = 12;
/** Above this many edges, per-edge badges would cover the lanes; only these stay. */
const EDGE_LABEL_LIMIT = 12;
/** A single row wider than this is a data-density problem, and the panel says so. */
const WIDE_ROW_LIMIT = 6;
/**
 * Below this canvas width the inspector floats over the canvas instead of docking
 * (see the R2 measurement in the round report), so the drawing is never crushed.
 */
const INSPECTOR_DOCK_MIN = 680;
const VIEW_LABELS = {
    flow: '派发流', audit: '审计', tools: '本会话',
};
/**
 * The five states the LEGEND lists, in the order the round's design fixes them. The
 * 收尾终态 (closed) is deliberately a sixth, separate presentation: it is not one of the
 * five dispatch states, it is the statement that a dispatch was wrapped up. It is
 * therefore named by the badges/edges themselves and by the overview's own count, and
 * the five-state legend is left exactly as the previous rounds shipped it.
 */
const EDGE_STATES = ['queued', 'executing', 'done', 'rework', 'lost'];
const EDGE_STATE_TEXT = {
    queued: '排队/已接收', executing: '执行中', done: '已完成', rework: '返工', lost: '未收尾/失联', paused: '已暂停', closed: '已收尾',
};
const SEMANTIC_ORDER = ['requirement', 'dispatch', 'delivery', 'rework', 'subagent'];
const NODE_STATE_CLASS = {
    idle: '', active: 'run', pending: 'queue', blocked: 'wait', done: 'done', rework: 'bad', planned: 'queue', lost: 'lost', paused: 'paused', closed: 'closed',
};
/** What the canvas shows per relation, in words, next to the line sample. */
const SEMANTIC_SHAPE = {
    requirement: '点线 · 指向总指挥',
    dispatch: '实线 · 指向员工',
    delivery: '点划线 · 指回总指挥',
    rework: '长虚线 · 指向原员工',
    subagent: '点线 · 双向',
};
/** Render the dispatch-flow canvas plus its overlays, inspector and the secondary views. */
export function FlowCanvas(props) {
    const { model, phase, tab, onTabChange, auditPanel, toolsPanel, now, connection: channel, notice, onReopenOverview } = props;
    const [heights, setHeights] = useState({});
    const [showHistory, setShowHistory] = useState(false);
    const [legendOpen, setLegendOpen] = useState(false);
    const scope = showHistory ? 'history' : 'current';
    /**
     * §一·前.2: the pause posture is part of what the canvas SHOWS, so it is folded
     * into the same model the cards and the inspector read — one source of truth, no
     * second reading of the flag anywhere in the view.
     */
    const paused = model.snapshot.paused;
    const flow = useMemo(() => applyPausePresentation(createFlowModel(model, now, heights, scope), paused), [model, now, heights, scope, paused]);
    // The channel posture drives the polling fallback notice and the status line.
    const connection = channel ?? null;
    const viewportRef = useRef(null);
    /**
     * The viewport element itself, as state, so the ResizeObserver is re-attached
     * when the dock re-creates the pane (which it does when the right column
     * switches layout at narrow widths). Watching a detached node meant a resize
     * never re-fitted the canvas below ~1180px.
     */
    const [viewportHost, setViewportHost] = useState(null);
    const bindViewport = useCallback((element) => {
        viewportRef.current = element;
        setViewportHost(element);
    }, []);
    /** Canvas host width, used to decide dock vs overlay drawer for the inspector. */
    const [hostWidth, setHostWidth] = useState(0);
    const hostRef = useRef(null);
    const boxRefs = useRef(new Map());
    const sizeRef = useRef({ w: 0, h: 0 });
    /** Set as soon as the operator pans, zooms or drags; stops automatic fitting. */
    const viewTouchedRef = useRef(false);
    const [transform, setTransform] = useState({ scale: 0.75, x: 12, y: 12 });
    const [positions, setPositions] = useState(() => seedPositions(flow));
    const [pinned, setPinned] = useState([]);
    const [selection, setSelection] = useState(null);
    /** What the 阶段关联 list currently highlights on the canvas. */
    const [highlight, setHighlight] = useState(null);
    const [rosterOpen, setRosterOpen] = useState(false);
    const [rosterCards, setRosterCards] = useState([]);
    const [panning, setPanning] = useState(false);
    /**
     * Skin: the default is the dark-gold skin (step 3C); an explicit choice wins and
     * is remembered. The old "follow the system" branch is gone on purpose (see
     * `skin.ts` for the measured reason).
     */
    const [skin, setSkin] = useState(() => resolveSkin(readStoredSkin(safeStorage())));
    /** The canvas root, where the §11.1 glass budget posture is published for CSS. */
    const rootRef = useRef(null);
    /**
     * Edges that JUST became 已完成, which may play the single pass-through sweep.
     * The map is a ref so a data refresh never rebuilds the animation elements.
     */
    const previousStatesRef = useRef(new Map());
    /**
     * A SECOND history for the flowing re-arm, deliberately not shared with the sweep
     * above: both walk "previous vs current" and both mutate their map, so one shared
     * map would make whichever effect ran second compare against states the first had
     * already overwritten — the re-arm would then never see a change at all.
     */
    const changedStatesRef = useRef(new Map());
    const [freshDone, setFreshDone] = useState([]);
    /**
     * Edges a REAL state change moved in the last render. The flowing layer is
     * re-armed only for these, so animation phase is anchored to committed events
     * rather than to the render loop: an idle canvas re-arms nothing at all.
     */
    const [rearmedEdges, setRearmedEdges] = useState([]);
    /**
     * Bumped once per re-arm so the re-armed element's key actually changes. The
     * epoch is what makes a REPEATED change to the same edge restart its animation; a
     * key derived from the edge id alone would keep the element across renders and
     * leave the flow running from wherever it happened to be.
     */
    const [rearmEpoch, setRearmEpoch] = useState(0);
    const nodes = useMemo(() => flow.nodes.map(node => ({ ...node, ...(positions[node.id] ?? { x: node.x, y: node.y }) })), [flow, positions]);
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
    const previousNodeIdsRef = useRef(FLOW_ENTER_HISTORY_START);
    /** 首次渲染的节点集只在挂载时取一次，供入场标记的初值使用。 */
    const initialNodesRef = useRef(null);
    if (initialNodesRef.current === null)
        initialNodesRef.current = nodes;
    /**
     * 首帧的入场标记在**首次渲染时**就算好，让第一批 DOM 自带的 `data-enter="true"`；
     * effect 在挂载时只会看到"这几个 id 已经在 enteringNodes 里"，因此不会重复又播一遍。
     */
    const [enteringNodes, setEnteringNodes] = useState(() => newlyEnteredNodes(FLOW_ENTER_HISTORY_START, initialNodesRef.current ?? []));
    const heightOf = (nodeId) => heights[nodeId] ?? NODE_HEIGHT;
    const boxes = useMemo(() => new Map(nodes.map(node => [node.id, {
            x: node.x, y: node.y, width: node.kind === 'requirement' ? 208 : FLOW_NODE_WIDTH,
            height: heights[node.id] ?? NODE_HEIGHT,
        }])), [nodes, heights]);
    const edges = useMemo(() => layoutEdges(flow.edges, boxes), [flow, boxes]);
    const requirementEdge = useMemo(() => (flow.requirementEdge === null ? null : layoutEdges([flow.requirementEdge], boxes)[0] ?? null), [flow, boxes]);
    const heightsSignature = Object.entries(heights)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([id, value]) => `${id}:${value}`)
        .join('|');
    // Auto layout only places nodes the user has NOT placed by hand, so a refresh
    // can never snap a dragged node back (it is "pinned" until 重置布局).
    useEffect(() => {
        const manual = new Set(pinned);
        setPositions(previous => {
            let changed = false;
            const next = { ...previous };
            const seen = new Set();
            for (const node of flow.nodes) {
                seen.add(node.id);
                if (manual.has(node.id))
                    continue;
                const current = next[node.id];
                if (current === undefined || current.x !== node.x || current.y !== node.y) {
                    next[node.id] = { x: node.x, y: node.y };
                    changed = true;
                }
            }
            for (const id of Object.keys(next)) {
                if (!seen.has(id)) {
                    delete next[id];
                    changed = true;
                }
            }
            return changed ? next : previous;
        });
    }, [flow, pinned, heightsSignature]);
    // Measure after paint so edge anchors and the fit action use real geometry.
    useEffect(() => {
        setHeights(previous => {
            let changed = false;
            const next = { ...previous };
            boxRefs.current.forEach((element, id) => {
                // `offsetHeight` is the UNTRANSFORMED layout height. Measuring the bounding
                // rect here would read back the world's own scale, so every fit would inflate
                // the next one (and the cards would grow past the canvas).
                const measured = Math.round(element.offsetHeight);
                if (measured > 0 && next[id] !== measured) {
                    next[id] = measured;
                    changed = true;
                }
            });
            return changed ? next : previous;
        });
    }, [flow, transform.scale]);
    // Docking decision: the inspector docks only while it can sit beside a canvas
    // that is still usable; otherwise it becomes an overlay drawer.
    useEffect(() => {
        const host = hostRef.current;
        if (host === null || typeof ResizeObserver === 'undefined')
            return;
        const observer = new ResizeObserver(() => { setHostWidth(host.getBoundingClientRect().width); });
        observer.observe(host);
        setHostWidth(host.getBoundingClientRect().width);
        return () => { observer.disconnect(); };
    }, [tab]);
    // Fit only on a real box change: a text-only refresh must not move the view.
    // The observer always calls the LATEST fit through a ref, because the closure
    // captured when the observer was installed would still hold the first render's
    // canvas box (an empty-heights model) and would therefore fit the wrong size.
    const fittedForRef = useRef(0);
    const fitRef = useRef(() => undefined);
    fitRef.current = fit;
    useEffect(() => {
        if (viewportHost === null || typeof ResizeObserver === 'undefined')
            return;
        // A newly attached element starts from a clean baseline, so attaching always
        // produces one fit for the size it actually has.
        sizeRef.current = { w: 0, h: 0 };
        const observer = new ResizeObserver(() => {
            const rect = viewportHost.getBoundingClientRect();
            const previous = sizeRef.current;
            const first = previous.w === 0 && previous.h === 0;
            sizeRef.current = { w: rect.width, h: rect.height };
            if (!first && Math.abs(rect.width - previous.w) < RESIZE_EPSILON && Math.abs(rect.height - previous.h) < RESIZE_EPSILON)
                return;
            fitRef.current();
        });
        observer.observe(viewportHost);
        return () => { observer.disconnect(); };
        // `fit` reads live geometry through refs; the host element is the only input.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [viewportHost]);
    // Cards are measured after paint, so the FIRST fit still used the fallback
    // height. Re-fit whenever the measured layout no longer matches what fit
    // assumed, so the whole chain stays visible at any column width. A view the
    // operator already moved is never re-fitted automatically.
    useEffect(() => {
        if (pinned.length > 0 || viewTouchedRef.current)
            return;
        if (Math.abs(flow.canvasHeight - fittedForRef.current) < 24)
            return;
        fitRef.current();
        // `canvasHeight` covers the measured card heights, the corridor and the bands.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [heights, pinned, edges, flow.canvasHeight]);
    function fit() {
        const viewport = viewportRef.current;
        if (viewport === null)
            return;
        const rect = viewport.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0)
            return;
        // Fit the WHOLE canvas box, not just the card extents: the 阶段关联带 rail and
        // the leftmost lane live to the left of the leftmost card, and a fit that
        // ignores them hides exactly the structure this round added.
        const width = flow.canvasWidth;
        const height = flow.canvasHeight;
        fittedForRef.current = height;
        const top = FIT_TOP_RESERVE;
        const bottom = FIT_BOTTOM_RESERVE;
        const usableWidth = Math.max(80, rect.width - FIT_PADDING * 2);
        const usableHeight = Math.max(80, rect.height - top - bottom);
        const scale = clamp(Math.min(usableWidth / Math.max(width, 1), usableHeight / Math.max(height, 1)), MIN_SCALE, MAX_SCALE);
        setTransform({
            scale,
            x: FIT_PADDING + Math.max(0, (usableWidth - width * scale) / 2),
            y: top + Math.max(0, (usableHeight - height * scale) / 2),
        });
    }
    /** Explicit reset: drop user placement and return to the computed layout. */
    const resetLayout = useCallback(() => {
        viewTouchedRef.current = false;
        setPinned([]);
        setPositions(seedPositions(flow));
        setHeights({});
        window.requestAnimationFrame(() => { fitRef.current(); });
        // `fit` reads live geometry through refs and is intentionally not a dependency.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [flow]);
    // Escape closes the inspector, so a keyboard user is never trapped in it.
    useEffect(() => {
        const onKeyDown = (event) => {
            if (event.key === 'Escape') {
                setSelection(null);
                setHighlight(null);
                setLegendOpen(false);
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => { window.removeEventListener('keydown', onKeyDown); };
    }, []);
    // Publish the skin where CSS can read it (the pane wrapper is this element's
    // PARENT, so the theme attribute has to live on the document root).
    useEffect(() => {
        applySkinAttribute(document.documentElement, skin);
    }, [skin]);
    /**
     * The ONLY scripted part of the motion: notice when a dispatch turns 已完成 so it
     * can play its single sweep. The sweep itself is a CSS animation (no frame loop),
     * and the flag is cleared by one timer shortly after it starts.
     */
    useEffect(() => {
        const fresh = freshlyDoneEdges(previousStatesRef.current, edges);
        if (fresh.length === 0)
            return;
        // Union: a second dispatch finishing inside the window must not cut the first
        // one's sweep short (the flag is what drives the one-shot CSS animation).
        setFreshDone(previous => [...new Set([...previous, ...fresh])]);
        const timer = window.setTimeout(() => { setFreshDone([]); }, FLOW_DONE_SWEEP_MS);
        return () => { window.clearTimeout(timer); };
    }, [edges]);
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
        const changed = changedEdges(changedStatesRef.current, edges);
        if (changed.length === 0)
            return;
        setRearmedEdges(changed);
        setRearmEpoch(epoch => epoch + 1);
    }, [edges]);
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
        const entered = newlyEnteredNodes(previousNodeIdsRef.current, nodes);
        previousNodeIdsRef.current = nodeIdSet(nodes);
        if (entered.length === 0)
            return;
        setEnteringNodes(entered);
        const timer = window.setTimeout(() => { setEnteringNodes([]); }, FLOW_ENTER_MS);
        return () => { window.clearTimeout(timer); };
    }, [nodes]);
    /** Flip the skin and remember the choice from now on. */
    function toggleSkin() {
        const next = nextSkin(skin);
        storeSkin(safeStorage(), next);
        setSkin(next);
    }
    /**
     * §11.1 玻璃 × 动效的降级策略：动画运行期间把叠加的玻璃层降级为实色，动画停下
     * {@link MOTION_QUIET_MS} 后恢复；另加一道"持续长帧"的自适应兜底。判定结果写在
     * 画布根节点的 data-glass-budget / data-motion 上，供样式与取证读取。
     * 这里只切换背景与模糊，绝不改动布局、语义色或动效本身。
     */
    useGlassMotionBudget(rootRef);
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
        if (viewportHost === null)
            return;
        const onWheel = (event) => {
            // Always consume the gesture: zoom in/out, never scroll the pane or the page.
            event.preventDefault();
            event.stopPropagation();
            zoomAt(event.deltaY < 0 ? 1.08 : 0.92, event.clientX, event.clientY);
        };
        viewportHost.addEventListener('wheel', onWheel, { passive: false });
        return () => { viewportHost.removeEventListener('wheel', onWheel); };
        // `zoomAt` reads live geometry through refs and is intentionally not a dependency.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [viewportHost]);
    /** Clamp panning so a slice of the canvas always stays reachable. */
    function panTo(next) {
        const viewport = viewportRef.current;
        if (viewport === null)
            return next;
        const rect = viewport.getBoundingClientRect();
        const worldW = flow.canvasWidth * next.scale;
        const worldH = flow.canvasHeight * next.scale;
        return {
            scale: next.scale,
            x: clamp(next.x, Math.min(MIN_VISIBLE, rect.width) - worldW, Math.max(0, rect.width - MIN_VISIBLE)),
            y: clamp(next.y, Math.min(MIN_VISIBLE, rect.height) - worldH, Math.max(0, rect.height - MIN_VISIBLE)),
        };
    }
    function zoomBy(delta) {
        const viewport = viewportRef.current;
        if (viewport === null)
            return;
        const rect = viewport.getBoundingClientRect();
        const anchorX = rect.width / 2;
        const anchorY = rect.height / 2;
        viewTouchedRef.current = true;
        setTransform(current => {
            const scale = clamp(current.scale + delta, MIN_SCALE, MAX_SCALE);
            return panTo({
                scale,
                x: anchorX - (anchorX - current.x) * (scale / current.scale),
                y: anchorY - (anchorY - current.y) * (scale / current.scale),
            });
        });
    }
    function zoomAt(factor, clientX, clientY) {
        const viewport = viewportRef.current;
        if (viewport === null)
            return;
        const rect = viewport.getBoundingClientRect();
        const anchorX = clientX - rect.left;
        const anchorY = clientY - rect.top;
        viewTouchedRef.current = true;
        setTransform(current => {
            const scale = clamp(current.scale * factor, MIN_SCALE, MAX_SCALE);
            return panTo({
                scale,
                x: anchorX - (anchorX - current.x) * (scale / current.scale),
                y: anchorY - (anchorY - current.y) * (scale / current.scale),
            });
        });
    }
    function startPan(event) {
        if (event.button !== 0)
            return;
        const target = event.target;
        if (target.closest('[data-flow-node]') !== null)
            return;
        if (target.closest('[data-flow-edge]') !== null)
            return;
        if (target.closest('.devflow-flow-float') !== null)
            return;
        const startX = event.clientX;
        const startY = event.clientY;
        const origin = transform;
        let moved = 0;
        setPanning(true);
        const move = (moveEvent) => {
            moved += Math.abs(moveEvent.clientX - startX) + Math.abs(moveEvent.clientY - startY);
            viewTouchedRef.current = true;
            setTransform(panTo({
                scale: origin.scale,
                x: origin.x + (moveEvent.clientX - startX),
                y: origin.y + (moveEvent.clientY - startY),
            }));
        };
        const up = () => {
            setPanning(false);
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            // A plain background click means "dismiss", the usual inspector behaviour.
            if (moved < 4)
                setSelection(null);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    }
    function startNodeDrag(nodeId, event) {
        if (event.button !== 0)
            return;
        event.stopPropagation();
        const startX = event.clientX;
        const startY = event.clientY;
        const origin = positions[nodeId] ?? { x: 0, y: 0 };
        let moved = 0;
        const move = (moveEvent) => {
            const dx = (moveEvent.clientX - startX) / transform.scale;
            const dy = (moveEvent.clientY - startY) / transform.scale;
            moved += Math.abs(dx) + Math.abs(dy);
            viewTouchedRef.current = true;
            setPositions(current => ({ ...current, [nodeId]: { x: origin.x + dx, y: origin.y + dy } }));
        };
        const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            if (moved < 4)
                selectNode(nodeId);
            else
                setPinned(current => current.includes(nodeId) ? current : [...current, nodeId]);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    }
    /** A tap on a card opens its detail in the inspector — the card itself never grows. */
    function selectNode(nodeId) {
        setSelection({ kind: 'node', id: nodeId });
    }
    function selectEdge(edgeId) {
        setSelection({ kind: 'edge', id: edgeId });
    }
    function toggleRosterCard(agentId) {
        setRosterCards(current => current.includes(agentId)
            ? current.filter(id => id !== agentId)
            : [...current, agentId]);
    }
    const selectedEdge = selection?.kind === 'edge'
        ? edges.find(edge => edge.id === selection.id) ?? null
        : null;
    const selectedNode = selection?.kind === 'node'
        ? nodes.find(node => node.id === selection.id) ?? null
        : null;
    const selectedBand = selection?.kind === 'phase'
        ? flow.bands.find(band => band.id === selection.id) ?? null
        : null;
    const docked = hostWidth >= INSPECTOR_DOCK_MIN;
    const inspectorMode = selection === null ? 'closed' : docked ? 'dock' : 'drawer';
    /**
     * Which nodes/edges the 阶段关联 list currently highlights: a single task, or
     * every task and dispatch of one phase.
     */
    const highlightedTasks = highlight === null
        ? new Set()
        : highlight.kind === 'task'
            ? new Set([highlight.id])
            : new Set((flow.bands.find(band => band.id === highlight.id)?.tasks ?? []).map(task => task.id));
    const highlightedPhase = highlight !== null && highlight.kind === 'phase' ? highlight.id : null;
    const isHighlighted = (taskId, phaseId) => taskId !== null && (highlightedTasks.has(taskId) || (phaseId !== null && phaseId === highlightedPhase));
    const roster = model.agents.filter(item => item.agent.kind === 'fixed');
    const temporaryRoster = model.agents.filter(item => item.agent.kind === 'temporary');
    const runningIds = new Set(nodes.filter(node => node.state === 'active').map(node => node.id));
    const session = model.snapshot.session;
    /**
     * The panel's project identifier (第九步).
     *
     * It names THIS session's project — the workspace the session is isolated to —
     * not a machine-wide shared root. The project name comes from the durable
     * project record; the workspace path is what makes two same-named projects
     * distinguishable, and the full path is carried verbatim so an operator can
     * copy it. `（未初始化）` keeps meaning "no project record in this workspace".
     */
    const projectName = model.snapshot.project?.name ?? '（未初始化）';
    const workspacePath = session.workspacePath ?? null;
    const workspaceLabel = workspacePath === null ? null : workspaceBasename(workspacePath);
    const identityLine = [
        workspacePath === null
            ? `本项目 ${projectName}`
            : `本项目 ${projectName} @ ${workspaceLabel}`,
        session.commanderMode === 'commander' ? '本会话已绑定总指挥' : '本会话未绑定总指挥',
        `会话 ${shortId(session.id, 12)}`,
        model.snapshot.paused ? '派发已暂停' : '派发中',
        freshnessLine(phase, model.snapshot.generatedAt),
        channelLine(connection),
    ].join(' ｜ ');
    const labelled = (edge) => edges.length <= EDGE_LABEL_LIMIT
        || edge.id === selection?.id
        || edge.semantic === 'rework';
    return _jsxs("div", { className: 'devflow-flow', "data-skin": skin, "data-paused": paused, ref: rootRef, children: [tab !== 'flow' && _jsxs("div", { className: 'devflow-flow-panel devflow-flow-secondary', role: "tabpanel", children: [_jsxs("header", { className: 'devflow-flow-secondaryhead', children: [_jsx("button", { type: "button", onClick: () => { onTabChange('flow'); }, children: "\u2190 \u8FD4\u56DE\u6D3E\u53D1\u6D41\u753B\u5E03" }), _jsx("strong", { children: VIEW_LABELS[tab] })] }), _jsx("div", { className: 'devflow-flow-secondarybody', children: tab === 'audit' ? auditPanel : toolsPanel })] }), tab === 'flow' && _jsxs("div", { className: 'devflow-flow-canvas', role: "tabpanel", "data-inspector": inspectorMode, ref: hostRef, children: [_jsxs("div", { className: 'devflow-flow-viewport', "data-panning": panning, ref: bindViewport, onPointerDown: startPan, children: [_jsx("div", { className: 'devflow-flow-grid', "aria-hidden": "true" }), _jsxs("div", { className: 'devflow-flow-world', style: {
                                    width: flow.canvasWidth,
                                    height: flow.canvasHeight,
                                    transform: `translate(${Math.round(transform.x)}px, ${Math.round(transform.y)}px) scale(${transform.scale})`,
                                }, children: [_jsxs("svg", { className: 'devflow-flow-edges', width: flow.canvasWidth, height: flow.canvasHeight, "aria-hidden": "true", children: [requirementEdge !== null && requirementEdge.path !== '' && _jsxs("g", { children: [_jsx("path", { className: 'devflow-flow-edge', "data-edge-semantic": requirementEdge.semantic, "data-edge-id": requirementEdge.id, "data-edge-from": requirementEdge.from, "data-edge-to": requirementEdge.to, d: requirementEdge.path }), _jsx("path", { className: 'devflow-flow-arrow', "data-edge-semantic": requirementEdge.semantic, d: requirementEdge.arrowPath })] }, requirementEdge.id), edges.filter(edge => edge.path !== '').map(edge => {
                                                const motion = motionProfile(edge.state, paused);
                                                const fresh = freshDone.includes(edge.id);
                                                // A real change re-arms the flow: the key makes React replace the
                                                // element, which restarts the CSS animation from its first frame. An
                                                // unchanged edge keeps its element, so its phase is never reset and an
                                                // idle canvas never re-triggers anything.
                                                const rearmed = rearmedEdges.includes(edge.id);
                                                return _jsxs("g", { "data-flow-rate": motionRate(motion), "data-highlight": isHighlighted(edge.taskId, edge.phaseId), "data-fresh": fresh ? 'true' : 'false', "data-rearmed": rearmed ? 'true' : 'false', style: { opacity: motion.opacity }, children: [_jsx("path", { className: 'devflow-flow-edge', "data-edge-state": edge.state, "data-edge-semantic": edge.semantic, "data-edge-id": edge.id, "data-edge-from": edge.from, "data-edge-to": edge.to, "data-selected": edge.id === selection?.id, d: edge.path }), _jsx("path", { className: 'devflow-flow-arrow', "data-edge-semantic": edge.semantic, "data-arrow-state": edge.state, d: edge.arrowPath }), _jsx("path", { className: 'devflow-flow-flow', "data-flow-overlay": edge.id, style: motion.flowing ? { animationDuration: `${motion.durationSeconds}s` } : undefined, d: edge.path }, rearmed ? `${edge.id}:${rearmEpoch}` : edge.id), _jsx("path", { className: 'devflow-flow-sweep', "data-flow-sweep": edge.id, pathLength: 100, d: edge.path }), _jsx("path", { className: 'devflow-flow-edge-hit', "data-flow-edge": edge.id, "data-stale-reason": edge.handoff.statusLabel, d: edge.path, onClick: event => {
                                                                event.stopPropagation();
                                                                selectEdge(edge.id);
                                                            } }), labelled(edge) && _jsx("text", { className: 'devflow-flow-edge-label', x: edge.labelX, y: edge.labelY, textAnchor: "middle", children: edge.badge })] }, edge.id);
                                            })] }), nodes.map(node => _jsxs("div", { ref: element => {
                                            if (element === null)
                                                boxRefs.current.delete(node.id);
                                            else
                                                boxRefs.current.set(node.id, element);
                                        }, className: 'devflow-flow-card', "data-flow-node": node.id, "data-kind": node.kind, "data-state": node.state, "data-enter": enteringNodes.includes(node.id) ? 'true' : 'false', "data-selected": selectedNode?.id === node.id, "data-highlight": isHighlighted(node.taskId, null), "data-card-h": heightOf(node.id), style: { left: node.x, top: node.y, width: node.kind === 'requirement' ? 208 : FLOW_NODE_WIDTH }, onPointerDown: event => { startNodeDrag(node.id, event); }, children: [_jsxs("p", { className: 'devflow-flow-name', children: [node.label, node.kind === 'requirement' && _jsx("span", { className: 'devflow-flow-tag user', children: node.sourceLabel }), node.kind === 'temporary' && _jsx("span", { className: 'devflow-flow-tag subagent', children: "\u5B50\u4EE3\u7406" })] }), _jsx("p", { className: 'devflow-flow-sub', children: nodeSubtitle(node) }), node.taskTitle !== null && _jsx("p", { className: 'devflow-flow-task', children: node.taskTitle }), _jsx("span", { className: `devflow-flow-badge ${NODE_STATE_CLASS[node.state]}`, children: node.stateLabel })] }, node.id))] }), _jsxs("div", { className: 'devflow-flow-float devflow-flow-info', "data-freshness": phase, "data-connection": connection?.phase ?? 'off', "data-skin": skin, children: [_jsxs("div", { className: 'devflow-flow-identrow', children: [_jsx("span", { className: 'devflow-flow-ident devflow-freshness', "data-freshness": phase, "data-connection": connection?.phase ?? 'off', "data-project-workspace": workspacePath ?? 'none', title: workspacePath === null ? session.id : `${session.id} · ${workspacePath}`, children: identityLine }), _jsx("button", { type: "button", className: 'devflow-flow-skin', "data-skin": skin, "aria-label": FLOW_SKIN_LABELS[skin].label, title: `${FLOW_SKIN_LABELS[skin].label} · ${FLOW_SKIN_LABELS[skin].hint}`, onClick: toggleSkin, children: _jsx("span", { className: 'devflow-flow-skinicon', "data-shape": skin === 'light' ? 'moon' : 'ring', "aria-hidden": "true" }) }), _jsx("button", { type: "button", className: 'devflow-flow-skin', "data-role": "overview-reopen", "aria-label": "\u91CD\u65B0\u6253\u5F00\u53F3\u4E0A\u89D2\u6982\u89C8\u6D6E\u5C42", title: "\u91CD\u65B0\u6253\u5F00\u53F3\u4E0A\u89D2\u6982\u89C8\u6D6E\u5C42", onClick: () => { onReopenOverview === undefined ? window.dispatchEvent(new Event(OVERVIEW_REOPEN_EVENT)) : onReopenOverview(); }, children: _jsx("span", { className: 'devflow-flow-overviewicon', "aria-hidden": "true" }) })] }), connection?.phase === 'polling' && _jsxs("span", { className: 'devflow-flow-channel', "data-connection": "polling", role: "status", children: [connection.detail ?? CONNECTION_LOST_DETAIL, "\uFF08\u753B\u5E03\u4ECD\u5728\u6BCF 5 \u79D2\u62C9\u53D6\u5FEB\u7167\uFF0C\u91CD\u8FDE\u6210\u529F\u540E\u81EA\u52A8\u6062\u590D\u5B9E\u65F6\u66F4\u65B0\uFF09"] }), connection?.phase === 'connecting' && _jsx("span", { className: 'devflow-flow-channel', "data-connection": "connecting", role: "status", children: "\u6B63\u5728\u5EFA\u7ACB\u5B9E\u65F6\u901A\u9053\u2026\uFF08\u5F53\u524D\u6309 5 \u79D2\u8F6E\u8BE2\u5FEB\u7167\uFF09" }), _jsxs("span", { className: 'devflow-flow-zoomchip', children: ["\u7F29\u653E ", Math.round(transform.scale * 100), "%"] })] }), _jsxs("div", { className: 'devflow-flow-float devflow-flow-bottomstack', children: [_jsxs("div", { className: 'devflow-flow-bottom', children: [_jsxs("span", { className: 'devflow-flow-hint', children: ["\u62D6\u52A8\u7A7A\u767D\u5904\u5E73\u79FB \u00B7 \u6EDA\u8F6E\u7F29\u653E \u00B7 \u62D6\u52A8\u5361\u7247 \u00B7 \u70B9\u5361\u7247\u770B\u8BE6\u60C5 \u00B7 ", _jsx("b", { children: "\u70B9\u8FDE\u7EBF\u770B\u8FD9\u6B21\u6D3E\u53D1\u7684\u4EFB\u52A1" })] }), _jsxs("span", { className: 'devflow-flow-notices', children: [notice !== null && notice !== undefined && _jsx("span", { role: "status", children: notice }), flow.visibleAgentIds.length === 0 && _jsx("span", { role: "status", children: "\u753B\u5E03\u521D\u59CB\u53EA\u6709\u603B\u6307\u6325\uFF1A\u7528\u5230\u8C01\u624D\u4F1A\u88AB\u8C03\u7528\u4E0B\u6765\u5E76\u8FDE\u7EBF\u3002" }), flow.visibleAgentIds.length > WIDE_ROW_LIMIT && _jsxs("span", { role: "status", children: ["\u540C\u5C42 ", flow.visibleAgentIds.length, " \u4F4D\u5458\u5DE5\u843D\u5728\u540C\u4E00\u884C\uFF0C\u753B\u5E03\u4F1A\u53D8\u5BBD\uFF1B\u8FD9\u662F\u6570\u636E\u4FA7\u5BC6\u5EA6\u95EE\u9898\uFF0C\u4E0D\u662F\u8FDE\u7EBF\u95EE\u9898\u3002"] }), flow.lostCount > 0 && _jsxs("span", { role: "status", children: ["\u5176\u4E2D ", flow.lostCount, " \u6761\u6D3E\u53D1\u6CA1\u6709\u6B63\u5728\u8FD0\u884C\u7684\u6267\u884C\u8BB0\u5F55\uFF0C\u5DF2\u6309\u300C\u672A\u6536\u5C3E \u00B7 \u5DF2\u5931\u8054\u300D\u6807\u51FA\uFF08\u5386\u53F2\u6570\u636E\u672A\u6E05\u7406\uFF09"] }), flow.unroutedCount > 0 && _jsxs("span", { role: "status", children: ["\u53E6\u6709 ", flow.unroutedCount, " \u6761\u6D3E\u53D1\u7684\u5458\u5DE5\u4E0D\u5728\u5F53\u524D\u5FEB\u7167\uFF0C\u65E0\u6CD5\u843D\u70B9\uFF08\u4E0D\u753B\u60AC\u7A7A\u8FDE\u7EBF\uFF09"] }), flow.history.edges.length > flow.current.edges.length && _jsx("span", { role: "status", children: showHistory
                                                            ? `正在显示全部 ${flow.history.edges.length} 条历史派发边（每次交接各自一条，未合并）`
                                                            : `已隐藏 ${flow.history.edges.length - flow.current.edges.length} 条历史派发边（工具栏 ⇥ 全部历史可展开）` })] })] }), _jsxs("span", { className: 'devflow-flow-legend', "aria-label": "\u8FDE\u7EBF\u56FE\u4F8B", children: [_jsx("span", { className: 'devflow-flow-legendgroup', "data-legend-group": "semantic", children: SEMANTIC_ORDER.map(semantic => _jsxs("span", { "data-legend-kind": "semantic", "data-semantic": semantic, title: `关系：${FLOW_SEMANTIC_LABELS[semantic]}（${SEMANTIC_SHAPE[semantic]}）`, children: [_jsx("i", { className: `devflow-flow-line is-${semantic}`, "aria-hidden": "true" }), FLOW_SEMANTIC_LABELS[semantic]] }, semantic)) }), _jsx("span", { className: 'devflow-flow-legendgroup', "data-legend-group": "state", children: EDGE_STATES.map(value => _jsxs("span", { "data-legend-kind": "state", "data-state": value, children: [_jsx("i", { className: `devflow-flow-swatch is-${value}`, "aria-hidden": "true" }), EDGE_STATE_TEXT[value]] }, value)) }), _jsx("button", { type: "button", className: 'devflow-flow-legendtoggle', "aria-expanded": legendOpen, onClick: () => { setLegendOpen(open => !open); }, children: legendOpen ? '收起图例' : '图例说明' })] }), _jsxs("div", { className: 'devflow-flow-bottomrow', children: [_jsxs("span", { className: 'devflow-flow-concurrency', "data-at-limit": flow.concurrency.atLimit, role: "status", "aria-label": `并发上限 ${flow.concurrency.running}/${flow.concurrency.limit}`, title: `同时最多 ${flow.concurrency.limit} 个派发在执行；达到上限后新的派发排队等待，不会丢`, children: [_jsxs("b", { children: ["\u5E76\u53D1 ", flow.concurrency.running, "/", flow.concurrency.limit] }), flow.concurrency.atLimit && _jsx("span", { className: 'devflow-flow-concurrencynote', children: "\u5DF2\u8FBE\u5E76\u53D1\u4E0A\u9650 \u00B7 \u540E\u7EED\u6392\u961F" })] }), _jsxs("div", { className: 'devflow-flow-roster', "data-open": rosterOpen, children: [_jsxs("button", { type: "button", className: 'devflow-flow-rosterhead', "aria-expanded": rosterOpen, onClick: () => { setRosterOpen(open => !open); }, children: [_jsx("span", { className: 'devflow-flow-rosterkicker', children: "\u5458\u5DE5\u540D\u518C" }), _jsxs("strong", { children: ["\u56FA\u5B9A\u5458\u5DE5 \u00B7 ", roster.length, " \u4EBA / \u4E34\u65F6\u5B50\u4EE3\u7406 \u00B7 ", temporaryRoster.length, " \u4EBA"] }), _jsx("span", { className: 'devflow-flow-rosterhint', children: rosterOpen ? '收起' : '展开' })] }), rosterOpen && _jsxs("div", { className: 'devflow-flow-rosterbody', children: [roster.map(item => _jsxs("div", { className: 'devflow-flow-pcard', "data-open": rosterCards.includes(item.agent.id), children: [_jsxs("button", { type: "button", className: 'devflow-flow-pcardbutton', onClick: () => { toggleRosterCard(item.agent.id); }, children: [_jsx("strong", { children: flowAgentName(item.agent.id, item.agent.displayName) }), runningIds.has(item.agent.id) && _jsx("span", { className: 'devflow-flow-tag live', children: "\u8FD0\u884C\u4E2D" }), item.agent.id !== flow.commanderId && (item.agent.skills ?? []).length === 0 && _jsx("span", { className: 'devflow-flow-tag', children: "\u6682\u672A\u7ED1\u5B9A" }), _jsx("small", { children: rosterCountLabel(item.agent.id, item.executions.filter(execution => execution.status === 'completed').length) })] }), rosterCards.includes(item.agent.id) && _jsxs("div", { className: 'devflow-flow-pdet', children: [_jsxs("p", { children: ["\u6280\u80FD\uFF1A", rosterSkillsLabel(item.agent.id, item.agent.skills)] }), _jsxs("p", { children: ["\u80FD\u529B\uFF1A", rosterCapabilitiesLabel(item.agent.id, item.agent.capabilities)] }), _jsxs("p", { children: ["\u6A21\u578B\uFF1A", item.agent.provider === undefined ? item.agent.model : `${item.agent.provider} · ${item.agent.model}`] }), _jsx("p", { children: rosterDelegationLabel(item.agent.id, item.agent.delegationDepth) }), _jsxs("p", { children: ["\u72B6\u6001\uFF1A", agentWorkStateLabel(item.workState)] })] })] }, item.agent.id)), _jsxs("div", { className: 'devflow-flow-rostergroup', children: [_jsxs("strong", { children: ["\u4E34\u65F6\u5B50\u4EE3\u7406 \u00B7 ", temporaryRoster.length, " \u4EBA"] }), temporaryRoster.length === 0
                                                                        ? _jsx("small", { children: "\u672C\u6B21\u4F1A\u8BDD\u5C1A\u672A\u521B\u5EFA\u4E34\u65F6\u5B50\u4EE3\u7406\uFF08\u53EA\u80FD\u7531\u603B\u6307\u6325\u73B0\u573A\u521B\u5EFA \u00B7 1\u20132 \u5C42\uFF09\u3002" })
                                                                        : temporaryRoster.map(item => _jsxs("div", { className: 'devflow-flow-pcard', "data-open": rosterCards.includes(item.agent.id), children: [_jsxs("button", { type: "button", className: 'devflow-flow-pcardbutton', onClick: () => { toggleRosterCard(item.agent.id); }, children: [_jsx("strong", { children: flowAgentName(item.agent.id, item.agent.displayName) }), _jsx("span", { className: 'devflow-flow-tag', children: "\u4E34\u65F6\u5B50\u4EE3\u7406" }), runningIds.has(item.agent.id) && _jsx("span", { className: 'devflow-flow-tag live', children: "\u8FD0\u884C\u4E2D" }), _jsx("small", { children: rosterCountLabel(item.agent.id, item.executions.filter(execution => execution.status === 'completed').length) })] }), rosterCards.includes(item.agent.id) && _jsxs("div", { className: 'devflow-flow-pdet', children: [_jsxs("p", { children: ["\u6280\u80FD\uFF1A", rosterSkillsLabel(item.agent.id, item.agent.skills)] }), _jsxs("p", { children: ["\u80FD\u529B\uFF1A", rosterCapabilitiesLabel(item.agent.id, item.agent.capabilities)] }), _jsxs("p", { children: ["\u6A21\u578B\uFF1A", item.agent.provider === undefined ? item.agent.model : `${item.agent.provider} · ${item.agent.model}`] }), _jsx("p", { children: rosterDelegationLabel(item.agent.id, item.agent.delegationDepth) }), _jsxs("p", { children: ["\u72B6\u6001\uFF1A", agentWorkStateLabel(item.workState)] })] })] }, item.agent.id))] }), _jsxs("div", { className: 'devflow-flow-pcard', "data-plan": "true", children: [_jsxs("strong", { children: ["\u4E34\u65F6\u5B50\u4EE3\u7406 ", _jsx("span", { className: 'devflow-flow-tag live', children: temporaryRoster.length > 0 ? `已启用 · ${temporaryRoster.length} 人` : '设计目标' })] }), _jsx("small", { children: "\u53EA\u80FD\u7531\u603B\u6307\u6325\u73B0\u573A\u521B\u5EFA \u00B7 1\u20132 \u5C42" }), _jsxs("div", { className: 'devflow-flow-pdet', children: [_jsxs("p", { children: ["\u521B\u5EFA\u8005\u662F\u603B\u6307\u6325\uFF08\u56FA\u5B9A\u5458\u5DE5 ", _jsx("code", { children: "delegationDepth = 0" }), "\uFF0C\u6CA1\u6709\u59D4\u6D3E\u80FD\u529B\uFF09\u3002"] }), _jsxs("p", { children: ["\u4E34\u65F6\u5B50\u4EE3\u7406\u7531\u603B\u6307\u6325\u73B0\u573A\u521B\u5EFA\u5E76\u6D3E\u53D1\uFF1B\u5176\u751F\u547D\u5468\u671F\u72B6\u6001\uFF08\u8FD0\u884C\u4E2D / \u5DF2\u7EC8\u6B62\uFF09\u5C1A\u672A\u4E0E\u9762\u677F\u8054\u52A8\uFF0C\u8282\u70B9\u72B6\u6001\u6682\u6309\u6267\u884C\u8BB0\u5F55\u63A8\u5BFC\u3002\u5F53\u524D\u5FEB\u7167\u6709 ", temporaryRoster.length, " \u4E2A\u4E34\u65F6 Agent \u8BB0\u5F55\u3002"] })] })] })] })] }), _jsxs("div", { className: 'devflow-flow-toolbar', children: [_jsx("button", { type: "button", className: 'devflow-flow-action', "data-primary": "true", title: "\u9002\u914D\u89C6\u56FE\uFF08\u91CD\u7F6E\u7F29\u653E\u5E76\u5E73\u79FB\u5230\u5168\u90E8\u8282\u70B9\u53EF\u89C1\uFF09", "aria-label": "\u9002\u914D\u89C6\u56FE", onClick: () => { fit(); }, children: "\u2922" }), _jsx("button", { type: "button", className: 'devflow-flow-action', title: "\u653E\u5927", "aria-label": "\u653E\u5927", onClick: () => { zoomBy(0.15); }, children: "\uFF0B" }), _jsx("button", { type: "button", className: 'devflow-flow-action', title: "\u7F29\u5C0F", "aria-label": "\u7F29\u5C0F", onClick: () => { zoomBy(-0.15); }, children: "\uFF0D" }), _jsx("button", { type: "button", className: 'devflow-flow-action', "data-primary": showHistory, "aria-pressed": showHistory, title: showHistory ? '只看当前链路' : '显示全部历史链路', "aria-label": showHistory ? '只看当前链路' : '全部历史链路', onClick: () => { setShowHistory(value => !value); window.requestAnimationFrame(() => { fit(); }); }, children: showHistory ? '⇤ 当前链路' : '⇥ 全部历史' }), _jsx("button", { type: "button", className: 'devflow-flow-action', title: "\u91CD\u7F6E\u5E03\u5C40\uFF08\u56DE\u5230\u81EA\u52A8\u5E03\u5C40\u5E76\u6062\u590D\u81EA\u52A8\u9002\u914D\uFF09", "aria-label": "\u91CD\u7F6E\u5E03\u5C40", onClick: resetLayout, children: "\u27F3 \u91CD\u7F6E\u5E03\u5C40" }), _jsx("span", { className: 'devflow-flow-viewswitch', children: ['audit', 'tools'].map(view => _jsx("button", { type: "button", className: 'devflow-flow-action', onClick: () => { onTabChange(view); }, children: VIEW_LABELS[view] }, view)) })] })] })] }), legendOpen && _jsxs("section", { className: 'devflow-flow-float devflow-flow-legendpanel', "aria-label": "\u56FE\u4F8B\u8BF4\u660E", children: [_jsx("h3", { children: "\u5173\u7CFB\uFF08\u770B\u7EBF\u578B\u4E0E\u7BAD\u5934\u65B9\u5411\uFF09" }), _jsx("ul", { children: SEMANTIC_ORDER.map(semantic => _jsxs("li", { children: [_jsx("i", { className: `devflow-flow-line is-${semantic}`, "aria-hidden": "true" }), semanticLine(semantic)] }, semantic)) }), _jsx("h3", { children: "\u72B6\u6001\uFF08\u53EA\u770B\u989C\u8272\uFF09" }), _jsx("ul", { children: EDGE_STATES.map(value => _jsxs("li", { children: [_jsx("i", { className: `devflow-flow-swatch is-${value}`, "aria-hidden": "true" }), EDGE_STATE_TEXT[value]] }, value)) }), _jsx("p", { className: 'devflow-flow-legendnote', children: "\u9636\u6BB5\u5173\u8054\u5E26\u6309\u9636\u6BB5\u628A\u540C\u9636\u6BB5\u7684\u6D3E\u53D1\u5206\u7EC4\u663E\u793A\uFF1B\u6BCF\u4E00\u6B21\u4EA4\u63A5\u90FD\u5404\u81EA\u6210\u8FB9\uFF0C\u4E0D\u505A\u5408\u5E76\u3002" }), _jsx("button", { type: "button", className: 'devflow-flow-xferclose', onClick: () => { setLegendOpen(false); }, children: "\u6536\u8D77" })] }), flow.concurrency.running > 1 && _jsxs("p", { className: 'devflow-flow-float devflow-flow-note', role: "status", children: ["\u5FEB\u7167\u4E2D\u6709 ", flow.concurrency.running, " \u6761\u6267\u884C\u8BB0\u5F55\u6B63\u5728\u8FD0\u884C\uFF0C\u753B\u5E03\u5982\u5B9E\u628A\u6BCF\u4E00\u6761\u90FD\u6807\u4E3A\u300C\u6267\u884C\u4E2D\u300D\u3002\u540C\u8F6E\u6D3E\u53D1\u5F7C\u6B64\u72EC\u7ACB\u3001\u540C\u65F6\u63A8\u8FDB\uFF1B\u540C\u65F6\u6700\u591A ", flow.concurrency.limit, " \u6761\uFF0C\u8FBE\u5230\u4E0A\u9650\u540E\u65B0\u7684\u6D3E\u53D1\u6309\u300C\u6392\u961F\u4E2D\u300D\u7B49\u5F85\uFF0C\u4E0D\u4F1A\u6084\u6084\u5EF6\u540E\u3002"] })] }), selection !== null && _jsx(FlowInspector, { mode: docked ? 'dock' : 'drawer', flow: flow, edges: edges, node: selectedNode, edge: selectedEdge, band: selectedBand, highlight: highlight, onClose: () => { setSelection(null); setHighlight(null); }, onSelectNode: selectNode, onSelectEdge: selectEdge, onSelectBand: bandId => { setSelection({ kind: 'phase', id: bandId }); setHighlight({ kind: 'phase', id: bandId }); }, onHighlightTask: taskId => { setHighlight(current => current?.kind === 'task' && current.id === taskId ? null : { kind: 'task', id: taskId }); } })] })] });
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
export function FlowInspector(props) {
    const { mode, flow, edges, node, edge, band, highlight, onClose, onSelectNode: _onSelectNode, onSelectEdge, onSelectBand, onHighlightTask } = props;
    const title = node !== null ? node.label : edge !== null ? edge.handoff.title : band !== null ? band.name : '详情';
    const kicker = node !== null ? '节点详情' : edge !== null ? '交接详情' : '阶段关联';
    const relatedEdges = node === null ? [] : edges.filter(item => item.from === node.id || item.to === node.id);
    const bandEdges = band === null ? [] : edges.filter(item => item.phaseId === band.id);
    return _jsxs("aside", { className: 'devflow-flow-inspector', "data-mode": mode, "aria-label": kicker, children: [_jsxs("header", { className: 'devflow-flow-inspectorhead', children: [_jsxs("div", { children: [_jsx("p", { className: 'devflow-kicker', children: kicker }), _jsx("h3", { children: title })] }), _jsx("button", { type: "button", className: 'devflow-flow-inspectorclose', "aria-label": "\u5173\u95ED\u8BE6\u60C5", onClick: onClose, children: "\u2715" })] }), node !== null && _jsxs(_Fragment, { children: [_jsxs("dl", { className: 'devflow-flow-table', children: [_jsxs("div", { children: [_jsx("dt", { children: "\u89D2\u8272 / id" }), _jsxs("dd", { children: [node.roleLabel, " \u00B7 ", node.id] })] }), node.sourceLabel !== null && _jsxs("div", { children: [_jsx("dt", { children: "\u6765\u6E90" }), _jsxs("dd", { children: [node.sourceLabel, "\uFF08\u53EA\u8BFB\u72B6\u6001\u8282\u70B9\uFF09"] })] }), _jsxs("div", { children: [_jsx("dt", { children: "\u59D4\u6D3E\u6DF1\u5EA6" }), _jsx("dd", { children: node.delegationLabel })] }), _jsxs("div", { children: [_jsx("dt", { children: "\u5B50\u4EE3\u7406" }), _jsx("dd", { children: node.subagentNote })] }), _jsxs("div", { children: [_jsx("dt", { children: "\u80FD\u529B" }), _jsx("dd", { children: node.capabilitiesLabel })] }), _jsxs("div", { children: [_jsx("dt", { children: "\u6A21\u578B" }), _jsx("dd", { children: node.modelLabel === '' ? '不适用' : node.modelLabel })] }), _jsxs("div", { children: [_jsx("dt", { children: "\u7ED1\u5B9A\u6280\u80FD" }), _jsx("dd", { children: node.skillsLabel })] }), _jsxs("div", { children: [_jsx("dt", { children: "\u672C\u4EFB\u52A1\u6280\u80FD" }), _jsx("dd", { children: node.dispatchSkillsLabel })] }), _jsxs("div", { children: [_jsx("dt", { children: "\u5DF2\u4EA4\u4ED8" }), _jsxs("dd", { children: [node.deliveryCount, " \u6B21"] })] }), _jsxs("div", { children: [_jsx("dt", { children: "\u72B6\u6001" }), _jsxs("dd", { children: [node.stateLabel, node.taskStateLabel === null ? '' : ` · ${node.taskStateLabel}`] })] }), node.executionLabel !== null && _jsxs("div", { children: [_jsx("dt", { children: "\u6267\u884C" }), _jsx("dd", { children: node.executionLabel })] })] }), _jsx("h4", { className: 'devflow-flow-inspectorsection', children: node.kind === 'requirement' ? '需求全文' : '当前任务' }), node.taskTitle === null
                        ? _jsx("p", { className: 'devflow-flow-mutedline', children: "\u5F53\u524D\u6CA1\u6709\u5173\u8054\u7684\u6D3E\u53D1\u4EFB\u52A1\u3002" })
                        : _jsxs(_Fragment, { children: [_jsxs("p", { className: 'devflow-flow-inspectortask', children: [node.taskTitle, node.taskId === null ? '' : `（${shortId(node.taskId, 14)}）`] }), node.taskDescription !== null && _jsx("p", { className: 'devflow-flow-xferdetail', children: node.taskDescription }), node.kind === 'requirement' && _jsx("p", { className: 'devflow-flow-mutedline', children: "\u7528\u6237\u9700\u6C42\u8282\u70B9\u4E0D\u627F\u8F7D\u6D3E\u53D1\u4EFB\u52A1\uFF0C\u53EA\u627F\u8F7D\u9700\u6C42\u5168\u6587\u4E0E\u6765\u6E90\u3002" })] }), _jsxs("h4", { className: 'devflow-flow-inspectorsection', children: ["\u76F8\u5173\u8FB9\uFF08", relatedEdges.length, "\uFF09"] }), relatedEdges.length === 0
                        ? _jsx("p", { className: 'devflow-flow-mutedline', children: "\u8BE5\u8282\u70B9\u5F53\u524D\u6CA1\u6709\u753B\u51FA\u7684\u8FB9\u3002" })
                        : _jsx("ul", { className: 'devflow-flow-inspectorlist', children: relatedEdges.map(item => _jsx("li", { children: _jsxs("button", { type: "button", "data-inspector-edge": item.id, onClick: () => { onSelectEdge(item.id); }, children: [_jsx("i", { className: `devflow-flow-line is-${item.semantic}`, "aria-hidden": "true" }), _jsxs("span", { className: 'devflow-flow-inspectorlinetitle', children: [FLOW_SEMANTIC_LABELS[item.semantic], " \u00B7 ", item.fromLabel, " \u2192 ", item.toLabel] }), _jsx("small", { children: item.badge })] }) }, item.id)) })] }), edge !== null && _jsxs(_Fragment, { children: [_jsxs("dl", { className: 'devflow-flow-table', children: [_jsxs("div", { children: [_jsx("dt", { children: "\u5173\u7CFB" }), _jsxs("dd", { children: [FLOW_SEMANTIC_LABELS[edge.semantic], "\uFF08", edge.semantic === 'delivery' ? '员工 → 总指挥' : '总指挥 → 员工', "\uFF09"] })] }), _jsxs("div", { children: [_jsx("dt", { children: "taskId" }), _jsx("dd", { children: edge.handoff.taskId ?? '未记录' })] }), _jsxs("div", { children: [_jsx("dt", { children: edge.handoff.acceptance.label }), _jsxs("dd", { children: [edge.handoff.acceptance.value, edge.handoff.acceptance.truncated ? '（已截断）' : ''] })] }), _jsxs("div", { children: [_jsx("dt", { children: "\u4EA4\u63A5\u53CC\u65B9" }), _jsxs("dd", { children: [edge.handoff.fromLabel, " \u2192 ", edge.handoff.toLabel] })] }), _jsxs("div", { children: [_jsx("dt", { children: "\u72B6\u6001" }), _jsx("dd", { children: edge.handoff.statusLabel })] }), _jsxs("div", { children: [_jsx("dt", { children: "\u65F6\u95F4" }), _jsx("dd", { children: edge.handoff.at ?? '未记录' })] }), _jsxs("div", { children: [_jsx("dt", { children: "\u8FD4\u5DE5\u6B21\u6570" }), _jsx("dd", { children: edge.handoff.retryCount })] })] }), edge.handoff.detail !== null && _jsx("p", { className: 'devflow-flow-xferdetail', children: edge.handoff.detail })] }), band !== null && _jsxs(_Fragment, { children: [_jsxs("dl", { className: 'devflow-flow-table', children: [_jsxs("div", { children: [_jsx("dt", { children: "\u9636\u6BB5" }), _jsx("dd", { children: band.name })] }), _jsxs("div", { children: [_jsx("dt", { children: "\u72B6\u6001" }), _jsx("dd", { children: band.statusLabel })] }), _jsxs("div", { children: [_jsx("dt", { children: "\u4EFB\u52A1\u6570 / \u6D3E\u53D1\u6570" }), _jsxs("dd", { children: [band.taskCount, " / ", band.dispatchCount] })] })] }), _jsxs("h4", { className: 'devflow-flow-inspectorsection', children: ["\u8BE5\u9636\u6BB5\u7684\u4EFB\u52A1\uFF08", band.tasks.length, "\uFF09"] }), band.tasks.length === 0
                        ? _jsx("p", { className: 'devflow-flow-mutedline', children: "\u8BE5\u9636\u6BB5\u5F53\u524D\u6CA1\u6709\u5173\u8054\u4EFB\u52A1\u3002" })
                        : _jsx("ul", { className: 'devflow-flow-inspectorlist', children: band.tasks.map(task => _jsx("li", { children: _jsxs("button", { type: "button", "data-inspector-task": task.id, "data-highlight": highlight?.kind === 'task' && highlight.id === task.id, onClick: () => { onHighlightTask(task.id); }, children: [_jsx("span", { className: 'devflow-flow-inspectorlinetitle', children: task.title }), _jsx("small", { children: task.stateLabel })] }) }, task.id)) }), _jsxs("h4", { className: 'devflow-flow-inspectorsection', children: ["\u8BE5\u9636\u6BB5\u7684\u6D3E\u53D1\uFF08", bandEdges.length, "\uFF09"] }), bandEdges.length === 0
                        ? _jsx("p", { className: 'devflow-flow-mutedline', children: "\u8BE5\u9636\u6BB5\u5F53\u524D\u6CA1\u6709\u753B\u51FA\u7684\u6D3E\u53D1\u8FB9\uFF08\u9ED8\u8BA4\u89C6\u56FE\u53EA\u753B\u6BCF\u4F4D\u5458\u5DE5\u7684\u5F53\u524D\u94FE\u8DEF\uFF09\u3002" })
                        : _jsx("ul", { className: 'devflow-flow-inspectorlist', children: bandEdges.map(item => _jsx("li", { children: _jsxs("button", { type: "button", "data-inspector-edge": item.id, onClick: () => { onSelectEdge(item.id); }, children: [_jsx("i", { className: `devflow-flow-line is-${item.semantic}`, "aria-hidden": "true" }), _jsx("span", { className: 'devflow-flow-inspectorlinetitle', children: item.taskLabel }), _jsx("small", { children: item.badge })] }) }, item.id)) }), _jsx("p", { className: 'devflow-flow-mutedline', children: "\u753B\u5E03\u4E0A\u4E0D\u518D\u753B\u4EFB\u4F55\u9636\u6BB5\u5143\u7D20\uFF1B\u9636\u6BB5\u5173\u8054\u53EA\u5728\u8FD9\u91CC\u5217\u51FA\u3002\u70B9\u4E00\u9879\u5373\u9AD8\u4EAE\u753B\u5E03\u4E0A\u5BF9\u5E94\u7684\u8282\u70B9\u4E0E\u8FB9\u3002" })] }), band === null && _jsxs("h4", { className: 'devflow-flow-inspectorsection', children: ["\u9636\u6BB5\u5173\u8054\uFF08", flow.bands.length, "\uFF09"] }), band === null && _jsx("ul", { className: 'devflow-flow-inspectorlist', children: flow.bands.map(item => _jsx("li", { children: _jsxs("button", { type: "button", "data-inspector-band": item.id, "data-highlight": highlight?.kind === 'phase' && highlight.id === item.id, title: `${item.name} · ${item.statusLabel} · 任务 ${item.taskCount} · 派发 ${item.dispatchCount}`, onClick: () => { onSelectBand(item.id); }, children: [_jsx("i", { className: 'devflow-flow-banddot', "data-status": item.status, "aria-hidden": "true" }), _jsx("span", { className: 'devflow-flow-inspectorlinetitle', children: item.name }), _jsxs("small", { children: [item.statusLabel, " \u00B7 ", item.taskCount, "/", item.dispatchCount] })] }) }, item.id)) }), _jsx("button", { type: "button", className: 'devflow-flow-xferclose', onClick: onClose, children: "\u5173\u95ED" })] });
}
function semanticLine(semantic) {
    if (semantic === 'requirement')
        return '需求下达：用户需求 → 总指挥（只读来源）';
    if (semantic === 'dispatch')
        return '派发：总指挥 → 员工 / 审计（箭头指向接收方）';
    if (semantic === 'delivery')
        return '交付 · 汇报：员工 / 审计 → 总指挥（箭头指回总指挥）';
    if (semantic === 'rework')
        return '返工：总指挥 → 原员工（同一任务的再次派发，边上标注返工次数）';
    return '子代理创建 / 回传：总指挥 ↔ 临时子代理（总指挥现场创建后即由本面板呈现）';
}
function agentWorkStateLabel(state) {
    if (state === 'working')
        return '工作中';
    if (state === 'blocked')
        return '等待决策';
    if (state === 'done')
        return '已完成作业';
    if (state === 'idle')
        return '空闲';
    if (state === 'archived')
        return '已归档';
    return '未知';
}
function freshnessLine(phase, generatedAt) {
    if (phase === 'refreshing')
        return `更新中…（上次 ${clock(generatedAt)}）`;
    if (phase === 'error')
        return `上次成功 ${clock(generatedAt)}`;
    return `更新 ${clock(generatedAt)}`;
}
/**
 * Name the data path the panel is actually on. This is an honesty line, not a
 * decoration: while the channel is down the panel says so instead of letting the
 * 5-second polling pass as realtime.
 */
function channelLine(connection) {
    if (connection === null)
        return '实时通道未启用 · 轮询快照';
    if (connection.phase === 'live')
        return `实时通道已连接${connection.sequence === null ? '' : ` · 游标 #${connection.sequence}`}`;
    if (connection.phase === 'connecting')
        return '实时通道连接中 · 轮询快照';
    return '实时通道已断开 · 轮询兜底';
}
function clock(at) {
    const parsed = Date.parse(at);
    if (Number.isNaN(parsed))
        return at;
    return new Date(parsed).toLocaleTimeString('zh-CN', { hour12: false });
}
function nodeSubtitle(node) {
    if (node.kind === 'requirement')
        return '用户需求 · 只读状态节点';
    if (node.kind === 'commander')
        return '拆解 · 派发 · 组织审计 · 验收';
    if (node.kind === 'temporary')
        return '临时子代理 · 由总指挥现场创建';
    return `固定员工 · 已交付 ${node.deliveryCount} 次`;
}
function rosterSkillsLabel(agentId, skills) {
    if (agentId === 'commander')
        return '不适用（总指挥不写代码）';
    if (skills === undefined || skills.length === 0)
        return '暂未绑定';
    return skills.join('、');
}
function rosterCapabilitiesLabel(agentId, capabilities) {
    if (agentId === 'commander')
        return '需求分析、任务拆解、派发、验收';
    if (capabilities === undefined || capabilities.length === 0)
        return '未记录';
    return capabilities.join('、');
}
function rosterDelegationLabel(agentId, depth) {
    const value = depth ?? 0;
    if (agentId === 'commander')
        return `委派深度 ${value}：可以现场创建临时子代理（生命周期状态尚未与面板联动）`;
    if (value <= 0)
        return `委派深度 ${value}：不能再派子代理`;
    return `委派深度 ${value}：可继续派子代理`;
}
function rosterCountLabel(agentId, count) {
    if (agentId === 'commander')
        return `已派出 ${count} 次执行`;
    if (agentId === 'code-auditor')
        return `已复核 ${count} 次`;
    return `已交付 ${count} 次`;
}
function seedPositions(flow) {
    const positions = {};
    for (const node of flow.nodes)
        positions[node.id] = { x: node.x, y: node.y };
    return positions;
}
/** `localStorage` access that never throws (private mode, disabled storage). */
function safeStorage() {
    try {
        return typeof window === 'undefined' ? null : window.localStorage;
    }
    catch {
        return null;
    }
}
function clamp(value, minimum, maximum) {
    if (minimum > maximum)
        return (minimum + maximum) / 2;
    return Math.min(maximum, Math.max(minimum, value));
}
/**
 * `true` when at least one flow layer inside `root` is actually animating right now.
 *
 * The selector is the MOTION, not the state: an element hidden by CSS still carries
 * `data-flow-rate`, so the class list alone would keep the glass degraded forever.
 * A 25-element scan at {@link SAMPLE_MS} cadence is a bounded, cheap read that never
 * touches layout (`getComputedStyle(...).animationName` only re-resolves style).
 */
function motionRunning(root) {
    for (const group of root.querySelectorAll('g[data-flow-rate]')) {
        const rate = group.getAttribute('data-flow-rate');
        if (rate !== 'base' && rate !== 'strong' && rate !== 'weak')
            continue;
        const layer = group.querySelector('.devflow-flow-flow');
        if (layer === null)
            continue;
        if (window.getComputedStyle(layer).animationName !== 'none')
            return true;
    }
    return false;
}
/**
 * §11.1: publish the glass-vs-motion posture on the canvas root.
 *
 * Sampling is one `requestAnimationFrame` loop plus a {@link SAMPLE_MS} DOM read; it
 * neither renders nor notifies React, so a refresh cannot be triggered by the guard
 * itself. A manual `?devflow-glass=solid|glass` override short-circuits the automatic
 * rules so a reviewer can hold either path in a real browser.
 */
function useGlassMotionBudget(root) {
    useEffect(() => {
        const element = root.current;
        if (element === null || typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function')
            return;
        const override = readGlassOverride(window.location.search);
        const budget = new MotionBudget();
        let frame = 0;
        let timer = null;
        let gaps = [];
        let lastFrame = 0;
        let lastMotionAt = 0;
        let stopped = false;
        const publish = (decision) => {
            const next = override === 'degrade' ? 'degrade' : override === 'glass' ? 'auto' : decision.budget;
            const motion = override === 'degrade' ? 'degraded' : override === 'glass' ? 'idle' : decision.motion;
            if (element.dataset.glassBudget !== next)
                element.dataset.glassBudget = next;
            if (element.dataset.motion !== motion)
                element.dataset.motion = motion;
            element.dataset.glassOverride = override;
        };
        const read = () => {
            const running = motionRunning(element);
            const now = window.performance.now();
            if (running)
                lastMotionAt = now;
            // "动画期间降级" holds for a short grace period after the last animated frame,
            // so a one-shot sweep or a two-frame repaint does not restore glass and then
            // degrade again (a visible flash).
            const active = running || now - lastMotionAt < MOTION_QUIET_MS;
            publish(budget.sample({ animating: active, meanFrameMs: meanFrameMs(gaps) ?? Number.NaN }));
            gaps = [];
        };
        const tick = (now) => {
            if (stopped)
                return;
            if (lastFrame !== 0)
                gaps.push(now - lastFrame);
            lastFrame = now;
            frame = window.requestAnimationFrame(tick);
        };
        const start = () => {
            if (stopped || timer !== null)
                return;
            lastFrame = 0;
            gaps = [];
            frame = window.requestAnimationFrame(tick);
            timer = window.setInterval(read, SAMPLE_MS);
            read();
        };
        const stop = () => {
            if (timer === null)
                return;
            window.clearInterval(timer);
            timer = null;
            if (frame !== 0) {
                window.cancelAnimationFrame(frame);
                frame = 0;
            }
            // Leaving the tab must not leave the canvas in a degraded skin the user never
            // sees restored: the posture is recomputed from scratch on the way back.
            lastMotionAt = 0;
            gaps = [];
        };
        const onVisibility = () => { if (document.visibilityState === 'hidden')
            stop();
        else
            start(); };
        if (document.visibilityState !== 'hidden')
            start();
        else
            publish({ budget: 'auto', motion: 'idle' });
        document.addEventListener('visibilitychange', onVisibility);
        return () => {
            stopped = true;
            document.removeEventListener('visibilitychange', onVisibility);
            stop();
        };
        // The posture follows the element only; every input is read live from the DOM.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
}
