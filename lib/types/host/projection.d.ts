/**
 * DevFlow plugin-owned read-model fold: folds `.devflow` journal records into a
 * client-facing view — project/tasks/agents plus the v0.4 orchestration
 * registry, planning state, and review failure counters. Pure replay value —
 * no live mirror; deterministic and side-effect free.
 * @module @xiaoxie-ide/dsh-devflow/projection
 */
import type { ZodType } from 'zod';
import type { AgentConfigPatch, AgentInstance, AgentReport, AgentReportUpdate, AssignmentStatus, BlockedReport, DevFlowCloseReason, CommanderAction, CommanderActionStatus, CommanderCheckpoint, CommanderCheckpointUpdate, CommanderDecision, CommanderDecisionUpdate, CommanderActionExecutionRecord, CommanderExecutionContext, CommanderMemory, CommanderMemoryUpdate, CommanderPolicy, CommanderProposal, CommanderReview, CommanderPlan, CommanderPlanUpdate, CommanderRunRecord, CommanderSchedule, CommanderScheduleUpdate, CommanderWorkflow, CommanderWorkflowExecution, CommanderWorkflowStep, DecisionAnswer, DecisionRequest, DevFlowProjectionState, DispatchDiagnostic, ExecutionAttempt, ExecutionAttemptStatus, ScopeBoundaryHit, ExecutionBatch, ExecutionBatchStatus, ExecutionRecord, ExecutionStatus, OrchestrationAgent, Phase, PhaseAssignment, RuntimeResultPackage, RuntimeSession, RuntimeSessionStatus, RuntimeTaskPackage, ResultVerdict, TemporaryAgentStatus } from './types.ts';
/** Fold one dispatch diagnostic into the latest map. */
export declare function upsertDispatchDiagnostic(diagnostics: Record<string, DispatchDiagnostic>, diagnostic: DispatchDiagnostic): Record<string, DispatchDiagnostic>;
/** Wire payload schema of the `devflow` projection (persisted-cache precondition). */
export declare const devflowProjectionSchema: ZodType<DevFlowProjectionState>;
/** Fold one imported review verdict into a task's consecutive failure count. */
export declare function foldReviewFailCount(counts: Record<string, number>, taskId: string, verdict: ResultVerdict): Record<string, number>;
/** Reset one task's consecutive review failure count. */
export declare function resetReviewFailCount(counts: Record<string, number>, taskId: string): Record<string, number>;
/** Fold one agent upsert into the instance list (replace by id, else append). */
export declare function upsertAgent(agents: readonly AgentInstance[], instance: AgentInstance): readonly AgentInstance[];
/** Fold one orchestration-agent register into the registry (replace by id). */
export declare function upsertOrchestrationAgent(agents: Record<string, OrchestrationAgent>, agent: OrchestrationAgent): Record<string, OrchestrationAgent>;
/** Fold one orchestration-agent removal out of the registry. */
export declare function removeOrchestrationAgent(agents: Record<string, OrchestrationAgent>, agentId: string): Record<string, OrchestrationAgent>;
/** Fold one orchestration-agent config patch into the registry. */
export declare function patchOrchestrationAgent(agents: Record<string, OrchestrationAgent>, agentId: string, patch: AgentConfigPatch, at: string): Record<string, OrchestrationAgent>;
/** Fold one temporary-agent lifecycle transition into the registry. */
export declare function transitionOrchestrationAgent(agents: Record<string, OrchestrationAgent>, agentId: string, to: TemporaryAgentStatus, at: string): Record<string, OrchestrationAgent>;
/** Fold one phase create/update into the phase map (replace by id). */
export declare function upsertPhase(phases: Record<string, Phase>, phase: Phase): Record<string, Phase>;
/** Fold one checkpoint create/update into the checkpoint map (replace by id). */
export declare function upsertCheckpoint(checkpoints: Record<string, CommanderCheckpoint>, checkpoint: CommanderCheckpoint): Record<string, CommanderCheckpoint>;
/** Fold one checkpoint patch into the checkpoint map. */
export declare function patchCheckpoint(checkpoints: Record<string, CommanderCheckpoint>, checkpointId: string, patch: CommanderCheckpointUpdate, at: string): Record<string, CommanderCheckpoint>;
/** Fold one assignment create/update into the assignment map (replace by id). */
export declare function upsertAssignment(assignments: Record<string, PhaseAssignment>, assignment: PhaseAssignment): Record<string, PhaseAssignment>;
/** Fold one assignment removal out of the assignment map. */
export declare function removeAssignment(assignments: Record<string, PhaseAssignment>, assignmentId: string): Record<string, PhaseAssignment>;
/**
 * Fold one assignment status change into the assignment map.
 *
 * `closed` is terminal and carries the stamp: the fold writes `closedAt` + `closeReason`
 * for it and REMOVES both on every other status, so the projection can never hold a
 * "closed" stamp on a record that is not closed.
 */
export declare function patchAssignmentStatus(assignments: Record<string, PhaseAssignment>, assignmentId: string, status: AssignmentStatus, at: string, closeReason?: DevFlowCloseReason): Record<string, PhaseAssignment>;
/** Fold one commander plan create/update into the plan map (replace by id). */
export declare function upsertCommanderPlan(plans: Record<string, CommanderPlan>, plan: CommanderPlan): Record<string, CommanderPlan>;
/** Fold one commander plan activation (status → active). */
export declare function activateCommanderPlan(plans: Record<string, CommanderPlan>, planningId: string, at: string): Record<string, CommanderPlan>;
/** Fold one commander plan patch into the plan map. */
export declare function patchCommanderPlan(plans: Record<string, CommanderPlan>, planningId: string, patch: CommanderPlanUpdate, at: string): Record<string, CommanderPlan>;
/** Fold one execution batch create/update into the batch map (replace by id). */
export declare function upsertExecutionBatch(batches: Record<string, ExecutionBatch>, batch: ExecutionBatch): Record<string, ExecutionBatch>;
/** Fold one execution batch status change into the batch map. */
export declare function transitionExecutionBatch(batches: Record<string, ExecutionBatch>, batchId: string, status: ExecutionBatchStatus, at: string): Record<string, ExecutionBatch>;
/** Fold one execution create/update into the execution map (replace by id). */
export declare function upsertExecution(executions: Record<string, ExecutionRecord>, execution: ExecutionRecord): Record<string, ExecutionRecord>;
/** Fold one execution status change into the execution map (stamps start/complete/close). */
export declare function transitionExecution(executions: Record<string, ExecutionRecord>, executionId: string, status: ExecutionStatus, at: string, closeReason?: DevFlowCloseReason): Record<string, ExecutionRecord>;
/** Fold one execution attempt create/update into the attempt map (replace by id). */
export declare function upsertExecutionAttempt(attempts: Record<string, ExecutionAttempt>, attempt: ExecutionAttempt): Record<string, ExecutionAttempt>;
/** Fold one execution attempt status change into the attempt map (stamps completion). */
export declare function transitionExecutionAttempt(attempts: Record<string, ExecutionAttempt>, attemptId: string, status: ExecutionAttemptStatus, at: string): Record<string, ExecutionAttempt>;
/** Fold one agent report create/update into the report map (replace by id). */
export declare function upsertAgentReport(reports: Record<string, AgentReport>, report: AgentReport): Record<string, AgentReport>;
/** Fold one blocked report into the blocked map (replace by id). */
export declare function upsertBlockedReport(blocked: Record<string, BlockedReport>, report: BlockedReport): Record<string, BlockedReport>;
/**
 * Every blocked report for one task, newest first.
 *
 * The dispatch breaker reads this: a task whose EMPLOYEES kept reporting the
 * same capability gap must stop being re-dispatched rather than spend another
 * turn reaching the same wall.
 * @param blocked - the blocked-report map from the projection state.
 * @param taskId - the task to filter on.
 * @returns that task's blocked reports, newest first.
 */
export declare function blockedReportsForTask(blocked: Record<string, BlockedReport>, taskId: string): readonly BlockedReport[];
/** Fold one agent report patch into the report map. */
export declare function patchAgentReport(reports: Record<string, AgentReport>, reportId: string, patch: AgentReportUpdate, at: string): Record<string, AgentReport>;
/** Fold one commander decision create/update into the decision map (replace by id). */
export declare function upsertCommanderDecision(decisions: Record<string, CommanderDecision>, decision: CommanderDecision): Record<string, CommanderDecision>;
/** Fold one commander decision patch into the decision map. */
export declare function patchCommanderDecision(decisions: Record<string, CommanderDecision>, decisionId: string, patch: CommanderDecisionUpdate, at: string): Record<string, CommanderDecision>;
/** Fold one commander control action create/update into the action map (replace by id). */
export declare function upsertCommanderAction(actions: Record<string, CommanderAction>, action: CommanderAction): Record<string, CommanderAction>;
/** Fold one commander control action status change into the action map. */
export declare function transitionCommanderAction(actions: Record<string, CommanderAction>, actionId: string, status: CommanderActionStatus, at: string): Record<string, CommanderAction>;
/** Fold one commander review create/update into the review map (replace by id). */
export declare function upsertCommanderReview(reviews: Record<string, CommanderReview>, review: CommanderReview): Record<string, CommanderReview>;
/** Fold one commander review completion (status → reviewed). */
export declare function completeCommanderReview(reviews: Record<string, CommanderReview>, reviewId: string, at: string): Record<string, CommanderReview>;
/** Fold one runtime task package export into the package map (replace by id). */
export declare function upsertRuntimePackage(packages: Record<string, RuntimeTaskPackage>, pkg: RuntimeTaskPackage): Record<string, RuntimeTaskPackage>;
/** Fold one runtime result package import into the result map (replace by id). */
export declare function upsertRuntimeResult(results: Record<string, RuntimeResultPackage>, result: RuntimeResultPackage): Record<string, RuntimeResultPackage>;
/** Fold one runtime session create/update into the session map (replace by id). */
export declare function upsertRuntimeSession(sessions: Record<string, RuntimeSession>, session: RuntimeSession): Record<string, RuntimeSession>;
/** Fold one runtime session status change into the session map (stamps start/complete). */
export declare function transitionRuntimeSession(sessions: Record<string, RuntimeSession>, sessionId: string, status: RuntimeSessionStatus, at: string): Record<string, RuntimeSession>;
/** Fold one commander memory create/update into the memory map (replace by id). */
export declare function upsertCommanderMemory(memories: Record<string, CommanderMemory>, memory: CommanderMemory): Record<string, CommanderMemory>;
/** Fold one commander memory patch into the memory map. */
export declare function patchCommanderMemory(memories: Record<string, CommanderMemory>, memoryId: string, patch: CommanderMemoryUpdate, at: string): Record<string, CommanderMemory>;
/** Fold one commander schedule create/update into the schedule map (replace by id). */
export declare function upsertCommanderSchedule(schedules: Record<string, CommanderSchedule>, schedule: CommanderSchedule): Record<string, CommanderSchedule>;
/** Fold one commander schedule patch into the schedule map (rolls the next run). */
export declare function patchCommanderSchedule(schedules: Record<string, CommanderSchedule>, scheduleId: string, patch: CommanderScheduleUpdate, at: string): Record<string, CommanderSchedule>;
/** Fold one commander schedule pause (status → paused). */
export declare function pauseCommanderSchedule(schedules: Record<string, CommanderSchedule>, scheduleId: string, at: string): Record<string, CommanderSchedule>;
/** Fold one commander run create/update into the run map (replace by id). */
export declare function upsertCommanderRun(runs: Record<string, CommanderRunRecord>, run: CommanderRunRecord): Record<string, CommanderRunRecord>;
/** Fold one commander run completion (status → completed, ids + stamp). */
export declare function completeCommanderRun(runs: Record<string, CommanderRunRecord>, runId: string, decisionId: string, actionId: string, at: string): Record<string, CommanderRunRecord>;
/** Fold one commander run failure (status → failed, stamp). */
export declare function failCommanderRun(runs: Record<string, CommanderRunRecord>, runId: string, at: string): Record<string, CommanderRunRecord>;
/** Fold one commander action execution create/update into the map (replace by id). */
export declare function upsertCommanderActionExecution(executions: Record<string, CommanderActionExecutionRecord>, execution: CommanderActionExecutionRecord): Record<string, CommanderActionExecutionRecord>;
/** Fold one commander action execution completion (status → completed, success, stamp). */
export declare function completeCommanderActionExecution(executions: Record<string, CommanderActionExecutionRecord>, executionId: string, at: string): Record<string, CommanderActionExecutionRecord>;
/** Fold one commander action execution failure (status → failed, error, stamp). */
export declare function failCommanderActionExecution(executions: Record<string, CommanderActionExecutionRecord>, executionId: string, error: string, at: string): Record<string, CommanderActionExecutionRecord>;
/** Fold one project policy create/replace into the policy map (replace by project id). */
export declare function upsertPolicy(policies: Record<string, CommanderPolicy>, policy: CommanderPolicy): Record<string, CommanderPolicy>;
/** Fold one commander proposal create/update into the proposal map (replace by id). */
export declare function upsertCommanderProposal(proposals: Record<string, CommanderProposal>, proposal: CommanderProposal): Record<string, CommanderProposal>;
/** Fold one commander proposal approval (status → approved). */
export declare function approveCommanderProposal(proposals: Record<string, CommanderProposal>, proposalId: string, at: string): Record<string, CommanderProposal>;
/** Fold one commander proposal rejection (status → rejected). */
export declare function rejectCommanderProposal(proposals: Record<string, CommanderProposal>, proposalId: string, at: string): Record<string, CommanderProposal>;
/** Fold one commander execution context generation into the map (replace by id). */
export declare function upsertCommanderExecutionContext(contexts: Record<string, CommanderExecutionContext>, context: CommanderExecutionContext): Record<string, CommanderExecutionContext>;
/** Fold one commander workflow create/update into the map (replace by id). */
export declare function upsertCommanderWorkflow(workflows: Record<string, CommanderWorkflow>, workflow: CommanderWorkflow): Record<string, CommanderWorkflow>;
/** Fold one commander workflow start (created → running, stamp). */
export declare function startCommanderWorkflow(workflows: Record<string, CommanderWorkflow>, workflowId: string, at: string): Record<string, CommanderWorkflow>;
/** Fold one commander workflow completion (running → completed, stamp). */
export declare function completeCommanderWorkflow(workflows: Record<string, CommanderWorkflow>, workflowId: string, at: string): Record<string, CommanderWorkflow>;
/** Fold one commander workflow failure (running → failed, stamp). */
export declare function failCommanderWorkflow(workflows: Record<string, CommanderWorkflow>, workflowId: string, at: string): Record<string, CommanderWorkflow>;
/** Fold one workflow history entry append (history grows, stamp). */
export declare function appendCommanderWorkflowExecution(workflows: Record<string, CommanderWorkflow>, workflowId: string, entry: CommanderWorkflowExecution, at: string): Record<string, CommanderWorkflow>;
/** Fold a Commander decision request into the request map. */
export declare function upsertDecisionRequest(requests: Record<string, DecisionRequest>, request: DecisionRequest): Record<string, DecisionRequest>;
/** Fold a pending Commander decision answer into the request map. */
export declare function answerDecisionRequest(requests: Record<string, DecisionRequest>, requestId: string, answer: DecisionAnswer, at: string): Record<string, DecisionRequest>;
/** Fold a ScopeGuard enforcement record into its append-only projection list. */
export declare function appendScopeBoundaryHit(hits: readonly ScopeBoundaryHit[], hit: ScopeBoundaryHit): readonly ScopeBoundaryHit[];
/** Fold one commander workflow step create/update into the map (replace by id). */
export declare function upsertCommanderWorkflowStep(steps: Record<string, CommanderWorkflowStep>, step: CommanderWorkflowStep): Record<string, CommanderWorkflowStep>;
/** Fold one commander workflow step start (pending → running, stamp). */
export declare function startCommanderWorkflowStep(steps: Record<string, CommanderWorkflowStep>, stepId: string, at: string): Record<string, CommanderWorkflowStep>;
/** Fold one commander workflow step completion (running → completed, stamp). */
export declare function completeCommanderWorkflowStep(steps: Record<string, CommanderWorkflowStep>, stepId: string, at: string): Record<string, CommanderWorkflowStep>;
/** Fold one commander workflow step failure (running → failed, stamp). */
export declare function failCommanderWorkflowStep(steps: Record<string, CommanderWorkflowStep>, stepId: string, at: string): Record<string, CommanderWorkflowStep>;
