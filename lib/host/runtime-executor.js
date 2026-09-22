/**
 * Agent runtime execution bridge: the DevFlow → RuntimeAdapter invocation
 * orchestration layer. One `executeExecution` run walks an ExecutionRecord
 * through agent-config lookup, task-package construction, a RuntimeSession
 * lifecycle, the adapter call, and result handling — every committed state
 * change lands in the calling session's event log. The executor speaks only
 * the store, the adapter seam, and the pure bridge conversions: it knows no
 * model, no vendor, and no Commander; the adapter knows no Commander; agents
 * never talk directly.
 * @module @xiaoxie-ide/dsh-devflow/runtime-executor
 */
import { buildAgentReportFromResult, buildTaskPackage } from "./runtime-bridge.js";
import { createScopeBoundaryHit, evaluateScopeUsage, foldScopeUsage, resolveTaskScope } from "./scope-guard.js";
import { assembleAgentPrompt } from "./skill-binding.js";
/** The outcome of one executed execution. */
import { recordDevFlowChange } from "./journal.js";
/**
 * The DevFlow → runtime invocation orchestrator. Each execution gets exactly
 * one runtime session; the adapter call is the only external seam and the
 * only step that can fail mid-flight.
 * @param store - the storage the execution, session, and report records go through.
 * @param adapter - the replaceable runtime adapter that performs the call.
 * @param session - the session whose event log records every committed change.
 */
export class AgentRuntimeExecutor {
    store;
    adapter;
    constructor(store, adapter) {
        this.store = store;
        this.adapter = adapter;
    }
    /**
     * Execute one execution record end to end: load the record and its agent,
     * build the task package, create and drive a runtime session through the
     * adapter call, and archive the resulting report. Unknown executions and
     * agents fail loud before any session or event is created; a failed or
     * throwing adapter still settles the session and execution into `failed`.
     * @param executionId - the execution to execute.
     * @returns the settled session, package, result, and report (if any).
     */
    async executeExecution(executionId) {
        const execution = await this.store.getExecutionRecord(executionId);
        if (execution === undefined) {
            throw new Error(`devflow: cannot execute unknown execution ${executionId}`);
        }
        const agent = await this.store.getAgent(execution.agentId);
        if (agent === undefined) {
            throw new Error(`devflow: cannot execute execution ${executionId}: unknown agent ${execution.agentId}`);
        }
        const defaultScope = await this.store.getScope();
        const scope = execution.scopeGuard ?? (defaultScope === undefined ? undefined : resolveTaskScope(defaultScope, undefined));
        const taskId = execution.taskId;
        const priorReports = taskId === undefined ? [] : await this.store.listReportsByTask(taskId);
        if (scope !== undefined && taskId !== undefined) {
            const priorDecisions = evaluateScopeUsage(scope, foldScopeUsage(priorReports));
            if (priorDecisions.length > 0) {
                const now = new Date().toISOString();
                for (const decision of priorDecisions) {
                    await recordDevFlowChange(this.store, 'devflow/scope/boundary-hit', { hit: createScopeBoundaryHit(taskId, decision, now) });
                }
                throw new Error(`devflow: task ${taskId} already reached its ScopeGuard`);
            }
        }
        const prompt = assembleAgentPrompt(agent, await this.store.resolveAgentSkills(agent));
        const taskPackage = buildTaskPackage(execution, agent, prompt, scope);
        // The execution start gates the whole call: an execution that cannot
        // start (already running, completed, or failed) fails loud before any
        // session or event exists.
        const running = await this.store.updateExecutionStatus(executionId, 'running');
        await recordDevFlowChange(this.store, 'devflow/execution/start', { execution: running });
        const created = await this.store.createRuntimeSession({
            executionId: execution.executionId,
            agentId: agent.agentId,
            metadata: { batchId: execution.batchId, assignmentId: execution.assignmentId },
        });
        await recordDevFlowChange(this.store, 'devflow/runtime/session/create', { session: created });
        const started = await this.store.updateRuntimeSessionStatus(created.sessionId, 'running');
        await recordDevFlowChange(this.store, 'devflow/runtime/session/start', {
            sessionId: created.sessionId,
            at: started.startedAt ?? started.updatedAt,
        });
        await recordDevFlowChange(this.store, 'devflow/runtime/export', { package: taskPackage });
        let resultPackage = null;
        let error = null;
        try {
            const response = await this.adapter.execute({ taskPackage });
            resultPackage = this.adapter.handleResult(response.resultPackage);
        }
        catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause);
        }
        if (resultPackage === null) {
            return this.fail(executionId, created.sessionId, taskPackage, error);
        }
        await recordDevFlowChange(this.store, 'devflow/runtime/import', { result: resultPackage });
        const producedReport = buildAgentReportFromResult(resultPackage, agent.agentId);
        const decisions = scope === undefined || taskId === undefined
            ? []
            : evaluateScopeUsage(scope, foldScopeUsage([...priorReports, producedReport]));
        const boundaryBlocked = decisions.length > 0;
        const report = boundaryBlocked ? { ...producedReport, status: 'blocked' } : producedReport;
        await this.store.saveReport(report);
        await recordDevFlowChange(this.store, 'devflow/agent/report/create', { report });
        if (boundaryBlocked && taskId !== undefined) {
            const now = new Date().toISOString();
            for (const decision of decisions) {
                await recordDevFlowChange(this.store, 'devflow/scope/boundary-hit', { hit: createScopeBoundaryHit(taskId, decision, now) });
            }
        }
        const success = resultPackage.status === 'success' && !boundaryBlocked;
        const settledSession = await this.store.updateRuntimeSessionStatus(created.sessionId, success ? 'completed' : 'failed');
        await recordDevFlowChange(this.store, success ? 'devflow/runtime/session/complete' : 'devflow/runtime/session/fail', { sessionId: created.sessionId, at: settledSession.completedAt ?? settledSession.updatedAt });
        const settledExecution = await this.store.updateExecutionStatus(executionId, success ? 'completed' : 'failed');
        await recordDevFlowChange(this.store, success ? 'devflow/execution/complete' : 'devflow/execution/fail', { executionId, at: settledExecution.completedAt ?? settledExecution.updatedAt });
        return { session: settledSession, taskPackage, resultPackage, report, error: null };
    }
    /** Settle a session and its execution into `failed` when no result arrived. */
    async fail(executionId, sessionId, taskPackage, error) {
        const failedSession = await this.store.updateRuntimeSessionStatus(sessionId, 'failed');
        await recordDevFlowChange(this.store, 'devflow/runtime/session/fail', {
            sessionId,
            at: failedSession.completedAt ?? failedSession.updatedAt,
        });
        const failedExecution = await this.store.updateExecutionStatus(executionId, 'failed');
        await recordDevFlowChange(this.store, 'devflow/execution/fail', {
            executionId,
            at: failedExecution.completedAt ?? failedExecution.updatedAt,
        });
        return { session: failedSession, taskPackage, resultPackage: null, report: null, error };
    }
}
