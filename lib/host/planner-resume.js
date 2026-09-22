/**
 * Planner Resume: the structured context handed back to the Planner after an
 * Executor round. Pure data assembly plus a stable Markdown renderer — no
 * model calls, no task creation, no file I/O. Rendering is a separate layer
 * so JSON/UI resumes can reuse the same PlannerContext later.
 * @module @xiaoxie-ide/dsh-devflow/planner-resume
 */
/**
 * Assemble one PlannerContext. Pure: no I/O, no events, no mutation;
 * identical inputs produce identical outputs. Results and history keep their
 * input order — the caller owns ordering (e.g. store.listTasks is
 * createdAt-sorted).
 * @param project - the project context.
 * @param task - the current task.
 * @param results - execution results for the current task.
 * @param history - earlier task records.
 * @returns the assembled context.
 */
export function buildPlannerContext(project, task, results, history) {
    return { project, task, results, history };
}
function bulletList(items) {
    return items.length === 0 ? '(none)' : items.map(item => `- ${item}`).join('\n');
}
/** The task role, or '(none)' when unassigned. */
function roleText(task) {
    return task.assignedRole ?? '(none)';
}
/** Render one result record; absent list sections render as (none). */
function renderResult(result) {
    return [
        `### ${result.id}`,
        '',
        `Result ID: ${result.id}`,
        `Task ID: ${result.taskId}`,
        `Summary: ${result.summary}`,
        'Changes:',
        '',
        bulletList(result.changes),
        'Verification:',
        '',
        bulletList(result.verification),
        'Issues:',
        '',
        bulletList(result.issues),
        'Next Steps:',
        '',
        bulletList(result.nextSteps),
    ].join('\n');
}
/**
 * Render one PlannerContext into the fixed resume document. Pure and
 * deterministic; empty results and history are legal and render as (none).
 * The Next Planning Context section states facts only — it never invents
 * tasks or conclusions.
 * @param context - the assembled planner context.
 * @returns the resume document.
 */
export function renderPlannerResume(context) {
    const { project, task, results, history } = context;
    const latest = results.length > 0 ? results[results.length - 1] : undefined;
    const lines = [
        '# DevFlow Planner Resume',
        '',
        '## Project',
        '',
        `Project Name: ${project.name}`,
        `Project ID: ${project.id}`,
        `Goal: ${project.goal}`,
        `Current Stage: ${project.currentStage}`,
        '',
        '## Current Task',
        '',
        `Task ID: ${task.id}`,
        `Title: ${task.title}`,
        `Description: ${task.description}`,
        `Status: ${task.status}`,
        `Assigned Role: ${roleText(task)}`,
        '',
        '## Execution Results',
        '',
        ...(results.length === 0 ? ['(none)', ''] : results.flatMap(result => [renderResult(result), ''])),
        '## Task History',
        '',
        ...(history.length === 0
            ? ['(none)']
            : history.map(entry => `- ${entry.id}  ${entry.status}  ${entry.title}  [role: ${roleText(entry)}]`)),
        '',
        '## Next Planning Context',
        '',
        'The current task has produced execution results. Plan the next stage from the context above; do not invent new tasks or conclusions here.',
        `Current Task Status: ${task.status}`,
        `Latest Result Summary: ${latest === undefined ? '(none)' : latest.summary}`,
        'Open Issues:',
        '',
        bulletList(latest === undefined ? [] : latest.issues),
        'Executor Next Steps:',
        '',
        bulletList(latest === undefined ? [] : latest.nextSteps),
        '',
    ];
    return lines.join('\n');
}
