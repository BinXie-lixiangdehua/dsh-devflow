/**
 * DevFlow model-facing tools: project status, task creation, task
 * transitions, result submission, and task-package creation. The tools are
 * thin, composed over the store and workflow — no scheduling, no Agent
 * calls, no external connections.
 * @module @xiaoxie-ide/dsh-devflow/tools
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { DevFlowStore } from './storage.ts';
import type { DevFlowSessionStores } from './session-store.ts';
import { TaskWorkflow } from './workflow.ts';
import { AgentWorkflow } from './workflow-agent.ts';
import type { DecisionOption, DecisionTrigger } from './types.ts';
/** Current in-flight dispatch count. Exported so a gate/test can read the truth. */
export declare function inFlightDispatchCount(): number;
/**
 * Whether one more dispatch may join a parallel group. `false` is not an error:
 * the host classifies the call `exclusive`, so it waits for the running group to
 * drain and then starts — this IS "超限排队".
 */
export declare function mayDispatchConcurrently(): boolean;
/**
 * The user-custom option carried by a DURABLE decision request.
 *
 * DevFlow's own decision surfaces render this copy, so it is Chinese like the
 * rest of them. It is one shared constant rather than a literal at each call
 * site: the popup copy drifted into English precisely because it was hardcoded
 * inline.
 */
export declare const DECISION_CUSTOM_OPTION: DecisionOption;
/** Validated arguments of one decision request, with the custom entry appended. */
export interface DecisionRequestArgs {
    readonly taskId?: string | undefined;
    readonly trigger: DecisionTrigger;
    readonly question: string;
    readonly recommendedOption: string;
    readonly options: readonly DecisionOption[];
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
export declare function parseDecisionRequestArgs(raw: unknown): DecisionRequestArgs;
export interface DevFlowToolServices {
    /**
     * The retained mixed library store (host-cwd `./.devflow`).
     *
     * Kept for the compositions and tests that already own exactly one store and
     * therefore register no `sessionStores`; a call served from it states that
     * fact explicitly in {@link sessionStores}'s absence.
     */
    readonly store: DevFlowStore;
    /**
     * Per-session-workspace store resolution: the isolation this round adds.
     *
     * When present, EVERY stateful tool call resolves its store from the calling
     * session's workspace before touching any state. When absent, the caller is
     * single-store by construction and {@link store} is used.
     */
    readonly sessionStores?: DevFlowSessionStores;
    readonly workflow: TaskWorkflow;
    readonly agentWorkflow: AgentWorkflow;
    /**
     * Proof that a calling agent currently holds the Commander seat, used as the
     * registration allow-list (see {@link authorizeAgentRegistration}). Omitted
     * by a composition that installs no Commander at all, in which case NO caller
     * is authorized and the upsert tool refuses.
     */
    readonly isCommander?: (agent: Agent) => boolean;
}
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
export declare function effectiveTemporaryTools(declared: readonly string[] | undefined, callerView?: ReadonlySet<string>): readonly string[];
/** Whether one tool list declares a writing capability (the auditable half of the rule). */
export declare function declaresWriteClassTools(tools: readonly string[]): readonly string[];
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
export declare function authorizeAgentRegistration(isCommander: ((agent: Agent) => boolean) | undefined, caller: Agent | undefined): string;
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
export declare const DEVFLOW_DISPATCH_AGENT_DESCRIPTION: string;
/**
 * Register every DevFlow tool family on the calling context.
 * @param ctx - registrant context; tools register only when a tool runtime is composed.
 * @param services - store, task session resolution, and workflows the tools delegate to.
 */
export declare function registerDevFlowTools(ctx: Context, services: DevFlowToolServices): void;
