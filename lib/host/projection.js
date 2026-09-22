/**
 * DevFlow plugin-owned read-model fold: folds `.devflow` journal records into a
 * client-facing view — project/tasks/agents plus the v0.4 orchestration
 * registry, planning state, and review failure counters. Pure replay value —
 * no live mirror; deterministic and side-effect free.
 * @module @xiaoxie-ide/dsh-devflow/projection
 */
import { z as zod } from 'zod';
import { isDevFlowCloseReason } from "./types.js";
const dispatchDiagnosticSchema = zod.object({
    dispatchId: zod.string(), taskId: zod.string(), agentId: zod.string(), projectId: zod.union([zod.string(), zod.null()]),
    taskStatus: zod.enum(['created', 'planned', 'executing', 'reviewing', 'completed', 'failed', 'cancelled']),
    projectionStatus: zod.enum(['available', 'unavailable']), reviewFailCount: zod.number().int().nonnegative(),
    decisionStatus: zod.string().optional(), highRisk: zod.boolean(), assignmentId: zod.string().optional(),
    assignmentStatus: zod.enum(['assigned', 'in_progress', 'completed', 'closed']).optional(), assignmentAgentId: zod.string().optional(), assignmentPhaseId: zod.string().optional(), childDepth: zod.number().int().nonnegative().optional(),
    maxDepth: zod.number().int().nonnegative().optional(), provider: zod.string().optional(), model: zod.string().optional(),
    toolFilter: zod.array(zod.string()).optional(), runId: zod.string().optional(), stopReason: zod.string().optional(),
    errorCode: zod.string().optional(), errorMessage: zod.string().optional(), partialOutput: zod.string().optional(),
    lastToolCall: zod.string().optional(), status: zod.enum(['started', 'blocked', 'failed', 'completed']), at: zod.string(),
});
/** Fold one dispatch diagnostic into the latest map. */
export function upsertDispatchDiagnostic(diagnostics, diagnostic) {
    return { ...diagnostics, [diagnostic.dispatchId]: diagnostic };
}
const agentInstanceSchema = zod.object({
    id: zod.string(),
    role: zod.enum(['planner', 'backend-engineer', 'frontend-engineer', 'reviewer']),
    displayName: zod.string(),
    description: zod.string().optional(),
    capabilities: zod.array(zod.string()).optional(),
    metadata: zod.record(zod.string(), zod.unknown()).optional(),
    createdAt: zod.string(),
    updatedAt: zod.string(),
});
const agentModelConfigSchema = zod.object({
    model: zod.string(),
    provider: zod.string().optional(),
    baseURL: zod.string().optional(),
    apiKey: zod.string().optional(),
    temperature: zod.number().optional(),
    maxTokens: zod.number().optional(),
    options: zod.record(zod.string(), zod.unknown()).optional(),
});
const orchestrationAgentSchema = zod.object({
    agentId: zod.string(),
    kind: zod.enum(['fixed', 'temporary']),
    role: zod.enum(['planner', 'backend-engineer', 'frontend-engineer', 'reviewer']),
    status: zod.enum(['active', 'created', 'running', 'terminated']),
    prompt: zod.string(),
    modelConfig: agentModelConfigSchema,
    tools: zod.array(zod.string()),
    capabilities: zod.array(zod.string()),
    skills: zod.array(zod.string()),
    delegationDepth: zod.number().int().nonnegative(),
    createdAt: zod.string(),
    updatedAt: zod.string(),
});
const mvpPlanSchema = zod.object({
    goal: zod.string(),
    scope: zod.array(zod.string()),
    phaseIds: zod.array(zod.string()),
    createdAt: zod.string(),
    updatedAt: zod.string(),
});
const phaseSchema = zod.object({
    id: zod.string(),
    name: zod.string(),
    description: zod.string(),
    status: zod.enum(['planned', 'in_progress', 'completed']),
    createdAt: zod.string(),
    updatedAt: zod.string(),
});
const scopeGuardSchema = zod.object({
    summary: zod.string(),
    inScope: zod.array(zod.string()),
    maxModifiedFiles: zod.number().int().positive(),
    maxToolSteps: zod.number().int().positive(),
    completionCriteria: zod.array(zod.string()).min(1),
    createdAt: zod.string(),
    updatedAt: zod.string(),
});
const improvementSchema = zod.object({
    id: zod.string(),
    title: zod.string(),
    description: zod.string(),
    createdAt: zod.string(),
});
const commanderCheckpointSchema = zod.object({
    checkpointId: zod.string(),
    projectId: zod.string(),
    currentMvp: zod.union([zod.string(), zod.null()]),
    currentIteration: zod.union([zod.string(), zod.null()]),
    currentPhase: zod.union([zod.string(), zod.null()]),
    currentTask: zod.union([zod.string(), zod.null()]),
    completedItems: zod.array(zod.string()),
    decisions: zod.array(zod.string()),
    nextSteps: zod.array(zod.string()),
    createdAt: zod.string(),
    updatedAt: zod.string(),
});
const phaseAssignmentSchema = zod.object({
    assignmentId: zod.string(),
    taskId: zod.string().optional(),
    phaseId: zod.string(),
    agentId: zod.string(),
    role: zod.enum(['planner', 'backend-engineer', 'frontend-engineer', 'reviewer']),
    status: zod.enum(['assigned', 'in_progress', 'completed']),
    createdAt: zod.string(),
    updatedAt: zod.string(),
});
const commanderPlanSchema = zod.object({
    planningId: zod.string(),
    projectId: zod.string(),
    goal: zod.string(),
    status: zod.enum(['draft', 'active', 'completed']),
    mvpPlanId: zod.union([zod.string(), zod.null()]),
    createdAt: zod.string(),
    updatedAt: zod.string(),
});
const executionBatchSchema = zod.object({
    batchId: zod.string(),
    projectId: zod.string(),
    planningId: zod.string(),
    phaseIds: zod.array(zod.string()),
    assignmentIds: zod.array(zod.string()),
    status: zod.enum(['planned', 'running', 'paused', 'completed']),
    createdAt: zod.string(),
    updatedAt: zod.string(),
});
const executionRecordSchema = zod.object({
    executionId: zod.string(),
    batchId: zod.string(),
    assignmentId: zod.string(),
    agentId: zod.string(),
    taskId: zod.string().optional(),
    scopeGuard: zod.object({
        maxModifiedFiles: zod.number().int().positive(),
        maxToolSteps: zod.number().int().positive(),
        completionCriteria: zod.array(zod.string()).min(1),
    }).optional(),
    status: zod.enum(['pending', 'running', 'completed', 'failed']),
    startedAt: zod.union([zod.string(), zod.null()]),
    completedAt: zod.union([zod.string(), zod.null()]),
    createdAt: zod.string(),
    updatedAt: zod.string(),
});
const executionAttemptSchema = zod.object({
    attemptId: zod.string(),
    executionId: zod.string(),
    parentAttemptId: zod.union([zod.string(), zod.null()]),
    status: zod.enum(['created', 'running', 'completed', 'failed']),
    reason: zod.union([zod.string(), zod.null()]),
    createdAt: zod.string(),
    completedAt: zod.union([zod.string(), zod.null()]),
    updatedAt: zod.string(),
});
const agentReportSchema = zod.object({
    reportId: zod.string(),
    executionId: zod.string(),
    agentId: zod.string(),
    status: zod.enum(['success', 'failed', 'blocked']),
    summary: zod.string(),
    outputReference: zod.string(),
    outcome: zod.enum(['delivered', 'blocked', 'failed', 'unknown']).optional(),
    modifiedFiles: zod.array(zod.string()).optional(),
    toolStepCount: zod.number().int().nonnegative().optional(),
    completedCriteria: zod.array(zod.string()).optional(),
    createdAt: zod.string(),
    updatedAt: zod.string(),
});
const blockedReportSchema = zod.object({
    blockedId: zod.string(),
    taskId: zod.string(),
    agentId: zod.string(),
    executionId: zod.string().optional(),
    sessionId: zod.string().optional(),
    gapKind: zod.enum(['tool', 'permission', 'dependency', 'unstated']),
    missing: zod.string(),
    suggestedOwner: zod.string(),
    reason: zod.string(),
    createdAt: zod.string(),
});
const commanderDecisionSchema = zod.object({
    decisionId: zod.string(),
    projectId: zod.string(),
    checkpointId: zod.union([zod.string(), zod.null()]),
    relatedExecutionIds: zod.array(zod.string()),
    decisionType: zod.enum(['continue', 'retry', 'pause', 'request_user']),
    summary: zod.string(),
    nextAction: zod.string(),
    createdAt: zod.string(),
    updatedAt: zod.string(),
});
const commanderActionSchema = zod.object({
    actionId: zod.string(),
    decisionId: zod.string(),
    actionType: zod.enum(['start_batch', 'pause_batch', 'retry_execution', 'complete_batch']),
    targetId: zod.string(),
    status: zod.enum(['created', 'executing', 'completed']),
    createdAt: zod.string(),
    updatedAt: zod.string(),
});
const commanderReviewSchema = zod.object({
    reviewId: zod.string(),
    projectId: zod.string(),
    reportId: zod.string(),
    executionId: zod.string(),
    status: zod.enum(['pending', 'reviewed']),
    summary: zod.string(),
    createdAt: zod.string(),
    updatedAt: zod.string(),
});
const runtimeTaskPackageSchema = zod.object({
    packageId: zod.string(),
    executionId: zod.string(),
    agentId: zod.string(),
    taskDescription: zod.string(),
    tools: zod.array(zod.string()),
    metadata: zod.record(zod.string(), zod.unknown()),
    currentDelegationDepth: zod.number().int().nonnegative().default(0),
    scopeGuard: zod.object({
        maxModifiedFiles: zod.number().int().positive(),
        maxToolSteps: zod.number().int().positive(),
        completionCriteria: zod.array(zod.string()).min(1),
    }).optional(),
    createdAt: zod.string(),
});
const runtimeResultPackageSchema = zod.object({
    resultId: zod.string(),
    executionId: zod.string(),
    status: zod.enum(['success', 'failed']),
    output: zod.string(),
    metadata: zod.record(zod.string(), zod.unknown()),
    modifiedFiles: zod.array(zod.string()).optional(),
    toolStepCount: zod.number().int().nonnegative().optional(),
    completedCriteria: zod.array(zod.string()).optional(),
    createdAt: zod.string(),
});
const decisionRequestSchema = zod.object({
    requestId: zod.string(),
    projectId: zod.string(),
    taskId: zod.union([zod.string(), zod.null()]),
    trigger: zod.enum(['ambiguity', 'approach-divergence', 'scope-creep', 'review-failed-twice', 'high-risk-operation', 'granularity', 'development-order']),
    question: zod.string(),
    options: zod.array(zod.object({ id: zod.string(), label: zod.string(), description: zod.string(), recommended: zod.boolean() })),
    allowCustom: zod.boolean(),
    status: zod.enum(['pending', 'answered', 'dismissed']),
    answer: zod.union([zod.object({ optionId: zod.string() }), zod.object({ custom: zod.string() }), zod.null()]),
    createdAt: zod.string(),
    answeredAt: zod.union([zod.string(), zod.null()]),
});
const scopeBoundaryHitSchema = zod.object({
    taskId: zod.string(),
    boundary: zod.enum(['modified_files', 'tool_steps', 'completion_criteria']),
    currentValue: zod.number().int().nonnegative(),
    limit: zod.number().int().positive(),
    at: zod.string(),
});
const runtimeSessionSchema = zod.object({
    sessionId: zod.string(),
    executionId: zod.string(),
    agentId: zod.string(),
    status: zod.enum(['created', 'running', 'completed', 'failed']),
    startedAt: zod.union([zod.string(), zod.null()]),
    completedAt: zod.union([zod.string(), zod.null()]),
    metadata: zod.record(zod.string(), zod.unknown()),
    createdAt: zod.string(),
    updatedAt: zod.string(),
});
const commanderMemorySchema = zod.object({
    memoryId: zod.string(),
    projectId: zod.string(),
    memoryType: zod.enum(['project', 'decision', 'execution', 'preference']),
    content: zod.string(),
    source: zod.string(),
    createdAt: zod.string(),
    updatedAt: zod.string(),
});
const commanderScheduleSchema = zod.object({
    scheduleId: zod.string(),
    projectId: zod.string(),
    status: zod.enum(['active', 'paused']),
    interval: zod.number(),
    lastRunAt: zod.union([zod.string(), zod.null()]),
    nextRunAt: zod.string(),
    createdAt: zod.string(),
    updatedAt: zod.string(),
});
const commanderRunSchema = zod.object({
    runId: zod.string(),
    projectId: zod.string(),
    scheduleId: zod.string(),
    status: zod.enum(['running', 'completed', 'failed']),
    decisionId: zod.union([zod.string(), zod.null()]),
    actionId: zod.union([zod.string(), zod.null()]),
    startedAt: zod.string(),
    completedAt: zod.union([zod.string(), zod.null()]),
    updatedAt: zod.string(),
});
const commanderActionExecutionSchema = zod.object({
    executionId: zod.string(),
    actionId: zod.string(),
    status: zod.enum(['running', 'completed', 'failed']),
    success: zod.union([zod.boolean(), zod.null()]),
    error: zod.union([zod.string(), zod.null()]),
    createdAt: zod.string(),
    completedAt: zod.union([zod.string(), zod.null()]),
    updatedAt: zod.string(),
});
const commanderPolicySchema = zod.object({
    projectId: zod.string(),
    maxRetryCount: zod.number(),
    allowedActionTypes: zod.array(zod.enum(['start_batch', 'pause_batch', 'retry_execution', 'complete_batch'])),
    requireApprovalActionTypes: zod.array(zod.enum(['start_batch', 'pause_batch', 'retry_execution', 'complete_batch'])),
    riskLevel: zod.enum(['low', 'medium', 'high']),
    createdAt: zod.string(),
    updatedAt: zod.string(),
});
const commanderProposalSchema = zod.object({
    proposalId: zod.string(),
    decisionId: zod.string(),
    actionType: zod.enum(['start_batch', 'pause_batch', 'retry_execution', 'complete_batch']),
    targetId: zod.string(),
    riskLevel: zod.enum(['low', 'medium', 'high']),
    status: zod.enum(['created', 'approved', 'rejected']),
    createdAt: zod.string(),
    updatedAt: zod.string(),
});
const commanderExecutionContextSchema = zod.object({
    contextId: zod.string(),
    executionId: zod.string(),
    decisionId: zod.string(),
    proposalId: zod.string(),
    actionType: zod.enum(['start_batch', 'pause_batch', 'retry_execution', 'complete_batch']),
    targetId: zod.string(),
    riskLevel: zod.enum(['low', 'medium', 'high']),
    metadata: zod.record(zod.string(), zod.unknown()),
    createdAt: zod.string(),
});
const commanderWorkflowExecutionResultSchema = zod.object({
    success: zod.boolean(),
    error: zod.union([zod.string(), zod.null()]),
});
const commanderWorkflowExecutionSchema = zod.object({
    entryId: zod.string(),
    stepId: zod.union([zod.string(), zod.null()]),
    decisionId: zod.string(),
    proposalId: zod.union([zod.string(), zod.null()]),
    approved: zod.boolean(),
    contextId: zod.union([zod.string(), zod.null()]),
    actionExecutionId: zod.union([zod.string(), zod.null()]),
    result: zod.union([commanderWorkflowExecutionResultSchema, zod.null()]),
    feedbackId: zod.union([zod.string(), zod.null()]),
    createdAt: zod.string(),
});
const commanderWorkflowSchema = zod.object({
    workflowId: zod.string(),
    projectId: zod.string(),
    title: zod.string(),
    description: zod.string(),
    status: zod.enum(['created', 'running', 'completed', 'failed']),
    history: zod.array(commanderWorkflowExecutionSchema),
    createdAt: zod.string(),
    updatedAt: zod.string(),
});
const commanderWorkflowStepSchema = zod.object({
    stepId: zod.string(),
    workflowId: zod.string(),
    stepIndex: zod.number(),
    title: zod.string(),
    status: zod.enum(['pending', 'running', 'completed', 'failed']),
    createdAt: zod.string(),
    updatedAt: zod.string(),
});
/** Wire payload schema of the `devflow` projection (persisted-cache precondition). */
// The zod optional fields widen to `T | undefined` under exactOptionalPropertyTypes;
// the runtime parse output matches DevFlowProjectionState, so the annotation is
// asserted rather than structurally derived.
export const devflowProjectionSchema = zod.object({
    project: zod.union([
        zod.object({
            id: zod.string(),
            name: zod.string(),
            goal: zod.string(),
            currentStage: zod.string(),
            createdAt: zod.string(),
            updatedAt: zod.string(),
        }),
        zod.null(),
    ]),
    tasks: zod.record(zod.string(), zod.enum(['created', 'planned', 'executing', 'reviewing', 'completed', 'failed', 'cancelled'])),
    taskTitles: zod.record(zod.string(), zod.string()).optional(),
    agents: zod.array(agentInstanceSchema),
    orchestrationAgents: zod.record(zod.string(), orchestrationAgentSchema),
    plan: zod.union([mvpPlanSchema, zod.null()]),
    phases: zod.record(zod.string(), phaseSchema),
    scope: zod.union([scopeGuardSchema, zod.null()]),
    improvements: zod.array(improvementSchema),
    commanderCheckpoints: zod.record(zod.string(), commanderCheckpointSchema),
    assignments: zod.record(zod.string(), phaseAssignmentSchema),
    commanderPlans: zod.record(zod.string(), commanderPlanSchema),
    executionBatches: zod.record(zod.string(), executionBatchSchema),
    executions: zod.record(zod.string(), executionRecordSchema),
    executionAttempts: zod.record(zod.string(), executionAttemptSchema),
    agentReports: zod.record(zod.string(), agentReportSchema),
    blockedReports: zod.record(zod.string(), blockedReportSchema).optional(),
    commanderDecisions: zod.record(zod.string(), commanderDecisionSchema),
    commanderActions: zod.record(zod.string(), commanderActionSchema),
    commanderReviews: zod.record(zod.string(), commanderReviewSchema),
    runtimePackages: zod.record(zod.string(), runtimeTaskPackageSchema),
    runtimeResults: zod.record(zod.string(), runtimeResultPackageSchema),
    runtimeSessions: zod.record(zod.string(), runtimeSessionSchema),
    commanderMemory: zod.record(zod.string(), commanderMemorySchema),
    commanderSchedules: zod.record(zod.string(), commanderScheduleSchema),
    commanderRuns: zod.record(zod.string(), commanderRunSchema),
    commanderActionExecutions: zod.record(zod.string(), commanderActionExecutionSchema),
    policies: zod.record(zod.string(), commanderPolicySchema),
    commanderProposals: zod.record(zod.string(), commanderProposalSchema),
    commanderExecutionContexts: zod.record(zod.string(), commanderExecutionContextSchema),
    commanderWorkflows: zod.record(zod.string(), commanderWorkflowSchema),
    commanderWorkflowSteps: zod.record(zod.string(), commanderWorkflowStepSchema),
    scopeBoundaryHits: zod.array(scopeBoundaryHitSchema),
    decisionRequests: zod.record(zod.string(), decisionRequestSchema),
    dispatchDiagnostics: zod.record(zod.string(), dispatchDiagnosticSchema).optional(),
    reviewFailCounts: zod.record(zod.string(), zod.number().int().nonnegative()),
    commanderMode: zod.enum(['chat', 'commander']),
    commanderModeExitAt: zod.string().optional(),
    paused: zod.boolean(),
});
/** Fold one imported review verdict into a task's consecutive failure count. */
export function foldReviewFailCount(counts, taskId, verdict) {
    if (verdict === 'accepted')
        return resetReviewFailCount(counts, taskId);
    return { ...counts, [taskId]: (counts[taskId] ?? 0) + 1 };
}
/** Reset one task's consecutive review failure count. */
export function resetReviewFailCount(counts, taskId) {
    if (counts[taskId] === undefined)
        return counts;
    const { [taskId]: _reset, ...remaining } = counts;
    return remaining;
}
/** Fold one agent upsert into the instance list (replace by id, else append). */
export function upsertAgent(agents, instance) {
    const index = agents.findIndex(existing => existing.id === instance.id);
    if (index < 0)
        return [...agents, instance];
    return [...agents.slice(0, index), instance, ...agents.slice(index + 1)];
}
/** Fold one orchestration-agent register into the registry (replace by id). */
export function upsertOrchestrationAgent(agents, agent) {
    return { ...agents, [agent.agentId]: agent };
}
/** Fold one orchestration-agent removal out of the registry. */
export function removeOrchestrationAgent(agents, agentId) {
    const { [agentId]: _removed, ...rest } = agents;
    return rest;
}
/** Fold one orchestration-agent config patch into the registry. */
export function patchOrchestrationAgent(agents, agentId, patch, at) {
    const existing = agents[agentId];
    if (existing === undefined)
        return agents;
    const updated = {
        ...existing,
        role: patch.role ?? existing.role,
        prompt: patch.prompt ?? existing.prompt,
        modelConfig: patch.modelConfig === undefined ? existing.modelConfig : { ...existing.modelConfig, ...patch.modelConfig },
        tools: patch.tools ?? existing.tools,
        capabilities: patch.capabilities ?? existing.capabilities,
        skills: patch.skills ?? existing.skills,
        delegationDepth: patch.delegationDepth ?? existing.delegationDepth,
        updatedAt: at,
    };
    return { ...agents, [agentId]: updated };
}
/** Fold one temporary-agent lifecycle transition into the registry. */
export function transitionOrchestrationAgent(agents, agentId, to, at) {
    const existing = agents[agentId];
    if (existing === undefined)
        return agents;
    return { ...agents, [agentId]: { ...existing, status: to, updatedAt: at } };
}
/** Fold one phase create/update into the phase map (replace by id). */
export function upsertPhase(phases, phase) {
    return { ...phases, [phase.id]: phase };
}
/** Fold one checkpoint create/update into the checkpoint map (replace by id). */
export function upsertCheckpoint(checkpoints, checkpoint) {
    return { ...checkpoints, [checkpoint.checkpointId]: checkpoint };
}
/** Fold one checkpoint patch into the checkpoint map. */
export function patchCheckpoint(checkpoints, checkpointId, patch, at) {
    const existing = checkpoints[checkpointId];
    if (existing === undefined)
        return checkpoints;
    const updated = {
        ...existing,
        ...(patch.currentMvp !== undefined ? { currentMvp: patch.currentMvp } : {}),
        ...(patch.currentIteration !== undefined ? { currentIteration: patch.currentIteration } : {}),
        ...(patch.currentPhase !== undefined ? { currentPhase: patch.currentPhase } : {}),
        ...(patch.currentTask !== undefined ? { currentTask: patch.currentTask } : {}),
        ...(patch.completedItems !== undefined ? { completedItems: patch.completedItems } : {}),
        ...(patch.decisions !== undefined ? { decisions: patch.decisions } : {}),
        ...(patch.nextSteps !== undefined ? { nextSteps: patch.nextSteps } : {}),
        updatedAt: at,
    };
    return { ...checkpoints, [checkpointId]: updated };
}
/** Fold one assignment create/update into the assignment map (replace by id). */
export function upsertAssignment(assignments, assignment) {
    return { ...assignments, [assignment.assignmentId]: assignment };
}
/** Fold one assignment removal out of the assignment map. */
export function removeAssignment(assignments, assignmentId) {
    const { [assignmentId]: _removed, ...rest } = assignments;
    return rest;
}
/**
 * Fold one assignment status change into the assignment map.
 *
 * `closed` is terminal and carries the stamp: the fold writes `closedAt` + `closeReason`
 * for it and REMOVES both on every other status, so the projection can never hold a
 * "closed" stamp on a record that is not closed.
 */
export function patchAssignmentStatus(assignments, assignmentId, status, at, closeReason) {
    const existing = assignments[assignmentId];
    if (existing === undefined)
        return assignments;
    const { closedAt: _closedAt, closeReason: _closeReason, ...rest } = existing;
    const next = {
        ...rest,
        status,
        ...(status === 'closed' && isDevFlowCloseReason(closeReason) ? { closedAt: at, closeReason } : {}),
        updatedAt: at,
    };
    return { ...assignments, [assignmentId]: next };
}
/** Fold one commander plan create/update into the plan map (replace by id). */
export function upsertCommanderPlan(plans, plan) {
    return { ...plans, [plan.planningId]: plan };
}
/** Fold one commander plan activation (status → active). */
export function activateCommanderPlan(plans, planningId, at) {
    const existing = plans[planningId];
    if (existing === undefined)
        return plans;
    return { ...plans, [planningId]: { ...existing, status: 'active', updatedAt: at } };
}
/** Fold one commander plan patch into the plan map. */
export function patchCommanderPlan(plans, planningId, patch, at) {
    const existing = plans[planningId];
    if (existing === undefined)
        return plans;
    const updated = {
        ...existing,
        ...(patch.goal !== undefined ? { goal: patch.goal } : {}),
        ...(patch.mvpPlanId !== undefined ? { mvpPlanId: patch.mvpPlanId } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        updatedAt: at,
    };
    return { ...plans, [planningId]: updated };
}
/** Fold one execution batch create/update into the batch map (replace by id). */
export function upsertExecutionBatch(batches, batch) {
    return { ...batches, [batch.batchId]: batch };
}
/** Fold one execution batch status change into the batch map. */
export function transitionExecutionBatch(batches, batchId, status, at) {
    const existing = batches[batchId];
    if (existing === undefined)
        return batches;
    return { ...batches, [batchId]: { ...existing, status, updatedAt: at } };
}
/** Fold one execution create/update into the execution map (replace by id). */
export function upsertExecution(executions, execution) {
    return { ...executions, [execution.executionId]: execution };
}
/** Fold one execution status change into the execution map (stamps start/complete/close). */
export function transitionExecution(executions, executionId, status, at, closeReason) {
    const existing = executions[executionId];
    if (existing === undefined)
        return executions;
    const { closedAt: _closedAt, closeReason: _closeReason, ...rest } = existing;
    const updated = {
        ...rest,
        status,
        ...(status === 'running' && existing.startedAt === null ? { startedAt: at } : {}),
        ...((status === 'completed' || status === 'failed') && existing.completedAt === null ? { completedAt: at } : {}),
        ...(status === 'closed' && isDevFlowCloseReason(closeReason) ? { closedAt: at, closeReason } : {}),
        updatedAt: at,
    };
    return { ...executions, [executionId]: updated };
}
/** Fold one execution attempt create/update into the attempt map (replace by id). */
export function upsertExecutionAttempt(attempts, attempt) {
    return { ...attempts, [attempt.attemptId]: attempt };
}
/** Fold one execution attempt status change into the attempt map (stamps completion). */
export function transitionExecutionAttempt(attempts, attemptId, status, at) {
    const existing = attempts[attemptId];
    if (existing === undefined)
        return attempts;
    const updated = {
        ...existing,
        status,
        ...((status === 'completed' || status === 'failed') && existing.completedAt === null ? { completedAt: at } : {}),
        updatedAt: at,
    };
    return { ...attempts, [attemptId]: updated };
}
/** Fold one agent report create/update into the report map (replace by id). */
export function upsertAgentReport(reports, report) {
    return { ...reports, [report.reportId]: report };
}
/** Fold one blocked report into the blocked map (replace by id). */
export function upsertBlockedReport(blocked, report) {
    return { ...blocked, [report.blockedId]: report };
}
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
export function blockedReportsForTask(blocked, taskId) {
    return Object.values(blocked)
        .filter(item => item.taskId === taskId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}
/** Fold one agent report patch into the report map. */
export function patchAgentReport(reports, reportId, patch, at) {
    const existing = reports[reportId];
    if (existing === undefined)
        return reports;
    const updated = {
        ...existing,
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
        ...(patch.outputReference !== undefined ? { outputReference: patch.outputReference } : {}),
        ...(patch.outcome !== undefined ? { outcome: patch.outcome } : {}),
        updatedAt: at,
    };
    return { ...reports, [reportId]: updated };
}
/** Fold one commander decision create/update into the decision map (replace by id). */
export function upsertCommanderDecision(decisions, decision) {
    return { ...decisions, [decision.decisionId]: decision };
}
/** Fold one commander decision patch into the decision map. */
export function patchCommanderDecision(decisions, decisionId, patch, at) {
    const existing = decisions[decisionId];
    if (existing === undefined)
        return decisions;
    const updated = {
        ...existing,
        ...(patch.checkpointId !== undefined ? { checkpointId: patch.checkpointId } : {}),
        ...(patch.relatedExecutionIds !== undefined ? { relatedExecutionIds: patch.relatedExecutionIds } : {}),
        ...(patch.decisionType !== undefined ? { decisionType: patch.decisionType } : {}),
        ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
        ...(patch.nextAction !== undefined ? { nextAction: patch.nextAction } : {}),
        updatedAt: at,
    };
    return { ...decisions, [decisionId]: updated };
}
/** Fold one commander control action create/update into the action map (replace by id). */
export function upsertCommanderAction(actions, action) {
    return { ...actions, [action.actionId]: action };
}
/** Fold one commander control action status change into the action map. */
export function transitionCommanderAction(actions, actionId, status, at) {
    const existing = actions[actionId];
    if (existing === undefined)
        return actions;
    return { ...actions, [actionId]: { ...existing, status, updatedAt: at } };
}
/** Fold one commander review create/update into the review map (replace by id). */
export function upsertCommanderReview(reviews, review) {
    return { ...reviews, [review.reviewId]: review };
}
/** Fold one commander review completion (status → reviewed). */
export function completeCommanderReview(reviews, reviewId, at) {
    const existing = reviews[reviewId];
    if (existing === undefined)
        return reviews;
    return { ...reviews, [reviewId]: { ...existing, status: 'reviewed', updatedAt: at } };
}
/** Fold one runtime task package export into the package map (replace by id). */
export function upsertRuntimePackage(packages, pkg) {
    return { ...packages, [pkg.packageId]: pkg };
}
/** Fold one runtime result package import into the result map (replace by id). */
export function upsertRuntimeResult(results, result) {
    return { ...results, [result.resultId]: result };
}
/** Fold one runtime session create/update into the session map (replace by id). */
export function upsertRuntimeSession(sessions, session) {
    return { ...sessions, [session.sessionId]: session };
}
/** Fold one runtime session status change into the session map (stamps start/complete). */
export function transitionRuntimeSession(sessions, sessionId, status, at) {
    const existing = sessions[sessionId];
    if (existing === undefined)
        return sessions;
    const updated = {
        ...existing,
        status,
        ...(status === 'running' && existing.startedAt === null ? { startedAt: at } : {}),
        ...((status === 'completed' || status === 'failed') && existing.completedAt === null ? { completedAt: at } : {}),
        updatedAt: at,
    };
    return { ...sessions, [sessionId]: updated };
}
/** Fold one commander memory create/update into the memory map (replace by id). */
export function upsertCommanderMemory(memories, memory) {
    return { ...memories, [memory.memoryId]: memory };
}
/** Fold one commander memory patch into the memory map. */
export function patchCommanderMemory(memories, memoryId, patch, at) {
    const existing = memories[memoryId];
    if (existing === undefined)
        return memories;
    const updated = {
        ...existing,
        ...(patch.content !== undefined ? { content: patch.content } : {}),
        ...(patch.source !== undefined ? { source: patch.source } : {}),
        updatedAt: at,
    };
    return { ...memories, [memoryId]: updated };
}
/** Fold one commander schedule create/update into the schedule map (replace by id). */
export function upsertCommanderSchedule(schedules, schedule) {
    return { ...schedules, [schedule.scheduleId]: schedule };
}
/** Fold one commander schedule patch into the schedule map (rolls the next run). */
export function patchCommanderSchedule(schedules, scheduleId, patch, at) {
    const existing = schedules[scheduleId];
    if (existing === undefined)
        return schedules;
    const interval = patch.interval ?? existing.interval;
    const lastRunAt = patch.markRunAt !== undefined ? patch.markRunAt : existing.lastRunAt;
    const rollBase = patch.markRunAt !== undefined ? patch.markRunAt : (lastRunAt ?? at);
    const nextRunAt = (patch.interval !== undefined || patch.markRunAt !== undefined)
        ? new Date(Date.parse(rollBase) + interval).toISOString()
        : existing.nextRunAt;
    return { ...schedules, [scheduleId]: { ...existing, interval, lastRunAt, nextRunAt, updatedAt: at } };
}
/** Fold one commander schedule pause (status → paused). */
export function pauseCommanderSchedule(schedules, scheduleId, at) {
    const existing = schedules[scheduleId];
    if (existing === undefined)
        return schedules;
    return { ...schedules, [scheduleId]: { ...existing, status: 'paused', updatedAt: at } };
}
/** Fold one commander run create/update into the run map (replace by id). */
export function upsertCommanderRun(runs, run) {
    return { ...runs, [run.runId]: run };
}
/** Fold one commander run completion (status → completed, ids + stamp). */
export function completeCommanderRun(runs, runId, decisionId, actionId, at) {
    const existing = runs[runId];
    if (existing === undefined)
        return runs;
    return { ...runs, [runId]: { ...existing, status: 'completed', decisionId, actionId, completedAt: at, updatedAt: at } };
}
/** Fold one commander run failure (status → failed, stamp). */
export function failCommanderRun(runs, runId, at) {
    const existing = runs[runId];
    if (existing === undefined)
        return runs;
    return { ...runs, [runId]: { ...existing, status: 'failed', completedAt: at, updatedAt: at } };
}
/** Fold one commander action execution create/update into the map (replace by id). */
export function upsertCommanderActionExecution(executions, execution) {
    return { ...executions, [execution.executionId]: execution };
}
/** Fold one commander action execution completion (status → completed, success, stamp). */
export function completeCommanderActionExecution(executions, executionId, at) {
    const existing = executions[executionId];
    if (existing === undefined)
        return executions;
    return { ...executions, [executionId]: { ...existing, status: 'completed', success: true, completedAt: at, updatedAt: at } };
}
/** Fold one commander action execution failure (status → failed, error, stamp). */
export function failCommanderActionExecution(executions, executionId, error, at) {
    const existing = executions[executionId];
    if (existing === undefined)
        return executions;
    return {
        ...executions,
        [executionId]: { ...existing, status: 'failed', success: false, error, completedAt: at, updatedAt: at },
    };
}
/** Fold one project policy create/replace into the policy map (replace by project id). */
export function upsertPolicy(policies, policy) {
    return { ...policies, [policy.projectId]: policy };
}
/** Fold one commander proposal create/update into the proposal map (replace by id). */
export function upsertCommanderProposal(proposals, proposal) {
    return { ...proposals, [proposal.proposalId]: proposal };
}
/** Fold one commander proposal approval (status → approved). */
export function approveCommanderProposal(proposals, proposalId, at) {
    const existing = proposals[proposalId];
    if (existing === undefined)
        return proposals;
    return { ...proposals, [proposalId]: { ...existing, status: 'approved', updatedAt: at } };
}
/** Fold one commander proposal rejection (status → rejected). */
export function rejectCommanderProposal(proposals, proposalId, at) {
    const existing = proposals[proposalId];
    if (existing === undefined)
        return proposals;
    return { ...proposals, [proposalId]: { ...existing, status: 'rejected', updatedAt: at } };
}
/** Fold one commander execution context generation into the map (replace by id). */
export function upsertCommanderExecutionContext(contexts, context) {
    return { ...contexts, [context.contextId]: context };
}
/** Fold one commander workflow create/update into the map (replace by id). */
export function upsertCommanderWorkflow(workflows, workflow) {
    return { ...workflows, [workflow.workflowId]: workflow };
}
/** Fold one commander workflow start (created → running, stamp). */
export function startCommanderWorkflow(workflows, workflowId, at) {
    const existing = workflows[workflowId];
    if (existing === undefined)
        return workflows;
    return { ...workflows, [workflowId]: { ...existing, status: 'running', updatedAt: at } };
}
/** Fold one commander workflow completion (running → completed, stamp). */
export function completeCommanderWorkflow(workflows, workflowId, at) {
    const existing = workflows[workflowId];
    if (existing === undefined)
        return workflows;
    return { ...workflows, [workflowId]: { ...existing, status: 'completed', updatedAt: at } };
}
/** Fold one commander workflow failure (running → failed, stamp). */
export function failCommanderWorkflow(workflows, workflowId, at) {
    const existing = workflows[workflowId];
    if (existing === undefined)
        return workflows;
    return { ...workflows, [workflowId]: { ...existing, status: 'failed', updatedAt: at } };
}
/** Fold one workflow history entry append (history grows, stamp). */
export function appendCommanderWorkflowExecution(workflows, workflowId, entry, at) {
    const existing = workflows[workflowId];
    if (existing === undefined)
        return workflows;
    return { ...workflows, [workflowId]: { ...existing, history: [...existing.history, entry], updatedAt: at } };
}
/** Fold a Commander decision request into the request map. */
export function upsertDecisionRequest(requests, request) {
    return { ...requests, [request.requestId]: request };
}
/** Fold a pending Commander decision answer into the request map. */
export function answerDecisionRequest(requests, requestId, answer, at) {
    const request = requests[requestId];
    if (request === undefined || request.status !== 'pending')
        return requests;
    return { ...requests, [requestId]: { ...request, status: 'answered', answer, answeredAt: at } };
}
/** Fold a ScopeGuard enforcement record into its append-only projection list. */
export function appendScopeBoundaryHit(hits, hit) {
    return [...hits, hit];
}
/** Fold one commander workflow step create/update into the map (replace by id). */
export function upsertCommanderWorkflowStep(steps, step) {
    return { ...steps, [step.stepId]: step };
}
/** Fold one commander workflow step start (pending → running, stamp). */
export function startCommanderWorkflowStep(steps, stepId, at) {
    const existing = steps[stepId];
    if (existing === undefined)
        return steps;
    return { ...steps, [stepId]: { ...existing, status: 'running', updatedAt: at } };
}
/** Fold one commander workflow step completion (running → completed, stamp). */
export function completeCommanderWorkflowStep(steps, stepId, at) {
    const existing = steps[stepId];
    if (existing === undefined)
        return steps;
    return { ...steps, [stepId]: { ...existing, status: 'completed', updatedAt: at } };
}
/** Fold one commander workflow step failure (running → failed, stamp). */
export function failCommanderWorkflowStep(steps, stepId, at) {
    const existing = steps[stepId];
    if (existing === undefined)
        return steps;
    return { ...steps, [stepId]: { ...existing, status: 'failed', updatedAt: at } };
}
