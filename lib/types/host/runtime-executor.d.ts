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
import type { RuntimeAdapter } from './runtime-adapter.ts';
import type { DevFlowStore } from './storage.ts';
import type { AgentReport, RuntimeResultPackage, RuntimeSession, RuntimeTaskPackage } from './types.ts';
export interface RuntimeExecutionOutcome {
    /** The runtime session that tracked the call (terminal status). */
    readonly session: RuntimeSession;
    /** The task package handed to the runtime. */
    readonly taskPackage: RuntimeTaskPackage;
    /** The result package the runtime returned; null when no result was produced. */
    readonly resultPackage: RuntimeResultPackage | null;
    /** The agent report archived from the result; null when no result was produced. */
    readonly report: AgentReport | null;
    /** The execution error message; null when the call produced a result. */
    readonly error: string | null;
}
/**
 * The DevFlow → runtime invocation orchestrator. Each execution gets exactly
 * one runtime session; the adapter call is the only external seam and the
 * only step that can fail mid-flight.
 * @param store - the storage the execution, session, and report records go through.
 * @param adapter - the replaceable runtime adapter that performs the call.
 * @param session - the session whose event log records every committed change.
 */
export declare class AgentRuntimeExecutor {
    private readonly store;
    private readonly adapter;
    constructor(store: DevFlowStore, adapter: RuntimeAdapter);
    /**
     * Execute one execution record end to end: load the record and its agent,
     * build the task package, create and drive a runtime session through the
     * adapter call, and archive the resulting report. Unknown executions and
     * agents fail loud before any session or event is created; a failed or
     * throwing adapter still settles the session and execution into `failed`.
     * @param executionId - the execution to execute.
     * @returns the settled session, package, result, and report (if any).
     */
    executeExecution(executionId: string): Promise<RuntimeExecutionOutcome>;
    /** Settle a session and its execution into `failed` when no result arrived. */
    private fail;
}
