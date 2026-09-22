/**
 * Default fixed DevFlow employees created during project initialization.
 *
 * The dispatched employees' tool lists name the REAL runtime tools provided by
 * the `devflow` preset's capability rows (`tool-fs`, `tool-fs-search`, and the
 * platform shell row). Dispatch still filters these names against the tools the
 * runtime actually registers, so a stored list naming an unavailable tool is
 * dropped instead of aborting the child start. An earlier revision named these
 * same tools while the preset carried no capability rows at all, which is why
 * every dispatch was rejected by `tools.restrict()`.
 * @module @xiaoxie-ide/dsh-devflow/default-agents
 */
import type { DevFlowStore } from './storage.ts';
import type { OrchestrationAgent } from './types.ts';
/** Store input for one default fixed employee. */
export type DefaultAgentInput = Omit<OrchestrationAgent, 'status' | 'createdAt' | 'updatedAt'>;
/** The commander's navigation reading scope, quoted verbatim in its prompt. */
export declare const COMMANDER_NAVIGATION_SCOPE = "\u9879\u76EE\u6839\u4E0E `docs/`";
/** The commander's read-only navigation tools; a writing tool must never join this list. */
export declare const COMMANDER_READ_ONLY_TOOLS: readonly string[];
/** The architect's dispatchable output contract, quoted verbatim in its prompt. */
export declare const ARCHITECT_NAVIGATION_CONTRACT: string;
/**
 * The architect persona: responsibility boundary, navigation-artifact contract,
 * and the peer-research adoption rule. The boundary names what it may NOT do as
 * explicitly as what it may, because the two ambient temptations for this seat
 * are editing business code and dispatching other employees — neither of which
 * is this employee's job.
 */
export declare const ARCHITECT_PROMPT: string;
/**
 * The reply discipline every dispatched employee must follow.
 *
 * The DevFlow Result document is a structured handoff, but it has no field for
 * "did the work actually get done" — an employee that could not do the job
 * still produced a valid document, so the pipeline recorded `success` and the
 * blocker lived only in prose. Declaring the conclusion on the FIRST line of the
 * `## Summary` section makes it machine-readable without changing the document
 * format, and it is the ONLY source of the `outcome` field: DevFlow never infers
 * a blocker from a failure to parse one. The landing point must be that section:
 * the parser reads the declaration out of `parsed.summary`, which is exactly the
 * `## Summary` section text, so a line anywhere before the first `##` heading
 * could never be seen.
 */
export declare const EMPLOYEE_OUTCOME_DISCIPLINE: string;
/** The four default fixed employees and their approved Skill bindings. */
export declare const DEFAULT_FIXED_AGENTS: readonly DefaultAgentInput[];
/** What one reconciliation pass actually changed, for logging and reporting. */
export interface FixedAgentReconciliation {
    /** Fixed employees registered for the first time. */
    readonly added: readonly string[];
    /** Fixed employees whose stored configuration no longer matched this source. */
    readonly refreshed: readonly string[];
}
/**
 * Every tool name a fixed employee may name — the dispatched plane's known set.
 *
 * Dispatch has to answer "is this a real runtime tool?" from the host plane,
 * where the child's own composed scope is not readable. This union is that
 * answer: every name here is one a shipped employee is expected to receive. It
 * is a NAME VOCABULARY, never a permission — it grants nothing, and each
 * employee's own `tools` list stays the only thing deciding what it may use.
 */
export declare const DECLARED_EMPLOYEE_TOOL_NAMES: ReadonlySet<string>;
/**
 * The tools a temporary employee gets when `devflow_agent_upsert` declares none.
 *
 * **Fail-closed by design.** Registration used to give a temporary employee the whole
 * tool set of its role peer, so a temporary `planner` inherited the architect's
 * `[read, write, edit, glob, grep, read_image, pwsh]`. Measured in production (超级玛丽
 * 库 2026-09-20T19:27:44Z, dispatch diagnostics): a purely **read-only** research task
 * was dispatched holding `write` / `edit` / `pwsh` — the permission overflow that
 * `e37ec04` only moved (from fixed employees onto temporary sub-agents) rather than
 * removed.
 *
 * The direction of the default is the whole point: forgetting to declare must leave an
 * employee with TOO LITTLE (it reports 受阻 and the Commander notices) instead of TOO
 * MUCH (it silently rewrites the products it was only supposed to read). `pwsh` is
 * deliberately NOT in this set — a shell can write by itself, so it is a writing tool
 * here even though `code-auditor` holds it by an explicit roster decision.
 */
export declare const TEMPORARY_READ_ONLY_TOOLS: readonly string[];
/**
 * The tools that may only ever be granted by an EXPLICIT declaration.
 *
 * `str_replace_editor` is listed although this runtime no longer registers it: the list
 * is the rule ("this name is a writing capability"), and a name that is not registered
 * is trimmed later by the roster vocabulary anyway.
 */
export declare const WRITE_CLASS_TOOLS: ReadonlySet<string>;
/**
 * The tool names a dispatched child may actually be given.
 *
 * The filter exists because `tools.restrict()` rejects a name the child's scope
 * does not know, and the child's scope is the child's preset composition — not
 * its parent's view. Reading "available" off the PARENT'S view is therefore
 * wrong whenever the parent is itself restricted: the Commander masks itself
 * down to its own navigation tools, so the intersection collapsed to exactly
 * those names and every dispatched employee became read-only. The defect stayed
 * invisible while `COMMANDER_TOOL_NAMES` held no native tool, because an empty
 * intersection fell through to "no toolFilter at all".
 *
 * A name is kept when the parent can see it OR when the roster declares it,
 * i.e. "this runtime may register it for an employee".
 * @param declared - the child's own declared tool list, in order.
 * @param parentView - tool names the calling parent can currently see.
 * @param known - the roster's declared vocabulary.
 * @returns the names to hand `toolFilter.allow`.
 */
export declare function dispatchableToolNames(declared: readonly string[], parentView: ReadonlySet<string>, known?: ReadonlySet<string>): readonly string[];
/**
 * Make the store's FIXED-employee roster agree with `DEFAULT_FIXED_AGENTS`.
 *
 * The roster is seeded once, when the project is first initialized, so a store
 * that predates a new fixed employee or a corrected tool/Skill list keeps the
 * old record forever: the canvas renders the roster from `.devflow`, and
 * `devflow_assign_agent` / `devflow_dispatch_agent` validate against it, so a
 * code-only change to a fixed employee would be invisible in production. This
 * is the one place that closes that gap. It is deliberately bounded:
 *
 * - it only ever touches ids listed in `DEFAULT_FIXED_AGENTS`;
 * - a stored `temporary` employee is never redefined, even if its id collides;
 * - an unchanged record is left completely untouched (no write, no journal row);
 * - `status` and the timestamps are the store's, not this module's.
 * @param store - the DevFlow store whose roster is reconciled.
 * @returns the ids added and the ids refreshed.
 */
export declare function reconcileFixedAgents(store: DevFlowStore): Promise<FixedAgentReconciliation>;
/**
 * Reconcile the fixed-employee roster and journal only what actually changed.
 *
 * An unchanged roster writes nothing, so this stays silent on an ordinary start
 * and produces one `devflow/agent/register` audit row per real change.
 * @param store - the DevFlow store whose roster and journal are updated.
 * @returns the ids added and the ids refreshed.
 */
export declare function recordFixedRosterChanges(store: DevFlowStore): Promise<FixedAgentReconciliation>;
