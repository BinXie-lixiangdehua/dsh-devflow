import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * Step 3B — the top-right DevFlow overview float (`shell.overlay`).
 *
 * The float is the "简版概览" the boss asked for: one glance at the current session's
 * DevFlow state without opening the right panel, and one click into the full panel.
 * It is explicitly NOT a second full panel — no audit list, no tool activity, no
 * handoff detail, no history chain, and none of the canvas' motion matrix.
 *
 * Three states, all of them reachable by keyboard:
 *   * **折叠** — a small pill in the frame's top-right corner: status dot, the
 *     headline counts, and the live-channel posture ("实时通道" / "轮询兜底").
 *   * **展开** — a docked float beside the panel: project + binding, the segmented
 *     progress bar, the commander line, one row per fixed employee, the small-print
 *     counts, and 打开完整面板.
 *   * **关闭** — the pill goes too; the way back in is the DevFlow panel's own
 *     header action (see `DevFlowCanvas`), which is why the closed flag is remembered.
 *
 * §四 (session filtering) is the round's real trap: `shell.overlay` is ROOT-scoped, so
 * this component owns the gate and {@link overviewGate} executes it deny-by-default.
 * A session change ALSO folds the float, so a value from the previous session can
 * never be on screen while the next one loads.
 *
 * §11.2 (motion): the float is still by default and distinguishes its states by
 * COLOUR. The only motion it may carry is one very weak opacity pulse on the status
 * dot while dispatches are in flight — no glass resampling, no travelling dash, no
 * animation matrix. `prefers-reduced-motion` removes even that.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createWorkspaceModel } from "./workspace.js";
import { OVERVIEW_REOPEN_EVENT, buildOverview, connectionDetail, legacyFlagCleanup, overviewClosedKey, overviewExpandedKey, overviewGate, } from "./overview.js";
/** The window event the panel's header action dispatches to bring the float back. */
export { OVERVIEW_REOPEN_EVENT };
/** Bounded, safe storage reads: private mode must never break the float. */
function readFlag(storage, key, fallback) {
    if (storage === null)
        return fallback;
    try {
        const value = storage.getItem(key);
        if (value === '1' || value === 'true')
            return true;
        if (value === '0' || value === 'false')
            return false;
        return fallback;
    }
    catch {
        return fallback;
    }
}
function writeFlag(storage, key, value) {
    if (storage === null)
        return;
    try {
        storage.setItem(key, value ? '1' : '0');
    }
    catch { /* ignored: the float still works this session */ }
}
function safeStorage() {
    try {
        return typeof window === 'undefined' ? null : window.localStorage;
    }
    catch {
        return null;
    }
}
/** The segmented progress bar, in the panel's own order and wording. */
const SEGMENTS = [
    { key: 'active', label: '进行中', tone: 'run' },
    { key: 'review', label: '待验收', tone: 'wait' },
    { key: 'done', label: '已完成', tone: 'done' },
    { key: 'lost', label: '未收尾·失联', tone: 'lost' },
    // 第四步：收尾终态与"未收尾·失联"并列但绝不混同——一个说"收尾了"，一个说"还悬着"。
    { key: 'closed', label: '已收尾', tone: 'closed' },
];
/** The float's own tone names for the node states it colours. */
const MEMBER_TONE = {
    idle: 'idle', active: 'run', blocked: 'wait', done: 'done', rework: 'bad', planned: 'queue', lost: 'lost', paused: 'paused', closed: 'closed',
};
const LOADING = { phase: 'loading', snapshot: null, error: null };
/**
 * Gap kept to the right of the column's own toggle button. The button is 28px wide and
 * sits at the frame's right edge while the column is collapsed, so the float has to clear
 * the button PLUS this margin — a bare "column width" offset put the float on top of it
 * at every narrow viewport (measured at 420/600/720px in the first evidence pass).
 */
const TOGGLE_CLEARANCE = 44;
/** The float's cell body. */
export function DevFlowOverview(props) {
    const { useSessions, controllerFor, liveFor, openPanel } = props;
    const sessions = useSessions(state => state);
    const gate = overviewGate(sessions);
    const sessionId = gate.sessionId;
    // Read BOTH flags through one helper that first drops the legacy global keys:
    // they are read by nobody now, and clearing them here (rather than only in an
    // effect) means the very first render after the upgrade is already correct.
    const readSessionFlags = useCallback(() => {
        const storage = safeStorage();
        legacyFlagCleanup(storage);
        return {
            expanded: readFlag(storage, overviewExpandedKey(sessionId), false),
            closed: readFlag(storage, overviewClosedKey(sessionId), false),
        };
    }, [sessionId]);
    /**
     * The fold and close are remembered PER SESSION. They are preferences about ONE
     * session's float; a single global flag meant one accidental close hid the
     * overview in every other project too — which is what "概览没有了" looked like.
     */
    const initialFlags = useRef(null);
    if (initialFlags.current === null || initialFlags.current.sessionId !== sessionId) {
        initialFlags.current = { sessionId, ...readSessionFlags() };
    }
    const [expanded, setExpanded] = useState(initialFlags.current.expanded);
    const [closed, setClosed] = useState(initialFlags.current.closed);
    const hostRef = useRef(null);
    const previousSession = useRef(null);
    const controller = sessionId === null ? null : controllerFor(sessionId);
    const live = sessionId === null ? undefined : liveFor(sessionId);
    const state = useControllerState(controller);
    const connection = useConnectionState(live ?? null);
    // §四: a session change re-reads THAT session's own fold and close, so nothing
    // from the previous session can decide the next one's posture.
    useEffect(() => {
        if (previousSession.current === sessionId)
            return;
        previousSession.current = sessionId;
        const flags = readSessionFlags();
        setExpanded(flags.expanded);
        setClosed(flags.closed);
    }, [sessionId, readSessionFlags]);
    // The panel's "reopen the float" action (a window event) lifts THIS session's
    // close flag. It is the only way back in once the pill is gone, per §二·3.
    useEffect(() => {
        const onReopen = () => {
            writeFlag(safeStorage(), overviewClosedKey(sessionId), false);
            setClosed(false);
        };
        window.addEventListener(OVERVIEW_REOPEN_EVENT, onReopen);
        return () => { window.removeEventListener(OVERVIEW_REOPEN_EVENT, onReopen); };
    }, [sessionId]);
    /**
     * Docking: the float never covers the right column's own controls, at any column width
     * or any of the three viewport widths the round checks.
     *
     * The offset is MEASURED, never assumed from a breakpoint: the frame has three layout
     * modes, the column can be collapsed to a narrow rail, and the toggle button sits at
     * the frame's right edge in the collapsed mode — where a "column width + small gap"
     * rule would put the float straight on top of it. The rule below is therefore:
     * clear the column, and clear the toggle with {@link TOGGLE_CLEARANCE} to spare.
     */
    useEffect(() => {
        const host = hostRef.current;
        if (host === null || typeof window === "undefined")
            return;
        const place = () => {
            const column = document.querySelector('[class*="rightbarCol"]');
            const columnWidth = column === null ? 0 : Math.round(column.getBoundingClientRect().width);
            const toggle = document.querySelector('button[data-sidebar-right-toggle="true"]');
            const toggleWidth = toggle === null ? 0 : Math.ceil(toggle.getBoundingClientRect().width);
            const width = Math.max(columnWidth, toggle === null ? 0 : toggleWidth + TOGGLE_CLEARANCE);
            host.style.setProperty("--devflow-ov-offset", Math.round(width) + "px");
        };
        place();
        if (typeof ResizeObserver === "undefined")
            return;
        const observer = new ResizeObserver(place);
        observer.observe(document.body);
        const column = document.querySelector('[class*="rightbarCol"]');
        if (column !== null)
            observer.observe(column);
        return () => { observer.disconnect(); };
    }, [gate.allowed, expanded, closed]);
    const toggle = useCallback(() => {
        setExpanded(value => { writeFlag(safeStorage(), overviewExpandedKey(sessionId), !value); return !value; });
    }, [sessionId]);
    const close = useCallback(() => {
        setExpanded(false);
        writeFlag(safeStorage(), overviewExpandedKey(sessionId), false);
        writeFlag(safeStorage(), overviewClosedKey(sessionId), true);
        setClosed(true);
    }, [sessionId]);
    const model = state.snapshot === null ? null : createWorkspaceModel(state.snapshot);
    const view = useMemo(() => (model === null ? null : buildOverview(model, undefined, connection)), [model, connection]);
    // Deny by default: not a DevFlow session, nothing renders — not even a placeholder.
    if (!gate.allowed || sessionId === null || closed)
        return null;
    const ready = view !== null && state.phase !== 'loading';
    const summary = view?.summary ?? '正在读取 DevFlow 状态';
    const posture = view?.posture ?? 'active';
    const paused = view?.paused ?? false;
    return _jsxs("div", { className: 'devflow-ov', "data-expanded": expanded, "data-posture": posture, "data-paused": paused, "data-connection": view?.connectionPhase ?? 'polling', "data-preset": gate.preset ?? 'none', "data-gate": gate.reason, "data-session": sessionId, ref: hostRef, children: [_jsxs("button", { type: "button", className: 'devflow-ov-pill', "aria-expanded": expanded, "aria-label": expanded ? '收起 DevFlow 概览' : `展开 DevFlow 概览：${summary}`, title: expanded ? '收起 DevFlow 概览' : '展开 DevFlow 概览', onClick: toggle, children: [_jsx("span", { className: 'devflow-ov-dot', "data-posture": posture, "aria-hidden": "true" }), _jsx("span", { className: 'devflow-ov-pilltext', children: summary }), _jsx("span", { className: 'devflow-ov-pillconn', "data-connection": view?.connectionPhase ?? 'polling', children: view?.connectionLabel ?? '轮询兜底' })] }), expanded && _jsxs("section", { className: 'devflow-ov-card', "aria-label": "DevFlow \u6982\u89C8", children: [_jsxs("header", { className: 'devflow-ov-head', children: [_jsxs("div", { children: [_jsx("p", { className: 'devflow-ov-kicker', children: "DevFlow \u6982\u89C8" }), _jsx("h2", { className: 'devflow-ov-title', children: ready && view !== null ? view.projectName : '正在读取…' })] }), _jsxs("div", { className: 'devflow-ov-headactions', children: [_jsx("button", { type: "button", className: 'devflow-ov-icon', "aria-label": "\u6536\u8D77 DevFlow \u6982\u89C8", onClick: toggle, children: "\u25BE" }), _jsx("button", { type: "button", className: 'devflow-ov-icon', "aria-label": "\u5173\u95ED DevFlow \u6982\u89C8", onClick: close, children: "\u2715" })] })] }), !ready && _jsx("p", { className: 'devflow-ov-muted', role: "status", children: "\u6B63\u5728\u8BFB\u53D6\u5F53\u524D\u4F1A\u8BDD\u7684 DevFlow \u72B6\u6001\u2026" }), ready && view !== null && _jsxs(_Fragment, { children: [_jsxs("p", { className: 'devflow-ov-meta', children: [_jsx("span", { className: 'devflow-ov-chip', "data-state": view.bindingLabel === '已绑定' ? 'bound' : 'unbound', children: view.bindingLabel }), view.paused && _jsx("span", { className: 'devflow-ov-chip', "data-state": "paused", children: "\u5DF2\u6682\u505C" }), _jsx("span", { className: 'devflow-ov-chip', "data-state": view.connectionPhase === 'live' ? 'live' : 'poll', children: view.connectionLabel })] }), _jsx("div", { className: 'devflow-ov-segments', role: "group", "aria-label": "\u6D3E\u53D1\u5206\u6BB5\u8FDB\u5EA6", children: SEGMENTS.map(segment => _jsxs("div", { className: 'devflow-ov-segment', "data-tone": segment.tone, "data-count": view.counts[segment.key], children: [_jsx("span", { className: 'devflow-ov-segbar', "aria-hidden": "true" }), _jsx("span", { className: 'devflow-ov-seglabel', children: segment.label }), _jsx("span", { className: 'devflow-ov-segnum', children: view.counts[segment.key] })] }, segment.key)) }), _jsxs("p", { className: 'devflow-ov-commander', children: [_jsx("span", { className: 'devflow-ov-dot', "data-state": "commander", "aria-hidden": "true" }), _jsx("strong", { children: view.commanderName }), _jsx("span", { className: 'devflow-ov-memberstate', children: view.commanderStateLabel }), _jsxs("span", { className: 'devflow-ov-muted', children: ["\u5DF2\u6D3E\u51FA ", view.dispatchCount, " \u6B21\u6D3E\u53D1"] })] }), _jsx("ul", { className: 'devflow-ov-members', children: view.members.map(member => _jsx("li", { children: _jsxs("button", { type: "button", className: 'devflow-ov-member', "data-state": member.state, "data-kind": member.kind, "aria-label": `打开完整面板查看 ${member.name}（${member.stateLabel}）`, onClick: openPanel, children: [_jsx("span", { className: 'devflow-ov-dot', "data-state": MEMBER_TONE[member.state] ?? 'idle', "aria-hidden": "true" }), _jsxs("span", { className: 'devflow-ov-membername', children: [member.name, member.kind === 'temporary' && _jsx("span", { className: 'devflow-ov-membertag', children: "\u4E34\u65F6\u5B50\u4EE3\u7406" })] }), _jsx("span", { className: 'devflow-ov-memberstate', "data-state": member.state, children: member.stateLabel }), _jsx("span", { className: 'devflow-ov-membertask', children: member.taskTitle ?? '当前没有派发任务' })] }) }, member.id)) }), _jsxs("p", { className: 'devflow-ov-tally', children: ["\u672A\u843D\u70B9 ", view.counts.unrouted, " \u00B7 \u672A\u6536\u5C3E ", view.counts.lost, " \u00B7 \u5DF2\u9690\u85CF ", view.counts.hidden, view.counts.paused > 0 && _jsxs(_Fragment, { children: [" \u00B7 \u5DF2\u6682\u505C ", view.counts.paused] })] }), connectionDetail(connection) !== null && _jsx("p", { className: 'devflow-ov-notice', role: "status", children: connectionDetail(connection) }), _jsx("footer", { className: 'devflow-ov-foot', children: _jsx("button", { type: "button", className: 'devflow-ov-open', onClick: openPanel, children: "\u6253\u5F00\u5B8C\u6574\u9762\u677F" }) })] })] })] });
}
/** Subscribe to the panel's per-session controller as an external store. */
function useControllerState(controller) {
    const subscribe = useCallback((listener) => (controller === null ? () => undefined : controller.subscribe(listener)), [controller]);
    const read = useCallback(() => (controller === null ? LOADING : controller.getSnapshot()), [controller]);
    return useSyncExternalStore(subscribe, read, read);
}
/** Subscribe to the session's live channel as an external store. */
function useConnectionState(live) {
    const subscribe = useCallback((listener) => (live === null ? () => undefined : live.subscribeConnection(listener)), [live]);
    const read = useCallback(() => (live === null ? null : live.getConnection()), [live]);
    return useSyncExternalStore(subscribe, read, read);
}
