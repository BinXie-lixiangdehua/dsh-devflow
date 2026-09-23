import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useId, useRef, useState } from 'react';
import { FlowCanvas } from "./FlowCanvas.js";
import { activationBannerMode, blockedBannerFolded, safeStorage, storeActivationFold, storeBlockedFold } from "./activation-banner.js";
import { equalCurrentSessionToolsState, mapCurrentSessionTools, } from "./tool-activity.js";
import { PROJECT_SELECTION, auditFilterForSelection, createWorkspaceModel, selectionExists, selectionLabel, selectionParent, shortId, } from "./workspace.js";
const INSPECTOR_TABS = ['flow', 'audit', 'tools'];
/**
 * Fixed readable phrase per refusal phase, mirroring the Host's own vocabulary
 * so the panel and `/devflow commander status` name the same act the same way.
 */
const ACTIVATION_PHASE_LABELS = {
    initial: '首次激活',
    recompose: '切换 preset',
    deactivate: '撤销激活',
    restore: '回滚恢复',
    journal: '留痕写入',
};
/**
 * The one readable conclusion for a recorded activation refusal.
 *
 * The banner's old headline was the raw refusal code, which reads as an internal
 * identifier rather than as an answer: an operator who saw
 * `devflow-activation-verification-failed` once read it as an employee id. The
 * code stays in the DOM (it is the one string that can be quoted into a report),
 * but it is no longer the sentence that carries the meaning.
 *
 * Only two conclusions are drawn, both from data the Host verified:
 *
 *  - `session` `bound` ⇒ the refusal was absorbed by the bounded settle retry and
 *    this session is live now, so the banner says so and points at the readable
 *    verdict rather than at the code;
 *  - anything else ⇒ the refusal stands, and the sentence is
 *    `激活未通过（原因：…）` with the recorded Chinese reason.
 *
 * No third branch invents a recovery: a refusal that was never followed by a
 * verified bound posture is never described as retried-and-recovered.
 * @param failure - the refusal record carried by the snapshot.
 * @param activation - the Host-verified posture of the same session.
 * @returns the headline, the factual meta line, and the fixed phase phrase.
 */
function activationFailureVerdict(failure, activation) {
    const retried = Math.max(failure.attempts - 1, 0);
    const meta = retried === 0
        ? `首次尝试即被拒绝 · ${failure.at}`
        : `已自动重试 ${String(retried)} 次 · ${failure.attempts} 次尝试 · ${failure.at}`;
    return {
        headline: activation === 'bound'
            ? 'DevFlow 激活未通过，重试后已恢复绑定（不影响当前会话）'
            : `DevFlow 激活未通过（原因：${failure.reason}）`,
        meta,
        phase: ACTIVATION_PHASE_LABELS[failure.phase] ?? '激活',
    };
}
/** Render the read-only DevFlow workspace as the right Sidebar's DevFlow tab body. */
export function DevFlowCanvas(props) {
    const { useDevflow, useSession, useChat, sessionId, refresh, t, audit, getInspectorTab, setInspectorTab: persistInspectorTab, reopenOverview } = props;
    const state = useDevflow((value) => value);
    const auditHook = props.useAudit;
    const auditState = auditHook === undefined ? null : auditHook((value) => value);
    const liveHook = props.useLive;
    const connection = liveHook === undefined ? null : (liveHook((value) => value) ?? null);
    // The event channel supersedes the poll while it is live; polling stays the
    // fallback (and is announced in the canvas), never a silent parallel reader.
    const liveConnected = connection?.phase === 'live';
    const [selection, setSelection] = useState(PROJECT_SELECTION);
    const [history, setHistory] = useState([]);
    const [selectionNotice, setSelectionNotice] = useState(null);
    const [inspectorOpen, setInspectorOpen] = useState(false);
    /**
     * Fold choices for THIS mount, keyed per banner ('activation' / 'blocked'); an absent
     * entry means "follow what storage remembers". ONE map rather than one state per banner
     * on purpose: the canvas' state slots are pinned by the copy tests' `useState` mock, so
     * every extra hook shifts every later slot.
     */
    const [foldOverrides, setFoldOverrides] = useState({});
    const [inspectorTab, setInspectorTab] = useState(() => getInspectorTab());
    const inspectorRegionId = useId();
    const changeInspectorTab = (tab) => {
        persistInspectorTab(tab);
        setInspectorTab(tab);
    };
    useEffect(() => {
        void refresh();
    }, [refresh]);
    const snapshot = state.snapshot;
    const devflowSessionId = snapshot?.session.id;
    const projectId = snapshot?.project?.id;
    const previousProjectId = useRef(projectId);
    const projectChanged = previousProjectId.current !== projectId;
    const model = snapshot === null ? null : createWorkspaceModel(snapshot);
    useEffect(() => {
        previousProjectId.current = projectId;
        if (model === null || (!projectChanged && selectionExists(model, selection)))
            return;
        setSelection(PROJECT_SELECTION);
        setHistory([]);
        setSelectionNotice(projectChanged
            ? '当前项目已变更，已回到项目总览。'
            : '原先选中的对象已不在当前快照，已回到项目总览。');
    }, [projectId, model, selection]);
    useEffect(() => {
        if (devflowSessionId === undefined || projectId === undefined || audit === undefined || inspectorTab !== 'audit')
            return;
        if (projectChanged) {
            void audit.ensure({ kind: 'project' }, projectId);
            return;
        }
        void audit.ensure(auditFilterForSelection(selection), projectId);
    }, [devflowSessionId, projectId, projectChanged, audit, inspectorTab, selection]);
    // The fallback reader is installed last: the mount read and the audit-scope
    // effects above are the load-bearing ones, and this timer only ever covers the
    // case where the event channel is not live (it is announced in the canvas).
    useEffect(() => {
        if (liveConnected)
            return;
        const timer = window.setInterval(() => { void refresh(); }, 5_000);
        return () => { window.clearInterval(timer); };
    }, [refresh, liveConnected]);
    const select = (next) => {
        setHistory(previous => [...previous, selection]);
        setSelection(next);
        setSelectionNotice(null);
        setInspectorOpen(true);
    };
    const goBack = () => {
        const previous = history.at(-1);
        if (previous !== undefined) {
            setHistory(history.slice(0, -1));
            setSelection(previous);
            setSelectionNotice(null);
            return;
        }
        if (model !== null) {
            const parent = selectionParent(model, selection);
            if (parent !== undefined) {
                setSelection(parent);
                setSelectionNotice(null);
            }
        }
    };
    if (state.phase === 'loading')
        return _jsx("main", { className: 'devflow-canvas devflow-flow', "aria-busy": "true", children: _jsx("p", { className: 'devflow-notice', children: t('loading') }) });
    if (snapshot === null || model === null) {
        return _jsx("main", { className: 'devflow-canvas devflow-flow', children: _jsxs("div", { className: 'devflow-notice', children: [_jsx("p", { children: t('unavailable') }), _jsx("button", { type: "button", onClick: () => { void refresh(); }, children: t('retry') })] }) });
    }
    /*
     * Read the recorded refusal defensively: it is a newer field than the rest of
     * the session block, so an older snapshot (a pinned fixture, a replay from a
     * previous build) legitimately lacks it. A missing diagnosis must degrade to
     * "nothing to show", never to a blank panel — this surface's whole job is to
     * stay readable when something else went wrong.
     */
    const failure = snapshot.session.lastActivationFailure ?? null;
    /** Blocked dispatches, newest first; empty for snapshots that predate them. */
    const blockedRows = snapshot.blocked ?? [];
    const verdict = failure === null ? null : activationFailureVerdict(failure, snapshot.session.activation);
    /*
     * Fold posture: storage remembers it per refusal, and the button overrides it for this
     * mount. A standing refusal is never foldable, so the two facts cannot disagree.
     */
    const storage = safeStorage();
    const bannerMode = activationBannerMode(failure, snapshot.session.activation, storage);
    const bannerFolded = foldOverrides.activation ?? bannerMode.folded;
    const setFolded = (folded) => {
        if (failure !== null)
            storeActivationFold(storage, failure, folded);
        setFoldOverrides(current => ({ ...current, activation: folded }));
    };
    /*
     * The 受阻 banner sits directly above the flow the user came to read, so it starts folded —
     * to ONE line that still carries the count and the latest report — and a new blocked report
     * is a different key, so it opens expanded again.
     */
    const blockedFolded = foldOverrides.blocked ?? blockedBannerFolded(blockedRows, storage);
    const setBlockedFolded = (folded) => {
        storeBlockedFold(storage, blockedRows, folded);
        setFoldOverrides(current => ({ ...current, blocked: folded }));
    };
    return _jsxs("main", { className: 'devflow-canvas devflow-flow', "data-phase": state.phase, "data-preset": snapshot.session.presetId ?? 'none', "data-devflow-panel": "true", "data-activation-failure": failure?.code ?? 'none', children: [failure !== null && verdict !== null && (_jsx("div", { className: `devflow-activation-failure${bannerFolded ? ' is-folded' : ''}`, role: "status", "data-activation-code": failure.code, "data-activation-phase": failure.phase, "data-activation-attempts": String(failure.attempts), "data-activation-recovered": String(snapshot.session.activation === 'bound'), "data-activation-folded": String(bannerFolded), children: bannerFolded
                    ? /* The rows are spans, not divs: a nested div made the banner a two-level tree, which
                         truncated the panel's own "first </div>" extraction used by the copy tests. */
                        _jsxs("span", { className: 'devflow-activation-failure-one', children: [_jsx("span", { className: 'devflow-activation-failure-head', children: verdict.headline }), _jsxs("span", { className: 'devflow-activation-failure-code', title: `内部编码：${failure.code}`, children: ["\u3008", failure.code, "\u3009"] }), _jsx("button", { type: "button", className: 'devflow-activation-failure-toggle', "data-activation-toggle": "expand", onClick: () => { setFolded(false); }, children: "\u5C55\u5F00" })] })
                    : _jsxs(_Fragment, { children: [_jsxs("span", { className: 'devflow-activation-failure-head-row', children: [_jsx("span", { className: 'devflow-activation-failure-head', children: verdict.headline }), bannerMode.collapsible && _jsx("button", { type: "button", className: 'devflow-activation-failure-toggle', "data-activation-toggle": "fold", onClick: () => { setFolded(true); }, children: "\u6536\u8D77\u6A2A\u5E45" })] }), _jsxs("span", { className: 'devflow-activation-failure-code', title: `内部编码：${failure.code}`, children: ["\u5185\u90E8\u7F16\u7801 \u3008", failure.code, "\u3009"] }), _jsx("span", { className: 'devflow-activation-failure-meta', children: `${verdict.phase} · ${verdict.meta}` })] }) })), state.phase === 'error' && _jsxs("div", { className: 'devflow-error-notice', role: "alert", "data-error-code": state.error.code, children: [_jsx("span", { children: state.error.code === 'scope-unavailable'
                            /* 隔离拒绝：本会话没有工作区，所以这里既不显示共享库，也不宣称"最近一次成功数据"。 */
                            ? t('scopeUnavailable')
                            : `${t('unavailable')} 显示最近一次成功的数据。` }), _jsx("button", { type: "button", onClick: () => { void refresh(); }, children: t('retry') })] }), blockedRows.length > 0 && _jsx("div", { className: `devflow-blocked-banner${blockedFolded ? ' is-folded' : ''}`, role: "status", "data-blocked-count": String(blockedRows.length), "data-blocked-folded": String(blockedFolded), children: blockedFolded
                    ? _jsxs("span", { className: 'devflow-blocked-headrow', children: [_jsxs("span", { className: 'devflow-blocked-head', children: ["\u53D7\u963B \u00B7 ", blockedRows.length, " \u6761\u5F85\u5904\u7406"] }), _jsx("button", { type: "button", className: 'devflow-blocked-toggle', "data-blocked-toggle": "expand", onClick: () => { setBlockedFolded(false); }, children: "\u5C55\u5F00" }), _jsx("span", { className: 'devflow-blocked-latest', children: blockedRows[0]?.headline })] })
                    : _jsxs(_Fragment, { children: [_jsxs("span", { className: 'devflow-blocked-headrow', children: [_jsx("span", { className: 'devflow-blocked-head', children: "\u53D7\u963B \u00B7 \u9700\u8981\u5904\u7406" }), _jsx("button", { type: "button", className: 'devflow-blocked-toggle', "data-blocked-toggle": "fold", onClick: () => { setBlockedFolded(true); }, children: "\u6536\u8D77" })] }), blockedRows.slice(0, 3).map(row => _jsxs("span", { className: 'devflow-blocked-row', "data-gap-kind": row.gapKind, "data-task-id": row.taskId, children: [row.headline, _jsx("span", { className: 'devflow-blocked-why', children: row.reason.text })] }, row.id))] }) }), _jsx(FlowCanvas, { model: model, phase: state.phase, tab: inspectorTab, now: props.now, connection: connection, 
                /* 会话级提示交给画布自己的提示行渲染：绝不再横贯画布盖住连线。 */
                notice: selectionNotice, onTabChange: changeInspectorTab, onReopenOverview: reopenOverview, auditPanel: snapshot.project === null
                    ? _jsx(EmptyProject, { t: t })
                    : _jsx(BusinessAudit, { state: projectChanged ? null : auditState, model: model, onSelect: select, onRefresh: () => { void audit?.refresh(); }, onMore: () => { void audit?.loadMore(); }, onRetry: () => { void audit?.retry(); } }), toolsPanel: _jsx(CurrentSessionToolsView, { useSession: useSession, useChat: useChat, sessionId: sessionId }) })] });
}
function EmptyProject({ t }) {
    return _jsxs("section", { className: 'devflow-empty-state', children: [_jsx("h1", { children: "\u5171\u4EAB DevFlow \u9879\u76EE" }), _jsx("p", { children: t('empty') }), _jsxs("p", { children: ["\u5728\u672C\u673A Chat \u91CC\u6267\u884C ", _jsx("code", { children: "/devflow init <name>" }), " \u5373\u53EF\u521D\u59CB\u5316\u3002\u672C\u5DE5\u4F5C\u533A\u53EA\u8BFB\u3002"] })] });
}
function DetailInspector({ model, selection, history, tab, inspectorRegionId, projectChanged, useSession, useChat, sessionId, auditState, onTabChange, onAuditRefresh, onAuditMore, onAuditRetry, onSelect, onBack }) {
    const tabGroupId = useId();
    const tabId = (value) => `${tabGroupId}-${value}-tab`;
    const panelId = (value) => `${tabGroupId}-${value}-panel`;
    const title = tab === 'tools' ? 'Current session tools' : selectionLabel(model, selection);
    const onTabKeyDown = (event, current) => {
        let nextIndex;
        const currentIndex = INSPECTOR_TABS.indexOf(current);
        if (event.key === 'ArrowRight')
            nextIndex = (currentIndex + 1) % INSPECTOR_TABS.length;
        if (event.key === 'ArrowLeft')
            nextIndex = (currentIndex - 1 + INSPECTOR_TABS.length) % INSPECTOR_TABS.length;
        if (event.key === 'Home')
            nextIndex = 0;
        if (event.key === 'End')
            nextIndex = INSPECTOR_TABS.length - 1;
        if (nextIndex === undefined)
            return;
        event.preventDefault();
        const next = INSPECTOR_TABS[nextIndex];
        onTabChange(next);
        event.currentTarget.parentElement?.querySelectorAll('[role="tab"]')[nextIndex]?.focus();
    };
    return _jsxs("section", { id: inspectorRegionId, className: 'devflow-inspector', children: [_jsxs("header", { children: [_jsxs("div", { children: [_jsx("p", { className: 'devflow-kicker', children: "Inspector" }), _jsx("h2", { children: title })] }), tab !== 'tools' && (history.length > 0 || selection.kind !== 'project') && _jsx("button", { type: "button", className: 'devflow-back-button', onClick: onBack, children: "Back" })] }), _jsx("div", { className: 'devflow-inspector-tabs', role: "tablist", "aria-label": "Inspector views", "aria-orientation": "horizontal", children: INSPECTOR_TABS.map(value => _jsx("button", { id: tabId(value), type: "button", role: "tab", tabIndex: tab === value ? 0 : -1, "aria-controls": panelId(value), "aria-selected": tab === value, "data-selected": tab === value, onClick: () => { onTabChange(value); }, onKeyDown: event => { onTabKeyDown(event, value); }, children: inspectorTabLabel(value) }, value)) }), _jsx("section", { id: panelId('flow'), role: "tabpanel", "aria-labelledby": tabId('flow'), hidden: tab !== 'flow', children: tab === 'flow' && _jsx(InspectorSourceHeading, { title: "Dispatch flow", badges: ['Shared · .devflow', 'Current session · scoped state'] }) }), _jsx("section", { id: panelId('audit'), role: "tabpanel", "aria-labelledby": tabId('audit'), hidden: tab !== 'audit', children: tab === 'audit' && _jsx(BusinessAudit, { state: projectChanged ? null : auditState, model: model, onSelect: onSelect, onRefresh: onAuditRefresh, onMore: onAuditMore, onRetry: onAuditRetry }) }), _jsx("section", { id: panelId('tools'), role: "tabpanel", "aria-labelledby": tabId('tools'), hidden: tab !== 'tools', children: tab === 'tools' && _jsx(CurrentSessionToolsView, { useSession: useSession, useChat: useChat, sessionId: sessionId }) })] });
}
function InspectorSourceHeading({ title, badges }) {
    return _jsx("header", { className: 'devflow-panel-heading', children: _jsxs("div", { children: [_jsx("h3", { children: title }), badges.map(badge => _jsx("span", { className: 'devflow-source-badge', children: badge }, badge))] }) });
}
function CurrentSessionToolsView({ useSession, useChat, sessionId }) {
    // The official window splits across two framework targets: session lifecycle
    // state from the Session Controller adapter, loaded Chat nodes from the Chat
    // target. Both are selected separately and joined in the pure mapper. The
    // parameters are annotated because the framework's selector hook types are
    // not always inferable from the slot props alone.
    const chat = useChat((snapshot) => snapshot);
    const state = useSession((session) => mapCurrentSessionTools(sessionId, { session, chat }), equalCurrentSessionToolsState);
    return _jsx(CurrentSessionTools, { state: state });
}
function CurrentSessionTools({ state }) {
    const hasItems = state.items.length > 0;
    return _jsxs("section", { className: 'devflow-tools', "aria-busy": state.phase === 'loading', children: [_jsx(InspectorSourceHeading, { title: "\u672C\u4F1A\u8BDD\u5DE5\u5177\u52A8\u6001", badges: ['本会话 · Harness 官方数据', '当前已加载会话窗口', '最新最多 20 条'] }), _jsx("p", { className: 'devflow-detail-note', children: "\u8FD9\u91CC\u663E\u793A\u5F53\u524D\u4F1A\u8BDD\u5DF2\u52A0\u8F7D\u7A97\u53E3\u91CC\u53EF\u89C1\u7684\u5B98\u65B9\u5DE5\u5177\u52A8\u6001\uFF1B\u5F53\u524D\u7684 DevFlow \u9009\u62E9\u4E0D\u53C2\u4E0E\u8FC7\u6EE4\u3002" }), state.phase === 'loading' && !hasItems && _jsx("p", { className: 'devflow-muted', children: "\u6B63\u5728\u4ECE\u5F53\u524D\u5DF2\u52A0\u8F7D\u7684\u4F1A\u8BDD\u7A97\u53E3\u8BFB\u53D6\u5B98\u65B9\u5DE5\u5177\u52A8\u6001\u2026" }), state.phase === 'loading' && hasItems && _jsx("p", { className: 'devflow-tools-stale', role: "status", children: "\u4F1A\u8BDD\u7A97\u53E3\u4ECD\u5728\u52A0\u8F7D\uFF0C\u8FD9\u91CC\u53EA\u663E\u793A\u5F53\u524D\u53EF\u89C1\u7684\u5B89\u5168\u5185\u5BB9\u3002" }), state.phase === 'unavailable' && !hasItems && _jsx("p", { className: 'devflow-tools-unavailable', role: "status", children: "\u5F53\u524D\u4F1A\u8BDD\u7684\u5B98\u65B9\u5DE5\u5177\u52A8\u6001\u4E0D\u53EF\u7528\u3002\u6B64\u5904\u4E0D\u4F1A\u7528 `.devflow` \u8BB0\u5F55\u9876\u66FF\u3002" }), state.phase === 'unavailable' && hasItems && _jsx("p", { className: 'devflow-tools-stale', role: "status", children: "\u5B98\u65B9\u5DE5\u5177\u52A8\u6001\u5F53\u524D\u4E0D\u53EF\u7528\uFF0C\u663E\u793A\u4ECD\u7559\u5728\u5DF2\u52A0\u8F7D\u7A97\u53E3\u4E2D\u7684\u5B89\u5168\u6761\u76EE\u3002" }), state.phase === 'ready' && !hasItems && state.incompleteCount === 0 && _jsx("p", { className: 'devflow-muted', children: "\u5F53\u524D\u4F1A\u8BDD\u5DF2\u52A0\u8F7D\u7A97\u53E3\u91CC\u6CA1\u6709\u53EF\u89C1\u7684\u5B98\u65B9\u5DE5\u5177\u52A8\u6001\u3002" }), state.incompleteCount > 0 && _jsxs("p", { className: 'devflow-muted', children: ["\u6709 ", state.incompleteCount, " \u6761\u53EF\u89C1\u5DE5\u5177\u8C03\u7528\u56E0\u4E3A\u6CA1\u6709\u786E\u8BA4\u5230\u6D3B\u8DC3\u7ED3\u679C\u800C\u88AB\u7565\u8FC7\u3002"] }), hasItems && _jsx("ol", { className: 'devflow-tool-list', children: state.items.map(item => _jsx(ToolActivityItem, { item: item }, item.id)) }), state.hasMore && _jsx("p", { className: 'devflow-muted', children: "\u66F4\u65E9\u7684\u4F1A\u8BDD\u5386\u53F2\u5728\u8FD9\u4E2A\u5DF2\u52A0\u8F7D\u7A97\u53E3\u4E4B\u5916\uFF0C\u672C\u89C6\u56FE\u4E0D\u4F1A\u53BB\u52A0\u8F7D\u5B83\u3002" })] });
}
function ToolActivityItem({ item }) {
    return _jsxs("li", { "data-status": item.status, children: [_jsxs("div", { className: 'devflow-tool-title', children: [_jsx("strong", { children: item.toolName }), _jsx("em", { children: toolStatusLabel(item.status) })] }), _jsxs("dl", { className: 'devflow-tool-meta', children: [_jsxs("div", { children: [_jsx("dt", { children: "\u8C03\u7528" }), _jsx("dd", { title: item.callId, children: shortId(item.callId, 18) })] }), _jsxs("div", { children: [_jsx("dt", { children: "\u5F00\u59CB" }), _jsxs("dd", { children: [item.startedAt ?? '不可见', item.startSeq === null ? '' : ` · #${item.startSeq}`] })] }), _jsxs("div", { children: [_jsx("dt", { children: "\u7ED3\u679C" }), _jsxs("dd", { children: [item.endedAt ?? '不可见', item.resultSeq === null ? '' : ` · #${item.resultSeq}`] })] }), _jsxs("div", { children: [_jsx("dt", { children: "\u8017\u65F6" }), _jsx("dd", { children: item.durationMs === null ? '不可用' : `${item.durationMs} 毫秒` })] })] }), _jsxs("p", { className: 'devflow-tool-summary', children: ["\u7ED3\u679C \u00B7 ", item.resultSummary] }), _jsx("p", { className: 'devflow-tool-relation', children: "\u672A\u77E5 \u2014 \u6CA1\u6709\u8BB0\u5F55\u5230 DevFlow \u5173\u8054" })] });
}
function toolStatusLabel(status) {
    return ({ running: '进行中', succeeded: '成功', failed: '失败', 'result-without-call': '只有结果、看不到调用' })[status];
}
function inspectorTabLabel(tab) {
    return ({ flow: '派发流', audit: '审计', tools: '本会话' })[tab];
}
function BusinessAudit({ state, model, onSelect, onRefresh, onMore, onRetry }) {
    if (state === null)
        return _jsxs("section", { className: 'devflow-audit', children: [_jsx(InspectorSourceHeading, { title: "\u4E1A\u52A1\u5BA1\u8BA1", badges: ['共享 · .devflow'] }), _jsx("p", { className: 'devflow-muted', children: "\u5F53\u524D\u5BA2\u6237\u7AEF\u7248\u672C\u6CA1\u6709\u4E1A\u52A1\u5BA1\u8BA1\u80FD\u529B\u3002" })] });
    if (state.phase === 'idle' || state.phase === 'loading')
        return _jsxs("section", { className: 'devflow-audit', "aria-busy": "true", children: [_jsx(AuditHeading, { onRefresh: onRefresh }), _jsx("p", { className: 'devflow-muted', children: "\u6B63\u5728\u8BFB\u53D6\u5171\u4EAB DevFlow \u4E1A\u52A1\u5BA1\u8BA1\u2026" })] });
    if (state.phase === 'error' && state.page === null)
        return _jsxs("section", { className: 'devflow-audit', children: [_jsx(AuditHeading, { onRefresh: onRefresh }), _jsx("p", { className: 'devflow-audit-error', children: "DevFlow \u5BA1\u8BA1\u4E0D\u53EF\u7528\uFF0C\u8BF7\u5237\u65B0\u91CD\u8BD5\u3002" }), _jsx("button", { type: "button", className: 'devflow-audit-action', onClick: onRetry, children: "\u91CD\u8BD5" })] });
    const page = state.page;
    if (page === null)
        return null;
    return _jsxs("section", { className: 'devflow-audit', children: [_jsx(AuditHeading, { onRefresh: onRefresh }), state.phase === 'refreshing' && _jsx("p", { className: 'devflow-audit-stale', children: "\u5237\u65B0\u4E2D \u00B7 \u663E\u793A\u6700\u8FD1\u4E00\u6B21\u6210\u529F\u7684\u5BA1\u8BA1\u6570\u636E" }), state.phase === 'error' && _jsxs("div", { className: 'devflow-audit-error', role: "alert", children: ["DevFlow \u5BA1\u8BA1\u4E0D\u53EF\u7528\uFF0C\u663E\u793A\u6700\u8FD1\u4E00\u6B21\u6210\u529F\u7684\u6570\u636E\u3002", _jsx("button", { type: "button", className: 'devflow-audit-action', onClick: onRetry, children: "\u91CD\u8BD5" })] }), page.items.length === 0
                ? _jsx("p", { className: 'devflow-muted', children: "\u5F53\u524D\u9879\u76EE\u6216\u5BF9\u8C61\u6CA1\u6709\u53EF\u5C55\u793A\u7684 DevFlow \u4E1A\u52A1\u5BA1\u8BA1\u8BB0\u5F55\u3002" })
                : _jsx("ol", { className: 'devflow-audit-list', children: page.items.map(item => _jsx(AuditItem, { item: item, model: model, onSelect: onSelect }, item.id)) }), page.omittedUnsafeCount > 0 && _jsxs("p", { className: 'devflow-muted', children: ["\u6709 ", page.omittedUnsafeCount, " \u6761\u4E0D\u5B89\u5168\u6216\u4E0D\u53D7\u652F\u6301\u7684\u5BA1\u8BA1\u8BB0\u5F55\u5DF2\u9690\u85CF\u3002"] }), page.truncated && _jsx("p", { className: 'devflow-muted', children: "\u672C\u9875\u5728\u5B8C\u6574\u8BB0\u5F55\u8FB9\u754C\u5904\u88AB\u5B89\u5168\u622A\u65AD\u3002" }), page.nextCursor !== null && _jsx("button", { type: "button", className: 'devflow-audit-action', disabled: state.phase !== 'ready', onClick: onMore, children: state.phase === 'loading-more' ? '加载中…' : '加载更多' })] });
}
function AuditHeading({ onRefresh, disabled = false }) {
    return _jsxs("header", { className: 'devflow-audit-heading', children: [_jsxs("div", { children: [_jsx("h3", { children: "\u4E1A\u52A1\u5BA1\u8BA1" }), _jsx("span", { className: 'devflow-source-badge', children: "\u5171\u4EAB \u00B7 .devflow" })] }), _jsx("button", { type: "button", className: 'devflow-audit-action', disabled: disabled, onClick: onRefresh, children: "\u5237\u65B0" })] });
}
function AuditItem({ item, model, onSelect }) {
    const related = relatedSelection(item, model);
    return _jsxs("li", { "data-incomplete": item.incomplete, children: [_jsxs("div", { className: 'devflow-audit-meta', children: [_jsx("time", { children: item.at }), _jsxs("span", { children: ["#", item.sequence] })] }), _jsxs("strong", { children: [auditLabel(item.category), " \u00B7 ", auditLabel(item.action)] }), item.status !== null && _jsx("em", { children: item.status }), related === undefined ? _jsx("p", { children: item.entity.display?.text ?? (item.incomplete ? '未知 / 历史遗留记录' : '当前没有对应对象') }) : _jsx("button", { type: "button", onClick: () => { onSelect(related); }, children: auditEntityLabel(item, model) }), item.summary !== null && _jsx(SafeText, { text: item.summary.text, truncated: item.summary.truncated, redacted: item.summary.redacted }), item.incomplete && _jsx("small", { children: "\u5386\u53F2\u9057\u7559\u6216\u4E0D\u5B8C\u6574\u8BB0\u5F55" })] });
}
function relatedSelection(item, model) {
    const id = item.entity.id;
    if (item.entity.type === 'phase' && id !== null && model.phases.some(phase => phase.id === id))
        return { kind: 'phase', id };
    if (item.entity.type === 'task' && id !== null && model.taskById.has(id))
        return { kind: 'task', id };
    if (item.entity.type === 'agent' && id !== null && model.agentById.has(id))
        return { kind: 'agent', id };
    if (item.entity.type === 'execution' && id !== null && model.executionById.has(id))
        return { kind: 'execution', id };
    if ((item.entity.type === 'decision' || item.entity.type === 'decision-request') && id !== null && (model.decisionsById.has(id) || model.decisionRequestsById.has(id)))
        return { kind: 'decision', id };
    return undefined;
}
function auditEntityLabel(item, model) {
    const id = item.entity.id;
    if (id === null)
        return '未知 / 历史遗留记录';
    if (item.entity.type === 'phase')
        return model.phases.find(phase => phase.id === id)?.name ?? '未知 / 阶段已删除';
    if (item.entity.type === 'task')
        return model.taskById.get(id)?.task.title ?? '未知 / 任务已删除';
    if (item.entity.type === 'agent')
        return model.agentById.get(id)?.agent.displayName ?? '未知 / Agent 已删除';
    if (item.entity.type === 'execution')
        return `执行 ${shortId(id)}`;
    return `决策 ${shortId(id)}`;
}
/**
 * Audit categories/actions arrive as stored English enum values. The panel shows
 * a Chinese name where one exists and falls back to the stored value, so an
 * unmapped code is visible rather than silently blanked.
 */
const AUDIT_WORDS = {
    project: '项目', task: '任务', phase: '阶段', agent: 'Agent', assignment: '派发',
    execution: '执行', attempt: '尝试', report: '报告', decision: '决策', control: '控制',
    scope: '范围', 'bridge-review': '桥接复核', runtime: '运行时', 'commander-action': '总指挥动作',
    updated: '更新', created: '创建', removed: '移除', transitioned: '状态流转', assigned: '已派发',
    unassigned: '已取消派发', started: '开始', completed: '完成', failed: '失败', blocked: '阻塞',
    requested: '已请求', answered: '已回答', paused: '已暂停', resumed: '已恢复', imported: '已导入',
    exported: '已导出', 'boundary-hit': '触达边界', executed: '已执行',
};
function auditLabel(value) {
    const known = AUDIT_WORDS[value];
    if (known !== undefined)
        return known;
    return value.split('-').map(part => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(' ');
}
/** Render one bounded audit summary without ever echoing raw runtime text. */
function SafeText({ text, truncated, redacted }) {
    return _jsxs("p", { children: [text, redacted ? _jsx("em", { children: " \u00B7 \u654F\u611F\u5185\u5BB9\u5DF2\u9690\u85CF" }) : truncated ? _jsx("em", { children: " \u00B7 \u5DF2\u622A\u65AD" }) : null] });
}
