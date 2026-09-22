const HIGH_RISK_PATTERN = /\b(delete|remove|drop|destroy|truncate)\b/i;
function decisionFor(projection, project, task, trigger) {
    const requests = Object.values(projection.decisionRequests).filter(request => request.trigger === trigger);
    const projectRequests = requests.filter(request => request.projectId === project.id);
    if (projectRequests.length === 0) {
        return {
            request: undefined,
            mismatch: requests.length === 0 ? null : 'high-risk-decision-project-mismatch',
        };
    }
    const taskRequests = projectRequests.filter(request => request.taskId === task.id);
    if (taskRequests.length === 0) {
        return {
            request: undefined,
            mismatch: trigger === 'review-failed-twice' ? 'review-decision-task-mismatch' : 'high-risk-decision-task-mismatch',
        };
    }
    return { request: taskRequests.at(-1), mismatch: null };
}
function expired(request, task) {
    if (request.status !== 'answered' || request.answeredAt === null)
        return false;
    const answeredAt = Date.parse(request.answeredAt);
    const taskUpdatedAt = Date.parse(task.updatedAt);
    return Number.isFinite(answeredAt) && Number.isFinite(taskUpdatedAt) && answeredAt < taskUpdatedAt;
}
/** Evaluate every dispatch decision gate without reading or mutating external state. */
export function evaluateDispatchGates(task, projection, project) {
    const highRisk = HIGH_RISK_PATTERN.test(`${task.title}\n${task.description}`);
    if (projection === undefined) {
        return { allowed: false, blockedBy: 'projection-unavailable', requiredDecision: null, projectionStatus: 'unavailable', reviewFailCount: 0, decisionStatus: undefined, highRisk };
    }
    const reviewFailCount = projection.reviewFailCounts[task.id] ?? 0;
    if (reviewFailCount >= 2) {
        const selected = decisionFor(projection, project, task, 'review-failed-twice');
        if (selected.mismatch !== null)
            return { allowed: false, blockedBy: selected.mismatch, requiredDecision: 'review-failed-twice', projectionStatus: 'available', reviewFailCount, highRisk, decisionStatus: 'mismatch' };
        if (selected.request === undefined)
            return { allowed: false, blockedBy: 'review-decision-missing', requiredDecision: 'review-failed-twice', projectionStatus: 'available', reviewFailCount, highRisk, decisionStatus: 'missing' };
        if (selected.request.status === 'pending')
            return { allowed: false, blockedBy: 'review-decision-pending', requiredDecision: 'review-failed-twice', projectionStatus: 'available', reviewFailCount, highRisk, decisionStatus: 'pending' };
        if (selected.request.status !== 'answered')
            return { allowed: false, blockedBy: 'review-decision-missing', requiredDecision: 'review-failed-twice', projectionStatus: 'available', reviewFailCount, highRisk, decisionStatus: selected.request.status };
        if (expired(selected.request, task))
            return { allowed: false, blockedBy: 'review-decision-expired', requiredDecision: 'review-failed-twice', projectionStatus: 'available', reviewFailCount, highRisk, decisionStatus: 'expired' };
    }
    if (highRisk) {
        const selected = decisionFor(projection, project, task, 'high-risk-operation');
        if (selected.mismatch !== null)
            return { allowed: false, blockedBy: selected.mismatch, requiredDecision: 'high-risk-operation', projectionStatus: 'available', reviewFailCount, highRisk, decisionStatus: 'mismatch' };
        if (selected.request === undefined)
            return { allowed: false, blockedBy: 'high-risk-decision-missing', requiredDecision: 'high-risk-operation', projectionStatus: 'available', reviewFailCount, highRisk, decisionStatus: 'missing' };
        if (selected.request.status === 'pending')
            return { allowed: false, blockedBy: 'high-risk-decision-pending', requiredDecision: 'high-risk-operation', projectionStatus: 'available', reviewFailCount, highRisk, decisionStatus: 'pending' };
        if (selected.request.status !== 'answered')
            return { allowed: false, blockedBy: 'high-risk-decision-missing', requiredDecision: 'high-risk-operation', projectionStatus: 'available', reviewFailCount, highRisk, decisionStatus: selected.request.status };
        if (expired(selected.request, task))
            return { allowed: false, blockedBy: 'high-risk-decision-expired', requiredDecision: 'high-risk-operation', projectionStatus: 'available', reviewFailCount, highRisk, decisionStatus: 'expired' };
    }
    return { allowed: true, blockedBy: null, requiredDecision: null, projectionStatus: 'available', reviewFailCount, decisionStatus: undefined, highRisk };
}
/** Render a short, non-secret diagnostic error message for a dispatch gate. */
export function dispatchGateMessage(result) {
    if (result.allowed || result.blockedBy === null)
        return 'dispatch gates passed';
    return `dispatch blocked by ${result.blockedBy}${result.requiredDecision === null ? '' : `; required decision ${result.requiredDecision}`}`;
}
/** Keep diagnostic text bounded before it enters the plugin-owned journal. */
export function boundedDiagnosticText(value, limit = 2000) {
    return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}
/** Create an immutable diagnostic snapshot from a partial set of facts. */
export function makeDispatchDiagnostic(input) {
    return {
        ...input,
        ...(input.toolFilter === undefined ? {} : { toolFilter: [...input.toolFilter] }),
    };
}
