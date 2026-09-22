/**
 * Runtime integration boundary: the data-conversion seam between the DevFlow
 * orchestration layer and a future Harness Runtime. Pure conversion only — no
 * runtime connection, no model/vendor binding, no execution. The v0.5 adapter
 * will implement the actual transport against the real Runtime.
 * @module @xiaoxie-ide/dsh-devflow/runtime-bridge
 */
import type { AgentReport, ExecutionRecord, OrchestrationAgent, RuntimeResultPackage, RuntimeTaskPackage, TaskScopeGuard } from './types.ts';
/**
 * Build a runtime task package from an execution record and its agent config.
 * @param execution - the execution being exported.
 * @param agent - the registered agent that will run it.
 * @param taskDescription - the task description handed to the runtime.
 * @returns the task package for the runtime.
 */
export declare function buildTaskPackage(execution: ExecutionRecord, agent: OrchestrationAgent, taskDescription: string, scopeGuard?: TaskScopeGuard | undefined): RuntimeTaskPackage;
/** Execution-linked facts recovered from a runtime result package. */
export interface RuntimeResultFacts {
    /** The execution the result answers. */
    readonly executionId: string;
    /** The raw outcome. */
    readonly status: 'success' | 'failed';
    /** The runtime output text. */
    readonly output: string;
}
/**
 * Extract the execution-linked facts from a runtime result package — the
 * boundary that lets the Commander map a raw result back to an execution.
 * @param result - the result package imported from the runtime.
 * @returns the normalized facts.
 */
export declare function resultExecutionFacts(result: RuntimeResultPackage): RuntimeResultFacts;
/**
 * Build an agent report from a runtime result package and the agent that ran
 * it. The report's `outputReference` points at the imported result id (the
 * durable reference that holds the output text); the raw outcome maps
 * `success`/`failed` directly onto the report status.
 * @param result - the result package imported from the runtime.
 * @param agentId - the registered agent that produced the result.
 * @returns the agent report ready for the Commander review loop.
 */
export declare function buildAgentReportFromResult(result: RuntimeResultPackage, agentId: string): AgentReport;
