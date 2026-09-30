/**
 * Which sessions own the DevFlow capability.
 *
 * ## Why this module exists
 *
 * The `devflow_*` tool family is registered by the DevFlow HOST bundle, which the
 * profile composes for every session of every workspace. Registration is
 * therefore global: a session running the `standard` preset still SEES all
 * eighteen `devflow_*` tools and can CALL them. 2026-10-01 measured exactly that
 * (`probe-default-standard.jsonl`: `composed:"standard"` with
 * `devflowToolCount:18`), and it is the second half of the越权 the boss reported —
 * the Commander persona was preset-scoped, but the capability was not.
 *
 * The boundary has to sit at EXECUTION, for the same reason the Commander seat's
 * deny-list does (see `commander-mode.ts`): `tools.restrict()` can only mask what
 * a scope INHERITS, while a scope's own registrations stay visible
 * unconditionally. `tools.guard()` is evaluated along the caller's whole scope
 * chain, so it denies a capability wherever it was registered.
 *
 * ## Who may call what
 *
 * | caller | devflow_* |
 * |---|---|
 * | the Commander's own session (`composedPreset === 'devflow'`, depth 0) | allowed |
 * | a session composed on any other preset | **denied** |
 * | a delegated Agent — a dispatched employee or any child (`delegationDepth > 0` / `origin: 'subagent'`) | **denied** |
 * | any caller in a deployment that composes no preset service at all | allowed (nothing to scope against) |
 * | a call carrying no Agent at all | **denied** |
 *
 * The third row is 红线 3 ("员工无 `devflow_*` 工具") pinned at the execution
 * boundary: the dispatch path already restricts an employee's VISIBLE set to
 * native tools, and this rule makes the capability unreachable even if a roster
 * record were to name one.
 *
 * @module @xiaoxie-ide/dsh-devflow/capability-scope
 */
import type { Agent } from '@deepseek-ai/dsh-agent';
/** The one preset id whose sessions own the DevFlow capability. */
export declare const DEVFLOW_CAPABILITY_PRESET_ID = "devflow";
/**
 * Every model-facing tool the DevFlow host bundle registers, in registration
 * order. Kept as an explicit list (rather than derived from the live registry)
 * because this array IS the reviewed boundary: a new `devflow_*` tool that is
 * added without being listed here fails `tests/capability-scope.spec.ts`, which
 * compares it against what `registerDevFlowTools` actually registered.
 */
export declare const DEVFLOW_TOOL_NAMES: readonly string[];
/** Whether one tool name belongs to the DevFlow family. */
export declare function isDevFlowToolName(name: string): boolean;
/**
 * The part of a tool execution this module reads.
 *
 * Declared structurally, like the Commander seat's guard view, so the module
 * keeps compiling against any published `@deepseek-ai/dsh-tools` snapshot.
 */
export interface DevFlowCapabilityCall {
    /** The tool name the call names. */
    readonly name: string;
    /** The Agent on whose behalf the call runs. */
    readonly agent?: Agent;
}
/**
 * The structural shape of the host's preset service, as this module reads it.
 *
 * Only `composedPreset` is ever touched: the boundary needs to know which preset
 * an Agent's live scope is composed from, never to mount or select anything.
 */
export interface DevFlowPresetPlane {
    composedPreset?: (context: unknown) => string | undefined;
}
/**
 * Read the preset plane reachable from one Agent's context.
 *
 * Distinguishing "no preset plane" from "plane present, composition unreadable"
 * matters: a deployment that composes no preset service has no preset identity to
 * scope the family against, and the DevFlow tools must stay usable there. The
 * absence is therefore reported as `undefined` rather than collapsed into an
 * unreadable composition.
 * @param agent - the Agent whose context is being read.
 * @returns the preset service, or undefined when the deployment has none.
 */
export declare function presetPlaneOf(agent: Agent): DevFlowPresetPlane | undefined;
/**
 * Read the preset one Agent's LIVE scope chain is composed from.
 *
 * Read live on every call rather than cached: a session may switch preset while
 * it is still blank, and a cached read would keep answering for the composition
 * that is no longer mounted.
 * @param agent - the Agent whose composition is wanted.
 * @returns the preset id, or undefined when no preset service answers.
 */
export declare function liveComposedPreset(agent: Agent): string | undefined;
/**
 * Whether this Agent may reach the DevFlow capability.
 *
 * Fail-closed on every unknown NAMED caller: an unattributed call, a delegated
 * Agent, or an Agent whose live composition is not `devflow` is not a DevFlow
 * session. The one deliberate exception is a deployment that composes NO preset
 * service at all: there is no preset identity to scope against, and refusing the
 * family there would break DevFlow's own orchestration without protecting
 * anything (there is no "standard session" to leak into).
 * @param agent - the calling Agent, when the runtime supplied one.
 * @returns true only for an Agent that is a live, top-level `devflow` session.
 */
export declare function ownsDevFlowCapability(agent: Agent | undefined): boolean;
/**
 * Whether the `devflow_*` tools should be HIDDEN from this Agent's schema list.
 *
 * Deliberately weaker than {@link ownsDevFlowCapability}: hiding is an
 * optimization on top of the execution guard, so it must fail OPEN when the live
 * composition cannot be read. Hiding a live DevFlow session would break DevFlow's
 * own orchestration — the one outcome the round's criteria call a hard gate.
 * @param agent - the Agent whose model-facing surface is being scoped.
 * @returns true when the family may be removed from that surface.
 */
export declare function shouldHideDevFlowTools(agent: Agent): boolean;
/**
 * The execution guard's verdict for one call.
 *
 * Returning a string DENIES the call: the executor materializes
 * `Error: ${denialReason}` with `isError: true` before the tool body runs
 * (`@deepseek-ai/dsh-tools` `guardReason` → `execute`). The reason names the tool
 * and, when it can be read, the preset the caller actually runs, so a refusal is
 * attributable from the tool result alone.
 * @param call - the call about to run.
 * @returns the denial reason, or undefined to let non-DevFlow names through.
 */
export declare function devflowCapabilityDenialReason(call: DevFlowCapabilityCall): string | undefined;
