/**
 * Runtime integration boundary: the data-conversion seam between the DevFlow
 * orchestration layer and a future Harness Runtime. Pure conversion only — no
 * runtime connection, no model/vendor binding, no execution. The v0.5 adapter
 * will implement the actual transport against the real Runtime.
 * @module @xiaoxie-ide/dsh-devflow/runtime-bridge
 */
import { randomUUID } from 'node:crypto';
/**
 * Build a runtime task package from an execution record and its agent config.
 * @param execution - the execution being exported.
 * @param agent - the registered agent that will run it.
 * @param taskDescription - the task description handed to the runtime.
 * @returns the task package for the runtime.
 */
export function buildTaskPackage(execution, agent, taskDescription, scopeGuard = execution.scopeGuard) {
    return {
        packageId: randomUUID(),
        executionId: execution.executionId,
        agentId: agent.agentId,
        taskDescription,
        tools: [...agent.tools],
        metadata: {
            batchId: execution.batchId,
            assignmentId: execution.assignmentId,
            ...(execution.taskId === undefined ? {} : { taskId: execution.taskId }),
        },
        currentDelegationDepth: agent.delegationDepth,
        ...(scopeGuard === undefined ? {} : { scopeGuard }),
        createdAt: new Date().toISOString(),
    };
}
/**
 * Extract the execution-linked facts from a runtime result package — the
 * boundary that lets the Commander map a raw result back to an execution.
 * @param result - the result package imported from the runtime.
 * @returns the normalized facts.
 */
export function resultExecutionFacts(result) {
    return { executionId: result.executionId, status: result.status, output: result.output };
}
/**
 * Build an agent report from a runtime result package and the agent that ran
 * it. The report's `outputReference` points at the imported result id (the
 * durable reference that holds the output text); the raw outcome maps
 * `success`/`failed` directly onto the report status.
 * @param result - the result package imported from the runtime.
 * @param agentId - the registered agent that produced the result.
 * @returns the agent report ready for the Commander review loop.
 */
export function buildAgentReportFromResult(result, agentId) {
    const now = new Date().toISOString();
    return {
        reportId: randomUUID(),
        executionId: result.executionId,
        agentId,
        status: result.status,
        summary: result.output,
        outputReference: result.resultId,
        ...(result.modifiedFiles === undefined ? {} : { modifiedFiles: result.modifiedFiles }),
        ...(result.toolStepCount === undefined ? {} : { toolStepCount: result.toolStepCount }),
        ...(result.completedCriteria === undefined ? {} : { completedCriteria: result.completedCriteria }),
        createdAt: now,
        updatedAt: now,
    };
}
