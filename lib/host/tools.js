/**
 * DevFlow model-facing tools: project status, task creation, task
 * transitions, result submission, and task-package creation. The tools are
 * thin, composed over the store and workflow — no scheduling, no Agent
 * calls, no external connections.
 * @module @xiaoxie-ide/dsh-devflow/tools
 */
import { randomUUID } from 'node:crypto';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent';
import { assembleAgentPrompt } from "./skill-binding.js";
import { MarkdownBridge, ResultParseError } from "./markdown-bridge.js";
import { prepareTaskPackage } from "./package-preflight.js";
import { dispatchGateMessage, evaluateDispatchGates, makeDispatchDiagnostic } from "./dispatch-gates.js";
import { resolveTaskScope } from "./scope-guard.js";
// Value imports: an isolated session needs its OWN workflow wrappers over its
// own store, so these are constructed per resolved store, not just typed.
import { TaskWorkflow } from "./workflow.js";
import { AgentWorkflow } from "./workflow-agent.js";
import { recordDevFlowChange } from "./journal.js";
import { DEFAULT_FIXED_AGENTS, DECLARED_EMPLOYEE_TOOL_NAMES, TEMPORARY_READ_ONLY_TOOLS, WRITE_CLASS_TOOLS, dispatchableToolNames } from "./default-agents.js";
import { blockedReportFrom, capabilityBreaker, declaredOutcome } from "./blocked-report.js";
import { blockedReportsForTask } from "./projection.js";
import { DEVFLOW_CONCURRENCY_LIMIT } from "../contract.js";
const ASSIGNED_ROLES = ['planner', 'backend-engineer', 'frontend-engineer', 'reviewer'];
const TASK_STATUSES = ['created', 'planned', 'executing', 'reviewing', 'completed', 'failed', 'cancelled'];
const REPORT_SUMMARY_LIMIT = 500;
const SENSITIVE_REPORT_TEXT = /(?:\b(?:prompt|system[\s_-]*prompt|credential|token|cookie|authorization|api[\s_-]*key|secret|password|raw\s*(?:tool\s*)?(?:input|output)|tool\s*(?:input|output)|stack\s*trace)\b|(?:[A-Za-z]:\\|\\\\|\/Users\/|\/home\/|\/tmp\/|\/var\/tmp\/|\/private\/var\/)|(?:Bearer\s+\S+))/i;
function safeReportSummary(value) {
    if (SENSITIVE_REPORT_TEXT.test(value))
        return 'Sensitive content is hidden.';
    return value.length <= REPORT_SUMMARY_LIMIT ? value : `${value.slice(0, REPORT_SUMMARY_LIMIT - 1)}…`;
}
const PHASE_STATUSES = ['planned', 'in_progress', 'completed'];
/**
 * How many `devflow_dispatch_agent` bodies are executing RIGHT NOW.
 *
 * Module-scoped on purpose. The classifier that decides "may this call join a
 * parallel group" (`isConcurrencySafe`) is projected onto the tool definition at
 * REGISTRATION time and receives only the call's arguments — no agent, no
 * session, no context — so the only place the host's scheduler and the tool body
 * can both see is a module fact. It counts ACROSS the process, which is exactly
 * what the limit means: N children of one runtime running at once.
 *
 * The counter is bumped SYNCHRONOUSLY as the first statement of the tool body,
 * before any `await`. That is what makes the join decision correct: the host
 * starts call 1 (`startCall` → `tools.execute`), and only afterwards re-reads
 * `executionMode` for call 2, so call 1's increment is already visible.
 */
let inFlightDispatches = 0;
/** Current in-flight dispatch count. Exported so a gate/test can read the truth. */
export function inFlightDispatchCount() {
    return inFlightDispatches;
}
/**
 * Whether one more dispatch may join a parallel group. `false` is not an error:
 * the host classifies the call `exclusive`, so it waits for the running group to
 * drain and then starts — this IS "超限排队".
 */
export function mayDispatchConcurrently() {
    return inFlightDispatches < DEVFLOW_CONCURRENCY_LIMIT;
}
/**
 * Take one in-flight slot. EVERY exit path of the dispatch body must go through
 * the returned release function (`try/finally`), or the count leaks upward and
 * the runtime degenerates to permanent serialization.
 */
function beginInFlightDispatch() {
    inFlightDispatches += 1;
    let released = false;
    return () => {
        if (released)
            return;
        released = true;
        inFlightDispatches -= 1;
    };
}
/** Advance a task into the executing state before a native child is started. */
async function prepareTaskForDispatch(workflow, store, taskId, append) {
    let task = await store.getTask(taskId);
    if (task === undefined)
        throw new Error(`devflow: unknown task ${taskId}`);
    if (task.status === 'created' || task.status === 'failed' || task.status === 'completed' || task.status === 'reviewing') {
        const planned = await workflow.planTask(task.id);
        await append(planned.change, planned.task.title);
        task = planned.task;
    }
    if (task.status === 'planned') {
        const executing = await workflow.startExecution(task.id);
        await append(executing.change, executing.task.title);
        task = executing.task;
    }
    if (task.status !== 'executing')
        throw new Error(`devflow: cannot dispatch task ${task.id} from status ${task.status}`);
    return task;
}
/** Services the tools delegate to. */
function appendDispatchDiagnostic(store, diagnostic) {
    void recordDevFlowChange(store, 'devflow/dispatch/diagnostic', { diagnostic: makeDispatchDiagnostic(diagnostic) }).catch(() => { });
}
function dispatchFailureCode(cause) {
    if (!(cause instanceof Error))
        return 'DEVFLOW_DISPATCH_FAILURE';
    return /DEVFLOW_DISPATCH_[A-Z_]+/.exec(cause.message)?.[0] ?? 'DEVFLOW_DISPATCH_FAILURE';
}
function dispatchFailureSummary(code) {
    const summaries = {
        DEVFLOW_DISPATCH_ERROR: 'The fixed Agent stopped before completion.',
        DEVFLOW_DISPATCH_ABORTED: 'The fixed Agent dispatch was aborted before completion.',
        DEVFLOW_DISPATCH_MAX_TOKENS: 'The fixed Agent stopped after reaching its output limit.',
        DEVFLOW_DISPATCH_REFUSAL: 'The fixed Agent declined the dispatched task.',
        DEVFLOW_DISPATCH_EMPTY_OUTPUT: 'The fixed Agent returned no result document.',
        DEVFLOW_DISPATCH_RESULT_FORMAT_INVALID: 'The fixed Agent result format was invalid.',
        DEVFLOW_DISPATCH_RESULT_REJECTED: 'The fixed Agent result document was rejected; dispatch again with the exact required format.',
        DEVFLOW_DISPATCH_TASK_MISMATCH: 'The fixed Agent result targets another task.',
        DEVFLOW_DISPATCH_RESULT_IMPORT_FAILED: 'The fixed Agent result could not be imported.',
    };
    return summaries[code] ?? 'The fixed Agent dispatch failed before completion.';
}
/** Child replies one dispatch accepts before degrading to a rejected outcome. */
const MAX_RESULT_ATTEMPTS = 2;
/** Bounded, safe rendering of what was wrong with a reply document. */
function safeResultProblems(problems) {
    return problems
        .map(problem => problem.replace(/[\r\n]+/g, ' ').slice(0, 60))
        .filter(problem => problem.length > 0)
        .slice(0, 4)
        .join('; ');
}
/** The failure summary, extended with the bounded document problems. */
function summaryWithProblems(code, problems) {
    const base = dispatchFailureSummary(code);
    const detail = safeResultProblems(problems ?? []);
    return detail === '' ? base : `${base} Missing or invalid: ${detail}.`;
}
/**
 * One dispatch whose child replies never contained an acceptable result
 * document. This is a REJECTED outcome, not an abort: the attempt and execution
 * records stay durable and the dispatch is retryable.
 */
class DispatchResultRejected extends Error {
    problems;
    constructor(problems, options) {
        super(`devflow: DEVFLOW_DISPATCH_RESULT_REJECTED: ${summaryWithProblems('DEVFLOW_DISPATCH_RESULT_REJECTED', problems)}`, options);
        this.name = 'DispatchResultRejected';
        this.problems = [...problems];
    }
}
/** The stricter instruction appended for the single retry. */
function retryInstruction(problems) {
    const detail = safeResultProblems(problems);
    return [
        '## Retry: Required Result Format',
        '',
        `Your previous reply was rejected because ${detail === '' ? 'it contained no result document' : `it could not be accepted (${detail})`}.`,
        'Reply with only the result document: your final reply must contain nothing else.',
        'Start at the line `# DevFlow Result`, keep every metadata key and section, and add no explanations, no prose, and no fenced code block before or after it.',
    ].join('\n');
}
/** Render `- item` lines, dropping empty entries. */
function bulletLines(items) {
    return items.map(item => item.trim()).filter(item => item !== '').map(item => `- ${item}`).join('\n');
}
/**
 * The most recent review rejection recorded for one task.
 *
 * Read from the committed import journal (`devflow/bridge/import`), because a
 * stored Result does not carry its verdict. Only the LATEST import for the task
 * counts: an accepted import after a change request means there is nothing to
 * hand back.
 * @param store - the DevFlow store.
 * @param taskId - the task whose latest import is inspected.
 * @returns the rejected result document, or undefined when the latest import was not a change request.
 */
async function latestReworkReason(store, taskId) {
    const imports = (await store.listJournal()).filter(entry => entry.type === 'devflow/bridge/import');
    for (let index = imports.length - 1; index >= 0; index -= 1) {
        const entry = imports[index];
        if (entry === undefined)
            continue;
        const data = entry.data;
        if (data.taskId !== taskId)
            continue;
        if (data.verdict !== 'changes-requested' || typeof data.resultId !== 'string')
            return undefined;
        return await store.getResult(data.resultId);
    }
    return undefined;
}
/**
 * Compose one handoff's instructions, acceptance criteria, and bounds.
 *
 * A task's OWN scope guard wins; the project-level file is only a fallback for a
 * task that never set bounds, and the package says which one it used. Before
 * this the project file was the single source, so one task's `devflow_set_scope`
 * silently re-bounded every other task's work — including their rework rounds.
 * The task itself carries no instructions/criteria fields, so the priority is:
 * caller-supplied (a future task-owned field) > previous review rejection >
 * this task's scope guard > project default scope guard.
 * @param store - the DevFlow store.
 * @param task - the task being handed over.
 * @returns instructions, acceptance criteria, resolved limits, and the scope source.
 */
async function resolveTaskBounds(store, task) {
    const taskScope = await store.getTaskScope(task.id);
    const projectScope = taskScope === undefined ? await store.getScope() : undefined;
    const scope = taskScope ?? projectScope;
    const source = taskScope !== undefined ? 'task' : (projectScope !== undefined ? 'project' : 'none');
    const rework = await latestReworkReason(store, task.id);
    const reworkLines = rework === undefined
        ? []
        : [...rework.issues, ...rework.nextSteps].map(line => line.trim()).filter(line => line !== '' && line !== 'None');
    const scopeCriteria = (scope?.completionCriteria ?? []).map(line => line.trim()).filter(line => line !== '');
    const blocks = [];
    if (reworkLines.length > 0) {
        blocks.push([
            '## Changes requested by the previous review',
            '',
            bulletLines(reworkLines),
            '',
            `Previous review summary: ${rework?.summary ?? ''}`.trim(),
        ].join('\n'));
    }
    if (scope !== undefined) {
        blocks.push([
            `## Scope Guard (source: ${source === 'task' ? `this task ${task.id}` : 'project default'})`,
            '',
            ...(source === 'task'
                ? []
                : ['This task has no Scope Guard of its own; the bounds below are the PROJECT default. Call devflow_set_scope with this task id so a later task cannot re-bound this work.', '']),
            ...(scope.summary.trim() === '' ? [] : [`Summary: ${scope.summary.trim()}`, '']),
            ...(scope.inScope.length === 0 ? [] : [`In scope:\n${bulletLines(scope.inScope)}`, '']),
            ...(scopeCriteria.length === 0 ? [] : [`Completion criteria:\n${bulletLines(scopeCriteria)}`, '']),
            `Limits: at most ${scope.maxModifiedFiles} modified files and ${scope.maxToolSteps} tool steps.`,
        ].join('\n'));
    }
    return {
        instructions: blocks.join('\n\n'),
        acceptanceCriteria: scopeCriteria.length > 0 ? scopeCriteria : reworkLines,
        scopeGuard: scope === undefined ? undefined : resolveTaskScope(scope, undefined),
        scope,
        source,
    };
}
/**
 * Path tokens in one text: a run of path characters holding at least one
 * separator. The text is slash-normalized before this runs, so a token is the
 * same whether it was written `src/js/ui.js` or `src\js\ui.js`.
 */
const PATH_TOKEN = /[^\s"'`,;()]*\/[^\s"'`,;()]*/g;
/** File-name tokens in one text. */
const FILE_NAME_TOKEN = /[A-Za-z0-9_][A-Za-z0-9_.-]*\.(?:html|css|js|mjs|cjs|ts|tsx|jsx|json|md|txt|yml|yaml|py|sh|ps1)\b/gi;
/**
 * The normalized locations one slash-normalized path token denotes, lowercased.
 *
 * A token always denotes the directory holding it (`src/js/ui.js` ⇒ `src/js`) and
 * its own path (`docs/日志/` ⇒ `docs/日志`). Only slash-separated segments are
 * compared — the token is never resolved against the disk, so a bare relative
 * path is a location exactly like an absolute one.
 */
function locationsOf(token) {
    const trimmed = token.replace(/\/+$/, '');
    const cut = trimmed.lastIndexOf('/');
    const holder = cut <= 0 ? '' : trimmed.slice(0, cut);
    return [holder, trimmed]
        .filter(location => location !== '')
        .map(location => location.toLowerCase());
}
/**
 * True when one path token names a location ON ITS OWN, rather than merely
 * containing a slash inside prose.
 *
 * Two separators (`src/js/ui.js`, `D:\Desktop\a.js`), a trailing separator
 * (`docs/日志/`), or a drive-root form (`D:\file.js`) name a location. A
 * throwaway slash word (`A/B`, `and/or`, `读/写`) does NOT: it is prose that
 * happens to hold a separator, and letting it into the comparison would excuse
 * a real contradiction — a shared `A/B` in both texts used to hand over bounds
 * naming `docs/secret` that the task never mentions.
 */
function namesOwnLocation(token) {
    const trimmed = token.replace(/\/+$/, '');
    return token.endsWith('/')
        || (trimmed.match(/\//g)?.length ?? 0) >= 2
        || /^[A-Za-z]:\//.test(trimmed);
}
/** Every distinct file-name token in one text, lowercased. */
function fileNamesOf(text) {
    return new Set((text.match(FILE_NAME_TOKEN) ?? []).map(name => name.toLowerCase()));
}
/**
 * Every distinct location a text NAMES, lowercased — the judging side.
 *
 * Both slash styles are normalized first, so `src/js/ui.js` and `src\js\ui.js`
 * yield the same locations instead of two disjoint sets: the false
 * `DEVFLOW_DISPATCH_SCOPE_CONFLICT` that refused legitimate handoffs. Prose slash
 * words are excluded here by {@link namesOwnLocation}.
 */
function namedLocationsOf(text) {
    const normalized = text.replace(/\\/g, '/');
    const out = new Set();
    for (const token of normalized.match(PATH_TOKEN) ?? []) {
        if (!namesOwnLocation(token))
            continue;
        for (const location of locationsOf(token))
            out.add(location);
    }
    return out;
}
/**
 * Every distinct location a text MENTIONS, lowercased — the excusing side.
 *
 * Deliberately more generous than {@link namedLocationsOf}: every slash-bearing
 * token counts, so bounds written `docs/日志/` still match a task that writes the
 * same directory bare (`docs\日志`).
 *
 * KNOWN GAP (registered for a later round, measured 2026-09-21 after the second
 * audit): this asymmetry does NOT make the location check airtight, because a
 * prose token holding TWO separators (`2026/09/21`, `读/写/执行`) satisfies
 * {@link namesOwnLocation} on BOTH sides, so one shared such token can still
 * excuse a contradiction elsewhere in the bounds. That gap predates this change
 * (the pre-step-16 heuristic behaved the same way: its `/09` matched `/09`), and
 * it is closed by nothing in this round — the two candidate fixes both cost more
 * than they buy: judging single-separator tokens re-opens the throwaway `A/B`
 * excuse this round removed, and requiring EVERY location to be mentioned turns
 * ordinary multi-location bounds into refusals. Closing it needs the bounds to
 * carry structured locations instead of parsed prose, which is a contract change.
 * `tests/scope-isolation.spec.ts` pins both halves of the gap as executable
 * evidence.
 */
function mentionedLocationsOf(text) {
    const normalized = text.replace(/\\/g, '/');
    const out = new Set();
    for (const token of normalized.match(PATH_TOKEN) ?? []) {
        for (const location of locationsOf(token))
            out.add(location);
    }
    return out;
}
/** A handoff whose bounds contradict the task they are meant to implement. */
class DispatchScopeConflict extends Error {
    constructor(detail) {
        super(`devflow: DEVFLOW_DISPATCH_SCOPE_CONFLICT: ${detail}; set this task's own bounds with devflow_set_scope, or clear the stale bounds with devflow_clear_scope.`);
        this.name = 'DispatchScopeConflict';
    }
}
/** Every trigger `devflow_request_decision` accepts. */
const DECISION_TRIGGERS = [
    'ambiguity', 'approach-divergence', 'scope-creep', 'review-failed-twice', 'high-risk-operation', 'granularity', 'development-order',
];
/** The option-count window the decision contract accepts. */
const DECISION_OPTION_MIN = 3;
const DECISION_OPTION_MAX = 5;
/** The reserved id of the user-custom entry the service appends itself. */
const DECISION_CUSTOM_OPTION_ID = 'custom';
/**
 * The user-custom option carried by a DURABLE decision request.
 *
 * DevFlow's own decision surfaces render this copy, so it is Chinese like the
 * rest of them. It is one shared constant rather than a literal at each call
 * site: the popup copy drifted into English precisely because it was hardcoded
 * inline.
 */
export const DECISION_CUSTOM_OPTION = {
    id: DECISION_CUSTOM_OPTION_ID,
    label: '自定义',
    description: '不在上述选项中，由我自行填写',
    recommended: false,
};
/** One bounded, actionable argument-contract failure. */
function decisionArgsError(detail) {
    return new Error(`devflow: devflow_request_decision ${detail}`);
}
/**
 * Read one field that may still be JSON text.
 *
 * Only a value that LOOKS like a JSON structure is parsed, so plain scalars
 * (`"parallel"`, `"development-order"`) pass through untouched while a
 * stringified array/object is recovered. Anything unparseable fails with an
 * actionable message instead of the runtime's bare type error.
 */
function parseDecisionField(value, field) {
    if (typeof value !== 'string')
        return value;
    const text = value.trim();
    if (!text.startsWith('{') && !text.startsWith('['))
        return value;
    try {
        return JSON.parse(text);
    }
    catch (cause) {
        const reason = cause instanceof Error ? cause.message.slice(0, 80) : 'invalid JSON';
        throw decisionArgsError(`received "${field}" as JSON text that could not be parsed (${reason}); send it as a plain value instead`);
    }
}
/**
 * Enforce the popup rules every decision request must satisfy.
 *
 * The failure these rules exist for: a Commander facing a capability wall asked
 * the user to choose among three technical routes and marked "try again" as the
 * recommendation. A user who does not understand the system clicks the
 * recommendation, so the default path led straight back into the same wall.
 * These rules make that shape unrepresentable:
 *
 * 1. every popup must offer an option that STOPS the work;
 * 2. the recommended option may never be a retry;
 * 3. every option must declare what it does (`kind`), so the check is a contract
 *    rather than a guess at the caller's wording.
 * @param options - the parsed options, `recommended` not yet applied.
 * @param recommended - the option id the caller recommends.
 * @throws when any rule is violated.
 */
function assertDecisionOptionRules(options, recommended) {
    // The user-custom entry is the service's own row, not one of the concrete
    // routes this decision offers, so it never has to carry an intent.
    const concrete = options.filter(option => option.id !== DECISION_CUSTOM_OPTION_ID);
    const undeclared = concrete.filter(option => option.kind === undefined).map(option => option.id);
    if (undeclared.length > 0) {
        throw decisionArgsError(`options ${undeclared.join(', ')} do not declare "kind"; every option must say what it does — one of proceed, retry, stop`);
    }
    if (!concrete.some(option => option.kind === 'stop')) {
        throw decisionArgsError('no option declares kind "stop"; every decision must offer the user a way to halt the work instead of continuing it');
    }
    const recommendedOption = concrete.find(option => option.id === recommended);
    if (recommendedOption?.kind === 'retry') {
        throw decisionArgsError(`recommendedOption ${JSON.stringify(recommended)} declares kind "retry"; a recommendation may never be a retry — recommend the most conservative option (usually "stop") instead`);
    }
}
/**
 * Validate one `devflow_request_decision` call and complete its option list.
 *
 * The product shape is three recommended options plus one user-custom option.
 * The custom entry is appended HERE, so a caller passes 3 (accepted range 3-5)
 * concrete options and must not invent its own custom entry; a caller that does
 * pass one keeps it and no duplicate is added. Every failure names what was
 * received and what was expected, because the previous message ("requires three
 * options and one recommendedOption") left the caller guessing.
 * @param raw - the model-supplied arguments, possibly still JSON text.
 * @returns the validated request arguments, custom entry included.
 * @throws when the trigger, question, options, or recommended id are unusable.
 */
export function parseDecisionRequestArgs(raw) {
    const record = parseDecisionField(raw, 'arguments');
    if (typeof record !== 'object' || record === null || Array.isArray(record)) {
        throw decisionArgsError(`needs an object with trigger, question, recommendedOption, and 3-5 options (received ${Array.isArray(record) ? 'an array' : typeof record})`);
    }
    const input = record;
    const trigger = input.trigger;
    if (typeof trigger !== 'string' || !DECISION_TRIGGERS.includes(trigger)) {
        throw decisionArgsError(`received trigger ${JSON.stringify(trigger)}; use one of ${DECISION_TRIGGERS.join(', ')}`);
    }
    const question = typeof input.question === 'string' ? input.question.trim() : '';
    if (question === '') {
        throw decisionArgsError(`needs a non-empty "question" (received ${typeof input.question})`);
    }
    const rawOptions = parseDecisionField(input.options, 'options');
    if (!Array.isArray(rawOptions)) {
        throw decisionArgsError(`received "options" as ${typeof rawOptions}; send an array of 3-5 { id, label, description } entries`);
    }
    const options = [];
    const ids = [];
    for (const [index, entry] of rawOptions.entries()) {
        const candidate = parseDecisionField(entry, `options[${index}]`);
        if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
            throw decisionArgsError(`received options[${index}] as ${typeof candidate}; each option must be an object with string id/label/description`);
        }
        const option = candidate;
        const id = typeof option.id === 'string' ? option.id.trim() : '';
        const label = typeof option.label === 'string' ? option.label.trim() : '';
        if (id === '' || label === '') {
            throw decisionArgsError(`received options[${index}] without a usable id/label (id: ${JSON.stringify(option.id)}, label: ${JSON.stringify(option.label)})`);
        }
        if (ids.includes(id))
            throw decisionArgsError(`received duplicate option id ${JSON.stringify(id)}; ids must be unique`);
        const description = typeof option.description === 'string' && option.description.trim() !== '' ? option.description.trim() : label;
        const kind = option.kind;
        if (kind !== undefined && kind !== 'proceed' && kind !== 'retry' && kind !== 'stop') {
            throw decisionArgsError(`received options[${index}].kind ${JSON.stringify(option.kind)}; use one of proceed, retry, stop`);
        }
        ids.push(id);
        options.push({ id, label, description, recommended: false, ...(kind === undefined ? {} : { kind }) });
    }
    if (options.length < DECISION_OPTION_MIN || options.length > DECISION_OPTION_MAX) {
        throw decisionArgsError(`received ${options.length} options (${ids.join(', ') || 'none'}); pass ${DECISION_OPTION_MIN}-${DECISION_OPTION_MAX} concrete recommended options — the user-custom option is appended automatically`);
    }
    const recommendedOption = parseDecisionField(input.recommendedOption, 'recommendedOption');
    if (typeof recommendedOption !== 'string' || recommendedOption.trim() === '') {
        throw decisionArgsError(`received recommendedOption ${JSON.stringify(recommendedOption)}; set it to one of the option ids (${ids.join(', ')})`);
    }
    const recommended = recommendedOption.trim();
    if (!ids.includes(recommended)) {
        throw decisionArgsError(`received recommendedOption ${JSON.stringify(recommendedOption)} which is not one of the option ids (${ids.join(', ')}); set it to one of them`);
    }
    assertDecisionOptionRules(options, recommended);
    const taskId = typeof input.taskId === 'string' && input.taskId.trim() !== '' ? input.taskId.trim() : undefined;
    const custom = ids.includes(DECISION_CUSTOM_OPTION_ID) ? [] : [{ ...DECISION_CUSTOM_OPTION }];
    return {
        ...(taskId === undefined ? {} : { taskId }),
        trigger: trigger,
        question,
        recommendedOption: recommended,
        options: [
            ...options.map(option => ({ ...option, recommended: option.id === recommended })),
            ...custom,
        ],
    };
}
/**
 * Refuse a handoff whose Scope Guard names work the task does not describe.
 *
 * The silent-pollution failure looked exactly like this: a package telling the
 * child to create a file somewhere the task text never mentioned. Only a
 * conflict is fatal — bounds that name no location, or that overlap the task
 * text, are handed over as before.
 *
 * Locations are compared as normalized location sets, never as absolute ones:
 * the two texts are slash-normalized first, so bounds written `src/js/ui.js`
 * and a task written `src\js\ui.js` name the same directory and are handed over
 * (the earlier heuristic read the forward-slash form as a root path `/js` and
 * refused a legitimate dispatch).
 *
 * The judging side only counts tokens that name a location on their own, while
 * the excusing side counts every slash-bearing token. That asymmetry is the
 * point: a throwaway slash word shared by both texts (`A/B`) can no longer
 * excuse bounds that name a location the task never mentions, and a bounds
 * directory written `docs/日志/` still matches a task writing `docs\日志`.
 * @param task - the task being handed over.
 * @param scope - the scope guard the handoff would carry, if any.
 * @throws when the bounds name a location or file set the task never mentions.
 */
function assertPackageScopeConsistency(task, scope) {
    if (scope === undefined)
        return;
    const scopeText = [scope.summary, ...scope.inScope, ...scope.completionCriteria].join('\n');
    const taskText = `${task.title}\n${task.description}`;
    const namedLocations = namedLocationsOf(scopeText);
    if (namedLocations.size > 0) {
        const mentionedLocations = mentionedLocationsOf(taskText);
        if ([...namedLocations].every(location => !mentionedLocations.has(location))) {
            throw new DispatchScopeConflict('the bounds name a location this task does not describe');
        }
    }
    const scopeFiles = fileNamesOf(scopeText);
    const taskFiles = fileNamesOf(taskText);
    if (scopeFiles.size > 0 && taskFiles.size > 0 && [...scopeFiles].every(name => !taskFiles.has(name))) {
        throw new DispatchScopeConflict('the bounds name files this task does not describe');
    }
}
async function completeBatch(store, runtime) {
    if (runtime.batch === undefined)
        return;
    let batch = await store.getBatch(runtime.batch.batchId);
    if (batch === undefined || batch.status === 'completed')
        return;
    if (batch.status === 'planned') {
        batch = await store.updateBatchStatus(batch.batchId, 'running');
        await recordDevFlowChange(store, 'devflow/execution/batch/start', { batchId: batch.batchId, at: batch.updatedAt });
    }
    if (batch.status === 'paused') {
        batch = await store.updateBatchStatus(batch.batchId, 'running');
        await recordDevFlowChange(store, 'devflow/execution/batch/start', { batchId: batch.batchId, at: batch.updatedAt });
    }
    if (batch.status === 'running') {
        batch = await store.updateBatchStatus(batch.batchId, 'completed');
        await recordDevFlowChange(store, 'devflow/execution/batch/complete', { batchId: batch.batchId, at: batch.updatedAt });
    }
    runtime.batch = batch;
}
async function failDirectDispatch(store, runtime, agentId, code, outcome = {}) {
    if (runtime.attempt !== undefined) {
        let attempt = await store.getAttempt(runtime.attempt.attemptId);
        if (attempt?.status === 'created') {
            attempt = await store.updateAttemptStatus(attempt.attemptId, 'running');
            await recordDevFlowChange(store, 'devflow/execution/attempt/start', { attemptId: attempt.attemptId, at: attempt.updatedAt });
        }
        if (attempt?.status === 'running') {
            attempt = await store.updateAttemptStatus(attempt.attemptId, 'failed');
            await recordDevFlowChange(store, 'devflow/execution/attempt/fail', { attemptId: attempt.attemptId, at: attempt.updatedAt });
        }
        if (attempt !== undefined)
            runtime.attempt = attempt;
    }
    if (runtime.execution !== undefined) {
        let execution = await store.getExecutionRecord(runtime.execution.executionId);
        if (execution?.status === 'pending') {
            execution = await store.updateExecutionStatus(execution.executionId, 'running');
            await recordDevFlowChange(store, 'devflow/execution/start', { execution });
        }
        if (execution?.status === 'running') {
            execution = await store.updateExecutionStatus(execution.executionId, 'failed');
            await recordDevFlowChange(store, 'devflow/execution/fail', { executionId: execution.executionId, at: execution.updatedAt });
        }
        if (execution !== undefined) {
            runtime.execution = execution;
            if ((await store.listReportsByExecution(execution.executionId)).length === 0) {
                const report = await store.createReport({
                    executionId: execution.executionId,
                    agentId,
                    status: outcome.reportStatus ?? 'failed',
                    summary: summaryWithProblems(code, outcome.problems),
                    outputReference: `devflow:execution:${execution.executionId}`,
                });
                await recordDevFlowChange(store, 'devflow/agent/report/create', { report });
            }
        }
    }
    await completeBatch(store, runtime);
}
const projectValueSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        id: { type: 'string', required: true },
        name: { type: 'string', required: true },
        goal: { type: 'string', required: true },
        currentStage: { type: 'string', required: true },
        createdAt: { type: 'string', required: true },
        updatedAt: { type: 'string', required: true },
    },
};
const taskValueSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        id: { type: 'string', required: true },
        title: { type: 'string', required: true },
        description: { type: 'string', required: true },
        status: { type: 'string', required: true, enum: TASK_STATUSES },
        assignedRole: { type: 'string', enum: ASSIGNED_ROLES },
        createdAt: { type: 'string', required: true },
        updatedAt: { type: 'string', required: true },
    },
};
const taskStatusChangeValueSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        taskId: { type: 'string', required: true },
        from: { type: 'string', required: true, enum: TASK_STATUSES },
        to: { type: 'string', required: true, enum: TASK_STATUSES },
        at: { type: 'string', required: true },
    },
};
const resultValueSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        id: { type: 'string', required: true },
        taskId: { type: 'string', required: true },
        summary: { type: 'string', required: true },
        changes: { type: 'array', required: true, items: { type: 'string' } },
        verification: { type: 'array', required: true, items: { type: 'string' } },
        issues: { type: 'array', required: true, items: { type: 'string' } },
        nextSteps: { type: 'array', required: true, items: { type: 'string' } },
        createdAt: { type: 'string', required: true },
    },
};
/**
 * Register the five DevFlow tools on `ctx.tools`. Registration is
 * effect-based: disposing the owning plugin fiber unregisters every tool.
 * @param ctx - registrant context carrying the tool registry.
 * @param services - the store and workflow the tools delegate to.
 */
/**
 * The capability tool list a temporary employee actually receives.
 *
 * Two revisions of behaviour meet here, and the ORDER matters:
 *
 * 1. **A declared list wins, but only after being trimmed** to what this runtime can
 *    really hand a child. The vocabulary is {@link DECLARED_EMPLOYEE_TOOL_NAMES} (every
 *    name a shipped employee may name) UNION the caller's own visible tools, which is
 *    the same two-source rule `dispatchableToolNames` already uses. A name in neither is
 *    **trimmed, not rejected**: the requirement is explicit that an unavailable tool must
 *    be silently dropped rather than refuse the registration, and silently dropped rather
 *    than quietly granted (§五-2 forbids the opposite failure — a DECLARED writing
 *    permission that vanishes without a trace — so the trim is total and deliberate:
 *    every name either survives into the roster record or is absent from it, and the
 *    caller can read the result back).
 * 2. **No declared list ⇒ the read-only default**, never the role peer's full set. See
 *    {@link TEMPORARY_READ_ONLY_TOOLS} for why the default had to change direction.
 *
 * @param declared - the tool names the caller explicitly declared, when it declared any.
 * @param callerView - tool names the calling agent can currently see.
 * @returns the tool names to persist on the employee's roster record.
 */
export function effectiveTemporaryTools(declared, callerView = new Set()) {
    if (declared === undefined || declared.length === 0)
        return [...TEMPORARY_READ_ONLY_TOOLS];
    const allowed = new Set([...DECLARED_EMPLOYEE_TOOL_NAMES, ...callerView]);
    const trimmed = [];
    for (const name of declared) {
        if (allowed.has(name) && !trimmed.includes(name))
            trimmed.push(name);
    }
    return trimmed;
}
/** Whether one tool list declares a writing capability (the auditable half of the rule). */
export function declaresWriteClassTools(tools) {
    return tools.filter(name => WRITE_CLASS_TOOLS.has(name));
}
/**
 * Whether a `tools` argument is a well-formed tool-name list.
 *
 * `json`-shaped crossings reach this tool as whatever the model sent, so a malformed
 * declaration is refused with an actionable message rather than silently coerced into
 * the read-only default (which would look like the declaration "worked" while granting
 * nothing the caller asked for).
 */
function isToolNameArray(value) {
    return Array.isArray(value) && value.every(item => typeof item === 'string' && item.trim() !== '');
}
/** The model configuration a temporary employee inherits from its role peer. */
function inheritedModelConfig(role) {
    // The Commander is excluded for the same reason as in `inheritedTools`: it is
    // the orchestrator, not a role peer an employee may be modelled on.
    const peer = DEFAULT_FIXED_AGENTS.find(agent => agent.role === role && agent.agentId !== 'commander');
    return peer === undefined ? { model: 'deepseek-chat' } : { model: peer.modelConfig.model };
}
/** The system prompt of a temporary employee, assembled from its registry entry. */
function temporaryAgentPrompt(instance) {
    const capabilityLine = instance.capabilities === undefined || instance.capabilities.length === 0
        ? ''
        : `能力标签：${instance.capabilities.join('、')}。`;
    const description = instance.description === undefined ? '' : `${instance.description}\n`;
    return `你是 DevFlow 的临时员工「${instance.displayName}」，由总指挥在本次项目内现场登记。`
        + `${description}${capabilityLine}`
        + '每次接任务先只读确认当前代码与状态的实际情况，再动手；若任务提示与实际明显偏离，停止并向总指挥反馈。';
}
/**
 * The explicit caller allow-list for `devflow_agent_upsert`.
 *
 * The registration path deliberately does NOT derive the new employee's budget
 * from the calling agent's remaining delegation depth: every fixed employee sits
 * at depth 0, so a depth-derived budget made this tool unusable from the only
 * agent allowed to call it. Removing that budget check removed the last thing
 * that constrained the tool at all, so the caller identity is now checked
 * directly and explicitly: the caller must currently hold the Commander seat.
 * An absent caller, and any caller that is not the Commander, is refused before
 * a single record is written.
 * @param isCommander - the Commander-seat check supplied by the composition.
 * @param caller - the calling agent the runtime supplied, when it supplied one.
 * @returns the calling agent id, for the caller's own logging.
 */
export function authorizeAgentRegistration(isCommander, caller) {
    if (caller === undefined) {
        throw new Error('devflow: registering an employee requires a calling agent; no parent agent on this tool call');
    }
    if (isCommander === undefined || !isCommander(caller)) {
        throw new Error(`devflow: registering an employee is restricted to the Commander; caller ${caller.id} is not authorized`);
    }
    return caller.id;
}
/**
 * Register or refresh the DISPATCHABLE employee behind one agent instance.
 *
 * The instance record alone is inert: it is not the canvas roster and it is not what
 * `devflow_assign_agent` / `devflow_dispatch_agent` validate against, so an
 * upsert that stopped at the instance would report success while leaving the
 * employee unassignable. Both registries are therefore written here.
 *
 * Caller identity is enforced first, by {@link authorizeAgentRegistration}. The
 * new employee then gets the ordinary employee delegation budget (0: it cannot
 * spawn children of its own). A future child-spawning path can hand its own
 * `delegationDepth` to `DevFlowStore.registerAgent` through the delegation policy.
 * @param store - the DevFlow store.
 * @param instance - the instance that was just persisted.
 * @param caller - the calling agent the runtime supplied, when it supplied one.
 * @param isCommander - the Commander-seat check supplied by the composition.
 */
async function registerDispatchableEmployee(store, instance, caller, isCommander, declaredTools) {
    authorizeAgentRegistration(isCommander, caller);
    const existing = await store.getAgent(instance.id);
    if (existing !== undefined && existing.kind === 'fixed') {
        throw new Error(`devflow: ${instance.id} is a fixed employee and cannot be redefined by devflow_agent_upsert`);
    }
    // The caller's own visible tools are one of the two sources the trim consults; an
    // absent caller cannot happen (authorizeAgentRegistration already refused it), but a
    // caller without a readable tool registry is tolerated: the roster vocabulary alone
    // still decides what a shipped employee may name.
    let callerView = new Set();
    if (caller !== undefined) {
        try {
            callerView = new Set(caller.ctx.tools.schemas(caller).map(entry => entry.name));
        }
        catch {
            callerView = new Set();
        }
    }
    const tools = effectiveTemporaryTools(declaredTools, callerView);
    const writeClass = declaresWriteClassTools(tools);
    const config = {
        role: instance.role,
        prompt: temporaryAgentPrompt(instance),
        modelConfig: inheritedModelConfig(instance.role),
        tools,
        capabilities: instance.capabilities === undefined ? [] : [...instance.capabilities],
        skills: [],
        delegationDepth: 0,
    };
    const registered = existing === undefined
        ? await store.registerAgent({ agentId: instance.id, kind: 'temporary', ...config })
        : await store.updateAgentConfig(instance.id, config);
    // The audit fact rides ON the existing event types (no new type, no new tool): both
    // records already carry the full roster row, whose `tools` IS the granted budget. The
    // extra `writeClassTools` field names the escalation explicitly, so "this employee was
    // given a writing capability" is readable without diffing two snapshots.
    if (existing === undefined) {
        await recordDevFlowChange(store, 'devflow/agent/register', { agent: registered, writeClassTools: [...writeClass] });
    }
    else {
        await recordDevFlowChange(store, 'devflow/agent/update-config', {
            agentId: registered.agentId,
            patch: config,
            writeClassTools: [...writeClass],
            at: registered.updatedAt,
        });
    }
    return { agent: registered, tools, writeClass };
}
/**
 * One workflow pair per resolved store.
 *
 * A session that calls ten tools must not build ten wrappers, and two wrappers
 * over one store would be two objects for one project's lifecycle.
 */
const workflowByStore = new WeakMap();
/**
 * Bind one tool call to the calling session's own project.
 *
 * Every stateful DevFlow tool starts with this: the store, the task workflow,
 * and the agent workflow are all derived from the CALLING SESSION'S WORKSPACE,
 * so a tool called from project B can never read or write project A's state —
 * not even when both sessions are served by one host process. A session that
 * cannot be scoped is refused by {@link DevFlowSessionStores.resolve} rather
 * than silently served from the shared library.
 * @param services - the registered tool services (single-store or per-session).
 * @param agent - the calling Agent the runtime supplied, when it supplied one.
 * @returns the calling session's store scope, workflow, and agent workflow.
 */
function bindSession(services, agent) {
    const { store, sessionStores, workflow, agentWorkflow } = services;
    if (sessionStores === undefined) {
        // A single-store composition cannot isolate; it therefore serves every call
        // from the one store it was handed, which is what its registrant asked for.
        return {
            scope: {
                store,
                sessionId: String(agent?.id ?? '(single-store)'),
                workspacePath: null,
                storeRoot: store.rootPath,
                sessionKey: store.rootPath,
            },
            store,
            workflow,
            agentWorkflow,
        };
    }
    const scope = sessionStores.resolve(agent);
    // The mixed library IS the store the composition already wrapped, so its
    // existing workflow pair stays authoritative (and stays a single instance).
    if (scope.store === store)
        return { scope, store, workflow, agentWorkflow };
    let pair = workflowByStore.get(scope.store);
    if (pair === undefined) {
        const scoped = new TaskWorkflow(scope.store);
        pair = { workflow: scoped, agentWorkflow: new AgentWorkflow(scope.store, scoped) };
        workflowByStore.set(scope.store, pair);
    }
    return { scope, store: scope.store, workflow: pair.workflow, agentWorkflow: pair.agentWorkflow };
}
/**
 * The model-facing description of `devflow_dispatch_agent`.
 *
 * It is a named constant (not an inline literal) because it is **behavioural**, not
 * decoration: the model reads it at the exact moment it decides how many dispatch
 * calls to emit. Measured in production before this text existed: across 17 dispatch
 * steps, a dispatch NEVER shared a step with any other call — the model had been told
 * (by the tool's single-dispatch framing) that dispatching is a solo, blocking act,
 * so the host's parallel scheduler never saw a second call to overlap.
 *
 * Exported so a test can pin the overlap sentence without composing a whole runtime.
 */
export const DEVFLOW_DISPATCH_AGENT_DESCRIPTION = 'Dispatch one existing task to a registered code engineer or auditor through the native Harness spawn provider. The child receives only its configured tools and Skill-bound persona. '
    + 'This call can OVERLAP with other dispatch calls: when several tasks are ready and independent (they do not write the same files / directories / config), send them as parallel calls in ONE reply so the children run at the same time — do not dispatch one and wait for it before dispatching the next. Tasks that DO share products, or where the second needs the first\'s output, must stay sequential.';
/**
 * Register every DevFlow tool family on the calling context.
 * @param ctx - registrant context; tools register only when a tool runtime is composed.
 * @param services - store, task session resolution, and workflows the tools delegate to.
 */
export function registerDevFlowTools(ctx, services) {
    const { store, workflow, agentWorkflow, isCommander } = services;
    ctx.tools.register(defineTool({
        name: 'devflow_project_status',
        description: 'Show the current DevFlow project context (goal, current stage) and task overview. '
            + 'Returns the saved project, or null when no project has been initialized in this devflow root.',
        parameters: {},
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    project: {
                        oneOf: [projectValueSchema, { type: 'null' }],
                        required: true,
                    },
                },
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: value.project === null
                        ? 'No project initialized in this devflow root.'
                        : `Project: ${value.project.name} (${value.project.id}), stage ${value.project.currentStage}.`,
                }],
        },
        execute: async (_args, exec) => {
            const { store: sessionStore } = bindSession(services, exec.agent);
            const project = (await sessionStore.loadProject()) ?? null;
            return { project };
        },
        presentCall: () => ({ card: 'generic', title: 'DevFlow project status', kind: 'other' }),
        presentResult: (_args, result) => ({
            card: 'generic',
            title: 'DevFlow project status',
            content: result.content,
        }),
    }));
    ctx.tools.register(defineTool({
        name: 'devflow_create_task',
        description: 'Create a DevFlow task in the initial `created` state. '
            + 'The task lifecycle then moves through planned, executing, reviewing, and completed via devflow_transition_task.',
        parameters: {
            title: { type: 'string', required: true, description: 'Human-readable task title.' },
            description: { type: 'string', required: true, description: 'Free-form task description.' },
            assignedRole: {
                type: 'string',
                enum: ASSIGNED_ROLES,
                description: 'Role the task is assigned to: planner, backend-engineer, frontend-engineer, or reviewer (optional).',
            },
        },
        output: { schema: taskValueSchema, render: (_args, value) => [{ type: 'text', text: `Created task ${value.id}: ${value.title} (${value.status}).` }] },
        execute: async (args, exec) => {
            const { store: sessionStore, workflow: sessionWorkflow } = bindSession(services, exec.agent);
            const task = await sessionWorkflow.createTask({
                title: args.title,
                description: args.description,
                status: 'created',
                ...(args.assignedRole === undefined ? {} : { assignedRole: args.assignedRole }),
            });
            // The task creation lands in the calling session's log (when there is
            // one); the file store remains the authoritative record either way.
            await recordDevFlowChange(sessionStore, 'devflow/task/transition', {
                taskId: task.id,
                title: task.title,
                from: null,
                to: task.status,
                at: task.createdAt,
            });
            return task;
        },
        presentCall: args => ({ card: 'generic', title: 'Create DevFlow task', kind: 'other', rawInput: args }),
        presentResult: (_args, result) => ({ card: 'generic', title: 'DevFlow task created', content: result.content }),
    }));
    ctx.tools.register(defineTool({
        name: 'devflow_transition_task',
        description: 'Advance one DevFlow task to the given status. Legal moves: created -> planned, '
            + 'planned -> executing, executing -> reviewing, reviewing -> completed, and the rework edge reviewing -> executing. '
            + 'Illegal transitions are rejected with the current and requested status.',
        parameters: {
            taskId: { type: 'string', required: true, description: 'The task id to advance.' },
            transition: {
                type: 'string',
                required: true,
                enum: ['planned', 'executing', 'reviewing', 'completed', 'failed', 'cancelled'],
                description: 'The target status: planned, executing, reviewing, completed, failed, or cancelled. Use role ids only in assignedRole/agentId.',
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    task: { ...taskValueSchema, required: true },
                    change: { ...taskStatusChangeValueSchema, required: true },
                },
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: `Task ${value.task.id} moved ${value.change.from} -> ${value.change.to}.`,
                }],
        },
        execute: async (args, exec) => {
            const { store: sessionStore, workflow: sessionWorkflow } = bindSession(services, exec.agent);
            let result;
            switch (args.transition) {
                case 'planned':
                    result = await sessionWorkflow.planTask(args.taskId);
                    break;
                case 'executing':
                    result = await sessionWorkflow.startExecution(args.taskId);
                    break;
                case 'reviewing':
                    result = await sessionWorkflow.submitReview(args.taskId);
                    break;
                case 'completed':
                    result = await sessionWorkflow.completeTask(args.taskId);
                    break;
                case 'failed':
                    result = await sessionWorkflow.failTask(args.taskId);
                    break;
                case 'cancelled':
                    result = await sessionWorkflow.cancelTask(args.taskId);
                    break;
                default: {
                    const exhaustive = args.transition;
                    throw new Error(`unreachable transition ${String(exhaustive)}`);
                }
            }
            await recordDevFlowChange(sessionStore, 'devflow/task/transition', {
                ...result.change,
                title: result.task.title,
            });
            return { task: result.task, change: result.change };
        },
        presentCall: args => ({ card: 'generic', title: 'Advance DevFlow task', kind: 'other', rawInput: args }),
        presentResult: (_args, result) => ({ card: 'generic', title: 'DevFlow task advanced', content: result.content }),
    }));
    ctx.tools.register(defineTool({
        name: 'devflow_submit_result',
        description: 'Archive one Agent execution result for a task. The result is saved as the task\'s result record; '
            + 'advance the task to `reviewing` separately with devflow_transition_task when the review phase begins.',
        parameters: {
            taskId: { type: 'string', required: true, description: 'The task this result belongs to.' },
            summary: { type: 'string', required: true, description: 'One-paragraph execution summary.' },
            changes: { type: 'array', required: true, items: { type: 'string' }, description: 'Files, interfaces, or config changes made.' },
            verification: { type: 'array', required: true, items: { type: 'string' }, description: 'Verification method and outcome.' },
            issues: { type: 'array', required: true, items: { type: 'string' }, description: 'Unfinished work, risks, and follow-ups.' },
            nextSteps: { type: 'array', required: true, items: { type: 'string' }, description: 'Suggested next steps.' },
        },
        output: { schema: resultValueSchema, render: (_args, value) => [{ type: 'text', text: `Saved result ${value.id} for task ${value.taskId}.` }] },
        execute: async (args, exec) => {
            const { store: sessionStore } = bindSession(services, exec.agent);
            const saved = await sessionStore.saveResult({
                taskId: args.taskId,
                summary: args.summary,
                changes: args.changes,
                verification: args.verification,
                issues: args.issues,
                nextSteps: args.nextSteps,
            });
            // The canonical value is the mutable JSON shape the schema declares.
            return {
                ...saved,
                changes: [...saved.changes],
                verification: [...saved.verification],
                issues: [...saved.issues],
                nextSteps: [...saved.nextSteps],
            };
        },
        presentCall: args => ({ card: 'generic', title: 'Submit DevFlow result', kind: 'other', rawInput: args }),
        presentResult: (_args, result) => ({ card: 'generic', title: 'DevFlow result saved', content: result.content }),
    }));
    ctx.tools.register(defineTool({
        name: 'devflow_create_task_package',
        description: 'Build the Agent handoff package for one task: the vendor-neutral envelope '
            + '(protocol version, project context, task, instructions, acceptance criteria) an Agent consumes '
            + 'to execute the task. Requires an initialized project and an assigned role (or an explicit role argument).',
        parameters: {
            taskId: { type: 'string', required: true, description: 'The task to package.' },
            role: {
                type: 'string',
                enum: ASSIGNED_ROLES,
                description: 'Target role for the handoff; defaults to the task\'s assigned role.',
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    protocolVersion: { type: 'string', required: true },
                    taskId: { type: 'string', required: true },
                    role: { type: 'string', required: true },
                    projectContext: { ...projectValueSchema, required: true },
                    task: { ...taskValueSchema, required: true },
                    instructions: { type: 'string', required: true },
                    acceptanceCriteria: { type: 'array', required: true, items: { type: 'string' } },
                    scopeGuard: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            maxModifiedFiles: { type: 'number', required: true },
                            maxToolSteps: { type: 'number', required: true },
                            completionCriteria: { type: 'array', required: true, items: { type: 'string' } },
                        },
                    },
                },
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: `Task package for ${value.taskId} (protocol ${value.protocolVersion}, role ${value.role}): `
                        + `${value.instructions || 'no instructions'} — ${value.acceptanceCriteria.length} acceptance criteria.`,
                }],
        },
        execute: async (args, exec) => {
            const { store: sessionStore } = bindSession(services, exec.agent);
            // A package with no instructions/criteria reads as `(none)` and leaves a
            // rework child guessing; synthesize both from the review rejection and
            // THIS TASK's scope guard (project default only as a marked fallback).
            const task = await sessionStore.getTask(args.taskId);
            if (task === undefined)
                throw new Error(`devflow: unknown task ${args.taskId}`);
            const bounds = await resolveTaskBounds(sessionStore, task);
            assertPackageScopeConsistency(task, bounds.scope);
            const prepared = await prepareTaskPackage(sessionStore, args.taskId, {
                ...(args.role === undefined ? {} : { role: args.role }),
                instructions: bounds.instructions,
                acceptanceCriteria: [...bounds.acceptanceCriteria],
                ...(bounds.scopeGuard === undefined ? {} : { scopeGuard: bounds.scopeGuard }),
            });
            // The schema declares mutable arrays; hand them over as copies and take
            // scopeGuard out of the package spread so its readonly criteria cannot
            // fight the declared output type.
            const { scopeGuard, ...packageRest } = prepared.package;
            return {
                ...packageRest,
                acceptanceCriteria: [...packageRest.acceptanceCriteria],
                ...(scopeGuard === undefined ? {} : {
                    scopeGuard: {
                        maxModifiedFiles: scopeGuard.maxModifiedFiles,
                        maxToolSteps: scopeGuard.maxToolSteps,
                        completionCriteria: [...scopeGuard.completionCriteria],
                    },
                }),
            };
        },
        presentCall: args => ({ card: 'generic', title: 'Create DevFlow task package', kind: 'other', rawInput: args }),
        presentResult: (_args, result) => ({ card: 'generic', title: 'DevFlow task package', content: result.content }),
    }));
    ctx.tools.register(defineTool({
        name: 'devflow_export_task',
        description: 'Export one task as its Markdown handoff document (task.md): project context, task, role, '
            + 'instructions, acceptance criteria, and file scope in the fixed DevFlow Task template. '
            + 'The document is returned as text — save it yourself and hand it to the external Executor Agent.',
        parameters: {
            taskId: { type: 'string', required: true, description: 'The task to export.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    taskId: { type: 'string', required: true },
                    markdown: { type: 'string', required: true },
                },
            },
            render: (_args, value) => [{ type: 'text', text: value.markdown }],
        },
        execute: async (args, exec) => {
            const { store: sessionStore, agentWorkflow: sessionAgentWorkflow } = bindSession(services, exec.agent);
            const exported = await sessionAgentWorkflow.exportTask(args.taskId, updated => (recordDevFlowChange(sessionStore, 'devflow/project/update', { project: updated }).then(() => undefined)));
            await recordDevFlowChange(sessionStore, 'devflow/bridge/export', {
                taskId: exported.taskId,
                bridge: 'markdown',
                at: new Date().toISOString(),
            });
            return exported;
        },
        presentCall: args => ({ card: 'generic', title: 'Export DevFlow task', kind: 'other', rawInput: args }),
        presentResult: (_args, result) => ({ card: 'generic', title: 'DevFlow task export', content: result.content }),
    }));
    ctx.tools.register(defineTool({
        name: 'devflow_import_result',
        description: 'Import one Markdown result document (result.md) produced by an external Executor Agent. '
            + 'The document is parsed with the MarkdownBridge, must target the given task, and is archived while '
            + 'the task advances to `reviewing` (the task must currently be `executing`).',
        parameters: {
            taskId: { type: 'string', required: true, description: 'The task the result document answers.' },
            markdown: { type: 'string', required: true, description: 'The full result document text.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    result: { ...resultValueSchema, required: true },
                    task: { ...taskValueSchema, required: true },
                },
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: `Imported result ${value.result.id} for task ${value.result.taskId}; task is now ${value.task.status}.`,
                }],
        },
        execute: async (args, exec) => {
            const { store: sessionStore, agentWorkflow: sessionAgentWorkflow } = bindSession(services, exec.agent);
            const submission = await sessionAgentWorkflow.importResult(args.taskId, args.markdown);
            await recordDevFlowChange(sessionStore, 'devflow/task/transition', {
                ...submission.transition.change,
                title: submission.transition.task.title,
            });
            await recordDevFlowChange(sessionStore, 'devflow/bridge/import', {
                taskId: args.taskId,
                resultId: submission.result.id,
                protocolVersion: submission.protocolVersion,
                verdict: submission.verdict,
                at: submission.result.createdAt,
            });
            const result = submission.result;
            return {
                result: {
                    ...result,
                    changes: [...result.changes],
                    verification: [...result.verification],
                    issues: [...result.issues],
                    nextSteps: [...result.nextSteps],
                },
                task: submission.transition.task,
            };
        },
        presentCall: args => ({ card: 'generic', title: 'Import DevFlow result', kind: 'other', rawInput: args }),
        presentResult: (_args, result) => ({ card: 'generic', title: 'DevFlow result imported', content: result.content }),
    }));
    ctx.tools.register(defineTool({
        name: 'devflow_resume',
        description: 'Generate the Planner Resume for one task: the structured context (project, current task, '
            + 'execution results, task history) plus the rendered resume.md the Planner continues the next stage from.',
        parameters: {
            taskId: { type: 'string', required: true, description: 'The task the Planner resumes on.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    taskId: { type: 'string', required: true },
                    project: { ...projectValueSchema, required: true },
                    task: { ...taskValueSchema, required: true },
                    results: { type: 'array', required: true, items: resultValueSchema },
                    history: { type: 'array', required: true, items: taskValueSchema },
                    resume: { type: 'string', required: true },
                },
            },
            render: (_args, value) => [{ type: 'text', text: value.resume }],
        },
        execute: async (args, exec) => {
            const { store: sessionStore, agentWorkflow: sessionAgentWorkflow } = bindSession(services, exec.agent);
            const { context, resume } = await sessionAgentWorkflow.resumeTask(args.taskId);
            await recordDevFlowChange(sessionStore, 'devflow/planner/resume', {
                taskId: args.taskId,
                at: new Date().toISOString(),
            });
            return {
                taskId: args.taskId,
                project: context.project,
                task: context.task,
                results: context.results.map(result => ({
                    ...result,
                    changes: [...result.changes],
                    verification: [...result.verification],
                    issues: [...result.issues],
                    nextSteps: [...result.nextSteps],
                })),
                history: context.history.map(task => ({ ...task })),
                resume,
            };
        },
        presentCall: args => ({ card: 'generic', title: 'DevFlow planner resume', kind: 'other', rawInput: args }),
        presentResult: (_args, result) => ({ card: 'generic', title: 'DevFlow planner resume', content: result.content }),
    }));
    ctx.tools.register(defineTool({
        name: 'devflow_create_phase',
        description: 'Create an ordered DevFlow development phase for the Commander plan.',
        parameters: {
            name: { type: 'string', required: true, description: 'Human-readable phase name.' },
            description: { type: 'string', required: true, description: 'Phase goal and expected work.' },
        },
        output: {
            schema: { type: 'object', additionalProperties: false, properties: {
                    id: { type: 'string', required: true }, name: { type: 'string', required: true },
                    description: { type: 'string', required: true }, status: { type: 'string', required: true, enum: PHASE_STATUSES },
                    createdAt: { type: 'string', required: true }, updatedAt: { type: 'string', required: true },
                } },
            render: (_args, value) => [{ type: 'text', text: `Created phase ${value.id}: ${value.name}.` }],
        },
        execute: async (args, exec) => {
            const { store: sessionStore } = bindSession(services, exec.agent);
            const phase = await sessionStore.createPhase({ name: args.name, description: args.description, status: 'planned' });
            await recordDevFlowChange(sessionStore, 'devflow/phase/create', { phase });
            return phase;
        },
        presentCall: args => ({ card: 'generic', title: 'Create DevFlow phase', kind: 'other', rawInput: args }),
        presentResult: (_args, result) => ({ card: 'generic', title: 'DevFlow phase created', content: result.content }),
    }));
    ctx.tools.register(defineTool({
        name: 'devflow_update_phase',
        description: 'Set a DevFlow phase status: planned, in_progress, or completed.',
        parameters: {
            phaseId: { type: 'string', required: true, description: 'The phase id to update.' },
            status: { type: 'string', required: true, enum: PHASE_STATUSES, description: 'The new phase status.' },
        },
        output: { schema: { type: 'object', additionalProperties: false, properties: {
                    id: { type: 'string', required: true }, name: { type: 'string', required: true }, description: { type: 'string', required: true },
                    status: { type: 'string', required: true, enum: PHASE_STATUSES }, createdAt: { type: 'string', required: true }, updatedAt: { type: 'string', required: true },
                } }, render: (_args, value) => [{ type: 'text', text: `Phase ${value.id} is ${value.status}.` }] },
        execute: async (args, exec) => {
            const { store: sessionStore } = bindSession(services, exec.agent);
            const phase = await sessionStore.updatePhaseStatus(args.phaseId, args.status);
            await recordDevFlowChange(sessionStore, 'devflow/phase/update', { phaseId: phase.id, status: phase.status, at: phase.updatedAt });
            return phase;
        },
        presentCall: args => ({ card: 'generic', title: 'Update DevFlow phase', kind: 'other', rawInput: args }),
        presentResult: (_args, result) => ({ card: 'generic', title: 'DevFlow phase updated', content: result.content }),
    }));
    ctx.tools.register(defineTool({
        name: 'devflow_set_scope',
        description: 'Set the Scope Guard. Pass a taskId to bind the bounds to ONE task (the recommended form: the task package then carries exactly these bounds and no other task can overwrite them). Without a taskId the bounds become the PROJECT default, used only by tasks that never set their own.',
        parameters: {
            summary: { type: 'string', required: true, description: 'Committed scope summary.' },
            inScope: { type: 'array', required: true, items: { type: 'string' }, description: 'In-scope work items.' },
            maxModifiedFiles: { type: 'number', required: true, description: 'Positive maximum modified file count.' },
            maxToolSteps: { type: 'number', required: true, description: 'Positive maximum tool step count.' },
            completionCriteria: { type: 'array', required: true, items: { type: 'string' }, description: 'Non-empty completion criteria.' },
            taskId: { type: 'string', description: 'Bind these bounds to one task; omit for the project default.' },
        },
        output: { schema: { type: 'object', additionalProperties: false, properties: {
                    source: { type: 'string', required: true },
                    taskId: { type: 'string' },
                    summary: { type: 'string', required: true }, inScope: { type: 'array', required: true, items: { type: 'string' } },
                    maxModifiedFiles: { type: 'number', required: true }, maxToolSteps: { type: 'number', required: true },
                    completionCriteria: { type: 'array', required: true, items: { type: 'string' } }, createdAt: { type: 'string', required: true }, updatedAt: { type: 'string', required: true },
                } }, render: (_args, value) => [{ type: 'text', text: value.taskId === undefined
                        ? `Project default Scope Guard set: ${value.summary}.`
                        : `Scope Guard set for task ${value.taskId}: ${value.summary}.` }] },
        execute: async (args, exec) => {
            const { store: sessionStore } = bindSession(services, exec.agent);
            const input = {
                summary: args.summary, inScope: args.inScope, maxModifiedFiles: args.maxModifiedFiles,
                maxToolSteps: args.maxToolSteps, completionCriteria: args.completionCriteria,
            };
            // A task-scoped guard is stored beside the project default, never over it:
            // one task's bounds must not silently re-bound another task's rework.
            const scope = args.taskId === undefined
                ? await sessionStore.updateScope(input)
                : await sessionStore.saveTaskScope(args.taskId, input);
            await recordDevFlowChange(sessionStore, args.taskId === undefined ? 'devflow/scope/update' : 'devflow/scope/task-update', {
                scope,
                ...(args.taskId === undefined ? {} : { taskId: args.taskId }),
            });
            return {
                source: args.taskId === undefined ? 'project-default' : 'task',
                ...(args.taskId === undefined ? {} : { taskId: args.taskId }),
                ...scope,
                inScope: [...scope.inScope],
                completionCriteria: [...scope.completionCriteria],
            };
        },
        presentCall: args => ({ card: 'generic', title: 'Set DevFlow scope', kind: 'other', rawInput: args }),
        presentResult: (_args, result) => ({ card: 'generic', title: 'DevFlow scope set', content: result.content }),
    }));
    ctx.tools.register(defineTool({
        name: 'devflow_clear_scope',
        description: 'Clear stale Scope Guard bounds. Pass a taskId to clear that task\'s own bounds; omit it to clear the project default. Use this when a task carries bounds that belong to another task (the handoff is then refused with DEVFLOW_DISPATCH_SCOPE_CONFLICT) instead of dispatching a contradictory package.',
        parameters: {
            taskId: { type: 'string', description: 'Clear this task\'s own bounds; omit to clear the project default.' },
        },
        output: { schema: { type: 'object', additionalProperties: false, properties: {
                    cleared: { type: 'string', required: true },
                    taskId: { type: 'string' },
                } }, render: (_args, value) => [{ type: 'text', text: value.taskId === undefined
                        ? 'Project default Scope Guard cleared.'
                        : `Scope Guard cleared for task ${value.taskId}.` }] },
        execute: async (args, exec) => {
            const { store: sessionStore } = bindSession(services, exec.agent);
            if (args.taskId === undefined) {
                await sessionStore.clearScope();
                await recordDevFlowChange(sessionStore, 'devflow/scope/clear', { at: new Date().toISOString() });
                return { cleared: 'project-default' };
            }
            await sessionStore.clearTaskScope(args.taskId);
            await recordDevFlowChange(sessionStore, 'devflow/scope/task-clear', { taskId: args.taskId, at: new Date().toISOString() });
            return { cleared: 'task', taskId: args.taskId };
        },
        presentCall: args => ({ card: 'generic', title: 'Clear DevFlow scope', kind: 'other', rawInput: args }),
        presentResult: (_args, result) => ({ card: 'generic', title: 'DevFlow scope cleared', content: result.content }),
    }));
    ctx.tools.register(defineTool({
        name: 'devflow_assign_agent',
        description: 'Assign one registered DevFlow employee to a development phase. The valid agent ids are exactly the orchestration roster — the fixed employees (commander, backend-engineer, frontend-engineer, architect, code-auditor) plus any temporary employee registered with devflow_agent_upsert. Role names such as planner are not agent ids.',
        parameters: {
            phaseId: { type: 'string', required: true, description: 'The phase to assign.' },
            taskId: { type: 'string', required: true, description: 'The task to assign.' },
            // No `enum` here on purpose. An enum is fixed when the tool registers, so it can
            // only ever list agents that existed at host start-up — which is exactly how a
            // newly registered employee became unassignable. The roster is the single
            // authority and it is read below, so the rejection keeps its precise message
            // for a genuinely unknown id while a freshly registered one is accepted.
            agentId: { type: 'string', required: true, description: 'Registered orchestration agent id (a fixed employee, or a temporary employee registered with devflow_agent_upsert); do not pass a role such as planner.' },
            role: { type: 'string', required: true, enum: ASSIGNED_ROLES, description: 'Role the agent performs for this phase.' },
        },
        output: { schema: { type: 'object', additionalProperties: false, properties: {
                    assignmentId: { type: 'string', required: true }, taskId: { type: 'string', required: true }, phaseId: { type: 'string', required: true }, agentId: { type: 'string', required: true },
                    role: { type: 'string', required: true, enum: ASSIGNED_ROLES }, status: { type: 'string', required: true },
                    createdAt: { type: 'string', required: true }, updatedAt: { type: 'string', required: true },
                } }, render: (_args, value) => [{ type: 'text', text: `Assigned ${value.agentId} to phase ${value.phaseId}.` }] },
        execute: async (args, exec) => {
            const { store: sessionStore } = bindSession(services, exec.agent);
            if (await sessionStore.getPhase(args.phaseId) === undefined) {
                throw new Error(`devflow: unknown phase ${args.phaseId}; create the phase first and pass the returned phase id unchanged`);
            }
            if (await sessionStore.getAgent(args.agentId) === undefined)
                throw new Error(`devflow: unknown orchestration agent ${args.agentId}`);
            if (await sessionStore.getTask(args.taskId) === undefined)
                throw new Error(`devflow: unknown task ${args.taskId}`);
            const assignment = await sessionStore.createAssignment({ taskId: args.taskId, phaseId: args.phaseId, agentId: args.agentId, role: args.role, status: 'assigned' });
            await recordDevFlowChange(sessionStore, 'devflow/orchestration/assign', { assignment });
            return { ...assignment, taskId: args.taskId };
        },
        presentCall: args => ({ card: 'generic', title: 'Assign DevFlow agent', kind: 'other', rawInput: args }),
        presentResult: (_args, result) => ({ card: 'generic', title: 'DevFlow agent assigned', content: result.content }),
    }));
    ctx.tools.register(defineTool({
        name: 'devflow_request_decision',
        description: 'The only Commander tool for direction, scope, or risk decisions. Use it for ambiguity, approach divergence, scope creep, repeated review failure, and high-risk operations. '
            + 'Pass a "question", 3-5 concrete "options" ({ id, label, description }), and "recommendedOption" set to one of those ids. '
            + 'The user-custom ("Custom") option is appended by the server — do NOT add your own custom entry, and do not send more than 5 options.',
        parameters: {
            taskId: { type: 'string', description: 'Optional related task id.' },
            trigger: { type: 'string', required: true, enum: [...DECISION_TRIGGERS] },
            question: { type: 'string', required: true, description: 'Question shown to the user.' },
            recommendedOption: { type: 'string', required: true, description: 'Id of the recommended option; MUST be one of the ids you pass in "options".' },
            options: {
                // `json` is not shape-enforced by the runtime, so a stringified array
                // reaches this tool and is parsed with an actionable message instead of
                // a bare type error; the count/id rules are validated in the tool.
                type: 'json',
                required: true,
                description: 'The 3-5 concrete options as an array of { id, label, description } (the product shape is exactly 3). A JSON-text array is accepted. The Custom option is appended automatically.',
            },
        },
        output: { schema: { type: 'object', additionalProperties: false, properties: {
                    requestId: { type: 'string', required: true }, answer: { type: 'object', required: true, additionalProperties: true },
                } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value.answer) }] },
        execute: async (rawArgs, exec) => {
            const { store: sessionStore } = bindSession(services, exec.agent);
            const project = await sessionStore.loadProject();
            if (project === undefined)
                throw new Error('devflow: no project initialized before requesting a decision');
            const args = parseDecisionRequestArgs(rawArgs);
            // A task whose employee already reported a capability blocker must NOT be
            // turned into a menu. That block is an objective obstruction the user
            // cannot choose their way out of, and a recommended option would send them
            // straight back into it; the blocked banner carries it instead.
            if (args.taskId !== undefined) {
                const state = await sessionStore.loadState();
                const blocking = blockedReportsForTask(state.blockedReports ?? {}, args.taskId);
                if (blocking.length > 0) {
                    const newest = blocking[0];
                    throw new Error(`devflow: task ${args.taskId} is blocked by a reported capability gap (${newest.gapKind}: ${newest.missing}); `
                        + 'a decision popup would ask the user to choose a route this runtime cannot run — report the block instead of requesting a decision');
                }
            }
            const now = new Date().toISOString();
            const request = {
                requestId: randomUUID(), projectId: project.id, taskId: args.taskId ?? null, trigger: args.trigger, question: args.question,
                options: args.options.map(option => ({ ...option })),
                allowCustom: true, status: 'pending', answer: null, createdAt: now, answeredAt: null,
            };
            await recordDevFlowChange(sessionStore, 'devflow/decision/request', { request });
            // The question payload carries the concrete options ONLY. The Harness
            // question composer always offers its own free-text answer next to them
            // (`输入你的答案`), so a second "custom" row would be a competing entry
            // point that produces no text. The durable request keeps its `custom`
            // option and `allowCustom` for DevFlow's own decision surfaces.
            const question = {
                id: request.requestId,
                question: request.question,
                options: request.options
                    .filter(option => option.id !== DECISION_CUSTOM_OPTION_ID)
                    .map(option => ({ label: `${option.label}${option.recommended ? ' (Recommended)' : ''}`, description: option.description })),
            };
            const userQuestions = ctx.get('userQuestions');
            if (userQuestions === undefined)
                throw new Error('devflow: user questions service unavailable');
            const answers = await userQuestions.ask({ questions: [question], ...(exec.agent === undefined ? {} : { agent: exec.agent }), signal: exec.signal });
            const first = answers.answers[0];
            if (first === undefined)
                throw new Error('devflow: user decision returned no answer');
            const selected = first.selected[0];
            const optionId = request.options.find(option => option.label === selected || `${option.label} (Recommended)` === selected)?.id;
            const answer = first.custom === undefined
                ? { optionId: optionId ?? selected ?? 'custom' }
                : { custom: first.custom };
            await recordDevFlowChange(sessionStore, 'devflow/decision/answer', { requestId: request.requestId, answer, at: new Date().toISOString() });
            return { requestId: request.requestId, answer: answer };
        },
        presentCall: args => ({ card: 'generic', title: 'Request DevFlow decision', kind: 'other', rawInput: args }),
        presentResult: (_args, result) => ({ card: 'generic', title: 'DevFlow decision answer', content: result.content }),
    }));
    ctx.tools.register(defineTool({
        name: 'devflow_pause',
        description: 'Pause new DevFlow dispatches after the current work group completes. Running child agents are not interrupted.',
        parameters: {},
        output: { schema: { type: 'object', additionalProperties: false, properties: { paused: { type: 'boolean', required: true } } }, render: () => [{ type: 'text', text: 'DevFlow dispatches paused.' }] },
        execute: async (_args, exec) => {
            const { store: sessionStore } = bindSession(services, exec.agent);
            await recordDevFlowChange(sessionStore, 'devflow/control/pause', { at: new Date().toISOString() });
            return { paused: true };
        },
        presentCall: () => ({ card: 'generic', title: 'Pause DevFlow', kind: 'other' }),
        presentResult: (_args, result) => ({ card: 'generic', title: 'DevFlow paused', content: result.content }),
    }));
    ctx.tools.register(defineTool({
        name: 'devflow_resume_dispatch',
        description: 'Resume new DevFlow dispatches after a pause.',
        parameters: {},
        output: { schema: { type: 'object', additionalProperties: false, properties: { paused: { type: 'boolean', required: true } } }, render: () => [{ type: 'text', text: 'DevFlow dispatches resumed.' }] },
        execute: async (_args, exec) => {
            const { store: sessionStore } = bindSession(services, exec.agent);
            await recordDevFlowChange(sessionStore, 'devflow/control/resume', { at: new Date().toISOString() });
            return { paused: false };
        },
        presentCall: () => ({ card: 'generic', title: 'Resume DevFlow', kind: 'other' }),
        presentResult: (_args, result) => ({ card: 'generic', title: 'DevFlow resumed', content: result.content }),
    }));
    ctx.inject(['subagents'], (dispatchCtx) => {
        dispatchCtx.tools.register(defineTool({
            name: 'devflow_dispatch_agent',
            description: DEVFLOW_DISPATCH_AGENT_DESCRIPTION,
            parameters: {
                agentId: { type: 'string', required: true, description: 'Registered orchestration agent id.' },
                taskId: { type: 'string', required: true, description: 'Existing task id.' },
                description: { type: 'string', description: 'Optional short child-run label.' },
            },
            output: { schema: { type: 'object', additionalProperties: false, properties: {
                        taskId: { type: 'string', required: true }, agentId: { type: 'string', required: true }, summary: { type: 'string', required: true },
                        changes: { type: 'array', required: true, items: { type: 'string' } }, verification: { type: 'array', required: true, items: { type: 'string' } },
                        issues: { type: 'array', required: true, items: { type: 'string' } }, nextSteps: { type: 'array', required: true, items: { type: 'string' } },
                    } }, render: (_args, value) => [{ type: 'text', text: value.summary }] },
            /**
             * The concurrency predicate the host's scheduler reads.
             *
             * `defineTool` validates the arguments first and answers `false` on invalid
             * input, so this only decides the open case: join a parallel group while a
             * slot is free (`< DEVFLOW_CONCURRENCY_LIMIT` in-flight dispatches), and be
             * `exclusive` once the limit is reached. `exclusive` is the safe direction —
             * the host starts the call after the running group drains, which is
             * 「超限排队」 — so the only failure mode a wrong answer can produce is a
             * slower dispatch, never an overlapping one.
             */
            isConcurrencySafe: () => mayDispatchConcurrently(),
            execute: async (args, exec) => {
                // Take the in-flight slot BEFORE the first `await`. The host classifies the
                // NEXT call only after this body has started, so a synchronous bump here is
                // what makes the predicate above see a truthful count.
                const release = beginInFlightDispatch();
                try {
                    const parent = exec.agent;
                    if (parent === undefined)
                        throw new Error('devflow: dispatch requires a calling commander agent');
                    // (The body below keeps its original one-level indentation: the whole
                    // dispatch is nested inside this single try/finally and re-indenting it
                    // would produce a diff that hides the four lines that actually changed.)
                    // The child inherits this session's workspace, so the dispatch reads and
                    // writes the SAME project the Commander is bound to — never another's.
                    const { store, workflow, agentWorkflow } = bindSession(services, parent);
                    const projection = await store.loadState();
                    if (projection.paused === true)
                        throw new Error('devflow: dispatch is paused; resume after the current work group');
                    const child = await store.getAgent(args.agentId);
                    if (child === undefined)
                        throw new Error(`devflow: unknown orchestration agent ${args.agentId}`);
                    const initialTask = await store.getTask(args.taskId);
                    if (initialTask === undefined)
                        throw new Error(`devflow: unknown task ${args.taskId}`);
                    let task = initialTask;
                    const dispatchId = String(exec.callId);
                    const projectBefore = await store.loadProject();
                    if (projectBefore === undefined)
                        throw new Error('devflow: no project initialized before dispatch');
                    const gate = evaluateDispatchGates(task, projection, projectBefore);
                    // The capability breaker runs BEFORE any state moves: a task whose
                    // employees kept reporting the same missing capability must stop being
                    // re-dispatched instead of spending another turn reaching the same wall.
                    const breaker = capabilityBreaker(blockedReportsForTask(projection.blockedReports ?? {}, task.id));
                    if (breaker !== undefined) {
                        appendDispatchDiagnostic(store, {
                            dispatchId, taskId: task.id, agentId: args.agentId, projectId: projectBefore.id, taskStatus: task.status,
                            projectionStatus: gate.projectionStatus, reviewFailCount: gate.reviewFailCount, decisionStatus: gate.decisionStatus,
                            highRisk: gate.highRisk, status: 'blocked', at: new Date().toISOString(),
                        });
                        throw new Error(`devflow: DEVFLOW_DISPATCH_CAPABILITY_BREAKER: ${breaker.reason}`);
                    }
                    appendDispatchDiagnostic(store, {
                        dispatchId, taskId: task.id, agentId: args.agentId, projectId: projectBefore.id, taskStatus: task.status,
                        projectionStatus: gate.projectionStatus, reviewFailCount: gate.reviewFailCount, decisionStatus: gate.decisionStatus,
                        highRisk: gate.highRisk, status: gate.allowed ? 'started' : 'blocked', at: new Date().toISOString(),
                    });
                    if (!gate.allowed)
                        throw new Error(`devflow: ${dispatchGateMessage(gate)}`);
                    let activeAssignmentId;
                    let activeAssignment;
                    const runtime = {};
                    /** Child-reply attempts spent and the last bounded document problems. */
                    let resultAttempts = 0;
                    let resultProblems = [];
                    /**
                     * The tool allow list this dispatch actually handed the child. Declared
                     * here because the failure diagnostic below reports it; it stays empty
                     * when the dispatch aborted before the child's tools were resolved.
                     */
                    let allowedTools = [];
                    try {
                        // Resolve and validate the handoff's bounds BEFORE any state moves: a
                        // scope that contradicts the task must abort the dispatch instead of
                        // producing instructions that point the child at another task's work.
                        const bounds = await resolveTaskBounds(store, task);
                        assertPackageScopeConsistency(task, bounds.scope);
                        task = await prepareTaskForDispatch(workflow, store, task.id, (change, title) => (recordDevFlowChange(store, 'devflow/task/transition', { ...change, title }).then(() => undefined)));
                        const assignment = (await store.listAssignments()).find(item => item.taskId === task.id && item.agentId === child.agentId && item.status !== 'completed');
                        if (assignment === undefined) {
                            throw new Error(`devflow: no active assignment for task ${task.id} and agent ${child.agentId}`);
                        }
                        const startedAssignment = await store.updateAssignmentStatus(assignment.assignmentId, 'in_progress');
                        await recordDevFlowChange(store, 'devflow/orchestration/update', {
                            assignmentId: startedAssignment.assignmentId,
                            status: startedAssignment.status,
                            at: startedAssignment.updatedAt,
                        });
                        activeAssignmentId = startedAssignment.assignmentId;
                        activeAssignment = startedAssignment;
                        const prepared = await prepareTaskPackage(store, task.id, {
                            role: child.role,
                            instructions: bounds.instructions,
                            acceptanceCriteria: [...bounds.acceptanceCriteria],
                            ...(bounds.scopeGuard === undefined ? {} : { scopeGuard: bounds.scopeGuard }),
                        }, updated => (recordDevFlowChange(store, 'devflow/project/update', { project: updated }).then(() => undefined)));
                        const project = prepared.project;
                        const taskPackage = prepared.package;
                        const scopeGuard = taskPackage.scopeGuard ?? bounds.scopeGuard;
                        let plan = await store.createPlanning({ projectId: project.id, goal: task.title, mvpPlanId: null });
                        await recordDevFlowChange(store, 'devflow/commander/plan/create', { plan });
                        plan = await store.activatePlanning(plan.planningId);
                        await recordDevFlowChange(store, 'devflow/commander/plan/activate', { planningId: plan.planningId, at: plan.updatedAt });
                        let batch = await store.createBatch({
                            projectId: project.id,
                            planningId: plan.planningId,
                            phaseIds: [assignment.phaseId],
                            assignmentIds: [assignment.assignmentId],
                        });
                        runtime.batch = batch;
                        await recordDevFlowChange(store, 'devflow/execution/batch/create', { batch });
                        batch = await store.updateBatchStatus(batch.batchId, 'running');
                        runtime.batch = batch;
                        await recordDevFlowChange(store, 'devflow/execution/batch/start', { batchId: batch.batchId, at: batch.updatedAt });
                        let execution = await store.createExecutionRecord({
                            batchId: batch.batchId,
                            assignmentId: assignment.assignmentId,
                            agentId: child.agentId,
                            taskId: task.id,
                            ...(scopeGuard === undefined ? {} : { scopeGuard }),
                        });
                        runtime.execution = execution;
                        execution = await store.updateExecutionStatus(execution.executionId, 'running');
                        runtime.execution = execution;
                        await recordDevFlowChange(store, 'devflow/execution/start', { execution });
                        let attempt = await store.createAttempt({ executionId: execution.executionId, parentAttemptId: null, reason: null });
                        runtime.attempt = attempt;
                        await recordDevFlowChange(store, 'devflow/execution/attempt/create', { attempt });
                        attempt = await store.updateAttemptStatus(attempt.attemptId, 'running');
                        runtime.attempt = attempt;
                        await recordDevFlowChange(store, 'devflow/execution/attempt/start', { attemptId: attempt.attemptId, at: attempt.updatedAt });
                        const markdown = new MarkdownBridge().exportTask(taskPackage);
                        await recordDevFlowChange(store, 'devflow/bridge/export', { taskId: task.id, bridge: 'markdown', at: new Date().toISOString() });
                        const persona = assembleAgentPrompt(child, await store.resolveAgentSkills(child));
                        // Only names this runtime may actually register for an employee are
                        // forwarded: `tools.restrict()` rejects a name the child's scope does
                        // not know, so an unfiltered list aborts the start.
                        //
                        // "Available" must NOT be read off the parent's own view. The parent may
                        // be restricted (the Commander masks itself to its navigation tools), and
                        // intersecting the employee's list with THAT view collapsed every
                        // dispatched employee to the parent's three read-only tools. A name
                        // qualifies when the parent can see it or when the roster declares it.
                        const availableTools = new Set(parent.ctx.tools.schemas(parent).map(entry => entry.name));
                        allowedTools = dispatchableToolNames(child.tools, availableTools);
                        /** Start one child run and settle its result; the run is always disposed. */
                        const startChild = async (promptText) => {
                            const run = await dispatchCtx.subagents.start('spawn', {
                                label: args.description ?? `DevFlow ${child.role} task`,
                                prompt: [{ type: 'text', text: promptText }],
                                parent,
                                signal: exec.signal,
                                persona,
                                ...(allowedTools.length === 0 ? {} : { toolFilter: { allow: allowedTools } }),
                                maxDepth: delegationDepthOf(parent) + 1,
                                agentOptions: {
                                    ...(child.modelConfig.provider === undefined ? {} : { provider: child.modelConfig.provider }),
                                    model: child.modelConfig.model,
                                },
                            });
                            try {
                                return { id: String(run.id), result: await run.result };
                            }
                            finally {
                                await run.dispose();
                            }
                        };
                        // A fixed Agent sometimes answers in prose or wraps the result document
                        // in a fence. The parse tolerates that; when even that fails, ONE retry
                        // with an explicit instruction runs before the dispatch degrades to a
                        // REJECTED outcome (attempt/execution records kept, retryable, no abort —
                        // an abort would strand the requested rework).
                        let parsed;
                        let lastRunId = '';
                        let stopReason = '';
                        while (parsed === undefined) {
                            resultAttempts += 1;
                            const attempt = await startChild(resultAttempts === 1 ? markdown : `${markdown}\n\n${retryInstruction(resultProblems)}`);
                            lastRunId = attempt.id;
                            stopReason = attempt.result.stopReason;
                            if (attempt.result.stopReason !== 'completed') {
                                const code = `DEVFLOW_DISPATCH_${attempt.result.stopReason.toUpperCase().replace('-', '_')}`;
                                throw new Error(`devflow: ${code}: ${dispatchFailureSummary(code)}`);
                            }
                            const output = attempt.result.output
                                .filter((block) => block.type === 'text')
                                .map(block => block.text).join('');
                            if (output.trim() === '') {
                                resultProblems = ['the reply contained no result document'];
                                if (resultAttempts < MAX_RESULT_ATTEMPTS && !exec.signal.aborted)
                                    continue;
                                throw new Error('devflow: DEVFLOW_DISPATCH_EMPTY_OUTPUT: fixed Agent returned no result document');
                            }
                            try {
                                parsed = new MarkdownBridge().importResult(output);
                            }
                            catch (cause) {
                                if (!(cause instanceof ResultParseError))
                                    throw cause;
                                resultProblems = [...cause.problems];
                                if (resultAttempts < MAX_RESULT_ATTEMPTS && !exec.signal.aborted)
                                    continue;
                                throw new DispatchResultRejected(resultProblems, { cause });
                            }
                        }
                        const runId = lastRunId;
                        const result = { stopReason };
                        if (parsed.taskId !== task.id)
                            throw new Error(`devflow: DEVFLOW_DISPATCH_TASK_MISMATCH: result targets another task`);
                        let submission;
                        try {
                            submission = await agentWorkflow.submitResult(task.id, {
                                summary: parsed.summary, changes: parsed.changes, verification: parsed.verification, issues: parsed.issues, nextSteps: parsed.nextSteps,
                            });
                        }
                        catch (cause) {
                            throw new Error('devflow: DEVFLOW_DISPATCH_RESULT_IMPORT_FAILED: fixed Agent result could not be imported', { cause });
                        }
                        await recordDevFlowChange(store, 'devflow/task/transition', { ...submission.transition.change, title: submission.transition.task.title });
                        await recordDevFlowChange(store, 'devflow/bridge/import', {
                            taskId: task.id, resultId: submission.result.id, protocolVersion: parsed.protocolVersion, verdict: parsed.verdict, at: submission.result.createdAt,
                        });
                        appendDispatchDiagnostic(store, {
                            dispatchId, taskId: task.id, agentId: child.agentId, projectId: project.id, taskStatus: submission.transition.task.status,
                            projectionStatus: gate.projectionStatus, reviewFailCount: gate.reviewFailCount, decisionStatus: gate.decisionStatus,
                            highRisk: gate.highRisk, assignmentId: activeAssignmentId, assignmentAgentId: assignment.agentId, assignmentPhaseId: assignment.phaseId, assignmentStatus: 'in_progress', childDepth: delegationDepthOf(parent) + 1,
                            maxDepth: delegationDepthOf(parent) + 1, provider: 'spawn', model: child.modelConfig.model, toolFilter: allowedTools,
                            runId, stopReason, attempts: resultAttempts, status: 'completed', at: new Date().toISOString(),
                        });
                        if (runtime.attempt === undefined || runtime.execution === undefined)
                            throw new Error('devflow: direct dispatch runtime was not initialized');
                        runtime.attempt = await store.updateAttemptStatus(runtime.attempt.attemptId, 'completed');
                        await recordDevFlowChange(store, 'devflow/execution/attempt/complete', { attemptId: runtime.attempt.attemptId, at: runtime.attempt.updatedAt });
                        runtime.execution = await store.updateExecutionStatus(runtime.execution.executionId, 'completed');
                        await recordDevFlowChange(store, 'devflow/execution/complete', { executionId: runtime.execution.executionId, at: runtime.execution.updatedAt });
                        // The employee's OWN conclusion, read from the head of its reply. It is
                        // recorded next to (never instead of) the pipeline status: a dispatch
                        // that produced a report is `success` even when the work was blocked,
                        // and only `outcome` can tell those two facts apart.
                        const declared = declaredOutcome(parsed.summary);
                        const report = await store.createReport({
                            executionId: runtime.execution.executionId,
                            agentId: child.agentId,
                            status: 'success',
                            summary: safeReportSummary(parsed.summary),
                            outputReference: `devflow:result:${submission.result.id}`,
                            ...(declared === undefined ? {} : { outcome: declared.outcome }),
                        });
                        await recordDevFlowChange(store, 'devflow/agent/report/create', { report });
                        if (declared?.outcome === 'blocked') {
                            // A declared blocker becomes a first-class record the panel can show
                            // and the dispatch breaker can count. Nothing is inferred here: the
                            // record exists only because the employee said so.
                            const blocked = blockedReportFrom({
                                taskId: task.id,
                                agentId: child.agentId,
                                executionId: runtime.execution.executionId,
                                detail: declared.detail,
                            });
                            await recordDevFlowChange(store, 'devflow/blocked/report', { blocked });
                        }
                        if (activeAssignmentId !== undefined) {
                            const completedAssignment = await store.updateAssignmentStatus(activeAssignmentId, 'completed');
                            await recordDevFlowChange(store, 'devflow/orchestration/update', {
                                assignmentId: completedAssignment.assignmentId,
                                status: completedAssignment.status,
                                at: completedAssignment.updatedAt,
                            });
                            activeAssignmentId = undefined;
                        }
                        await completeBatch(store, runtime);
                        return {
                            taskId: task.id, agentId: child.agentId, summary: parsed.summary, changes: [...parsed.changes],
                            verification: [...parsed.verification], issues: [...parsed.issues], nextSteps: [...parsed.nextSteps],
                        };
                    }
                    catch (cause) {
                        if (activeAssignmentId !== undefined) {
                            try {
                                const restoredAssignment = await store.updateAssignmentStatus(activeAssignmentId, 'assigned');
                                await recordDevFlowChange(store, 'devflow/orchestration/update', {
                                    assignmentId: restoredAssignment.assignmentId,
                                    status: restoredAssignment.status,
                                    at: restoredAssignment.updatedAt,
                                });
                            }
                            catch {
                                // Preserve the dispatch error; the assignment can be repaired through its durable record.
                            }
                        }
                        const current = await store.getTask(task.id);
                        const code = dispatchFailureCode(cause);
                        const problems = cause instanceof DispatchResultRejected ? cause.problems : undefined;
                        await failDirectDispatch(store, runtime, child.agentId, code, {
                            ...(code === 'DEVFLOW_DISPATCH_RESULT_REJECTED' ? { reportStatus: 'blocked' } : {}),
                            ...(problems === undefined ? {} : { problems }),
                        });
                        const failureDiagnostic = {
                            dispatchId, taskId: task.id, agentId: child.agentId, projectId: projectBefore.id, taskStatus: current?.status ?? task.status,
                            projectionStatus: gate.projectionStatus, reviewFailCount: gate.reviewFailCount, decisionStatus: gate.decisionStatus,
                            highRisk: gate.highRisk, ...(activeAssignmentId === undefined || activeAssignment === undefined ? {} : { assignmentId: activeAssignmentId, assignmentAgentId: activeAssignment.agentId, assignmentPhaseId: activeAssignment.phaseId, assignmentStatus: 'assigned' }),
                            provider: 'spawn', model: child.modelConfig.model, toolFilter: allowedTools,
                            errorCode: code,
                            errorMessage: summaryWithProblems(code, problems),
                            attempts: resultAttempts,
                            status: 'failed', at: new Date().toISOString(),
                        };
                        appendDispatchDiagnostic(store, failureDiagnostic);
                        if (current?.status === 'executing') {
                            const failed = await workflow.failTask(task.id);
                            await recordDevFlowChange(store, 'devflow/task/transition', { ...failed.change, title: failed.task.title });
                        }
                        throw cause;
                    }
                }
                finally {
                    // The ONE release for every path above: success (`return`), a thrown
                    // gate/breaker error, a failed child run, an aborted signal, or a store
                    // write failing half-way. Without this the counter only ever rises and
                    // the runtime silently serializes forever — the failure mode a bare
                    // increment would hide.
                    release();
                }
            },
            presentCall: args => ({ card: 'generic', title: 'Dispatch DevFlow agent', kind: 'other', rawInput: args }),
            presentResult: (_args, result) => ({ card: 'generic', title: 'DevFlow agent result', content: result.content }),
        }));
    });
    ctx.tools.register(defineTool({
        name: 'devflow_agent_upsert',
        description: 'Register or update a TEMPORARY employee of the DevFlow team, and return it. Only the Commander may call this: the caller must currently hold the Commander seat, and every other caller (or a call with no caller at all) is refused. The employee becomes dispatchable immediately: it enters the orchestration roster (so devflow_assign_agent accepts its id) and it can spawn no children of its own. The fixed employees (commander, backend-engineer, frontend-engineer, architect, code-auditor) already exist after project init and cannot be redefined here — to assign work to one of them use devflow_assign_agent with the fixed employee id.',
        parameters: {
            id: { type: 'string', required: true, description: 'Stable lowercase slug id, e.g. executor-main.' },
            role: { type: 'string', required: true, enum: ASSIGNED_ROLES, description: 'The role this instance plays.' },
            displayName: { type: 'string', required: true, description: 'Display name (Chinese allowed).' },
            description: { type: 'string', description: 'One-paragraph responsibility description.' },
            capabilities: { type: 'array', items: { type: 'string' }, description: 'Capability tags.' },
            metadata: { type: 'object', additionalProperties: true, description: 'Free-form extension fields.' },
            // Fail-closed: omitting this grants the READ-ONLY set, never the role peer's full
            // set. `write` / `edit` / `pwsh` / `str_replace_editor` must be named explicitly.
            tools: {
                type: 'array',
                items: { type: 'string' },
                description: 'Tool names this temporary employee may use. OMIT IT for a read-only employee (research / collection): the default is read, glob, grep, read_image. Declaring write / edit / pwsh is REQUIRED for an employee that must write files or run commands, and the declaration is recorded in the agent journal. Names this runtime cannot grant are trimmed, never silently kept.',
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    id: { type: 'string', required: true },
                    role: { type: 'string', required: true, enum: ASSIGNED_ROLES },
                    displayName: { type: 'string', required: true },
                    description: { type: 'string' },
                    capabilities: { type: 'array', items: { type: 'string' } },
                    metadata: { type: 'object', additionalProperties: true },
                    tools: { type: 'array', required: true, items: { type: 'string' } },
                    createdAt: { type: 'string', required: true },
                    updatedAt: { type: 'string', required: true },
                },
            },
            render: (_args, value) => [{ type: 'text', text: `Temporary employee ${value.id} (${value.role}) registered as ${value.displayName}; it is now assignable and dispatchable, with tools: ${value.tools.join(', ')}.` }],
        },
        execute: async (args, exec) => {
            const { store: sessionStore } = bindSession(services, exec.agent);
            if (args.tools !== undefined && !isToolNameArray(args.tools)) {
                throw new Error('devflow: tools must be an array of tool names (strings); omit it entirely for a read-only employee');
            }
            const existing = await sessionStore.getAgentInstance(args.id);
            const patch = {
                role: args.role,
                displayName: args.displayName,
                ...(args.description === undefined ? {} : { description: args.description }),
                ...(args.capabilities === undefined ? {} : { capabilities: args.capabilities }),
                ...(args.metadata === undefined ? {} : { metadata: args.metadata }),
            };
            const instance = existing === undefined
                ? await sessionStore.createAgentInstance({ id: args.id, ...patch })
                : await sessionStore.updateAgentInstance(args.id, patch);
            await recordDevFlowChange(sessionStore, 'devflow/agent/upsert', { instance });
            const registered = await registerDispatchableEmployee(sessionStore, instance, exec.agent, isCommander, args.tools);
            // The canonical value is the mutable JSON shape the schema declares.
            const { capabilities, metadata, ...rest } = instance;
            return {
                ...rest,
                ...(capabilities === undefined ? {} : { capabilities: [...capabilities] }),
                // The GRANTED budget reported back verbatim, so the caller can see the trim's
                // result instead of assuming its declaration survived.
                tools: [...registered.tools],
                // Tool output crosses a JSON boundary; metadata values must be JSON.
                ...(metadata === undefined ? {} : { metadata: metadata }),
            };
        },
        presentCall: args => ({ card: 'generic', title: 'Upsert DevFlow agent', kind: 'other', rawInput: args }),
        presentResult: (_args, result) => ({ card: 'generic', title: 'DevFlow agent saved', content: result.content }),
    }));
}
