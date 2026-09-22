export const PROJECT_SELECTION = { kind: 'project' };
/** Convert a Canvas selection into an exact, Host-enforced audit predicate. */
export function auditFilterForSelection(selection) {
    if (selection.kind === 'project' || selection.kind === 'commander')
        return { kind: 'project' };
    if (selection.kind === 'phase')
        return { kind: 'phase', id: selection.id };
    if (selection.kind === 'task')
        return { kind: 'task', id: selection.id };
    if (selection.kind === 'agent')
        return { kind: 'agent', id: selection.id };
    if (selection.kind === 'execution')
        return { kind: 'execution', id: selection.id };
    return { kind: 'decision', id: selection.id };
}
/** Build the read-only Canvas view model from the current V1 snapshot only. */
export function createWorkspaceModel(snapshot) {
    const phases = [...snapshot.phases].sort((left, right) => left.id.localeCompare(right.id));
    const results = bounded(snapshot.results);
    const reports = bounded(snapshot.reports);
    const attempts = bounded(snapshot.attempts);
    const failures = bounded(snapshot.failures);
    const assignmentsByPhase = groupBy(snapshot.assignments, assignment => assignment.phaseId);
    const assignmentsByTask = groupBy(snapshot.assignments.filter(hasTaskId), assignment => assignment.taskId);
    const executionsByTask = groupBy(snapshot.executions.filter(hasTaskId), execution => execution.taskId);
    const executionsByAgent = groupBy(snapshot.executions, execution => execution.agentId);
    const resultsByTask = groupBy(results, result => result.taskId);
    const reportsByExecution = groupBy(reports, report => report.executionId);
    const attemptsByExecution = groupBy(attempts, attempt => attempt.executionId);
    const failuresByExecution = groupBy(failures, failure => failure.executionId);
    const assignmentsByAgent = groupBy(snapshot.assignments, assignment => assignment.agentId);
    const pendingDecisionsByTask = groupBy(snapshot.decisionRequests.filter(hasPendingTaskId), request => request.taskId);
    const tasks = snapshot.tasks.map(task => {
        const assignments = assignmentsByTask.get(task.id) ?? [];
        const executions = executionsByTask.get(task.id) ?? [];
        const taskReports = executions.flatMap(execution => reportsByExecution.get(execution.id) ?? []);
        const taskAttempts = executions.flatMap(execution => attemptsByExecution.get(execution.id) ?? []);
        const taskFailures = executions.flatMap(execution => failuresByExecution.get(execution.id) ?? []);
        const pendingDecisions = pendingDecisionsByTask.get(task.id) ?? [];
        const phaseIds = unique(assignments.map(assignment => assignment.phaseId));
        return {
            task,
            assignments,
            executions,
            results: resultsByTask.get(task.id) ?? [],
            reports: taskReports,
            attempts: taskAttempts,
            failures: taskFailures,
            pendingDecisions,
            phaseIds,
            workState: taskWorkState(task, executions, pendingDecisions),
        };
    });
    const taskById = new Map(tasks.map(task => [task.task.id, task]));
    const agents = snapshot.agents.map(agent => {
        const assignments = assignmentsByAgent.get(agent.id) ?? [];
        const executions = executionsByAgent.get(agent.id) ?? [];
        const reports = executions.flatMap(execution => reportsByExecution.get(execution.id) ?? []);
        const failures = executions.flatMap(execution => failuresByExecution.get(execution.id) ?? []);
        const taskIds = unique([
            ...assignments.flatMap(assignment => assignment.taskId === undefined ? [] : [assignment.taskId]),
            ...executions.flatMap(execution => execution.taskId === undefined ? [] : [execution.taskId]),
        ]);
        const pendingDecisions = taskIds.flatMap(taskId => pendingDecisionsByTask.get(taskId) ?? []);
        const hasActiveTask = taskIds.some(taskId => taskById.get(taskId)?.workState === 'working');
        return {
            agent,
            assignments,
            executions,
            reports,
            failures,
            taskIds,
            pendingDecisions,
            workState: agentWorkState(agent, executions, pendingDecisions, hasActiveTask),
        };
    });
    const blockers = createBlockers(snapshot, tasks);
    const recentActivity = createRecentActivity(snapshot);
    return {
        snapshot,
        phases,
        tasks,
        agents,
        assignmentsByPhase,
        taskById,
        agentById: new Map(agents.map(agent => [agent.agent.id, agent])),
        executionById: new Map(snapshot.executions.map(execution => [execution.id, execution])),
        decisionRequestsById: new Map(snapshot.decisionRequests.map(request => [request.id, request])),
        decisionsById: new Map(snapshot.decisions.map(decision => [decision.id, decision])),
        blockers,
        recentActivity,
    };
}
/** True when a local selection still refers to an object in the refreshed snapshot. */
export function selectionExists(model, selection) {
    if (selection.kind === 'project' || selection.kind === 'commander')
        return true;
    if (selection.kind === 'phase')
        return model.phases.some(phase => phase.id === selection.id);
    if (selection.kind === 'task')
        return model.taskById.has(selection.id);
    if (selection.kind === 'agent')
        return model.agentById.has(selection.id);
    if (selection.kind === 'execution')
        return model.executionById.has(selection.id);
    return model.decisionRequestsById.has(selection.id) || model.decisionsById.has(selection.id);
}
/**
 * The single Chinese display name for a stored agent id.
 *
 * Correction R3 (step 3B): the canvas, the roster and the overview float each carried
 * their own copy of this table, so the same employee could be named differently in two
 * places. One table, one name; an unknown id falls back to what the record itself says.
 */
const AGENT_DISPLAY_NAMES = {
    commander: '总指挥',
    'backend-engineer': '代码工程师',
    'frontend-engineer': '前端工程师',
    architect: '架构师',
    'code-auditor': '审计工程师',
};
export function flowAgentName(agentId, displayName) {
    return AGENT_DISPLAY_NAMES[agentId] ?? displayName;
}
/** Render-safe title for the selected object. */
export function selectionLabel(model, selection) {
    if (selection.kind === 'project')
        return model.snapshot.project?.name ?? 'Shared project';
    if (selection.kind === 'commander')
        return 'Commander';
    if (selection.kind === 'phase')
        return model.phases.find(phase => phase.id === selection.id)?.name ?? selection.id;
    if (selection.kind === 'task')
        return model.taskById.get(selection.id)?.task.title ?? selection.id;
    if (selection.kind === 'agent')
        return model.agentById.get(selection.id)?.agent.displayName ?? selection.id;
    if (selection.kind === 'execution')
        return `Execution ${shortId(selection.id)}`;
    const request = model.decisionRequestsById.get(selection.id);
    return request === undefined ? `Decision ${shortId(selection.id)}` : request.question;
}
/** The nearest factual parent for a selection. Used by the local breadcrumb only. */
export function selectionParent(model, selection) {
    if (selection.kind === 'project')
        return undefined;
    if (selection.kind === 'commander')
        return PROJECT_SELECTION;
    if (selection.kind === 'phase' || selection.kind === 'agent')
        return PROJECT_SELECTION;
    if (selection.kind === 'task') {
        const phaseId = model.taskById.get(selection.id)?.phaseIds[0];
        return phaseId === undefined ? PROJECT_SELECTION : { kind: 'phase', id: phaseId };
    }
    if (selection.kind === 'execution') {
        const execution = model.executionById.get(selection.id);
        if (execution?.taskId !== undefined)
            return { kind: 'task', id: execution.taskId };
        return execution === undefined ? PROJECT_SELECTION : { kind: 'agent', id: execution.agentId };
    }
    const request = model.decisionRequestsById.get(selection.id);
    if (request?.taskId !== null && request?.taskId !== undefined)
        return { kind: 'task', id: request.taskId };
    if (model.decisionsById.has(selection.id))
        return PROJECT_SELECTION;
    return PROJECT_SELECTION;
}
/** All visible phase IDs relevant to a selection. Empty means show the full project view. */
export function focusedPhaseIds(model, selection) {
    if (selection.kind === 'phase')
        return new Set([selection.id]);
    if (selection.kind === 'task')
        return new Set(model.taskById.get(selection.id)?.phaseIds ?? []);
    if (selection.kind === 'agent') {
        return new Set(model.agentById.get(selection.id)?.assignments.map(assignment => assignment.phaseId) ?? []);
    }
    if (selection.kind === 'execution') {
        return focusedPhaseIds(model, selectionParent(model, selection) ?? PROJECT_SELECTION);
    }
    if (selection.kind === 'decision') {
        return focusedPhaseIds(model, selectionParent(model, selection) ?? PROJECT_SELECTION);
    }
    return new Set();
}
/** Whether a work item belongs to the selected object for visual focus only. */
export function isSelectionRelated(model, selection, taskId) {
    if (selection.kind === 'project' || selection.kind === 'commander')
        return true;
    if (selection.kind === 'task')
        return selection.id === taskId;
    if (selection.kind === 'phase')
        return model.taskById.get(taskId)?.phaseIds.includes(selection.id) ?? false;
    if (selection.kind === 'agent')
        return model.agentById.get(selection.id)?.taskIds.includes(taskId) ?? false;
    if (selection.kind === 'execution')
        return model.executionById.get(selection.id)?.taskId === taskId;
    const parent = selectionParent(model, selection);
    return parent === undefined ? false : isSelectionRelated(model, parent, taskId);
}
export function workStateLabel(state) {
    return ({ idle: 'Idle', working: 'Working', blocked: 'Blocked', done: 'Done', archived: 'Archived', unknown: 'Unknown' })[state];
}
export function lifecycleLabel(status) {
    return ({ active: 'Active', created: 'Created', running: 'Running', terminated: 'Terminated' })[status];
}
export function taskWorkStateLabel(state) {
    return ({
        created: 'Created', planned: 'Planned', working: 'Working', blocked: 'Blocked', reviewing: 'Reviewing',
        completed: 'Completed', failed: 'Needs rework', cancelled: 'Cancelled',
    })[state];
}
export function shortId(id, length = 10) {
    return id.length <= length ? id : `${id.slice(0, length)}…`;
}
/**
 * The last path segment of one workspace directory, for the panel identity line.
 *
 * The identity line is one compact Chinese line, so it names the project by its
 * directory while the full path stays available as the element's `title`. Both
 * separators are honoured because a session workspace is whatever the host
 * resolved, not necessarily this process's platform style; a path with no
 * segment at all is returned unchanged rather than rendered as an empty label.
 * @param path - the session workspace directory.
 * @returns its last segment, or the input when it has none.
 */
export function workspaceBasename(path) {
    const segments = path.split(/[\\/]+/).filter(segment => segment !== '');
    return segments[segments.length - 1] ?? path;
}
/**
 * Derive one task's work state from the task record plus its executions.
 *
 * "Failed" is a statement about the task's CURRENT attempt, not about its history:
 * a dispatch that failed and was then retried to a delivered result is not a failed
 * task any more. Reading the whole execution history instead made the state
 * permanent — once ANY execution of a task had failed, the task read 返工 forever,
 * even after a later attempt delivered (N5: `researcher-refs`'s assignment carries a
 * failed execution at 17:29 and a completed one at 17:52; the panel kept saying
 * 返工中 while the chat had already shown the delivered result). So the failure that
 * counts is the one carried by the NEWEST execution.
 */
function taskWorkState(task, executions, pendingDecisions) {
    if (pendingDecisions.length > 0)
        return 'blocked';
    const latest = newestExecution(executions);
    if (latest !== null && latest.status === 'failed')
        return 'failed';
    if (task.status === 'failed')
        return 'failed';
    if (task.status === 'completed')
        return 'completed';
    if (task.status === 'reviewing')
        return 'reviewing';
    if (task.status === 'cancelled')
        return 'cancelled';
    if (task.status === 'executing' || executions.some(execution => execution.status === 'running'))
        return 'working';
    return task.status;
}
/**
 * The most recent execution by its own timestamps, or null when there is none.
 *
 * Time decides, not array order: the snapshot sorts executions by id (the host's
 * own order), which says nothing about which attempt ran last.
 */
function newestExecution(executions) {
    const at = (value) => {
        if (value === null)
            return Number.NEGATIVE_INFINITY;
        const parsed = Date.parse(value);
        return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
    };
    let best = null;
    let bestAt = Number.NEGATIVE_INFINITY;
    for (const execution of executions) {
        // An execution is "at" its completion when it has one, else its start.
        const when = Math.max(at(execution.completedAt), at(execution.startedAt));
        if (best === null || when > bestAt) {
            best = execution;
            bestAt = when;
        }
    }
    return best;
}
function agentWorkState(agent, executions, pendingDecisions, hasActiveTask) {
    if (pendingDecisions.length > 0)
        return 'blocked';
    if (executions.some(execution => execution.status === 'running') || hasActiveTask)
        return 'working';
    if (agent.kind === 'temporary' && agent.status === 'terminated')
        return 'archived';
    if (executions.some(execution => execution.status === 'completed'))
        return 'done';
    if (agent.kind === 'fixed' && agent.status === 'active' && executions.length === 0)
        return 'idle';
    return 'unknown';
}
function createBlockers(snapshot, tasks) {
    const blockers = [];
    if (snapshot.paused) {
        blockers.push({
            id: 'shared-dispatch-paused', kind: 'paused', title: 'Shared dispatch is paused',
            detail: 'New dispatches wait until shared DevFlow dispatch resumes.', selection: PROJECT_SELECTION,
        });
    }
    for (const request of snapshot.decisionRequests.filter(request => request.status === 'pending')) {
        blockers.push({
            id: `decision-${request.id}`, kind: 'decision', title: 'Decision required',
            detail: request.question, selection: { kind: 'decision', id: request.id },
        });
    }
    for (const item of tasks.filter(item => item.workState === 'failed')) {
        blockers.push({
            id: `task-${item.task.id}`, kind: 'failed-task', title: `${item.task.title} needs rework`,
            detail: 'The current task or an execution is marked failed.', selection: { kind: 'task', id: item.task.id },
        });
    }
    for (const execution of snapshot.executions.filter(execution => execution.status === 'failed' && execution.taskId === undefined)) {
        blockers.push({
            id: `execution-${execution.id}`, kind: 'failed-execution', title: 'Execution needs follow-up',
            detail: `Execution ${shortId(execution.id)} is marked failed.`, selection: { kind: 'execution', id: execution.id },
        });
    }
    return blockers;
}
function createRecentActivity(snapshot) {
    const activity = [
        ...snapshot.tasks.map(task => ({
            id: `task-${task.id}`, at: task.updatedAt, title: 'Task updated', detail: task.title,
            selection: { kind: 'task', id: task.id },
        })),
        ...snapshot.executions.flatMap(execution => [
            ...(execution.startedAt === null ? [] : [{
                    id: `execution-start-${execution.id}`, at: execution.startedAt, title: 'Execution started',
                    detail: `Execution ${shortId(execution.id)}`, selection: { kind: 'execution', id: execution.id },
                }]),
            ...(execution.completedAt === null ? [] : [{
                    id: `execution-end-${execution.id}`, at: execution.completedAt,
                    title: execution.status === 'failed' ? 'Execution failed' : 'Execution completed',
                    detail: `Execution ${shortId(execution.id)}`, selection: { kind: 'execution', id: execution.id },
                }]),
        ]),
        ...snapshot.decisions.map(decision => ({
            id: `decision-${decision.id}`, at: decision.createdAt, title: 'Commander decision', detail: decision.summary,
            selection: { kind: 'decision', id: decision.id },
        })),
    ];
    return activity
        .filter(item => !Number.isNaN(Date.parse(item.at)))
        .sort((left, right) => right.at.localeCompare(left.at))
        .slice(0, 8);
}
function groupBy(items, key) {
    const grouped = new Map();
    for (const item of items) {
        const itemKey = key(item);
        const existing = grouped.get(itemKey);
        if (existing === undefined)
            grouped.set(itemKey, [item]);
        else
            existing.push(item);
    }
    return grouped;
}
function unique(values) {
    return [...new Set(values)];
}
/** Preserve Host bounds when an old or malformed snapshot reaches the UI. */
function bounded(items) {
    return (items ?? []).slice(0, 20);
}
function hasPendingTaskId(request) {
    return request.status === 'pending' && request.taskId !== null;
}
function hasTaskId(item) {
    return item.taskId !== undefined;
}
