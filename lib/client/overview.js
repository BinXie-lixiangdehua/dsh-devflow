/**
 * Step 3B — the top-right overview float's read model, and its session gate.
 *
 * Two responsibilities, both pure so they can be asserted without a browser:
 *
 *  1. {@link overviewGate} — the round's hard requirement, executed as **deny by
 *     default**: `shell.overlay` is ROOT-scoped, so the host does not filter it by
 *     session and this module must. The float exists only while the current session's
 *     `agentPreset` is exactly `devflow`; every other case — standard mode, another
 *     preset, a session with no recorded preset, and the instant before the preset is
 *     resolved — renders nothing at all. No placeholder, no empty strip: absence is
 *     the correct semantics for "this session is not a DevFlow session".
 *
 *  2. {@link buildOverview} — the numbers and rows the float shows. It reads the SAME
 *     `FlowModel` the canvas renders, so the float and the right panel can never
 *     disagree: the counts are a `group by` over the very edges the canvas draws.
 */
import { applyPausePresentation } from "./pause-presentation.js";
import { createFlowModel } from "./flow-projection.js";
import { CONNECTION_LOST_DETAIL } from "./store.js";
import { flowAgentName } from "./workspace.js";
/** The one preset that owns this float. */
export const DEVFLOW_PRESET = 'devflow';
/** The float's own identity in `shell.overlay`, and its localStorage namespace. */
export const OVERVIEW_CELL_ID = 'devflow-overview';
/**
 * The window event the panel's header action dispatches to bring a CLOSED float back.
 *
 * It lives here, in the pure module both sides already import, so the panel does not
 * have to reach into the float's component module (which would make the two import
 * each other).
 */
export const OVERVIEW_REOPEN_EVENT = 'devflow:overview-reopen';
/**
 * Storage keys: folding, the explicit close, and the skin the float renders in.
 *
 * The fold and the close are remembered **per session** (see
 * {@link overviewClosedKey} / {@link overviewExpandedKey}). They are UI
 * preferences ABOUT ONE SESSION's float, and a single global flag made one
 * accidental click hide the overview in every DevFlow session — including
 * projects the operator never touched — with no way back except hunting for the
 * panel's reopen action. The `*_KEY` constants below are the LEGACY global keys:
 * they are only read to be discarded (see `legacyFlagCleanup`).
 */
export const OVERVIEW_EXPANDED_KEY = 'devflow.overview.expanded';
export const OVERVIEW_CLOSED_KEY = 'devflow.overview.closed';
/**
 * The per-session close key.
 *
 * Scoped by session id so "I don't need the overview here" stays a decision about
 * THAT session. An id-less call falls back to the legacy global key, which keeps
 * the read total instead of throwing on an unexpected state.
 * @param sessionId - the session the float belongs to.
 * @returns the storage key for that session's close flag.
 */
export function overviewClosedKey(sessionId) {
    return sessionId === null || sessionId === undefined || sessionId === ''
        ? OVERVIEW_CLOSED_KEY
        : `${OVERVIEW_CLOSED_KEY}.${sessionId}`;
}
/**
 * The per-session fold key; same scoping rule as {@link overviewClosedKey}.
 * @param sessionId - the session the float belongs to.
 * @returns the storage key for that session's fold flag.
 */
export function overviewExpandedKey(sessionId) {
    return sessionId === null || sessionId === undefined || sessionId === ''
        ? OVERVIEW_EXPANDED_KEY
        : `${OVERVIEW_EXPANDED_KEY}.${sessionId}`;
}
/**
 * Remove the legacy GLOBAL flags once, so they cannot keep hiding the float.
 *
 * A global `closed` written by an older build would otherwise hide the float
 * forever: the per-session key it is read from now would never match, and the
 * stale flag would sit there resurrecting the bug for anyone whose session id
 * ever collided with it.
 * @param storage - the storage to clean, or null when unavailable.
 */
export function legacyFlagCleanup(storage) {
    if (storage === null)
        return;
    try {
        storage.removeItem(OVERVIEW_CLOSED_KEY);
        storage.removeItem(OVERVIEW_EXPANDED_KEY);
    }
    catch { /* private mode: nothing to clean */ }
}
/** One shared skin key with the canvas, so the two surfaces always agree. */
export const OVERVIEW_SKIN_KEY = 'devflow.overview.skin';
export const DEVFLOW_SKIN_KEY = 'devflow.flow.skin';
/**
 * Decide whether the float may exist for the current session.
 *
 * @param sessions - the client session list state.
 * @returns the gate decision; `allowed` is true for exactly one case.
 */
export function overviewGate(sessions) {
    if (sessions === undefined || sessions === null || sessions.current === undefined) {
        return { allowed: false, sessionId: null, preset: null, reason: 'no-session' };
    }
    const sessionId = sessions.current;
    const summary = sessions.byId[sessionId];
    const raw = summary?.projectionValues?.agentPreset;
    // A session whose preset is not recorded yet is NOT a DevFlow session: "later is
    // better than appear-then-disappear", so an unresolved preset refuses.
    if (typeof raw !== 'string' || raw === '')
        return { allowed: false, sessionId, preset: null, reason: 'preset-unresolved' };
    if (raw !== DEVFLOW_PRESET)
        return { allowed: false, sessionId, preset: raw, reason: 'other-preset' };
    return { allowed: true, sessionId, preset: raw, reason: 'allowed' };
}
/** Chinese wording for the live-channel posture; never a raw transport string. */
export function connectionLabel(connection) {
    if (connection === null)
        return '轮询兜底';
    if (connection.phase === 'live')
        return '实时通道';
    if (connection.phase === 'connecting')
        return '连接中';
    return '轮询兜底';
}
/** The reason line under a polling badge, or null while the channel is healthy. */
export function connectionDetail(connection) {
    if (connection === null || connection.phase !== 'polling')
        return null;
    return connection.detail ?? CONNECTION_LOST_DETAIL;
}
/** How many dispatch edges the default (current) view hides behind 全部历史. */
export function hiddenDispatchCount(flow) {
    return Math.max(0, flow.history.edges.length - flow.current.edges.length);
}
/**
 * Build the float's read model from the same inputs the canvas uses.
 *
 * @param model - the workspace model folded from the snapshot.
 * @param now - the clock the stale judgement uses (the canvas passes the same one).
 * @param connection - the live-channel posture, or null when unavailable.
 * @returns the overview view model.
 */
export function buildOverview(model, now, connection = null) {
    const paused = model.snapshot.paused;
    // The counts are read over the FULL history of dispatches, because "how many
    // dispatches ended up like this" is a project fact, not a view fact; the 已隐藏
    // count then reports how many of them the default canvas view is not drawing.
    const flow = applyPausePresentation(createFlowModel(model, now, {}, 'history'), paused);
    const counts = {
        ...countEdges(flow.history.edges, model),
        unrouted: flow.unroutedCount,
        hidden: hiddenDispatchCount(flow),
    };
    const total = flow.history.edges.length;
    const commander = flow.nodes.find(node => node.id === flow.commanderId);
    /**
     * The employee rows, both rosters.
     *
     * The fixed four are listed always — they are the team, whether or not they are
     * holding anything right now. A temporary sub-agent is listed only when the
     * canvas actually draws it (one card, one row): the float and the canvas read the
     * same node set, so "画布上有卡、概览说没人" cannot happen.
     */
    const rosterIds = new Set(flow.nodes.map(node => node.id));
    const members = model.agents
        .filter(item => item.agent.id !== flow.commanderId)
        .filter(item => item.agent.kind === 'fixed' || rosterIds.has(item.agent.id))
        .map(item => memberRow(item.agent, flow));
    return {
        projectName: model.snapshot.project?.name ?? '（未初始化）',
        bindingLabel: model.snapshot.session.commanderMode === 'commander' ? '已绑定' : '未绑定',
        paused,
        counts,
        total,
        summary: summaryLine(counts.lost, counts.active, counts.review, counts.done),
        posture: postureOf(counts),
        postureLabel: postureLabel(postureOf(counts)),
        commanderName: flowAgentName(flow.commanderId, commander?.label ?? '总指挥'),
        commanderStateLabel: paused ? '已暂停' : (commander?.stateLabel ?? '未知'),
        dispatchCount: total,
        members,
        connectionLabel: connectionLabel(connection),
        connectionPhase: connection?.phase ?? 'polling',
    };
}
/**
 * The project's dispatch ledger, bucketed the way the panel talks about it.
 *
 * 待验收 is NOT a stored state: a dispatch is waiting for acceptance while it is
 * finished (`done`) and its task is still in 复核中 — the stored status is literally
 * `reviewing`, which the panel words as `Reviewing` (see `taskWorkStateLabel`).
 * Reading it any other way would need a second source of truth, which the round forbids.
 */
function countEdges(edges, model) {
    let active = 0;
    let review = 0;
    let done = 0;
    let lost = 0;
    let paused = 0;
    let closed = 0;
    for (const edge of edges) {
        if (edge.state === 'executing' || edge.state === 'queued') {
            active += 1;
            continue;
        }
        if (edge.state === 'rework') {
            active += 1;
            continue;
        }
        if (edge.state === 'paused') {
            paused += 1;
            continue;
        }
        if (edge.state === 'lost') {
            lost += 1;
            continue;
        }
        // 已收尾 is its OWN bucket: it must not inflate 未收尾 · 已失联, which is the whole
        // point of the round's change to the counts.
        if (edge.state === 'closed') {
            closed += 1;
            continue;
        }
        if (edge.state === 'done') {
            if (edge.taskId !== null && model.taskById.get(edge.taskId)?.workState === 'reviewing')
                review += 1;
            else
                done += 1;
        }
    }
    return { active, review, done, lost, paused, closed, unrouted: 0, hidden: 0 };
}
/** The pill's headline: the lede is what is happening now, then what is stuck. */
function summaryLine(lost, active, review, done) {
    const parts = [];
    if (active > 0)
        parts.push(`进行中 ${active}`);
    if (review > 0)
        parts.push(`待验收 ${review}`);
    if (parts.length === 0)
        parts.push(done > 0 && lost === 0 ? '全部完成' : lost > 0 ? '无进行中' : '暂无派发');
    if (lost > 0)
        parts.push(`未收尾 ${lost}`);
    return parts.join(' · ');
}
/**
 * The pill's status dot. 已收尾 does NOT make the project "active": a project whose only
 * remaining records were wrapped up has nothing happening, so the posture is allowed to
 * read 全部完成 — the closed count is reported in the card's own row instead.
 */
function postureOf(counts) {
    if (counts.active > 0 || counts.lost > 0 || counts.paused > 0)
        return 'active';
    if (counts.review > 0)
        return 'review';
    return 'done';
}
function postureLabel(posture) {
    return posture === 'active' ? '进行中' : posture === 'review' ? '待验收' : '全部完成';
}
/** One employee's row: the node the canvas draws, plus the dispatch it holds. */
function memberRow(agent, flow) {
    const node = flow.nodes.find(candidate => candidate.id === agent.id);
    return {
        id: agent.id,
        name: flowAgentName(agent.id, agent.displayName),
        kind: agent.kind === 'temporary' ? 'temporary' : 'fixed',
        state: node?.state ?? 'idle',
        stateLabel: node?.stateLabel ?? '空闲',
        taskTitle: node?.taskTitle ?? null,
    };
}
