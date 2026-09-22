const MAX_ITEMS = 20;
const MAX_SAFE_STATE_BYTES = 32 * 1024;
const MAX_ID_LENGTH = 128;
const MAX_TOOL_NAME_LENGTH = 128;
const CONTROL_CHARACTER = /[\p{Cc}\p{Cf}]/u;
const SOURCE = 'harness-official-tool';
const WINDOW = 'current-loaded-window';
const UNKNOWN_RELATION = { kind: 'unknown' };
export function mapCurrentSessionTools(expectedSessionId, sources) {
    const { session, chat } = sources;
    if (!isSafeIdentifier(expectedSessionId))
        return unavailableState();
    try {
        if (session.sessionId !== expectedSessionId || !isSafeIdentifier(String(session.sessionId)))
            return unavailableState();
        if (session.subagent !== null)
            return unavailableState();
        const read = readSafeItems(expectedSessionId, session, chat);
        if (read === null)
            return unavailableState();
        const { items, incompleteCount } = read;
        const hasMore = session.hasMore === true;
        if (read.storeUnavailable)
            return state('unavailable', items, hasMore, items.length > 0, incompleteCount);
        if (session.openState === 'open')
            return state('ready', items, hasMore, false, incompleteCount);
        if (session.openState === 'cold' || session.openState === 'loading') {
            return state('loading', items, hasMore, items.length > 0, incompleteCount);
        }
        if (session.openState === 'error')
            return state('unavailable', items, hasMore, items.length > 0, incompleteCount);
        return unavailableState();
    }
    catch {
        return unavailableState();
    }
}
export function equalCurrentSessionToolsState(left, right) {
    if (left === right)
        return true;
    if (left.phase !== right.phase || left.hasMore !== right.hasMore || left.staleSafeItems !== right.staleSafeItems || left.incompleteCount !== right.incompleteCount || left.items.length !== right.items.length)
        return false;
    return left.items.every((item, index) => equalActivity(item, right.items[index]));
}
function readSafeItems(sessionId, session, chat) {
    const nodes = chat.nodes;
    if (nodes === null || typeof nodes !== 'object' || typeof nodes.get !== 'function')
        return null;
    const order = chat.order;
    if (!Array.isArray(order) || !order.every(key => typeof key === 'string'))
        return null;
    const items = [];
    let storeUnavailable = false;
    let incompleteCount = 0;
    for (const key of order) {
        let value;
        try {
            value = nodes.get(key);
        }
        catch {
            storeUnavailable = true;
            continue;
        }
        if (!isToolChatNode(value))
            continue;
        try {
            if (isUnconfirmedToolNode(value, session)) {
                incompleteCount++;
                continue;
            }
            const candidate = mapToolNode(sessionId, value);
            if (candidate !== null)
                insertBounded(items, candidate);
        }
        catch {
            continue;
        }
    }
    return serializedStateSize(items, incompleteCount) <= MAX_SAFE_STATE_BYTES ? { items, storeUnavailable, incompleteCount } : null;
}
function isUnconfirmedToolNode(node, session) {
    const root = node.data.root;
    if ('kind' in root)
        return root.kind === 'tool-result' && isFiniteFraction(root.seq);
    if (session.running !== true)
        return true;
    const location = node.location;
    if (location.kind === 'step')
        return location.step.status !== 'open' || location.turn.status !== 'open';
    if (location.kind === 'turn')
        return location.turn.status !== 'open';
    return true;
}
function mapToolNode(sessionId, node) {
    const root = node.data.root;
    const callId = root.callId;
    if (!isSafeIdentifier(callId))
        return null;
    if (!('kind' in root))
        return mapRunning(sessionId, callId, node.anchorSeq, root);
    if (root.kind !== 'tool-result')
        return null;
    return mapSettled(sessionId, callId, node.anchorSeq, root);
}
function mapRunning(sessionId, callId, anchorSeq, root) {
    const start = safeTime(root.time);
    return activity({
        sessionId,
        callId,
        toolName: safeToolName(root.name),
        status: 'running',
        startedAt: start?.iso ?? null,
        endedAt: null,
        durationMs: null,
        startSeq: safeSequence(anchorSeq),
        resultSeq: null,
        resultSummary: 'running',
    });
}
function mapSettled(sessionId, callId, anchorSeq, root) {
    if (typeof root.isError !== 'boolean')
        return null;
    const resultSeq = safeSequence(root.seq);
    if (root.call === null) {
        if (resultSeq === null)
            return null;
        const end = safeTime(root.time);
        return activity({
            sessionId,
            callId,
            toolName: 'Unknown tool',
            status: 'result-without-call',
            startedAt: null,
            endedAt: end?.iso ?? null,
            durationMs: null,
            startSeq: null,
            resultSeq,
            resultSummary: 'result received without visible call',
        });
    }
    const startSeq = safeSequence(anchorSeq);
    const start = safeTime(root.callTime);
    if (resultSeq === null)
        return null;
    if (startSeq !== null && resultSeq <= startSeq)
        return null;
    const end = safeTime(root.time);
    const failed = root.isError === true;
    return activity({
        sessionId,
        callId,
        toolName: safeToolName(root.call.name),
        status: failed ? 'failed' : 'succeeded',
        startedAt: start?.iso ?? null,
        endedAt: end?.iso ?? null,
        durationMs: start !== null && end !== null && end.epochMs >= start.epochMs ? end.epochMs - start.epochMs : null,
        startSeq,
        resultSeq,
        resultSummary: failed ? 'failed' : 'completed',
    });
}
function activity(input) {
    return {
        id: `${input.sessionId}:${input.callId}`,
        source: SOURCE,
        sessionId: input.sessionId,
        callId: input.callId,
        toolName: input.toolName,
        status: input.status,
        startedAt: input.startedAt,
        endedAt: input.endedAt,
        durationMs: input.durationMs,
        startSeq: input.startSeq,
        resultSeq: input.resultSeq,
        resultSummary: input.resultSummary,
        devflowRelation: UNKNOWN_RELATION,
    };
}
function insertBounded(items, candidate) {
    const duplicateIndex = items.findIndex(item => item.id === candidate.id);
    if (duplicateIndex >= 0)
        items[duplicateIndex] = preferredActivity(items[duplicateIndex], candidate);
    else if (items.length < MAX_ITEMS)
        items.push(candidate);
    else if (compareActivity(candidate, items[MAX_ITEMS - 1]) < 0)
        items[MAX_ITEMS - 1] = candidate;
    else
        return;
    items.sort(compareActivity);
    if (items.length > MAX_ITEMS)
        items.length = MAX_ITEMS;
}
function preferredActivity(left, right) {
    const leftRank = evidenceRank(left.status);
    const rightRank = evidenceRank(right.status);
    if (leftRank !== rightRank)
        return leftRank > rightRank ? left : right;
    const leftSeq = sortSequence(left);
    const rightSeq = sortSequence(right);
    if (leftSeq !== rightSeq)
        return leftSeq > rightSeq ? left : right;
    if (left.status !== right.status && (left.status === 'failed' || right.status === 'failed'))
        return left.status === 'failed' ? left : right;
    return compareCodeUnits(activityFingerprint(left), activityFingerprint(right)) <= 0 ? left : right;
}
function evidenceRank(status) {
    if (status === 'running')
        return 0;
    if (status === 'result-without-call')
        return 1;
    return 2;
}
function compareActivity(left, right) {
    const leftSeq = sortSequence(left);
    const rightSeq = sortSequence(right);
    if (leftSeq !== rightSeq)
        return leftSeq > rightSeq ? -1 : 1;
    return compareCodeUnits(left.callId, right.callId);
}
function sortSequence(item) {
    return item.resultSeq ?? item.startSeq ?? -1;
}
function compareCodeUnits(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
function activityFingerprint(item) {
    return JSON.stringify([
        item.status,
        item.toolName,
        item.startedAt,
        item.endedAt,
        item.durationMs,
        item.startSeq,
        item.resultSeq,
        item.resultSummary,
    ]);
}
function isToolChatNode(value) {
    try {
        if (value === null || typeof value !== 'object')
            return false;
        const node = value;
        if (node.kind !== 'tool-call' || node.target !== 'chat' || node.visibility !== 'visible' || node.data === null || typeof node.data !== 'object')
            return false;
        const data = node.data;
        if (data.root === null || typeof data.root !== 'object')
            return false;
        const root = data.root;
        return typeof root.callId === 'string';
    }
    catch {
        return false;
    }
}
function serializedStateSize(items, incompleteCount) {
    return new TextEncoder().encode(JSON.stringify({
        phase: 'unavailable',
        source: SOURCE,
        window: WINDOW,
        hasMore: true,
        staleSafeItems: true,
        incompleteCount,
        items,
    })).byteLength;
}
function isSafeIdentifier(value) {
    return value.length > 0 && codePointLengthAtMost(value, MAX_ID_LENGTH) && !CONTROL_CHARACTER.test(value);
}
function safeToolName(value) {
    return typeof value === 'string' && value.length > 0 && codePointLengthAtMost(value, MAX_TOOL_NAME_LENGTH) && !CONTROL_CHARACTER.test(value)
        ? value
        : 'Unknown tool';
}
function codePointLengthAtMost(value, maximum) {
    let length = 0;
    for (const _character of value) {
        length++;
        if (length > maximum)
            return false;
    }
    return true;
}
function safeSequence(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function isFiniteFraction(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && !Number.isInteger(value);
}
function safeTime(value) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
        return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime()))
        return null;
    return { epochMs: value, iso: date.toISOString() };
}
function equalActivity(left, right) {
    return right !== undefined
        && left.id === right.id
        && left.toolName === right.toolName
        && left.status === right.status
        && left.startedAt === right.startedAt
        && left.endedAt === right.endedAt
        && left.durationMs === right.durationMs
        && left.startSeq === right.startSeq
        && left.resultSeq === right.resultSeq
        && left.resultSummary === right.resultSummary;
}
function state(phase, items, hasMore, staleSafeItems, incompleteCount = 0) {
    return { phase, source: SOURCE, window: WINDOW, hasMore, staleSafeItems, incompleteCount, items };
}
function unavailableState() {
    return state('unavailable', [], false, false);
}
