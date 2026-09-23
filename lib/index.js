import { Service } from "@deepseek-ai/cordis";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { delegationDepthOf } from "@deepseek-ai/dsh-subagent";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
//#region lib/host/types.js
/**
* DevFlow durable data types. Pure structural types only; all runtime logic
* lives in the storage and tool layers.
* @module @xiaoxie-ide/dsh-devflow/types
*/
/** Every close reason, in one place, so all layers validate the same set. */
const DEVFLOW_CLOSE_REASONS = [
	"stale-lost",
	"superseded",
	"abandoned"
];
/** Is this value one of the three close reasons? */
function isDevFlowCloseReason(value) {
	return typeof value === "string" && DEVFLOW_CLOSE_REASONS.includes(value);
}
//#endregion
//#region lib/host/projection.js
/**
* DevFlow plugin-owned read-model fold: folds `.devflow` journal records into a
* client-facing view — project/tasks/agents plus the v0.4 orchestration
* registry, planning state, and review failure counters. Pure replay value —
* no live mirror; deterministic and side-effect free.
* @module @xiaoxie-ide/dsh-devflow/projection
*/
const dispatchDiagnosticSchema = z.object({
	dispatchId: z.string(),
	taskId: z.string(),
	agentId: z.string(),
	projectId: z.union([z.string(), z.null()]),
	taskStatus: z.enum([
		"created",
		"planned",
		"executing",
		"reviewing",
		"completed",
		"failed",
		"cancelled"
	]),
	projectionStatus: z.enum(["available", "unavailable"]),
	reviewFailCount: z.number().int().nonnegative(),
	decisionStatus: z.string().optional(),
	highRisk: z.boolean(),
	assignmentId: z.string().optional(),
	assignmentStatus: z.enum([
		"assigned",
		"in_progress",
		"completed",
		"closed"
	]).optional(),
	assignmentAgentId: z.string().optional(),
	assignmentPhaseId: z.string().optional(),
	childDepth: z.number().int().nonnegative().optional(),
	maxDepth: z.number().int().nonnegative().optional(),
	provider: z.string().optional(),
	model: z.string().optional(),
	toolFilter: z.array(z.string()).optional(),
	runId: z.string().optional(),
	stopReason: z.string().optional(),
	errorCode: z.string().optional(),
	errorMessage: z.string().optional(),
	partialOutput: z.string().optional(),
	lastToolCall: z.string().optional(),
	status: z.enum([
		"started",
		"blocked",
		"failed",
		"completed"
	]),
	at: z.string()
});
/** Fold one dispatch diagnostic into the latest map. */
function upsertDispatchDiagnostic(diagnostics, diagnostic) {
	return {
		...diagnostics,
		[diagnostic.dispatchId]: diagnostic
	};
}
const agentInstanceSchema = z.object({
	id: z.string(),
	role: z.enum([
		"planner",
		"backend-engineer",
		"frontend-engineer",
		"reviewer"
	]),
	displayName: z.string(),
	description: z.string().optional(),
	capabilities: z.array(z.string()).optional(),
	metadata: z.record(z.string(), z.unknown()).optional(),
	createdAt: z.string(),
	updatedAt: z.string()
});
const agentModelConfigSchema = z.object({
	model: z.string(),
	provider: z.string().optional(),
	baseURL: z.string().optional(),
	apiKey: z.string().optional(),
	temperature: z.number().optional(),
	maxTokens: z.number().optional(),
	options: z.record(z.string(), z.unknown()).optional()
});
const orchestrationAgentSchema = z.object({
	agentId: z.string(),
	kind: z.enum(["fixed", "temporary"]),
	role: z.enum([
		"planner",
		"backend-engineer",
		"frontend-engineer",
		"reviewer"
	]),
	status: z.enum([
		"active",
		"created",
		"running",
		"terminated"
	]),
	prompt: z.string(),
	modelConfig: agentModelConfigSchema,
	tools: z.array(z.string()),
	capabilities: z.array(z.string()),
	skills: z.array(z.string()),
	delegationDepth: z.number().int().nonnegative(),
	createdAt: z.string(),
	updatedAt: z.string()
});
const mvpPlanSchema = z.object({
	goal: z.string(),
	scope: z.array(z.string()),
	phaseIds: z.array(z.string()),
	createdAt: z.string(),
	updatedAt: z.string()
});
const phaseSchema = z.object({
	id: z.string(),
	name: z.string(),
	description: z.string(),
	status: z.enum([
		"planned",
		"in_progress",
		"completed"
	]),
	createdAt: z.string(),
	updatedAt: z.string()
});
const scopeGuardSchema = z.object({
	summary: z.string(),
	inScope: z.array(z.string()),
	maxModifiedFiles: z.number().int().positive(),
	maxToolSteps: z.number().int().positive(),
	completionCriteria: z.array(z.string()).min(1),
	createdAt: z.string(),
	updatedAt: z.string()
});
const improvementSchema = z.object({
	id: z.string(),
	title: z.string(),
	description: z.string(),
	createdAt: z.string()
});
const commanderCheckpointSchema = z.object({
	checkpointId: z.string(),
	projectId: z.string(),
	currentMvp: z.union([z.string(), z.null()]),
	currentIteration: z.union([z.string(), z.null()]),
	currentPhase: z.union([z.string(), z.null()]),
	currentTask: z.union([z.string(), z.null()]),
	completedItems: z.array(z.string()),
	decisions: z.array(z.string()),
	nextSteps: z.array(z.string()),
	createdAt: z.string(),
	updatedAt: z.string()
});
const phaseAssignmentSchema = z.object({
	assignmentId: z.string(),
	taskId: z.string().optional(),
	phaseId: z.string(),
	agentId: z.string(),
	role: z.enum([
		"planner",
		"backend-engineer",
		"frontend-engineer",
		"reviewer"
	]),
	status: z.enum([
		"assigned",
		"in_progress",
		"completed"
	]),
	createdAt: z.string(),
	updatedAt: z.string()
});
const commanderPlanSchema = z.object({
	planningId: z.string(),
	projectId: z.string(),
	goal: z.string(),
	status: z.enum([
		"draft",
		"active",
		"completed"
	]),
	mvpPlanId: z.union([z.string(), z.null()]),
	createdAt: z.string(),
	updatedAt: z.string()
});
const executionBatchSchema = z.object({
	batchId: z.string(),
	projectId: z.string(),
	planningId: z.string(),
	phaseIds: z.array(z.string()),
	assignmentIds: z.array(z.string()),
	status: z.enum([
		"planned",
		"running",
		"paused",
		"completed"
	]),
	createdAt: z.string(),
	updatedAt: z.string()
});
const executionRecordSchema = z.object({
	executionId: z.string(),
	batchId: z.string(),
	assignmentId: z.string(),
	agentId: z.string(),
	taskId: z.string().optional(),
	scopeGuard: z.object({
		maxModifiedFiles: z.number().int().positive(),
		maxToolSteps: z.number().int().positive(),
		completionCriteria: z.array(z.string()).min(1)
	}).optional(),
	status: z.enum([
		"pending",
		"running",
		"completed",
		"failed"
	]),
	startedAt: z.union([z.string(), z.null()]),
	completedAt: z.union([z.string(), z.null()]),
	createdAt: z.string(),
	updatedAt: z.string()
});
const executionAttemptSchema = z.object({
	attemptId: z.string(),
	executionId: z.string(),
	parentAttemptId: z.union([z.string(), z.null()]),
	status: z.enum([
		"created",
		"running",
		"completed",
		"failed"
	]),
	reason: z.union([z.string(), z.null()]),
	createdAt: z.string(),
	completedAt: z.union([z.string(), z.null()]),
	updatedAt: z.string()
});
const agentReportSchema = z.object({
	reportId: z.string(),
	executionId: z.string(),
	agentId: z.string(),
	status: z.enum([
		"success",
		"failed",
		"blocked"
	]),
	summary: z.string(),
	outputReference: z.string(),
	outcome: z.enum([
		"delivered",
		"blocked",
		"failed",
		"unknown"
	]).optional(),
	modifiedFiles: z.array(z.string()).optional(),
	toolStepCount: z.number().int().nonnegative().optional(),
	completedCriteria: z.array(z.string()).optional(),
	createdAt: z.string(),
	updatedAt: z.string()
});
const blockedReportSchema = z.object({
	blockedId: z.string(),
	taskId: z.string(),
	agentId: z.string(),
	executionId: z.string().optional(),
	sessionId: z.string().optional(),
	gapKind: z.enum([
		"tool",
		"permission",
		"dependency",
		"unstated"
	]),
	missing: z.string(),
	suggestedOwner: z.string(),
	reason: z.string(),
	createdAt: z.string()
});
const commanderDecisionSchema = z.object({
	decisionId: z.string(),
	projectId: z.string(),
	checkpointId: z.union([z.string(), z.null()]),
	relatedExecutionIds: z.array(z.string()),
	decisionType: z.enum([
		"continue",
		"retry",
		"pause",
		"request_user"
	]),
	summary: z.string(),
	nextAction: z.string(),
	createdAt: z.string(),
	updatedAt: z.string()
});
const commanderActionSchema = z.object({
	actionId: z.string(),
	decisionId: z.string(),
	actionType: z.enum([
		"start_batch",
		"pause_batch",
		"retry_execution",
		"complete_batch"
	]),
	targetId: z.string(),
	status: z.enum([
		"created",
		"executing",
		"completed"
	]),
	createdAt: z.string(),
	updatedAt: z.string()
});
const commanderReviewSchema = z.object({
	reviewId: z.string(),
	projectId: z.string(),
	reportId: z.string(),
	executionId: z.string(),
	status: z.enum(["pending", "reviewed"]),
	summary: z.string(),
	createdAt: z.string(),
	updatedAt: z.string()
});
const runtimeTaskPackageSchema = z.object({
	packageId: z.string(),
	executionId: z.string(),
	agentId: z.string(),
	taskDescription: z.string(),
	tools: z.array(z.string()),
	metadata: z.record(z.string(), z.unknown()),
	currentDelegationDepth: z.number().int().nonnegative().default(0),
	scopeGuard: z.object({
		maxModifiedFiles: z.number().int().positive(),
		maxToolSteps: z.number().int().positive(),
		completionCriteria: z.array(z.string()).min(1)
	}).optional(),
	createdAt: z.string()
});
const runtimeResultPackageSchema = z.object({
	resultId: z.string(),
	executionId: z.string(),
	status: z.enum(["success", "failed"]),
	output: z.string(),
	metadata: z.record(z.string(), z.unknown()),
	modifiedFiles: z.array(z.string()).optional(),
	toolStepCount: z.number().int().nonnegative().optional(),
	completedCriteria: z.array(z.string()).optional(),
	createdAt: z.string()
});
const decisionRequestSchema = z.object({
	requestId: z.string(),
	projectId: z.string(),
	taskId: z.union([z.string(), z.null()]),
	trigger: z.enum([
		"ambiguity",
		"approach-divergence",
		"scope-creep",
		"review-failed-twice",
		"high-risk-operation",
		"granularity",
		"development-order"
	]),
	question: z.string(),
	options: z.array(z.object({
		id: z.string(),
		label: z.string(),
		description: z.string(),
		recommended: z.boolean()
	})),
	allowCustom: z.boolean(),
	status: z.enum([
		"pending",
		"answered",
		"dismissed"
	]),
	answer: z.union([
		z.object({ optionId: z.string() }),
		z.object({ custom: z.string() }),
		z.null()
	]),
	createdAt: z.string(),
	answeredAt: z.union([z.string(), z.null()])
});
const scopeBoundaryHitSchema = z.object({
	taskId: z.string(),
	boundary: z.enum([
		"modified_files",
		"tool_steps",
		"completion_criteria"
	]),
	currentValue: z.number().int().nonnegative(),
	limit: z.number().int().positive(),
	at: z.string()
});
const runtimeSessionSchema = z.object({
	sessionId: z.string(),
	executionId: z.string(),
	agentId: z.string(),
	status: z.enum([
		"created",
		"running",
		"completed",
		"failed"
	]),
	startedAt: z.union([z.string(), z.null()]),
	completedAt: z.union([z.string(), z.null()]),
	metadata: z.record(z.string(), z.unknown()),
	createdAt: z.string(),
	updatedAt: z.string()
});
const commanderMemorySchema = z.object({
	memoryId: z.string(),
	projectId: z.string(),
	memoryType: z.enum([
		"project",
		"decision",
		"execution",
		"preference"
	]),
	content: z.string(),
	source: z.string(),
	createdAt: z.string(),
	updatedAt: z.string()
});
const commanderScheduleSchema = z.object({
	scheduleId: z.string(),
	projectId: z.string(),
	status: z.enum(["active", "paused"]),
	interval: z.number(),
	lastRunAt: z.union([z.string(), z.null()]),
	nextRunAt: z.string(),
	createdAt: z.string(),
	updatedAt: z.string()
});
const commanderRunSchema = z.object({
	runId: z.string(),
	projectId: z.string(),
	scheduleId: z.string(),
	status: z.enum([
		"running",
		"completed",
		"failed"
	]),
	decisionId: z.union([z.string(), z.null()]),
	actionId: z.union([z.string(), z.null()]),
	startedAt: z.string(),
	completedAt: z.union([z.string(), z.null()]),
	updatedAt: z.string()
});
const commanderActionExecutionSchema = z.object({
	executionId: z.string(),
	actionId: z.string(),
	status: z.enum([
		"running",
		"completed",
		"failed"
	]),
	success: z.union([z.boolean(), z.null()]),
	error: z.union([z.string(), z.null()]),
	createdAt: z.string(),
	completedAt: z.union([z.string(), z.null()]),
	updatedAt: z.string()
});
const commanderPolicySchema = z.object({
	projectId: z.string(),
	maxRetryCount: z.number(),
	allowedActionTypes: z.array(z.enum([
		"start_batch",
		"pause_batch",
		"retry_execution",
		"complete_batch"
	])),
	requireApprovalActionTypes: z.array(z.enum([
		"start_batch",
		"pause_batch",
		"retry_execution",
		"complete_batch"
	])),
	riskLevel: z.enum([
		"low",
		"medium",
		"high"
	]),
	createdAt: z.string(),
	updatedAt: z.string()
});
const commanderProposalSchema = z.object({
	proposalId: z.string(),
	decisionId: z.string(),
	actionType: z.enum([
		"start_batch",
		"pause_batch",
		"retry_execution",
		"complete_batch"
	]),
	targetId: z.string(),
	riskLevel: z.enum([
		"low",
		"medium",
		"high"
	]),
	status: z.enum([
		"created",
		"approved",
		"rejected"
	]),
	createdAt: z.string(),
	updatedAt: z.string()
});
const commanderExecutionContextSchema = z.object({
	contextId: z.string(),
	executionId: z.string(),
	decisionId: z.string(),
	proposalId: z.string(),
	actionType: z.enum([
		"start_batch",
		"pause_batch",
		"retry_execution",
		"complete_batch"
	]),
	targetId: z.string(),
	riskLevel: z.enum([
		"low",
		"medium",
		"high"
	]),
	metadata: z.record(z.string(), z.unknown()),
	createdAt: z.string()
});
const commanderWorkflowExecutionResultSchema = z.object({
	success: z.boolean(),
	error: z.union([z.string(), z.null()])
});
const commanderWorkflowExecutionSchema = z.object({
	entryId: z.string(),
	stepId: z.union([z.string(), z.null()]),
	decisionId: z.string(),
	proposalId: z.union([z.string(), z.null()]),
	approved: z.boolean(),
	contextId: z.union([z.string(), z.null()]),
	actionExecutionId: z.union([z.string(), z.null()]),
	result: z.union([commanderWorkflowExecutionResultSchema, z.null()]),
	feedbackId: z.union([z.string(), z.null()]),
	createdAt: z.string()
});
const commanderWorkflowSchema = z.object({
	workflowId: z.string(),
	projectId: z.string(),
	title: z.string(),
	description: z.string(),
	status: z.enum([
		"created",
		"running",
		"completed",
		"failed"
	]),
	history: z.array(commanderWorkflowExecutionSchema),
	createdAt: z.string(),
	updatedAt: z.string()
});
const commanderWorkflowStepSchema = z.object({
	stepId: z.string(),
	workflowId: z.string(),
	stepIndex: z.number(),
	title: z.string(),
	status: z.enum([
		"pending",
		"running",
		"completed",
		"failed"
	]),
	createdAt: z.string(),
	updatedAt: z.string()
});
z.object({
	project: z.union([z.object({
		id: z.string(),
		name: z.string(),
		goal: z.string(),
		currentStage: z.string(),
		createdAt: z.string(),
		updatedAt: z.string()
	}), z.null()]),
	tasks: z.record(z.string(), z.enum([
		"created",
		"planned",
		"executing",
		"reviewing",
		"completed",
		"failed",
		"cancelled"
	])),
	taskTitles: z.record(z.string(), z.string()).optional(),
	agents: z.array(agentInstanceSchema),
	orchestrationAgents: z.record(z.string(), orchestrationAgentSchema),
	plan: z.union([mvpPlanSchema, z.null()]),
	phases: z.record(z.string(), phaseSchema),
	scope: z.union([scopeGuardSchema, z.null()]),
	improvements: z.array(improvementSchema),
	commanderCheckpoints: z.record(z.string(), commanderCheckpointSchema),
	assignments: z.record(z.string(), phaseAssignmentSchema),
	commanderPlans: z.record(z.string(), commanderPlanSchema),
	executionBatches: z.record(z.string(), executionBatchSchema),
	executions: z.record(z.string(), executionRecordSchema),
	executionAttempts: z.record(z.string(), executionAttemptSchema),
	agentReports: z.record(z.string(), agentReportSchema),
	blockedReports: z.record(z.string(), blockedReportSchema).optional(),
	commanderDecisions: z.record(z.string(), commanderDecisionSchema),
	commanderActions: z.record(z.string(), commanderActionSchema),
	commanderReviews: z.record(z.string(), commanderReviewSchema),
	runtimePackages: z.record(z.string(), runtimeTaskPackageSchema),
	runtimeResults: z.record(z.string(), runtimeResultPackageSchema),
	runtimeSessions: z.record(z.string(), runtimeSessionSchema),
	commanderMemory: z.record(z.string(), commanderMemorySchema),
	commanderSchedules: z.record(z.string(), commanderScheduleSchema),
	commanderRuns: z.record(z.string(), commanderRunSchema),
	commanderActionExecutions: z.record(z.string(), commanderActionExecutionSchema),
	policies: z.record(z.string(), commanderPolicySchema),
	commanderProposals: z.record(z.string(), commanderProposalSchema),
	commanderExecutionContexts: z.record(z.string(), commanderExecutionContextSchema),
	commanderWorkflows: z.record(z.string(), commanderWorkflowSchema),
	commanderWorkflowSteps: z.record(z.string(), commanderWorkflowStepSchema),
	scopeBoundaryHits: z.array(scopeBoundaryHitSchema),
	decisionRequests: z.record(z.string(), decisionRequestSchema),
	dispatchDiagnostics: z.record(z.string(), dispatchDiagnosticSchema).optional(),
	reviewFailCounts: z.record(z.string(), z.number().int().nonnegative()),
	commanderMode: z.enum(["chat", "commander"]),
	commanderModeExitAt: z.string().optional(),
	paused: z.boolean()
});
/** Fold one imported review verdict into a task's consecutive failure count. */
function foldReviewFailCount(counts, taskId, verdict) {
	if (verdict === "accepted") return resetReviewFailCount(counts, taskId);
	return {
		...counts,
		[taskId]: (counts[taskId] ?? 0) + 1
	};
}
/** Reset one task's consecutive review failure count. */
function resetReviewFailCount(counts, taskId) {
	if (counts[taskId] === void 0) return counts;
	const { [taskId]: _reset, ...remaining } = counts;
	return remaining;
}
/** Fold one agent upsert into the instance list (replace by id, else append). */
function upsertAgent(agents, instance) {
	const index = agents.findIndex((existing) => existing.id === instance.id);
	if (index < 0) return [...agents, instance];
	return [
		...agents.slice(0, index),
		instance,
		...agents.slice(index + 1)
	];
}
/** Fold one orchestration-agent register into the registry (replace by id). */
function upsertOrchestrationAgent(agents, agent) {
	return {
		...agents,
		[agent.agentId]: agent
	};
}
/** Fold one orchestration-agent removal out of the registry. */
function removeOrchestrationAgent(agents, agentId) {
	const { [agentId]: _removed, ...rest } = agents;
	return rest;
}
/** Fold one orchestration-agent config patch into the registry. */
function patchOrchestrationAgent(agents, agentId, patch, at) {
	const existing = agents[agentId];
	if (existing === void 0) return agents;
	const updated = {
		...existing,
		role: patch.role ?? existing.role,
		prompt: patch.prompt ?? existing.prompt,
		modelConfig: patch.modelConfig === void 0 ? existing.modelConfig : {
			...existing.modelConfig,
			...patch.modelConfig
		},
		tools: patch.tools ?? existing.tools,
		capabilities: patch.capabilities ?? existing.capabilities,
		skills: patch.skills ?? existing.skills,
		delegationDepth: patch.delegationDepth ?? existing.delegationDepth,
		updatedAt: at
	};
	return {
		...agents,
		[agentId]: updated
	};
}
/** Fold one temporary-agent lifecycle transition into the registry. */
function transitionOrchestrationAgent(agents, agentId, to, at) {
	const existing = agents[agentId];
	if (existing === void 0) return agents;
	return {
		...agents,
		[agentId]: {
			...existing,
			status: to,
			updatedAt: at
		}
	};
}
/** Fold one phase create/update into the phase map (replace by id). */
function upsertPhase(phases, phase) {
	return {
		...phases,
		[phase.id]: phase
	};
}
/** Fold one checkpoint create/update into the checkpoint map (replace by id). */
function upsertCheckpoint(checkpoints, checkpoint) {
	return {
		...checkpoints,
		[checkpoint.checkpointId]: checkpoint
	};
}
/** Fold one checkpoint patch into the checkpoint map. */
function patchCheckpoint(checkpoints, checkpointId, patch, at) {
	const existing = checkpoints[checkpointId];
	if (existing === void 0) return checkpoints;
	const updated = {
		...existing,
		...patch.currentMvp !== void 0 ? { currentMvp: patch.currentMvp } : {},
		...patch.currentIteration !== void 0 ? { currentIteration: patch.currentIteration } : {},
		...patch.currentPhase !== void 0 ? { currentPhase: patch.currentPhase } : {},
		...patch.currentTask !== void 0 ? { currentTask: patch.currentTask } : {},
		...patch.completedItems !== void 0 ? { completedItems: patch.completedItems } : {},
		...patch.decisions !== void 0 ? { decisions: patch.decisions } : {},
		...patch.nextSteps !== void 0 ? { nextSteps: patch.nextSteps } : {},
		updatedAt: at
	};
	return {
		...checkpoints,
		[checkpointId]: updated
	};
}
/** Fold one assignment create/update into the assignment map (replace by id). */
function upsertAssignment(assignments, assignment) {
	return {
		...assignments,
		[assignment.assignmentId]: assignment
	};
}
/** Fold one assignment removal out of the assignment map. */
function removeAssignment(assignments, assignmentId) {
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
function patchAssignmentStatus(assignments, assignmentId, status, at, closeReason) {
	const existing = assignments[assignmentId];
	if (existing === void 0) return assignments;
	const { closedAt: _closedAt, closeReason: _closeReason, ...rest } = existing;
	const next = {
		...rest,
		status,
		...status === "closed" && isDevFlowCloseReason(closeReason) ? {
			closedAt: at,
			closeReason
		} : {},
		updatedAt: at
	};
	return {
		...assignments,
		[assignmentId]: next
	};
}
/** Fold one commander plan create/update into the plan map (replace by id). */
function upsertCommanderPlan(plans, plan) {
	return {
		...plans,
		[plan.planningId]: plan
	};
}
/** Fold one commander plan activation (status → active). */
function activateCommanderPlan(plans, planningId, at) {
	const existing = plans[planningId];
	if (existing === void 0) return plans;
	return {
		...plans,
		[planningId]: {
			...existing,
			status: "active",
			updatedAt: at
		}
	};
}
/** Fold one commander plan patch into the plan map. */
function patchCommanderPlan(plans, planningId, patch, at) {
	const existing = plans[planningId];
	if (existing === void 0) return plans;
	const updated = {
		...existing,
		...patch.goal !== void 0 ? { goal: patch.goal } : {},
		...patch.mvpPlanId !== void 0 ? { mvpPlanId: patch.mvpPlanId } : {},
		...patch.status !== void 0 ? { status: patch.status } : {},
		updatedAt: at
	};
	return {
		...plans,
		[planningId]: updated
	};
}
/** Fold one execution batch create/update into the batch map (replace by id). */
function upsertExecutionBatch(batches, batch) {
	return {
		...batches,
		[batch.batchId]: batch
	};
}
/** Fold one execution batch status change into the batch map. */
function transitionExecutionBatch(batches, batchId, status, at) {
	const existing = batches[batchId];
	if (existing === void 0) return batches;
	return {
		...batches,
		[batchId]: {
			...existing,
			status,
			updatedAt: at
		}
	};
}
/** Fold one execution create/update into the execution map (replace by id). */
function upsertExecution(executions, execution) {
	return {
		...executions,
		[execution.executionId]: execution
	};
}
/** Fold one execution status change into the execution map (stamps start/complete/close). */
function transitionExecution(executions, executionId, status, at, closeReason) {
	const existing = executions[executionId];
	if (existing === void 0) return executions;
	const { closedAt: _closedAt, closeReason: _closeReason, ...rest } = existing;
	const updated = {
		...rest,
		status,
		...status === "running" && existing.startedAt === null ? { startedAt: at } : {},
		...(status === "completed" || status === "failed") && existing.completedAt === null ? { completedAt: at } : {},
		...status === "closed" && isDevFlowCloseReason(closeReason) ? {
			closedAt: at,
			closeReason
		} : {},
		updatedAt: at
	};
	return {
		...executions,
		[executionId]: updated
	};
}
/** Fold one execution attempt create/update into the attempt map (replace by id). */
function upsertExecutionAttempt(attempts, attempt) {
	return {
		...attempts,
		[attempt.attemptId]: attempt
	};
}
/** Fold one execution attempt status change into the attempt map (stamps completion). */
function transitionExecutionAttempt(attempts, attemptId, status, at) {
	const existing = attempts[attemptId];
	if (existing === void 0) return attempts;
	const updated = {
		...existing,
		status,
		...(status === "completed" || status === "failed") && existing.completedAt === null ? { completedAt: at } : {},
		updatedAt: at
	};
	return {
		...attempts,
		[attemptId]: updated
	};
}
/** Fold one agent report create/update into the report map (replace by id). */
function upsertAgentReport(reports, report) {
	return {
		...reports,
		[report.reportId]: report
	};
}
/** Fold one blocked report into the blocked map (replace by id). */
function upsertBlockedReport(blocked, report) {
	return {
		...blocked,
		[report.blockedId]: report
	};
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
function blockedReportsForTask(blocked, taskId) {
	return Object.values(blocked).filter((item) => item.taskId === taskId).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}
/** Fold one agent report patch into the report map. */
function patchAgentReport(reports, reportId, patch, at) {
	const existing = reports[reportId];
	if (existing === void 0) return reports;
	const updated = {
		...existing,
		...patch.status !== void 0 ? { status: patch.status } : {},
		...patch.summary !== void 0 ? { summary: patch.summary } : {},
		...patch.outputReference !== void 0 ? { outputReference: patch.outputReference } : {},
		...patch.outcome !== void 0 ? { outcome: patch.outcome } : {},
		updatedAt: at
	};
	return {
		...reports,
		[reportId]: updated
	};
}
/** Fold one commander decision create/update into the decision map (replace by id). */
function upsertCommanderDecision(decisions, decision) {
	return {
		...decisions,
		[decision.decisionId]: decision
	};
}
/** Fold one commander decision patch into the decision map. */
function patchCommanderDecision(decisions, decisionId, patch, at) {
	const existing = decisions[decisionId];
	if (existing === void 0) return decisions;
	const updated = {
		...existing,
		...patch.checkpointId !== void 0 ? { checkpointId: patch.checkpointId } : {},
		...patch.relatedExecutionIds !== void 0 ? { relatedExecutionIds: patch.relatedExecutionIds } : {},
		...patch.decisionType !== void 0 ? { decisionType: patch.decisionType } : {},
		...patch.summary !== void 0 ? { summary: patch.summary } : {},
		...patch.nextAction !== void 0 ? { nextAction: patch.nextAction } : {},
		updatedAt: at
	};
	return {
		...decisions,
		[decisionId]: updated
	};
}
/** Fold one commander control action create/update into the action map (replace by id). */
function upsertCommanderAction(actions, action) {
	return {
		...actions,
		[action.actionId]: action
	};
}
/** Fold one commander control action status change into the action map. */
function transitionCommanderAction(actions, actionId, status, at) {
	const existing = actions[actionId];
	if (existing === void 0) return actions;
	return {
		...actions,
		[actionId]: {
			...existing,
			status,
			updatedAt: at
		}
	};
}
/** Fold one commander review create/update into the review map (replace by id). */
function upsertCommanderReview(reviews, review) {
	return {
		...reviews,
		[review.reviewId]: review
	};
}
/** Fold one commander review completion (status → reviewed). */
function completeCommanderReview(reviews, reviewId, at) {
	const existing = reviews[reviewId];
	if (existing === void 0) return reviews;
	return {
		...reviews,
		[reviewId]: {
			...existing,
			status: "reviewed",
			updatedAt: at
		}
	};
}
/** Fold one runtime task package export into the package map (replace by id). */
function upsertRuntimePackage(packages, pkg) {
	return {
		...packages,
		[pkg.packageId]: pkg
	};
}
/** Fold one runtime result package import into the result map (replace by id). */
function upsertRuntimeResult(results, result) {
	return {
		...results,
		[result.resultId]: result
	};
}
/** Fold one runtime session create/update into the session map (replace by id). */
function upsertRuntimeSession(sessions, session) {
	return {
		...sessions,
		[session.sessionId]: session
	};
}
/** Fold one runtime session status change into the session map (stamps start/complete). */
function transitionRuntimeSession(sessions, sessionId, status, at) {
	const existing = sessions[sessionId];
	if (existing === void 0) return sessions;
	const updated = {
		...existing,
		status,
		...status === "running" && existing.startedAt === null ? { startedAt: at } : {},
		...(status === "completed" || status === "failed") && existing.completedAt === null ? { completedAt: at } : {},
		updatedAt: at
	};
	return {
		...sessions,
		[sessionId]: updated
	};
}
/** Fold one commander memory create/update into the memory map (replace by id). */
function upsertCommanderMemory(memories, memory) {
	return {
		...memories,
		[memory.memoryId]: memory
	};
}
/** Fold one commander memory patch into the memory map. */
function patchCommanderMemory(memories, memoryId, patch, at) {
	const existing = memories[memoryId];
	if (existing === void 0) return memories;
	const updated = {
		...existing,
		...patch.content !== void 0 ? { content: patch.content } : {},
		...patch.source !== void 0 ? { source: patch.source } : {},
		updatedAt: at
	};
	return {
		...memories,
		[memoryId]: updated
	};
}
/** Fold one commander schedule create/update into the schedule map (replace by id). */
function upsertCommanderSchedule(schedules, schedule) {
	return {
		...schedules,
		[schedule.scheduleId]: schedule
	};
}
/** Fold one commander schedule patch into the schedule map (rolls the next run). */
function patchCommanderSchedule(schedules, scheduleId, patch, at) {
	const existing = schedules[scheduleId];
	if (existing === void 0) return schedules;
	const interval = patch.interval ?? existing.interval;
	const lastRunAt = patch.markRunAt !== void 0 ? patch.markRunAt : existing.lastRunAt;
	const rollBase = patch.markRunAt !== void 0 ? patch.markRunAt : lastRunAt ?? at;
	const nextRunAt = patch.interval !== void 0 || patch.markRunAt !== void 0 ? new Date(Date.parse(rollBase) + interval).toISOString() : existing.nextRunAt;
	return {
		...schedules,
		[scheduleId]: {
			...existing,
			interval,
			lastRunAt,
			nextRunAt,
			updatedAt: at
		}
	};
}
/** Fold one commander schedule pause (status → paused). */
function pauseCommanderSchedule(schedules, scheduleId, at) {
	const existing = schedules[scheduleId];
	if (existing === void 0) return schedules;
	return {
		...schedules,
		[scheduleId]: {
			...existing,
			status: "paused",
			updatedAt: at
		}
	};
}
/** Fold one commander run create/update into the run map (replace by id). */
function upsertCommanderRun(runs, run) {
	return {
		...runs,
		[run.runId]: run
	};
}
/** Fold one commander run completion (status → completed, ids + stamp). */
function completeCommanderRun(runs, runId, decisionId, actionId, at) {
	const existing = runs[runId];
	if (existing === void 0) return runs;
	return {
		...runs,
		[runId]: {
			...existing,
			status: "completed",
			decisionId,
			actionId,
			completedAt: at,
			updatedAt: at
		}
	};
}
/** Fold one commander run failure (status → failed, stamp). */
function failCommanderRun(runs, runId, at) {
	const existing = runs[runId];
	if (existing === void 0) return runs;
	return {
		...runs,
		[runId]: {
			...existing,
			status: "failed",
			completedAt: at,
			updatedAt: at
		}
	};
}
/** Fold one commander action execution create/update into the map (replace by id). */
function upsertCommanderActionExecution(executions, execution) {
	return {
		...executions,
		[execution.executionId]: execution
	};
}
/** Fold one commander action execution completion (status → completed, success, stamp). */
function completeCommanderActionExecution(executions, executionId, at) {
	const existing = executions[executionId];
	if (existing === void 0) return executions;
	return {
		...executions,
		[executionId]: {
			...existing,
			status: "completed",
			success: true,
			completedAt: at,
			updatedAt: at
		}
	};
}
/** Fold one commander action execution failure (status → failed, error, stamp). */
function failCommanderActionExecution(executions, executionId, error, at) {
	const existing = executions[executionId];
	if (existing === void 0) return executions;
	return {
		...executions,
		[executionId]: {
			...existing,
			status: "failed",
			success: false,
			error,
			completedAt: at,
			updatedAt: at
		}
	};
}
/** Fold one project policy create/replace into the policy map (replace by project id). */
function upsertPolicy(policies, policy) {
	return {
		...policies,
		[policy.projectId]: policy
	};
}
/** Fold one commander proposal create/update into the proposal map (replace by id). */
function upsertCommanderProposal(proposals, proposal) {
	return {
		...proposals,
		[proposal.proposalId]: proposal
	};
}
/** Fold one commander proposal approval (status → approved). */
function approveCommanderProposal(proposals, proposalId, at) {
	const existing = proposals[proposalId];
	if (existing === void 0) return proposals;
	return {
		...proposals,
		[proposalId]: {
			...existing,
			status: "approved",
			updatedAt: at
		}
	};
}
/** Fold one commander proposal rejection (status → rejected). */
function rejectCommanderProposal(proposals, proposalId, at) {
	const existing = proposals[proposalId];
	if (existing === void 0) return proposals;
	return {
		...proposals,
		[proposalId]: {
			...existing,
			status: "rejected",
			updatedAt: at
		}
	};
}
/** Fold one commander execution context generation into the map (replace by id). */
function upsertCommanderExecutionContext(contexts, context) {
	return {
		...contexts,
		[context.contextId]: context
	};
}
/** Fold one commander workflow create/update into the map (replace by id). */
function upsertCommanderWorkflow(workflows, workflow) {
	return {
		...workflows,
		[workflow.workflowId]: workflow
	};
}
/** Fold one commander workflow start (created → running, stamp). */
function startCommanderWorkflow(workflows, workflowId, at) {
	const existing = workflows[workflowId];
	if (existing === void 0) return workflows;
	return {
		...workflows,
		[workflowId]: {
			...existing,
			status: "running",
			updatedAt: at
		}
	};
}
/** Fold one commander workflow completion (running → completed, stamp). */
function completeCommanderWorkflow(workflows, workflowId, at) {
	const existing = workflows[workflowId];
	if (existing === void 0) return workflows;
	return {
		...workflows,
		[workflowId]: {
			...existing,
			status: "completed",
			updatedAt: at
		}
	};
}
/** Fold one commander workflow failure (running → failed, stamp). */
function failCommanderWorkflow(workflows, workflowId, at) {
	const existing = workflows[workflowId];
	if (existing === void 0) return workflows;
	return {
		...workflows,
		[workflowId]: {
			...existing,
			status: "failed",
			updatedAt: at
		}
	};
}
/** Fold one workflow history entry append (history grows, stamp). */
function appendCommanderWorkflowExecution(workflows, workflowId, entry, at) {
	const existing = workflows[workflowId];
	if (existing === void 0) return workflows;
	return {
		...workflows,
		[workflowId]: {
			...existing,
			history: [...existing.history, entry],
			updatedAt: at
		}
	};
}
/** Fold a Commander decision request into the request map. */
function upsertDecisionRequest(requests, request) {
	return {
		...requests,
		[request.requestId]: request
	};
}
/** Fold a pending Commander decision answer into the request map. */
function answerDecisionRequest(requests, requestId, answer, at) {
	const request = requests[requestId];
	if (request === void 0 || request.status !== "pending") return requests;
	return {
		...requests,
		[requestId]: {
			...request,
			status: "answered",
			answer,
			answeredAt: at
		}
	};
}
/** Fold a ScopeGuard enforcement record into its append-only projection list. */
function appendScopeBoundaryHit(hits, hit) {
	return [...hits, hit];
}
/** Fold one commander workflow step create/update into the map (replace by id). */
function upsertCommanderWorkflowStep(steps, step) {
	return {
		...steps,
		[step.stepId]: step
	};
}
/** Fold one commander workflow step start (pending → running, stamp). */
function startCommanderWorkflowStep(steps, stepId, at) {
	const existing = steps[stepId];
	if (existing === void 0) return steps;
	return {
		...steps,
		[stepId]: {
			...existing,
			status: "running",
			updatedAt: at
		}
	};
}
/** Fold one commander workflow step completion (running → completed, stamp). */
function completeCommanderWorkflowStep(steps, stepId, at) {
	const existing = steps[stepId];
	if (existing === void 0) return steps;
	return {
		...steps,
		[stepId]: {
			...existing,
			status: "completed",
			updatedAt: at
		}
	};
}
/** Fold one commander workflow step failure (running → failed, stamp). */
function failCommanderWorkflowStep(steps, stepId, at) {
	const existing = steps[stepId];
	if (existing === void 0) return steps;
	return {
		...steps,
		[stepId]: {
			...existing,
			status: "failed",
			updatedAt: at
		}
	};
}
//#endregion
//#region lib/host/state.js
/**
* Store-journal DevFlow read model.
*
* This is the former session projection's pure fold, reused over plugin-owned
* journal records so third-party state never depends on session event support.
* @module @xiaoxie-ide/dsh-devflow/state
*/
/** Create the empty durable DevFlow state. */
function initialDevFlowState() {
	return {
		project: null,
		tasks: {},
		agents: [],
		orchestrationAgents: {},
		plan: null,
		phases: {},
		scope: null,
		improvements: [],
		commanderCheckpoints: {},
		assignments: {},
		commanderPlans: {},
		executionBatches: {},
		executions: {},
		executionAttempts: {},
		agentReports: {},
		blockedReports: {},
		commanderDecisions: {},
		commanderActions: {},
		commanderReviews: {},
		runtimePackages: {},
		runtimeResults: {},
		runtimeSessions: {},
		commanderMemory: {},
		commanderSchedules: {},
		commanderRuns: {},
		commanderActionExecutions: {},
		policies: {},
		commanderProposals: {},
		commanderExecutionContexts: {},
		commanderWorkflows: {},
		commanderWorkflowSteps: {},
		scopeBoundaryHits: [],
		decisionRequests: {},
		reviewFailCounts: {},
		commanderMode: "chat",
		paused: false
	};
}
/** Fold one plugin-owned journal record using the established DevFlow rules. */
function applyDevFlowStateEvent(state, event) {
	if (event.type === "devflow/project/update") return {
		...state,
		project: event.data.project
	};
	if (event.type === "devflow/task/transition") return {
		...state,
		tasks: {
			...state.tasks,
			[event.data.taskId]: event.data.to
		},
		...event.data.title === void 0 ? {} : { taskTitles: {
			...state.taskTitles ?? {},
			[event.data.taskId]: event.data.title
		} },
		...event.data.to === "completed" ? { reviewFailCounts: resetReviewFailCount(state.reviewFailCounts, event.data.taskId) } : {}
	};
	if (event.type === "devflow/bridge/import") return {
		...state,
		reviewFailCounts: foldReviewFailCount(state.reviewFailCounts, event.data.taskId, event.data.verdict)
	};
	if (event.type === "devflow/agent/upsert") return {
		...state,
		agents: upsertAgent(state.agents, event.data.instance)
	};
	if (event.type === "devflow/agent/register") return {
		...state,
		orchestrationAgents: upsertOrchestrationAgent(state.orchestrationAgents, event.data.agent)
	};
	if (event.type === "devflow/agent/remove") return {
		...state,
		orchestrationAgents: removeOrchestrationAgent(state.orchestrationAgents, event.data.agentId)
	};
	if (event.type === "devflow/agent/update-config") return {
		...state,
		orchestrationAgents: patchOrchestrationAgent(state.orchestrationAgents, event.data.agentId, event.data.patch, event.data.at)
	};
	if (event.type === "devflow/agent/transition") return {
		...state,
		orchestrationAgents: transitionOrchestrationAgent(state.orchestrationAgents, event.data.agentId, event.data.to, event.data.at)
	};
	if (event.type === "devflow/mvp/create") return {
		...state,
		plan: event.data.plan
	};
	if (event.type === "devflow/phase/create") return {
		...state,
		phases: upsertPhase(state.phases, event.data.phase)
	};
	if (event.type === "devflow/phase/update") {
		const existing = state.phases[event.data.phaseId];
		if (existing === void 0) return state;
		return {
			...state,
			phases: {
				...state.phases,
				[event.data.phaseId]: {
					...existing,
					status: event.data.status,
					updatedAt: event.data.at
				}
			}
		};
	}
	if (event.type === "devflow/scope/update") return {
		...state,
		scope: event.data.scope
	};
	if (event.type === "devflow/scope/clear") return {
		...state,
		scope: null
	};
	if (event.type === "devflow/decision/request") return {
		...state,
		decisionRequests: upsertDecisionRequest(state.decisionRequests, event.data.request)
	};
	if (event.type === "devflow/decision/answer") {
		const decisionRequests = answerDecisionRequest(state.decisionRequests, event.data.requestId, event.data.answer, event.data.at);
		const request = decisionRequests[event.data.requestId];
		if (request?.trigger === "review-failed-twice" && request.taskId !== null) {
			const { [request.taskId]: _reset, ...reviewFailCounts } = state.reviewFailCounts;
			return {
				...state,
				decisionRequests,
				reviewFailCounts
			};
		}
		return {
			...state,
			decisionRequests
		};
	}
	if (event.type === "devflow/dispatch/diagnostic") return {
		...state,
		dispatchDiagnostics: upsertDispatchDiagnostic(state.dispatchDiagnostics ?? {}, event.data.diagnostic)
	};
	if (event.type === "devflow/commander/mode-enter") {
		const { commanderModeExitAt: _exit, ...rest } = state;
		return {
			...rest,
			commanderMode: "commander"
		};
	}
	if (event.type === "devflow/commander/mode-exit") return {
		...state,
		commanderMode: "chat",
		commanderModeExitAt: event.data.at
	};
	if (event.type === "devflow/control/pause") return {
		...state,
		paused: true
	};
	if (event.type === "devflow/control/resume") return {
		...state,
		paused: false
	};
	if (event.type === "devflow/improvement/add") return {
		...state,
		improvements: [...state.improvements, event.data.improvement]
	};
	if (event.type === "devflow/scope/boundary-hit") return {
		...state,
		scopeBoundaryHits: appendScopeBoundaryHit(state.scopeBoundaryHits, event.data.hit)
	};
	if (event.type === "devflow/commander/checkpoint/create") return {
		...state,
		commanderCheckpoints: upsertCheckpoint(state.commanderCheckpoints, event.data.checkpoint)
	};
	if (event.type === "devflow/commander/checkpoint/update") return {
		...state,
		commanderCheckpoints: patchCheckpoint(state.commanderCheckpoints, event.data.checkpointId, event.data.patch, event.data.at)
	};
	if (event.type === "devflow/orchestration/assign") return {
		...state,
		assignments: upsertAssignment(state.assignments, event.data.assignment)
	};
	if (event.type === "devflow/orchestration/unassign") return {
		...state,
		assignments: removeAssignment(state.assignments, event.data.assignmentId)
	};
	if (event.type === "devflow/orchestration/update") return {
		...state,
		assignments: patchAssignmentStatus(state.assignments, event.data.assignmentId, event.data.status, event.data.at, event.data.closeReason)
	};
	if (event.type === "devflow/orchestration/close") return {
		...state,
		assignments: patchAssignmentStatus(state.assignments, event.data.assignmentId, "closed", event.data.at, event.data.closeReason)
	};
	if (event.type === "devflow/commander/plan/create") return {
		...state,
		commanderPlans: upsertCommanderPlan(state.commanderPlans, event.data.plan)
	};
	if (event.type === "devflow/commander/plan/activate") return {
		...state,
		commanderPlans: activateCommanderPlan(state.commanderPlans, event.data.planningId, event.data.at)
	};
	if (event.type === "devflow/commander/plan/update") return {
		...state,
		commanderPlans: patchCommanderPlan(state.commanderPlans, event.data.planningId, event.data.patch, event.data.at)
	};
	if (event.type === "devflow/execution/batch/create") return {
		...state,
		executionBatches: upsertExecutionBatch(state.executionBatches, event.data.batch)
	};
	if (event.type === "devflow/execution/batch/start") return {
		...state,
		executionBatches: transitionExecutionBatch(state.executionBatches, event.data.batchId, "running", event.data.at)
	};
	if (event.type === "devflow/execution/batch/pause") return {
		...state,
		executionBatches: transitionExecutionBatch(state.executionBatches, event.data.batchId, "paused", event.data.at)
	};
	if (event.type === "devflow/execution/batch/complete") return {
		...state,
		executionBatches: transitionExecutionBatch(state.executionBatches, event.data.batchId, "completed", event.data.at)
	};
	if (event.type === "devflow/execution/start") return {
		...state,
		executions: upsertExecution(state.executions, event.data.execution)
	};
	if (event.type === "devflow/execution/update") return {
		...state,
		executions: transitionExecution(state.executions, event.data.executionId, event.data.status, event.data.at, event.data.closeReason)
	};
	if (event.type === "devflow/execution/close") return {
		...state,
		executions: transitionExecution(state.executions, event.data.executionId, "closed", event.data.at, event.data.closeReason)
	};
	if (event.type === "devflow/execution/complete") return {
		...state,
		executions: transitionExecution(state.executions, event.data.executionId, "completed", event.data.at)
	};
	if (event.type === "devflow/execution/fail") return {
		...state,
		executions: transitionExecution(state.executions, event.data.executionId, "failed", event.data.at)
	};
	if (event.type === "devflow/execution/attempt/create") return {
		...state,
		executionAttempts: upsertExecutionAttempt(state.executionAttempts, event.data.attempt)
	};
	if (event.type === "devflow/execution/attempt/start") return {
		...state,
		executionAttempts: transitionExecutionAttempt(state.executionAttempts, event.data.attemptId, "running", event.data.at)
	};
	if (event.type === "devflow/execution/attempt/complete") return {
		...state,
		executionAttempts: transitionExecutionAttempt(state.executionAttempts, event.data.attemptId, "completed", event.data.at)
	};
	if (event.type === "devflow/execution/attempt/fail") return {
		...state,
		executionAttempts: transitionExecutionAttempt(state.executionAttempts, event.data.attemptId, "failed", event.data.at)
	};
	if (event.type === "devflow/agent/report/create") return {
		...state,
		agentReports: upsertAgentReport(state.agentReports, event.data.report)
	};
	if (event.type === "devflow/blocked/report") return {
		...state,
		blockedReports: upsertBlockedReport(state.blockedReports ?? {}, event.data.blocked)
	};
	if (event.type === "devflow/agent/report/update") return {
		...state,
		agentReports: patchAgentReport(state.agentReports, event.data.reportId, event.data.patch, event.data.at)
	};
	if (event.type === "devflow/commander/decision/create") return {
		...state,
		commanderDecisions: upsertCommanderDecision(state.commanderDecisions, event.data.decision)
	};
	if (event.type === "devflow/commander/decision/update") return {
		...state,
		commanderDecisions: patchCommanderDecision(state.commanderDecisions, event.data.decisionId, event.data.patch, event.data.at)
	};
	if (event.type === "devflow/runtime/export") return {
		...state,
		runtimePackages: upsertRuntimePackage(state.runtimePackages, event.data.package)
	};
	if (event.type === "devflow/runtime/import") return {
		...state,
		runtimeResults: upsertRuntimeResult(state.runtimeResults, event.data.result)
	};
	if (event.type === "devflow/runtime/session/create") return {
		...state,
		runtimeSessions: upsertRuntimeSession(state.runtimeSessions, event.data.session)
	};
	if (event.type === "devflow/runtime/session/start") return {
		...state,
		runtimeSessions: transitionRuntimeSession(state.runtimeSessions, event.data.sessionId, "running", event.data.at)
	};
	if (event.type === "devflow/runtime/session/complete") return {
		...state,
		runtimeSessions: transitionRuntimeSession(state.runtimeSessions, event.data.sessionId, "completed", event.data.at)
	};
	if (event.type === "devflow/runtime/session/fail") return {
		...state,
		runtimeSessions: transitionRuntimeSession(state.runtimeSessions, event.data.sessionId, "failed", event.data.at)
	};
	if (event.type === "devflow/commander/action/create") return {
		...state,
		commanderActions: upsertCommanderAction(state.commanderActions, event.data.action)
	};
	if (event.type === "devflow/commander/action/execute") return {
		...state,
		commanderActions: transitionCommanderAction(state.commanderActions, event.data.actionId, "executing", event.data.at)
	};
	if (event.type === "devflow/commander/action/complete") return {
		...state,
		commanderActions: transitionCommanderAction(state.commanderActions, event.data.actionId, "completed", event.data.at)
	};
	if (event.type === "devflow/commander/review/create") return {
		...state,
		commanderReviews: upsertCommanderReview(state.commanderReviews, event.data.review)
	};
	if (event.type === "devflow/commander/review/complete") return {
		...state,
		commanderReviews: completeCommanderReview(state.commanderReviews, event.data.reviewId, event.data.at)
	};
	if (event.type === "devflow/memory/create") return {
		...state,
		commanderMemory: upsertCommanderMemory(state.commanderMemory, event.data.memory)
	};
	if (event.type === "devflow/memory/update") return {
		...state,
		commanderMemory: patchCommanderMemory(state.commanderMemory, event.data.memoryId, event.data.patch, event.data.at)
	};
	if (event.type === "devflow/commander/schedule/create") return {
		...state,
		commanderSchedules: upsertCommanderSchedule(state.commanderSchedules, event.data.schedule)
	};
	if (event.type === "devflow/commander/schedule/update") return {
		...state,
		commanderSchedules: patchCommanderSchedule(state.commanderSchedules, event.data.scheduleId, event.data.patch, event.data.at)
	};
	if (event.type === "devflow/commander/schedule/pause") return {
		...state,
		commanderSchedules: pauseCommanderSchedule(state.commanderSchedules, event.data.scheduleId, event.data.at)
	};
	if (event.type === "devflow/commander/run/create") return {
		...state,
		commanderRuns: upsertCommanderRun(state.commanderRuns, event.data.run)
	};
	if (event.type === "devflow/commander/run/complete") return {
		...state,
		commanderRuns: completeCommanderRun(state.commanderRuns, event.data.runId, event.data.decisionId, event.data.actionId, event.data.at)
	};
	if (event.type === "devflow/commander/run/fail") return {
		...state,
		commanderRuns: failCommanderRun(state.commanderRuns, event.data.runId, event.data.at)
	};
	if (event.type === "devflow/commander/action-execution/create") return {
		...state,
		commanderActionExecutions: upsertCommanderActionExecution(state.commanderActionExecutions, event.data.execution)
	};
	if (event.type === "devflow/commander/action-execution/complete") return {
		...state,
		commanderActionExecutions: completeCommanderActionExecution(state.commanderActionExecutions, event.data.executionId, event.data.at)
	};
	if (event.type === "devflow/commander/action-execution/fail") return {
		...state,
		commanderActionExecutions: failCommanderActionExecution(state.commanderActionExecutions, event.data.executionId, event.data.error, event.data.at)
	};
	if (event.type === "devflow/policy/update") return {
		...state,
		policies: upsertPolicy(state.policies, event.data.policy)
	};
	if (event.type === "devflow/commander/proposal/create") return {
		...state,
		commanderProposals: upsertCommanderProposal(state.commanderProposals, event.data.proposal)
	};
	if (event.type === "devflow/commander/proposal/approve") return {
		...state,
		commanderProposals: approveCommanderProposal(state.commanderProposals, event.data.proposalId, event.data.at)
	};
	if (event.type === "devflow/commander/proposal/reject") return {
		...state,
		commanderProposals: rejectCommanderProposal(state.commanderProposals, event.data.proposalId, event.data.at)
	};
	if (event.type === "devflow/commander/execution-context/create") return {
		...state,
		commanderExecutionContexts: upsertCommanderExecutionContext(state.commanderExecutionContexts, event.data.context)
	};
	if (event.type === "devflow/commander/workflow/create") return {
		...state,
		commanderWorkflows: upsertCommanderWorkflow(state.commanderWorkflows, event.data.workflow)
	};
	if (event.type === "devflow/commander/workflow/start") return {
		...state,
		commanderWorkflows: startCommanderWorkflow(state.commanderWorkflows, event.data.workflowId, event.data.at)
	};
	if (event.type === "devflow/commander/workflow/complete") return {
		...state,
		commanderWorkflows: completeCommanderWorkflow(state.commanderWorkflows, event.data.workflowId, event.data.at)
	};
	if (event.type === "devflow/commander/workflow/fail") return {
		...state,
		commanderWorkflows: failCommanderWorkflow(state.commanderWorkflows, event.data.workflowId, event.data.at)
	};
	if (event.type === "devflow/commander/workflow/execution/add") return {
		...state,
		commanderWorkflows: appendCommanderWorkflowExecution(state.commanderWorkflows, event.data.workflowId, event.data.entry, event.data.at)
	};
	if (event.type === "devflow/commander/step/create") return {
		...state,
		commanderWorkflowSteps: upsertCommanderWorkflowStep(state.commanderWorkflowSteps, event.data.step)
	};
	if (event.type === "devflow/commander/step/start") return {
		...state,
		commanderWorkflowSteps: startCommanderWorkflowStep(state.commanderWorkflowSteps, event.data.stepId, event.data.at)
	};
	if (event.type === "devflow/commander/step/complete") return {
		...state,
		commanderWorkflowSteps: completeCommanderWorkflowStep(state.commanderWorkflowSteps, event.data.stepId, event.data.at)
	};
	if (event.type === "devflow/commander/step/fail") return {
		...state,
		commanderWorkflowSteps: failCommanderWorkflowStep(state.commanderWorkflowSteps, event.data.stepId, event.data.at)
	};
	return state;
}
//#endregion
//#region lib/host/journal.js
/**
* Persist a post-mutation DevFlow audit fact in the plugin-owned journal.
*
* DevFlow events are never appended to Session: a third-party plugin cannot
* reliably extend the host persistence vocabulary. Official tool lifecycle
* records are independently produced by the dsh tool runtime and remain the
* only session-level conversation anchors.
*/
async function recordDevFlowChange(store, type, data) {
	let json;
	try {
		json = JSON.parse(JSON.stringify(data));
	} catch (error) {
		throw new Error(`devflow: cannot journal ${type}: data is not JSON-serializable`, { cause: error });
	}
	return store.appendJournal(type, json);
}
//#endregion
//#region lib/host/json.js
/**
* Shared JSON shape guards used at the durable-file and wire boundaries.
* @module @xiaoxie-ide/dsh-devflow/json
*/
/** Whether a parsed value is a plain object (not null, not an array). */
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Whether a parsed value is a string. */
function isString(value) {
	return typeof value === "string";
}
/** Whether a parsed value is an array of strings. */
function isStringArray(value) {
	return Array.isArray(value) && value.every(isString);
}
//#endregion
//#region lib/host/skill-binding.js
/**
* DevFlow Skill binding catalog and prompt assembly. Skill text is supplied
* by the caller after reading the catalog's repository file references.
* @module @xiaoxie-ide/dsh-devflow/skill-binding
*/
/** Skill ids and existing repository files approved for permanent prompt injection. */
const DEVFLOW_SKILLS = {
	"repository-conventions": {
		id: "repository-conventions",
		sourcePath: "AGENTS.md"
	},
	"defensive-patterns": {
		id: "defensive-patterns",
		sourcePath: "docs/defensive-patterns.md"
	},
	"testing-policy": {
		id: "testing-policy",
		sourcePath: "docs/testing.md"
	},
	"pre-push-checks": {
		id: "pre-push-checks",
		sourcePath: ".agents/skills/dsh-pre-push-checks/SKILL.md"
	},
	"code-review": {
		id: "code-review",
		sourcePath: ".agents/skills/dsh-code-review/SKILL.md"
	},
	"find-simplifications": {
		id: "find-simplifications",
		sourcePath: ".agents/skills/dsh-find-simplifications/SKILL.md"
	},
	"archify": {
		id: "archify",
		sourcePath: ".agents/skills/archify/SKILL.md"
	},
	"advise-project-approach": {
		id: "advise-project-approach",
		sourcePath: ".agents/skills/advise-project-approach/SKILL.md"
	},
	"api-and-interface-design": {
		id: "api-and-interface-design",
		sourcePath: ".agents/skills/api-and-interface-design/SKILL.md"
	},
	"documentation-and-adrs": {
		id: "documentation-and-adrs",
		sourcePath: ".agents/skills/documentation-and-adrs/SKILL.md"
	},
	"frontend-ui-engineering": {
		id: "frontend-ui-engineering",
		sourcePath: ".agents/skills/frontend-ui-engineering/SKILL.md"
	},
	"browser-testing-with-devtools": {
		id: "browser-testing-with-devtools",
		sourcePath: ".agents/skills/browser-testing-with-devtools/SKILL.md"
	}
};
/** Reject unknown Skill ids before an agent record is persisted or projected. */
function validateAgentSkills(skills, displayPath) {
	for (const skillId of skills) if (!(skillId in DEVFLOW_SKILLS)) throw new Error(`devflow: unknown skill id ${JSON.stringify(skillId)} in ${displayPath}`);
}
/**
* Append bound Skill contents to an agent's configured prompt. The caller
* must resolve every id in agent.skills and preserve that order.
* @param agent - agent whose configured prompt and Skill ids are authoritative.
* @param resolved - repository file contents corresponding to agent.skills.
* @returns the complete system prompt sent at every agent start.
*/
function assembleAgentPrompt(agent, resolved) {
	validateAgentSkills(agent.skills, "prompt assembly");
	if (resolved.length !== agent.skills.length || resolved.some((item, index) => item.id !== agent.skills[index])) throw new Error("devflow: resolved Skill contents do not match the agent Skill binding order");
	if (resolved.length === 0) return agent.prompt;
	const sections = resolved.map((item) => [
		`<!-- DEVFLOW SKILL START: ${item.id} -->`,
		item.content.trim(),
		`<!-- DEVFLOW SKILL END: ${item.id} -->`
	].join("\n"));
	return [agent.prompt.trim(), ...sections].join("\n\n");
}
//#endregion
//#region lib/host/storage.js
/**
* DevFlow file-backed storage. One `.devflow` root holds the single project
* context (`project.json`), one JSON file per task (`tasks/<id>.json`), and
* one JSON file per result (`results/<id>.json`). Every read and write goes
* through the `ctx.fs` seam — atomic writes with per-target locks and
* optional version guards — so swapping the storage backend means swapping
* the `ctx.fs` provider, never this module.
*
* The durable-file boundary is validated on both sides: writes reject
* malformed records before publication, and reads reject corrupted or
* unexpected JSON instead of returning it. Task/result ids are UUIDs and are
* format-checked before they enter a file path.
* @module @xiaoxie-ide/dsh-devflow/storage
*/
const JOURNAL_DIR = "journal";
const PROJECT_FILE = "project.json";
const TASKS_DIR = "tasks";
const RESULTS_DIR = "results";
const AGENTS_DIR = "agents";
const IMPORTS_DIR = "imports";
const FILE_SUFFIX = ".json";
const MARKDOWN_SUFFIX = ".md";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Per-journal-root tail that serializes local concurrent append operations. */
const journalTails = /* @__PURE__ */ new Map();
/** Agent instance ids are human-recognizable lowercase slugs, never UUIDs. */
const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const JOURNAL_HEAD_FILE = "head.json";
/** Root-relative journal head, in the backend-independent `/` form observers see. */
const JOURNAL_HEAD_RELATIVE = `${JOURNAL_DIR}/${JOURNAL_HEAD_FILE}`;
function isJsonValue(value) {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJsonValue);
	return isRecord(value) && Object.values(value).every(isJsonValue);
}
function validateJournalEntry(value, displayPath) {
	if (!isRecord(value) || typeof value.sequence !== "number" || !Number.isSafeInteger(value.sequence) || value.sequence < 0 || !isString(value.id) || !UUID_PATTERN.test(value.id) || !isString(value.type) || value.type.trim() === "" || !isJsonValue(value.data) || !isString(value.at)) throw new Error(`devflow: invalid journal entry in ${displayPath}`);
	return {
		sequence: value.sequence,
		id: value.id,
		type: value.type,
		data: value.data,
		at: value.at
	};
}
function validateJournalHead(value, displayPath) {
	if (!isRecord(value) || typeof value.nextSequence !== "number" || !Number.isSafeInteger(value.nextSequence) || value.nextSequence < 0) throw new Error(`devflow: invalid journal head in ${displayPath}`);
	return { nextSequence: value.nextSequence };
}
const TASK_STATUSES$1 = [
	"created",
	"planned",
	"executing",
	"reviewing",
	"completed",
	"failed",
	"cancelled"
];
const ASSIGNED_ROLES$1 = [
	"planner",
	"backend-engineer",
	"frontend-engineer",
	"reviewer"
];
const ORCHESTRATION_AGENTS_DIR = "orchestration-agents";
const MVP_FILE = "mvp.json";
const PHASES_DIR = "phases";
const SCOPE_FILE = "scope.json";
/** Directory holding one scope guard per task (`scopes/<taskId>.json`). */
const SCOPES_DIR = "scopes";
const IMPROVEMENTS_DIR = "improvements";
const AGENT_KINDS = ["fixed", "temporary"];
const FIXED_STATUSES = ["active"];
const TEMPORARY_STATUSES = [
	"created",
	"running",
	"terminated"
];
const PHASE_STATUSES$1 = [
	"planned",
	"in_progress",
	"completed"
];
/** Valid temporary-agent lifecycle transitions: created → running → terminated. */
const TEMPORARY_TRANSITIONS = {
	created: ["running"],
	running: ["terminated"],
	terminated: []
};
const CHECKPOINTS_DIR = "checkpoints";
const ASSIGNMENTS_DIR = "assignments";
const ASSIGNMENT_STATUSES = [
	"assigned",
	"in_progress",
	"completed",
	"closed"
];
/**
* Valid assignment transitions.
*
* `closed` is terminal and reachable from BOTH live states — a dispatch that never
* started is exactly as closeable as one that started and lost its carrier.
*
* `in_progress → assigned` is NOT an oversight: the dispatch failure path re-arms its
* own assignment before a retry (`tools.ts`, `restoredAssignment`), so that edge has
* always been in use. Adding `closed` must not silently forbid it, so it is named here
* explicitly — a transition the product relies on belongs in the table.
*/
const ASSIGNMENT_TRANSITIONS = {
	assigned: [
		"in_progress",
		"completed",
		"closed"
	],
	in_progress: [
		"assigned",
		"completed",
		"closed"
	],
	completed: [],
	closed: []
};
const PLANNING_DIR = "planning";
const BATCHES_DIR = "batches";
const COMMANDER_PLAN_STATUSES = [
	"draft",
	"active",
	"completed"
];
const EXECUTION_BATCH_STATUSES = [
	"planned",
	"running",
	"paused",
	"completed"
];
/** Valid execution-batch transitions: planned → running → paused/completed; paused → running. */
const EXECUTION_BATCH_TRANSITIONS = {
	planned: ["running"],
	running: ["paused", "completed"],
	paused: ["running"],
	completed: []
};
const EXECUTIONS_DIR = "executions";
const REPORTS_DIR = "reports";
const EXECUTION_STATUSES = [
	"pending",
	"running",
	"completed",
	"failed",
	"closed"
];
/**
* Valid execution transitions: pending → running → completed/failed, and → `closed`
* from either live state. `closed` is terminal and is the ONLY status that may be
* stamped with a close reason; the other terminal states already say what happened.
*/
const EXECUTION_TRANSITIONS = {
	pending: ["running", "closed"],
	running: [
		"completed",
		"failed",
		"closed"
	],
	completed: [],
	failed: [],
	closed: []
};
const AGENT_REPORT_STATUSES = [
	"success",
	"failed",
	"blocked"
];
const DECISIONS_DIR = "decisions";
const DECISION_TYPES = [
	"continue",
	"retry",
	"pause",
	"request_user"
];
const ACTIONS_DIR = "actions";
const ACTION_TYPES = [
	"start_batch",
	"pause_batch",
	"retry_execution",
	"complete_batch"
];
const ACTION_STATUSES = [
	"created",
	"executing",
	"completed"
];
/** Valid commander control-action transitions: created → executing → completed. */
const ACTION_TRANSITIONS = {
	created: ["executing"],
	executing: ["completed"],
	completed: []
};
const SESSIONS_DIR = "runtime-sessions";
const RUNTIME_SESSION_STATUSES = [
	"created",
	"running",
	"completed",
	"failed"
];
/** Valid runtime session transitions: created → running → completed/failed. */
const RUNTIME_SESSION_TRANSITIONS = {
	created: ["running"],
	running: ["completed", "failed"],
	completed: [],
	failed: []
};
const ATTEMPTS_DIR = "attempts";
const ATTEMPT_STATUSES = [
	"created",
	"running",
	"completed",
	"failed"
];
/** Valid execution attempt transitions: created → running → completed/failed. */
const ATTEMPT_TRANSITIONS = {
	created: ["running"],
	running: ["completed", "failed"],
	completed: [],
	failed: []
};
const REVIEWS_DIR = "reviews";
const REVIEW_STATUSES = ["pending", "reviewed"];
/** Valid commander review transitions: pending → reviewed. */
const REVIEW_TRANSITIONS = {
	pending: ["reviewed"],
	reviewed: []
};
const MEMORY_DIR = "memory";
const MEMORY_TYPES = [
	"project",
	"decision",
	"execution",
	"preference"
];
const SCHEDULES_DIR = "schedules";
const SCHEDULE_STATUSES = ["active", "paused"];
const RUNS_DIR = "runs";
const RUN_STATUSES = [
	"running",
	"completed",
	"failed"
];
/** Valid commander run transitions: running → completed/failed (terminal). */
const RUN_TRANSITIONS = {
	running: ["completed", "failed"],
	completed: [],
	failed: []
};
const ACTION_EXECUTIONS_DIR = "action-executions";
const ACTION_EXECUTION_STATUSES = [
	"running",
	"completed",
	"failed"
];
/** Valid commander action-execution transitions: running → completed/failed (terminal). */
const ACTION_EXECUTION_TRANSITIONS = {
	running: ["completed", "failed"],
	completed: [],
	failed: []
};
const POLICIES_DIR = "policies";
const RISK_LEVELS = [
	"low",
	"medium",
	"high"
];
const PROPOSALS_DIR = "proposals";
const PROPOSAL_STATUSES = [
	"created",
	"approved",
	"rejected"
];
/** Valid commander proposal transitions: created → approved/rejected (terminal). */
const PROPOSAL_TRANSITIONS = {
	created: ["approved", "rejected"],
	approved: [],
	rejected: []
};
const WORKFLOWS_DIR = "workflows";
const WORKFLOW_STATUSES = [
	"created",
	"running",
	"completed",
	"failed"
];
/** Valid commander workflow transitions: created → running → completed/failed (terminal). */
const WORKFLOW_TRANSITIONS = {
	created: ["running"],
	running: ["completed", "failed"],
	completed: [],
	failed: []
};
const STEPS_DIR = "steps";
const STEP_STATUSES = [
	"pending",
	"running",
	"completed",
	"failed"
];
/** Valid commander step transitions: pending → running → completed/failed (terminal). */
const STEP_TRANSITIONS = {
	pending: ["running"],
	running: ["completed", "failed"],
	completed: [],
	failed: []
};
/** Parse one stored JSON document; corrupted content fails loud, never silently drops. */
function parseJson(text, displayPath) {
	try {
		return JSON.parse(text);
	} catch (cause) {
		throw new Error(`devflow: corrupted JSON in ${displayPath}`, { cause });
	}
}
/** Validate one project record at the durable-file boundary. */
function validateProject(value, displayPath) {
	if (!isRecord(value)) throw new Error(`devflow: invalid project record in ${displayPath}`);
	const { id, name, goal, currentStage, createdAt, updatedAt } = value;
	if (!isString(id) || !isString(name) || !isString(goal) || !isString(currentStage) || !isString(createdAt) || !isString(updatedAt)) throw new Error(`devflow: invalid project fields in ${displayPath}`);
	return {
		id,
		name,
		goal,
		currentStage,
		createdAt,
		updatedAt
	};
}
/** Validate one task record at the durable-file boundary. */
function validateTask(value, displayPath) {
	if (!isRecord(value)) throw new Error(`devflow: invalid task record in ${displayPath}`);
	const { id, title, description, status, assignedRole, createdAt, updatedAt } = value;
	if (!isString(id) || !isString(title) || !isString(description) || !isString(status) || !isString(createdAt) || !isString(updatedAt)) throw new Error(`devflow: invalid task fields in ${displayPath}`);
	if (!TASK_STATUSES$1.includes(status)) throw new Error(`devflow: invalid task status ${JSON.stringify(status)} in ${displayPath}`);
	if (assignedRole !== void 0) {
		if (!ASSIGNED_ROLES$1.includes(assignedRole)) throw new Error(`devflow: invalid assigned role ${JSON.stringify(assignedRole)} in ${displayPath}`);
	}
	return {
		id,
		title,
		description,
		status,
		...assignedRole === void 0 ? {} : { assignedRole },
		createdAt,
		updatedAt
	};
}
/** Validate one result record at the durable-file boundary. */
function validateResult(value, displayPath) {
	if (!isRecord(value)) throw new Error(`devflow: invalid result record in ${displayPath}`);
	const { id, taskId, summary, changes, verification, issues, nextSteps, createdAt } = value;
	if (!isString(id) || !isString(taskId) || !isString(summary) || !isString(createdAt) || !isStringArray(changes) || !isStringArray(verification) || !isStringArray(issues) || !isStringArray(nextSteps)) throw new Error(`devflow: invalid result fields in ${displayPath}`);
	return {
		id,
		taskId,
		summary,
		changes,
		verification,
		issues,
		nextSteps,
		createdAt
	};
}
/** Reject ids that could escape the per-kind directory before they enter a path. */
function assertUuid(id, kind) {
	if (!UUID_PATTERN.test(id)) throw new Error(`devflow: invalid ${kind} id ${JSON.stringify(id)}`);
}
/** Reject agent instance ids that are not lowercase slugs (also blocks path traversal). */
function assertAgentId(id) {
	if (!AGENT_ID_PATTERN.test(id)) throw new Error(`devflow: invalid agent instance id ${JSON.stringify(id)}; expected a lowercase slug`);
}
/** Reject project ids that could escape the policies directory (also blocks path traversal). */
function assertProjectId(projectId) {
	if (!AGENT_ID_PATTERN.test(projectId)) throw new Error(`devflow: invalid project id ${JSON.stringify(projectId)}; expected a lowercase slug`);
}
/** Validate one agent instance record at the durable-file boundary. */
function validateAgentInstance(value, displayPath) {
	if (!isRecord(value)) throw new Error(`devflow: invalid agent instance record in ${displayPath}`);
	const { id, role, displayName, description, capabilities, metadata, createdAt, updatedAt } = value;
	if (!isString(id) || !AGENT_ID_PATTERN.test(id)) throw new Error(`devflow: invalid agent instance id in ${displayPath}`);
	if (!isString(role) || !ASSIGNED_ROLES$1.includes(role)) throw new Error(`devflow: invalid agent instance role ${JSON.stringify(role)} in ${displayPath}`);
	if (!isString(displayName) || displayName.trim() === "") throw new Error(`devflow: invalid agent instance displayName in ${displayPath}`);
	if (description !== void 0 && !isString(description)) throw new Error(`devflow: invalid agent instance description in ${displayPath}`);
	if (capabilities !== void 0 && !isStringArray(capabilities)) throw new Error(`devflow: invalid agent instance capabilities in ${displayPath}`);
	if (metadata !== void 0 && !isRecord(metadata)) throw new Error(`devflow: invalid agent instance metadata in ${displayPath}`);
	if (!isString(createdAt) || !isString(updatedAt)) throw new Error(`devflow: invalid agent instance timestamps in ${displayPath}`);
	return {
		id,
		role,
		displayName,
		...description === void 0 ? {} : { description },
		...capabilities === void 0 ? {} : { capabilities },
		...metadata === void 0 ? {} : { metadata },
		createdAt,
		updatedAt
	};
}
/** A tombstone marker for logically-removed records (fs has no delete primitive). */
function isTombstone(value) {
	return isRecord(value) && value.removed === true;
}
/** Validate one agent model-config record at the durable-file boundary. */
function validateModelConfig(value, displayPath) {
	if (!isRecord(value)) throw new Error(`devflow: invalid agent modelConfig in ${displayPath}`);
	const { model, provider, baseURL, apiKey, temperature, maxTokens, options } = value;
	if (!isString(model) || model.trim() === "") throw new Error(`devflow: invalid agent modelConfig.model in ${displayPath}`);
	if (provider !== void 0 && !isString(provider)) throw new Error(`devflow: invalid agent modelConfig.provider in ${displayPath}`);
	if (baseURL !== void 0 && !isString(baseURL)) throw new Error(`devflow: invalid agent modelConfig.baseURL in ${displayPath}`);
	if (apiKey !== void 0 && !isString(apiKey)) throw new Error(`devflow: invalid agent modelConfig.apiKey in ${displayPath}`);
	if (temperature !== void 0 && typeof temperature !== "number") throw new Error(`devflow: invalid agent modelConfig.temperature in ${displayPath}`);
	if (maxTokens !== void 0 && typeof maxTokens !== "number") throw new Error(`devflow: invalid agent modelConfig.maxTokens in ${displayPath}`);
	if (options !== void 0 && !isRecord(options)) throw new Error(`devflow: invalid agent modelConfig.options in ${displayPath}`);
	return {
		model,
		...provider === void 0 ? {} : { provider },
		...baseURL === void 0 ? {} : { baseURL },
		...apiKey === void 0 ? {} : { apiKey },
		...temperature === void 0 ? {} : { temperature },
		...maxTokens === void 0 ? {} : { maxTokens },
		...options === void 0 ? {} : { options }
	};
}
/** Validate one orchestration agent record at the durable-file boundary. */
function validateOrchestrationAgent(value, displayPath) {
	if (!isRecord(value)) throw new Error(`devflow: invalid orchestration agent record in ${displayPath}`);
	const { agentId, kind, role, status, prompt, modelConfig, tools, capabilities, skills, delegationDepth, createdAt, updatedAt } = value;
	if (!isString(agentId) || !AGENT_ID_PATTERN.test(agentId)) throw new Error(`devflow: invalid orchestration agent id in ${displayPath}`);
	if (!isString(kind) || !AGENT_KINDS.includes(kind)) throw new Error(`devflow: invalid orchestration agent kind ${JSON.stringify(kind)} in ${displayPath}`);
	if (!isString(role) || !ASSIGNED_ROLES$1.includes(role)) throw new Error(`devflow: invalid orchestration agent role ${JSON.stringify(role)} in ${displayPath}`);
	const allowedStatuses = kind === "fixed" ? FIXED_STATUSES : TEMPORARY_STATUSES;
	if (!isString(status) || !allowedStatuses.includes(status)) throw new Error(`devflow: invalid orchestration agent status ${JSON.stringify(status)} in ${displayPath}`);
	if (!isString(prompt)) throw new Error(`devflow: invalid orchestration agent prompt in ${displayPath}`);
	if (!isStringArray(tools)) throw new Error(`devflow: invalid orchestration agent tools in ${displayPath}`);
	if (!isStringArray(capabilities)) throw new Error(`devflow: invalid orchestration agent capabilities in ${displayPath}`);
	if (!isStringArray(skills)) throw new Error(`devflow: invalid orchestration agent skills in ${displayPath}`);
	validateAgentSkills(skills, displayPath);
	if (typeof delegationDepth !== "number" || !Number.isSafeInteger(delegationDepth) || delegationDepth < 0) throw new Error(`devflow: invalid orchestration agent delegationDepth in ${displayPath}`);
	if (!isString(createdAt) || !isString(updatedAt)) throw new Error(`devflow: invalid orchestration agent timestamps in ${displayPath}`);
	return {
		agentId,
		kind,
		role,
		status,
		prompt,
		modelConfig: validateModelConfig(modelConfig, displayPath),
		tools,
		capabilities,
		skills,
		delegationDepth,
		createdAt,
		updatedAt
	};
}
/** Validate one MVP plan record at the durable-file boundary. */
function validateMvpPlan(value, displayPath) {
	if (!isRecord(value)) throw new Error(`devflow: invalid mvp plan record in ${displayPath}`);
	const { goal, scope, phaseIds, createdAt, updatedAt } = value;
	if (!isString(goal) || !isStringArray(scope) || !isStringArray(phaseIds) || !isString(createdAt) || !isString(updatedAt)) throw new Error(`devflow: invalid mvp plan fields in ${displayPath}`);
	return {
		goal,
		scope,
		phaseIds,
		createdAt,
		updatedAt
	};
}
/** Validate one phase record at the durable-file boundary. */
function validatePhase(value, displayPath) {
	if (!isRecord(value)) throw new Error(`devflow: invalid phase record in ${displayPath}`);
	const { id, name, description, status, createdAt, updatedAt } = value;
	if (!isString(id) || !isString(name) || !isString(description) || !isString(status) || !isString(createdAt) || !isString(updatedAt)) throw new Error(`devflow: invalid phase fields in ${displayPath}`);
	if (!PHASE_STATUSES$1.includes(status)) throw new Error(`devflow: invalid phase status ${JSON.stringify(status)} in ${displayPath}`);
	return {
		id,
		name,
		description,
		status,
		createdAt,
		updatedAt
	};
}
/** Validate one scope guard record at the durable-file boundary. */
function validateScopeGuard(value, displayPath) {
	if (!isRecord(value)) throw new Error(`devflow: invalid scope guard record in ${displayPath}`);
	const { summary, inScope, maxModifiedFiles, maxToolSteps, completionCriteria, createdAt, updatedAt } = value;
	if (!isString(summary) || !isStringArray(inScope) || !isString(createdAt) || !isString(updatedAt)) throw new Error(`devflow: invalid scope guard fields in ${displayPath}`);
	if (typeof maxModifiedFiles !== "number" || !Number.isSafeInteger(maxModifiedFiles) || maxModifiedFiles < 1) throw new Error(`devflow: invalid scope guard maxModifiedFiles in ${displayPath}`);
	if (typeof maxToolSteps !== "number" || !Number.isSafeInteger(maxToolSteps) || maxToolSteps < 1) throw new Error(`devflow: invalid scope guard maxToolSteps in ${displayPath}`);
	if (!isStringArray(completionCriteria) || completionCriteria.length === 0 || completionCriteria.some((criterion) => criterion.trim() === "")) throw new Error(`devflow: invalid scope guard completionCriteria in ${displayPath}`);
	return {
		summary,
		inScope,
		maxModifiedFiles,
		maxToolSteps,
		completionCriteria,
		createdAt,
		updatedAt
	};
}
/** Validate one improvement record at the durable-file boundary. */
function validateImprovement(value, displayPath) {
	if (!isRecord(value)) throw new Error(`devflow: invalid improvement record in ${displayPath}`);
	const { id, title, description, createdAt } = value;
	if (!isString(id) || !isString(title) || !isString(description) || !isString(createdAt)) throw new Error(`devflow: invalid improvement fields in ${displayPath}`);
	return {
		id,
		title,
		description,
		createdAt
	};
}
/** Validate one commander checkpoint record at the durable-file boundary. */
function validateCommanderCheckpoint(value, displayPath) {
	if (!isRecord(value)) throw new Error(`devflow: invalid commander checkpoint record in ${displayPath}`);
	const { checkpointId, projectId, currentMvp, currentIteration, currentPhase, currentTask, completedItems, decisions, nextSteps, createdAt, updatedAt } = value;
	if (!isString(checkpointId)) throw new Error(`devflow: invalid commander checkpoint id in ${displayPath}`);
	if (!isString(projectId)) throw new Error(`devflow: invalid commander checkpoint projectId in ${displayPath}`);
	if (currentMvp !== null && !isString(currentMvp)) throw new Error(`devflow: invalid commander checkpoint currentMvp in ${displayPath}`);
	if (currentIteration !== null && !isString(currentIteration)) throw new Error(`devflow: invalid commander checkpoint currentIteration in ${displayPath}`);
	if (currentPhase !== null && !isString(currentPhase)) throw new Error(`devflow: invalid commander checkpoint currentPhase in ${displayPath}`);
	if (currentTask !== null && !isString(currentTask)) throw new Error(`devflow: invalid commander checkpoint currentTask in ${displayPath}`);
	if (!isStringArray(completedItems) || !isStringArray(decisions) || !isStringArray(nextSteps)) throw new Error(`devflow: invalid commander checkpoint string-array fields in ${displayPath}`);
	if (!isString(createdAt) || !isString(updatedAt)) throw new Error(`devflow: invalid commander checkpoint timestamps in ${displayPath}`);
	return {
		checkpointId,
		projectId,
		currentMvp,
		currentIteration,
		currentPhase,
		currentTask,
		completedItems,
		decisions,
		nextSteps,
		createdAt,
		updatedAt
	};
}
/** Validate one phase-assignment record at the durable-file boundary. */
function validatePhaseAssignment(value, displayPath) {
	if (!isRecord(value)) throw new Error(`devflow: invalid phase assignment record in ${displayPath}`);
	const { assignmentId, taskId, phaseId, agentId, role, status, closedAt, closeReason, createdAt, updatedAt } = value;
	if (!isString(assignmentId)) throw new Error(`devflow: invalid phase assignment id in ${displayPath}`);
	if (taskId !== void 0 && (!isString(taskId) || taskId.trim() === "")) throw new Error(`devflow: invalid phase assignment taskId in ${displayPath}`);
	if (!isString(phaseId)) throw new Error(`devflow: invalid phase assignment phaseId in ${displayPath}`);
	if (!isString(agentId) || !AGENT_ID_PATTERN.test(agentId)) throw new Error(`devflow: invalid phase assignment agentId in ${displayPath}`);
	if (!isString(role) || !ASSIGNED_ROLES$1.includes(role)) throw new Error(`devflow: invalid phase assignment role ${JSON.stringify(role)} in ${displayPath}`);
	if (!isString(status) || !ASSIGNMENT_STATUSES.includes(status)) throw new Error(`devflow: invalid phase assignment status ${JSON.stringify(status)} in ${displayPath}`);
	if (status === "closed") {
		if (!isString(closedAt) || !isDevFlowCloseReason(closeReason)) throw new Error(`devflow: closed phase assignment must carry closedAt and a close reason in ${displayPath}`);
	} else if (closedAt !== void 0 || closeReason !== void 0) throw new Error(`devflow: phase assignment carries a close stamp without being closed in ${displayPath}`);
	if (!isString(createdAt) || !isString(updatedAt)) throw new Error(`devflow: invalid phase assignment timestamps in ${displayPath}`);
	return {
		assignmentId,
		...taskId === void 0 ? {} : { taskId },
		phaseId,
		agentId,
		role,
		status,
		...status === "closed" ? {
			closedAt,
			closeReason
		} : {},
		createdAt,
		updatedAt
	};
}
/** Validate one commander plan record at the durable-file boundary. */
function validateCommanderPlan(value, displayPath) {
	if (!isRecord(value)) throw new Error(`devflow: invalid commander plan record in ${displayPath}`);
	const { planningId, projectId, goal, status, mvpPlanId, createdAt, updatedAt } = value;
	if (!isString(planningId)) throw new Error(`devflow: invalid commander plan id in ${displayPath}`);
	if (!isString(projectId)) throw new Error(`devflow: invalid commander plan projectId in ${displayPath}`);
	if (!isString(goal)) throw new Error(`devflow: invalid commander plan goal in ${displayPath}`);
	if (!isString(status) || !COMMANDER_PLAN_STATUSES.includes(status)) throw new Error(`devflow: invalid commander plan status ${JSON.stringify(status)} in ${displayPath}`);
	if (mvpPlanId !== null && !isString(mvpPlanId)) throw new Error(`devflow: invalid commander plan mvpPlanId in ${displayPath}`);
	if (!isString(createdAt) || !isString(updatedAt)) throw new Error(`devflow: invalid commander plan timestamps in ${displayPath}`);
	return {
		planningId,
		projectId,
		goal,
		status,
		mvpPlanId,
		createdAt,
		updatedAt
	};
}
/** Validate one execution batch record at the durable-file boundary. */
function validateExecutionBatch(value, displayPath) {
	if (!isRecord(value)) throw new Error(`devflow: invalid execution batch record in ${displayPath}`);
	const { batchId, projectId, planningId, phaseIds, assignmentIds, status, createdAt, updatedAt } = value;
	if (!isString(batchId)) throw new Error(`devflow: invalid execution batch id in ${displayPath}`);
	if (!isString(projectId)) throw new Error(`devflow: invalid execution batch projectId in ${displayPath}`);
	if (!isString(planningId)) throw new Error(`devflow: invalid execution batch planningId in ${displayPath}`);
	if (!isStringArray(phaseIds)) throw new Error(`devflow: invalid execution batch phaseIds in ${displayPath}`);
	if (!isStringArray(assignmentIds)) throw new Error(`devflow: invalid execution batch assignmentIds in ${displayPath}`);
	if (!isString(status) || !EXECUTION_BATCH_STATUSES.includes(status)) throw new Error(`devflow: invalid execution batch status ${JSON.stringify(status)} in ${displayPath}`);
	if (!isString(createdAt) || !isString(updatedAt)) throw new Error(`devflow: invalid execution batch timestamps in ${displayPath}`);
	return {
		batchId,
		projectId,
		planningId,
		phaseIds,
		assignmentIds,
		status,
		createdAt,
		updatedAt
	};
}
/** Validate an optional task-level ScopeGuard override at the durable-file boundary. */
function validateTaskScopeGuard(value, displayPath) {
	if (value === void 0) return void 0;
	if (!isRecord(value)) throw new Error(`devflow: invalid task scope guard in ${displayPath}`);
	const { maxModifiedFiles, maxToolSteps, completionCriteria } = value;
	if (typeof maxModifiedFiles !== "number" || !Number.isSafeInteger(maxModifiedFiles) || maxModifiedFiles < 1 || typeof maxToolSteps !== "number" || !Number.isSafeInteger(maxToolSteps) || maxToolSteps < 1 || !isStringArray(completionCriteria) || completionCriteria.length === 0 || completionCriteria.some((criterion) => criterion.trim() === "")) throw new Error(`devflow: invalid task scope guard fields in ${displayPath}`);
	return {
		maxModifiedFiles,
		maxToolSteps,
		completionCriteria
	};
}
/** Validate one execution record at the durable-file boundary. */
function validateExecutionRecord(value, displayPath) {
	if (!isRecord(value)) throw new Error(`devflow: invalid execution record in ${displayPath}`);
	const { executionId, batchId, assignmentId, agentId, taskId, scopeGuard, status, startedAt, completedAt, closedAt, closeReason, createdAt, updatedAt } = value;
	if (!isString(executionId)) throw new Error(`devflow: invalid execution id in ${displayPath}`);
	if (!isString(batchId)) throw new Error(`devflow: invalid execution batchId in ${displayPath}`);
	if (!isString(assignmentId)) throw new Error(`devflow: invalid execution assignmentId in ${displayPath}`);
	if (!isString(agentId) || !AGENT_ID_PATTERN.test(agentId)) throw new Error(`devflow: invalid execution agentId in ${displayPath}`);
	if (taskId !== void 0 && (!isString(taskId) || taskId.trim() === "")) throw new Error(`devflow: invalid execution taskId in ${displayPath}`);
	const validatedScopeGuard = validateTaskScopeGuard(scopeGuard, displayPath);
	if (!isString(status) || !EXECUTION_STATUSES.includes(status)) throw new Error(`devflow: invalid execution status ${JSON.stringify(status)} in ${displayPath}`);
	if (startedAt !== null && !isString(startedAt)) throw new Error(`devflow: invalid execution startedAt in ${displayPath}`);
	if (completedAt !== null && !isString(completedAt)) throw new Error(`devflow: invalid execution completedAt in ${displayPath}`);
	if (status === "closed") {
		if (!isString(closedAt) || !isDevFlowCloseReason(closeReason)) throw new Error(`devflow: closed execution must carry closedAt and a close reason in ${displayPath}`);
	} else if (closedAt !== void 0 || closeReason !== void 0) throw new Error(`devflow: execution carries a close stamp without being closed in ${displayPath}`);
	if (!isString(createdAt) || !isString(updatedAt)) throw new Error(`devflow: invalid execution timestamps in ${displayPath}`);
	return {
		executionId,
		batchId,
		assignmentId,
		agentId,
		...taskId === void 0 ? {} : { taskId },
		...validatedScopeGuard === void 0 ? {} : { scopeGuard: validatedScopeGuard },
		status,
		startedAt,
		completedAt,
		...status === "closed" ? {
			closedAt,
			closeReason
		} : {},
		createdAt,
		updatedAt
	};
}
/** Validate one agent report record at the durable-file boundary. */
function validateAgentReport(value, displayPath) {
	if (!isRecord(value)) throw new Error(`devflow: invalid agent report record in ${displayPath}`);
	const { reportId, executionId, agentId, status, summary, outputReference, modifiedFiles, toolStepCount, completedCriteria, createdAt, updatedAt } = value;
	if (!isString(reportId)) throw new Error(`devflow: invalid agent report id in ${displayPath}`);
	if (!isString(executionId)) throw new Error(`devflow: invalid agent report executionId in ${displayPath}`);
	if (!isString(agentId) || !AGENT_ID_PATTERN.test(agentId)) throw new Error(`devflow: invalid agent report agentId in ${displayPath}`);
	if (!isString(status) || !AGENT_REPORT_STATUSES.includes(status)) throw new Error(`devflow: invalid agent report status ${JSON.stringify(status)} in ${displayPath}`);
	if (!isString(summary)) throw new Error(`devflow: invalid agent report summary in ${displayPath}`);
	if (!isString(outputReference)) throw new Error(`devflow: invalid agent report outputReference in ${displayPath}`);
	if (modifiedFiles !== void 0 && !isStringArray(modifiedFiles)) throw new Error(`devflow: invalid agent report modifiedFiles in ${displayPath}`);
	if (toolStepCount !== void 0 && (typeof toolStepCount !== "number" || !Number.isSafeInteger(toolStepCount) || toolStepCount < 0)) throw new Error(`devflow: invalid agent report toolStepCount in ${displayPath}`);
	if (completedCriteria !== void 0 && !isStringArray(completedCriteria)) throw new Error(`devflow: invalid agent report completedCriteria in ${displayPath}`);
	if (!isString(createdAt) || !isString(updatedAt)) throw new Error(`devflow: invalid agent report timestamps in ${displayPath}`);
	return {
		reportId,
		executionId,
		agentId,
		status,
		summary,
		outputReference,
		...modifiedFiles === void 0 ? {} : { modifiedFiles },
		...toolStepCount === void 0 ? {} : { toolStepCount },
		...completedCriteria === void 0 ? {} : { completedCriteria },
		createdAt,
		updatedAt
	};
}
/** Validate one commander decision record at the durable-file boundary. */
function validateCommanderDecision(value, displayPath) {
	if (!isRecord(value)) throw new Error(`devflow: invalid commander decision record in ${displayPath}`);
	const { decisionId, projectId, checkpointId, relatedExecutionIds, decisionType, summary, nextAction, createdAt, updatedAt } = value;
	if (!isString(decisionId)) throw new Error(`devflow: invalid commander decision id in ${displayPath}`);
	if (!isString(projectId)) throw new Error(`devflow: invalid commander decision projectId in ${displayPath}`);
	if (checkpointId !== null && !isString(checkpointId)) throw new Error(`devflow: invalid commander decision checkpointId in ${displayPath}`);
	if (!isStringArray(relatedExecutionIds)) throw new Error(`devflow: invalid commander decision relatedExecutionIds in ${displayPath}`);
	if (!isString(decisionType) || !DECISION_TYPES.includes(decisionType)) throw new Error(`devflow: invalid commander decision type ${JSON.stringify(decisionType)} in ${displayPath}`);
	if (!isString(summary)) throw new Error(`devflow: invalid commander decision summary in ${displayPath}`);
	if (!isString(nextAction)) throw new Error(`devflow: invalid commander decision nextAction in ${displayPath}`);
	if (!isString(createdAt) || !isString(updatedAt)) throw new Error(`devflow: invalid commander decision timestamps in ${displayPath}`);
	return {
		decisionId,
		projectId,
		checkpointId,
		relatedExecutionIds,
		decisionType,
		summary,
		nextAction,
		createdAt,
		updatedAt
	};
}
/** Validate one commander control action record at the durable-file boundary. */
function validateCommanderAction(value, displayPath) {
	if (!isRecord(value)) throw new Error(`devflow: invalid commander action record in ${displayPath}`);
	const { actionId, decisionId, actionType, targetId, status, createdAt, updatedAt } = value;
	if (!isString(actionId)) throw new Error(`devflow: invalid commander action id in ${displayPath}`);
	if (!isString(decisionId)) throw new Error(`devflow: invalid commander action decisionId in ${displayPath}`);
	if (!isString(actionType) || !ACTION_TYPES.includes(actionType)) throw new Error(`devflow: invalid commander action type ${JSON.stringify(actionType)} in ${displayPath}`);
	if (!isString(targetId) || targetId.trim() === "") throw new Error(`devflow: invalid commander action targetId in ${displayPath}`);
	if (!isString(status) || !ACTION_STATUSES.includes(status)) throw new Error(`devflow: invalid commander action status ${JSON.stringify(status)} in ${displayPath}`);
	if (!isString(createdAt) || !isString(updatedAt)) throw new Error(`devflow: invalid commander action timestamps in ${displayPath}`);
	return {
		actionId,
		decisionId,
		actionType,
		targetId,
		status,
		createdAt,
		updatedAt
	};
}
/** Validate one runtime session record at the durable-file boundary. */
function validateRuntimeSession(value, displayPath) {
	if (!isRecord(value)) throw new Error(`devflow: invalid runtime session record in ${displayPath}`);
	const { sessionId, executionId, agentId, status, startedAt, completedAt, metadata, createdAt, updatedAt } = value;
	if (!isString(sessionId)) throw new Error(`devflow: invalid runtime session id in ${displayPath}`);
	if (!isString(executionId)) throw new Error(`devflow: invalid runtime session executionId in ${displayPath}`);
	if (!isString(agentId) || !AGENT_ID_PATTERN.test(agentId)) throw new Error(`devflow: invalid runtime session agentId in ${displayPath}`);
	if (!isString(status) || !RUNTIME_SESSION_STATUSES.includes(status)) throw new Error(`devflow: invalid runtime session status ${JSON.stringify(status)} in ${displayPath}`);
	if (startedAt !== null && !isString(startedAt)) throw new Error(`devflow: invalid runtime session startedAt in ${displayPath}`);
	if (completedAt !== null && !isString(completedAt)) throw new Error(`devflow: invalid runtime session completedAt in ${displayPath}`);
	if (!isRecord(metadata)) throw new Error(`devflow: invalid runtime session metadata in ${displayPath}`);
	if (!isString(createdAt) || !isString(updatedAt)) throw new Error(`devflow: invalid runtime session timestamps in ${displayPath}`);
	return {
		sessionId,
		executionId,
		agentId,
		status,
		startedAt,
		completedAt,
		metadata,
		createdAt,
		updatedAt
	};
}
/** Validate one execution attempt record at the durable-file boundary. */
function validateExecutionAttempt(value, displayPath) {
	if (!isRecord(value)) throw new Error(`devflow: invalid execution attempt record in ${displayPath}`);
	const { attemptId, executionId, parentAttemptId, status, reason, createdAt, completedAt, updatedAt } = value;
	if (!isString(attemptId)) throw new Error(`devflow: invalid execution attempt id in ${displayPath}`);
	if (!isString(executionId)) throw new Error(`devflow: invalid execution attempt executionId in ${displayPath}`);
	if (parentAttemptId !== null && !isString(parentAttemptId)) throw new Error(`devflow: invalid execution attempt parentAttemptId in ${displayPath}`);
	if (!isString(status) || !ATTEMPT_STATUSES.includes(status)) throw new Error(`devflow: invalid execution attempt status ${JSON.stringify(status)} in ${displayPath}`);
	if (reason !== null && !isString(reason)) throw new Error(`devflow: invalid execution attempt reason in ${displayPath}`);
	if (!isString(createdAt)) throw new Error(`devflow: invalid execution attempt createdAt in ${displayPath}`);
	if (completedAt !== null && !isString(completedAt)) throw new Error(`devflow: invalid execution attempt completedAt in ${displayPath}`);
	if (!isString(updatedAt)) throw new Error(`devflow: invalid execution attempt updatedAt in ${displayPath}`);
	return {
		attemptId,
		executionId,
		parentAttemptId,
		status,
		reason,
		createdAt,
		completedAt,
		updatedAt
	};
}
/** Validate one commander review record at the durable-file boundary. */
function validateCommanderReview(value, displayPath) {
	if (!isRecord(value)) throw new Error(`devflow: invalid commander review record in ${displayPath}`);
	const { reviewId, projectId, reportId, executionId, status, summary, createdAt, updatedAt } = value;
	if (!isString(reviewId)) throw new Error(`devflow: invalid commander review id in ${displayPath}`);
	if (!isString(projectId)) throw new Error(`devflow: invalid commander review projectId in ${displayPath}`);
	if (!isString(reportId)) throw new Error(`devflow: invalid commander review reportId in ${displayPath}`);
	if (!isString(executionId)) throw new Error(`devflow: invalid commander review executionId in ${displayPath}`);
	if (!isString(status) || !REVIEW_STATUSES.includes(status)) throw new Error(`devflow: invalid commander review status ${JSON.stringify(status)} in ${displayPath}`);
	if (!isString(summary)) throw new Error(`devflow: invalid commander review summary in ${displayPath}`);
	if (!isString(createdAt) || !isString(updatedAt)) throw new Error(`devflow: invalid commander review timestamps in ${displayPath}`);
	return {
		reviewId,
		projectId,
		reportId,
		executionId,
		status,
		summary,
		createdAt,
		updatedAt
	};
}
/** Validate one commander memory record at the durable-file boundary. */
function validateCommanderMemory(value, displayPath) {
	if (!isRecord(value)) throw new Error(`devflow: invalid commander memory record in ${displayPath}`);
	const { memoryId, projectId, memoryType, content, source, createdAt, updatedAt } = value;
	if (!isString(memoryId)) throw new Error(`devflow: invalid commander memory id in ${displayPath}`);
	if (!isString(projectId)) throw new Error(`devflow: invalid commander memory projectId in ${displayPath}`);
	if (!isString(memoryType) || !MEMORY_TYPES.includes(memoryType)) throw new Error(`devflow: invalid commander memory type ${JSON.stringify(memoryType)} in ${displayPath}`);
	if (!isString(content) || content.trim() === "") throw new Error(`devflow: invalid commander memory content in ${displayPath}`);
	if (!isString(source) || source.trim() === "") throw new Error(`devflow: invalid commander memory source in ${displayPath}`);
	if (!isString(createdAt) || !isString(updatedAt)) throw new Error(`devflow: invalid commander memory timestamps in ${displayPath}`);
	return {
		memoryId,
		projectId,
		memoryType,
		content,
		source,
		createdAt,
		updatedAt
	};
}
/** Validate one commander schedule record at the durable-file boundary. */
function validateCommanderSchedule(value, displayPath) {
	if (!isRecord(value)) throw new Error(`devflow: invalid commander schedule record in ${displayPath}`);
	const { scheduleId, projectId, status, interval, lastRunAt, nextRunAt, createdAt, updatedAt } = value;
	if (!isString(scheduleId)) throw new Error(`devflow: invalid commander schedule id in ${displayPath}`);
	if (!isString(projectId)) throw new Error(`devflow: invalid commander schedule projectId in ${displayPath}`);
	if (!isString(status) || !SCHEDULE_STATUSES.includes(status)) throw new Error(`devflow: invalid commander schedule status ${JSON.stringify(status)} in ${displayPath}`);
	if (typeof interval !== "number" || !Number.isFinite(interval) || interval <= 0) throw new Error(`devflow: invalid commander schedule interval in ${displayPath}`);
	if (lastRunAt !== null && !isString(lastRunAt)) throw new Error(`devflow: invalid commander schedule lastRunAt in ${displayPath}`);
	if (!isString(nextRunAt)) throw new Error(`devflow: invalid commander schedule nextRunAt in ${displayPath}`);
	if (!isString(createdAt) || !isString(updatedAt)) throw new Error(`devflow: invalid commander schedule timestamps in ${displayPath}`);
	return {
		scheduleId,
		projectId,
		status,
		interval,
		lastRunAt,
		nextRunAt,
		createdAt,
		updatedAt
	};
}
/**
* Apply one schedule patch: an interval change or a completed-run stamp rolls
* `nextRunAt` forward from the last run (or the patch time when no run exists).
* @param existing - the schedule being patched.
* @param patch - the fields to apply; omitted keys stay untouched.
* @param at - the patch time (ISO 8601).
* @returns the updated schedule.
*/
function applySchedulePatch(existing, patch, at) {
	const interval = patch.interval ?? existing.interval;
	const lastRunAt = patch.markRunAt !== void 0 ? patch.markRunAt : existing.lastRunAt;
	const rollBase = patch.markRunAt !== void 0 ? patch.markRunAt : lastRunAt ?? at;
	const nextRunAt = patch.interval !== void 0 || patch.markRunAt !== void 0 ? new Date(Date.parse(rollBase) + interval).toISOString() : existing.nextRunAt;
	return {
		...existing,
		interval,
		lastRunAt,
		nextRunAt,
		updatedAt: at
	};
}
/** Validate one commander run record at the durable-file boundary. */
function validateCommanderRunRecord(value, displayPath) {
	if (!isRecord(value)) throw new Error(`devflow: invalid commander run record in ${displayPath}`);
	const { runId, projectId, scheduleId, status, decisionId, actionId, startedAt, completedAt, updatedAt } = value;
	if (!isString(runId)) throw new Error(`devflow: invalid commander run id in ${displayPath}`);
	if (!isString(projectId)) throw new Error(`devflow: invalid commander run projectId in ${displayPath}`);
	if (!isString(scheduleId)) throw new Error(`devflow: invalid commander run scheduleId in ${displayPath}`);
	if (!isString(status) || !RUN_STATUSES.includes(status)) throw new Error(`devflow: invalid commander run status ${JSON.stringify(status)} in ${displayPath}`);
	if (decisionId !== null && !isString(decisionId)) throw new Error(`devflow: invalid commander run decisionId in ${displayPath}`);
	if (actionId !== null && !isString(actionId)) throw new Error(`devflow: invalid commander run actionId in ${displayPath}`);
	if (!isString(startedAt)) throw new Error(`devflow: invalid commander run startedAt in ${displayPath}`);
	if (completedAt !== null && !isString(completedAt)) throw new Error(`devflow: invalid commander run completedAt in ${displayPath}`);
	if (!isString(updatedAt)) throw new Error(`devflow: invalid commander run updatedAt in ${displayPath}`);
	return {
		runId,
		projectId,
		scheduleId,
		status,
		decisionId,
		actionId,
		startedAt,
		completedAt,
		updatedAt
	};
}
/** Validate one commander action execution record at the durable-file boundary. */
function validateCommanderActionExecution(value, displayPath) {
	if (!isRecord(value)) throw new Error(`devflow: invalid commander action execution record in ${displayPath}`);
	const { executionId, actionId, status, success, error, createdAt, completedAt, updatedAt } = value;
	if (!isString(executionId)) throw new Error(`devflow: invalid commander action execution id in ${displayPath}`);
	if (!isString(actionId)) throw new Error(`devflow: invalid commander action execution actionId in ${displayPath}`);
	if (!isString(status) || !ACTION_EXECUTION_STATUSES.includes(status)) throw new Error(`devflow: invalid commander action execution status ${JSON.stringify(status)} in ${displayPath}`);
	if (success !== null && typeof success !== "boolean") throw new Error(`devflow: invalid commander action execution success in ${displayPath}`);
	if (error !== null && !isString(error)) throw new Error(`devflow: invalid commander action execution error in ${displayPath}`);
	if (!isString(createdAt)) throw new Error(`devflow: invalid commander action execution createdAt in ${displayPath}`);
	if (completedAt !== null && !isString(completedAt)) throw new Error(`devflow: invalid commander action execution completedAt in ${displayPath}`);
	if (!isString(updatedAt)) throw new Error(`devflow: invalid commander action execution updatedAt in ${displayPath}`);
	return {
		executionId,
		actionId,
		status,
		success,
		error,
		createdAt,
		completedAt,
		updatedAt
	};
}
/** Validate one commander policy record at the durable-file boundary. */
function validateCommanderPolicy(value, displayPath) {
	if (!isRecord(value)) throw new Error(`devflow: invalid commander policy record in ${displayPath}`);
	const { projectId, maxRetryCount, allowedActionTypes, requireApprovalActionTypes, riskLevel, createdAt, updatedAt } = value;
	if (!isString(projectId) || !AGENT_ID_PATTERN.test(projectId)) throw new Error(`devflow: invalid commander policy projectId in ${displayPath}`);
	if (typeof maxRetryCount !== "number" || !Number.isInteger(maxRetryCount) || maxRetryCount < 0) throw new Error(`devflow: invalid commander policy maxRetryCount in ${displayPath}`);
	if (!isStringArray(allowedActionTypes) || !allowedActionTypes.every((type) => ACTION_TYPES.includes(type))) throw new Error(`devflow: invalid commander policy allowedActionTypes in ${displayPath}`);
	if (!isStringArray(requireApprovalActionTypes) || !requireApprovalActionTypes.every((type) => ACTION_TYPES.includes(type))) throw new Error(`devflow: invalid commander policy requireApprovalActionTypes in ${displayPath}`);
	if (!isString(riskLevel) || !RISK_LEVELS.includes(riskLevel)) throw new Error(`devflow: invalid commander policy riskLevel in ${displayPath}`);
	if (!isString(createdAt) || !isString(updatedAt)) throw new Error(`devflow: invalid commander policy timestamps in ${displayPath}`);
	return {
		projectId,
		maxRetryCount,
		allowedActionTypes,
		requireApprovalActionTypes,
		riskLevel,
		createdAt,
		updatedAt
	};
}
/** Validate one commander proposal record at the durable-file boundary. */
function validateCommanderProposal(value, displayPath) {
	if (!isRecord(value)) throw new Error(`devflow: invalid commander proposal record in ${displayPath}`);
	const { proposalId, decisionId, actionType, targetId, riskLevel, status, createdAt, updatedAt } = value;
	if (!isString(proposalId)) throw new Error(`devflow: invalid commander proposal id in ${displayPath}`);
	if (!isString(decisionId)) throw new Error(`devflow: invalid commander proposal decisionId in ${displayPath}`);
	if (!isString(actionType) || !ACTION_TYPES.includes(actionType)) throw new Error(`devflow: invalid commander proposal actionType in ${displayPath}`);
	if (!isString(targetId) || targetId.trim() === "") throw new Error(`devflow: invalid commander proposal targetId in ${displayPath}`);
	if (!isString(riskLevel) || !RISK_LEVELS.includes(riskLevel)) throw new Error(`devflow: invalid commander proposal riskLevel in ${displayPath}`);
	if (!isString(status) || !PROPOSAL_STATUSES.includes(status)) throw new Error(`devflow: invalid commander proposal status in ${displayPath}`);
	if (!isString(createdAt) || !isString(updatedAt)) throw new Error(`devflow: invalid commander proposal timestamps in ${displayPath}`);
	return {
		proposalId,
		decisionId,
		actionType,
		targetId,
		riskLevel,
		status,
		createdAt,
		updatedAt
	};
}
/** Validate one workflow execution-history entry at the durable-file boundary. */
function validateCommanderWorkflowExecution(value, displayPath) {
	if (!isRecord(value)) throw new Error(`devflow: invalid workflow execution entry in ${displayPath}`);
	const { entryId, stepId, decisionId, proposalId, approved, contextId, actionExecutionId, result, feedbackId, createdAt } = value;
	if (!isString(entryId)) throw new Error(`devflow: invalid workflow execution entryId in ${displayPath}`);
	if (stepId !== null && !isString(stepId)) throw new Error(`devflow: invalid workflow execution stepId in ${displayPath}`);
	if (!isString(decisionId)) throw new Error(`devflow: invalid workflow execution decisionId in ${displayPath}`);
	if (proposalId !== null && !isString(proposalId)) throw new Error(`devflow: invalid workflow execution proposalId in ${displayPath}`);
	if (typeof approved !== "boolean") throw new Error(`devflow: invalid workflow execution approved in ${displayPath}`);
	if (contextId !== null && !isString(contextId)) throw new Error(`devflow: invalid workflow execution contextId in ${displayPath}`);
	if (actionExecutionId !== null && !isString(actionExecutionId)) throw new Error(`devflow: invalid workflow execution actionExecutionId in ${displayPath}`);
	let resultSnapshot = null;
	if (result !== null) {
		if (!isRecord(result)) throw new Error(`devflow: invalid workflow execution result in ${displayPath}`);
		const { success, error } = result;
		if (typeof success !== "boolean" || error !== null && !isString(error)) throw new Error(`devflow: invalid workflow execution result in ${displayPath}`);
		resultSnapshot = {
			success,
			error: error === null ? null : error
		};
	}
	if (feedbackId !== null && !isString(feedbackId)) throw new Error(`devflow: invalid workflow execution feedbackId in ${displayPath}`);
	if (!isString(createdAt)) throw new Error(`devflow: invalid workflow execution createdAt in ${displayPath}`);
	return {
		entryId,
		stepId,
		decisionId,
		proposalId,
		approved,
		contextId,
		actionExecutionId,
		result: resultSnapshot,
		feedbackId,
		createdAt
	};
}
/** Validate one commander workflow record at the durable-file boundary. */
function validateCommanderWorkflow(value, displayPath) {
	if (!isRecord(value)) throw new Error(`devflow: invalid commander workflow record in ${displayPath}`);
	const { workflowId, projectId, title, description, status, history, createdAt, updatedAt } = value;
	if (!isString(workflowId)) throw new Error(`devflow: invalid commander workflow id in ${displayPath}`);
	if (!isString(projectId)) throw new Error(`devflow: invalid commander workflow projectId in ${displayPath}`);
	if (!isString(title) || title.trim() === "") throw new Error(`devflow: invalid commander workflow title in ${displayPath}`);
	if (!isString(description)) throw new Error(`devflow: invalid commander workflow description in ${displayPath}`);
	if (!isString(status) || !WORKFLOW_STATUSES.includes(status)) throw new Error(`devflow: invalid commander workflow status ${JSON.stringify(status)} in ${displayPath}`);
	if (!Array.isArray(history)) throw new Error(`devflow: invalid commander workflow history in ${displayPath}`);
	const entries = history.map((entry) => validateCommanderWorkflowExecution(entry, displayPath));
	if (!isString(createdAt) || !isString(updatedAt)) throw new Error(`devflow: invalid commander workflow timestamps in ${displayPath}`);
	return {
		workflowId,
		projectId,
		title,
		description,
		status,
		history: entries,
		createdAt,
		updatedAt
	};
}
/** Validate one commander workflow step record at the durable-file boundary. */
function validateCommanderWorkflowStep(value, displayPath) {
	if (!isRecord(value)) throw new Error(`devflow: invalid commander workflow step record in ${displayPath}`);
	const { stepId, workflowId, stepIndex, title, status, createdAt, updatedAt } = value;
	if (!isString(stepId)) throw new Error(`devflow: invalid commander workflow step id in ${displayPath}`);
	if (!isString(workflowId)) throw new Error(`devflow: invalid commander workflow step workflowId in ${displayPath}`);
	if (typeof stepIndex !== "number" || !Number.isInteger(stepIndex) || stepIndex < 0) throw new Error(`devflow: invalid commander workflow step stepIndex in ${displayPath}`);
	if (!isString(title) || title.trim() === "") throw new Error(`devflow: invalid commander workflow step title in ${displayPath}`);
	if (!isString(status) || !STEP_STATUSES.includes(status)) throw new Error(`devflow: invalid commander workflow step status ${JSON.stringify(status)} in ${displayPath}`);
	if (!isString(createdAt) || !isString(updatedAt)) throw new Error(`devflow: invalid commander workflow step timestamps in ${displayPath}`);
	return {
		stepId,
		workflowId,
		stepIndex,
		title,
		status,
		createdAt,
		updatedAt
	};
}
/**
* File-backed DevFlow store over the `ctx.fs` seam.
* @param fs - the filesystem backend all storage I/O goes through.
* @param root - the `.devflow` root; a relative path resolves against the
*   backend's cwd, an absolute path is used verbatim.
*/
var DevFlowStore = class {
	fs;
	root;
	onChange;
	sandboxPolicyOf;
	/** The committed journal id index at one observed head sequence. */
	journalIdCache;
	/** Cached absolute store root, resolved once; see {@link relativeToRoot}. */
	absoluteRoot = null;
	/**
	* Meaning of the journal record whose ENTRY has just been written but whose head
	* has not advanced yet.
	*
	* It is parked here so the head write — the report that already carries the durable
	* sequence — can publish both facts as ONE signal. Reporting the record on its own
	* would race the head report across the coalescing window, and the client would then
	* receive a frame that says "nothing you can see changed" immediately before the
	* frame that explains the change. One commit must produce one frame.
	*/
	pendingJournalRecord = null;
	constructor(fs, root, onChange, sandboxPolicyOf) {
		this.fs = fs;
		this.root = root;
		this.onChange = onChange;
		this.sandboxPolicyOf = sandboxPolicyOf;
	}
	/**
	* The configured `.devflow` root of this store.
	*
	* Exposed for the session-scope resolver, which reports which project a
	* session is bound to: a panel that cannot name the root cannot show that two
	* sessions are on two projects.
	*/
	get rootPath() {
		return this.root;
	}
	/** Resolve the append-only journal directory. */
	journalDirTarget() {
		return this.fs.resolve(join(this.root, JOURNAL_DIR));
	}
	/** Resolve the optimistic journal-head record. */
	journalHeadTarget() {
		return this.fs.resolve(join(this.root, JOURNAL_DIR, JOURNAL_HEAD_FILE));
	}
	/** Resolve one journal entry by its stable sequence. */
	journalEntryTarget(sequence) {
		return this.fs.resolve(join(this.root, JOURNAL_DIR, `${String(sequence).padStart(16, "0")}${FILE_SUFFIX}`));
	}
	/** Resolve the project record file. */
	projectTarget() {
		return this.fs.resolve(join(this.root, PROJECT_FILE));
	}
	/** Resolve one task record file. */
	taskTarget(id) {
		return this.fs.resolve(join(this.root, TASKS_DIR, `${id}${FILE_SUFFIX}`));
	}
	/** Resolve one result record file. */
	resultTarget(id) {
		return this.fs.resolve(join(this.root, RESULTS_DIR, `${id}${FILE_SUFFIX}`));
	}
	/** Resolve one agent instance record file. */
	agentTarget(id) {
		return this.fs.resolve(join(this.root, AGENTS_DIR, `${id}${FILE_SUFFIX}`));
	}
	/** Read one JSON record; returns undefined when the file is absent. */
	async readJson(target) {
		const info = await this.fs.stat(target);
		if (info === void 0) return void 0;
		if (info.type !== "file") throw new Error(`devflow: not a regular file: ${target.displayPath}`);
		return parseJson(await this.fs.readText(target), target.displayPath);
	}
	/**
	* Write one JSON record; `expected` guards against blind overwrites.
	*
	* `report` is set false for the one write whose report would be pure noise: the
	* journal ENTRY file, which is always followed by the head write (the watermark)
	* and, for a published record, by the record's own meaning. Reporting it would put
	* a "nothing you can see changed" frame in front of the frame that explains the
	* change — one commit must yield exactly one frame.
	*/
	async writeJson(target, value, expected, options) {
		await this.fs.writeText(target, `${JSON.stringify(value, null, 2)}\n`, expected, void 0, this.sandboxPolicyOf?.());
		if (this.onChange === void 0 || options?.report === false) return;
		const relative = await this.relativeToRoot(target);
		if (relative === null) return;
		const sequence = relative === JOURNAL_HEAD_RELATIVE && isRecord(value) && typeof value.nextSequence === "number" ? value.nextSequence : void 0;
		const record = options?.carryPendingRecord === true ? this.pendingJournalRecord ?? void 0 : void 0;
		if (options?.carryPendingRecord === true) this.pendingJournalRecord = null;
		try {
			if (sequence === void 0 && record === void 0) this.onChange(relative);
			else this.onChange(relative, sequence, record);
		} catch {}
	}
	/**
	* Root-relative path of one store target, or null when it lives outside the root.
	*
	* Backends hand back an absolute `displayPath` even when the configured root is
	* relative, so the root is resolved once through the same seam that builds the
	* targets and cached; a relative display path still falls back to a literal
	* prefix match.
	*/
	async relativeToRoot(target) {
		const display = target.displayPath.replace(/\\/g, "/");
		if (this.absoluteRoot === null) try {
			this.absoluteRoot = (await this.fs.resolve(this.root)).displayPath.replace(/\\/g, "/");
		} catch {
			this.absoluteRoot = "";
		}
		for (const candidate of [this.absoluteRoot, this.root.replace(/\\/g, "/")]) {
			const prefix = candidate.replace(/\/+$/, "");
			if (prefix !== "" && display.startsWith(`${prefix}/`)) return display.slice(prefix.length + 1);
		}
		if (!display.includes("/") && !display.includes(":")) return display;
		return null;
	}
	/**
	* Look up one committed id without making every append rescan the journal.
	* The cache is valid only at its observed head sequence, so a changed head
	* refreshes it before relying on a negative result from another writer.
	*/
	async findJournalEntry(id, nextSequence) {
		if (this.journalIdCache?.nextSequence !== nextSequence) {
			const entries = await this.listJournal();
			this.journalIdCache = {
				nextSequence,
				entries: new Map(entries.map((entry) => [entry.id, entry]))
			};
		}
		return this.journalIdCache.entries.get(id);
	}
	/** Remember one locally committed entry without invalidating the observed head. */
	rememberJournalEntry(entry) {
		if (this.journalIdCache?.nextSequence === entry.sequence) {
			this.journalIdCache.entries.set(entry.id, entry);
			this.journalIdCache = {
				...this.journalIdCache,
				nextSequence: entry.sequence + 1
			};
		}
	}
	/**
	* Append one durable DevFlow audit record. The head file uses the filesystem
	* version as a compare-and-swap guard, so concurrent workers retry rather
	* than silently sharing a sequence. The entry is published before the head;
	* a crash can leave an unreachable tail entry, but can never make the head
	* point at a missing entry.
	*/
	async appendJournal(type, data, id = randomUUID()) {
		const journalRoot = this.root;
		const prior = journalTails.get(journalRoot) ?? Promise.resolve();
		let release;
		const gate = new Promise((resolve) => {
			release = resolve;
		});
		const tail = prior.then(() => gate);
		journalTails.set(journalRoot, tail);
		await prior;
		try {
			return await this.appendJournalUnlocked(type, data, id);
		} finally {
			release();
			if (journalTails.get(journalRoot) === tail) journalTails.delete(journalRoot);
		}
	}
	/** Perform one journal append while this process owns the journal tail. */
	async appendJournalUnlocked(type, data, id) {
		if (!isString(type) || type.trim() === "") throw new Error("devflow: journal type must be a non-empty string");
		if (!isJsonValue(data)) throw new Error(`devflow: journal ${type} carries non-JSON data`);
		for (;;) {
			const headTarget = await this.journalHeadTarget();
			const headInfo = await this.fs.stat(headTarget);
			const head = headInfo === void 0 ? { nextSequence: 0 } : validateJournalHead(await this.readJson(headTarget), headTarget.displayPath);
			const alreadyCommitted = await this.findJournalEntry(id, head.nextSequence);
			if (alreadyCommitted !== void 0) return alreadyCommitted;
			const entryTarget = await this.journalEntryTarget(head.nextSequence);
			const entry = {
				sequence: head.nextSequence,
				id,
				type,
				data,
				at: (/* @__PURE__ */ new Date()).toISOString()
			};
			if (await this.fs.stat(entryTarget) !== void 0) {
				const prior = validateJournalEntry(await this.readJson(entryTarget), entryTarget.displayPath);
				if (prior.id === id) {
					this.rememberJournalEntry(prior);
					return prior;
				}
				try {
					await this.writeJson(headTarget, { nextSequence: prior.sequence + 1 }, headInfo === void 0 ? { kind: "createIfAbsent" } : {
						kind: "replaceIfVersion",
						version: headInfo.version
					});
				} catch (error) {
					if (headInfo === void 0 || error.code === "FS_STALE_VERSION") continue;
					throw error;
				}
				continue;
			}
			try {
				await this.writeJson(entryTarget, entry, { kind: "createIfAbsent" }, { report: false });
			} catch (error) {
				if (error.code === "FS_NOT_OBSERVED") continue;
				throw error;
			}
			this.pendingJournalRecord = {
				type: entry.type,
				data: entry.data,
				at: entry.at
			};
			try {
				await this.writeJson(headTarget, { nextSequence: entry.sequence + 1 }, headInfo === void 0 ? { kind: "createIfAbsent" } : {
					kind: "replaceIfVersion",
					version: headInfo.version
				}, { carryPendingRecord: true });
				this.rememberJournalEntry(entry);
				return entry;
			} catch (error) {
				if (headInfo === void 0 || error.code === "FS_STALE_VERSION") continue;
				throw error;
			}
		}
	}
	/**
	* Read a bounded descending sequence window without listing or parsing the
	* complete journal. Callers supply an exclusive position pinned to a
	* previously observed committed head, so later appends cannot move a page.
	*/
	async readCommittedJournalSequencePage(capturedHeadSequence, nextExclusiveSequence, scanLimit) {
		if (!Number.isSafeInteger(scanLimit) || scanLimit < 1) throw new Error("devflow: journal page scanLimit must be a positive safe integer");
		const headTarget = await this.journalHeadTarget();
		const headRaw = await this.readJson(headTarget);
		const head = headRaw === void 0 ? { nextSequence: 0 } : validateJournalHead(headRaw, headTarget.displayPath);
		const captured = capturedHeadSequence ?? head.nextSequence;
		if (!Number.isSafeInteger(captured) || captured < 0 || captured > head.nextSequence) throw new Error("devflow: invalid committed journal page head");
		const start = nextExclusiveSequence ?? captured;
		if (!Number.isSafeInteger(start) || start < 0 || start > captured) throw new Error("devflow: invalid committed journal page position");
		const entries = [];
		let scannedCount = 0;
		let cursor = start;
		while (cursor > 0 && scannedCount < scanLimit) {
			const sequence = cursor - 1;
			const target = await this.journalEntryTarget(sequence);
			const raw = await this.readJson(target);
			if (raw === void 0) throw new Error("devflow: committed journal entry is unavailable");
			const entry = validateJournalEntry(raw, target.displayPath);
			if (entry.sequence !== sequence) throw new Error("devflow: committed journal sequence mismatch");
			entries.push(entry);
			scannedCount++;
			cursor = sequence;
		}
		return {
			capturedHeadSequence: captured,
			entries,
			nextExclusiveSequence: cursor === 0 ? null : cursor,
			scannedCount
		};
	}
	/** Read committed journal entries only, in their stable sequence order. */
	async listJournal() {
		const dir = await this.journalDirTarget();
		const info = await this.fs.stat(dir);
		if (info === void 0) return [];
		if (info.type !== "directory") throw new Error(`devflow: not a directory: ${dir.displayPath}`);
		const entries = [];
		for (const entry of await this.fs.listDir(dir)) {
			if (entry.type !== "file" || !entry.name.endsWith(FILE_SUFFIX) || entry.name === JOURNAL_HEAD_FILE) continue;
			const raw = await this.readJson(entry.target);
			if (raw !== void 0) entries.push(validateJournalEntry(raw, entry.target.displayPath));
		}
		const headTarget = await this.journalHeadTarget();
		const headRaw = await this.readJson(headTarget);
		if (headRaw === void 0) return [];
		const head = validateJournalHead(headRaw, headTarget.displayPath);
		return entries.filter((entry) => entry.sequence < head.nextSequence).sort((left, right) => left.sequence - right.sequence);
	}
	/** Save (create or replace) the project context. */
	async saveProject(project) {
		validateProject(project, "memory");
		await this.writeJson(await this.projectTarget(), project);
	}
	/** Load the project context; undefined when the project has never been saved. */
	async loadProject() {
		const target = await this.projectTarget();
		const raw = await this.readJson(target);
		return raw === void 0 ? void 0 : validateProject(raw, target.displayPath);
	}
	/**
	* Create and persist one task with a generated id and timestamps.
	* @param input - task fields without the store-owned id and timestamps.
	* @returns the persisted task.
	*/
	async createTask(input) {
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const task = {
			...input,
			id: randomUUID(),
			createdAt: now,
			updatedAt: now
		};
		validateTask(task, "memory");
		await this.writeJson(await this.taskTarget(task.id), task, { kind: "createIfAbsent" });
		return task;
	}
	/** Load one task; undefined when the task id is unknown. */
	async getTask(id) {
		assertUuid(id, "task");
		const target = await this.taskTarget(id);
		const raw = await this.readJson(target);
		return raw === void 0 ? void 0 : validateTask(raw, target.displayPath);
	}
	/** Load every task in the store, oldest first; an empty tasks/ is an empty list. */
	async listTasks() {
		const dir = await this.fs.resolve(join(this.root, TASKS_DIR));
		const info = await this.fs.stat(dir);
		if (info === void 0) return [];
		if (info.type !== "directory") throw new Error(`devflow: not a directory: ${dir.displayPath}`);
		const tasks = [];
		for (const entry of await this.fs.listDir(dir)) {
			if (entry.type !== "file" || !entry.name.endsWith(FILE_SUFFIX)) continue;
			const raw = await this.readJson(entry.target);
			if (raw !== void 0) tasks.push(validateTask(raw, entry.target.displayPath));
		}
		return tasks.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}
	/**
	* Apply a partial update to one task and refresh its `updatedAt`.
	* The id and `createdAt` are immutable; unknown tasks fail loud. An
	* `assignedRole` of `undefined` in the patch clears the assignment; an
	* omitted key leaves it untouched.
	* @param id - the task to update.
	* @param patch - the fields to replace.
	* @returns the updated task.
	*/
	async updateTask(id, patch) {
		assertUuid(id, "task");
		const existing = await this.getTask(id);
		if (existing === void 0) throw new Error(`devflow: cannot update unknown task ${id}`);
		const { assignedRole, ...rest } = patch;
		const { assignedRole: existingRole, ...existingRest } = existing;
		const rolePart = "assignedRole" in patch ? assignedRole === void 0 ? {} : { assignedRole } : existingRole === void 0 ? {} : { assignedRole: existingRole };
		const updated = {
			...existingRest,
			...rest,
			...rolePart,
			id: existing.id,
			createdAt: existing.createdAt,
			updatedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		validateTask(updated, "memory");
		await this.writeJson(await this.taskTarget(id), updated);
		return updated;
	}
	/**
	* Create and persist one result with a generated id and creation time.
	* @param input - result fields without the store-owned id and `createdAt`.
	* @returns the persisted result.
	*/
	async saveResult(input) {
		const result = {
			...input,
			id: randomUUID(),
			createdAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		validateResult(result, "memory");
		await this.writeJson(await this.resultTarget(result.id), result, { kind: "createIfAbsent" });
		return result;
	}
	/** Load one result; undefined when the result id is unknown. */
	async getResult(id) {
		assertUuid(id, "result");
		const target = await this.resultTarget(id);
		const raw = await this.readJson(target);
		return raw === void 0 ? void 0 : validateResult(raw, target.displayPath);
	}
	/** Load every result in the store, oldest first; an empty results/ is an empty list. */
	async listResults() {
		const dir = await this.fs.resolve(join(this.root, RESULTS_DIR));
		const info = await this.fs.stat(dir);
		if (info === void 0) return [];
		if (info.type !== "directory") throw new Error(`devflow: not a directory: ${dir.displayPath}`);
		const results = [];
		for (const entry of await this.fs.listDir(dir)) {
			if (entry.type !== "file" || !entry.name.endsWith(FILE_SUFFIX)) continue;
			const raw = await this.readJson(entry.target);
			if (raw !== void 0) results.push(validateResult(raw, entry.target.displayPath));
		}
		return results.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}
	/** Load every result for one task, oldest first; an empty results/ is an empty list. */
	async listResultsByTask(taskId) {
		assertUuid(taskId, "task");
		const dir = await this.fs.resolve(join(this.root, RESULTS_DIR));
		const info = await this.fs.stat(dir);
		if (info === void 0) return [];
		if (info.type !== "directory") throw new Error(`devflow: not a directory: ${dir.displayPath}`);
		const results = [];
		for (const entry of await this.fs.listDir(dir)) {
			if (entry.type !== "file" || !entry.name.endsWith(FILE_SUFFIX)) continue;
			const raw = await this.readJson(entry.target);
			if (raw !== void 0) {
				const result = validateResult(raw, entry.target.displayPath);
				if (result.taskId === taskId) results.push(result);
			}
		}
		return results.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}
	/**
	* Read the convention import document for one task
	* (`.devflow/imports/<taskId>.md`); undefined when the user has not placed
	* a document there yet. Reads only — writing stays with the caller layer.
	*/
	async readImportMarkdown(taskId) {
		assertUuid(taskId, "task");
		const target = await this.fs.resolve(join(this.root, IMPORTS_DIR, `${taskId}${MARKDOWN_SUFFIX}`));
		const info = await this.fs.stat(target);
		if (info === void 0) return void 0;
		if (info.type !== "file") throw new Error(`devflow: not a regular file: ${target.displayPath}`);
		return this.fs.readText(target);
	}
	/**
	* Create and persist one agent instance with caller-supplied slug id and
	* store-generated timestamps. Duplicate ids fail (createIfAbsent).
	* @param input - instance fields without the store-owned timestamps.
	* @returns the persisted instance.
	*/
	async createAgentInstance(input) {
		assertAgentId(input.id);
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const instance = {
			...input,
			createdAt: now,
			updatedAt: now
		};
		validateAgentInstance(instance, "memory");
		await this.writeJson(await this.agentTarget(input.id), instance, { kind: "createIfAbsent" });
		return instance;
	}
	/** Load one agent instance; undefined when the id is unknown. */
	async getAgentInstance(id) {
		assertAgentId(id);
		const target = await this.agentTarget(id);
		const raw = await this.readJson(target);
		return raw === void 0 ? void 0 : validateAgentInstance(raw, target.displayPath);
	}
	/** Load every agent instance in the store, oldest first; an empty agents/ is an empty list. */
	async listAgentInstances() {
		const dir = await this.fs.resolve(join(this.root, AGENTS_DIR));
		const info = await this.fs.stat(dir);
		if (info === void 0) return [];
		if (info.type !== "directory") throw new Error(`devflow: not a directory: ${dir.displayPath}`);
		const instances = [];
		for (const entry of await this.fs.listDir(dir)) {
			if (entry.type !== "file" || !entry.name.endsWith(FILE_SUFFIX)) continue;
			const raw = await this.readJson(entry.target);
			if (raw !== void 0) instances.push(validateAgentInstance(raw, entry.target.displayPath));
		}
		return instances.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}
	/**
	* Apply a partial update to one agent instance and refresh its `updatedAt`.
	* The id and `createdAt` are immutable; unknown instances fail loud.
	* @param id - the instance to update.
	* @param patch - the fields to replace; undefined keys leave values untouched.
	* @returns the updated instance.
	*/
	async updateAgentInstance(id, patch) {
		assertAgentId(id);
		const existing = await this.getAgentInstance(id);
		if (existing === void 0) throw new Error(`devflow: cannot update unknown agent instance ${id}`);
		const { role, displayName, description, capabilities, metadata } = patch;
		const updated = {
			id: existing.id,
			role: role ?? existing.role,
			displayName: displayName ?? existing.displayName,
			...(description ?? existing.description) === void 0 ? {} : { description: description ?? existing.description },
			...(capabilities ?? existing.capabilities) === void 0 ? {} : { capabilities: capabilities ?? existing.capabilities },
			...(metadata ?? existing.metadata) === void 0 ? {} : { metadata: metadata ?? existing.metadata },
			createdAt: existing.createdAt,
			updatedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		validateAgentInstance(updated, "memory");
		await this.writeJson(await this.agentTarget(id), updated);
		return updated;
	}
	/** Resolve one orchestration agent record file. */
	orchestrationAgentTarget(agentId) {
		return this.fs.resolve(join(this.root, ORCHESTRATION_AGENTS_DIR, `${agentId}${FILE_SUFFIX}`));
	}
	/** Resolve the MVP plan record file. */
	mvpTarget() {
		return this.fs.resolve(join(this.root, MVP_FILE));
	}
	/** Resolve one phase record file. */
	phaseTarget(id) {
		return this.fs.resolve(join(this.root, PHASES_DIR, `${id}${FILE_SUFFIX}`));
	}
	/** Resolve the scope guard record file. */
	scopeTarget() {
		return this.fs.resolve(join(this.root, SCOPE_FILE));
	}
	/** Resolve one task's scope-guard file. */
	taskScopeTarget(taskId) {
		return this.fs.resolve(join(this.root, SCOPES_DIR, `${taskId}${FILE_SUFFIX}`));
	}
	/** Resolve one improvement record file. */
	improvementTarget(id) {
		return this.fs.resolve(join(this.root, IMPROVEMENTS_DIR, `${id}${FILE_SUFFIX}`));
	}
	/**
	* Register one orchestration agent. Fixed agents start `active`; temporary
	* agents start `created`. Duplicate ids fail (createIfAbsent).
	* @param input - agent fields without the store-owned status and timestamps.
	* @returns the persisted agent.
	*/
	async registerAgent(input) {
		assertAgentId(input.agentId);
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const status = input.kind === "fixed" ? "active" : "created";
		const agent = {
			...input,
			status,
			createdAt: now,
			updatedAt: now
		};
		validateOrchestrationAgent(agent, "memory");
		await this.writeJson(await this.orchestrationAgentTarget(input.agentId), agent, { kind: "createIfAbsent" });
		return agent;
	}
	/** Load one orchestration agent; undefined when the id is unknown or removed. */
	async getAgent(agentId) {
		assertAgentId(agentId);
		const target = await this.orchestrationAgentTarget(agentId);
		const raw = await this.readJson(target);
		if (raw === void 0 || isTombstone(raw)) return void 0;
		return validateOrchestrationAgent(raw, target.displayPath);
	}
	/** Read the repository-backed Skill contents bound to one agent, preserving binding order. */
	async resolveAgentSkills(agent) {
		validateAgentSkills(agent.skills, "agent Skill resolution");
		const resolved = [];
		for (const skillId of agent.skills) {
			const definition = DEVFLOW_SKILLS[skillId];
			if (definition === void 0) throw new Error(`devflow: unknown skill id ${JSON.stringify(skillId)}`);
			const target = await this.fs.resolve(definition.sourcePath);
			if ((await this.fs.stat(target))?.type !== "file") throw new Error(`devflow: Skill source ${definition.sourcePath} for ${skillId} is unavailable`);
			resolved.push({
				id: skillId,
				content: await this.fs.readText(target)
			});
		}
		return resolved;
	}
	/** Load every registered orchestration agent, oldest first; skips removed agents. */
	async listAgents() {
		const dir = await this.fs.resolve(join(this.root, ORCHESTRATION_AGENTS_DIR));
		const info = await this.fs.stat(dir);
		if (info === void 0) return [];
		if (info.type !== "directory") throw new Error(`devflow: not a directory: ${dir.displayPath}`);
		const agents = [];
		for (const entry of await this.fs.listDir(dir)) {
			if (entry.type !== "file" || !entry.name.endsWith(FILE_SUFFIX)) continue;
			const raw = await this.readJson(entry.target);
			if (raw !== void 0 && !isTombstone(raw)) agents.push(validateOrchestrationAgent(raw, entry.target.displayPath));
		}
		return agents.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}
	/**
	* Remove one orchestration agent. fs has no delete primitive, so removal is
	* a logical tombstone: the record file is replaced with a marker and every
	* reader skips it. Unknown agents fail loud.
	* @param agentId - the agent to remove.
	*/
	async removeAgent(agentId) {
		assertAgentId(agentId);
		if (await this.getAgent(agentId) === void 0) throw new Error(`devflow: cannot remove unknown agent ${agentId}`);
		await this.writeJson(await this.orchestrationAgentTarget(agentId), {
			removed: true,
			removedAt: (/* @__PURE__ */ new Date()).toISOString()
		});
	}
	/**
	* Apply a partial config patch to one orchestration agent and refresh
	* `updatedAt`. The id, kind, status, and `createdAt` are immutable.
	* @param agentId - the agent to update.
	* @param patch - the fields to replace; omitted keys stay untouched.
	* @returns the updated agent.
	*/
	async updateAgentConfig(agentId, patch) {
		assertAgentId(agentId);
		const existing = await this.getAgent(agentId);
		if (existing === void 0) throw new Error(`devflow: cannot update unknown agent ${agentId}`);
		const { role, prompt, modelConfig, tools, capabilities, skills, delegationDepth } = patch;
		const updated = {
			...existing,
			role: role ?? existing.role,
			prompt: prompt ?? existing.prompt,
			modelConfig: modelConfig === void 0 ? existing.modelConfig : {
				...existing.modelConfig,
				...modelConfig
			},
			tools: tools ?? existing.tools,
			capabilities: capabilities ?? existing.capabilities,
			skills: skills ?? existing.skills,
			delegationDepth: delegationDepth ?? existing.delegationDepth,
			updatedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		validateOrchestrationAgent(updated, "memory");
		await this.writeJson(await this.orchestrationAgentTarget(agentId), updated);
		return updated;
	}
	/**
	* Transition one temporary agent through its lifecycle. Only the legal
	* created → running → terminated edges are accepted; fixed agents have no
	* transitions.
	* @param agentId - the temporary agent to transition.
	* @param to - the target status.
	* @returns the updated agent.
	*/
	async transitionAgent(agentId, to) {
		assertAgentId(agentId);
		const existing = await this.getAgent(agentId);
		if (existing === void 0) throw new Error(`devflow: cannot transition unknown agent ${agentId}`);
		if (existing.kind !== "temporary") throw new Error(`devflow: fixed agent ${agentId} has no lifecycle transitions`);
		if (!TEMPORARY_TRANSITIONS[existing.status].includes(to)) throw new Error(`devflow: illegal temporary-agent transition ${existing.status} -> ${to} for ${agentId}`);
		const updated = {
			...existing,
			status: to,
			updatedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		validateOrchestrationAgent(updated, "memory");
		await this.writeJson(await this.orchestrationAgentTarget(agentId), updated);
		return updated;
	}
	/** Save (create or replace) the MVP plan. */
	async saveMvpPlan(plan) {
		validateMvpPlan(plan, "memory");
		await this.writeJson(await this.mvpTarget(), plan);
	}
	/** Load the MVP plan; undefined when it has never been saved. */
	async getMvpPlan() {
		const target = await this.mvpTarget();
		const raw = await this.readJson(target);
		return raw === void 0 ? void 0 : validateMvpPlan(raw, target.displayPath);
	}
	/** Create and persist one phase with a generated id and timestamps. */
	async createPhase(input) {
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const phase = {
			...input,
			id: randomUUID(),
			createdAt: now,
			updatedAt: now
		};
		validatePhase(phase, "memory");
		await this.writeJson(await this.phaseTarget(phase.id), phase, { kind: "createIfAbsent" });
		return phase;
	}
	/** Load one phase; undefined when the id is unknown. */
	async getPhase(id) {
		assertUuid(id, "phase");
		const target = await this.phaseTarget(id);
		const raw = await this.readJson(target);
		return raw === void 0 ? void 0 : validatePhase(raw, target.displayPath);
	}
	/** Change one phase's status and refresh its `updatedAt`. */
	async updatePhaseStatus(id, status) {
		assertUuid(id, "phase");
		const existing = await this.getPhase(id);
		if (existing === void 0) throw new Error(`devflow: cannot update unknown phase ${id}`);
		const updated = {
			...existing,
			status,
			updatedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		validatePhase(updated, "memory");
		await this.writeJson(await this.phaseTarget(id), updated);
		return updated;
	}
	/**
	* Update (create or replace) the scope guard. The first update sets
	* `createdAt`; later updates keep it and refresh `updatedAt`.
	*/
	async updateScope(scope) {
		const existing = await this.getScope();
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const updated = {
			...scope,
			createdAt: existing?.createdAt ?? now,
			updatedAt: now
		};
		validateScopeGuard(updated, "memory");
		await this.writeJson(await this.scopeTarget(), updated);
		return updated;
	}
	/** Load the scope guard; undefined when it has never been saved or was cleared. */
	async getScope() {
		const target = await this.scopeTarget();
		const raw = await this.readJson(target);
		if (raw === void 0 || isTombstone(raw)) return void 0;
		return validateScopeGuard(raw, target.displayPath);
	}
	/** Clear the PROJECT default scope (the file stays as a tombstone record). */
	async clearScope() {
		await this.writeJson(await this.scopeTarget(), { removed: true });
	}
	/**
	* Save one TASK-scoped scope guard.
	*
	* Task scopes live beside the project default rather than replacing it: the
	* project file is a fallback for a task that never set bounds, so a later
	* task can no longer overwrite the bounds an earlier task's rework rounds
	* depend on. The first update sets `createdAt`; later updates keep it.
	* @param taskId - the task the bounds belong to.
	* @param scope - summary, in-scope items, limits, and completion criteria.
	* @returns the persisted scope guard.
	*/
	async saveTaskScope(taskId, scope) {
		assertUuid(taskId, "task");
		const existing = await this.getTaskScope(taskId);
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const updated = {
			...scope,
			createdAt: existing?.createdAt ?? now,
			updatedAt: now
		};
		validateScopeGuard(updated, "memory");
		await this.writeJson(await this.taskScopeTarget(taskId), updated);
		return updated;
	}
	/** Load one task's scope guard; undefined when that task never set bounds. */
	async getTaskScope(taskId) {
		assertUuid(taskId, "task");
		const target = await this.taskScopeTarget(taskId);
		const raw = await this.readJson(target);
		if (raw === void 0 || isTombstone(raw)) return void 0;
		return validateScopeGuard(raw, target.displayPath);
	}
	/** Clear one task's scope guard (tombstone; the project default is untouched). */
	async clearTaskScope(taskId) {
		assertUuid(taskId, "task");
		await this.writeJson(await this.taskScopeTarget(taskId), { removed: true });
	}
	/** Queue one out-of-scope improvement with a generated id and creation time. */
	async addImprovement(input) {
		const improvement = {
			...input,
			id: randomUUID(),
			createdAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		validateImprovement(improvement, "memory");
		await this.writeJson(await this.improvementTarget(improvement.id), improvement, { kind: "createIfAbsent" });
		return improvement;
	}
	/** Load the improvement queue, oldest first; an empty improvements/ is an empty list. */
	async listImprovements() {
		const dir = await this.fs.resolve(join(this.root, IMPROVEMENTS_DIR));
		const info = await this.fs.stat(dir);
		if (info === void 0) return [];
		if (info.type !== "directory") throw new Error(`devflow: not a directory: ${dir.displayPath}`);
		const improvements = [];
		for (const entry of await this.fs.listDir(dir)) {
			if (entry.type !== "file" || !entry.name.endsWith(FILE_SUFFIX)) continue;
			const raw = await this.readJson(entry.target);
			if (raw !== void 0) improvements.push(validateImprovement(raw, entry.target.displayPath));
		}
		return improvements.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}
	/** Resolve one commander checkpoint record file. */
	checkpointTarget(id) {
		return this.fs.resolve(join(this.root, CHECKPOINTS_DIR, `${id}${FILE_SUFFIX}`));
	}
	/** Resolve one phase-assignment record file. */
	assignmentTarget(id) {
		return this.fs.resolve(join(this.root, ASSIGNMENTS_DIR, `${id}${FILE_SUFFIX}`));
	}
	/** Create and persist one commander checkpoint with a generated id and timestamps. */
	async createCheckpoint(input) {
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const checkpoint = {
			...input,
			checkpointId: randomUUID(),
			createdAt: now,
			updatedAt: now
		};
		validateCommanderCheckpoint(checkpoint, "memory");
		await this.writeJson(await this.checkpointTarget(checkpoint.checkpointId), checkpoint, { kind: "createIfAbsent" });
		return checkpoint;
	}
	/** Load one commander checkpoint; undefined when the id is unknown. */
	async getCheckpoint(id) {
		assertUuid(id, "checkpoint");
		const target = await this.checkpointTarget(id);
		const raw = await this.readJson(target);
		return raw === void 0 ? void 0 : validateCommanderCheckpoint(raw, target.displayPath);
	}
	/**
	* Apply a partial update to one commander checkpoint and refresh `updatedAt`.
	* The checkpoint id and `createdAt` are immutable; unknown ids fail loud.
	*/
	async updateCheckpoint(id, patch) {
		assertUuid(id, "checkpoint");
		const existing = await this.getCheckpoint(id);
		if (existing === void 0) throw new Error(`devflow: cannot update unknown checkpoint ${id}`);
		const { currentMvp, currentIteration, currentPhase, currentTask, completedItems, decisions, nextSteps } = patch;
		const updated = {
			...existing,
			...currentMvp !== void 0 ? { currentMvp } : {},
			...currentIteration !== void 0 ? { currentIteration } : {},
			...currentPhase !== void 0 ? { currentPhase } : {},
			...currentTask !== void 0 ? { currentTask } : {},
			...completedItems !== void 0 ? { completedItems } : {},
			...decisions !== void 0 ? { decisions } : {},
			...nextSteps !== void 0 ? { nextSteps } : {},
			updatedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		validateCommanderCheckpoint(updated, "memory");
		await this.writeJson(await this.checkpointTarget(id), updated);
		return updated;
	}
	/** Load every commander checkpoint, oldest first; an empty checkpoints/ is an empty list. */
	async listCheckpoints() {
		const dir = await this.fs.resolve(join(this.root, CHECKPOINTS_DIR));
		const info = await this.fs.stat(dir);
		if (info === void 0) return [];
		if (info.type !== "directory") throw new Error(`devflow: not a directory: ${dir.displayPath}`);
		const checkpoints = [];
		for (const entry of await this.fs.listDir(dir)) {
			if (entry.type !== "file" || !entry.name.endsWith(FILE_SUFFIX)) continue;
			const raw = await this.readJson(entry.target);
			if (raw !== void 0) checkpoints.push(validateCommanderCheckpoint(raw, entry.target.displayPath));
		}
		return checkpoints.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}
	/** Create and persist one phase assignment with a generated id and timestamps. */
	async createAssignment(input) {
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const assignment = {
			...input,
			assignmentId: randomUUID(),
			createdAt: now,
			updatedAt: now
		};
		validatePhaseAssignment(assignment, "memory");
		await this.writeJson(await this.assignmentTarget(assignment.assignmentId), assignment, { kind: "createIfAbsent" });
		return assignment;
	}
	/** Load one phase assignment; undefined when the id is unknown or removed. */
	async getAssignment(id) {
		assertUuid(id, "assignment");
		const target = await this.assignmentTarget(id);
		const raw = await this.readJson(target);
		if (raw === void 0 || isTombstone(raw)) return void 0;
		return validatePhaseAssignment(raw, target.displayPath);
	}
	/**
	* Change one phase assignment's status and refresh its `updatedAt`.
	*
	* A transition to `closed` must carry a reason and stamps `closedAt`; every other
	* transition must NOT carry one, and clears any stale close stamp. The lifecycle edge
	* is checked against {@link ASSIGNMENT_TRANSITIONS}, so `completed`/`closed` are
	* terminal and a closed assignment can never be reopened.
	*
	* A close also appends its own `devflow/orchestration/close` journal record. This
	* method is where a closure is validated and committed, so it is the only place
	* every caller — tool path, runtime path, or an operator script — can be made to
	* leave the same audit trail. {@link appendClosure} explains why the append is
	* best-effort.
	*/
	async updateAssignmentStatus(id, status, closeReason) {
		assertUuid(id, "assignment");
		const existing = await this.getAssignment(id);
		if (existing === void 0) throw new Error(`devflow: cannot update unknown assignment ${id}`);
		if (!ASSIGNMENT_TRANSITIONS[existing.status].includes(status)) throw new Error(`devflow: illegal assignment transition ${existing.status} -> ${status} for ${id}`);
		if (status === "closed" && !isDevFlowCloseReason(closeReason)) throw new Error(`devflow: closing assignment ${id} requires a close reason`);
		if (status !== "closed" && closeReason !== void 0) throw new Error(`devflow: assignment ${id} may only carry a close reason while closed`);
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const { closedAt: _closedAt, closeReason: _closeReason, ...rest } = existing;
		const updated = {
			...rest,
			status,
			...status === "closed" ? {
				closedAt: now,
				closeReason
			} : {},
			updatedAt: now
		};
		validatePhaseAssignment(updated, "memory");
		await this.writeJson(await this.assignmentTarget(id), updated);
		if (updated.status === "closed") await this.appendClosure("devflow/orchestration/close", {
			assignmentId: id,
			closeReason: updated.closeReason,
			at: updated.closedAt
		});
		return updated;
	}
	/** Remove one phase assignment via a logical tombstone (fs has no delete). */
	async unassignAssignment(id) {
		assertUuid(id, "assignment");
		if (await this.getAssignment(id) === void 0) throw new Error(`devflow: cannot unassign unknown assignment ${id}`);
		await this.writeJson(await this.assignmentTarget(id), {
			removed: true,
			removedAt: (/* @__PURE__ */ new Date()).toISOString()
		});
	}
	/** Load every phase assignment, oldest first; skips removed assignments. */
	async listAssignments() {
		const dir = await this.fs.resolve(join(this.root, ASSIGNMENTS_DIR));
		const info = await this.fs.stat(dir);
		if (info === void 0) return [];
		if (info.type !== "directory") throw new Error(`devflow: not a directory: ${dir.displayPath}`);
		const assignments = [];
		for (const entry of await this.fs.listDir(dir)) {
			if (entry.type !== "file" || !entry.name.endsWith(FILE_SUFFIX)) continue;
			const raw = await this.readJson(entry.target);
			if (raw !== void 0 && !isTombstone(raw)) assignments.push(validatePhaseAssignment(raw, entry.target.displayPath));
		}
		return assignments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}
	/** Resolve one commander plan record file. */
	planningTarget(id) {
		return this.fs.resolve(join(this.root, PLANNING_DIR, `${id}${FILE_SUFFIX}`));
	}
	/** Resolve one execution batch record file. */
	batchTarget(id) {
		return this.fs.resolve(join(this.root, BATCHES_DIR, `${id}${FILE_SUFFIX}`));
	}
	/** Create and persist one commander plan (starts `draft`). */
	async createPlanning(input) {
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const plan = {
			...input,
			planningId: randomUUID(),
			status: "draft",
			createdAt: now,
			updatedAt: now
		};
		validateCommanderPlan(plan, "memory");
		await this.writeJson(await this.planningTarget(plan.planningId), plan, { kind: "createIfAbsent" });
		return plan;
	}
	/** Load one commander plan; undefined when the id is unknown. */
	async getPlanning(id) {
		assertUuid(id, "planning");
		const target = await this.planningTarget(id);
		const raw = await this.readJson(target);
		return raw === void 0 ? void 0 : validateCommanderPlan(raw, target.displayPath);
	}
	/** Apply a partial update to one commander plan and refresh `updatedAt`. */
	async updatePlanning(id, patch) {
		assertUuid(id, "planning");
		const existing = await this.getPlanning(id);
		if (existing === void 0) throw new Error(`devflow: cannot update unknown plan ${id}`);
		const { goal, mvpPlanId, status } = patch;
		const updated = {
			...existing,
			...goal !== void 0 ? { goal } : {},
			...mvpPlanId !== void 0 ? { mvpPlanId } : {},
			...status !== void 0 ? { status } : {},
			updatedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		validateCommanderPlan(updated, "memory");
		await this.writeJson(await this.planningTarget(id), updated);
		return updated;
	}
	/** Activate one commander plan (draft → active). */
	async activatePlanning(id) {
		assertUuid(id, "planning");
		const existing = await this.getPlanning(id);
		if (existing === void 0) throw new Error(`devflow: cannot activate unknown plan ${id}`);
		if (existing.status !== "draft") throw new Error(`devflow: cannot activate plan ${id} in status ${existing.status}`);
		const updated = {
			...existing,
			status: "active",
			updatedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		validateCommanderPlan(updated, "memory");
		await this.writeJson(await this.planningTarget(id), updated);
		return updated;
	}
	/** Load every commander plan, oldest first; an empty planning/ is an empty list. */
	async listPlanning() {
		const dir = await this.fs.resolve(join(this.root, PLANNING_DIR));
		const info = await this.fs.stat(dir);
		if (info === void 0) return [];
		if (info.type !== "directory") throw new Error(`devflow: not a directory: ${dir.displayPath}`);
		const plans = [];
		for (const entry of await this.fs.listDir(dir)) {
			if (entry.type !== "file" || !entry.name.endsWith(FILE_SUFFIX)) continue;
			const raw = await this.readJson(entry.target);
			if (raw !== void 0) plans.push(validateCommanderPlan(raw, entry.target.displayPath));
		}
		return plans.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}
	/** Create and persist one execution batch (starts `planned`). */
	async createBatch(input) {
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const batch = {
			...input,
			batchId: randomUUID(),
			status: "planned",
			createdAt: now,
			updatedAt: now
		};
		validateExecutionBatch(batch, "memory");
		await this.writeJson(await this.batchTarget(batch.batchId), batch, { kind: "createIfAbsent" });
		return batch;
	}
	/** Load one execution batch; undefined when the id is unknown. */
	async getBatch(id) {
		assertUuid(id, "batch");
		const target = await this.batchTarget(id);
		const raw = await this.readJson(target);
		return raw === void 0 ? void 0 : validateExecutionBatch(raw, target.displayPath);
	}
	/** Transition one execution batch's status, validating the lifecycle edge. */
	async updateBatchStatus(id, status) {
		assertUuid(id, "batch");
		const existing = await this.getBatch(id);
		if (existing === void 0) throw new Error(`devflow: cannot update unknown batch ${id}`);
		if (!EXECUTION_BATCH_TRANSITIONS[existing.status].includes(status)) throw new Error(`devflow: illegal execution-batch transition ${existing.status} -> ${status} for ${id}`);
		const updated = {
			...existing,
			status,
			updatedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		validateExecutionBatch(updated, "memory");
		await this.writeJson(await this.batchTarget(id), updated);
		return updated;
	}
	/** Load every execution batch, oldest first; an empty batches/ is an empty list. */
	async listBatches() {
		const dir = await this.fs.resolve(join(this.root, BATCHES_DIR));
		const info = await this.fs.stat(dir);
		if (info === void 0) return [];
		if (info.type !== "directory") throw new Error(`devflow: not a directory: ${dir.displayPath}`);
		const batches = [];
		for (const entry of await this.fs.listDir(dir)) {
			if (entry.type !== "file" || !entry.name.endsWith(FILE_SUFFIX)) continue;
			const raw = await this.readJson(entry.target);
			if (raw !== void 0) batches.push(validateExecutionBatch(raw, entry.target.displayPath));
		}
		return batches.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}
	/** Resolve one execution record file. */
	executionTarget(id) {
		return this.fs.resolve(join(this.root, EXECUTIONS_DIR, `${id}${FILE_SUFFIX}`));
	}
	/** Resolve one agent report record file. */
	reportTarget(id) {
		return this.fs.resolve(join(this.root, REPORTS_DIR, `${id}${FILE_SUFFIX}`));
	}
	/** Create and persist one execution record (starts `pending`). */
	async createExecutionRecord(input) {
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const execution = {
			...input,
			executionId: randomUUID(),
			status: "pending",
			startedAt: null,
			completedAt: null,
			createdAt: now,
			updatedAt: now
		};
		validateExecutionRecord(execution, "memory");
		await this.writeJson(await this.executionTarget(execution.executionId), execution, { kind: "createIfAbsent" });
		return execution;
	}
	/** Load one execution record; undefined when the id is unknown. */
	async getExecutionRecord(id) {
		assertUuid(id, "execution");
		const target = await this.executionTarget(id);
		const raw = await this.readJson(target);
		return raw === void 0 ? void 0 : validateExecutionRecord(raw, target.displayPath);
	}
	/**
	* Transition one execution's status, validating the lifecycle edge and stamping
	* `startedAt`/`completedAt` on the crossing edges.
	*
	* `closed` is the terminal "can never run again" state: it stamps `closedAt` and
	* carries a mandatory reason, and it clears the close stamp on every other edge so a
	* record can never keep a stale closure.
	*
	* A close also appends its own `devflow/execution/close` journal record, for the
	* same reason {@link updateAssignmentStatus} does: this is the one seam every
	* closer passes through.
	*/
	async updateExecutionStatus(id, status, closeReason) {
		assertUuid(id, "execution");
		const existing = await this.getExecutionRecord(id);
		if (existing === void 0) throw new Error(`devflow: cannot update unknown execution ${id}`);
		if (!EXECUTION_TRANSITIONS[existing.status].includes(status)) throw new Error(`devflow: illegal execution transition ${existing.status} -> ${status} for ${id}`);
		if (status === "closed" && !isDevFlowCloseReason(closeReason)) throw new Error(`devflow: closing execution ${id} requires a close reason`);
		if (status !== "closed" && closeReason !== void 0) throw new Error(`devflow: execution ${id} may only carry a close reason while closed`);
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const { closedAt: _closedAt, closeReason: _closeReason, ...rest } = existing;
		const updated = {
			...rest,
			status,
			...status === "running" && existing.startedAt === null ? { startedAt: now } : {},
			...(status === "completed" || status === "failed") && existing.completedAt === null ? { completedAt: now } : {},
			...status === "closed" ? {
				closedAt: now,
				closeReason
			} : {},
			updatedAt: now
		};
		validateExecutionRecord(updated, "memory");
		await this.writeJson(await this.executionTarget(id), updated);
		if (updated.status === "closed") await this.appendClosure("devflow/execution/close", {
			executionId: id,
			closeReason: updated.closeReason,
			at: updated.closedAt
		});
		return updated;
	}
	/**
	* Append the journal record that makes one closure auditable.
	*
	* Best-effort by design: the close itself is already committed to its own
	* entity file, and turning a journal write failure into a thrown error would
	* report a successful close as a failure while leaving the record closed on
	* disk — the caller would then retry a transition the lifecycle table already
	* forbids. A missing entry therefore degrades the audit trail, never the
	* closure, and the entity file remains the authority for what the record says.
	* @param type - the dedicated close event type.
	* @param data - the closure's identity, reason, and stamp.
	*/
	async appendClosure(type, data) {
		try {
			await recordDevFlowChange(this, type, data);
		} catch {}
	}
	/** Load every execution record for one task, oldest first. */
	async listExecutionsByTask(taskId) {
		if (!isString(taskId) || taskId.trim() === "") throw new Error("devflow: taskId must be a non-empty string");
		const dir = await this.fs.resolve(join(this.root, EXECUTIONS_DIR));
		const info = await this.fs.stat(dir);
		if (info === void 0) return [];
		if (info.type !== "directory") throw new Error(`devflow: not a directory: ${dir.displayPath}`);
		const executions = [];
		for (const entry of await this.fs.listDir(dir)) {
			if (entry.type !== "file" || !entry.name.endsWith(FILE_SUFFIX)) continue;
			const raw = await this.readJson(entry.target);
			if (raw !== void 0) {
				const record = validateExecutionRecord(raw, entry.target.displayPath);
				if (record.taskId === taskId) executions.push(record);
			}
		}
		return executions.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}
	/** Load every execution record for one batch, oldest first. */
	async listExecutionsByBatch(batchId) {
		const dir = await this.fs.resolve(join(this.root, EXECUTIONS_DIR));
		const info = await this.fs.stat(dir);
		if (info === void 0) return [];
		if (info.type !== "directory") throw new Error(`devflow: not a directory: ${dir.displayPath}`);
		const executions = [];
		for (const entry of await this.fs.listDir(dir)) {
			if (entry.type !== "file" || !entry.name.endsWith(FILE_SUFFIX)) continue;
			const raw = await this.readJson(entry.target);
			if (raw !== void 0) {
				const record = validateExecutionRecord(raw, entry.target.displayPath);
				if (record.batchId === batchId) executions.push(record);
			}
		}
		return executions.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}
	/** Create and persist one agent report with a generated id and timestamps. */
	async createReport(input) {
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const report = {
			...input,
			reportId: randomUUID(),
			createdAt: now,
			updatedAt: now
		};
		validateAgentReport(report, "memory");
		await this.writeJson(await this.reportTarget(report.reportId), report, { kind: "createIfAbsent" });
		return report;
	}
	/** Load one agent report; undefined when the id is unknown. */
	async getReport(id) {
		assertUuid(id, "report");
		const target = await this.reportTarget(id);
		const raw = await this.readJson(target);
		return raw === void 0 ? void 0 : validateAgentReport(raw, target.displayPath);
	}
	/** Load every report for all executions of one task, oldest first. */
	async listReportsByTask(taskId) {
		const executionIds = new Set((await this.listExecutionsByTask(taskId)).map((execution) => execution.executionId));
		if (executionIds.size === 0) return [];
		const dir = await this.fs.resolve(join(this.root, REPORTS_DIR));
		const info = await this.fs.stat(dir);
		if (info === void 0) return [];
		if (info.type !== "directory") throw new Error(`devflow: not a directory: ${dir.displayPath}`);
		const reports = [];
		for (const entry of await this.fs.listDir(dir)) {
			if (entry.type !== "file" || !entry.name.endsWith(FILE_SUFFIX)) continue;
			const raw = await this.readJson(entry.target);
			if (raw !== void 0) {
				const report = validateAgentReport(raw, entry.target.displayPath);
				if (executionIds.has(report.executionId)) reports.push(report);
			}
		}
		return reports.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}
	/** Load every report for one execution, oldest first. */
	async listReportsByExecution(executionId) {
		const dir = await this.fs.resolve(join(this.root, REPORTS_DIR));
		const info = await this.fs.stat(dir);
		if (info === void 0) return [];
		if (info.type !== "directory") throw new Error(`devflow: not a directory: ${dir.displayPath}`);
		const reports = [];
		for (const entry of await this.fs.listDir(dir)) {
			if (entry.type !== "file" || !entry.name.endsWith(FILE_SUFFIX)) continue;
			const raw = await this.readJson(entry.target);
			if (raw !== void 0) {
				const report = validateAgentReport(raw, entry.target.displayPath);
				if (report.executionId === executionId) reports.push(report);
			}
		}
		return reports.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}
	/** Apply a partial update to one agent report and refresh `updatedAt`. */
	async updateReport(id, patch) {
		assertUuid(id, "report");
		const existing = await this.getReport(id);
		if (existing === void 0) throw new Error(`devflow: cannot update unknown report ${id}`);
		const { status, summary, outputReference } = patch;
		const updated = {
			...existing,
			...status !== void 0 ? { status } : {},
			...summary !== void 0 ? { summary } : {},
			...outputReference !== void 0 ? { outputReference } : {},
			updatedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		validateAgentReport(updated, "memory");
		await this.writeJson(await this.reportTarget(id), updated);
		return updated;
	}
	/** Resolve one commander decision record file. */
	decisionTarget(id) {
		return this.fs.resolve(join(this.root, DECISIONS_DIR, `${id}${FILE_SUFFIX}`));
	}
	/** Create and persist one commander decision with a generated id and timestamps. */
	async createDecision(input) {
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const decision = {
			...input,
			decisionId: randomUUID(),
			createdAt: now,
			updatedAt: now
		};
		validateCommanderDecision(decision, "memory");
		await this.writeJson(await this.decisionTarget(decision.decisionId), decision, { kind: "createIfAbsent" });
		return decision;
	}
	/** Load one commander decision; undefined when the id is unknown. */
	async getDecision(id) {
		assertUuid(id, "decision");
		const target = await this.decisionTarget(id);
		const raw = await this.readJson(target);
		return raw === void 0 ? void 0 : validateCommanderDecision(raw, target.displayPath);
	}
	/** Load every commander decision, oldest first; an empty decisions/ is an empty list. */
	async listDecisions() {
		const dir = await this.fs.resolve(join(this.root, DECISIONS_DIR));
		const info = await this.fs.stat(dir);
		if (info === void 0) return [];
		if (info.type !== "directory") throw new Error(`devflow: not a directory: ${dir.displayPath}`);
		const decisions = [];
		for (const entry of await this.fs.listDir(dir)) {
			if (entry.type !== "file" || !entry.name.endsWith(FILE_SUFFIX)) continue;
			const raw = await this.readJson(entry.target);
			if (raw !== void 0) decisions.push(validateCommanderDecision(raw, entry.target.displayPath));
		}
		return decisions.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}
	/** Apply a partial update to one commander decision and refresh `updatedAt`. */
	async updateDecision(id, patch) {
		assertUuid(id, "decision");
		const existing = await this.getDecision(id);
		if (existing === void 0) throw new Error(`devflow: cannot update unknown decision ${id}`);
		const { checkpointId, relatedExecutionIds, decisionType, summary, nextAction } = patch;
		const updated = {
			...existing,
			...checkpointId !== void 0 ? { checkpointId } : {},
			...relatedExecutionIds !== void 0 ? { relatedExecutionIds } : {},
			...decisionType !== void 0 ? { decisionType } : {},
			...summary !== void 0 ? { summary } : {},
			...nextAction !== void 0 ? { nextAction } : {},
			updatedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		validateCommanderDecision(updated, "memory");
		await this.writeJson(await this.decisionTarget(id), updated);
		return updated;
	}
	/** Resolve one commander control action record file. */
	actionTarget(id) {
		return this.fs.resolve(join(this.root, ACTIONS_DIR, `${id}${FILE_SUFFIX}`));
	}
	/** Create and persist one commander control action with a generated id and timestamps. */
	async createAction(input) {
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const action = {
			...input,
			actionId: randomUUID(),
			status: "created",
			createdAt: now,
			updatedAt: now
		};
		validateCommanderAction(action, "memory");
		await this.writeJson(await this.actionTarget(action.actionId), action, { kind: "createIfAbsent" });
		return action;
	}
	/** Load one commander control action; undefined when the id is unknown. */
	async getAction(id) {
		assertUuid(id, "action");
		const target = await this.actionTarget(id);
		const raw = await this.readJson(target);
		return raw === void 0 ? void 0 : validateCommanderAction(raw, target.displayPath);
	}
	/** Load every commander control action, oldest first; an empty actions/ is an empty list. */
	async listActions() {
		const dir = await this.fs.resolve(join(this.root, ACTIONS_DIR));
		const info = await this.fs.stat(dir);
		if (info === void 0) return [];
		if (info.type !== "directory") throw new Error(`devflow: not a directory: ${dir.displayPath}`);
		const actions = [];
		for (const entry of await this.fs.listDir(dir)) {
			if (entry.type !== "file" || !entry.name.endsWith(FILE_SUFFIX)) continue;
			const raw = await this.readJson(entry.target);
			if (raw !== void 0) actions.push(validateCommanderAction(raw, entry.target.displayPath));
		}
		return actions.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}
	/**
	* Transition one commander control action's status through the created →
	* executing → completed chain and refresh `updatedAt`.
	*/
	async updateActionStatus(id, status) {
		assertUuid(id, "action");
		const existing = await this.getAction(id);
		if (existing === void 0) throw new Error(`devflow: cannot update unknown action ${id}`);
		if (!ACTION_TRANSITIONS[existing.status].includes(status)) throw new Error(`devflow: illegal action transition ${existing.status} -> ${status} for ${id}`);
		const updated = {
			...existing,
			status,
			updatedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		validateCommanderAction(updated, "memory");
		await this.writeJson(await this.actionTarget(id), updated);
		return updated;
	}
	/** Resolve one runtime session record file. */
	sessionTarget(id) {
		return this.fs.resolve(join(this.root, SESSIONS_DIR, `${id}${FILE_SUFFIX}`));
	}
	/**
	* Create and persist one runtime session (starts `created`).
	* @param input - session fields without the store-owned id, status,
	*   timestamps, and start/complete stamps.
	* @returns the persisted session.
	*/
	async createRuntimeSession(input) {
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const session = {
			...input,
			sessionId: randomUUID(),
			status: "created",
			startedAt: null,
			completedAt: null,
			createdAt: now,
			updatedAt: now
		};
		validateRuntimeSession(session, "memory");
		await this.writeJson(await this.sessionTarget(session.sessionId), session, { kind: "createIfAbsent" });
		return session;
	}
	/** Load one runtime session; undefined when the id is unknown. */
	async getRuntimeSession(id) {
		assertUuid(id, "session");
		const target = await this.sessionTarget(id);
		const raw = await this.readJson(target);
		return raw === void 0 ? void 0 : validateRuntimeSession(raw, target.displayPath);
	}
	/**
	* Transition one runtime session's status, validating the lifecycle edge
	* and stamping `startedAt`/`completedAt` on the crossing edges.
	*/
	async updateRuntimeSessionStatus(id, status) {
		assertUuid(id, "session");
		const existing = await this.getRuntimeSession(id);
		if (existing === void 0) throw new Error(`devflow: cannot update unknown runtime session ${id}`);
		if (!RUNTIME_SESSION_TRANSITIONS[existing.status].includes(status)) throw new Error(`devflow: illegal runtime session transition ${existing.status} -> ${status} for ${id}`);
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const updated = {
			...existing,
			status,
			...status === "running" && existing.startedAt === null ? { startedAt: now } : {},
			...(status === "completed" || status === "failed") && existing.completedAt === null ? { completedAt: now } : {},
			updatedAt: now
		};
		validateRuntimeSession(updated, "memory");
		await this.writeJson(await this.sessionTarget(id), updated);
		return updated;
	}
	/** Load every runtime session for one execution, oldest first. */
	async listRuntimeSessionsByExecution(executionId) {
		const dir = await this.fs.resolve(join(this.root, SESSIONS_DIR));
		const info = await this.fs.stat(dir);
		if (info === void 0) return [];
		if (info.type !== "directory") throw new Error(`devflow: not a directory: ${dir.displayPath}`);
		const sessions = [];
		for (const entry of await this.fs.listDir(dir)) {
			if (entry.type !== "file" || !entry.name.endsWith(FILE_SUFFIX)) continue;
			const raw = await this.readJson(entry.target);
			if (raw !== void 0) {
				const session = validateRuntimeSession(raw, entry.target.displayPath);
				if (session.executionId === executionId) sessions.push(session);
			}
		}
		return sessions.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}
	/**
	* Persist one complete agent report record as-is (validate + write). This
	* keeps the report id and timestamps produced by the runtime bridge — the
	* caller layer that converted a runtime result package — authoritative.
	* @param report - the complete report record to persist.
	*/
	async saveReport(report) {
		validateAgentReport(report, "memory");
		await this.writeJson(await this.reportTarget(report.reportId), report, { kind: "createIfAbsent" });
	}
	/** Resolve one execution attempt record file. */
	attemptTarget(id) {
		return this.fs.resolve(join(this.root, ATTEMPTS_DIR, `${id}${FILE_SUFFIX}`));
	}
	/**
	* Create and persist one execution attempt (starts `created`). A retry
	* chains a new attempt under the previous one via `parentAttemptId` and
	* records why it exists in `reason`.
	* @param input - attempt fields without the store-owned id, status,
	*   `createdAt`, `completedAt`, and `updatedAt`.
	* @returns the persisted attempt.
	*/
	async createAttempt(input) {
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const attempt = {
			...input,
			attemptId: randomUUID(),
			status: "created",
			createdAt: now,
			completedAt: null,
			updatedAt: now
		};
		validateExecutionAttempt(attempt, "memory");
		await this.writeJson(await this.attemptTarget(attempt.attemptId), attempt, { kind: "createIfAbsent" });
		return attempt;
	}
	/** Load one execution attempt; undefined when the id is unknown. */
	async getAttempt(id) {
		assertUuid(id, "attempt");
		const target = await this.attemptTarget(id);
		const raw = await this.readJson(target);
		return raw === void 0 ? void 0 : validateExecutionAttempt(raw, target.displayPath);
	}
	/**
	* Transition one execution attempt's status, validating the lifecycle edge
	* and stamping `completedAt` on the terminal edges.
	*/
	async updateAttemptStatus(id, status) {
		assertUuid(id, "attempt");
		const existing = await this.getAttempt(id);
		if (existing === void 0) throw new Error(`devflow: cannot update unknown execution attempt ${id}`);
		if (!ATTEMPT_TRANSITIONS[existing.status].includes(status)) throw new Error(`devflow: illegal execution attempt transition ${existing.status} -> ${status} for ${id}`);
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const updated = {
			...existing,
			status,
			...(status === "completed" || status === "failed") && existing.completedAt === null ? { completedAt: now } : {},
			updatedAt: now
		};
		validateExecutionAttempt(updated, "memory");
		await this.writeJson(await this.attemptTarget(id), updated);
		return updated;
	}
	/** Load every execution attempt for one execution, oldest first. */
	async listAttemptsByExecution(executionId) {
		const dir = await this.fs.resolve(join(this.root, ATTEMPTS_DIR));
		const info = await this.fs.stat(dir);
		if (info === void 0) return [];
		if (info.type !== "directory") throw new Error(`devflow: not a directory: ${dir.displayPath}`);
		const attempts = [];
		for (const entry of await this.fs.listDir(dir)) {
			if (entry.type !== "file" || !entry.name.endsWith(FILE_SUFFIX)) continue;
			const raw = await this.readJson(entry.target);
			if (raw !== void 0) {
				const attempt = validateExecutionAttempt(raw, entry.target.displayPath);
				if (attempt.executionId === executionId) attempts.push(attempt);
			}
		}
		return attempts.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}
	/** Resolve one commander review record file. */
	reviewTarget(id) {
		return this.fs.resolve(join(this.root, REVIEWS_DIR, `${id}${FILE_SUFFIX}`));
	}
	/**
	* Create and persist one commander review (starts `pending`).
	* @param input - review fields without the store-owned id, status, and
	*   timestamps.
	* @returns the persisted review.
	*/
	async createReview(input) {
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const review = {
			...input,
			reviewId: randomUUID(),
			status: "pending",
			createdAt: now,
			updatedAt: now
		};
		validateCommanderReview(review, "memory");
		await this.writeJson(await this.reviewTarget(review.reviewId), review, { kind: "createIfAbsent" });
		return review;
	}
	/** Load one commander review; undefined when the id is unknown. */
	async getReview(id) {
		assertUuid(id, "review");
		const target = await this.reviewTarget(id);
		const raw = await this.readJson(target);
		return raw === void 0 ? void 0 : validateCommanderReview(raw, target.displayPath);
	}
	/**
	* Complete one commander review (pending → reviewed) and refresh
	* `updatedAt`. The review carries no decision content — a future Commander
	* fills the decision from an explicit review outcome.
	*/
	async completeReview(id) {
		assertUuid(id, "review");
		const existing = await this.getReview(id);
		if (existing === void 0) throw new Error(`devflow: cannot complete unknown review ${id}`);
		if (!REVIEW_TRANSITIONS[existing.status].includes("reviewed")) throw new Error(`devflow: illegal review transition ${existing.status} -> reviewed for ${id}`);
		const updated = {
			...existing,
			status: "reviewed",
			updatedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		validateCommanderReview(updated, "memory");
		await this.writeJson(await this.reviewTarget(id), updated);
		return updated;
	}
	/** Load every commander review for one execution, oldest first. */
	async listReviewsByExecution(executionId) {
		const dir = await this.fs.resolve(join(this.root, REVIEWS_DIR));
		const info = await this.fs.stat(dir);
		if (info === void 0) return [];
		if (info.type !== "directory") throw new Error(`devflow: not a directory: ${dir.displayPath}`);
		const reviews = [];
		for (const entry of await this.fs.listDir(dir)) {
			if (entry.type !== "file" || !entry.name.endsWith(FILE_SUFFIX)) continue;
			const raw = await this.readJson(entry.target);
			if (raw !== void 0) {
				const review = validateCommanderReview(raw, entry.target.displayPath);
				if (review.executionId === executionId) reviews.push(review);
			}
		}
		return reviews.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}
	/** Resolve one commander memory record file. */
	memoryTarget(id) {
		return this.fs.resolve(join(this.root, MEMORY_DIR, `${id}${FILE_SUFFIX}`));
	}
	/**
	* Create and persist one structured commander memory with a generated id
	* and timestamps.
	* @param input - memory fields without the store-owned id and timestamps.
	* @returns the persisted memory.
	*/
	async createMemory(input) {
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const memory = {
			...input,
			memoryId: randomUUID(),
			createdAt: now,
			updatedAt: now
		};
		validateCommanderMemory(memory, "memory");
		await this.writeJson(await this.memoryTarget(memory.memoryId), memory, { kind: "createIfAbsent" });
		return memory;
	}
	/** Load one commander memory; undefined when the id is unknown. */
	async getMemory(id) {
		assertUuid(id, "memory");
		const target = await this.memoryTarget(id);
		const raw = await this.readJson(target);
		return raw === void 0 ? void 0 : validateCommanderMemory(raw, target.displayPath);
	}
	/**
	* Apply a partial update to one commander memory and refresh `updatedAt`.
	* The id, project, type, and `createdAt` are immutable; unknown ids fail
	* loud.
	*/
	async updateMemory(id, patch) {
		assertUuid(id, "memory");
		const existing = await this.getMemory(id);
		if (existing === void 0) throw new Error(`devflow: cannot update unknown memory ${id}`);
		const { content, source } = patch;
		const updated = {
			...existing,
			...content !== void 0 ? { content } : {},
			...source !== void 0 ? { source } : {},
			updatedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		validateCommanderMemory(updated, "memory");
		await this.writeJson(await this.memoryTarget(id), updated);
		return updated;
	}
	/** Load every commander memory for one project, oldest first. */
	async listMemoriesByProject(projectId) {
		const dir = await this.fs.resolve(join(this.root, MEMORY_DIR));
		const info = await this.fs.stat(dir);
		if (info === void 0) return [];
		if (info.type !== "directory") throw new Error(`devflow: not a directory: ${dir.displayPath}`);
		const memories = [];
		for (const entry of await this.fs.listDir(dir)) {
			if (entry.type !== "file" || !entry.name.endsWith(FILE_SUFFIX)) continue;
			const raw = await this.readJson(entry.target);
			if (raw !== void 0) {
				const memory = validateCommanderMemory(raw, entry.target.displayPath);
				if (memory.projectId === projectId) memories.push(memory);
			}
		}
		return memories.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}
	/** Resolve one commander schedule record file. */
	scheduleTarget(id) {
		return this.fs.resolve(join(this.root, SCHEDULES_DIR, `${id}${FILE_SUFFIX}`));
	}
	/**
	* Create and persist one commander schedule (starts `active` with no last
	* run and the first `nextRunAt` one interval ahead).
	* @param input - schedule fields without the store-owned id, status,
	*   run stamps, and timestamps.
	* @returns the persisted schedule.
	*/
	async createSchedule(input) {
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const schedule = {
			...input,
			scheduleId: randomUUID(),
			status: "active",
			lastRunAt: null,
			nextRunAt: new Date(Date.parse(now) + input.interval).toISOString(),
			createdAt: now,
			updatedAt: now
		};
		validateCommanderSchedule(schedule, "memory");
		await this.writeJson(await this.scheduleTarget(schedule.scheduleId), schedule, { kind: "createIfAbsent" });
		return schedule;
	}
	/** Load one commander schedule; undefined when the id is unknown. */
	async getSchedule(id) {
		assertUuid(id, "schedule");
		const target = await this.scheduleTarget(id);
		const raw = await this.readJson(target);
		return raw === void 0 ? void 0 : validateCommanderSchedule(raw, target.displayPath);
	}
	/**
	* Apply a partial update to one commander schedule: an interval change
	* rolls `nextRunAt` forward, and a `markRunAt` stamp records a completed
	* run. Unknown ids fail loud.
	*/
	async updateSchedule(id, patch) {
		assertUuid(id, "schedule");
		const existing = await this.getSchedule(id);
		if (existing === void 0) throw new Error(`devflow: cannot update unknown schedule ${id}`);
		const updated = applySchedulePatch(existing, patch, (/* @__PURE__ */ new Date()).toISOString());
		validateCommanderSchedule(updated, "memory");
		await this.writeJson(await this.scheduleTarget(id), updated);
		return updated;
	}
	/** Pause one commander schedule (active → paused) and refresh `updatedAt`. */
	async pauseSchedule(id) {
		assertUuid(id, "schedule");
		const existing = await this.getSchedule(id);
		if (existing === void 0) throw new Error(`devflow: cannot pause unknown schedule ${id}`);
		if (existing.status !== "active") throw new Error(`devflow: cannot pause schedule ${id} in status ${existing.status}`);
		const updated = {
			...existing,
			status: "paused",
			updatedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		validateCommanderSchedule(updated, "memory");
		await this.writeJson(await this.scheduleTarget(id), updated);
		return updated;
	}
	/** Load every commander schedule, oldest first; an empty schedules/ is an empty list. */
	async listSchedules() {
		const dir = await this.fs.resolve(join(this.root, SCHEDULES_DIR));
		const info = await this.fs.stat(dir);
		if (info === void 0) return [];
		if (info.type !== "directory") throw new Error(`devflow: not a directory: ${dir.displayPath}`);
		const schedules = [];
		for (const entry of await this.fs.listDir(dir)) {
			if (entry.type !== "file" || !entry.name.endsWith(FILE_SUFFIX)) continue;
			const raw = await this.readJson(entry.target);
			if (raw !== void 0) schedules.push(validateCommanderSchedule(raw, entry.target.displayPath));
		}
		return schedules.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}
	/** Resolve one commander run record file. */
	runTarget(id) {
		return this.fs.resolve(join(this.root, RUNS_DIR, `${id}${FILE_SUFFIX}`));
	}
	/**
	* Create and persist one commander run record (born `running`).
	* @param input - run fields without the store-owned id, status, produced
	*   ids, and timestamps.
	* @returns the persisted run.
	*/
	async createRunRecord(input) {
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const run = {
			...input,
			runId: randomUUID(),
			status: "running",
			decisionId: null,
			actionId: null,
			startedAt: now,
			completedAt: null,
			updatedAt: now
		};
		validateCommanderRunRecord(run, "memory");
		await this.writeJson(await this.runTarget(run.runId), run, { kind: "createIfAbsent" });
		return run;
	}
	/** Load one commander run record; undefined when the id is unknown. */
	async getRunRecord(id) {
		assertUuid(id, "run");
		const target = await this.runTarget(id);
		const raw = await this.readJson(target);
		return raw === void 0 ? void 0 : validateCommanderRunRecord(raw, target.displayPath);
	}
	/**
	* Complete one commander run (running → completed): record the produced
	* decision and action ids and stamp `completedAt`.
	*/
	async completeRunRecord(id, decisionId, actionId) {
		assertUuid(id, "run");
		const existing = await this.getRunRecord(id);
		if (existing === void 0) throw new Error(`devflow: cannot complete unknown run ${id}`);
		if (!RUN_TRANSITIONS[existing.status].includes("completed")) throw new Error(`devflow: illegal run transition ${existing.status} -> completed for ${id}`);
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const updated = {
			...existing,
			status: "completed",
			decisionId,
			actionId,
			completedAt: now,
			updatedAt: now
		};
		validateCommanderRunRecord(updated, "memory");
		await this.writeJson(await this.runTarget(id), updated);
		return updated;
	}
	/** Fail one commander run (running → failed) and stamp `completedAt`. */
	async failRunRecord(id) {
		assertUuid(id, "run");
		const existing = await this.getRunRecord(id);
		if (existing === void 0) throw new Error(`devflow: cannot fail unknown run ${id}`);
		if (!RUN_TRANSITIONS[existing.status].includes("failed")) throw new Error(`devflow: illegal run transition ${existing.status} -> failed for ${id}`);
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const updated = {
			...existing,
			status: "failed",
			completedAt: now,
			updatedAt: now
		};
		validateCommanderRunRecord(updated, "memory");
		await this.writeJson(await this.runTarget(id), updated);
		return updated;
	}
	/** Load every commander run record for one project, oldest first. */
	async listRunRecordsByProject(projectId) {
		const dir = await this.fs.resolve(join(this.root, RUNS_DIR));
		const info = await this.fs.stat(dir);
		if (info === void 0) return [];
		if (info.type !== "directory") throw new Error(`devflow: not a directory: ${dir.displayPath}`);
		const runs = [];
		for (const entry of await this.fs.listDir(dir)) {
			if (entry.type !== "file" || !entry.name.endsWith(FILE_SUFFIX)) continue;
			const raw = await this.readJson(entry.target);
			if (raw !== void 0) {
				const run = validateCommanderRunRecord(raw, entry.target.displayPath);
				if (run.projectId === projectId) runs.push(run);
			}
		}
		return runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
	}
	/** Resolve one commander action execution record file. */
	actionExecutionTarget(id) {
		return this.fs.resolve(join(this.root, ACTION_EXECUTIONS_DIR, `${id}${FILE_SUFFIX}`));
	}
	/**
	* Create and persist one commander action execution (born `running` with no
	* outcome yet).
	* @param input - execution fields without the store-owned id, status,
	*   outcome, and timestamps.
	* @returns the persisted execution.
	*/
	async createActionExecution(input) {
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const execution = {
			...input,
			executionId: randomUUID(),
			status: "running",
			success: null,
			error: null,
			createdAt: now,
			completedAt: null,
			updatedAt: now
		};
		validateCommanderActionExecution(execution, "memory");
		await this.writeJson(await this.actionExecutionTarget(execution.executionId), execution, { kind: "createIfAbsent" });
		return execution;
	}
	/** Load one commander action execution; undefined when the id is unknown. */
	async getActionExecution(id) {
		assertUuid(id, "action-execution");
		const target = await this.actionExecutionTarget(id);
		const raw = await this.readJson(target);
		return raw === void 0 ? void 0 : validateCommanderActionExecution(raw, target.displayPath);
	}
	/** Complete one action execution (running → completed, success true) and stamp `completedAt`. */
	async completeActionExecution(id) {
		assertUuid(id, "action-execution");
		const existing = await this.getActionExecution(id);
		if (existing === void 0) throw new Error(`devflow: cannot complete unknown action execution ${id}`);
		if (!ACTION_EXECUTION_TRANSITIONS[existing.status].includes("completed")) throw new Error(`devflow: illegal action execution transition ${existing.status} -> completed for ${id}`);
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const updated = {
			...existing,
			status: "completed",
			success: true,
			completedAt: now,
			updatedAt: now
		};
		validateCommanderActionExecution(updated, "memory");
		await this.writeJson(await this.actionExecutionTarget(id), updated);
		return updated;
	}
	/** Fail one action execution (running → failed, success false) with the error, and stamp `completedAt`. */
	async failActionExecution(id, error) {
		assertUuid(id, "action-execution");
		const existing = await this.getActionExecution(id);
		if (existing === void 0) throw new Error(`devflow: cannot fail unknown action execution ${id}`);
		if (!ACTION_EXECUTION_TRANSITIONS[existing.status].includes("failed")) throw new Error(`devflow: illegal action execution transition ${existing.status} -> failed for ${id}`);
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const updated = {
			...existing,
			status: "failed",
			success: false,
			error,
			completedAt: now,
			updatedAt: now
		};
		validateCommanderActionExecution(updated, "memory");
		await this.writeJson(await this.actionExecutionTarget(id), updated);
		return updated;
	}
	/** Load every commander action execution for one action, oldest first. */
	async listActionExecutionsByAction(actionId) {
		const dir = await this.fs.resolve(join(this.root, ACTION_EXECUTIONS_DIR));
		const info = await this.fs.stat(dir);
		if (info === void 0) return [];
		if (info.type !== "directory") throw new Error(`devflow: not a directory: ${dir.displayPath}`);
		const executions = [];
		for (const entry of await this.fs.listDir(dir)) {
			if (entry.type !== "file" || !entry.name.endsWith(FILE_SUFFIX)) continue;
			const raw = await this.readJson(entry.target);
			if (raw !== void 0) {
				const execution = validateCommanderActionExecution(raw, entry.target.displayPath);
				if (execution.actionId === actionId) executions.push(execution);
			}
		}
		return executions.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}
	/** Resolve one project policy record file. */
	policyTarget(projectId) {
		return this.fs.resolve(join(this.root, POLICIES_DIR, `${projectId}${FILE_SUFFIX}`));
	}
	/**
	* Save (create or replace) the governance policy for one project. The
	* first save sets `createdAt`; later saves keep it and refresh `updatedAt`.
	* @param policy - policy fields without the store-owned timestamps.
	* @returns the persisted policy.
	*/
	async savePolicy(policy) {
		assertProjectId(policy.projectId);
		const existing = await this.getPolicy(policy.projectId);
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const saved = {
			...policy,
			createdAt: existing?.createdAt ?? now,
			updatedAt: now
		};
		validateCommanderPolicy(saved, "memory");
		await this.writeJson(await this.policyTarget(policy.projectId), saved);
		return saved;
	}
	/** Load the governance policy for one project; undefined when never saved. */
	async getPolicy(projectId) {
		assertProjectId(projectId);
		const target = await this.policyTarget(projectId);
		const raw = await this.readJson(target);
		return raw === void 0 ? void 0 : validateCommanderPolicy(raw, target.displayPath);
	}
	/** Resolve one commander proposal record file. */
	proposalTarget(id) {
		return this.fs.resolve(join(this.root, PROPOSALS_DIR, `${id}${FILE_SUFFIX}`));
	}
	/**
	* Create and persist one commander proposal (starts `created`).
	* @param input - proposal fields without the store-owned id, status, and
	*   timestamps.
	* @returns the persisted proposal.
	*/
	async createProposal(input) {
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const proposal = {
			...input,
			proposalId: randomUUID(),
			status: "created",
			createdAt: now,
			updatedAt: now
		};
		validateCommanderProposal(proposal, "memory");
		await this.writeJson(await this.proposalTarget(proposal.proposalId), proposal, { kind: "createIfAbsent" });
		return proposal;
	}
	/** Load one commander proposal; undefined when the id is unknown. */
	async getProposal(id) {
		assertUuid(id, "proposal");
		const target = await this.proposalTarget(id);
		const raw = await this.readJson(target);
		return raw === void 0 ? void 0 : validateCommanderProposal(raw, target.displayPath);
	}
	/** Approve one commander proposal (created → approved) and refresh `updatedAt`. */
	async approveProposal(id) {
		assertUuid(id, "proposal");
		const existing = await this.getProposal(id);
		if (existing === void 0) throw new Error(`devflow: cannot approve unknown proposal ${id}`);
		if (!PROPOSAL_TRANSITIONS[existing.status].includes("approved")) throw new Error(`devflow: illegal proposal transition ${existing.status} -> approved for ${id}`);
		const updated = {
			...existing,
			status: "approved",
			updatedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		validateCommanderProposal(updated, "memory");
		await this.writeJson(await this.proposalTarget(id), updated);
		return updated;
	}
	/** Reject one commander proposal (created → rejected) and refresh `updatedAt`. */
	async rejectProposal(id) {
		assertUuid(id, "proposal");
		const existing = await this.getProposal(id);
		if (existing === void 0) throw new Error(`devflow: cannot reject unknown proposal ${id}`);
		if (!PROPOSAL_TRANSITIONS[existing.status].includes("rejected")) throw new Error(`devflow: illegal proposal transition ${existing.status} -> rejected for ${id}`);
		const updated = {
			...existing,
			status: "rejected",
			updatedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		validateCommanderProposal(updated, "memory");
		await this.writeJson(await this.proposalTarget(id), updated);
		return updated;
	}
	/** Load every commander proposal for one decision, oldest first. */
	async listProposalsByDecision(decisionId) {
		const dir = await this.fs.resolve(join(this.root, PROPOSALS_DIR));
		const info = await this.fs.stat(dir);
		if (info === void 0) return [];
		if (info.type !== "directory") throw new Error(`devflow: not a directory: ${dir.displayPath}`);
		const proposals = [];
		for (const entry of await this.fs.listDir(dir)) {
			if (entry.type !== "file" || !entry.name.endsWith(FILE_SUFFIX)) continue;
			const raw = await this.readJson(entry.target);
			if (raw !== void 0) {
				const proposal = validateCommanderProposal(raw, entry.target.displayPath);
				if (proposal.decisionId === decisionId) proposals.push(proposal);
			}
		}
		return proposals.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}
	/** Resolve one commander workflow record file. */
	workflowTarget(id) {
		return this.fs.resolve(join(this.root, WORKFLOWS_DIR, `${id}${FILE_SUFFIX}`));
	}
	/**
	* Create and persist one commander development workflow (born `created`
	* with an empty execution history).
	* @param input - workflow fields without the store-owned id, status,
	*   history, and timestamps.
	* @returns the persisted workflow.
	*/
	async createWorkflow(input) {
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const workflow = {
			...input,
			workflowId: randomUUID(),
			status: "created",
			history: [],
			createdAt: now,
			updatedAt: now
		};
		validateCommanderWorkflow(workflow, "memory");
		await this.writeJson(await this.workflowTarget(workflow.workflowId), workflow, { kind: "createIfAbsent" });
		return workflow;
	}
	/** Load one commander workflow; undefined when the id is unknown. */
	async getWorkflow(id) {
		assertUuid(id, "workflow");
		const target = await this.workflowTarget(id);
		const raw = await this.readJson(target);
		return raw === void 0 ? void 0 : validateCommanderWorkflow(raw, target.displayPath);
	}
	/** Start one commander workflow (created → running) and refresh `updatedAt`. */
	async startWorkflow(id) {
		assertUuid(id, "workflow");
		const existing = await this.getWorkflow(id);
		if (existing === void 0) throw new Error(`devflow: cannot start unknown workflow ${id}`);
		if (!WORKFLOW_TRANSITIONS[existing.status].includes("running")) throw new Error(`devflow: illegal workflow transition ${existing.status} -> running for ${id}`);
		const updated = {
			...existing,
			status: "running",
			updatedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		validateCommanderWorkflow(updated, "memory");
		await this.writeJson(await this.workflowTarget(id), updated);
		return updated;
	}
	/** Complete one commander workflow (running → completed) and refresh `updatedAt`. */
	async completeWorkflow(id) {
		assertUuid(id, "workflow");
		const existing = await this.getWorkflow(id);
		if (existing === void 0) throw new Error(`devflow: cannot complete unknown workflow ${id}`);
		if (!WORKFLOW_TRANSITIONS[existing.status].includes("completed")) throw new Error(`devflow: illegal workflow transition ${existing.status} -> completed for ${id}`);
		const updated = {
			...existing,
			status: "completed",
			updatedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		validateCommanderWorkflow(updated, "memory");
		await this.writeJson(await this.workflowTarget(id), updated);
		return updated;
	}
	/** Fail one commander workflow (running → failed) and refresh `updatedAt`. */
	async failWorkflow(id) {
		assertUuid(id, "workflow");
		const existing = await this.getWorkflow(id);
		if (existing === void 0) throw new Error(`devflow: cannot fail unknown workflow ${id}`);
		if (!WORKFLOW_TRANSITIONS[existing.status].includes("failed")) throw new Error(`devflow: illegal workflow transition ${existing.status} -> failed for ${id}`);
		const updated = {
			...existing,
			status: "failed",
			updatedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		validateCommanderWorkflow(updated, "memory");
		await this.writeJson(await this.workflowTarget(id), updated);
		return updated;
	}
	/** Append one execution-history entry to a running workflow and refresh `updatedAt`. */
	async appendWorkflowExecution(id, entry) {
		assertUuid(id, "workflow");
		assertUuid(entry.entryId, "workflow-entry");
		const existing = await this.getWorkflow(id);
		if (existing === void 0) throw new Error(`devflow: cannot append to unknown workflow ${id}`);
		if (existing.status !== "running") throw new Error(`devflow: cannot append to workflow ${id} in status ${existing.status}`);
		validateCommanderWorkflowExecution(entry, "memory");
		const updated = {
			...existing,
			history: [...existing.history, entry],
			updatedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		validateCommanderWorkflow(updated, "memory");
		await this.writeJson(await this.workflowTarget(id), updated);
		return updated;
	}
	/** Load every commander workflow for one project, oldest first. */
	async listWorkflowsByProject(projectId) {
		const dir = await this.fs.resolve(join(this.root, WORKFLOWS_DIR));
		const info = await this.fs.stat(dir);
		if (info === void 0) return [];
		if (info.type !== "directory") throw new Error(`devflow: not a directory: ${dir.displayPath}`);
		const workflows = [];
		for (const entry of await this.fs.listDir(dir)) {
			if (entry.type !== "file" || !entry.name.endsWith(FILE_SUFFIX)) continue;
			const raw = await this.readJson(entry.target);
			if (raw !== void 0) {
				const workflow = validateCommanderWorkflow(raw, entry.target.displayPath);
				if (workflow.projectId === projectId) workflows.push(workflow);
			}
		}
		return workflows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}
	/** Resolve one commander workflow step record file. */
	stepTarget(id) {
		return this.fs.resolve(join(this.root, STEPS_DIR, `${id}${FILE_SUFFIX}`));
	}
	/**
	* Create and persist one commander workflow step (born `pending`).
	* @param input - step fields without the store-owned id, status, and
	*   timestamps.
	* @returns the persisted step.
	*/
	async createStep(input) {
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const step = {
			...input,
			stepId: randomUUID(),
			status: "pending",
			createdAt: now,
			updatedAt: now
		};
		validateCommanderWorkflowStep(step, "memory");
		await this.writeJson(await this.stepTarget(step.stepId), step, { kind: "createIfAbsent" });
		return step;
	}
	/** Load one commander workflow step; undefined when the id is unknown. */
	async getStep(id) {
		assertUuid(id, "step");
		const target = await this.stepTarget(id);
		const raw = await this.readJson(target);
		return raw === void 0 ? void 0 : validateCommanderWorkflowStep(raw, target.displayPath);
	}
	/** Start one commander workflow step (pending → running) and refresh `updatedAt`. */
	async startStep(id) {
		assertUuid(id, "step");
		const existing = await this.getStep(id);
		if (existing === void 0) throw new Error(`devflow: cannot start unknown step ${id}`);
		if (!STEP_TRANSITIONS[existing.status].includes("running")) throw new Error(`devflow: illegal step transition ${existing.status} -> running for ${id}`);
		const updated = {
			...existing,
			status: "running",
			updatedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		validateCommanderWorkflowStep(updated, "memory");
		await this.writeJson(await this.stepTarget(id), updated);
		return updated;
	}
	/** Complete one commander workflow step (running → completed) and refresh `updatedAt`. */
	async completeStep(id) {
		assertUuid(id, "step");
		const existing = await this.getStep(id);
		if (existing === void 0) throw new Error(`devflow: cannot complete unknown step ${id}`);
		if (!STEP_TRANSITIONS[existing.status].includes("completed")) throw new Error(`devflow: illegal step transition ${existing.status} -> completed for ${id}`);
		const updated = {
			...existing,
			status: "completed",
			updatedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		validateCommanderWorkflowStep(updated, "memory");
		await this.writeJson(await this.stepTarget(id), updated);
		return updated;
	}
	/** Fail one commander workflow step (running → failed) and refresh `updatedAt`. */
	async failStep(id) {
		assertUuid(id, "step");
		const existing = await this.getStep(id);
		if (existing === void 0) throw new Error(`devflow: cannot fail unknown step ${id}`);
		if (!STEP_TRANSITIONS[existing.status].includes("failed")) throw new Error(`devflow: illegal step transition ${existing.status} -> failed for ${id}`);
		const updated = {
			...existing,
			status: "failed",
			updatedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		validateCommanderWorkflowStep(updated, "memory");
		await this.writeJson(await this.stepTarget(id), updated);
		return updated;
	}
	/** Load every commander workflow step for one workflow, in sequence order. */
	async listStepsByWorkflow(workflowId) {
		return (await this.listRecords(STEPS_DIR, validateCommanderWorkflowStep)).filter((step) => step.workflowId === workflowId).sort((a, b) => a.stepIndex - b.stepIndex);
	}
	/** Read all valid records in one store directory, ordered by creation time. */
	async listRecords(directory, validate) {
		const dir = await this.fs.resolve(join(this.root, directory));
		const info = await this.fs.stat(dir);
		if (info === void 0) return [];
		if (info.type !== "directory") throw new Error(`devflow: not a directory: ${dir.displayPath}`);
		const records = [];
		for (const entry of await this.fs.listDir(dir)) {
			if (entry.type !== "file" || !entry.name.endsWith(FILE_SUFFIX)) continue;
			const raw = await this.readJson(entry.target);
			if (raw !== void 0) records.push(validate(raw, entry.target.displayPath));
		}
		return records.sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
	}
	/**
	* Recover the complete state from entity files plus the committed plugin
	* journal. Entity files are authoritative for current records; the journal
	* supplies ordering and control facts that have no standalone file.
	*/
	async loadState() {
		const [project, tasks, agentInstances, agents, phases, scope, improvements, checkpoints, assignments, plans, batches, executions, attempts, reports, decisions, actions, reviews, runtimeSessions, memories, schedules, runs, actionExecutions, policies, proposals, workflows, steps, journal] = await Promise.all([
			this.loadProject(),
			this.listTasks(),
			this.listAgentInstances(),
			this.listRecords(ORCHESTRATION_AGENTS_DIR, validateOrchestrationAgent),
			this.listRecords(PHASES_DIR, validatePhase),
			this.getScope(),
			this.listImprovements(),
			this.listCheckpoints(),
			this.listAssignments(),
			this.listPlanning(),
			this.listBatches(),
			this.listRecords(EXECUTIONS_DIR, validateExecutionRecord),
			this.listRecords(ATTEMPTS_DIR, validateExecutionAttempt),
			this.listRecords(REPORTS_DIR, validateAgentReport),
			this.listDecisions(),
			this.listActions(),
			this.listRecords(REVIEWS_DIR, validateCommanderReview),
			this.listRecords(SESSIONS_DIR, validateRuntimeSession),
			this.listRecords(MEMORY_DIR, validateCommanderMemory),
			this.listSchedules(),
			this.listRecords(RUNS_DIR, validateCommanderRunRecord),
			this.listRecords(ACTION_EXECUTIONS_DIR, validateCommanderActionExecution),
			this.listRecords(POLICIES_DIR, validateCommanderPolicy),
			this.listRecords(PROPOSALS_DIR, validateCommanderProposal),
			this.listRecords(WORKFLOWS_DIR, validateCommanderWorkflow),
			this.listRecords(STEPS_DIR, validateCommanderWorkflowStep),
			this.listJournal()
		]);
		const by = (items, id) => Object.fromEntries(items.map((item) => [id(item), item]));
		let state = {
			project: project ?? null,
			tasks: Object.fromEntries(tasks.map((task) => [task.id, task.status])),
			taskTitles: Object.fromEntries(tasks.map((task) => [task.id, task.title])),
			agents: agentInstances,
			orchestrationAgents: by(agents, (agent) => agent.agentId),
			plan: await this.getMvpPlan() ?? null,
			phases: by(phases, (phase) => phase.id),
			scope: scope ?? null,
			improvements,
			commanderCheckpoints: by(checkpoints, (checkpoint) => checkpoint.checkpointId),
			assignments: by(assignments, (assignment) => assignment.assignmentId),
			commanderPlans: by(plans, (plan) => plan.planningId),
			executionBatches: by(batches, (batch) => batch.batchId),
			executions: by(executions, (execution) => execution.executionId),
			executionAttempts: by(attempts, (attempt) => attempt.attemptId),
			agentReports: by(reports, (report) => report.reportId),
			blockedReports: Object.fromEntries(journal.filter((entry) => entry.type === "devflow/blocked/report").map((entry) => entry.data).map((payload) => payload.blocked).map((report) => [report.blockedId, report])),
			commanderDecisions: by(decisions, (decision) => decision.decisionId),
			commanderActions: by(actions, (action) => action.actionId),
			commanderReviews: by(reviews, (review) => review.reviewId),
			runtimePackages: {},
			runtimeResults: {},
			runtimeSessions: by(runtimeSessions, (session) => session.sessionId),
			commanderMemory: by(memories, (memory) => memory.memoryId),
			commanderSchedules: by(schedules, (schedule) => schedule.scheduleId),
			commanderRuns: by(runs, (run) => run.runId),
			commanderActionExecutions: by(actionExecutions, (execution) => execution.executionId),
			policies: by(policies, (policy) => policy.projectId),
			commanderProposals: by(proposals, (proposal) => proposal.proposalId),
			commanderExecutionContexts: {},
			commanderWorkflows: by(workflows, (workflow) => workflow.workflowId),
			commanderWorkflowSteps: by(steps, (step) => step.stepId),
			scopeBoundaryHits: [],
			decisionRequests: {},
			dispatchDiagnostics: {},
			reviewFailCounts: {},
			commanderMode: "chat",
			paused: false
		};
		const journalOnlyTypes = /* @__PURE__ */ new Set([
			"devflow/bridge/import",
			"devflow/decision/request",
			"devflow/decision/answer",
			"devflow/dispatch/diagnostic",
			"devflow/commander/mode-enter",
			"devflow/commander/mode-exit",
			"devflow/control/pause",
			"devflow/control/resume",
			"devflow/scope/boundary-hit",
			"devflow/runtime/export",
			"devflow/runtime/import",
			"devflow/commander/execution-context/create"
		]);
		for (const entry of journal) {
			if (!journalOnlyTypes.has(entry.type)) continue;
			state = applyDevFlowStateEvent(state, {
				type: entry.type,
				seq: entry.sequence,
				time: Date.parse(entry.at),
				data: entry.data
			});
		}
		return state;
	}
};
//#endregion
//#region lib/host/session-store.js
/**
* Session-scoped `.devflow` store resolution (第九步 · 项目隔离).
*
* The store root used to be one process-wide constant, so every project session
* on the machine shared one `.devflow` — one task list, one roster, one "memory".
* This module derives the root from the CALLING SESSION'S WORKSPACE instead:
* `<session cwd>/.devflow`, so project A and project B cannot see each other.
*
* Three rules carry the product decision:
*
* 1. **Derived from the session workspace.** The session cwd is the only input.
*    It is read from `agent.session.header.cwd` — the same durable session fact
*    the Harness filesystem tools resolve relative paths against.
* 2. **Session-level lock.** The first resolution for a session PINS its root.
*    A later workspace change inside the same session does not re-point the
*    store: a session keeps talking to the project it started on (decision 4).
* 3. **Never a silent fallback.** A session with no workspace facts does not
*    quietly inherit the shared library. It throws
*    {@link DevFlowSessionScopeError}, and the caller surfaces that refusal —
*    an unisolated read must never look like a successful isolated one.
*
* The pre-existing mixed library (`<host cwd>/.devflow`) is deliberately still
* readable and untouched: nothing is moved, split, deleted, or re-attributed
* (decision 3). No session is served from it, though — unlike before 第九步, a
* session that cannot name its workspace is refused rather than pointed at it.
* @module @xiaoxie-ide/dsh-devflow/session-store
*/
/** The state directory name created inside one session workspace. */
const DEVFLOW_STATE_DIR_NAME = ".devflow";
/**
* Stable machine-readable code for "this session has no usable workspace".
*
* It is a code rather than free text because it crosses the tool boundary and
* the panel: the point of the refusal is that the caller can SEE that the
* session was not isolated.
*/
const DEVFLOW_SESSION_SCOPE_UNAVAILABLE = "DEVFLOW_SESSION_SCOPE_UNAVAILABLE";
/** The refusal raised when a session cannot be scoped to its own workspace. */
var DevFlowSessionScopeError = class extends Error {
	code = DEVFLOW_SESSION_SCOPE_UNAVAILABLE;
	/** The session that could not be scoped, or `(no agent)` for a caller-less call. */
	sessionId;
	/** What was missing, in plain terms. */
	detail;
	constructor(sessionId, detail) {
		super(`devflow: ${DEVFLOW_SESSION_SCOPE_UNAVAILABLE}: session ${sessionId} has no workspace to derive \`.devflow\` from (${detail}); refusing to fall back to the shared library because that would report a shared project as an isolated one.`);
		this.name = "DevFlowSessionScopeError";
		this.sessionId = sessionId;
		this.detail = detail;
	}
};
/** Read the durable session cwd off one live Agent, if it has one. */
function workspaceOf(agent) {
	const cwd = (agent?.session)?.header?.cwd;
	return typeof cwd === "string" && cwd.trim() !== "" ? cwd : void 0;
}
/** Read the session id off one live Agent, if it has one. */
function sessionIdOf(agent) {
	const direct = agent?.id;
	const id = (agent?.session)?.id ?? direct;
	return typeof id === "string" && id !== "" ? id : "(unknown session)";
}
/**
* Derive a new project's NAME from the session workspace directory.
*
* A project created inside `D:\Desktop\贪吃蛇` is the 贪吃蛇 project, so its name
* is that directory's last segment. Naming every project `DevFlow` made the
* panel read "本项目 DevFlow @ 贪吃蛇" — a name that contradicts the workspace it
* sits in — and it is the one string an operator reads first.
*
* The rule is total, and both project-creation paths use THIS function so the
* two can never drift apart:
*
* - trailing separators are ignored (`D:\a\b\` ⇒ `b`);
* - a path whose last segment is empty (a drive or filesystem root, `C:\` or
*   `/`) falls back to the path's own last non-empty segment (`C:` / `/`), and
*   the report records that branch;
* - a path with no usable segment at all returns the workspace verbatim rather
*   than an invented label: an unrecognizable name is still not a WRONG name.
*
* An unresolvable workspace never reaches here — that case is already refused by
* {@link deriveSessionStoreRoot} with `DEVFLOW_SESSION_SCOPE_UNAVAILABLE`, and
* this function deliberately does NOT reintroduce a hard-coded fallback name.
* @param workspace - the resolved session workspace directory.
* @returns the new project's name.
*/
function deriveProjectNameFromWorkspace(workspace) {
	const segments = workspace.split(/[\\/]+/).filter((segment) => segment !== "");
	const last = segments[segments.length - 1];
	if (last !== void 0 && last.trim() !== "") return last;
	return workspace.split(/[\\/]+/).find((segment) => segment !== "") ?? workspace;
}
/**
* The name and goal a NEWLY created project starts with.
*
* `goal` is deliberately EMPTY: the previous placeholder (`'DevFlow'`) was a
* meaningless word that read as a real objective and misled the Commander's
* direction judgement. "未设定" is the honest state, and an empty string says
* exactly that — no placeholder is written in its place.
* @param workspace - the session workspace the project is being created in.
* @returns the new project's name and empty goal.
*/
function deriveNewProjectIdentity(workspace) {
	return {
		name: deriveProjectNameFromWorkspace(workspace),
		goal: ""
	};
}
/**
* Derive one session's `.devflow` root.
*
* A session with no workspace fact has NO project of its own, and this is the
* one place that decides so: it throws rather than answering with the retained
* mixed library. That is the whole point of 第九步 — a shared answer dressed as
* an isolated one is worse than a refusal, because nobody can tell them apart.
*
* Kept separate (and exported) so the rule is testable on its own and so the
* refusal message has exactly one home.
* @param workspace - the session's workspace directory, when it has one.
* @param defaultRoot - the retained mixed-library root. It is reported for
*   diagnostics and is deliberately NOT a fallback: it is never returned here.
* @param sessionId - the session id, for the refusal message.
* @returns the `.devflow` root inside this session's workspace.
* @throws DevFlowSessionScopeError when the session carries no workspace.
*/
function deriveSessionStoreRoot(workspace, defaultRoot, sessionId) {
	if (workspace === void 0) throw new DevFlowSessionScopeError(sessionId, "the session header carries no workspace (cwd), so no project can be derived");
	if (workspace.trim() === "") throw new DevFlowSessionScopeError(sessionId, "the session workspace path is empty");
	return join(workspace, DEVFLOW_STATE_DIR_NAME);
}
/**
* Resolve and cache one {@link DevFlowStore} per session workspace.
*
* The resolver is a plain object rather than a service: it owns no protocol and
* no lifecycle, and every consumer already receives it explicitly, so a second
* Cordis service would be a second place for the same fact to live.
*/
var DevFlowSessionStores = class {
	fs;
	defaultRoot;
	onChange;
	sandboxPolicyOf;
	/** Session id → the root pinned for it (the session-level lock). */
	boundRoots = /* @__PURE__ */ new Map();
	/** Session id → the workspace directory that root was derived from. */
	boundWorkspaces = /* @__PURE__ */ new Map();
	/** Store root → the one store instance for it, so caches and journal gates are shared. */
	storeByRoot = /* @__PURE__ */ new Map();
	/**
	* @param fs - the filesystem seam every store goes through.
	* @param defaultRoot - the retained mixed-library root (`./.devflow`, i.e. the
	*   host process cwd). Reported for diagnostics only: it is never used to
	*   serve a session.
	* @param onChange - committed-write observer, called with the observing
	*   store's session key so the live channel can address one project's frames.
	* @param sandboxPolicyOf - the calling session's sandbox policy, stamped on
	*   every write so a store inside the session's own workspace is written AS a
	*   session workspace write (see {@link DevFlowSandboxPolicyResolver}).
	*/
	constructor(fs, defaultRoot, onChange, sandboxPolicyOf) {
		this.fs = fs;
		this.defaultRoot = defaultRoot;
		this.onChange = onChange;
		this.sandboxPolicyOf = sandboxPolicyOf;
	}
	/** The retained mixed-library root, as configured. Never a session's root. */
	get mixedLibraryRoot() {
		return this.defaultRoot;
	}
	/** Every root this run has actually opened, for diagnostics and reports. */
	get openedRoots() {
		return [...this.storeByRoot.keys()];
	}
	/**
	* Resolve the store for one calling session, pinning the session's root on
	* first use.
	*
	* A caller with no Agent at all (a programmatic tool call) is refused rather
	* than defaulted: there is no session to isolate, so there is no honest
	* answer that is not a guess.
	* @param agent - the calling Agent, when the runtime supplied one.
	* @returns the session's store and identity.
	* @throws DevFlowSessionScopeError when the caller has no session, or the
	*   session carries no workspace to derive a project from.
	*/
	resolve(agent) {
		if (agent === void 0) throw new DevFlowSessionScopeError("(no agent)", "the tool call carried no calling agent");
		const sessionId = sessionIdOf(agent);
		const pinned = this.boundRoots.get(sessionId);
		if (pinned !== void 0) return this.scopeOf(pinned, this.boundWorkspaces.get(sessionId) ?? null, sessionId, agent);
		const workspace = workspaceOf(agent);
		const root = deriveSessionStoreRoot(workspace, this.defaultRoot, sessionId);
		this.boundRoots.set(sessionId, root);
		this.boundWorkspaces.set(sessionId, workspace ?? null);
		return this.scopeOf(root, workspace ?? null, sessionId, agent);
	}
	/**
	* The workspace a session is currently pinned to, without resolving a store.
	* @param sessionId - the session to look up.
	* @returns the pinned root, or undefined when the session never resolved one.
	*/
	pinnedRoot(sessionId) {
		return this.boundRoots.get(sessionId);
	}
	/** Build (or reuse) the store for one pinned root. */
	scopeOf(root, workspacePath, sessionId, agent) {
		let store = this.storeByRoot.get(root);
		if (store === void 0) {
			const sessionKey = root;
			const boundAgent = agent;
			store = new DevFlowStore(this.fs, root, this.onChange === void 0 ? void 0 : (relativePath, sequence, record) => this.onChange?.(sessionKey, relativePath, sequence, record), this.sandboxPolicyOf === void 0 || boundAgent === void 0 ? void 0 : () => this.sandboxPolicyOf?.(boundAgent));
			this.storeByRoot.set(root, store);
		}
		return {
			store,
			sessionId,
			workspacePath,
			storeRoot: root,
			sessionKey: root
		};
	}
};
//#endregion
//#region lib/host/workflow.js
/**
* DevFlow task lifecycle: the five-state machine (`created → planned →
* executing → reviewing → completed`) plus the allowed rework edge
* (`reviewing → executing`). TaskWorkflow owns no scheduling, Agent
* registry, or model calls — it only validates transitions against the
* TRANSITIONS table and persists each committed change through the store.
* @module @xiaoxie-ide/dsh-devflow/workflow
*/
/** Allowed transitions per status; cancelled is terminal while failed/completed may be re-planned. */
const TRANSITIONS = {
	created: ["planned", "cancelled"],
	planned: ["executing", "cancelled"],
	executing: [
		"planned",
		"reviewing",
		"failed",
		"cancelled"
	],
	reviewing: [
		"completed",
		"executing",
		"planned",
		"failed",
		"cancelled"
	],
	completed: ["planned"],
	failed: [
		"planned",
		"executing",
		"cancelled"
	],
	cancelled: []
};
/**
* Task lifecycle manager over the file-backed store. Every transition
* validates the current status, applies the change, and persists it.
* @param store - the storage all tasks and changes go through.
*/
var TaskWorkflow = class {
	store;
	constructor(store) {
		this.store = store;
	}
	/**
	* Create one task in the initial `created` state.
	* @param input - task fields without the store-owned id and timestamps.
	* @returns the persisted task.
	*/
	async createTask(input) {
		return this.store.createTask(input);
	}
	/**
	* Move one task to `planned` (`created -> planned`).
	* @param taskId - the task to plan.
	* @returns the updated task and its change record.
	*/
	async planTask(taskId) {
		return this.transition(taskId, "planned");
	}
	/**
	* Move one task to `executing` (`planned -> executing`, or the
	* `reviewing -> executing` rework edge).
	* @param taskId - the task to start.
	* @returns the updated task and its change record.
	*/
	async startExecution(taskId) {
		return this.transition(taskId, "executing");
	}
	/**
	* Move one task to `reviewing` (`executing -> reviewing`).
	* @param taskId - the task to submit for review.
	* @returns the updated task and its change record.
	*/
	async submitReview(taskId) {
		return this.transition(taskId, "reviewing");
	}
	/** Settle one executing task as failed after its execution cannot complete. */
	async failTask(taskId) {
		return this.transition(taskId, "failed");
	}
	/** Cancel a task before or during execution; cancelled tasks are terminal. */
	async cancelTask(taskId) {
		return this.transition(taskId, "cancelled");
	}
	/**
	* Move one task to `completed` (`reviewing -> completed`).
	* @param taskId - the task to complete.
	* @returns the updated task and its change record.
	*/
	async completeTask(taskId) {
		return this.transition(taskId, "completed");
	}
	/**
	* Validate one transition against the TRANSITIONS table, persist it, and
	* return the updated task with its audit record. Illegal transitions and
	* unknown tasks fail loud.
	* @param taskId - the task to transition.
	* @param to - the target status.
	* @returns the updated task and its change record.
	*/
	async transition(taskId, to) {
		const task = await this.store.getTask(taskId);
		if (task === void 0) throw new Error(`devflow: cannot transition unknown task ${taskId}`);
		if (!TRANSITIONS[task.status].includes(to)) throw new Error(`Invalid task transition: ${task.status} -> ${to}`);
		const updated = await this.store.updateTask(taskId, { status: to });
		return {
			task: updated,
			change: {
				taskId: updated.id,
				from: task.status,
				to,
				at: updated.updatedAt
			}
		};
	}
};
/** Protocol versions this build can consume; exports always use the current version. */
const SUPPORTED_PROTOCOL_VERSIONS = [
	"0.1",
	"0.2",
	"0.3",
	"0.4"
];
/** The four built-in roles of the fixed DevFlow team. */
const BUILTIN_AGENT_ROLES = {
	planner: {
		roleId: "planner",
		name: "Commander",
		description: "唯一与用户直接交流的入口，负责理解需求、制定方案、拆分任务、派发任务、验收结果和决策弹窗。",
		inputTemplate: [
			"# Task input",
			"",
			"## Background",
			"## Goal",
			"## Scope",
			"## Requirements",
			"## Acceptance criteria"
		].join("\n"),
		outputTemplate: [
			"# Task plan",
			"",
			"## Breakdown",
			"## Approach",
			"## Risks"
		].join("\n"),
		capabilities: ["task-planning", "requirements-analysis"]
	},
	"backend-engineer": {
		roleId: "backend-engineer",
		name: "Backend Engineer",
		description: "负责后端代码编写、接口实现、数据处理和后端验证。",
		inputTemplate: [
			"# Task input",
			"",
			"## Background",
			"## Goal",
			"## Scope",
			"## Requirements",
			"## Acceptance criteria"
		].join("\n"),
		outputTemplate: [
			"# Task result",
			"",
			"## Summary",
			"## Changes",
			"## Verification",
			"## Issues",
			"## Next steps"
		].join("\n"),
		capabilities: [
			"backend-implementation",
			"file-modification",
			"test-execution"
		]
	},
	"frontend-engineer": {
		roleId: "frontend-engineer",
		name: "Frontend UI Engineer",
		description: "负责前端页面、视觉呈现、交互行为和浏览器端验证。",
		inputTemplate: [
			"# Task input",
			"",
			"## Background",
			"## Goal",
			"## Scope",
			"## Requirements",
			"## Acceptance criteria"
		].join("\n"),
		outputTemplate: [
			"# Task result",
			"",
			"## Summary",
			"## Changes",
			"## Verification",
			"## Issues",
			"## Next steps"
		].join("\n"),
		capabilities: [
			"frontend-implementation",
			"ui-interaction",
			"browser-verification"
		]
	},
	reviewer: {
		roleId: "reviewer",
		name: "Code Auditor",
		description: "负责代码审查、安全检查和质量把关。",
		inputTemplate: [
			"# Review input",
			"",
			"## Task",
			"## Changes",
			"## Verification"
		].join("\n"),
		outputTemplate: [
			"# Review result",
			"",
			"## Verdict",
			"## Findings",
			"## Required changes"
		].join("\n"),
		capabilities: ["code-review", "quality-check"]
	}
};
/**
* Create the task package for one task against one project. Pure: no I/O.
* @param task - the task to hand over.
* @param project - the project context the receiving Agent works against.
* @param options - role, instructions, and acceptance criteria overrides.
* @returns the task package.
*/
function createTaskPackage(task, project, options = {}) {
	const role = options.role ?? task.assignedRole;
	if (role === void 0) throw new Error(`createTaskPackage: task ${task.id} has no assigned role; pass options.role`);
	if (!(role in BUILTIN_AGENT_ROLES)) throw new Error(`createTaskPackage: unsupported role ${JSON.stringify(role)}; legacy executor packages are rejected`);
	return {
		protocolVersion: "0.4",
		taskId: task.id,
		role,
		projectContext: project,
		task,
		instructions: options.instructions ?? "",
		acceptanceCriteria: options.acceptanceCriteria ?? [],
		...options.fileScope === void 0 ? {} : { fileScope: options.fileScope },
		...options.scopeGuard === void 0 ? {} : { scopeGuard: options.scopeGuard }
	};
}
//#endregion
//#region lib/host/bridge.js
/**
* DevFlow Agent Bridge: the standard connection layer between DevFlow task
* packages and external Agent environments. A bridge is a pure renderer and
* parser — it never executes an Agent, performs no file I/O, and knows no
* concrete Agent vendor. Storage hands strings in, storage takes strings
* out.
* @module @xiaoxie-ide/dsh-devflow/bridge
*/
/**
* Assert that a parsed protocol version is one this build can consume.
* @param version - the version read from external content.
* @returns the accepted version.
*/
function assertSupportedProtocolVersion(version) {
	if (typeof version !== "string" || !SUPPORTED_PROTOCOL_VERSIONS.includes(version)) throw new Error(`Invalid AgentResultPackage: unsupported protocol version ${JSON.stringify(version)}`);
	return version;
}
/**
* Audit one task package before export: value-semantic checks across fields
* (field presence and types are the TypeScript interface's guarantee). One
* problem per finding; an empty list means the package is exportable.
* @param pkg - the package to audit.
* @returns the problem list.
*/
function validateTaskPackage(pkg) {
	const problems = [];
	if (!SUPPORTED_PROTOCOL_VERSIONS.includes(pkg.protocolVersion)) problems.push(`unsupported protocol version ${JSON.stringify(pkg.protocolVersion)}`);
	if (pkg.taskId.trim() === "") problems.push("taskId must be a non-empty string");
	if (pkg.role.trim() === "") problems.push("role must be a non-empty string");
	else if (!(pkg.role in BUILTIN_AGENT_ROLES)) problems.push(`unsupported role ${JSON.stringify(pkg.role)}; legacy executor packages are rejected`);
	if (pkg.projectContext.goal.trim() === "") problems.push("projectContext must carry a non-empty goal");
	if (pkg.task.title.trim() === "") problems.push("task must carry a non-empty title");
	if (pkg.task.id !== pkg.taskId) problems.push(`task id ${JSON.stringify(pkg.task.id)} does not match package taskId ${JSON.stringify(pkg.taskId)}`);
	return problems;
}
//#endregion
//#region lib/host/markdown-bridge.js
/**
* MarkdownBridge: the first AgentBridge representation — renders
* AgentTaskPackage into a fixed, deterministic Markdown document an external
* Executor Agent can consume. Pure string generation: no file I/O, no Agent
* execution, no randomness — identical input yields byte-identical output.
* @module @xiaoxie-ide/dsh-devflow/markdown-bridge
*/
/** The fixed document heading. */
const DOCUMENT_TITLE = "# DevFlow Task";
/** The fixed result document heading. */
const RESULT_DOCUMENT_TITLE = "# DevFlow Result";
/** The fixed generator attribution line. */
const GENERATED_BY = "Generated By: DevFlow";
/** A fence line that may wrap the result document. */
const FENCE_LINE = /^(?:```|~~~)/;
/** Every section heading a result document may carry. */
const RESULT_SECTIONS = /* @__PURE__ */ new Set([
	"Metadata",
	"Summary",
	"Changes",
	"Verification",
	"Issues",
	"Next Steps",
	"Modified Files",
	"Tool Step Count",
	"Completed Criteria"
]);
/**
* A result document that could not be accepted, with the bounded reason list.
*
* `problems` names only what is wrong with the document (missing section, key,
* or an out-of-range verdict) — never the model's raw reply, so the list is safe
* to persist in a report summary and to show in a tool error.
*/
var ResultParseError = class extends Error {
	problems;
	constructor(problems) {
		super(`Invalid AgentResultPackage: ${problems.join("; ")}`);
		this.problems = problems;
		this.name = "ResultParseError";
	}
};
/** A heading line's text, without markdown closing hashes. */
function headingText(line) {
	return /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line.trim())?.[2];
}
/**
* Locate the result document inside one Agent reply.
*
* A fixed Agent often wraps the document in prose or a fenced block even when
* told not to; the parse therefore starts at the `# DevFlow Result` heading
* wherever it appears, and stops at the block's end (a closing fence or the next
* top-level heading). Only a reply without that heading has no document at all.
* @param content - the Agent reply.
* @returns the document lines after the heading, or undefined when absent.
*/
function extractResultDocument(content) {
	const lines = content.split(/\r?\n/);
	const headingIndex = lines.findIndex((line) => headingText(line) === RESULT_DOCUMENT_TITLE.slice(2));
	if (headingIndex === -1) return void 0;
	const body = [];
	for (let index = headingIndex + 1; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		if (FENCE_LINE.test(line.trim())) break;
		const heading = headingText(line);
		if (heading !== void 0 && !RESULT_SECTIONS.has(heading) && body.some((entry) => entry.trim() !== "")) break;
		body.push(line);
	}
	return body;
}
function bulletList$1(items) {
	return items.map((item) => `- ${item}`).join("\n");
}
/** Render the File Scope section; `Not specified` when the package carries none. */
function fileScopeSection(pkg) {
	const scope = pkg.fileScope;
	return scope !== void 0 && scope.length > 0 ? bulletList$1(scope) : "Not specified";
}
/** Render the optional numeric ScopeGuard task limits. */
function taskBoundarySection(pkg) {
	const scope = pkg.scopeGuard;
	if (scope === void 0) return "Project default applies";
	return [
		`Maximum Modified Files: ${scope.maxModifiedFiles}`,
		`Maximum Tool Steps: ${scope.maxToolSteps}`,
		"Completion Criteria:",
		bulletList$1(scope.completionCriteria)
	].join("\n");
}
/** Split a result document into its `## <name>` sections, in document order. */
function splitSections(lines) {
	const sections = /* @__PURE__ */ new Map();
	let current;
	for (const line of lines) {
		const match = /^##\s+(.+?)\s*$/.exec(line);
		if (match !== null && match[1] !== void 0) {
			current = match[1].trim();
			sections.set(current, []);
			continue;
		}
		if (current !== void 0) sections.get(current)?.push(line);
	}
	return sections;
}
/** Parse one `Key: value` pair; undefined for lines without the separator. */
function keyValue(line) {
	const match = /^([A-Za-z][A-Za-z ]*):\s*(.*)$/.exec(line);
	if (match === null || match[1] === void 0 || match[2] === void 0) return void 0;
	return [match[1].trim(), match[2].trim()];
}
/** Parse one review verdict from result metadata. */
function parseVerdict(metadata) {
	const verdict = metadata.get("Verdict");
	if (verdict === "accepted" || verdict === "changes-requested" || verdict === "rejected") return verdict;
	throw new ResultParseError([`verdict ${verdict === void 0 ? "(missing)" : JSON.stringify(verdict.slice(0, 40))} is not accepted|changes-requested|rejected`]);
}
/** Parse one non-negative integer result metric. */
function parseCount(metadata, key) {
	const raw = metadata.get(key);
	if (raw === void 0) throw new ResultParseError([`missing ${key}`]);
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < 0) throw new ResultParseError([`${key} must be a non-negative integer`]);
	return value;
}
/** Extract `- item` list entries in order, ignoring non-list lines and blanks. */
function listItems(lines) {
	const items = [];
	for (const line of lines) {
		const match = /^-\s+(.*)$/.exec(line);
		if (match !== null && match[1] !== void 0) items.push(match[1]);
	}
	return items;
}
/**
* Parse one Markdown result document into a result package. Simple and
* stable: the document is split on `##` headings and sections are mapped by
* name; `protocolVersion`, `taskId`, and `summary` are required and fail
* loud, the list sections default to []. No Markdown AST is involved.
* @param markdown - the result document produced by an external Agent.
* @returns the validated result package.
*/
function parseResultMarkdown(markdown) {
	const document = extractResultDocument(markdown);
	if (document === void 0) throw new ResultParseError([`missing the ${JSON.stringify(RESULT_DOCUMENT_TITLE)} heading`]);
	const sections = splitSections(document);
	const sectionText = (name) => (sections.get(name) ?? []).join("\n").trim();
	const sectionLines = (name) => sections.get(name) ?? [];
	const metadata = /* @__PURE__ */ new Map();
	for (const line of sectionLines("Metadata")) {
		const pair = keyValue(line);
		if (pair !== void 0) metadata.set(pair[0], pair[1]);
	}
	const protocolVersion = metadata.get("Protocol Version");
	if (protocolVersion === void 0 || protocolVersion === "") throw new ResultParseError(["missing protocolVersion"]);
	try {
		assertSupportedProtocolVersion(protocolVersion);
	} catch {
		throw new ResultParseError([`unsupported protocolVersion ${JSON.stringify(protocolVersion.slice(0, 24))}`]);
	}
	const taskId = metadata.get("Task ID");
	if (taskId === void 0 || taskId === "") throw new ResultParseError(["missing taskId"]);
	const summary = sectionText("Summary");
	if (summary === "") throw new ResultParseError(["missing summary"]);
	return {
		protocolVersion,
		taskId,
		verdict: parseVerdict(metadata),
		summary,
		changes: listItems(sectionLines("Changes")),
		verification: listItems(sectionLines("Verification")),
		issues: listItems(sectionLines("Issues")),
		nextSteps: listItems(sectionLines("Next Steps")),
		...metadata.get("Modified File Count") === void 0 ? {} : { modifiedFiles: listItems(sectionLines("Modified Files")) },
		...metadata.get("Tool Step Count") === void 0 ? {} : { toolStepCount: parseCount(metadata, "Tool Step Count") },
		...sections.has("Completed Criteria") ? { completedCriteria: listItems(sectionLines("Completed Criteria")) } : {}
	};
}
/** Render one task package into the fixed Markdown template. Pure and deterministic. */
function renderTaskMarkdown(pkg) {
	const instructions = pkg.instructions === "" ? "(none)" : pkg.instructions;
	const criteria = pkg.acceptanceCriteria.length > 0 ? bulletList$1(pkg.acceptanceCriteria) : "(none)";
	return [
		DOCUMENT_TITLE,
		"",
		"## Metadata",
		"",
		`Protocol Version: ${pkg.protocolVersion}`,
		`Task ID: ${pkg.taskId}`,
		`Role: ${pkg.role}`,
		GENERATED_BY,
		"",
		"## Project Context",
		"",
		`Project: ${pkg.projectContext.name} (${pkg.projectContext.id})`,
		`Stage: ${pkg.projectContext.currentStage}`,
		`Goal: ${pkg.projectContext.goal}`,
		"",
		"## Task Description",
		"",
		`### ${pkg.task.title}`,
		"",
		pkg.task.description,
		"",
		"## Instructions",
		"",
		instructions,
		"",
		"## Acceptance Criteria",
		"",
		criteria,
		"",
		"## File Scope",
		"",
		fileScopeSection(pkg),
		"",
		"## Task Boundaries",
		"",
		taskBoundarySection(pkg),
		"",
		"## Required Result Format",
		"",
		"Your final response must contain only one complete result document in the exact format below.",
		"Do not omit, rename, or reorder any required heading or metadata key.",
		"Use the exact Protocol Version and Task ID already written in the template.",
		"Verdict must be exactly one of: accepted, changes-requested, rejected.",
		"Summary must be non-empty. Keep Changes, Verification, Issues, and Next Steps; write `- None` when a list has no other item.",
		"Do not output any text or fenced code block before or after the result document.",
		"",
		RESULT_DOCUMENT_TITLE,
		"",
		"## Metadata",
		"",
		`Protocol Version: ${pkg.protocolVersion}`,
		`Task ID: ${pkg.taskId}`,
		"Verdict: accepted|changes-requested|rejected",
		"",
		"## Summary",
		"",
		"<non-empty summary>",
		"",
		"## Changes",
		"",
		"- <change or None>",
		"",
		"## Verification",
		"",
		"- <verification or None>",
		"",
		"## Issues",
		"",
		"- <issue or None>",
		"",
		"## Next Steps",
		"",
		"- <next step or None>",
		""
	].join("\n");
}
/**
* The Markdown bridge: renders task packages to Markdown and (from Task-013
* on) parses result Markdown back into result packages.
*/
var MarkdownBridge = class {
	/** Stable bridge kind. */
	name = "markdown";
	/**
	* Render one task package into Markdown. The package is audited first;
	* a non-exportable package fails loud.
	* @param pkg - the task package to export.
	* @returns the rendered Markdown document.
	*/
	exportTask(pkg) {
		const problems = validateTaskPackage(pkg);
		if (problems.length > 0) throw new Error(`Invalid AgentTaskPackage: ${problems.join("; ")}`);
		return renderTaskMarkdown(pkg);
	}
	/**
	* Parse one Markdown result document back into a result package.
	* @param content - the result document produced by an external Agent.
	* @returns the validated result package.
	*/
	importResult(content) {
		return parseResultMarkdown(content);
	}
	/**
	* Audit one task package before export.
	* @param pkg - the package to audit.
	* @returns one problem per finding; an empty list means exportable.
	*/
	validate(pkg) {
		return validateTaskPackage(pkg);
	}
};
//#endregion
//#region lib/host/planner-resume.js
/**
* Planner Resume: the structured context handed back to the Planner after an
* Executor round. Pure data assembly plus a stable Markdown renderer — no
* model calls, no task creation, no file I/O. Rendering is a separate layer
* so JSON/UI resumes can reuse the same PlannerContext later.
* @module @xiaoxie-ide/dsh-devflow/planner-resume
*/
/**
* Assemble one PlannerContext. Pure: no I/O, no events, no mutation;
* identical inputs produce identical outputs. Results and history keep their
* input order — the caller owns ordering (e.g. store.listTasks is
* createdAt-sorted).
* @param project - the project context.
* @param task - the current task.
* @param results - execution results for the current task.
* @param history - earlier task records.
* @returns the assembled context.
*/
function buildPlannerContext(project, task, results, history) {
	return {
		project,
		task,
		results,
		history
	};
}
function bulletList(items) {
	return items.length === 0 ? "(none)" : items.map((item) => `- ${item}`).join("\n");
}
/** The task role, or '(none)' when unassigned. */
function roleText(task) {
	return task.assignedRole ?? "(none)";
}
/** Render one result record; absent list sections render as (none). */
function renderResult(result) {
	return [
		`### ${result.id}`,
		"",
		`Result ID: ${result.id}`,
		`Task ID: ${result.taskId}`,
		`Summary: ${result.summary}`,
		"Changes:",
		"",
		bulletList(result.changes),
		"Verification:",
		"",
		bulletList(result.verification),
		"Issues:",
		"",
		bulletList(result.issues),
		"Next Steps:",
		"",
		bulletList(result.nextSteps)
	].join("\n");
}
/**
* Render one PlannerContext into the fixed resume document. Pure and
* deterministic; empty results and history are legal and render as (none).
* The Next Planning Context section states facts only — it never invents
* tasks or conclusions.
* @param context - the assembled planner context.
* @returns the resume document.
*/
function renderPlannerResume(context) {
	const { project, task, results, history } = context;
	const latest = results.length > 0 ? results[results.length - 1] : void 0;
	return [
		"# DevFlow Planner Resume",
		"",
		"## Project",
		"",
		`Project Name: ${project.name}`,
		`Project ID: ${project.id}`,
		`Goal: ${project.goal}`,
		`Current Stage: ${project.currentStage}`,
		"",
		"## Current Task",
		"",
		`Task ID: ${task.id}`,
		`Title: ${task.title}`,
		`Description: ${task.description}`,
		`Status: ${task.status}`,
		`Assigned Role: ${roleText(task)}`,
		"",
		"## Execution Results",
		"",
		...results.length === 0 ? ["(none)", ""] : results.flatMap((result) => [renderResult(result), ""]),
		"## Task History",
		"",
		...history.length === 0 ? ["(none)"] : history.map((entry) => `- ${entry.id}  ${entry.status}  ${entry.title}  [role: ${roleText(entry)}]`),
		"",
		"## Next Planning Context",
		"",
		"The current task has produced execution results. Plan the next stage from the context above; do not invent new tasks or conclusions here.",
		`Current Task Status: ${task.status}`,
		`Latest Result Summary: ${latest === void 0 ? "(none)" : latest.summary}`,
		"Open Issues:",
		"",
		bulletList(latest === void 0 ? [] : latest.issues),
		"Executor Next Steps:",
		"",
		bulletList(latest === void 0 ? [] : latest.nextSteps),
		""
	].join("\n");
}
//#endregion
//#region lib/host/package-preflight.js
/** Load, repair the goal, build, and validate one task package consistently. */
async function prepareTaskPackage(store, taskId, options = {}, onProjectUpdate) {
	const task = await store.getTask(taskId);
	if (task === void 0) throw new Error(`devflow: cannot export unknown task ${taskId}`);
	const current = await store.loadProject();
	if (current === void 0) throw new Error("devflow: no project initialized; save a project before building a task package");
	let project = current;
	if (project.goal.trim() === "") {
		const goal = task.title.trim() || task.description.trim();
		if (goal === "") throw new Error(`devflow: cannot package task ${task.id} because project goal and task objective are empty`);
		project = {
			...project,
			goal,
			updatedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		await store.saveProject(project);
		await onProjectUpdate?.(project);
	}
	const pkg = createTaskPackage(task, project, options);
	const problems = validateTaskPackage(pkg);
	if (problems.length > 0) throw new Error(`Invalid AgentTaskPackage: ${problems.join("; ")}`);
	return {
		task,
		project,
		package: pkg
	};
}
//#endregion
//#region lib/host/workflow-agent.js
/**
* DevFlow Agent collaboration flow: the Planner → DevFlow → Executor loop
* composed over the store, the task lifecycle, and the handoff protocol.
* This layer simulates the workflow only — no model calls, no Agent
* instances, no registry, no scheduling, no parallelism.
* @module @xiaoxie-ide/dsh-devflow/workflow-agent
*/
/**
* Agent collaboration flow over the file-backed store and task lifecycle.
* @param store - the storage all tasks and results go through.
* @param workflow - the task lifecycle manager.
*/
var AgentWorkflow = class {
	store;
	workflow;
	bridge = new MarkdownBridge();
	constructor(store, workflow) {
		this.store = store;
		this.workflow = workflow;
	}
	/**
	* Export one task as its handoff Markdown document: task + project →
	* AgentTaskPackage → MarkdownBridge. Unknown tasks and missing projects
	* fail loud.
	* @param taskId - the task to export.
	* @returns the task id and the rendered Markdown.
	*/
	async exportTask(taskId, onProjectUpdate) {
		const prepared = await prepareTaskPackage(this.store, taskId, {}, onProjectUpdate);
		return {
			taskId,
			markdown: this.bridge.exportTask(prepared.package)
		};
	}
	/**
	* Planner flow: open a planning task for the given project and hand back
	* its task package. The task is created in `created` with the planner
	* role, then advanced to `planned` (the plan is done), and packaged for
	* handoff.
	* @param project - the project context the task belongs to.
	* @param input - the task title and description.
	* @returns the planner task package ready for handoff.
	*/
	async createPlanningTask(project, input) {
		const task = await this.workflow.createTask({
			title: input.title,
			description: input.description,
			status: "created",
			assignedRole: "planner"
		});
		const { task: planned } = await this.workflow.planTask(task.id);
		return createTaskPackage(planned, project, { role: "planner" });
	}
	/**
	* Executor flow, step one: accept a task package and start executing its
	* task (`planned -> executing`). The task must exist and be in `planned`;
	* any other status is rejected by the lifecycle.
	* @param pkg - the task package the Executor received.
	* @returns the transition to `executing`.
	*/
	async assignExecutor(pkg) {
		const task = await this.store.getTask(pkg.taskId);
		if (task === void 0) throw new Error(`devflow: cannot assign executor to unknown task ${pkg.taskId}`);
		return this.workflow.startExecution(task.id);
	}
	/**
	* Executor flow, step two: archive the execution result and move the task
	* to `reviewing` (`executing -> reviewing`). The task must be in
	* `executing`; the status is checked before the result is written, so a
	* rejected submission leaves no orphan result behind.
	* @param pkg - the task package the Executor received.
	* @param input - the execution result fields.
	* @returns the archived result and the transition it triggered.
	*/
	async submitExecutionResult(pkg, input) {
		return this.submitResult(pkg.taskId, input);
	}
	/**
	* Archive one execution result and move its task to `reviewing`. Shared by
	* the package-driven and the import-driven flows; the task must be in
	* `executing`, checked before the result is written.
	* @param taskId - the task the result belongs to.
	* @param input - the execution result fields.
	* @returns the archived result and the transition it triggered.
	*/
	async submitResult(taskId, input) {
		const task = await this.store.getTask(taskId);
		if (task === void 0) throw new Error(`devflow: cannot submit an execution result for unknown task ${taskId}`);
		if (task.status !== "executing") throw new Error(`devflow: cannot submit an execution result for task ${taskId} in status ${task.status}; expected executing`);
		return {
			result: await this.store.saveResult({
				taskId: task.id,
				...input
			}),
			transition: await this.workflow.submitReview(task.id)
		};
	}
	/**
	* Import one Markdown result document: parse it through the MarkdownBridge
	* (fail loud on malformed input), require the document's task id to match,
	* then archive and advance through the shared result flow.
	* @param taskId - the expected task the document answers.
	* @param markdown - the result document produced by an external Agent.
	* @returns the archived result, transition, protocol version, and review verdict.
	*/
	async importResult(taskId, markdown) {
		const pkg = this.bridge.importResult(markdown);
		if (pkg.taskId !== taskId) throw new Error(`devflow: result document targets task ${pkg.taskId}, expected ${taskId}`);
		return {
			...await this.submitResult(taskId, {
				summary: pkg.summary,
				changes: pkg.changes,
				verification: pkg.verification,
				issues: pkg.issues,
				nextSteps: pkg.nextSteps
			}),
			protocolVersion: pkg.protocolVersion,
			verdict: pkg.verdict
		};
	}
	/**
	* Planner flow, resume step: assemble the PlannerContext for one task and
	* render its resume document. Pure assembly — no model calls, no task
	* creation, no scheduling. Results and history arrive from the caller in
	* deterministic order; the store supplies the project and current task,
	* failing loud when either is missing.
	* @param taskId - the task the Planner resumes on.
	* @param results - execution results for the task, in order.
	* @param history - earlier task records, in order.
	* @returns the assembled context and its rendered resume document.
	*/
	async resumePlanner(taskId, results, history) {
		const task = await this.store.getTask(taskId);
		if (task === void 0) throw new Error(`devflow: cannot resume planner for unknown task ${taskId}`);
		const project = await this.store.loadProject();
		if (project === void 0) throw new Error("devflow: no project initialized; save a project before resuming the planner");
		const context = buildPlannerContext(project, task, results, history);
		return {
			context,
			resume: renderPlannerResume(context)
		};
	}
	/**
	* Resume one task with its own stored facts: results for the task come
	* from the store (oldest first) and history from the full task list
	* (oldest first), then the resume document is rendered.
	* @param taskId - the task the Planner resumes on.
	* @returns the assembled context and its rendered resume document.
	*/
	async resumeTask(taskId) {
		const results = await this.store.listResultsByTask(taskId);
		const history = await this.store.listTasks();
		return this.resumePlanner(taskId, results, history);
	}
};
//#endregion
//#region lib/host/dispatch-gates.js
const HIGH_RISK_PATTERN = /\b(delete|remove|drop|destroy|truncate)\b/i;
function decisionFor(projection, project, task, trigger) {
	const requests = Object.values(projection.decisionRequests).filter((request) => request.trigger === trigger);
	const projectRequests = requests.filter((request) => request.projectId === project.id);
	if (projectRequests.length === 0) return {
		request: void 0,
		mismatch: requests.length === 0 ? null : "high-risk-decision-project-mismatch"
	};
	const taskRequests = projectRequests.filter((request) => request.taskId === task.id);
	if (taskRequests.length === 0) return {
		request: void 0,
		mismatch: trigger === "review-failed-twice" ? "review-decision-task-mismatch" : "high-risk-decision-task-mismatch"
	};
	return {
		request: taskRequests.at(-1),
		mismatch: null
	};
}
function expired(request, task) {
	if (request.status !== "answered" || request.answeredAt === null) return false;
	const answeredAt = Date.parse(request.answeredAt);
	const taskUpdatedAt = Date.parse(task.updatedAt);
	return Number.isFinite(answeredAt) && Number.isFinite(taskUpdatedAt) && answeredAt < taskUpdatedAt;
}
/** Evaluate every dispatch decision gate without reading or mutating external state. */
function evaluateDispatchGates(task, projection, project) {
	const highRisk = HIGH_RISK_PATTERN.test(`${task.title}\n${task.description}`);
	if (projection === void 0) return {
		allowed: false,
		blockedBy: "projection-unavailable",
		requiredDecision: null,
		projectionStatus: "unavailable",
		reviewFailCount: 0,
		decisionStatus: void 0,
		highRisk
	};
	const reviewFailCount = projection.reviewFailCounts[task.id] ?? 0;
	if (reviewFailCount >= 2) {
		const selected = decisionFor(projection, project, task, "review-failed-twice");
		if (selected.mismatch !== null) return {
			allowed: false,
			blockedBy: selected.mismatch,
			requiredDecision: "review-failed-twice",
			projectionStatus: "available",
			reviewFailCount,
			highRisk,
			decisionStatus: "mismatch"
		};
		if (selected.request === void 0) return {
			allowed: false,
			blockedBy: "review-decision-missing",
			requiredDecision: "review-failed-twice",
			projectionStatus: "available",
			reviewFailCount,
			highRisk,
			decisionStatus: "missing"
		};
		if (selected.request.status === "pending") return {
			allowed: false,
			blockedBy: "review-decision-pending",
			requiredDecision: "review-failed-twice",
			projectionStatus: "available",
			reviewFailCount,
			highRisk,
			decisionStatus: "pending"
		};
		if (selected.request.status !== "answered") return {
			allowed: false,
			blockedBy: "review-decision-missing",
			requiredDecision: "review-failed-twice",
			projectionStatus: "available",
			reviewFailCount,
			highRisk,
			decisionStatus: selected.request.status
		};
		if (expired(selected.request, task)) return {
			allowed: false,
			blockedBy: "review-decision-expired",
			requiredDecision: "review-failed-twice",
			projectionStatus: "available",
			reviewFailCount,
			highRisk,
			decisionStatus: "expired"
		};
	}
	if (highRisk) {
		const selected = decisionFor(projection, project, task, "high-risk-operation");
		if (selected.mismatch !== null) return {
			allowed: false,
			blockedBy: selected.mismatch,
			requiredDecision: "high-risk-operation",
			projectionStatus: "available",
			reviewFailCount,
			highRisk,
			decisionStatus: "mismatch"
		};
		if (selected.request === void 0) return {
			allowed: false,
			blockedBy: "high-risk-decision-missing",
			requiredDecision: "high-risk-operation",
			projectionStatus: "available",
			reviewFailCount,
			highRisk,
			decisionStatus: "missing"
		};
		if (selected.request.status === "pending") return {
			allowed: false,
			blockedBy: "high-risk-decision-pending",
			requiredDecision: "high-risk-operation",
			projectionStatus: "available",
			reviewFailCount,
			highRisk,
			decisionStatus: "pending"
		};
		if (selected.request.status !== "answered") return {
			allowed: false,
			blockedBy: "high-risk-decision-missing",
			requiredDecision: "high-risk-operation",
			projectionStatus: "available",
			reviewFailCount,
			highRisk,
			decisionStatus: selected.request.status
		};
		if (expired(selected.request, task)) return {
			allowed: false,
			blockedBy: "high-risk-decision-expired",
			requiredDecision: "high-risk-operation",
			projectionStatus: "available",
			reviewFailCount,
			highRisk,
			decisionStatus: "expired"
		};
	}
	return {
		allowed: true,
		blockedBy: null,
		requiredDecision: null,
		projectionStatus: "available",
		reviewFailCount,
		decisionStatus: void 0,
		highRisk
	};
}
/** Render a short, non-secret diagnostic error message for a dispatch gate. */
function dispatchGateMessage(result) {
	if (result.allowed || result.blockedBy === null) return "dispatch gates passed";
	return `dispatch blocked by ${result.blockedBy}${result.requiredDecision === null ? "" : `; required decision ${result.requiredDecision}`}`;
}
/** Create an immutable diagnostic snapshot from a partial set of facts. */
function makeDispatchDiagnostic(input) {
	return {
		...input,
		...input.toolFilter === void 0 ? {} : { toolFilter: [...input.toolFilter] }
	};
}
//#endregion
//#region lib/host/scope-guard.js
/** Resolve a task override against the mandatory project ScopeGuard default. */
function resolveTaskScope(defaultScope, override) {
	return override ?? {
		maxModifiedFiles: defaultScope.maxModifiedFiles,
		maxToolSteps: defaultScope.maxToolSteps,
		completionCriteria: defaultScope.completionCriteria
	};
}
//#endregion
//#region lib/host/default-agents.js
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
/** The commander's navigation reading scope, quoted verbatim in its prompt. */
const COMMANDER_NAVIGATION_SCOPE = "项目根与 `docs/`";
/** The commander's read-only navigation tools; a writing tool must never join this list. */
const COMMANDER_READ_ONLY_TOOLS = [
	"read",
	"glob",
	"grep"
];
/**
* The architect persona: responsibility boundary, navigation-artifact contract,
* and the peer-research adoption rule. The boundary names what it may NOT do as
* explicitly as what it may, because the two ambient temptations for this seat
* are editing business code and dispatching other employees — neither of which
* is this employee's job.
*/
const ARCHITECT_PROMPT = [
	"你是 DevFlow 架构师（固定员工），由总指挥派发任务，只对总指挥负责。",
	"你能做的：技术选型（语言 / 框架 / 架构范式 / 关键外部组件）、目录树与命名规范设计、产出 `docs/` 导航物、生成架构图、撰写 ADR（决策记录）。",
	"你不能做的：① 不改业务代码——任何代码、UI、测试文件的实现改动都由总指挥派给代码 / 前端工程师；② 不做派发——只有总指挥能派活，你不创建任务、不指派、不启动任何子代理；③ 不使用任何 `devflow_*` 工具。",
	"接任务后先只读确认项目现状（先读根规则文件与 `docs/04-阶段与进度.md`，再按需读其它导航物），确认总指挥给的结论与仓库实际一致后再动手；明显偏离时停下来向总指挥反馈。",
	"导航物契约（每次被派发时按需产出，路径与文件名固定，不得改名或改位置）：",
	[
		"<项目根>/",
		"├─ 项目规则.md              ← 根规则文件，≤100 行：项目规范 / 命名 / 目录职责 / 开工必读清单 / 禁止事项",
		"└─ docs/",
		"   ├─ 00-项目简介.md         （目标 / 范围 / 术语）",
		"   ├─ 01-技术选型与架构.md    （语言 / 框架 / 范式 + 理由 + 被否选项及原因）",
		"   ├─ 02-目录结构与命名规范.md （复刻自同类产品调研，或架构师推荐；须写明采纳或推翻的理由）",
		"   ├─ 03-架构图.html         （archify 产出，self-contained，可直接在浏览器打开）",
		"   ├─ 04-阶段与进度.md        （导航心脏：阶段表 + 当前任务 + 待办 + 阻塞，只写当前有效信息）",
		"   ├─ 05-决策记录.md          （ADR：每次关键选择 + 理由 + 时间）",
		"   └─ 日志/YYYY-MM-DD.md     （当日记录，append-only）"
	].join("\n"),
	"同类产品调研的采纳规则：标准目录结构与命名规范的\"同类产品调研\"由总指挥派临时子代理完成（产出一棵目录树）；你负责采纳或推翻它，并把理由写进 `docs/02-目录结构与命名规范.md`。若总指挥未提供调研结果，你可以给出自己的推荐方案，但必须在同一文件里写明\"未做同类产品调研，本方案为架构师推荐\"及其局限。",
	"产出纪律：① 每个导航物都要真的落盘（用 write / edit 写文件），不要只在回传里描述内容；② 回传里给出实际产出的文件路径清单与每个文件的一句话摘要；③ `04-阶段与进度.md` 只写当前有效信息，过程细节下沉到 `docs/日志/`；④ `05-决策记录.md` 每条 ADR 记下选择、理由、时间。",
	"技术选型 / 目录与规范 / 架构图 / ADR 是你的主产出；被问到\"某个功能怎么实现\"时，给方案与接口设计，实现交给代码 / 前端工程师。"
].join("\n");
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
const EMPLOYEE_OUTCOME_DISCIPLINE = "回传纪律：`# DevFlow Result` 文档 `## Summary` **分区的第一行**必须先给出一句业务结论，格式为 `outcome: delivered|blocked|failed`，后接一句原因（例如 `outcome: blocked — 本会话没有 write 工具，无法落盘`）。`delivered` 表示任务真的完成了；`blocked` 表示你被能力或权限卡住、没有完成；`failed` 表示尝试后失败。没有完成就**必须**写 `blocked` 或 `failed`，禁止用 `delivered` 掩盖未完成的工作；也不要为了凑结论而伪造产物。";
/**
* The file/command tool chain the implementation employees share.
*
* `str_replace_editor` is deliberately absent: this runtime's registry no longer
* registers that name (the `edit` row superseded it), and a name the runtime
* never registers makes `tools.restrict()` reject the ENTIRE dispatch. The roster
* is the vocabulary dispatch filters against, so a retired name here is not a
* harmless leftover — it is a dispatch-aborting one.
*/
const EMPLOYEE_FILE_TOOLS = [
	"read",
	"write",
	"edit",
	"glob",
	"grep",
	"read_image",
	"pwsh"
];
/** The four default fixed employees and their approved Skill bindings. */
const DEFAULT_FIXED_AGENTS = [
	{
		agentId: "commander",
		kind: "fixed",
		role: "planner",
		delegationDepth: 0,
		prompt: [
			"你是 DevFlow 总指挥，也是唯一直接与用户交流的入口。你运行在 Harness 标准模式下，使用其文件、搜索、计划、待办、Skill、弹窗和委派能力，但你不能自己写代码。",
			"工作流程是：理解需求；需求歧义时用 devflow_request_decision 结构化弹窗确认；用 devflow_create_phase 和 devflow_set_scope 制定分阶段方案；让用户选择执行粒度；**先判断每个任务属于\"调研\"还是\"交付\"，再按下面的派给谁规则选人**；用 devflow_dispatch_agent 把明确边界的任务派给对应员工；审计和验收；通过则继续，不通过则返工。",
			"需求歧义、方案分叉、范围蔓延、审计连续两次不通过和高风险操作必须弹窗。每个弹窗给出恰好三个推荐选项（devflow_request_decision 的 options 传 3 条，recommendedOption 指向其中一条的 id），自定义选项由系统自动追加，不要自己传自定义项。",
			"前后端协作时先让用户选择并行、后端先行或前端先行。简单功能按整阶段执行；中等功能确认一次粒度；大型项目按阶段执行。用户要求暂停时完成当前阶段或步骤组后暂停。Scope Guard 是硬约束，禁止无限扩展。",
			`开工先读导航文件：先读项目根的规则文件（项目规则.md，兼容 AGENTS.md），再读 docs/04-阶段与进度.md，然后才决定怎么派活。这是你唯一允许亲自读取的内容，范围严格限定在${COMMANDER_NAVIGATION_SCOPE}。`,
			`只读边界：你持有 read / glob / grep 三个只读工具，仅允许用于${COMMANDER_NAVIGATION_SCOPE}的开工导航读取。禁止用它们读业务源码做调研、禁止用它们产出任何交付内容；你没有 write / edit / pwsh，任何写文件、改代码、跑命令都必须派给员工。范围之外的文件、目录列表与检索，以及全部业务调研，仍然必须派给员工。`,
			"强制派员工规则：对于任何涉及代码编写、文件操作、UI 设计、代码审计、API 接口等具体工作，必须按以下流程派给对应员工，禁止自己用 shell、file、str_replace 等工具直接代替：1. 先调 `devflow_create_task` 创建任务，描述清楚任务目标和验收标准；2. 调 `devflow_assign_agent` 把任务派给对应员工（后端→`backend-engineer`，前端→`frontend-engineer`，架构/技术选型/目录规范/架构图/ADR→`architect`，审计/质量→`code-auditor`）；3. 调 `devflow_dispatch_agent` 启动子 agent 实际干活（`subagent_runtime: harness`）；4. 收齐结果后汇总给用户。**第 3 步不是\"一次一个\"**：几个任务都已绑好边界时，就把它们**并列写在同一条回复里**一起派出去，然后再一起等回传 —— 等的是这一批，不是某一个。",
			"**派给谁：先分清\"交付\"还是\"调研\"，选错员工是硬错误。** ① **交付类**（要改代码、改 UI、产出导航物/文档、审计复核 —— 任何需要\"动手产出\"的活）派给固定员工：后端→`backend-engineer`、前端→`frontend-engineer`、架构与技术选型→`architect`、审计与质量→`code-auditor`。② **调研类**（只读的信息收集：调研用户需求 / 使用习惯 / 使用场景 / 同类产品 / 玩法要素偏好 / 竞品对比等 —— 只读、只收集、**没有文件产出**）**必须派给临时子代理**（先用 `devflow_agent_upsert` 登记一名，再 `devflow_assign_agent` 派活）。**固定员工不接调研类任务**：除了\"这不是他的本职\"，还有个硬理由 —— 固定员工持有 `write` / `edit` / `pwsh`，把只读调研交给他们等于给一个只需要读的任务发写权限，一旦越界就会改坏产物。③ 混合型任务（\"先调研 + 再据此产出\"）拆成两段：调研段派临时子代理；拿回结论后，把\"结论 + 产出任务\"一起派给对应固定员工。④ 登记临时子代理时：**调研/只读类**不要声明写类工具（只读集即可）；**需要它写文件或跑命令**（例如临时后台/前端工程师）时，**必须显式声明** `write` / `edit` / `pwsh`，并说明为什么需要。不声明就等于只给只读集（`read` / `glob` / `grep` / `read_image`），它会因为干不了活而受阻上报 —— 宁可少给，也不要默认给写权限。",
			"这些操作一律派给员工去执行（**交付类给固定员工、调研类给临时子代理** —— 见上面的\"派给谁\"规则）。你只做：理解需求 → 读导航 → 拆任务 → `devflow_create_task` + `devflow_assign_agent` + `devflow_dispatch_agent` 派活 → 汇总结果。",
			"派活硬流程：每个任务都走 `create_task` → `assign_agent` → `dispatch_agent`，三步不可省。**但顺序是先建齐、再统一派**：同一批要给出去的几个任务，先逐个 `create_task` 建完、再逐个 `assign_agent` 绑好边界，最后把**已经绑好边界的任务在同一次回复里一起 `dispatch_agent`** —— 也就是**一条回复的并列工具调用里出现多个 `devflow_dispatch_agent`**。**不要建一个就立刻派一个**，也**不要\"派一个 → 等它回来 → 再派下一个\"** —— 那样第二个任务还没绑边界（或被第一个堵着），几件本来能同时做的事就永远排成一前一后，白白拖时间。判断标准很短：**只要能一起派，就必须在同一条回复里一起发出去；一条回复里以 `dispatch` 开头、后面只跟了一个 `dispatch`，说明你漏了同批的就绪任务。**",
			`并发派发是**默认工作方式，不是特例**：只要一个任务已经 \`assign\` 且边界已定，它就应该跟其它就绪任务**在同一轮里被派出去**，不要给它排「等上一个跑完」的队。判断什么时候**不**能并行，只有一条 —— **产物重叠**：两个任务会不会写同一批文件、同一个目录、同一份配置（反例：两个都要改 src/host/tools.ts；正例：两个只读调研、或一个写前端一个写后端且文件不重叠）。会重叠就分开：先派第一个，等它回传完再派第二个。**有先后依赖的任务也必须分开派**：第二个任务要用第一个的产物时，等第一个回来再派它。一句话：**产物不重叠、彼此不依赖 ⇒ 同一条回复里一起派**。**整批一起等**：多条并行派发都写在同一条回复里，之后一起等它们回传再统一汇总；**不要因为其中一条先回来了，就单独拿它的结果去推进下一步** —— 那会打断同批的并行。同时最多 **5** 条在执行；达到上限后新的派发会自动排队等待（面板会显示「已达并发上限 · 后续排队」），**排队是正常的，不要为了凑数把任务拆碎、也不要把同一个任务重复派**。**不得**为了让面板看起来在并发而硬凑并行；也**不得**因为并发可用就缩短审计 / 复核链路 —— 验收口径与串行时完全一致。`,
			"派发给架构师的任务：技术选型、目录结构与命名规范、架构图（`docs/03-架构图.html`）、ADR 与导航物（根规则文件、`docs/00`–`docs/05`、`docs/日志/`）。这些是**产出**类工作；其中的调研部分（同类产品目录结构调研、用户需求调研等）**必须先由临时子代理做完**，再把调研结论连同产出任务一起派给架构师，由架构师采纳或推翻并写明理由 —— 调研本身不要派给架构师。",
			"`devflow_agent_upsert` 是**调研类任务的必经步骤**，不是例外：每次要派调研时，先 `devflow_agent_upsert` 登记一名临时员工（命名按调研方向，例如 `researcher-demands` / `researcher-pains` / `researcher-refs`），再用 `devflow_assign_agent` 把调研任务派给他 —— **不要**把调研直接派给固定员工，也**不要**因为\"要 upsert 太麻烦\"就退而派给固定员工。只有你自己在总指挥模式下能调用它；用户明确要求增加团队成员时同样用它。固定员工 id 规则：派活使用 `backend-engineer`（后端）、`frontend-engineer`（前端）、`architect`（架构）、`code-auditor`（审计）；不要把 role 类型 `planner` 或 `reviewer` 当作 agent id，Commander 自己也不作为 child dispatch target。",
			"如果发现 project.goal 为空，禁止停下来要求用户手工设置；从当前任务标题或描述提取目标并继续派活，运行时会在 dispatch 边界持久化该目标。固定员工（backend-engineer、frontend-engineer、architect、code-auditor）已存在，派活只用 `devflow_assign_agent` + `devflow_dispatch_agent`。",
			"验收收口（任务停在 reviewing 即\"等用户验收\"，不推进它会一直挂着）：只有用户明确表示接受 / 验收通过之后，你才能对**对应的那一个任务**调用 `devflow_transition_task` 把它推进到 `completed`；用户接受的只是哪一个任务、哪一个范围，就只收口那些任务，不许多收口、不许顺手把其它任务一起收口。用户表示不接受时，按既有返工路径处理：用 `devflow_transition_task` 把它退回 `executing`（reviewing → executing），再按返工流程重新派发，并记录用户不接受的理由。红线：**不得由你自己判定验收通过**——验收是用户的判断，你只负责在用户表态之后执行收口；**不得**为了\"让面板好看\"、为了清空「待验收」计数或为了让阶段看起来完成而提前收口任何任务。**用户没说接受，就不许 transition。**",
			"阶段状态必须跟着事实走 —— **面板读的是 `.devflow` 里的阶段记录，不是 `docs/` 里的导航物**，两者必须一致：`devflow_create_phase` 建好的阶段起初是「计划中」，当该阶段真正开始派活时用 `devflow_update_phase` 把它推进到 `in_progress`；**只有当该阶段的全部任务都已由用户验收收口之后**，才把它推进到 `completed`。红线与验收同源：**不得**为了\"让面板好看\"或让阶段看起来完成而提前推进任何阶段。员工在 `docs/04-阶段与进度.md` 里回填的进度与这里的阶段记录不一致时，以事实为准并把两者补齐（真机实测 2026-09-23：某项目 12 个阶段全部停在「计划中」，而 `docs/` 已写\"阶段 1–6 已完成\"，面板因此整场显示「计划中」）。"
		].join(""),
		modelConfig: { model: "deepseek-chat" },
		tools: [
			"ask_user_question",
			"devflow_create_phase",
			"devflow_update_phase",
			"devflow_set_scope",
			"devflow_clear_scope",
			"devflow_assign_agent",
			"devflow_dispatch_agent",
			"devflow_transition_task",
			"devflow_request_decision",
			"devflow_pause",
			"devflow_resume_dispatch",
			"devflow_create_task",
			"devflow_create_task_package",
			"devflow_submit_result",
			"devflow_export_task",
			"devflow_import_result",
			"devflow_resume",
			"devflow_project_status",
			"devflow_agent_upsert",
			...COMMANDER_READ_ONLY_TOOLS
		],
		capabilities: [
			"requirements-analysis",
			"task-planning",
			"task-dispatch",
			"acceptance"
		],
		skills: []
	},
	{
		agentId: "backend-engineer",
		kind: "fixed",
		role: "backend-engineer",
		delegationDepth: 0,
		prompt: "你是后端代码工程师。每次接任务先读取相关文件并查看 git diff，确认当前代码状态后再修改；若总指挥任务提示与实际代码明显偏离，停止并向总指挥反馈。" + EMPLOYEE_OUTCOME_DISCIPLINE,
		modelConfig: { model: "deepseek-chat" },
		tools: [...EMPLOYEE_FILE_TOOLS],
		capabilities: [
			"backend-implementation",
			"api-development",
			"test-execution"
		],
		skills: [
			"repository-conventions",
			"defensive-patterns",
			"testing-policy",
			"pre-push-checks"
		]
	},
	{
		agentId: "frontend-engineer",
		kind: "fixed",
		role: "frontend-engineer",
		delegationDepth: 0,
		prompt: "你是前端 UI 工程师。每次接任务先读取相关文件并查看 git diff，确认当前代码状态后再修改；若总指挥任务提示与实际代码明显偏离，停止并向总指挥反馈。" + EMPLOYEE_OUTCOME_DISCIPLINE,
		modelConfig: { model: "deepseek-chat" },
		tools: [...EMPLOYEE_FILE_TOOLS],
		capabilities: [
			"frontend-implementation",
			"ui-interaction",
			"browser-verification"
		],
		skills: ["frontend-ui-engineering", "browser-testing-with-devtools"]
	},
	{
		agentId: "architect",
		kind: "fixed",
		role: "planner",
		delegationDepth: 0,
		prompt: ARCHITECT_PROMPT + EMPLOYEE_OUTCOME_DISCIPLINE,
		modelConfig: { model: "deepseek-chat" },
		tools: [...EMPLOYEE_FILE_TOOLS],
		capabilities: [
			"architecture-design",
			"tech-selection",
			"project-scaffolding",
			"adr-authoring"
		],
		skills: [
			"archify",
			"advise-project-approach",
			"api-and-interface-design",
			"documentation-and-adrs"
		]
	},
	{
		agentId: "code-auditor",
		kind: "fixed",
		role: "reviewer",
		delegationDepth: 0,
		prompt: "你是代码审计员。按绑定的 Skill 内容逐项审查代码正确性、安全性、质量和可简化性，并把可执行的发现返回总指挥。" + EMPLOYEE_OUTCOME_DISCIPLINE,
		modelConfig: { model: "deepseek-chat" },
		tools: [
			"read",
			"glob",
			"grep",
			"read_image",
			"pwsh"
		],
		capabilities: [
			"code-review",
			"security-review",
			"quality-assurance"
		],
		skills: ["code-review", "find-simplifications"]
	}
];
/**
* Every tool name a fixed employee may name — the dispatched plane's known set.
*
* Dispatch has to answer "is this a real runtime tool?" from the host plane,
* where the child's own composed scope is not readable. This union is that
* answer: every name here is one a shipped employee is expected to receive. It
* is a NAME VOCABULARY, never a permission — it grants nothing, and each
* employee's own `tools` list stays the only thing deciding what it may use.
*/
const DECLARED_EMPLOYEE_TOOL_NAMES = new Set(DEFAULT_FIXED_AGENTS.flatMap((agent) => [...agent.tools]));
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
const TEMPORARY_READ_ONLY_TOOLS = [
	"read",
	"glob",
	"grep",
	"read_image"
];
/**
* The tools that may only ever be granted by an EXPLICIT declaration.
*
* `str_replace_editor` is listed although this runtime no longer registers it: the list
* is the rule ("this name is a writing capability"), and a name that is not registered
* is trimmed later by the roster vocabulary anyway.
*/
const WRITE_CLASS_TOOLS = /* @__PURE__ */ new Set([
	"write",
	"edit",
	"pwsh",
	"str_replace_editor"
]);
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
function dispatchableToolNames(declared, parentView, known = DECLARED_EMPLOYEE_TOOL_NAMES) {
	return declared.filter((name) => parentView.has(name) || known.has(name));
}
/** The config fields this module owns for a fixed employee, in patch form. */
function configOf(input) {
	return {
		role: input.role,
		prompt: input.prompt,
		modelConfig: input.modelConfig,
		tools: input.tools,
		capabilities: input.capabilities,
		skills: input.skills,
		delegationDepth: input.delegationDepth
	};
}
/** True when the stored fixed employee no longer matches this module's config. */
function drifted(stored, input) {
	const same = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);
	return stored.role !== input.role || stored.prompt !== input.prompt || stored.modelConfig.model !== input.modelConfig.model || stored.modelConfig.provider !== input.modelConfig.provider || stored.delegationDepth !== input.delegationDepth || !same(stored.tools, input.tools) || !same(stored.capabilities, input.capabilities) || !same(stored.skills, input.skills);
}
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
async function reconcileFixedAgents(store) {
	const added = [];
	const refreshed = [];
	for (const input of DEFAULT_FIXED_AGENTS) {
		const stored = await store.getAgent(input.agentId);
		if (stored === void 0) {
			await store.registerAgent(input);
			added.push(input.agentId);
			continue;
		}
		if (stored.kind !== "fixed") continue;
		if (!drifted(stored, input)) continue;
		await store.updateAgentConfig(input.agentId, configOf(input));
		refreshed.push(input.agentId);
	}
	return {
		added,
		refreshed
	};
}
/**
* Reconcile the fixed-employee roster and journal only what actually changed.
*
* An unchanged roster writes nothing, so this stays silent on an ordinary start
* and produces one `devflow/agent/register` audit row per real change.
* @param store - the DevFlow store whose roster and journal are updated.
* @returns the ids added and the ids refreshed.
*/
async function recordFixedRosterChanges(store) {
	const reconciliation = await reconcileFixedAgents(store);
	for (const agentId of [...reconciliation.added, ...reconciliation.refreshed]) {
		const agent = await store.getAgent(agentId);
		if (agent !== void 0) await recordDevFlowChange(store, "devflow/agent/register", { agent });
	}
	return reconciliation;
}
/**
* Read an employee's declared outcome from the first line of its reply.
*
* The contract asked of every fixed employee is one leading declaration:
* `outcome: delivered|blocked|failed` optionally followed by ` — <reason>`. It
* is read only from the FIRST non-empty line so a passing mention inside body
* prose can never be mistaken for the declaration.
* @param text - the employee's reply, verbatim.
* @returns the declaration, or undefined when the reply declared nothing.
*/
function declaredOutcome(text) {
	const firstLine = text.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== "");
	if (firstLine === void 0) return void 0;
	const match = /^outcome\s*[:：]\s*(delivered|blocked|failed)\b([\s\S]*)$/i.exec(firstLine);
	if (match === null) return void 0;
	return {
		outcome: match[1]?.toLowerCase(),
		detail: (match[2] ?? "").replace(/^\s*[—\-–:：]\s*/, "").trim()
	};
}
/**
* Classify which capability the employee said it was missing.
*
* Only the employee's own words are classified. "no write/edit" is a missing
* tool; "permission"/"审批"/"提权" is a permission; anything else is
* `unstated` — the honest answer when the reply did not say.
* @param detail - the employee's reason text.
* @returns the gap kind.
*/
function classifyCapabilityGap(detail) {
	const text = detail.toLowerCase();
	if (/权限|授权|审批|提权|permission|not allowed|denied|forbidden/.test(text)) return "permission";
	if (TOOL_NAME.test(text) && /没有|缺少|缺|missing|no\s+(?:write|edit)|without|未挂载|不可用/.test(text)) return "tool";
	if (/依赖|dependency|not installed|未安装|找不到命令|command not found/.test(text)) return "dependency";
	return "unstated";
}
/** One tool name, tested WITHOUT the `g` flag: a global regex carries `lastIndex`
* across `test()` calls, which would make detection depend on call order. */
const TOOL_NAME = /(?:write|edit|str_replace_editor|read_image|pwsh|read|glob|grep|bash|web_search|web_fetch|skill|workflow)/;
/** The same names, for scanning one string exhaustively. */
const TOOL_NAME_ALL = /\b(?:write|edit|str_replace_editor|read_image|pwsh|read|glob|grep|bash|web_search|web_fetch|skill|workflow)\b/g;
/**
* The tool named IMMEDIATELY after an absence marker.
*
* Employees explain a blocker by contrasting what they lack with what they have
* ("缺的正是 `web_search` 工具：当前可用工具集为 edit / glob / …"). Matching only
* the name the absence marker points at is what keeps `missing` about the gap;
* a bare scan for tool names reads the contrast list as the gap and reports the
* exact opposite of the truth.
*/
const ABSENT_TOOL = /(?:没有|缺少|缺|无|未挂载|未注册|不可用|not\s+available|missing|without|no)[^A-Za-z0-9_`"']{0,8}[`"']?\s*(write|edit|str_replace_editor|read_image|pwsh|read|glob|grep|bash|web_search|web_fetch|skill|workflow)\b/g;
/** The tool names the employee named as absent, deduplicated and in order. */
function missingTools(detail) {
	const names = [];
	for (const match of detail.matchAll(ABSENT_TOOL)) if (match[1] !== void 0) names.push(match[1]);
	if (names.length > 0) return [...new Set(names)];
	const found = (detail.split(/[。;；\n]/)[0] ?? detail).match(TOOL_NAME_ALL);
	return found === null ? [] : [...new Set(found)];
}
/**
* The employee's reason with any "these are the tools I HAVE" tail removed.
*
* The durable record is shown to a user, and an inventory of the employee's own
* tool catalogue is not part of the gap. The tail is dropped only after an
* absence statement, so a reply that never lists its tools is kept verbatim.
*/
function gapReason(detail) {
	if (!/(?:没有|缺少|缺|无|未挂载|不可用)/.test(detail)) return detail;
	const cut = detail.split(/当前(?:可)?用工具集为|可用工具(?:集)?为|现有工具为|当前工具集为/);
	return cut.length > 1 ? `${cut[0].trim()}（可用工具清单已略）` : detail;
}
/** Who the reply itself says could clear the blocker. */
function suggestedOwner(detail) {
	if (/boss|用户|你执行|需要你|请用户/.test(detail)) return "boss";
	if (/配置|preset|派发策略|宿主|DSH/.test(detail)) return "DevFlow 配置层";
	if (/总指挥/.test(detail)) return "总指挥";
	return "未标明";
}
/**
* Canonical form of a named capability, used for BOTH storage and comparison.
*
* Employees write the same gap differently from turn to turn — one reply lists
* "read / write / edit / …", the next "edit / glob / … / write" — so an exact
* string comparison treats one gap as two and the breaker never arms. Sorting and
* deduplicating makes the stored value and the comparison key the same canonical
* text, which is what lets "the same capability, again" actually match.
* @param missing - the raw capability text.
* @returns the canonical, order-independent form.
*/
function normalizeMissing(missing) {
	const names = [...new Set(missing.split(/[\/、,，\s]+/).map((part) => part.trim()).filter((part) => part !== ""))];
	if (names.length <= 1) return names[0] ?? "未标明";
	return [...names].sort().join(" / ");
}
/** The identity of a capability gap: what must match for the breaker to arm. */
function gapKey(report) {
	return `${report.gapKind}::${normalizeMissing(report.missing)}`;
}
/** Bounded, whitespace-normalized excerpt of the employee's reason. */
function boundedReason(detail) {
	const flat = detail.replace(/\s+/g, " ").trim();
	return flat.length <= 400 ? flat : `${flat.slice(0, 399)}…`;
}
/**
* Build a blocked record from an employee reply that declared `blocked`.
*
* Nothing is invented: an undeclared tool list becomes `missing: '未标明'`, not
* a guess at what the employee probably lacked.
* @param input - the task, employee, execution identity, and the reply text.
* @returns the durable blocked record.
*/
function blockedReportFrom(input) {
	const detail = input.detail.trim() === "" ? "未标明" : input.detail;
	const gapKind = classifyCapabilityGap(detail);
	const tools = missingTools(detail);
	return {
		blockedId: randomUUID(),
		taskId: input.taskId,
		agentId: input.agentId,
		...input.executionId === void 0 ? {} : { executionId: input.executionId },
		...input.sessionId === void 0 ? {} : { sessionId: input.sessionId },
		gapKind,
		missing: tools.length === 0 ? "未标明" : normalizeMissing(tools.join(" / ")),
		suggestedOwner: suggestedOwner(detail),
		reason: boundedReason(gapReason(detail)),
		createdAt: input.now ?? (/* @__PURE__ */ new Date()).toISOString()
	};
}
/** One line of human-facing Chinese, shown on the panel where a user will see it. */
function blockedHeadline(report, displayName) {
	return `${displayName}${report.gapKind === "tool" ? `缺少${report.missing} 工具` : report.gapKind === "permission" ? "权限不足" : report.gapKind === "dependency" ? "缺少所需组件" : "受阻（原因未标明）"}，无法继续本次派发${report.suggestedOwner === "未标明" ? "" : `— 需 ${report.suggestedOwner} 处理`}`;
}
/**
* Whether a dispatch must be refused because the same capability gap keeps
* blocking this task.
*
* The breaker trips on the THIRD attempt: two blocked reports already spent two
* turns reaching the same wall, and the third dispatch is what gets refused.
* Only reports naming the SAME gap kind and the SAME missing capability count —
* a new, different blocker is new information and must still be able to surface.
* @param blocked - this task's blocked reports, newest first.
* @returns the reason the dispatch is refused, or undefined when it may proceed.
*/
function capabilityBreaker(blocked) {
	const newest = blocked[0];
	if (newest === void 0) return void 0;
	const key = gapKey(newest);
	const sameGap = blocked.filter((item) => gapKey(item) === key);
	if (sameGap.length < 2) return void 0;
	return {
		trips: true,
		reason: `同一能力缺口已连续 ${sameGap.length} 次导致派发受阻（${newest.gapKind}: ${newest.missing}）；已熔断，请先修复配置或权限后再派发`
	};
}
//#endregion
//#region lib/host/tools.js
/**
* DevFlow model-facing tools: project status, task creation, task
* transitions, result submission, and task-package creation. The tools are
* thin, composed over the store and workflow — no scheduling, no Agent
* calls, no external connections.
* @module @xiaoxie-ide/dsh-devflow/tools
*/
const ASSIGNED_ROLES = [
	"planner",
	"backend-engineer",
	"frontend-engineer",
	"reviewer"
];
const TASK_STATUSES = [
	"created",
	"planned",
	"executing",
	"reviewing",
	"completed",
	"failed",
	"cancelled"
];
const REPORT_SUMMARY_LIMIT = 500;
const SENSITIVE_REPORT_TEXT = /(?:\b(?:prompt|system[\s_-]*prompt|credential|token|cookie|authorization|api[\s_-]*key|secret|password|raw\s*(?:tool\s*)?(?:input|output)|tool\s*(?:input|output)|stack\s*trace)\b|(?:[A-Za-z]:\\|\\\\|\/Users\/|\/home\/|\/tmp\/|\/var\/tmp\/|\/private\/var\/)|(?:Bearer\s+\S+))/i;
function safeReportSummary(value) {
	if (SENSITIVE_REPORT_TEXT.test(value)) return "Sensitive content is hidden.";
	return value.length <= REPORT_SUMMARY_LIMIT ? value : `${value.slice(0, 499)}…`;
}
const PHASE_STATUSES = [
	"planned",
	"in_progress",
	"completed"
];
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
/**
* Whether one more dispatch may join a parallel group. `false` is not an error:
* the host classifies the call `exclusive`, so it waits for the running group to
* drain and then starts — this IS "超限排队".
*/
function mayDispatchConcurrently() {
	return inFlightDispatches < 5;
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
		if (released) return;
		released = true;
		inFlightDispatches -= 1;
	};
}
/** Advance a task into the executing state before a native child is started. */
async function prepareTaskForDispatch(workflow, store, taskId, append) {
	let task = await store.getTask(taskId);
	if (task === void 0) throw new Error(`devflow: unknown task ${taskId}`);
	if (task.status === "created" || task.status === "failed" || task.status === "completed" || task.status === "reviewing") {
		const planned = await workflow.planTask(task.id);
		await append(planned.change, planned.task.title);
		task = planned.task;
	}
	if (task.status === "planned") {
		const executing = await workflow.startExecution(task.id);
		await append(executing.change, executing.task.title);
		task = executing.task;
	}
	if (task.status !== "executing") throw new Error(`devflow: cannot dispatch task ${task.id} from status ${task.status}`);
	return task;
}
/** Services the tools delegate to. */
function appendDispatchDiagnostic(store, diagnostic) {
	recordDevFlowChange(store, "devflow/dispatch/diagnostic", { diagnostic: makeDispatchDiagnostic(diagnostic) }).catch(() => {});
}
function dispatchFailureCode(cause) {
	if (!(cause instanceof Error)) return "DEVFLOW_DISPATCH_FAILURE";
	return /DEVFLOW_DISPATCH_[A-Z_]+/.exec(cause.message)?.[0] ?? "DEVFLOW_DISPATCH_FAILURE";
}
function dispatchFailureSummary(code) {
	return {
		DEVFLOW_DISPATCH_ERROR: "The fixed Agent stopped before completion.",
		DEVFLOW_DISPATCH_ABORTED: "The fixed Agent dispatch was aborted before completion.",
		DEVFLOW_DISPATCH_MAX_TOKENS: "The fixed Agent stopped after reaching its output limit.",
		DEVFLOW_DISPATCH_REFUSAL: "The fixed Agent declined the dispatched task.",
		DEVFLOW_DISPATCH_EMPTY_OUTPUT: "The fixed Agent returned no result document.",
		DEVFLOW_DISPATCH_RESULT_FORMAT_INVALID: "The fixed Agent result format was invalid.",
		DEVFLOW_DISPATCH_RESULT_REJECTED: "The fixed Agent result document was rejected; dispatch again with the exact required format.",
		DEVFLOW_DISPATCH_TASK_MISMATCH: "The fixed Agent result targets another task.",
		DEVFLOW_DISPATCH_RESULT_IMPORT_FAILED: "The fixed Agent result could not be imported."
	}[code] ?? "The fixed Agent dispatch failed before completion.";
}
/** Child replies one dispatch accepts before degrading to a rejected outcome. */
const MAX_RESULT_ATTEMPTS = 2;
/** Bounded, safe rendering of what was wrong with a reply document. */
function safeResultProblems(problems) {
	return problems.map((problem) => problem.replace(/[\r\n]+/g, " ").slice(0, 60)).filter((problem) => problem.length > 0).slice(0, 4).join("; ");
}
/** The failure summary, extended with the bounded document problems. */
function summaryWithProblems(code, problems) {
	const base = dispatchFailureSummary(code);
	const detail = safeResultProblems(problems ?? []);
	return detail === "" ? base : `${base} Missing or invalid: ${detail}.`;
}
/**
* One dispatch whose child replies never contained an acceptable result
* document. This is a REJECTED outcome, not an abort: the attempt and execution
* records stay durable and the dispatch is retryable.
*/
var DispatchResultRejected = class extends Error {
	problems;
	constructor(problems, options) {
		super(`devflow: DEVFLOW_DISPATCH_RESULT_REJECTED: ${summaryWithProblems("DEVFLOW_DISPATCH_RESULT_REJECTED", problems)}`, options);
		this.name = "DispatchResultRejected";
		this.problems = [...problems];
	}
};
/** The stricter instruction appended for the single retry. */
function retryInstruction(problems) {
	const detail = safeResultProblems(problems);
	return [
		"## Retry: Required Result Format",
		"",
		`Your previous reply was rejected because ${detail === "" ? "it contained no result document" : `it could not be accepted (${detail})`}.`,
		"Reply with only the result document: your final reply must contain nothing else.",
		"Start at the line `# DevFlow Result`, keep every metadata key and section, and add no explanations, no prose, and no fenced code block before or after it."
	].join("\n");
}
/** Render `- item` lines, dropping empty entries. */
function bulletLines(items) {
	return items.map((item) => item.trim()).filter((item) => item !== "").map((item) => `- ${item}`).join("\n");
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
	const imports = (await store.listJournal()).filter((entry) => entry.type === "devflow/bridge/import");
	for (let index = imports.length - 1; index >= 0; index -= 1) {
		const entry = imports[index];
		if (entry === void 0) continue;
		const data = entry.data;
		if (data.taskId !== taskId) continue;
		if (data.verdict !== "changes-requested" || typeof data.resultId !== "string") return void 0;
		return await store.getResult(data.resultId);
	}
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
	const projectScope = taskScope === void 0 ? await store.getScope() : void 0;
	const scope = taskScope ?? projectScope;
	const source = taskScope !== void 0 ? "task" : projectScope !== void 0 ? "project" : "none";
	const rework = await latestReworkReason(store, task.id);
	const reworkLines = rework === void 0 ? [] : [...rework.issues, ...rework.nextSteps].map((line) => line.trim()).filter((line) => line !== "" && line !== "None");
	const scopeCriteria = (scope?.completionCriteria ?? []).map((line) => line.trim()).filter((line) => line !== "");
	const blocks = [];
	if (reworkLines.length > 0) blocks.push([
		"## Changes requested by the previous review",
		"",
		bulletLines(reworkLines),
		"",
		`Previous review summary: ${rework?.summary ?? ""}`.trim()
	].join("\n"));
	if (scope !== void 0) blocks.push([
		`## Scope Guard (source: ${source === "task" ? `this task ${task.id}` : "project default"})`,
		"",
		...source === "task" ? [] : ["This task has no Scope Guard of its own; the bounds below are the PROJECT default. Call devflow_set_scope with this task id so a later task cannot re-bound this work.", ""],
		...scope.summary.trim() === "" ? [] : [`Summary: ${scope.summary.trim()}`, ""],
		...scope.inScope.length === 0 ? [] : [`In scope:\n${bulletLines(scope.inScope)}`, ""],
		...scopeCriteria.length === 0 ? [] : [`Completion criteria:\n${bulletLines(scopeCriteria)}`, ""],
		`Limits: at most ${scope.maxModifiedFiles} modified files and ${scope.maxToolSteps} tool steps.`
	].join("\n"));
	return {
		instructions: blocks.join("\n\n"),
		acceptanceCriteria: scopeCriteria.length > 0 ? scopeCriteria : reworkLines,
		scopeGuard: scope === void 0 ? void 0 : resolveTaskScope(scope, void 0),
		scope,
		source
	};
}
/**
* Path tokens in one text: a run of path characters holding at least one
* separator. The text is slash-normalized before this runs, so a token is the
* same whether it was written `src/js/ui.js` or `src\js\ui.js`.
*
* Full-width punctuation is excluded for the same reason ASCII punctuation is, and it
* was measured rather than guessed: in a live project (2026-09-22) the bounds prose
* `server/、gzh-Skills/、docs/契约/、产品说明.md` was read as ONE token, so the guard
* judged a "location" (`server/、gzh-skills/、docs/契约`) that no task text can ever
* mention. Excluding `、` splits it into pieces that each match the task text.
*/
const PATH_TOKEN = /[^\s"'`,;()、，。：；！？「」『』（）《》【】…—·]*\/[^\s"'`,;()、，。：；！？「」『』（）《》【】…—·]*/g;
/** File-name tokens in one text. */
const FILE_NAME_TOKEN = /[A-Za-z0-9_][A-Za-z0-9_.-]*\.(?:html|css|js|mjs|cjs|ts|tsx|jsx|json|md|txt|yml|yaml|py|sh|ps1)\b/gi;
/**
* The normalized locations one slash-normalized path token denotes, lowercased.
*
* Two tokens sit on one LINEAGE when they are equal, or when one is a segment-wise
* prefix of the other — `a/b` and `a/b/c/file` are the same lineage; `docs/secret/x`
* and `docs/other/x` are NOT, even though both start with `docs`.
*
* This replaced an "ancestor closure" comparison, and a live run is why: registering
* every ancestor of a bound as its own excusable location made `docs/secret/overview.md`
* match a task that only mentioned `docs/overview.md` — both sets contained `docs`, so a
* genuine contradiction was handed over (measured 2026-09-22 on the running host, the
* task that the same check used to refuse). Lineage keeps the case that motivated the
* closure (`.npm-cache/node_modules/dist/output/logs/config` is excused by a task that
* names `.npm-cache/`, because one token is a prefix of the other) without letting a
* shared GRANDparent excuse two different children.
*/
function sameLineage(left, right) {
	return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}
/** One path token, slash-normalized, without a trailing separator and lowercased. */
function pathTokenOf(token) {
	return token.replace(/\/+$/, "").toLowerCase();
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
*
* The FIRST SEGMENT must be ASCII as well. This is measured, not stylistic: a live
* project (2026-09-22, `D:\公众号agent`) lost ~50 minutes to seven refused dispatches
* whose only cause was Chinese prose using `/` for "or" — `暂停/继续/每轮复制`,
* `成立/不成立/无法判定` — which satisfied "two separators" and were therefore judged as
* locations. A real path in these projects starts with an ASCII segment (`docs/契约/
* 运行契约.md`, `web/src/…`), so the rule keeps every real location while dropping the
* prose. The cost is deliberate: a bound whose FIRST segment is Chinese (`日志/2026.md`)
* is no longer judged at all — it can only excuse, never refuse.
*/
function namesOwnLocation(token) {
	const trimmed = token.replace(/\/+$/, "");
	if (!/^\/?[A-Za-z0-9_.\-]/.test(trimmed)) return false;
	return token.endsWith("/") || (trimmed.match(/\//g)?.length ?? 0) >= 2 || /^[A-Za-z]:\//.test(trimmed);
}
/** Every distinct file-name token in one text, lowercased. */
function fileNamesOf(text) {
	return new Set((text.match(FILE_NAME_TOKEN) ?? []).map((name) => name.toLowerCase()));
}
/**
* Every distinct path token a text NAMES, lowercased — the judging side.
*
* Both slash styles are normalized first, so `src/js/ui.js` and `src\js\ui.js` yield the
* same token instead of two disjoint sets: the false `DEVFLOW_DISPATCH_SCOPE_CONFLICT`
* that refused legitimate handoffs. Prose slash words are excluded here by
* {@link namesOwnLocation}.
*/
function judgedTokensOf(text) {
	const normalized = text.replace(/\\/g, "/");
	const out = /* @__PURE__ */ new Set();
	for (const token of normalized.match(PATH_TOKEN) ?? []) {
		if (!namesOwnLocation(token)) continue;
		const value = pathTokenOf(token);
		if (value !== "") out.add(value);
	}
	return [...out];
}
/**
* Every distinct path token a text MENTIONS, lowercased — the excusing side.
*
* Deliberately more generous than {@link judgedTokensOf}: every slash-bearing token
* counts, so bounds written `docs/日志/` still match a task that writes the same
* directory bare (`docs\日志`). The comparison itself is {@link sameLineage}, NOT a
* closed set of ancestors — see that function for the live measurement that forced it.
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
function mentionedTokensOf(text) {
	const normalized = text.replace(/\\/g, "/");
	const out = /* @__PURE__ */ new Set();
	for (const token of normalized.match(PATH_TOKEN) ?? []) {
		const value = pathTokenOf(token);
		if (value !== "") out.add(value);
	}
	return [...out];
}
/** A handoff whose bounds contradict the task they are meant to implement. */
var DispatchScopeConflict = class extends Error {
	constructor(detail) {
		super(`devflow: DEVFLOW_DISPATCH_SCOPE_CONFLICT: ${detail}; set this task's own bounds with devflow_set_scope, or clear the stale bounds with devflow_clear_scope.`);
		this.name = "DispatchScopeConflict";
	}
};
/** Every trigger `devflow_request_decision` accepts. */
const DECISION_TRIGGERS = [
	"ambiguity",
	"approach-divergence",
	"scope-creep",
	"review-failed-twice",
	"high-risk-operation",
	"granularity",
	"development-order"
];
/** The option-count window the decision contract accepts. */
const DECISION_OPTION_MIN = 3;
const DECISION_OPTION_MAX = 5;
/** The reserved id of the user-custom entry the service appends itself. */
const DECISION_CUSTOM_OPTION_ID = "custom";
/**
* The user-custom option carried by a DURABLE decision request.
*
* DevFlow's own decision surfaces render this copy, so it is Chinese like the
* rest of them. It is one shared constant rather than a literal at each call
* site: the popup copy drifted into English precisely because it was hardcoded
* inline.
*/
const DECISION_CUSTOM_OPTION = {
	id: DECISION_CUSTOM_OPTION_ID,
	label: "自定义",
	description: "不在上述选项中，由我自行填写",
	recommended: false
};
/** One bounded, actionable argument-contract failure. */
function decisionArgsError(detail) {
	return /* @__PURE__ */ new Error(`devflow: devflow_request_decision ${detail}`);
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
	if (typeof value !== "string") return value;
	const text = value.trim();
	if (!text.startsWith("{") && !text.startsWith("[")) return value;
	try {
		return JSON.parse(text);
	} catch (cause) {
		throw decisionArgsError(`received "${field}" as JSON text that could not be parsed (${cause instanceof Error ? cause.message.slice(0, 80) : "invalid JSON"}); send it as a plain value instead`);
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
	const concrete = options.filter((option) => option.id !== DECISION_CUSTOM_OPTION_ID);
	const undeclared = concrete.filter((option) => option.kind === void 0).map((option) => option.id);
	if (undeclared.length > 0) throw decisionArgsError(`options ${undeclared.join(", ")} do not declare "kind"; every option must say what it does — one of proceed, retry, stop`);
	if (!concrete.some((option) => option.kind === "stop")) throw decisionArgsError("no option declares kind \"stop\"; every decision must offer the user a way to halt the work instead of continuing it");
	if (concrete.find((option) => option.id === recommended)?.kind === "retry") throw decisionArgsError(`recommendedOption ${JSON.stringify(recommended)} declares kind "retry"; a recommendation may never be a retry — recommend the most conservative option (usually "stop") instead`);
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
function parseDecisionRequestArgs(raw) {
	const record = parseDecisionField(raw, "arguments");
	if (typeof record !== "object" || record === null || Array.isArray(record)) throw decisionArgsError(`needs an object with trigger, question, recommendedOption, and 3-5 options (received ${Array.isArray(record) ? "an array" : typeof record})`);
	const input = record;
	const trigger = input.trigger;
	if (typeof trigger !== "string" || !DECISION_TRIGGERS.includes(trigger)) throw decisionArgsError(`received trigger ${JSON.stringify(trigger)}; use one of ${DECISION_TRIGGERS.join(", ")}`);
	const question = typeof input.question === "string" ? input.question.trim() : "";
	if (question === "") throw decisionArgsError(`needs a non-empty "question" (received ${typeof input.question})`);
	const rawOptions = parseDecisionField(input.options, "options");
	if (!Array.isArray(rawOptions)) throw decisionArgsError(`received "options" as ${typeof rawOptions}; send an array of 3-5 { id, label, description } entries`);
	const options = [];
	const ids = [];
	for (const [index, entry] of rawOptions.entries()) {
		const candidate = parseDecisionField(entry, `options[${index}]`);
		if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) throw decisionArgsError(`received options[${index}] as ${typeof candidate}; each option must be an object with string id/label/description`);
		const option = candidate;
		const id = typeof option.id === "string" ? option.id.trim() : "";
		const label = typeof option.label === "string" ? option.label.trim() : "";
		if (id === "" || label === "") throw decisionArgsError(`received options[${index}] without a usable id/label (id: ${JSON.stringify(option.id)}, label: ${JSON.stringify(option.label)})`);
		if (ids.includes(id)) throw decisionArgsError(`received duplicate option id ${JSON.stringify(id)}; ids must be unique`);
		const description = typeof option.description === "string" && option.description.trim() !== "" ? option.description.trim() : label;
		const kind = option.kind;
		if (kind !== void 0 && kind !== "proceed" && kind !== "retry" && kind !== "stop") throw decisionArgsError(`received options[${index}].kind ${JSON.stringify(option.kind)}; use one of proceed, retry, stop`);
		ids.push(id);
		options.push({
			id,
			label,
			description,
			recommended: false,
			...kind === void 0 ? {} : { kind }
		});
	}
	if (options.length < DECISION_OPTION_MIN || options.length > DECISION_OPTION_MAX) throw decisionArgsError(`received ${options.length} options (${ids.join(", ") || "none"}); pass ${DECISION_OPTION_MIN}-${DECISION_OPTION_MAX} concrete recommended options — the user-custom option is appended automatically`);
	const recommendedOption = parseDecisionField(input.recommendedOption, "recommendedOption");
	if (typeof recommendedOption !== "string" || recommendedOption.trim() === "") throw decisionArgsError(`received recommendedOption ${JSON.stringify(recommendedOption)}; set it to one of the option ids (${ids.join(", ")})`);
	const recommended = recommendedOption.trim();
	if (!ids.includes(recommended)) throw decisionArgsError(`received recommendedOption ${JSON.stringify(recommendedOption)} which is not one of the option ids (${ids.join(", ")}); set it to one of them`);
	assertDecisionOptionRules(options, recommended);
	const taskId = typeof input.taskId === "string" && input.taskId.trim() !== "" ? input.taskId.trim() : void 0;
	const custom = ids.includes(DECISION_CUSTOM_OPTION_ID) ? [] : [{ ...DECISION_CUSTOM_OPTION }];
	return {
		...taskId === void 0 ? {} : { taskId },
		trigger,
		question,
		recommendedOption: recommended,
		options: [...options.map((option) => ({
			...option,
			recommended: option.id === recommended
		})), ...custom]
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
	if (scope === void 0) return;
	const scopeText = [
		scope.summary,
		...scope.inScope,
		...scope.completionCriteria
	].join("\n");
	const taskText = `${task.title}\n${task.description}`;
	const judgedTokens = judgedTokensOf(scopeText);
	if (judgedTokens.length > 0) {
		const mentionedTokens = mentionedTokensOf(taskText);
		if (judgedTokens.every((named) => !mentionedTokens.some((mention) => sameLineage(named, mention)))) throw new DispatchScopeConflict("the bounds name a location this task does not describe");
	}
	const scopeFiles = fileNamesOf(scopeText);
	const taskFiles = fileNamesOf(taskText);
	if (scopeFiles.size > 0 && taskFiles.size > 0 && [...scopeFiles].every((name) => !taskFiles.has(name))) throw new DispatchScopeConflict("the bounds name files this task does not describe");
}
async function completeBatch(store, runtime) {
	if (runtime.batch === void 0) return;
	let batch = await store.getBatch(runtime.batch.batchId);
	if (batch === void 0 || batch.status === "completed") return;
	if (batch.status === "planned") {
		batch = await store.updateBatchStatus(batch.batchId, "running");
		await recordDevFlowChange(store, "devflow/execution/batch/start", {
			batchId: batch.batchId,
			at: batch.updatedAt
		});
	}
	if (batch.status === "paused") {
		batch = await store.updateBatchStatus(batch.batchId, "running");
		await recordDevFlowChange(store, "devflow/execution/batch/start", {
			batchId: batch.batchId,
			at: batch.updatedAt
		});
	}
	if (batch.status === "running") {
		batch = await store.updateBatchStatus(batch.batchId, "completed");
		await recordDevFlowChange(store, "devflow/execution/batch/complete", {
			batchId: batch.batchId,
			at: batch.updatedAt
		});
	}
	runtime.batch = batch;
}
async function failDirectDispatch(store, runtime, agentId, code, outcome = {}) {
	if (runtime.attempt !== void 0) {
		let attempt = await store.getAttempt(runtime.attempt.attemptId);
		if (attempt?.status === "created") {
			attempt = await store.updateAttemptStatus(attempt.attemptId, "running");
			await recordDevFlowChange(store, "devflow/execution/attempt/start", {
				attemptId: attempt.attemptId,
				at: attempt.updatedAt
			});
		}
		if (attempt?.status === "running") {
			attempt = await store.updateAttemptStatus(attempt.attemptId, "failed");
			await recordDevFlowChange(store, "devflow/execution/attempt/fail", {
				attemptId: attempt.attemptId,
				at: attempt.updatedAt
			});
		}
		if (attempt !== void 0) runtime.attempt = attempt;
	}
	if (runtime.execution !== void 0) {
		let execution = await store.getExecutionRecord(runtime.execution.executionId);
		if (execution?.status === "pending") {
			execution = await store.updateExecutionStatus(execution.executionId, "running");
			await recordDevFlowChange(store, "devflow/execution/start", { execution });
		}
		if (execution?.status === "running") {
			execution = await store.updateExecutionStatus(execution.executionId, "failed");
			await recordDevFlowChange(store, "devflow/execution/fail", {
				executionId: execution.executionId,
				at: execution.updatedAt
			});
		}
		if (execution !== void 0) {
			runtime.execution = execution;
			if ((await store.listReportsByExecution(execution.executionId)).length === 0) await recordDevFlowChange(store, "devflow/agent/report/create", { report: await store.createReport({
				executionId: execution.executionId,
				agentId,
				status: outcome.reportStatus ?? "failed",
				summary: summaryWithProblems(code, outcome.problems),
				outputReference: `devflow:execution:${execution.executionId}`
			}) });
		}
	}
	await completeBatch(store, runtime);
}
const projectValueSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		id: {
			type: "string",
			required: true
		},
		name: {
			type: "string",
			required: true
		},
		goal: {
			type: "string",
			required: true
		},
		currentStage: {
			type: "string",
			required: true
		},
		createdAt: {
			type: "string",
			required: true
		},
		updatedAt: {
			type: "string",
			required: true
		}
	}
};
const taskValueSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		id: {
			type: "string",
			required: true
		},
		title: {
			type: "string",
			required: true
		},
		description: {
			type: "string",
			required: true
		},
		status: {
			type: "string",
			required: true,
			enum: TASK_STATUSES
		},
		assignedRole: {
			type: "string",
			enum: ASSIGNED_ROLES
		},
		createdAt: {
			type: "string",
			required: true
		},
		updatedAt: {
			type: "string",
			required: true
		}
	}
};
const taskStatusChangeValueSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		taskId: {
			type: "string",
			required: true
		},
		from: {
			type: "string",
			required: true,
			enum: TASK_STATUSES
		},
		to: {
			type: "string",
			required: true,
			enum: TASK_STATUSES
		},
		at: {
			type: "string",
			required: true
		}
	}
};
const resultValueSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		id: {
			type: "string",
			required: true
		},
		taskId: {
			type: "string",
			required: true
		},
		summary: {
			type: "string",
			required: true
		},
		changes: {
			type: "array",
			required: true,
			items: { type: "string" }
		},
		verification: {
			type: "array",
			required: true,
			items: { type: "string" }
		},
		issues: {
			type: "array",
			required: true,
			items: { type: "string" }
		},
		nextSteps: {
			type: "array",
			required: true,
			items: { type: "string" }
		},
		createdAt: {
			type: "string",
			required: true
		}
	}
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
function effectiveTemporaryTools(declared, callerView = /* @__PURE__ */ new Set()) {
	if (declared === void 0 || declared.length === 0) return [...TEMPORARY_READ_ONLY_TOOLS];
	const allowed = /* @__PURE__ */ new Set([...DECLARED_EMPLOYEE_TOOL_NAMES, ...callerView]);
	const trimmed = [];
	for (const name of declared) if (allowed.has(name) && !trimmed.includes(name)) trimmed.push(name);
	return trimmed;
}
/** Whether one tool list declares a writing capability (the auditable half of the rule). */
function declaresWriteClassTools(tools) {
	return tools.filter((name) => WRITE_CLASS_TOOLS.has(name));
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
	return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim() !== "");
}
/** The model configuration a temporary employee inherits from its role peer. */
function inheritedModelConfig(role) {
	const peer = DEFAULT_FIXED_AGENTS.find((agent) => agent.role === role && agent.agentId !== "commander");
	return peer === void 0 ? { model: "deepseek-chat" } : { model: peer.modelConfig.model };
}
/** The system prompt of a temporary employee, assembled from its registry entry. */
function temporaryAgentPrompt(instance) {
	const capabilityLine = instance.capabilities === void 0 || instance.capabilities.length === 0 ? "" : `能力标签：${instance.capabilities.join("、")}。`;
	const description = instance.description === void 0 ? "" : `${instance.description}\n`;
	return `你是 DevFlow 的临时员工「${instance.displayName}」，由总指挥在本次项目内现场登记。${description}${capabilityLine}每次接任务先只读确认当前代码与状态的实际情况，再动手；若任务提示与实际明显偏离，停止并向总指挥反馈。`;
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
function authorizeAgentRegistration(isCommander, caller) {
	if (caller === void 0) throw new Error("devflow: registering an employee requires a calling agent; no parent agent on this tool call");
	if (isCommander === void 0 || !isCommander(caller)) throw new Error(`devflow: registering an employee is restricted to the Commander; caller ${caller.id} is not authorized`);
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
	if (existing !== void 0 && existing.kind === "fixed") throw new Error(`devflow: ${instance.id} is a fixed employee and cannot be redefined by devflow_agent_upsert`);
	let callerView = /* @__PURE__ */ new Set();
	if (caller !== void 0) try {
		callerView = new Set(caller.ctx.tools.schemas(caller).map((entry) => entry.name));
	} catch {
		callerView = /* @__PURE__ */ new Set();
	}
	const tools = effectiveTemporaryTools(declaredTools, callerView);
	const writeClass = declaresWriteClassTools(tools);
	const config = {
		role: instance.role,
		prompt: temporaryAgentPrompt(instance),
		modelConfig: inheritedModelConfig(instance.role),
		tools,
		capabilities: instance.capabilities === void 0 ? [] : [...instance.capabilities],
		skills: [],
		delegationDepth: 0
	};
	const registered = existing === void 0 ? await store.registerAgent({
		agentId: instance.id,
		kind: "temporary",
		...config
	}) : await store.updateAgentConfig(instance.id, config);
	if (existing === void 0) await recordDevFlowChange(store, "devflow/agent/register", {
		agent: registered,
		writeClassTools: [...writeClass]
	});
	else await recordDevFlowChange(store, "devflow/agent/update-config", {
		agentId: registered.agentId,
		patch: config,
		writeClassTools: [...writeClass],
		at: registered.updatedAt
	});
	return {
		agent: registered,
		tools,
		writeClass
	};
}
/**
* One workflow pair per resolved store.
*
* A session that calls ten tools must not build ten wrappers, and two wrappers
* over one store would be two objects for one project's lifecycle.
*/
const workflowByStore = /* @__PURE__ */ new WeakMap();
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
	if (sessionStores === void 0) return {
		scope: {
			store,
			sessionId: String(agent?.id ?? "(single-store)"),
			workspacePath: null,
			storeRoot: store.rootPath,
			sessionKey: store.rootPath
		},
		store,
		workflow,
		agentWorkflow
	};
	const scope = sessionStores.resolve(agent);
	if (scope.store === store) return {
		scope,
		store,
		workflow,
		agentWorkflow
	};
	let pair = workflowByStore.get(scope.store);
	if (pair === void 0) {
		const scoped = new TaskWorkflow(scope.store);
		pair = {
			workflow: scoped,
			agentWorkflow: new AgentWorkflow(scope.store, scoped)
		};
		workflowByStore.set(scope.store, pair);
	}
	return {
		scope,
		store: scope.store,
		workflow: pair.workflow,
		agentWorkflow: pair.agentWorkflow
	};
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
const DEVFLOW_DISPATCH_AGENT_DESCRIPTION = "Dispatch one existing task to a registered code engineer or auditor through the native Harness spawn provider. The child receives only its configured tools and Skill-bound persona. This call can OVERLAP with other dispatch calls: when several tasks are ready and independent (they do not write the same files / directories / config), send them as parallel calls in ONE reply so the children run at the same time — do not dispatch one and wait for it before dispatching the next. Tasks that DO share products, or where the second needs the first's output, must stay sequential.";
/**
* Register every DevFlow tool family on the calling context.
* @param ctx - registrant context; tools register only when a tool runtime is composed.
* @param services - store, task session resolution, and workflows the tools delegate to.
*/
function registerDevFlowTools(ctx, services) {
	const { store, workflow, agentWorkflow, isCommander } = services;
	ctx.tools.register(defineTool({
		name: "devflow_project_status",
		description: "Show the current DevFlow project context (goal, current stage) and task overview. Returns the saved project, or null when no project has been initialized in this devflow root.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { project: {
					oneOf: [projectValueSchema, { type: "null" }],
					required: true
				} }
			},
			render: (_args, value) => [{
				type: "text",
				text: value.project === null ? "No project initialized in this devflow root." : `Project: ${value.project.name} (${value.project.id}), stage ${value.project.currentStage}.`
			}]
		},
		execute: async (_args, exec) => {
			const { store: sessionStore } = bindSession(services, exec.agent);
			return { project: await sessionStore.loadProject() ?? null };
		},
		presentCall: () => ({
			card: "generic",
			title: "DevFlow project status",
			kind: "other"
		}),
		presentResult: (_args, result) => ({
			card: "generic",
			title: "DevFlow project status",
			content: result.content
		})
	}));
	ctx.tools.register(defineTool({
		name: "devflow_create_task",
		description: "Create a DevFlow task in the initial `created` state. The task lifecycle then moves through planned, executing, reviewing, and completed via devflow_transition_task.",
		parameters: {
			title: {
				type: "string",
				required: true,
				description: "Human-readable task title."
			},
			description: {
				type: "string",
				required: true,
				description: "Free-form task description."
			},
			assignedRole: {
				type: "string",
				enum: ASSIGNED_ROLES,
				description: "Role the task is assigned to: planner, backend-engineer, frontend-engineer, or reviewer (optional)."
			}
		},
		output: {
			schema: taskValueSchema,
			render: (_args, value) => [{
				type: "text",
				text: `Created task ${value.id}: ${value.title} (${value.status}).`
			}]
		},
		execute: async (args, exec) => {
			const { store: sessionStore, workflow: sessionWorkflow } = bindSession(services, exec.agent);
			const task = await sessionWorkflow.createTask({
				title: args.title,
				description: args.description,
				status: "created",
				...args.assignedRole === void 0 ? {} : { assignedRole: args.assignedRole }
			});
			await recordDevFlowChange(sessionStore, "devflow/task/transition", {
				taskId: task.id,
				title: task.title,
				from: null,
				to: task.status,
				at: task.createdAt
			});
			return task;
		},
		presentCall: (args) => ({
			card: "generic",
			title: "Create DevFlow task",
			kind: "other",
			rawInput: args
		}),
		presentResult: (_args, result) => ({
			card: "generic",
			title: "DevFlow task created",
			content: result.content
		})
	}));
	ctx.tools.register(defineTool({
		name: "devflow_transition_task",
		description: "Advance one DevFlow task to the given status. Legal moves: created -> planned, planned -> executing, executing -> reviewing, reviewing -> completed, and the rework edge reviewing -> executing. Illegal transitions are rejected with the current and requested status.",
		parameters: {
			taskId: {
				type: "string",
				required: true,
				description: "The task id to advance."
			},
			transition: {
				type: "string",
				required: true,
				enum: [
					"planned",
					"executing",
					"reviewing",
					"completed",
					"failed",
					"cancelled"
				],
				description: "The target status: planned, executing, reviewing, completed, failed, or cancelled. Use role ids only in assignedRole/agentId."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					task: {
						...taskValueSchema,
						required: true
					},
					change: {
						...taskStatusChangeValueSchema,
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `Task ${value.task.id} moved ${value.change.from} -> ${value.change.to}.`
			}]
		},
		execute: async (args, exec) => {
			const { store: sessionStore, workflow: sessionWorkflow } = bindSession(services, exec.agent);
			let result;
			switch (args.transition) {
				case "planned":
					result = await sessionWorkflow.planTask(args.taskId);
					break;
				case "executing":
					result = await sessionWorkflow.startExecution(args.taskId);
					break;
				case "reviewing":
					result = await sessionWorkflow.submitReview(args.taskId);
					break;
				case "completed":
					result = await sessionWorkflow.completeTask(args.taskId);
					break;
				case "failed":
					result = await sessionWorkflow.failTask(args.taskId);
					break;
				case "cancelled":
					result = await sessionWorkflow.cancelTask(args.taskId);
					break;
				default: {
					const exhaustive = args.transition;
					throw new Error(`unreachable transition ${String(exhaustive)}`);
				}
			}
			await recordDevFlowChange(sessionStore, "devflow/task/transition", {
				...result.change,
				title: result.task.title
			});
			return {
				task: result.task,
				change: result.change
			};
		},
		presentCall: (args) => ({
			card: "generic",
			title: "Advance DevFlow task",
			kind: "other",
			rawInput: args
		}),
		presentResult: (_args, result) => ({
			card: "generic",
			title: "DevFlow task advanced",
			content: result.content
		})
	}));
	ctx.tools.register(defineTool({
		name: "devflow_submit_result",
		description: "Archive one Agent execution result for a task. The result is saved as the task's result record; advance the task to `reviewing` separately with devflow_transition_task when the review phase begins.",
		parameters: {
			taskId: {
				type: "string",
				required: true,
				description: "The task this result belongs to."
			},
			summary: {
				type: "string",
				required: true,
				description: "One-paragraph execution summary."
			},
			changes: {
				type: "array",
				required: true,
				items: { type: "string" },
				description: "Files, interfaces, or config changes made."
			},
			verification: {
				type: "array",
				required: true,
				items: { type: "string" },
				description: "Verification method and outcome."
			},
			issues: {
				type: "array",
				required: true,
				items: { type: "string" },
				description: "Unfinished work, risks, and follow-ups."
			},
			nextSteps: {
				type: "array",
				required: true,
				items: { type: "string" },
				description: "Suggested next steps."
			}
		},
		output: {
			schema: resultValueSchema,
			render: (_args, value) => [{
				type: "text",
				text: `Saved result ${value.id} for task ${value.taskId}.`
			}]
		},
		execute: async (args, exec) => {
			const { store: sessionStore } = bindSession(services, exec.agent);
			const saved = await sessionStore.saveResult({
				taskId: args.taskId,
				summary: args.summary,
				changes: args.changes,
				verification: args.verification,
				issues: args.issues,
				nextSteps: args.nextSteps
			});
			return {
				...saved,
				changes: [...saved.changes],
				verification: [...saved.verification],
				issues: [...saved.issues],
				nextSteps: [...saved.nextSteps]
			};
		},
		presentCall: (args) => ({
			card: "generic",
			title: "Submit DevFlow result",
			kind: "other",
			rawInput: args
		}),
		presentResult: (_args, result) => ({
			card: "generic",
			title: "DevFlow result saved",
			content: result.content
		})
	}));
	ctx.tools.register(defineTool({
		name: "devflow_create_task_package",
		description: "Build the Agent handoff package for one task: the vendor-neutral envelope (protocol version, project context, task, instructions, acceptance criteria) an Agent consumes to execute the task. Requires an initialized project and an assigned role (or an explicit role argument).",
		parameters: {
			taskId: {
				type: "string",
				required: true,
				description: "The task to package."
			},
			role: {
				type: "string",
				enum: ASSIGNED_ROLES,
				description: "Target role for the handoff; defaults to the task's assigned role."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					protocolVersion: {
						type: "string",
						required: true
					},
					taskId: {
						type: "string",
						required: true
					},
					role: {
						type: "string",
						required: true
					},
					projectContext: {
						...projectValueSchema,
						required: true
					},
					task: {
						...taskValueSchema,
						required: true
					},
					instructions: {
						type: "string",
						required: true
					},
					acceptanceCriteria: {
						type: "array",
						required: true,
						items: { type: "string" }
					},
					scopeGuard: {
						type: "object",
						additionalProperties: false,
						properties: {
							maxModifiedFiles: {
								type: "number",
								required: true
							},
							maxToolSteps: {
								type: "number",
								required: true
							},
							completionCriteria: {
								type: "array",
								required: true,
								items: { type: "string" }
							}
						}
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `Task package for ${value.taskId} (protocol ${value.protocolVersion}, role ${value.role}): ${value.instructions || "no instructions"} — ${value.acceptanceCriteria.length} acceptance criteria.`
			}]
		},
		execute: async (args, exec) => {
			const { store: sessionStore } = bindSession(services, exec.agent);
			const task = await sessionStore.getTask(args.taskId);
			if (task === void 0) throw new Error(`devflow: unknown task ${args.taskId}`);
			const bounds = await resolveTaskBounds(sessionStore, task);
			assertPackageScopeConsistency(task, bounds.scope);
			const { scopeGuard, ...packageRest } = (await prepareTaskPackage(sessionStore, args.taskId, {
				...args.role === void 0 ? {} : { role: args.role },
				instructions: bounds.instructions,
				acceptanceCriteria: [...bounds.acceptanceCriteria],
				...bounds.scopeGuard === void 0 ? {} : { scopeGuard: bounds.scopeGuard }
			})).package;
			return {
				...packageRest,
				acceptanceCriteria: [...packageRest.acceptanceCriteria],
				...scopeGuard === void 0 ? {} : { scopeGuard: {
					maxModifiedFiles: scopeGuard.maxModifiedFiles,
					maxToolSteps: scopeGuard.maxToolSteps,
					completionCriteria: [...scopeGuard.completionCriteria]
				} }
			};
		},
		presentCall: (args) => ({
			card: "generic",
			title: "Create DevFlow task package",
			kind: "other",
			rawInput: args
		}),
		presentResult: (_args, result) => ({
			card: "generic",
			title: "DevFlow task package",
			content: result.content
		})
	}));
	ctx.tools.register(defineTool({
		name: "devflow_export_task",
		description: "Export one task as its Markdown handoff document (task.md): project context, task, role, instructions, acceptance criteria, and file scope in the fixed DevFlow Task template. The document is returned as text — save it yourself and hand it to the external Executor Agent.",
		parameters: { taskId: {
			type: "string",
			required: true,
			description: "The task to export."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					taskId: {
						type: "string",
						required: true
					},
					markdown: {
						type: "string",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: value.markdown
			}]
		},
		execute: async (args, exec) => {
			const { store: sessionStore, agentWorkflow: sessionAgentWorkflow } = bindSession(services, exec.agent);
			const exported = await sessionAgentWorkflow.exportTask(args.taskId, (updated) => recordDevFlowChange(sessionStore, "devflow/project/update", { project: updated }).then(() => void 0));
			await recordDevFlowChange(sessionStore, "devflow/bridge/export", {
				taskId: exported.taskId,
				bridge: "markdown",
				at: (/* @__PURE__ */ new Date()).toISOString()
			});
			return exported;
		},
		presentCall: (args) => ({
			card: "generic",
			title: "Export DevFlow task",
			kind: "other",
			rawInput: args
		}),
		presentResult: (_args, result) => ({
			card: "generic",
			title: "DevFlow task export",
			content: result.content
		})
	}));
	ctx.tools.register(defineTool({
		name: "devflow_import_result",
		description: "Import one Markdown result document (result.md) produced by an external Executor Agent. The document is parsed with the MarkdownBridge, must target the given task, and is archived while the task advances to `reviewing` (the task must currently be `executing`).",
		parameters: {
			taskId: {
				type: "string",
				required: true,
				description: "The task the result document answers."
			},
			markdown: {
				type: "string",
				required: true,
				description: "The full result document text."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					result: {
						...resultValueSchema,
						required: true
					},
					task: {
						...taskValueSchema,
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `Imported result ${value.result.id} for task ${value.result.taskId}; task is now ${value.task.status}.`
			}]
		},
		execute: async (args, exec) => {
			const { store: sessionStore, agentWorkflow: sessionAgentWorkflow } = bindSession(services, exec.agent);
			const submission = await sessionAgentWorkflow.importResult(args.taskId, args.markdown);
			await recordDevFlowChange(sessionStore, "devflow/task/transition", {
				...submission.transition.change,
				title: submission.transition.task.title
			});
			await recordDevFlowChange(sessionStore, "devflow/bridge/import", {
				taskId: args.taskId,
				resultId: submission.result.id,
				protocolVersion: submission.protocolVersion,
				verdict: submission.verdict,
				at: submission.result.createdAt
			});
			const result = submission.result;
			return {
				result: {
					...result,
					changes: [...result.changes],
					verification: [...result.verification],
					issues: [...result.issues],
					nextSteps: [...result.nextSteps]
				},
				task: submission.transition.task
			};
		},
		presentCall: (args) => ({
			card: "generic",
			title: "Import DevFlow result",
			kind: "other",
			rawInput: args
		}),
		presentResult: (_args, result) => ({
			card: "generic",
			title: "DevFlow result imported",
			content: result.content
		})
	}));
	ctx.tools.register(defineTool({
		name: "devflow_resume",
		description: "Generate the Planner Resume for one task: the structured context (project, current task, execution results, task history) plus the rendered resume.md the Planner continues the next stage from.",
		parameters: { taskId: {
			type: "string",
			required: true,
			description: "The task the Planner resumes on."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					taskId: {
						type: "string",
						required: true
					},
					project: {
						...projectValueSchema,
						required: true
					},
					task: {
						...taskValueSchema,
						required: true
					},
					results: {
						type: "array",
						required: true,
						items: resultValueSchema
					},
					history: {
						type: "array",
						required: true,
						items: taskValueSchema
					},
					resume: {
						type: "string",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: value.resume
			}]
		},
		execute: async (args, exec) => {
			const { store: sessionStore, agentWorkflow: sessionAgentWorkflow } = bindSession(services, exec.agent);
			const { context, resume } = await sessionAgentWorkflow.resumeTask(args.taskId);
			await recordDevFlowChange(sessionStore, "devflow/planner/resume", {
				taskId: args.taskId,
				at: (/* @__PURE__ */ new Date()).toISOString()
			});
			return {
				taskId: args.taskId,
				project: context.project,
				task: context.task,
				results: context.results.map((result) => ({
					...result,
					changes: [...result.changes],
					verification: [...result.verification],
					issues: [...result.issues],
					nextSteps: [...result.nextSteps]
				})),
				history: context.history.map((task) => ({ ...task })),
				resume
			};
		},
		presentCall: (args) => ({
			card: "generic",
			title: "DevFlow planner resume",
			kind: "other",
			rawInput: args
		}),
		presentResult: (_args, result) => ({
			card: "generic",
			title: "DevFlow planner resume",
			content: result.content
		})
	}));
	ctx.tools.register(defineTool({
		name: "devflow_create_phase",
		description: "Create an ordered DevFlow development phase for the Commander plan.",
		parameters: {
			name: {
				type: "string",
				required: true,
				description: "Human-readable phase name."
			},
			description: {
				type: "string",
				required: true,
				description: "Phase goal and expected work."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: {
						type: "string",
						required: true
					},
					name: {
						type: "string",
						required: true
					},
					description: {
						type: "string",
						required: true
					},
					status: {
						type: "string",
						required: true,
						enum: PHASE_STATUSES
					},
					createdAt: {
						type: "string",
						required: true
					},
					updatedAt: {
						type: "string",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `Created phase ${value.id}: ${value.name}.`
			}]
		},
		execute: async (args, exec) => {
			const { store: sessionStore } = bindSession(services, exec.agent);
			const phase = await sessionStore.createPhase({
				name: args.name,
				description: args.description,
				status: "planned"
			});
			await recordDevFlowChange(sessionStore, "devflow/phase/create", { phase });
			return phase;
		},
		presentCall: (args) => ({
			card: "generic",
			title: "Create DevFlow phase",
			kind: "other",
			rawInput: args
		}),
		presentResult: (_args, result) => ({
			card: "generic",
			title: "DevFlow phase created",
			content: result.content
		})
	}));
	ctx.tools.register(defineTool({
		name: "devflow_update_phase",
		description: "Set a DevFlow phase status: planned, in_progress, or completed.",
		parameters: {
			phaseId: {
				type: "string",
				required: true,
				description: "The phase id to update."
			},
			status: {
				type: "string",
				required: true,
				enum: PHASE_STATUSES,
				description: "The new phase status."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: {
						type: "string",
						required: true
					},
					name: {
						type: "string",
						required: true
					},
					description: {
						type: "string",
						required: true
					},
					status: {
						type: "string",
						required: true,
						enum: PHASE_STATUSES
					},
					createdAt: {
						type: "string",
						required: true
					},
					updatedAt: {
						type: "string",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `Phase ${value.id} is ${value.status}.`
			}]
		},
		execute: async (args, exec) => {
			const { store: sessionStore } = bindSession(services, exec.agent);
			const phase = await sessionStore.updatePhaseStatus(args.phaseId, args.status);
			await recordDevFlowChange(sessionStore, "devflow/phase/update", {
				phaseId: phase.id,
				status: phase.status,
				at: phase.updatedAt
			});
			return phase;
		},
		presentCall: (args) => ({
			card: "generic",
			title: "Update DevFlow phase",
			kind: "other",
			rawInput: args
		}),
		presentResult: (_args, result) => ({
			card: "generic",
			title: "DevFlow phase updated",
			content: result.content
		})
	}));
	ctx.tools.register(defineTool({
		name: "devflow_set_scope",
		description: "Set the Scope Guard. Pass a taskId to bind the bounds to ONE task (the recommended form: the task package then carries exactly these bounds and no other task can overwrite them). Without a taskId the bounds become the PROJECT default, used only by tasks that never set their own.",
		parameters: {
			summary: {
				type: "string",
				required: true,
				description: "Committed scope summary."
			},
			inScope: {
				type: "array",
				required: true,
				items: { type: "string" },
				description: "In-scope work items."
			},
			maxModifiedFiles: {
				type: "number",
				required: true,
				description: "Positive maximum modified file count."
			},
			maxToolSteps: {
				type: "number",
				required: true,
				description: "Positive maximum tool step count."
			},
			completionCriteria: {
				type: "array",
				required: true,
				items: { type: "string" },
				description: "Non-empty completion criteria."
			},
			taskId: {
				type: "string",
				description: "Bind these bounds to one task; omit for the project default."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					source: {
						type: "string",
						required: true
					},
					taskId: { type: "string" },
					summary: {
						type: "string",
						required: true
					},
					inScope: {
						type: "array",
						required: true,
						items: { type: "string" }
					},
					maxModifiedFiles: {
						type: "number",
						required: true
					},
					maxToolSteps: {
						type: "number",
						required: true
					},
					completionCriteria: {
						type: "array",
						required: true,
						items: { type: "string" }
					},
					createdAt: {
						type: "string",
						required: true
					},
					updatedAt: {
						type: "string",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: value.taskId === void 0 ? `Project default Scope Guard set: ${value.summary}.` : `Scope Guard set for task ${value.taskId}: ${value.summary}.`
			}]
		},
		execute: async (args, exec) => {
			const { store: sessionStore } = bindSession(services, exec.agent);
			const input = {
				summary: args.summary,
				inScope: args.inScope,
				maxModifiedFiles: args.maxModifiedFiles,
				maxToolSteps: args.maxToolSteps,
				completionCriteria: args.completionCriteria
			};
			const scope = args.taskId === void 0 ? await sessionStore.updateScope(input) : await sessionStore.saveTaskScope(args.taskId, input);
			await recordDevFlowChange(sessionStore, args.taskId === void 0 ? "devflow/scope/update" : "devflow/scope/task-update", {
				scope,
				...args.taskId === void 0 ? {} : { taskId: args.taskId }
			});
			return {
				source: args.taskId === void 0 ? "project-default" : "task",
				...args.taskId === void 0 ? {} : { taskId: args.taskId },
				...scope,
				inScope: [...scope.inScope],
				completionCriteria: [...scope.completionCriteria]
			};
		},
		presentCall: (args) => ({
			card: "generic",
			title: "Set DevFlow scope",
			kind: "other",
			rawInput: args
		}),
		presentResult: (_args, result) => ({
			card: "generic",
			title: "DevFlow scope set",
			content: result.content
		})
	}));
	ctx.tools.register(defineTool({
		name: "devflow_clear_scope",
		description: "Clear stale Scope Guard bounds. Pass a taskId to clear that task's own bounds; omit it to clear the project default. Use this when a task carries bounds that belong to another task (the handoff is then refused with DEVFLOW_DISPATCH_SCOPE_CONFLICT) instead of dispatching a contradictory package.",
		parameters: { taskId: {
			type: "string",
			description: "Clear this task's own bounds; omit to clear the project default."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					cleared: {
						type: "string",
						required: true
					},
					taskId: { type: "string" }
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: value.taskId === void 0 ? "Project default Scope Guard cleared." : `Scope Guard cleared for task ${value.taskId}.`
			}]
		},
		execute: async (args, exec) => {
			const { store: sessionStore } = bindSession(services, exec.agent);
			if (args.taskId === void 0) {
				await sessionStore.clearScope();
				await recordDevFlowChange(sessionStore, "devflow/scope/clear", { at: (/* @__PURE__ */ new Date()).toISOString() });
				return { cleared: "project-default" };
			}
			await sessionStore.clearTaskScope(args.taskId);
			await recordDevFlowChange(sessionStore, "devflow/scope/task-clear", {
				taskId: args.taskId,
				at: (/* @__PURE__ */ new Date()).toISOString()
			});
			return {
				cleared: "task",
				taskId: args.taskId
			};
		},
		presentCall: (args) => ({
			card: "generic",
			title: "Clear DevFlow scope",
			kind: "other",
			rawInput: args
		}),
		presentResult: (_args, result) => ({
			card: "generic",
			title: "DevFlow scope cleared",
			content: result.content
		})
	}));
	ctx.tools.register(defineTool({
		name: "devflow_assign_agent",
		description: "Assign one registered DevFlow employee to a development phase. The valid agent ids are exactly the orchestration roster — the fixed employees (commander, backend-engineer, frontend-engineer, architect, code-auditor) plus any temporary employee registered with devflow_agent_upsert. Role names such as planner are not agent ids.",
		parameters: {
			phaseId: {
				type: "string",
				required: true,
				description: "The phase to assign."
			},
			taskId: {
				type: "string",
				required: true,
				description: "The task to assign."
			},
			agentId: {
				type: "string",
				required: true,
				description: "Registered orchestration agent id (a fixed employee, or a temporary employee registered with devflow_agent_upsert); do not pass a role such as planner."
			},
			role: {
				type: "string",
				required: true,
				enum: ASSIGNED_ROLES,
				description: "Role the agent performs for this phase."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					assignmentId: {
						type: "string",
						required: true
					},
					taskId: {
						type: "string",
						required: true
					},
					phaseId: {
						type: "string",
						required: true
					},
					agentId: {
						type: "string",
						required: true
					},
					role: {
						type: "string",
						required: true,
						enum: ASSIGNED_ROLES
					},
					status: {
						type: "string",
						required: true
					},
					createdAt: {
						type: "string",
						required: true
					},
					updatedAt: {
						type: "string",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `Assigned ${value.agentId} to phase ${value.phaseId}.`
			}]
		},
		execute: async (args, exec) => {
			const { store: sessionStore } = bindSession(services, exec.agent);
			if (await sessionStore.getPhase(args.phaseId) === void 0) throw new Error(`devflow: unknown phase ${args.phaseId}; create the phase first and pass the returned phase id unchanged`);
			if (await sessionStore.getAgent(args.agentId) === void 0) throw new Error(`devflow: unknown orchestration agent ${args.agentId}`);
			if (await sessionStore.getTask(args.taskId) === void 0) throw new Error(`devflow: unknown task ${args.taskId}`);
			const assignment = await sessionStore.createAssignment({
				taskId: args.taskId,
				phaseId: args.phaseId,
				agentId: args.agentId,
				role: args.role,
				status: "assigned"
			});
			await recordDevFlowChange(sessionStore, "devflow/orchestration/assign", { assignment });
			return {
				...assignment,
				taskId: args.taskId
			};
		},
		presentCall: (args) => ({
			card: "generic",
			title: "Assign DevFlow agent",
			kind: "other",
			rawInput: args
		}),
		presentResult: (_args, result) => ({
			card: "generic",
			title: "DevFlow agent assigned",
			content: result.content
		})
	}));
	ctx.tools.register(defineTool({
		name: "devflow_request_decision",
		description: "The only Commander tool for direction, scope, or risk decisions. Use it for ambiguity, approach divergence, scope creep, repeated review failure, and high-risk operations. Pass a \"question\", 3-5 concrete \"options\" ({ id, label, description }), and \"recommendedOption\" set to one of those ids. The user-custom (\"Custom\") option is appended by the server — do NOT add your own custom entry, and do not send more than 5 options.",
		parameters: {
			taskId: {
				type: "string",
				description: "Optional related task id."
			},
			trigger: {
				type: "string",
				required: true,
				enum: [...DECISION_TRIGGERS]
			},
			question: {
				type: "string",
				required: true,
				description: "Question shown to the user."
			},
			recommendedOption: {
				type: "string",
				required: true,
				description: "Id of the recommended option; MUST be one of the ids you pass in \"options\"."
			},
			options: {
				type: "json",
				required: true,
				description: "The 3-5 concrete options as an array of { id, label, description } (the product shape is exactly 3). A JSON-text array is accepted. The Custom option is appended automatically."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					requestId: {
						type: "string",
						required: true
					},
					answer: {
						type: "object",
						required: true,
						additionalProperties: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value.answer)
			}]
		},
		execute: async (rawArgs, exec) => {
			const { store: sessionStore } = bindSession(services, exec.agent);
			const project = await sessionStore.loadProject();
			if (project === void 0) throw new Error("devflow: no project initialized before requesting a decision");
			const args = parseDecisionRequestArgs(rawArgs);
			if (args.taskId !== void 0) {
				const blocking = blockedReportsForTask((await sessionStore.loadState()).blockedReports ?? {}, args.taskId);
				if (blocking.length > 0) {
					const newest = blocking[0];
					throw new Error(`devflow: task ${args.taskId} is blocked by a reported capability gap (${newest.gapKind}: ${newest.missing}); a decision popup would ask the user to choose a route this runtime cannot run — report the block instead of requesting a decision`);
				}
			}
			const now = (/* @__PURE__ */ new Date()).toISOString();
			const request = {
				requestId: randomUUID(),
				projectId: project.id,
				taskId: args.taskId ?? null,
				trigger: args.trigger,
				question: args.question,
				options: args.options.map((option) => ({ ...option })),
				allowCustom: true,
				status: "pending",
				answer: null,
				createdAt: now,
				answeredAt: null
			};
			await recordDevFlowChange(sessionStore, "devflow/decision/request", { request });
			const question = {
				id: request.requestId,
				question: request.question,
				options: request.options.filter((option) => option.id !== DECISION_CUSTOM_OPTION_ID).map((option) => ({
					label: `${option.label}${option.recommended ? " (Recommended)" : ""}`,
					description: option.description
				}))
			};
			const userQuestions = ctx.get("userQuestions");
			if (userQuestions === void 0) throw new Error("devflow: user questions service unavailable");
			const first = (await userQuestions.ask({
				questions: [question],
				...exec.agent === void 0 ? {} : { agent: exec.agent },
				signal: exec.signal
			})).answers[0];
			if (first === void 0) throw new Error("devflow: user decision returned no answer");
			const selected = first.selected[0];
			const optionId = request.options.find((option) => option.label === selected || `${option.label} (Recommended)` === selected)?.id;
			const answer = first.custom === void 0 ? { optionId: optionId ?? selected ?? "custom" } : { custom: first.custom };
			await recordDevFlowChange(sessionStore, "devflow/decision/answer", {
				requestId: request.requestId,
				answer,
				at: (/* @__PURE__ */ new Date()).toISOString()
			});
			return {
				requestId: request.requestId,
				answer
			};
		},
		presentCall: (args) => ({
			card: "generic",
			title: "Request DevFlow decision",
			kind: "other",
			rawInput: args
		}),
		presentResult: (_args, result) => ({
			card: "generic",
			title: "DevFlow decision answer",
			content: result.content
		})
	}));
	ctx.tools.register(defineTool({
		name: "devflow_pause",
		description: "Pause new DevFlow dispatches after the current work group completes. Running child agents are not interrupted.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { paused: {
					type: "boolean",
					required: true
				} }
			},
			render: () => [{
				type: "text",
				text: "DevFlow dispatches paused."
			}]
		},
		execute: async (_args, exec) => {
			const { store: sessionStore } = bindSession(services, exec.agent);
			await recordDevFlowChange(sessionStore, "devflow/control/pause", { at: (/* @__PURE__ */ new Date()).toISOString() });
			return { paused: true };
		},
		presentCall: () => ({
			card: "generic",
			title: "Pause DevFlow",
			kind: "other"
		}),
		presentResult: (_args, result) => ({
			card: "generic",
			title: "DevFlow paused",
			content: result.content
		})
	}));
	ctx.tools.register(defineTool({
		name: "devflow_resume_dispatch",
		description: "Resume new DevFlow dispatches after a pause.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { paused: {
					type: "boolean",
					required: true
				} }
			},
			render: () => [{
				type: "text",
				text: "DevFlow dispatches resumed."
			}]
		},
		execute: async (_args, exec) => {
			const { store: sessionStore } = bindSession(services, exec.agent);
			await recordDevFlowChange(sessionStore, "devflow/control/resume", { at: (/* @__PURE__ */ new Date()).toISOString() });
			return { paused: false };
		},
		presentCall: () => ({
			card: "generic",
			title: "Resume DevFlow",
			kind: "other"
		}),
		presentResult: (_args, result) => ({
			card: "generic",
			title: "DevFlow resumed",
			content: result.content
		})
	}));
	ctx.inject(["subagents"], (dispatchCtx) => {
		dispatchCtx.tools.register(defineTool({
			name: "devflow_dispatch_agent",
			description: DEVFLOW_DISPATCH_AGENT_DESCRIPTION,
			parameters: {
				agentId: {
					type: "string",
					required: true,
					description: "Registered orchestration agent id."
				},
				taskId: {
					type: "string",
					required: true,
					description: "Existing task id."
				},
				description: {
					type: "string",
					description: "Optional short child-run label."
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						taskId: {
							type: "string",
							required: true
						},
						agentId: {
							type: "string",
							required: true
						},
						summary: {
							type: "string",
							required: true
						},
						changes: {
							type: "array",
							required: true,
							items: { type: "string" }
						},
						verification: {
							type: "array",
							required: true,
							items: { type: "string" }
						},
						issues: {
							type: "array",
							required: true,
							items: { type: "string" }
						},
						nextSteps: {
							type: "array",
							required: true,
							items: { type: "string" }
						}
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: value.summary
				}]
			},
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
				const release = beginInFlightDispatch();
				try {
					const parent = exec.agent;
					if (parent === void 0) throw new Error("devflow: dispatch requires a calling commander agent");
					const { store, workflow, agentWorkflow } = bindSession(services, parent);
					const projection = await store.loadState();
					if (projection.paused === true) throw new Error("devflow: dispatch is paused; resume after the current work group");
					const child = await store.getAgent(args.agentId);
					if (child === void 0) throw new Error(`devflow: unknown orchestration agent ${args.agentId}`);
					const initialTask = await store.getTask(args.taskId);
					if (initialTask === void 0) throw new Error(`devflow: unknown task ${args.taskId}`);
					let task = initialTask;
					const dispatchId = String(exec.callId);
					const projectBefore = await store.loadProject();
					if (projectBefore === void 0) throw new Error("devflow: no project initialized before dispatch");
					const gate = evaluateDispatchGates(task, projection, projectBefore);
					const breaker = capabilityBreaker(blockedReportsForTask(projection.blockedReports ?? {}, task.id));
					if (breaker !== void 0) {
						appendDispatchDiagnostic(store, {
							dispatchId,
							taskId: task.id,
							agentId: args.agentId,
							projectId: projectBefore.id,
							taskStatus: task.status,
							projectionStatus: gate.projectionStatus,
							reviewFailCount: gate.reviewFailCount,
							decisionStatus: gate.decisionStatus,
							highRisk: gate.highRisk,
							status: "blocked",
							at: (/* @__PURE__ */ new Date()).toISOString()
						});
						throw new Error(`devflow: DEVFLOW_DISPATCH_CAPABILITY_BREAKER: ${breaker.reason}`);
					}
					appendDispatchDiagnostic(store, {
						dispatchId,
						taskId: task.id,
						agentId: args.agentId,
						projectId: projectBefore.id,
						taskStatus: task.status,
						projectionStatus: gate.projectionStatus,
						reviewFailCount: gate.reviewFailCount,
						decisionStatus: gate.decisionStatus,
						highRisk: gate.highRisk,
						status: gate.allowed ? "started" : "blocked",
						at: (/* @__PURE__ */ new Date()).toISOString()
					});
					if (!gate.allowed) throw new Error(`devflow: ${dispatchGateMessage(gate)}`);
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
						const bounds = await resolveTaskBounds(store, task);
						assertPackageScopeConsistency(task, bounds.scope);
						task = await prepareTaskForDispatch(workflow, store, task.id, (change, title) => recordDevFlowChange(store, "devflow/task/transition", {
							...change,
							title
						}).then(() => void 0));
						const assignment = (await store.listAssignments()).find((item) => item.taskId === task.id && item.agentId === child.agentId && item.status !== "completed");
						if (assignment === void 0) throw new Error(`devflow: no active assignment for task ${task.id} and agent ${child.agentId}`);
						const startedAssignment = await store.updateAssignmentStatus(assignment.assignmentId, "in_progress");
						await recordDevFlowChange(store, "devflow/orchestration/update", {
							assignmentId: startedAssignment.assignmentId,
							status: startedAssignment.status,
							at: startedAssignment.updatedAt
						});
						activeAssignmentId = startedAssignment.assignmentId;
						activeAssignment = startedAssignment;
						const prepared = await prepareTaskPackage(store, task.id, {
							role: child.role,
							instructions: bounds.instructions,
							acceptanceCriteria: [...bounds.acceptanceCriteria],
							...bounds.scopeGuard === void 0 ? {} : { scopeGuard: bounds.scopeGuard }
						}, (updated) => recordDevFlowChange(store, "devflow/project/update", { project: updated }).then(() => void 0));
						const project = prepared.project;
						const taskPackage = prepared.package;
						const scopeGuard = taskPackage.scopeGuard ?? bounds.scopeGuard;
						let plan = await store.createPlanning({
							projectId: project.id,
							goal: task.title,
							mvpPlanId: null
						});
						await recordDevFlowChange(store, "devflow/commander/plan/create", { plan });
						plan = await store.activatePlanning(plan.planningId);
						await recordDevFlowChange(store, "devflow/commander/plan/activate", {
							planningId: plan.planningId,
							at: plan.updatedAt
						});
						let batch = await store.createBatch({
							projectId: project.id,
							planningId: plan.planningId,
							phaseIds: [assignment.phaseId],
							assignmentIds: [assignment.assignmentId]
						});
						runtime.batch = batch;
						await recordDevFlowChange(store, "devflow/execution/batch/create", { batch });
						batch = await store.updateBatchStatus(batch.batchId, "running");
						runtime.batch = batch;
						await recordDevFlowChange(store, "devflow/execution/batch/start", {
							batchId: batch.batchId,
							at: batch.updatedAt
						});
						let execution = await store.createExecutionRecord({
							batchId: batch.batchId,
							assignmentId: assignment.assignmentId,
							agentId: child.agentId,
							taskId: task.id,
							...scopeGuard === void 0 ? {} : { scopeGuard }
						});
						runtime.execution = execution;
						execution = await store.updateExecutionStatus(execution.executionId, "running");
						runtime.execution = execution;
						await recordDevFlowChange(store, "devflow/execution/start", { execution });
						let attempt = await store.createAttempt({
							executionId: execution.executionId,
							parentAttemptId: null,
							reason: null
						});
						runtime.attempt = attempt;
						await recordDevFlowChange(store, "devflow/execution/attempt/create", { attempt });
						attempt = await store.updateAttemptStatus(attempt.attemptId, "running");
						runtime.attempt = attempt;
						await recordDevFlowChange(store, "devflow/execution/attempt/start", {
							attemptId: attempt.attemptId,
							at: attempt.updatedAt
						});
						const markdown = new MarkdownBridge().exportTask(taskPackage);
						await recordDevFlowChange(store, "devflow/bridge/export", {
							taskId: task.id,
							bridge: "markdown",
							at: (/* @__PURE__ */ new Date()).toISOString()
						});
						const persona = assembleAgentPrompt(child, await store.resolveAgentSkills(child));
						const availableTools = new Set(parent.ctx.tools.schemas(parent).map((entry) => entry.name));
						allowedTools = dispatchableToolNames(child.tools, availableTools);
						/** Start one child run and settle its result; the run is always disposed. */
						const startChild = async (promptText) => {
							const run = await dispatchCtx.subagents.start("spawn", {
								label: args.description ?? `DevFlow ${child.role} task`,
								prompt: [{
									type: "text",
									text: promptText
								}],
								parent,
								signal: exec.signal,
								persona,
								...allowedTools.length === 0 ? {} : { toolFilter: { allow: allowedTools } },
								maxDepth: delegationDepthOf(parent) + 1,
								agentOptions: {
									...child.modelConfig.provider === void 0 ? {} : { provider: child.modelConfig.provider },
									model: child.modelConfig.model
								}
							});
							try {
								return {
									id: String(run.id),
									result: await run.result
								};
							} finally {
								await run.dispose();
							}
						};
						let parsed;
						let lastRunId = "";
						let stopReason = "";
						while (parsed === void 0) {
							resultAttempts += 1;
							const attempt = await startChild(resultAttempts === 1 ? markdown : `${markdown}\n\n${retryInstruction(resultProblems)}`);
							lastRunId = attempt.id;
							stopReason = attempt.result.stopReason;
							if (attempt.result.stopReason !== "completed") {
								const code = `DEVFLOW_DISPATCH_${attempt.result.stopReason.toUpperCase().replace("-", "_")}`;
								throw new Error(`devflow: ${code}: ${dispatchFailureSummary(code)}`);
							}
							const output = attempt.result.output.filter((block) => block.type === "text").map((block) => block.text).join("");
							if (output.trim() === "") {
								resultProblems = ["the reply contained no result document"];
								if (resultAttempts < MAX_RESULT_ATTEMPTS && !exec.signal.aborted) continue;
								throw new Error("devflow: DEVFLOW_DISPATCH_EMPTY_OUTPUT: fixed Agent returned no result document");
							}
							try {
								parsed = new MarkdownBridge().importResult(output);
							} catch (cause) {
								if (!(cause instanceof ResultParseError)) throw cause;
								resultProblems = [...cause.problems];
								if (resultAttempts < MAX_RESULT_ATTEMPTS && !exec.signal.aborted) continue;
								throw new DispatchResultRejected(resultProblems, { cause });
							}
						}
						const runId = lastRunId;
						if (parsed.taskId !== task.id) throw new Error(`devflow: DEVFLOW_DISPATCH_TASK_MISMATCH: result targets another task`);
						let submission;
						try {
							submission = await agentWorkflow.submitResult(task.id, {
								summary: parsed.summary,
								changes: parsed.changes,
								verification: parsed.verification,
								issues: parsed.issues,
								nextSteps: parsed.nextSteps
							});
						} catch (cause) {
							throw new Error("devflow: DEVFLOW_DISPATCH_RESULT_IMPORT_FAILED: fixed Agent result could not be imported", { cause });
						}
						await recordDevFlowChange(store, "devflow/task/transition", {
							...submission.transition.change,
							title: submission.transition.task.title
						});
						await recordDevFlowChange(store, "devflow/bridge/import", {
							taskId: task.id,
							resultId: submission.result.id,
							protocolVersion: parsed.protocolVersion,
							verdict: parsed.verdict,
							at: submission.result.createdAt
						});
						appendDispatchDiagnostic(store, {
							dispatchId,
							taskId: task.id,
							agentId: child.agentId,
							projectId: project.id,
							taskStatus: submission.transition.task.status,
							projectionStatus: gate.projectionStatus,
							reviewFailCount: gate.reviewFailCount,
							decisionStatus: gate.decisionStatus,
							highRisk: gate.highRisk,
							assignmentId: activeAssignmentId,
							assignmentAgentId: assignment.agentId,
							assignmentPhaseId: assignment.phaseId,
							assignmentStatus: "in_progress",
							childDepth: delegationDepthOf(parent) + 1,
							maxDepth: delegationDepthOf(parent) + 1,
							provider: "spawn",
							model: child.modelConfig.model,
							toolFilter: allowedTools,
							runId,
							stopReason,
							attempts: resultAttempts,
							status: "completed",
							at: (/* @__PURE__ */ new Date()).toISOString()
						});
						if (runtime.attempt === void 0 || runtime.execution === void 0) throw new Error("devflow: direct dispatch runtime was not initialized");
						runtime.attempt = await store.updateAttemptStatus(runtime.attempt.attemptId, "completed");
						await recordDevFlowChange(store, "devflow/execution/attempt/complete", {
							attemptId: runtime.attempt.attemptId,
							at: runtime.attempt.updatedAt
						});
						runtime.execution = await store.updateExecutionStatus(runtime.execution.executionId, "completed");
						await recordDevFlowChange(store, "devflow/execution/complete", {
							executionId: runtime.execution.executionId,
							at: runtime.execution.updatedAt
						});
						const declared = declaredOutcome(parsed.summary);
						await recordDevFlowChange(store, "devflow/agent/report/create", { report: await store.createReport({
							executionId: runtime.execution.executionId,
							agentId: child.agentId,
							status: "success",
							summary: safeReportSummary(parsed.summary),
							outputReference: `devflow:result:${submission.result.id}`,
							...declared === void 0 ? {} : { outcome: declared.outcome }
						}) });
						if (declared?.outcome === "blocked") await recordDevFlowChange(store, "devflow/blocked/report", { blocked: blockedReportFrom({
							taskId: task.id,
							agentId: child.agentId,
							executionId: runtime.execution.executionId,
							detail: declared.detail
						}) });
						if (activeAssignmentId !== void 0) {
							const completedAssignment = await store.updateAssignmentStatus(activeAssignmentId, "completed");
							await recordDevFlowChange(store, "devflow/orchestration/update", {
								assignmentId: completedAssignment.assignmentId,
								status: completedAssignment.status,
								at: completedAssignment.updatedAt
							});
							activeAssignmentId = void 0;
						}
						await completeBatch(store, runtime);
						return {
							taskId: task.id,
							agentId: child.agentId,
							summary: parsed.summary,
							changes: [...parsed.changes],
							verification: [...parsed.verification],
							issues: [...parsed.issues],
							nextSteps: [...parsed.nextSteps]
						};
					} catch (cause) {
						if (activeAssignmentId !== void 0) try {
							const restoredAssignment = await store.updateAssignmentStatus(activeAssignmentId, "assigned");
							await recordDevFlowChange(store, "devflow/orchestration/update", {
								assignmentId: restoredAssignment.assignmentId,
								status: restoredAssignment.status,
								at: restoredAssignment.updatedAt
							});
						} catch {}
						const current = await store.getTask(task.id);
						const code = dispatchFailureCode(cause);
						const problems = cause instanceof DispatchResultRejected ? cause.problems : void 0;
						await failDirectDispatch(store, runtime, child.agentId, code, {
							...code === "DEVFLOW_DISPATCH_RESULT_REJECTED" ? { reportStatus: "blocked" } : {},
							...problems === void 0 ? {} : { problems }
						});
						appendDispatchDiagnostic(store, {
							dispatchId,
							taskId: task.id,
							agentId: child.agentId,
							projectId: projectBefore.id,
							taskStatus: current?.status ?? task.status,
							projectionStatus: gate.projectionStatus,
							reviewFailCount: gate.reviewFailCount,
							decisionStatus: gate.decisionStatus,
							highRisk: gate.highRisk,
							...activeAssignmentId === void 0 || activeAssignment === void 0 ? {} : {
								assignmentId: activeAssignmentId,
								assignmentAgentId: activeAssignment.agentId,
								assignmentPhaseId: activeAssignment.phaseId,
								assignmentStatus: "assigned"
							},
							provider: "spawn",
							model: child.modelConfig.model,
							toolFilter: allowedTools,
							errorCode: code,
							errorMessage: summaryWithProblems(code, problems),
							attempts: resultAttempts,
							status: "failed",
							at: (/* @__PURE__ */ new Date()).toISOString()
						});
						if (current?.status === "executing") {
							const failed = await workflow.failTask(task.id);
							await recordDevFlowChange(store, "devflow/task/transition", {
								...failed.change,
								title: failed.task.title
							});
						}
						throw cause;
					}
				} finally {
					release();
				}
			},
			presentCall: (args) => ({
				card: "generic",
				title: "Dispatch DevFlow agent",
				kind: "other",
				rawInput: args
			}),
			presentResult: (_args, result) => ({
				card: "generic",
				title: "DevFlow agent result",
				content: result.content
			})
		}));
	});
	ctx.tools.register(defineTool({
		name: "devflow_agent_upsert",
		description: "Register or update a TEMPORARY employee of the DevFlow team, and return it. Only the Commander may call this: the caller must currently hold the Commander seat, and every other caller (or a call with no caller at all) is refused. The employee becomes dispatchable immediately: it enters the orchestration roster (so devflow_assign_agent accepts its id) and it can spawn no children of its own. The fixed employees (commander, backend-engineer, frontend-engineer, architect, code-auditor) already exist after project init and cannot be redefined here — to assign work to one of them use devflow_assign_agent with the fixed employee id.",
		parameters: {
			id: {
				type: "string",
				required: true,
				description: "Stable lowercase slug id, e.g. executor-main."
			},
			role: {
				type: "string",
				required: true,
				enum: ASSIGNED_ROLES,
				description: "The role this instance plays."
			},
			displayName: {
				type: "string",
				required: true,
				description: "Display name (Chinese allowed)."
			},
			description: {
				type: "string",
				description: "One-paragraph responsibility description."
			},
			capabilities: {
				type: "array",
				items: { type: "string" },
				description: "Capability tags."
			},
			metadata: {
				type: "object",
				additionalProperties: true,
				description: "Free-form extension fields."
			},
			tools: {
				type: "array",
				items: { type: "string" },
				description: "Tool names this temporary employee may use. OMIT IT for a read-only employee (research / collection): the default is read, glob, grep, read_image. Declaring write / edit / pwsh is REQUIRED for an employee that must write files or run commands, and the declaration is recorded in the agent journal. Names this runtime cannot grant are trimmed, never silently kept."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: {
						type: "string",
						required: true
					},
					role: {
						type: "string",
						required: true,
						enum: ASSIGNED_ROLES
					},
					displayName: {
						type: "string",
						required: true
					},
					description: { type: "string" },
					capabilities: {
						type: "array",
						items: { type: "string" }
					},
					metadata: {
						type: "object",
						additionalProperties: true
					},
					tools: {
						type: "array",
						required: true,
						items: { type: "string" }
					},
					createdAt: {
						type: "string",
						required: true
					},
					updatedAt: {
						type: "string",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `Temporary employee ${value.id} (${value.role}) registered as ${value.displayName}; it is now assignable and dispatchable, with tools: ${value.tools.join(", ")}.`
			}]
		},
		execute: async (args, exec) => {
			const { store: sessionStore } = bindSession(services, exec.agent);
			authorizeAgentRegistration(isCommander, exec.agent);
			if (args.tools !== void 0 && !isToolNameArray(args.tools)) throw new Error("devflow: tools must be an array of tool names (strings); omit it entirely for a read-only employee");
			const existing = await sessionStore.getAgentInstance(args.id);
			const patch = {
				role: args.role,
				displayName: args.displayName,
				...args.description === void 0 ? {} : { description: args.description },
				...args.capabilities === void 0 ? {} : { capabilities: args.capabilities },
				...args.metadata === void 0 ? {} : { metadata: args.metadata }
			};
			const instance = existing === void 0 ? await sessionStore.createAgentInstance({
				id: args.id,
				...patch
			}) : await sessionStore.updateAgentInstance(args.id, patch);
			await recordDevFlowChange(sessionStore, "devflow/agent/upsert", { instance });
			const registered = await registerDispatchableEmployee(sessionStore, instance, exec.agent, isCommander, args.tools);
			const { capabilities, metadata, ...rest } = instance;
			return {
				...rest,
				...capabilities === void 0 ? {} : { capabilities: [...capabilities] },
				tools: [...registered.tools],
				...metadata === void 0 ? {} : { metadata }
			};
		},
		presentCall: (args) => ({
			card: "generic",
			title: "Upsert DevFlow agent",
			kind: "other",
			rawInput: args
		}),
		presentResult: (_args, result) => ({
			card: "generic",
			title: "DevFlow agent saved",
			content: result.content
		})
	}));
}
//#endregion
//#region lib/host/display.js
/**
* DevFlow display layer: Chinese-facing role presentation. Machine
* identifiers (role ids, agent ids, protocol fields, storage keys, event
* types) stay English forever; this module is the only place that maps them
* to display names and icons for CLI/Web/Canvas.
* @module @xiaoxie-ide/dsh-devflow/display
*/
/** Built-in role presentations. */
const ROLE_DISPLAY = {
	planner: {
		displayName: "总指挥",
		icon: "🧠"
	},
	"backend-engineer": {
		displayName: "后端代码工程师",
		icon: "💻"
	},
	"frontend-engineer": {
		displayName: "前端 UI 工程师",
		icon: "🎨"
	},
	reviewer: {
		displayName: "代码审计员",
		icon: "🔍"
	}
};
/**
* Per-employee display names, keyed by agent id.
*
* Role is not enough to name an employee: the architect sits on the `planner`
* role (the assigned-role enum has no `architect`), so a role lookup would call
* it 总指挥 — the same name as the commander — both in the panel and on the
* canvas. A fixed employee without an entry here falls back to its agent id,
* which is the honest display for a machine identifier.
*/
const FIXED_AGENT_DISPLAY_NAMES = {
	commander: "总指挥",
	"backend-engineer": "代码工程师",
	"frontend-engineer": "前端工程师",
	architect: "架构师",
	"code-auditor": "审计工程师"
};
/**
* Resolve one orchestration agent's display name.
* @param agentId - the machine agent id.
* @returns the Chinese display name, or the id itself when unmapped.
*/
function fixedAgentDisplayName(agentId) {
	return FIXED_AGENT_DISPLAY_NAMES[agentId] ?? agentId;
}
/**
* Render one role's display line, e.g. `🧠 产品规划师`.
* @param role - the machine role id.
* @returns the display line.
*/
function displayRole(role) {
	const display = ROLE_DISPLAY[role];
	return `${display.icon} ${display.displayName}`;
}
//#endregion
//#region lib/host/activation-reason.js
/**
* The one reason vocabulary for a refused DevFlow preset activation.
*
* Two surfaces read the same refusal and must never disagree about it:
*
*  - the **durable audit record** (`devflow/preset/activation-failed`) proves
*    *that* it happened, and survives a Host restart;
*  - the **human surfaces** (`/devflow commander status`, the panel) must say
*    *why* without a debugger, so each code carries one fixed Chinese sentence
*    and one bounded English one.
*
* Both live here rather than beside either reader, because a second copy of
* this table is exactly how "what the log says" and "what the operator is told"
* drift apart. The Chinese sentence is the product-facing text the PM asked
* for; the English one is what the DTO carries to a non-Chinese locale.
* @module @xiaoxie-ide/dsh-devflow/activation-reason
*/
/**
* Fixed Chinese explanation per refusal code.
*
* These are the strings `/devflow commander status` prints and the panel shows,
* so each one must name the *actionable* fact (what to check) rather than
* restate the code in prose. A mapped value must never be empty: the reason
* table is the last place a real cause can survive, and an empty sentence would
* silently reintroduce the fixed-blank-message problem this module exists to
* remove.
*/
const ACTIVATION_CODE_REASONS_ZH = {
	"devflow-preset-identity-mismatch": "请求的 preset 与当前会话实际组合的 preset 不一致。",
	"devflow-session-mismatch": "会话记录的 preset 与运行中的 Agent 不一致。",
	"devflow-project-unavailable": "此会话读不到共享的 DevFlow 项目。",
	"devflow-project-init-failed": "DevFlow 项目无法为此会话初始化。",
	"devflow-commander-install-failed": "DevFlow 总指挥无法装入此会话。",
	"devflow-activation-verification-failed": "DevFlow 激活未通过实时校验（工具集尚未结算，或工具集不符）。",
	"devflow-commander-not-installed": "此会话尚未装入 DevFlow 总指挥。",
	"devflow-deactivation-failed": "DevFlow 总指挥无法从此会话移除。",
	"devflow-restore-failed": "DevFlow 总指挥无法恢复到此会话。",
	"devflow-journal-failed": "DevFlow 激活记录写入失败。",
	"devflow-host-unavailable": "DevFlow 宿主服务不可用。"
};
/** One fixed phrase per refused act, so the operator learns what was attempted. */
const ACTIVATION_PHASE_REASONS_ZH = {
	initial: "首次激活",
	recompose: "切换 preset",
	deactivate: "撤销激活",
	restore: "回滚恢复",
	journal: "留痕写入"
};
Object.keys(ACTIVATION_CODE_REASONS_ZH);
/**
* The fixed Chinese reason for one refusal code.
*
* An unknown code can only arrive from a newer build's journal replayed by an
* older one; it degrades to the code itself rather than to an empty sentence,
* so the reader still sees which refusal it was.
* @param code - the refusal code to explain.
* @returns one non-empty Chinese sentence.
*/
function activationReasonZh(code) {
	return ACTIVATION_CODE_REASONS_ZH[code] ?? `激活被拒绝（未识别的代码：${code}）。`;
}
//#endregion
//#region lib/host/commands.js
/**
* DevFlow human commands: `/devflow init|status|tasks|roles|show|agents|
* export|import|resume`, a direct command-plane entry that never routes
* through a model turn. The command child activates only when a command
* registry is composed.
* @module @xiaoxie-ide/dsh-devflow/commands
*/
/** Services the commands delegate to. */
/** Render one agent instance's display block: Chinese name, English ids. */
function renderInstance(id, role, displayName) {
	return `${displayRole(role)} (${displayName})\nid: ${id}\nrole: ${role}`;
}
const DEVFLOW_INPUT = {
	hint: "init <name> | commander enter|exit|status | decision-answer <id> <json> | agent-config <id> <json> | pause | resume-dispatch | status | tasks | roles | show <taskId> | agents | export <taskId> | import <taskId> | resume <taskId>",
	bareBehavior: "execute"
};
const DEVFLOW_USAGE = `Usage: /devflow ${DEVFLOW_INPUT.hint}`;
/**
* Render current-session activation state and its single next step.
*
* The refusal line is the whole point of this read: when an activation was
* refused, the code alone says nothing an operator can act on, so the fixed
* Chinese reason and the attempt count are printed beside it. A refusal that
* happened on the first try and one that survived the whole settle budget read
* identically otherwise, and they call for different responses.
*/
function renderCommanderStatus(agent, commanderMode, report) {
	const state = commanderMode.current(agent);
	const next = state.mode === "commander" ? "Send your request as a normal message in this conversation." : "Run /devflow commander enter in this conversation, then send your request as a normal message.";
	const activationLines = report === void 0 ? [] : [`Preset: ${report.presetId ?? "(none)"}`, `Activation: ${report.activation}${report.activationError === null ? "" : ` (${report.activationError.code})`}${report.verifiedAt === null ? "" : ` · verified ${report.verifiedAt}`}`];
	const failureLines = report?.lastFailure == null ? [] : [`Last activation failure: ${report.lastFailure.code} · ${ACTIVATION_PHASE_REASONS_ZH[report.lastFailure.phase]} · 第 ${report.lastFailure.attempts} 次尝试 · ${report.lastFailure.at}`, `原因：${report.lastFailure.reason}`];
	return [
		"DevFlow is loaded.",
		`Current session: ${agent.session.id}`,
		`Mode: ${state.mode}`,
		`Project: ${state.projectId ?? "(none)"}`,
		...activationLines,
		...failureLines,
		next,
		"This release currently dispatches fixed Agents only.",
		"Commander bindings are in memory; enter again after a Host restart."
	].join("\n");
}
/**
* Register the `/devflow` command family on `ctx.commands`.
* @param ctx - registrant context; the command registers only when a command
*   registry is composed.
* @param services - the store, workflow, and optional Commander controller the commands delegate to.
*/
function registerDevFlowCommands(ctx, services) {
	const { store, sessionStores, agentWorkflow, getCommanderMode, readPresetActivation } = services;
	/**
	* The store of the session that is running this command.
	*
	* A single-store composition cannot isolate and says so by omitting
	* `sessionStores`; every real host resolves the command's own workspace, so
	* a command typed in project B reads only project B.
	*/
	const storeFor = (agent) => sessionStores === void 0 ? store : sessionStores.resolve(agent).store;
	/**
	* The workspace directory of the session running this command.
	*
	* A new project is NAMED after it, so the name and the store root come from
	* one resolution and cannot disagree. A single-store composition (no
	* `sessionStores`) has no session workspace and answers with the empty string,
	* which the derivation turns into the empty string rather than a made-up name.
	*/
	const workspaceFor = (agent) => {
		if (sessionStores === void 0) return "";
		return sessionStores.resolve(agent).workspacePath ?? "";
	};
	/**
	* The agent workflow of the session running this command.
	*
	* A store's workflow wrappers are per-store: export/import/resume must run
	* against the SESSION's own project, so a session on another workspace gets
	* its own pair rather than the mixed library's.
	*/
	const commandWorkflows = /* @__PURE__ */ new Map();
	const workflowFor = (agent) => {
		const sessionStore = storeFor(agent);
		if (sessionStore === store) return agentWorkflow;
		let sessionWorkflow = commandWorkflows.get(sessionStore);
		if (sessionWorkflow === void 0) {
			sessionWorkflow = new AgentWorkflow(sessionStore, new TaskWorkflow(sessionStore));
			commandWorkflows.set(sessionStore, sessionWorkflow);
		}
		return sessionWorkflow;
	};
	/** Append shared project and Agent registry facts to the plugin-owned journal. */
	async function hydrateProjectJournal(project, sessionStore) {
		await recordDevFlowChange(sessionStore, "devflow/project/update", { project });
		for (const registered of await sessionStore.listAgents()) await recordDevFlowChange(sessionStore, "devflow/agent/register", { agent: registered });
	}
	/**
	* Create a project and register the fixed employees that belong to it.
	*
	* A project created WITHOUT an explicit operator name is named after the
	* session workspace it lives in, through the same derivation the preset
	* activation path uses — one function, so the two creation paths can never
	* disagree. `/devflow init <name>` is the explicit case: the operator typed
	* that name, so it is used verbatim.
	* @param sessionStore - the calling session's store.
	* @param workspace - the calling session's workspace directory.
	* @param explicitName - the operator-supplied name, when there was one.
	* @param explicitGoal - the operator-supplied goal, when there was one.
	* @returns the created project.
	*/
	async function ensureProject(sessionStore, workspace, explicitName, explicitGoal) {
		const derived = deriveNewProjectIdentity(workspace);
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const project = {
			id: randomUUID(),
			name: explicitName ?? derived.name,
			goal: explicitGoal ?? derived.goal,
			currentStage: "",
			createdAt: now,
			updatedAt: now
		};
		await sessionStore.saveProject(project);
		await recordDevFlowChange(sessionStore, "devflow/project/update", { project });
		await syncFixedRoster(sessionStore);
		return project;
	}
	/**
	* Make the stored fixed-employee roster agree with the shipped configuration.
	*
	* An existing project was initialized by an older revision, so its roster is
	* what the canvas renders and what assignment/dispatch validate against: a
	* fixed employee added or corrected in code afterwards would otherwise stay
	* invisible and undispatchable in production. Only the changed records are
	* journalled, so an unchanged roster writes nothing.
	*/
	async function syncFixedRoster(sessionStore) {
		await recordFixedRosterChanges(sessionStore);
	}
	ctx.inject(["commands"], (commandCtx) => {
		commandCtx.commands.register({
			name: "devflow",
			description: "DevFlow project, task, and agent management",
			input: DEVFLOW_INPUT,
			handler: async ({ agent, rawInput }) => {
				const [verb, ...rest] = rawInput.trim().split(/\s+/);
				const sessionStore = storeFor(agent);
				const commanderMode = getCommanderMode();
				if (verb === "") {
					if (commanderMode === void 0) return {
						kind: "error",
						text: "devflow: commander mode requires a full Harness host"
					};
					return {
						kind: "success",
						text: `${renderCommanderStatus(agent, commanderMode, await readPresetActivation?.(agent))}\n${DEVFLOW_USAGE}`
					};
				}
				switch (verb) {
					case "init": {
						const existing = await sessionStore.loadProject();
						if (existing !== void 0) return {
							kind: "success",
							text: `Project already initialized (${existing.id}). Use /devflow commander enter to start.`
						};
						const input = rest.join(" ").trim();
						if (input === "") return {
							kind: "error",
							text: "Usage: /devflow init <name> — a project name is required to initialize DevFlow."
						};
						const [name = "", ...goalParts] = input.split(/\s+/);
						if (name === "") return {
							kind: "error",
							text: "Usage: /devflow init <name> — a project name is required to initialize DevFlow."
						};
						const goal = goalParts.join(" ").trim();
						const project = await ensureProject(sessionStore, workspaceFor(agent), name, goal);
						return {
							kind: "success",
							text: `Project ${JSON.stringify(project.name)} created (${project.id}) with its fixed agents.`
						};
					}
					case "commander": {
						const action = rest[0];
						if (commanderMode === void 0) return {
							kind: "error",
							text: "devflow: commander mode requires a full Harness host"
						};
						if (action === "enter") {
							const existingProject = await sessionStore.loadProject();
							const project = existingProject ?? await ensureProject(sessionStore, workspaceFor(agent));
							if (existingProject !== void 0) await hydrateProjectJournal(project, sessionStore);
							await syncFixedRoster(sessionStore);
							const state = commanderMode.enter(agent, project.id);
							await recordDevFlowChange(sessionStore, "devflow/commander/mode-enter", {
								projectId: state.projectId,
								sessionId: agent.session.id,
								at: state.changedAt
							});
							return {
								kind: "success",
								text: `${existingProject === void 0 ? `项目 ${JSON.stringify(project.name)} 已初始化（按会话工作区派生）。\n` : ""}Commander entered for this session: ${agent.session.id}\nProject: ${state.projectId}\nSend your request as a normal message in this conversation.\nThis release currently dispatches fixed Agents only.\nEnter Commander again after a Host restart.`
							};
						}
						if (action === "exit") {
							await recordDevFlowChange(sessionStore, "devflow/commander/mode-exit", {
								at: commanderMode.exit(agent).changedAt,
								sessionId: agent.session.id
							});
							return {
								kind: "success",
								text: `Commander exited for this session: ${agent.session.id}\nHarness native Chat behavior is restored for normal messages.`
							};
						}
						if (action === "status") return {
							kind: "success",
							text: renderCommanderStatus(agent, commanderMode, await readPresetActivation?.(agent))
						};
						if (action === "say") {
							if (rest.slice(1).join(" ").trim() === "") return {
								kind: "error",
								text: "/devflow commander say is no longer a command; send the message as normal Chat input."
							};
							return {
								kind: "error",
								text: "Commander requests are normal Chat input; send the message as normal Chat input without /devflow commander say."
							};
						}
						return {
							kind: "error",
							text: "Usage: /devflow commander enter | exit | status"
						};
					}
					case "decision-answer": {
						const requestId = (rest[0] ?? "").trim();
						const rawAnswer = rest.slice(1).join(" ").trim();
						if (requestId === "" || rawAnswer === "") return {
							kind: "error",
							text: "/devflow decision-answer needs a request id and answer."
						};
						let answer;
						try {
							const parsed = JSON.parse(rawAnswer);
							if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("object required");
							if ("optionId" in parsed && typeof parsed.optionId === "string") answer = { optionId: parsed.optionId };
							else if ("custom" in parsed && typeof parsed.custom === "string") answer = { custom: parsed.custom };
							else throw new Error("optionId or custom required");
						} catch {
							return {
								kind: "error",
								text: "/devflow decision-answer received invalid JSON."
							};
						}
						await recordDevFlowChange(sessionStore, "devflow/decision/answer", {
							requestId,
							answer,
							at: (/* @__PURE__ */ new Date()).toISOString()
						});
						return {
							kind: "success",
							text: `Decision ${requestId} answered.`
						};
					}
					case "agent-config": {
						const agentId = (rest[0] ?? "").trim();
						const rawPatch = rest.slice(1).join(" ").trim();
						if (agentId === "" || rawPatch === "") return {
							kind: "error",
							text: "/devflow agent-config needs an agent id and JSON patch."
						};
						let patch;
						try {
							patch = JSON.parse(rawPatch);
						} catch {
							return {
								kind: "error",
								text: "/devflow agent-config received invalid JSON."
							};
						}
						if (typeof patch !== "object" || patch === null || Array.isArray(patch)) return {
							kind: "error",
							text: "/devflow agent-config needs a JSON object."
						};
						const updated = await sessionStore.updateAgentConfig(agentId, patch);
						await recordDevFlowChange(sessionStore, "devflow/agent/update-config", {
							agentId,
							patch: { modelConfig: updated.modelConfig },
							at: updated.updatedAt
						});
						return {
							kind: "success",
							text: `Agent ${agentId} model configuration updated.`
						};
					}
					case "pause":
						await recordDevFlowChange(sessionStore, "devflow/control/pause", { at: (/* @__PURE__ */ new Date()).toISOString() });
						return {
							kind: "success",
							text: "DevFlow dispatches pause after the current work group."
						};
					case "resume-dispatch":
						await recordDevFlowChange(sessionStore, "devflow/control/resume", { at: (/* @__PURE__ */ new Date()).toISOString() });
						return {
							kind: "success",
							text: "DevFlow dispatches resumed."
						};
					case "status": {
						const project = await sessionStore.loadProject();
						if (project === void 0) return {
							kind: "success",
							text: "No project initialized."
						};
						return {
							kind: "success",
							text: `项目 ${project.name} (${project.id}) ｜ 工作区 ${sessionStore.rootPath}\n阶段：${project.currentStage || "(none)"} ｜ 目标：${project.goal || "(none)"}`
						};
					}
					case "tasks": {
						const tasks = await sessionStore.listTasks();
						if (tasks.length === 0) return {
							kind: "success",
							text: `项目 ${sessionStore.rootPath}（本会话工作区）：No tasks.`
						};
						const lines = tasks.map((task) => `${task.id}  ${task.status.padEnd(9)}  ${task.title}`);
						return {
							kind: "success",
							text: `项目 ${sessionStore.rootPath}（本会话工作区）Tasks (${tasks.length}):\n${lines.join("\n")}`
						};
					}
					case "roles": return {
						kind: "success",
						text: Object.values(BUILTIN_AGENT_ROLES).map((role) => `${role.roleId} — ${role.name}: ${role.capabilities.join(", ")}`).join("\n")
					};
					case "show": {
						const taskId = (rest[0] ?? "").trim();
						if (taskId === "") return {
							kind: "error",
							text: "/devflow show needs a task id."
						};
						const task = await sessionStore.getTask(taskId);
						if (task === void 0) return {
							kind: "error",
							text: `Unknown task ${taskId}.`
						};
						return {
							kind: "success",
							text: JSON.stringify(task, null, 2)
						};
					}
					case "agents": {
						const instances = await sessionStore.listAgentInstances();
						if (instances.length === 0) return {
							kind: "success",
							text: `No agent instances. Built-in roles: ${Object.values(ROLE_DISPLAY).map((display) => `${display.icon} ${display.displayName}`).join(" / ")}`
						};
						return {
							kind: "success",
							text: instances.map((instance) => renderInstance(instance.id, instance.role, instance.displayName)).join("\n\n")
						};
					}
					case "export": {
						const taskId = (rest[0] ?? "").trim();
						if (taskId === "") return {
							kind: "error",
							text: "/devflow export needs a task id."
						};
						const { markdown } = await workflowFor(agent).exportTask(taskId);
						await recordDevFlowChange(sessionStore, "devflow/bridge/export", {
							taskId,
							bridge: "markdown",
							at: (/* @__PURE__ */ new Date()).toISOString()
						});
						return {
							kind: "success",
							text: markdown
						};
					}
					case "import": {
						const taskId = (rest[0] ?? "").trim();
						if (taskId === "") return {
							kind: "error",
							text: "/devflow import needs a task id."
						};
						const markdown = await sessionStore.readImportMarkdown(taskId);
						if (markdown === void 0) return {
							kind: "success",
							text: `No result document yet. Place the Executor's result at ${sessionStore.rootPath}/imports/${taskId}.md, then run /devflow import ${taskId} again.`
						};
						const submission = await workflowFor(agent).importResult(taskId, markdown);
						await recordDevFlowChange(sessionStore, "devflow/task/transition", {
							...submission.transition.change,
							title: submission.transition.task.title
						});
						await recordDevFlowChange(sessionStore, "devflow/bridge/import", {
							taskId,
							resultId: submission.result.id,
							protocolVersion: submission.protocolVersion,
							verdict: submission.verdict,
							at: submission.result.createdAt
						});
						return {
							kind: "success",
							text: `Imported result ${submission.result.id} for task ${taskId}; task is now ${submission.transition.task.status}.`
						};
					}
					case "resume": {
						const taskId = (rest[0] ?? "").trim();
						if (taskId === "") return {
							kind: "error",
							text: "/devflow resume needs a task id."
						};
						const { resume } = await workflowFor(agent).resumeTask(taskId);
						await recordDevFlowChange(sessionStore, "devflow/planner/resume", {
							taskId,
							at: (/* @__PURE__ */ new Date()).toISOString()
						});
						return {
							kind: "success",
							text: resume
						};
					}
					default: return {
						kind: "error",
						text: `Unknown /devflow verb. ${DEVFLOW_USAGE}`
					};
				}
			}
		});
	});
}
//#endregion
//#region lib/host/commander-mode.js
/** Current-session Commander persona lifecycle for DevFlow developer mode. */
const COMMANDER_TOOL_NAMES = [
	"ask_user_question",
	"devflow_project_status",
	"devflow_create_task",
	"devflow_transition_task",
	"devflow_submit_result",
	"devflow_create_task_package",
	"devflow_export_task",
	"devflow_import_result",
	"devflow_resume",
	"devflow_create_phase",
	"devflow_update_phase",
	"devflow_set_scope",
	"devflow_clear_scope",
	"devflow_assign_agent",
	"devflow_request_decision",
	"devflow_pause",
	"devflow_resume_dispatch",
	"devflow_dispatch_agent",
	"devflow_agent_upsert",
	"read",
	"glob",
	"grep"
];
/**
* Installs the Commander persona into the current session Agent's scoped
* system prompt. It creates neither an Agent nor a Session: normal user input
* remains in the same native conversation while DevFlow state stays in the
* plugin-owned `.devflow` store.
*/
var CommanderMode = class {
	persona;
	active = /* @__PURE__ */ new Map();
	constructor(persona) {
		this.persona = persona;
	}
	/** Enter Commander mode for the current session Agent. */
	enter(agent, projectId) {
		if (projectId.trim() === "") throw new Error("devflow: commander mode needs a non-empty projectId");
		const current = this.active.get(agent.id);
		if (current?.projectId === projectId) return {
			mode: "commander",
			sessionId: agent.id,
			projectId,
			changedAt: current.changedAt
		};
		this.exit(agent);
		const changedAt = (/* @__PURE__ */ new Date()).toISOString();
		const disposePresentation = agent.ctx.tools.presentAs("native");
		try {
			const available = new Set(agent.ctx.tools.schemas(agent).map((tool) => tool.name));
			const disposeTools = agent.ctx.tools.restrict({ allow: COMMANDER_TOOL_NAMES.filter((name) => available.has(name)) });
			try {
				const disposePersona = agent.ctx.systemPrompt.section({
					name: "devflow-commander-persona",
					order: 1,
					text: this.persona
				});
				this.active.set(agent.id, {
					projectId,
					disposePersona,
					disposeTools,
					disposePresentation,
					changedAt
				});
			} catch (error) {
				disposeTools();
				throw error;
			}
		} catch (error) {
			disposePresentation();
			throw error;
		}
		return {
			mode: "commander",
			sessionId: agent.id,
			projectId,
			changedAt
		};
	}
	/** Remove the Commander persona from the current session Agent. */
	exit(agent) {
		const active = this.active.get(agent.id);
		if (active !== void 0) {
			this.active.delete(agent.id);
			try {
				active.disposePersona();
			} finally {
				try {
					active.disposeTools();
				} finally {
					active.disposePresentation();
				}
			}
		}
		return {
			mode: "chat",
			sessionId: null,
			projectId: null,
			changedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
	}
	/** Read one session Agent's mode state. */
	current(agent) {
		const active = this.active.get(agent.id);
		return active === void 0 ? {
			mode: "chat",
			sessionId: null,
			projectId: null,
			changedAt: ""
		} : {
			mode: "commander",
			sessionId: agent.id,
			projectId: active.projectId,
			changedAt: active.changedAt
		};
	}
	/**
	* Verify that one Agent's Commander installation is live and complete.
	*
	* Map presence alone is not proof: the entry records that persona, tools,
	* and presentation disposers were installed, but only a live scope read can
	* confirm the tool restriction still hides native tools. Cold-restart and
	* recompose verification therefore checks both the entry and the visible
	* schema set before anything may be reported `bound`.
	* @param agent - the session Agent to verify.
	* @param projectId - when given, the entry must be bound to this project.
	*/
	verify(agent, projectId) {
		const active = this.active.get(agent.id);
		if (active === void 0) return {
			ok: false,
			failureCode: "devflow-mode-not-installed"
		};
		if (projectId !== void 0 && active.projectId !== projectId) return {
			ok: false,
			failureCode: "devflow-project-mismatch"
		};
		const visible = new Set(agent.ctx.tools.schemas(agent).map((tool) => tool.name));
		const allowed = new Set(COMMANDER_TOOL_NAMES);
		for (const name of visible) if (!allowed.has(name)) return {
			ok: false,
			failureCode: "devflow-tool-restriction-missing"
		};
		return { ok: true };
	}
};
//#endregion
//#region lib/host/preset-activation.js
/**
* DevFlow agent-plane preset activation adapter.
*
* This module implements the consumer side of the Harness generic preset
* activation Hook for the `devflow` preset. The composition row provides an
* isolated `agentPresetActivation` service (the provider), and `AgentPresets`
* calls `activate()` inside the pre-publication mount/recompose window. The
* adapter never creates a second loader, service, Remote, or state source: it
* drives the single host {@link DevflowController} (Commander mode + the one
* `.devflow` store) that the deployment already composed.
*
* Activation only succeeds after, in order: the preset identity is `devflow`
* both by request and by the live composed scope; the shared project exists
* (single-flight initialization reuses the store's own concurrency-safe
* journaling); Commander is entered for this exact Agent; the installation is
* verified live (not merely recorded); and an audit-only journal record is
* appended. Any failure throws a stable activationCode so the Hook blocks
* publication or selection commit — never a silent native fallback.
*
* The returned lease reverses exactly that state: `deactivate()` exits
* Commander and restores the native persona/presentation, `restore()` re-enters
* this lease's project after a blank-session switch is rolled back. Both are
* idempotent and never leak raw exceptions.
* @module @xiaoxie-ide/dsh-devflow/preset-activation
*/
/** The one preset id this adapter will activate. */
const DEVFLOW_PRESET_ID = "devflow";
/** Whether a value can read one Session projection key. */
function isAgentPresetProjectionReader(value) {
	return typeof value === "object" && value !== null && typeof value.stateOf === "function";
}
/** Stable activationCodes this adapter may surface; never raw provider text. */
const DEVFLOW_ACTIVATION_CODES = {
	presetIdentityMismatch: "devflow-preset-identity-mismatch",
	sessionMismatch: "devflow-session-mismatch",
	projectUnavailable: "devflow-project-unavailable",
	projectInitFailed: "devflow-project-init-failed",
	commanderInstallFailed: "devflow-commander-install-failed",
	verificationFailed: "devflow-activation-verification-failed",
	commanderNotInstalled: "devflow-commander-not-installed",
	deactivationFailed: "devflow-deactivation-failed",
	restoreFailed: "devflow-restore-failed",
	journalFailed: "devflow-journal-failed",
	hostUnavailable: "devflow-host-unavailable"
};
/**
* Fixed bounded English messages; session/preset/project ids are not free text.
*
* This is the ENGLISH half of the reason vocabulary: it is what the wire and
* the DTO carry as `activationError.message`, while
* {@link ACTIVATION_CODE_REASONS_ZH} holds the Chinese sentence the human
* surfaces print. Both tables are complete over the same code union, and the
* reason-table test in `tests/preset-activation.spec.ts` asserts that.
*/
const CODE_MESSAGES = {
	"devflow-preset-identity-mismatch": "DevFlow preset identity does not match this session.",
	"devflow-session-mismatch": "DevFlow session identity does not match the live Agent.",
	"devflow-project-unavailable": "DevFlow project is unavailable for this session.",
	"devflow-project-init-failed": "DevFlow project could not be initialized for this session.",
	"devflow-commander-install-failed": "DevFlow Commander could not be installed for this session.",
	"devflow-activation-verification-failed": "DevFlow activation could not be verified for this session.",
	"devflow-commander-not-installed": "DevFlow Commander is not installed for this session.",
	"devflow-deactivation-failed": "DevFlow Commander could not be removed for this session.",
	"devflow-restore-failed": "DevFlow Commander could not be restored for this session.",
	"devflow-journal-failed": "DevFlow activation record could not be written.",
	"devflow-host-unavailable": "DevFlow host is unavailable for this session."
};
/** Lazily resolve the Harness Hook's fault constructor when module identity allows. */
let harnessFaultConstructor;
/**
* Produce a stable activationCode-carrying fault for the Harness Hook.
*
* When the running agent-presets copy exposes its `AgentPresetActivationFault`
* (the Hook-enabled build sharing this process), the thrown value is an
* instance of it so the Hook preserves the DevFlow code in its bounded
* details. When that class is absent (a stale published snapshot, or a
* separate module copy), a structurally equivalent fault with the same
* `activationCode` is thrown; the Hook still fails the activation closed with
* its generic code, and DevFlow's own reporting surface keeps the stable code.
*
* The fault class itself is the Harness's shape, so it carries the code and
* nothing else; this module's own durable record is where phase, attempt count,
* and the operator-facing reason live.
* @param code - the stable refusal code.
* @param options - optional `cause` chain kept for in-process debugging.
* @returns the fault to throw.
*/
async function activationFault(code, options) {
	if (harnessFaultConstructor === void 0) try {
		const candidate = (await import("@deepseek-ai/dsh-agent-presets")).AgentPresetActivationFault;
		harnessFaultConstructor = typeof candidate === "function" ? candidate : null;
	} catch {
		harnessFaultConstructor = null;
	}
	if (harnessFaultConstructor !== null) return new harnessFaultConstructor(code);
	const error = new Error("agent preset activation rejected", options);
	Object.defineProperty(error, "activationCode", {
		value: code,
		enumerable: true
	});
	return error;
}
/**
* The refusal code carried by a thrown activation failure.
*
* Deliberately structural rather than `instanceof`: the fault class is loaded
* through an async dynamic import (see {@link activationFault}), so an adapter
* that reads it must not add a second, independent identity dependency. A
* non-refusal error (a real bug on our side) answers `undefined` and is
* reported under its own fallback code by the caller.
* @param error - any thrown value.
* @returns the stable code, or undefined when this is not an activation fault.
*/
function activationFaultCode(error) {
	const value = error?.activationCode;
	return typeof value === "string" && value in ACTIVATION_CODE_REASONS_ZH ? value : void 0;
}
/** Preset lifecycle journal categories appended by the adapter. */
const ACTIVATED_JOURNAL = "devflow/preset/activated";
const DEACTIVATED_JOURNAL = "devflow/preset/deactivated";
const FAILED_JOURNAL = "devflow/preset/activation-failed";
/** Per-store single-flight guard so concurrent activations share one project. */
const projectInitializations = /* @__PURE__ */ new WeakMap();
/**
* Last refusal per store, mirrored so a failed journal append cannot erase it.
*
* The journal is the authority a restart reads; this mirror only covers the
* window where the append itself failed. It is deliberately keyed by store so
* a second deployment in one process never inherits another's refusal.
*/
const lastFailures = /* @__PURE__ */ new WeakMap();
/**
* Normalize the constructor's store argument.
*
* A `DevFlowSessionStores` isolates per calling session; a plain `DevFlowStore`
* is a single-store composition (tests and programmatic mounts) that says so by
* passing the store itself.
* @param source - either the session scope resolver or one fixed store.
* @returns a function returning the store for one Agent.
*/
function scopeResolverOf(source) {
	return typeof source.resolve === "function" ? (agent) => source.resolve(agent).store : () => source;
}
/**
* Normalize the constructor's workspace argument for the same two shapes.
*
* A single-store composition has no session workspace at all, so it answers with
* a value that is honestly unusable as a name — and `deriveProjectNameFromWorkspace`
* turns that into the workspace verbatim rather than inventing a label. Such a
* composition is a test or programmatic mount, never the shipped host, where the
* resolver has already refused a workspace-less session outright.
* @param source - either the session scope resolver or one fixed store.
* @returns a function returning the workspace for one Agent.
*/
function workspaceResolverOf(source) {
	if (typeof source.resolve !== "function") return () => "";
	return (agent) => {
		return source.resolve(agent).workspacePath ?? "";
	};
}
/**
* The DevFlow preset activation adapter bound to one host controller instance.
*
* One instance is constructed per host {@link DevflowController}; every preset
* composition row asks the controller for a provider via
* {@link createProvider}. The provider is a plain value with no service
* registration of its own, so no second host service or state source exists.
*
* Since 第九步 the adapter reaches state through the CALLING SESSION's own
* store: activating project B registers employees and journals into
* `<B>/.devflow` and never into project A's, so one project's Commander can
* never inherit another project's roster or memory.
*/
var DevFlowPresetActivation = class {
	commanderMode;
	options;
	/** One alias kept for composition rows and commands. */
	presetId = DEVFLOW_PRESET_ID;
	/** Resolve the store of the session being activated. */
	storeFor;
	/** Resolve the workspace directory of the session being activated. */
	workspaceFor;
	constructor(source, commanderMode, options = {}) {
		this.commanderMode = commanderMode;
		this.options = options;
		this.storeFor = scopeResolverOf(source);
		this.workspaceFor = workspaceResolverOf(source);
	}
	/** A provider value for the isolated `agentPresetActivation` composition row. */
	createProvider() {
		return { activate: (input) => this.activate(input) };
	}
	/**
	* Turn one refusal into the fault the Harness Hook classifies.
	*
	* Centralised so every refusal site reports the SAME shape: a fault carrying
	* `activationCode` (see {@link activationFault}). A plain Error would be
	* indistinguishable in-process but would lose the code at the Hook boundary,
	* where only a fault is recognised.
	* @param code - the stable refusal code.
	* @param options - optional `cause` chain kept for in-process debugging.
	* @returns a rejection carrying that code.
	*/
	async refuse(code, options) {
		throw await activationFault(code, options);
	}
	/**
	* Append one refusal to the durable journal and mirror it for this session.
	*
	* Never throws: this runs while an activation is already failing, and a
	* second failure raised from the reporting path would replace the real cause
	* with a bookkeeping error. When the append fails the mirror keeps the
	* refusal readable until the next Host restart replays the (absent) record.
	* @param agent - the Agent whose session was refused.
	* @param code - the stable refusal code.
	* @param phase - the act that was refused.
	* @param attempts - activation runs consumed before the refusal settled.
	*/
	async recordFailure(agent, code, phase, attempts) {
		const sessionId = String(agent.id);
		const at = this.options.now?.() ?? (/* @__PURE__ */ new Date()).toISOString();
		const failure = {
			code,
			phase,
			attempts,
			reason: activationReasonZh(code),
			at
		};
		const store = this.storeFor(agent);
		const mirrored = lastFailures.get(store) ?? /* @__PURE__ */ new Map();
		lastFailures.set(store, mirrored);
		mirrored.set(sessionId, failure);
		try {
			await recordDevFlowChange(store, FAILED_JOURNAL, {
				sessionId,
				activationCode: code,
				phase,
				attempts,
				reason: failure.reason,
				at
			});
		} catch {}
	}
	/**
	* Read the last refusal this session recorded, newest record first.
	*
	* The journal is append-only, so the newest *usable* matching entry is the
	* current answer. Only that session's records are considered: a refusal
	* belongs to the session that suffered it, and a shared read model would let
	* one bad session explain another.
	* @param sessionId - the session whose refusal is wanted.
	* @returns the durable refusal, or the mirror when no usable record exists.
	*/
	async readFailure(agent, sessionId) {
		const store = this.storeFor(agent);
		const mirrored = lastFailures.get(store)?.get(sessionId) ?? null;
		try {
			const entries = await store.listJournal();
			for (let index = entries.length - 1; index >= 0; index -= 1) {
				const entry = entries[index];
				if (entry === void 0 || entry.type !== FAILED_JOURNAL) continue;
				const data = entry.data;
				if (typeof data.sessionId !== "string" || data.sessionId !== sessionId) continue;
				const decoded = readFailureRecord(entry.data, entry.at);
				if (decoded !== null) return decoded;
			}
		} catch {}
		return mirrored;
	}
	/**
	* Activate one Agent onto the shared DevFlow project, in the Harness
	* pre-publication window. Throws a stable activationCode on any failure.
	*
	* Every refusal is recorded to the durable journal before it is thrown, so
	* the reason survives both the Host boundary (which cannot carry it for an
	* initial activation) and a Host restart (which an in-memory field cannot).
	*/
	async activate(input) {
		const { agent, preset } = input;
		const phase = input.kind === "recompose" ? "recompose" : "initial";
		const attempts = input.attempts ?? 1;
		const refuse = async (code, options) => {
			await this.recordFailure(agent, code, phase, attempts);
			return await this.refuse(code, options);
		};
		if (preset.id !== "devflow") return await refuse(DEVFLOW_ACTIVATION_CODES.presetIdentityMismatch);
		if (this.composedPresetOf(agent) !== "devflow") return await refuse(DEVFLOW_ACTIVATION_CODES.presetIdentityMismatch);
		const existing = await this.readProject(agent);
		if (existing !== void 0) {
			const current = this.commanderMode.current(agent);
			if (current.mode === "commander" && current.projectId === existing.id && this.commanderMode.verify(agent, existing.id).ok) return this.lease(agent, existing.id);
		}
		let project;
		try {
			project = await this.ensureProject(agent);
		} catch (cause) {
			return await refuse(activationFaultCode(cause) ?? DEVFLOW_ACTIVATION_CODES.projectInitFailed, { cause });
		}
		try {
			this.commanderMode.enter(agent, project.id);
		} catch (cause) {
			return await refuse(DEVFLOW_ACTIVATION_CODES.commanderInstallFailed, { cause });
		}
		if (!this.commanderMode.verify(agent, project.id).ok) {
			try {
				this.commanderMode.exit(agent);
			} catch {}
			return await refuse(DEVFLOW_ACTIVATION_CODES.verificationFailed);
		}
		await this.journalActivated(agent, project.id);
		return this.lease(agent, project.id);
	}
	/**
	* Verify one session's activation posture. `bound` is a conjunction; any
	* failed conjunct is `error` (or `unbound` after an explicit exit), and a
	* journal record alone can never produce `bound`.
	*
	* The recorded refusal rides along on every outcome, including a healthy one:
	* a session that failed and then succeeded is exactly the case where an
	* operator needs both facts, and hiding the earlier refusal once the session
	* recovers would re-create the blind spot this report exists to close.
	* @param agent - the live Agent whose session is being reported.
	*/
	async report(agent) {
		const sessionId = String(agent.id);
		const lastFailure = await this.readFailure(agent, sessionId);
		const composed = this.composedPresetOf(agent);
		const durable = this.durablePresetOf(agent);
		if (composed !== "devflow") return {
			presetId: composed ?? null,
			commanderMode: this.commanderMode.current(agent).mode,
			projectId: null,
			activation: "unbound",
			activationError: null,
			verifiedAt: null,
			lastFailure
		};
		if (durable !== "devflow") return this.errorReport(DEVFLOW_ACTIVATION_CODES.sessionMismatch, agent, lastFailure);
		const project = await this.readProject(agent);
		if (project === void 0) return this.errorReport(DEVFLOW_ACTIVATION_CODES.projectUnavailable, agent, lastFailure);
		const current = this.commanderMode.current(agent);
		if (current.mode === "commander" && current.projectId === project.id && this.commanderMode.verify(agent, project.id).ok) return {
			presetId: DEVFLOW_PRESET_ID,
			commanderMode: "commander",
			projectId: project.id,
			activation: "bound",
			activationError: null,
			verifiedAt: this.options.now?.() ?? (/* @__PURE__ */ new Date()).toISOString(),
			lastFailure
		};
		if (await this.sessionExplicitlyExited(agent, sessionId)) return {
			presetId: DEVFLOW_PRESET_ID,
			commanderMode: "chat",
			projectId: project.id,
			activation: "unbound",
			activationError: null,
			verifiedAt: null,
			lastFailure
		};
		return this.errorReport(current.mode === "commander" ? DEVFLOW_ACTIVATION_CODES.verificationFailed : DEVFLOW_ACTIVATION_CODES.commanderNotInstalled, agent, lastFailure);
	}
	/** True when this session's latest lifecycle journal record is an exit. */
	async sessionExplicitlyExited(agent, sessionId) {
		const entries = await this.storeFor(agent).listJournal();
		for (let index = entries.length - 1; index >= 0; index -= 1) {
			const entry = entries[index];
			if (entry === void 0) continue;
			const data = entry.data;
			if (typeof data.sessionId !== "string" || data.sessionId !== sessionId) continue;
			if (entry.type === DEACTIVATED_JOURNAL || entry.type === "devflow/commander/mode-exit") return true;
			if (entry.type === ACTIVATED_JOURNAL || entry.type === "devflow/commander/mode-enter") return false;
		}
		return false;
	}
	errorReport(conjunctCode, agent, lastFailure) {
		const code = lastFailure?.code ?? conjunctCode;
		return {
			presetId: DEVFLOW_PRESET_ID,
			commanderMode: this.commanderMode.current(agent).mode,
			projectId: null,
			activation: "error",
			activationError: {
				code,
				message: CODE_MESSAGES[code]
			},
			verifiedAt: null,
			lastFailure
		};
	}
	composedPresetOf(agent) {
		return this.options.composedPreset?.(agent);
	}
	durablePresetOf(agent) {
		if (this.options.durablePreset !== void 0) return this.options.durablePreset(agent);
		const reader = agent.ctx.get("sessionProjections");
		if (!isAgentPresetProjectionReader(reader)) return void 0;
		return reader.stateOf(agent.session, "agentPreset") ?? void 0;
	}
	async readProject(agent) {
		return await this.storeFor(agent).loadProject();
	}
	/**
	* Read or single-flight create THIS SESSION'S project.
	*
	* The single-flight key is the session's STORE, so two sessions activating
	* concurrently inside one workspace still share one initialization, while two
	* projects initialize independently of each other.
	*/
	async ensureProject(agent) {
		const store = this.storeFor(agent);
		const inFlight = projectInitializations.get(store);
		if (inFlight !== void 0) return inFlight;
		const attempt = this.ensureProjectNow(agent, store).finally(() => {
			projectInitializations.delete(store);
		});
		projectInitializations.set(store, attempt);
		return attempt;
	}
	async ensureProjectNow(agent, store) {
		const existing = await store.loadProject();
		if (existing !== void 0) {
			try {
				await recordFixedRosterChanges(store);
			} catch (cause) {
				throw await activationFault(DEVFLOW_ACTIVATION_CODES.projectInitFailed, { cause });
			}
			return existing;
		}
		const now = this.options.now?.() ?? (/* @__PURE__ */ new Date()).toISOString();
		const identity = deriveNewProjectIdentity(this.workspaceFor(agent));
		const project = {
			id: randomUUID(),
			name: identity.name,
			goal: identity.goal,
			currentStage: "",
			createdAt: now,
			updatedAt: now
		};
		try {
			await store.saveProject(project);
			await recordDevFlowChange(store, "devflow/project/update", { project });
			await recordFixedRosterChanges(store);
		} catch (cause) {
			throw await activationFault(DEVFLOW_ACTIVATION_CODES.projectInitFailed, { cause });
		}
		return await store.loadProject() ?? project;
	}
	async journalActivated(agent, projectId) {
		try {
			await recordDevFlowChange(this.storeFor(agent), ACTIVATED_JOURNAL, {
				sessionId: String(agent.id),
				projectId,
				presetId: DEVFLOW_PRESET_ID,
				at: this.options.now?.() ?? (/* @__PURE__ */ new Date()).toISOString()
			});
		} catch (cause) {
			throw await activationFault(DEVFLOW_ACTIVATION_CODES.journalFailed, { cause });
		}
	}
	async journalDeactivated(agent, projectId) {
		await recordDevFlowChange(this.storeFor(agent), DEACTIVATED_JOURNAL, {
			sessionId: String(agent.id),
			projectId,
			presetId: DEVFLOW_PRESET_ID,
			at: this.options.now?.() ?? (/* @__PURE__ */ new Date()).toISOString()
		});
	}
	/**
	* One Agent-private lease: reversal of exactly this activation.
	*
	* A reversal that fails is reported as a fault rather than a bare error for
	* the same reason the forward path is: the Harness Hook is the reader, and it
	* classifies a fault's own code. `restore()` deliberately does NOT append a
	* refusal record: it runs inside the Hook's own rollback, where a second
	* journal write could fail for the same reason the rollback is running, and
	* the rollback outcome is already reported as recovery-required.
	*/
	lease(agent, projectId) {
		return {
			deactivate: async () => {
				try {
					this.commanderMode.exit(agent);
				} catch (cause) {
					throw await activationFault(DEVFLOW_ACTIVATION_CODES.deactivationFailed, { cause });
				}
				await this.journalDeactivated(agent, projectId).catch(() => void 0);
			},
			restore: async () => {
				if (this.commanderMode.verify(agent, projectId).ok) return;
				try {
					this.commanderMode.enter(agent, projectId);
					if (!this.commanderMode.verify(agent, projectId).ok) throw await activationFault(DEVFLOW_ACTIVATION_CODES.verificationFailed);
				} catch (cause) {
					if (activationFaultCode(cause) !== void 0) throw cause;
					throw await activationFault(DEVFLOW_ACTIVATION_CODES.restoreFailed, { cause });
				}
				await this.journalActivated(agent, projectId).catch(() => void 0);
			}
		};
	}
};
/**
* How many times one published activation re-runs after a live-verification
* failure, and the wait between runs.
*
* The wait only has to cover the harness's own asynchronous removal of an
* Agent-owned registration (a fiber disposal), never a state the deployment
* could not reach, so the budget stays small and the failure path unchanged.
*/
const SETTLE_ATTEMPTS = 4;
const SETTLE_WAIT_MS = 40;
/** Whether a failure is the activation's own live-verification refusal. */
function isVerificationFailure(error) {
	return activationFaultCode(error) === DEVFLOW_ACTIVATION_CODES.verificationFailed;
}
/**
* Run one activation, re-running it while a composition switch is still
* settling.
*
* Leaving a preset does not remove the tools that preset registered into each
* Agent's OWN scope: a preset row that samples a per-Agent tool definition
* (`tool-subagent` does) owns an Agent-scope registration, and
* `tools.restrict()` never filters a scope's own registrations — it masks only
* what the scope inherits. That owner removes its registration when the
* harness publishes `tools/change`, which a recompose emits after the swap and
* this activation's own install publishes too, so for one turn the outgoing
* preset's Agent-owned tool is still visible to `verify()`. A session created
* under `standard` and switched to DevFlow was therefore refused with
* `devflow-activation-verification-failed`, intermittently, depending on
* whether that registration had landed before the switch.
*
* The retry decides nothing: every run re-enters Commander and re-runs the
* unchanged live verification, and the last refusal is what surfaces — a
* genuinely wrong tool set still fails with the same code after the bounded
* number of runs.
*
* Each run is told which attempt it is, so the durable refusal record can
* separate "refused on the first try" from "still refused after the whole
* settle budget". Those two read identically from the outside otherwise, and
* they call for opposite responses: a first-try refusal is a real
* configuration fault, while an exhausted budget points at the settling window
* this wrapper exists to absorb.
* @param provider - the activation provider the preset plane publishes.
* @param input - the activation input the Harness Hook supplied.
* @returns the lease of the first run whose live verification passed.
* @throws the last failure, unchanged, when every run is refused.
*/
async function activateWithSettle(provider, input) {
	let lastError;
	for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt += 1) try {
		return await provider.activate({
			...input,
			attempts: attempt + 1
		});
	} catch (error) {
		if (!isVerificationFailure(error)) throw error;
		lastError = error;
		await new Promise((resolve) => {
			setTimeout(resolve, SETTLE_WAIT_MS);
		});
	}
	throw lastError;
}
/**
* Decode one journal record into a bounded refusal.
*
* The journal is on disk and therefore untrusted input: a hand-edited or
* partially written entry must not be able to inject free text into the
* operator-facing reason, so the code is re-derived from the fixed table and a
* code outside it is refused outright (the caller then falls back to the
* in-memory mirror). Only the code, phase, attempt count, and timestamp are
* carried across; the reason is always this build's sentence for that code.
* @param data - the record's `data` payload.
* @param at - the record's own publication time, used when the payload has none.
* @returns the decoded refusal, or null when the payload is not usable.
*/
function readFailureRecord(data, at) {
	if (typeof data !== "object" || data === null) return null;
	const record = data;
	const code = typeof record.activationCode === "string" ? activationFaultCode({ activationCode: record.activationCode }) : void 0;
	if (code === void 0) return null;
	const phase = typeof record.phase === "string" && record.phase in ACTIVATION_PHASE_REASONS_ZH ? record.phase : "initial";
	const attempts = typeof record.attempts === "number" && Number.isSafeInteger(record.attempts) && record.attempts > 0 ? record.attempts : 1;
	const time = typeof record.at === "string" && record.at !== "" ? record.at : at;
	return {
		code,
		phase,
		attempts,
		reason: activationReasonZh(code),
		at: time
	};
}
({
	name: "devflow-preset-activation",
	apply(ctx, config) {
		const controller = ctx.get("devflow");
		const provider = typeof controller?.createActivationProvider === "function" ? controller.createActivationProvider() : void 0;
		if (provider === void 0) throw new Error("devflow: preset activation requires the DevFlow host controller (devflow service)");
		const published = { activate: (input) => activateWithSettle(provider, input) };
		ctx.effect(() => ctx.reflect.provide("agentPresetActivation", published));
	}
}).name;
const AUDIT_UNAVAILABLE = {
	code: "audit-unavailable",
	message: "DevFlow audit is unavailable. Refresh to try again."
};
const CURSOR_INVALID = {
	code: "cursor-invalid",
	message: "DevFlow audit history changed. Refresh to try again."
};
const REDACTED_TEXT$1 = "Sensitive content is hidden.";
const LEGACY_TEXT = "Unknown / legacy record";
const SENSITIVE_TEXT$1 = /(?:\b(?:prompt|system[\s_-]*prompt|credential|token|cookie|authorization|api[\s_-]*key|secret|password|raw\s*(?:tool\s*)?(?:input|output)|tool\s*(?:input|output)|stack\s*trace|outputReference|modifiedFiles)\b|(?:[A-Za-z]:\\|\\\\|\/Users\/|\/home\/|\/tmp\/|\/var\/tmp\/|\/private\/var\/)|(?:Bearer\s+\S+))/i;
const MAX_CURSOR_LENGTH = 2048;
const MAX_ID_LENGTH = 128;
/** A private, per-service cursor signer prevents clients changing page meaning. */
var DevFlowAuditPager = class {
	secret = randomBytes(32);
	storeFor;
	/**
	* @param source - the session's store, or a supplier resolving it per call.
	*   The supplier form is what keeps the audit page inside the CALLING
	*   session's project: one audit panel must not page through another
	*   project's journal.
	*/
	constructor(source) {
		this.storeFor = typeof source === "function" ? source : () => source;
	}
	async page(query = {}) {
		try {
			const store = this.storeFor();
			const project = await store.loadProject();
			const cursor = query.cursor === void 0 ? void 0 : this.decodeCursor(query.cursor);
			if (query.cursor !== void 0 && cursor === void 0) return {
				kind: "error",
				error: CURSOR_INVALID
			};
			const normalized = normalizeQuery(query, cursor);
			if (normalized === void 0) return {
				kind: "error",
				error: CURSOR_INVALID
			};
			if (cursor !== void 0 && cursor.projectId !== (project?.id ?? null)) return {
				kind: "error",
				error: CURSOR_INVALID
			};
			const scan = await store.readCommittedJournalSequencePage(cursor?.head, cursor?.next, 200);
			return {
				kind: "page",
				page: this.buildPage(project?.id ?? null, normalized, scan.entries, scan.capturedHeadSequence, scan.nextExclusiveSequence)
			};
		} catch {
			return {
				kind: "error",
				error: AUDIT_UNAVAILABLE
			};
		}
	}
	buildPage(projectId, query, entries, capturedHeadSequence, scanNext) {
		const items = [];
		let omittedUnsafeCount = 0;
		let truncated = false;
		let nextSequence = scanNext;
		let stoppedEarly = false;
		for (const entry of entries) {
			const item = toSafeAuditItem(entry);
			if (item === void 0) {
				omittedUnsafeCount++;
				continue;
			}
			if (!inRange(item.at, query) || !matchesFilter(item, query.filter)) continue;
			if (items.length === 20) {
				nextSequence = entry.sequence + 1;
				stoppedEarly = true;
				break;
			}
			if (serializedBytes({
				items: [...items, item],
				nextCursor: "x".repeat(MAX_CURSOR_LENGTH)
			}) > 49152) {
				truncated = true;
				nextSequence = entry.sequence + 1;
				stoppedEarly = true;
				break;
			}
			items.push(item);
			nextSequence = entry.sequence;
		}
		const cursor = (stoppedEarly || scanNext !== null) && nextSequence !== null && nextSequence > 0 ? this.encodeCursor({
			v: 1,
			projectId,
			filter: query.filter,
			from: query.from,
			to: query.to,
			head: capturedHeadSequence,
			next: nextSequence
		}) : null;
		const page = {
			version: 1,
			source: "devflow-journal",
			projectId,
			range: {
				from: query.from,
				to: query.to
			},
			items,
			nextCursor: cursor,
			capturedHeadSequence,
			omittedUnsafeCount,
			truncated
		};
		if (serializedBytes(page) > 49152) throw new Error("audit page exceeds response budget");
		return page;
	}
	encodeCursor(payload) {
		const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
		return `${encoded}.${createHmac("sha256", this.secret).update(encoded).digest("base64url")}`;
	}
	decodeCursor(value) {
		if (typeof value !== "string" || value.length === 0 || value.length > MAX_CURSOR_LENGTH) return void 0;
		const [encoded, signature, extra] = value.split(".");
		if (encoded === void 0 || signature === void 0 || extra !== void 0) return void 0;
		const expected = createHmac("sha256", this.secret).update(encoded).digest("base64url");
		const received = Buffer.from(signature);
		const expectedBytes = Buffer.from(expected);
		if (received.length !== expectedBytes.length || !timingSafeEqual(received, expectedBytes)) return void 0;
		try {
			const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
			return isCursorPayload(value) ? value : void 0;
		} catch {
			return;
		}
	}
};
/** Converts only explicit, reviewed journal payload fields into the browser DTO. */
function toSafeAuditItem(entry) {
	if (!validId(entry.id) || !Number.isSafeInteger(entry.sequence) || entry.sequence < 0 || !validTime(entry.at)) return void 0;
	const data = record(entry.data);
	if (data === void 0) return void 0;
	const known = (category, action, entityType, entityId, related, status = null, summary = null, incomplete = false) => ({
		id: entry.id,
		sequence: entry.sequence,
		category,
		action,
		at: entry.at,
		entity: {
			type: entityType,
			id: entityId,
			display: entityId === null ? safeText(LEGACY_TEXT) : null
		},
		related,
		status,
		summary: summary === null ? null : safeText(summary),
		incomplete
	});
	const id = (key) => stringField$1(data, key);
	const status = (key, allowed) => enumField(data, key, allowed);
	switch (entry.type) {
		case "devflow/project/update": {
			const project = record(data.project);
			const projectId = project === void 0 ? void 0 : stringField$1(project, "id");
			return known("project", "updated", projectId === void 0 ? "unknown" : "project", projectId ?? null, projectId === void 0 ? {} : { projectId }, null, null, projectId === void 0);
		}
		case "devflow/task/transition": {
			const taskId = id("taskId");
			const to = status("to", [
				"created",
				"planned",
				"executing",
				"reviewing",
				"completed",
				"failed",
				"cancelled"
			]);
			return known("task", "transitioned", taskId === void 0 ? "unknown" : "task", taskId ?? null, taskId === void 0 ? {} : { taskId }, to, stringField$1(data, "title") ?? null, taskId === void 0);
		}
		case "devflow/phase/create": {
			const phase = record(data.phase);
			const phaseId = phase === void 0 ? void 0 : stringField$1(phase, "id");
			return known("phase", "created", phaseId === void 0 ? "unknown" : "phase", phaseId ?? null, phaseId === void 0 ? {} : { phaseId }, phase === void 0 ? null : enumField(phase, "status", [
				"planned",
				"in_progress",
				"completed"
			]), null, phaseId === void 0);
		}
		case "devflow/phase/update": {
			const phaseId = id("phaseId");
			return known("phase", "updated", phaseId === void 0 ? "unknown" : "phase", phaseId ?? null, phaseId === void 0 ? {} : { phaseId }, status("status", [
				"planned",
				"in_progress",
				"completed"
			]), null, phaseId === void 0);
		}
		case "devflow/agent/register": {
			const agent = record(data.agent);
			const agentId = agent === void 0 ? void 0 : stringField$1(agent, "agentId");
			return known("agent", "created", agentId === void 0 ? "unknown" : "agent", agentId ?? null, agentId === void 0 ? {} : { agentId }, agent === void 0 ? null : enumField(agent, "status", [
				"active",
				"created",
				"running",
				"terminated"
			]), null, agentId === void 0);
		}
		case "devflow/agent/remove": {
			const agentId = id("agentId");
			return known("agent", "removed", agentId === void 0 ? "unknown" : "agent", agentId ?? null, agentId === void 0 ? {} : { agentId }, null, null, agentId === void 0);
		}
		case "devflow/agent/transition": {
			const agentId = id("agentId");
			return known("agent", "transitioned", agentId === void 0 ? "unknown" : "agent", agentId ?? null, agentId === void 0 ? {} : { agentId }, status("to", [
				"created",
				"running",
				"terminated"
			]), null, agentId === void 0);
		}
		case "devflow/orchestration/assign": return assignmentItem(known, record(data.assignment), "assigned");
		case "devflow/orchestration/unassign": {
			const assignmentId = id("assignmentId");
			return known("assignment", "unassigned", assignmentId === void 0 ? "unknown" : "assignment", assignmentId ?? null, assignmentId === void 0 ? {} : { assignmentId }, null, null, assignmentId === void 0);
		}
		case "devflow/orchestration/update": {
			const assignmentId = id("assignmentId");
			return known("assignment", "updated", assignmentId === void 0 ? "unknown" : "assignment", assignmentId ?? null, assignmentId === void 0 ? {} : { assignmentId }, status("status", [
				"assigned",
				"in_progress",
				"completed",
				"closed"
			]), null, assignmentId === void 0);
		}
		case "devflow/orchestration/close": {
			const assignmentId = id("assignmentId");
			return known("assignment", "closed", assignmentId === void 0 ? "unknown" : "assignment", assignmentId ?? null, assignmentId === void 0 ? {} : { assignmentId }, "closed", null, assignmentId === void 0);
		}
		case "devflow/execution/start": return executionItem(known, record(data.execution), "started");
		case "devflow/execution/update":
		case "devflow/execution/complete":
		case "devflow/execution/fail":
		case "devflow/execution/close": {
			const executionId = id("executionId");
			return known("execution", entry.type.endsWith("/complete") ? "completed" : entry.type.endsWith("/fail") ? "failed" : entry.type.endsWith("/close") ? "closed" : "updated", executionId === void 0 ? "unknown" : "execution", executionId ?? null, executionId === void 0 ? {} : { executionId }, status("status", [
				"pending",
				"running",
				"completed",
				"failed",
				"closed"
			]), null, executionId === void 0);
		}
		case "devflow/execution/attempt/create": return attemptItem(known, record(data.attempt), "created");
		case "devflow/execution/attempt/start":
		case "devflow/execution/attempt/complete":
		case "devflow/execution/attempt/fail": {
			const attemptId = id("attemptId");
			return known("attempt", entry.type.endsWith("/start") ? "started" : entry.type.endsWith("/complete") ? "completed" : "failed", attemptId === void 0 ? "unknown" : "attempt", attemptId ?? null, attemptId === void 0 ? {} : { attemptId }, null, null, attemptId === void 0);
		}
		case "devflow/agent/report/create": return reportItem(known, record(data.report), "created");
		case "devflow/agent/report/update": {
			const reportId = id("reportId");
			return known("report", "updated", reportId === void 0 ? "unknown" : "report", reportId ?? null, reportId === void 0 ? {} : { reportId }, null, null, reportId === void 0);
		}
		case "devflow/decision/request": {
			const request = record(data.request);
			const requestId = request === void 0 ? void 0 : stringField$1(request, "requestId");
			const taskId = request === void 0 ? void 0 : nullableStringField(request, "taskId");
			return known("decision", "requested", requestId === void 0 ? "unknown" : "decision-request", requestId ?? null, {
				...requestId === void 0 ? {} : { requestId },
				...taskId === void 0 || taskId === null ? {} : { taskId }
			}, request === void 0 ? null : enumField(request, "status", [
				"pending",
				"answered",
				"dismissed"
			]), request === void 0 ? null : stringField$1(request, "question") ?? null, requestId === void 0);
		}
		case "devflow/decision/answer": {
			const requestId = id("requestId");
			return known("decision", "answered", requestId === void 0 ? "unknown" : "decision-request", requestId ?? null, requestId === void 0 ? {} : { requestId }, "answered", null, requestId === void 0);
		}
		case "devflow/commander/decision/create": {
			const decision = record(data.decision);
			const decisionId = decision === void 0 ? void 0 : stringField$1(decision, "decisionId");
			return known("decision", "created", decisionId === void 0 ? "unknown" : "decision", decisionId ?? null, decisionId === void 0 ? {} : { decisionId }, decision === void 0 ? null : enumField(decision, "decisionType", [
				"continue",
				"retry",
				"pause",
				"request_user"
			]), decision === void 0 ? null : stringField$1(decision, "summary") ?? null, decisionId === void 0);
		}
		case "devflow/commander/decision/update": {
			const decisionId = id("decisionId");
			return known("decision", "updated", decisionId === void 0 ? "unknown" : "decision", decisionId ?? null, decisionId === void 0 ? {} : { decisionId }, null, null, decisionId === void 0);
		}
		case "devflow/control/pause": return known("control", "paused", "project", null, {}, "paused");
		case "devflow/control/resume": return known("control", "resumed", "project", null, {}, "live");
		case "devflow/scope/boundary-hit": {
			const hit = record(data.hit);
			const taskId = hit === void 0 ? void 0 : stringField$1(hit, "taskId");
			return known("scope", "boundary-hit", taskId === void 0 ? "unknown" : "task", taskId ?? null, taskId === void 0 ? {} : { taskId }, hit === void 0 ? null : enumField(hit, "boundary", [
				"modified_files",
				"tool_steps",
				"completion_criteria"
			]), null, taskId === void 0);
		}
		case "devflow/bridge/export": {
			const taskId = id("taskId");
			return known("bridge-review", "exported", taskId === void 0 ? "unknown" : "task", taskId ?? null, taskId === void 0 ? {} : { taskId }, null, null, taskId === void 0);
		}
		case "devflow/bridge/import": {
			const taskId = id("taskId");
			const resultId = id("resultId");
			return known("bridge-review", "imported", taskId === void 0 ? "unknown" : "task", taskId ?? null, {
				...taskId === void 0 ? {} : { taskId },
				...resultId === void 0 ? {} : { reportId: resultId }
			}, status("verdict", [
				"accepted",
				"changes-requested",
				"rejected"
			]), null, taskId === void 0);
		}
		case "devflow/commander/review/create": {
			const review = record(data.review);
			const reviewId = review === void 0 ? void 0 : stringField$1(review, "reviewId");
			const executionId = review === void 0 ? void 0 : stringField$1(review, "executionId");
			return known("bridge-review", "created", reviewId === void 0 ? "unknown" : "review", reviewId ?? null, {
				...reviewId === void 0 ? {} : { reportId: reviewId },
				...executionId === void 0 ? {} : { executionId }
			}, review === void 0 ? null : enumField(review, "status", ["pending", "reviewed"]), review === void 0 ? null : stringField$1(review, "summary") ?? null, reviewId === void 0);
		}
		case "devflow/commander/review/complete": {
			const reviewId = id("reviewId");
			return known("bridge-review", "completed", reviewId === void 0 ? "unknown" : "review", reviewId ?? null, reviewId === void 0 ? {} : { reportId: reviewId }, "reviewed", null, reviewId === void 0);
		}
		case "devflow/runtime/session/create": return runtimeItem(known, record(data.session), "created");
		case "devflow/runtime/session/start":
		case "devflow/runtime/session/complete":
		case "devflow/runtime/session/fail": {
			const sessionId = id("sessionId");
			return known("runtime", entry.type.endsWith("/start") ? "started" : entry.type.endsWith("/complete") ? "completed" : "failed", sessionId === void 0 ? "unknown" : "runtime-session", sessionId ?? null, sessionId === void 0 ? {} : { executionId: sessionId }, null, null, sessionId === void 0);
		}
		case "devflow/commander/action/create": return actionItem(known, record(data.action), "created");
		case "devflow/commander/action/execute":
		case "devflow/commander/action/complete": {
			const actionId = id("actionId");
			return known("commander-action", entry.type.endsWith("/execute") ? "executed" : "completed", actionId === void 0 ? "unknown" : "action", actionId ?? null, actionId === void 0 ? {} : { decisionId: actionId }, null, null, actionId === void 0);
		}
		case "devflow/commander/action-execution/create": {
			const execution = record(data.execution);
			const executionId = execution === void 0 ? void 0 : stringField$1(execution, "executionId");
			const actionId = execution === void 0 ? void 0 : stringField$1(execution, "actionId");
			return known("commander-action", "executed", executionId === void 0 ? "unknown" : "action", executionId ?? null, {
				...executionId === void 0 ? {} : { executionId },
				...actionId === void 0 ? {} : { decisionId: actionId }
			}, execution === void 0 ? null : enumField(execution, "status", [
				"running",
				"completed",
				"failed"
			]), null, executionId === void 0);
		}
		case "devflow/commander/action-execution/complete":
		case "devflow/commander/action-execution/fail": {
			const executionId = id("executionId");
			return known("commander-action", entry.type.endsWith("/complete") ? "completed" : "failed", executionId === void 0 ? "unknown" : "action", executionId ?? null, executionId === void 0 ? {} : { executionId }, null, null, executionId === void 0);
		}
		default: return;
	}
}
function assignmentItem(known, assignment, action) {
	const assignmentId = assignment === void 0 ? void 0 : stringField$1(assignment, "assignmentId");
	const taskId = assignment === void 0 ? void 0 : stringField$1(assignment, "taskId");
	const phaseId = assignment === void 0 ? void 0 : stringField$1(assignment, "phaseId");
	const agentId = assignment === void 0 ? void 0 : stringField$1(assignment, "agentId");
	return known("assignment", action, assignmentId === void 0 ? "unknown" : "assignment", assignmentId ?? null, {
		...assignmentId === void 0 ? {} : { assignmentId },
		...taskId === void 0 ? {} : { taskId },
		...phaseId === void 0 ? {} : { phaseId },
		...agentId === void 0 ? {} : { agentId }
	}, assignment === void 0 ? null : enumField(assignment, "status", [
		"assigned",
		"in_progress",
		"completed",
		"closed"
	]), null, assignmentId === void 0);
}
function executionItem(known, execution, action) {
	const executionId = execution === void 0 ? void 0 : stringField$1(execution, "executionId");
	const taskId = execution === void 0 ? void 0 : stringField$1(execution, "taskId");
	const agentId = execution === void 0 ? void 0 : stringField$1(execution, "agentId");
	const assignmentId = execution === void 0 ? void 0 : stringField$1(execution, "assignmentId");
	return known("execution", action, executionId === void 0 ? "unknown" : "execution", executionId ?? null, {
		...executionId === void 0 ? {} : { executionId },
		...taskId === void 0 ? {} : { taskId },
		...agentId === void 0 ? {} : { agentId },
		...assignmentId === void 0 ? {} : { assignmentId }
	}, execution === void 0 ? null : enumField(execution, "status", [
		"pending",
		"running",
		"completed",
		"failed",
		"closed"
	]), null, executionId === void 0);
}
function attemptItem(known, attempt, action) {
	const attemptId = attempt === void 0 ? void 0 : stringField$1(attempt, "attemptId");
	const executionId = attempt === void 0 ? void 0 : stringField$1(attempt, "executionId");
	return known("attempt", action, attemptId === void 0 ? "unknown" : "attempt", attemptId ?? null, {
		...attemptId === void 0 ? {} : { attemptId },
		...executionId === void 0 ? {} : { executionId }
	}, attempt === void 0 ? null : enumField(attempt, "status", [
		"created",
		"running",
		"completed",
		"failed"
	]), null, attemptId === void 0);
}
function reportItem(known, report, action) {
	const reportId = report === void 0 ? void 0 : stringField$1(report, "reportId");
	const executionId = report === void 0 ? void 0 : stringField$1(report, "executionId");
	const agentId = report === void 0 ? void 0 : stringField$1(report, "agentId");
	return known("report", action, reportId === void 0 ? "unknown" : "report", reportId ?? null, {
		...reportId === void 0 ? {} : { reportId },
		...executionId === void 0 ? {} : { executionId },
		...agentId === void 0 ? {} : { agentId }
	}, report === void 0 ? null : enumField(report, "status", [
		"success",
		"failed",
		"blocked"
	]), report === void 0 ? null : stringField$1(report, "summary") ?? null, reportId === void 0);
}
function runtimeItem(known, session, action) {
	const sessionId = session === void 0 ? void 0 : stringField$1(session, "sessionId");
	const executionId = session === void 0 ? void 0 : stringField$1(session, "executionId");
	const agentId = session === void 0 ? void 0 : stringField$1(session, "agentId");
	return known("runtime", action, sessionId === void 0 ? "unknown" : "runtime-session", sessionId ?? null, {
		...executionId === void 0 ? {} : { executionId },
		...agentId === void 0 ? {} : { agentId }
	}, session === void 0 ? null : enumField(session, "status", [
		"created",
		"running",
		"completed",
		"failed"
	]), null, sessionId === void 0);
}
function actionItem(known, actionValue, action) {
	const actionId = actionValue === void 0 ? void 0 : stringField$1(actionValue, "actionId");
	const decisionId = actionValue === void 0 ? void 0 : stringField$1(actionValue, "decisionId");
	return known("commander-action", action, actionId === void 0 ? "unknown" : "action", actionId ?? null, { ...decisionId === void 0 ? {} : { decisionId } }, actionValue === void 0 ? null : enumField(actionValue, "status", [
		"created",
		"executing",
		"completed"
	]), null, actionId === void 0);
}
function normalizeQuery(query, cursor) {
	const filter = query.filter ?? cursor?.filter ?? { kind: "project" };
	if (!validFilter(filter) || cursor !== void 0 && !sameFilter(filter, cursor.filter)) return void 0;
	const now = /* @__PURE__ */ new Date();
	const fromValue = query.range?.from ?? cursor?.from ?? (/* @__PURE__ */ new Date(now.getTime() - 2592e6)).toISOString();
	const toValue = query.range?.to ?? cursor?.to ?? now.toISOString();
	if (!validTime(fromValue) || !validTime(toValue) || cursor !== void 0 && (fromValue !== cursor.from || toValue !== cursor.to)) return void 0;
	const from = Date.parse(fromValue);
	const to = Date.parse(toValue);
	if (from > to || to - from > 7776e6) return void 0;
	return {
		filter,
		from: new Date(from).toISOString(),
		to: new Date(to).toISOString()
	};
}
function matchesFilter(item, filter) {
	if (filter.kind === "project") return true;
	const id = filter.id;
	if (filter.kind === "phase") return item.entity.type === "phase" && item.entity.id === id || item.related.phaseId === id;
	if (filter.kind === "task") return item.entity.type === "task" && item.entity.id === id || item.related.taskId === id;
	if (filter.kind === "agent") return item.entity.type === "agent" && item.entity.id === id || item.related.agentId === id;
	if (filter.kind === "execution") return item.entity.type === "execution" && item.entity.id === id || item.related.executionId === id;
	return item.entity.type === "decision" && item.entity.id === id || item.related.decisionId === id || item.related.requestId === id;
}
function inRange(at, query) {
	const time = Date.parse(at);
	return Number.isFinite(time) && time >= Date.parse(query.from) && time <= Date.parse(query.to);
}
function safeText(value) {
	if (SENSITIVE_TEXT$1.test(value)) return {
		text: REDACTED_TEXT$1,
		truncated: false,
		redacted: true
	};
	if (value.length <= 500) return {
		text: value,
		truncated: false,
		redacted: false
	};
	return {
		text: value.slice(0, 500),
		truncated: true,
		redacted: false
	};
}
function record(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function stringField$1(value, key) {
	const candidate = value[key];
	return typeof candidate === "string" && validId(candidate) ? candidate : void 0;
}
function nullableStringField(value, key) {
	const candidate = value[key];
	if (candidate === null) return null;
	return typeof candidate === "string" && validId(candidate) ? candidate : void 0;
}
function enumField(value, key, allowed) {
	const candidate = value[key];
	return typeof candidate === "string" && allowed.includes(candidate) ? candidate : null;
}
function validId(value) {
	return value.length > 0 && value.length <= MAX_ID_LENGTH && !/[\x00-\x1F]/.test(value);
}
function validTime(value) {
	return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}
function validFilter(value) {
	return value.kind === "project" || validId(value.id);
}
function sameFilter(left, right) {
	return left.kind === right.kind && ("id" in left ? left.id === ("id" in right ? right.id : void 0) : !("id" in right));
}
function isCursorPayload(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const candidate = value;
	return candidate.v === 1 && (candidate.projectId === null || typeof candidate.projectId === "string") && isFilter(candidate.filter) && validTime(candidate.from) && validTime(candidate.to) && validSequence(candidate.head) && validSequence(candidate.next);
}
function isFilter(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const item = value;
	return item.kind === "project" || typeof item.kind === "string" && [
		"phase",
		"task",
		"agent",
		"execution",
		"decision"
	].includes(item.kind) && typeof item.id === "string" && validId(item.id);
}
function validSequence(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function serializedBytes(value) {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}
const REDACTED_TEXT = "Sensitive content is hidden.";
const SENSITIVE_TEXT = /(?:\b(?:prompt|system[\s_-]*prompt|credential|token|cookie|authorization|api[\s_-]*key|secret|password|raw\s*(?:tool\s*)?(?:input|output)|tool\s*(?:input|output)|stack\s*trace)\b|(?:[A-Za-z]:\\|\\\\|\/Users\/|\/home\/|\/tmp\/|\/var\/tmp\/|\/private\/var\/)|(?:Bearer\s+\S+))/i;
/** Convert plugin-owned state into the narrow JSON-safe Canvas DTO. */
async function createDevFlowClientSnapshot(controller, agent) {
	const scope = controller.resolveSessionScope(agent);
	const [state, tasks, results] = await Promise.all([
		scope.store.loadState(),
		scope.store.listTasks(),
		typeof scope.store.listResults === "function" ? scope.store.listResults() : Promise.resolve([])
	]);
	const mode = controller.commanderMode?.current(agent).mode ?? "chat";
	const report = controller.presetActivation === void 0 ? null : await controller.presetActivation.report(agent).catch(() => null);
	const executions = Object.values(state.executions);
	const executionById = new Map(executions.map((item) => [item.executionId, item]));
	const agentInstances = new Map(state.agents.map((item) => [item.id, item]));
	const reports = latestFirst(Object.values(state.agentReports), (item) => item.updatedAt, (item) => item.reportId).map((item) => toSafeReport(item, executionById.get(item.executionId)));
	const failures = createFailures(executions, reports);
	const visibleReports = reports.slice(0, 20);
	return {
		version: 1,
		generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
		session: {
			id: agent.id,
			workspacePath: scope.workspacePath,
			storeRoot: scope.storeRoot,
			commanderMode: report?.commanderMode ?? mode,
			presetId: report?.presetId ?? null,
			activation: report === null ? "unbound" : report.activation,
			activationError: report?.activationError ?? null,
			verifiedAt: report?.verifiedAt ?? null,
			lastActivationFailure: report?.lastFailure ?? null
		},
		paused: state.paused,
		project: state.project === null ? null : {
			id: state.project.id,
			name: state.project.name,
			goal: state.project.goal,
			currentStage: state.project.currentStage
		},
		agents: Object.values(state.orchestrationAgents).map((item) => ({
			id: item.agentId,
			role: item.role,
			kind: item.kind,
			status: item.status,
			displayName: agentInstances.get(item.agentId)?.displayName ?? fixedAgentDisplayName(item.agentId),
			model: item.modelConfig.model,
			...item.modelConfig.provider === void 0 ? {} : { provider: item.modelConfig.provider },
			skills: [...item.skills],
			capabilities: [...item.capabilities],
			delegationDepth: item.delegationDepth
		})).sort((left, right) => left.displayName.localeCompare(right.displayName)),
		tasks: tasks.map((item) => ({
			id: item.id,
			title: item.title,
			description: item.description,
			status: item.status,
			...item.assignedRole === void 0 ? {} : { assignedRole: item.assignedRole },
			updatedAt: item.updatedAt
		})).sort((left, right) => left.updatedAt.localeCompare(right.updatedAt)),
		phases: Object.values(state.phases).map((item) => ({
			id: item.id,
			name: item.name,
			description: item.description,
			status: item.status
		})).sort((left, right) => left.id.localeCompare(right.id)),
		assignments: Object.values(state.assignments).map((item) => ({
			id: item.assignmentId,
			...item.taskId === void 0 ? {} : { taskId: item.taskId },
			phaseId: item.phaseId,
			agentId: item.agentId,
			role: item.role,
			status: item.status,
			...item.status === "closed" ? {
				closedAt: item.closedAt,
				closeReason: item.closeReason
			} : {}
		})).sort((left, right) => left.id.localeCompare(right.id)),
		executions: executions.map((item) => ({
			id: item.executionId,
			assignmentId: item.assignmentId,
			...item.taskId === void 0 ? {} : { taskId: item.taskId },
			agentId: item.agentId,
			status: item.status,
			startedAt: item.startedAt,
			completedAt: item.completedAt,
			...item.status === "closed" ? {
				closedAt: item.closedAt,
				closeReason: item.closeReason
			} : {}
		})).sort((left, right) => left.id.localeCompare(right.id)),
		results: latestFirst(results, (item) => item.createdAt, (item) => item.id).slice(0, 20).map(toSafeResult),
		reports: visibleReports,
		attempts: latestFirst(Object.values(state.executionAttempts), (item) => item.updatedAt, (item) => item.attemptId).slice(0, 20).map(toSafeAttempt),
		failures,
		decisions: Object.values(state.commanderDecisions).map((item) => ({
			id: item.decisionId,
			type: item.decisionType,
			summary: item.summary,
			nextAction: item.nextAction,
			createdAt: item.createdAt
		})).sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
		decisionRequests: Object.values(state.decisionRequests).map((item) => ({
			id: item.requestId,
			taskId: item.taskId,
			trigger: item.trigger,
			question: item.question,
			options: item.options.map((option) => ({
				id: option.id,
				label: option.label,
				description: option.description,
				recommended: option.recommended
			})),
			status: item.status
		})).sort((left, right) => left.id.localeCompare(right.id)),
		blocked: blockedRows(state, agentInstances)
	};
}
/**
* True when recorded FACTS say one block was resolved after it was reported.
*
* Live feedback (2026-09-24): the 受阻 banner kept listing blocks whose tasks had long
* been delivered and accepted — it read as a stale alarm and covered the canvas. A block
* is a durable record, so the panel is what must stop calling it open, and only two facts
* count as resolution:
*
*  * the block's task reached `completed` (the work finished and the user accepted it);
*  * a COMPLETED execution exists for the same task that ended after the block was
*    reported — the task was dispatched again and this time it landed, which is exactly
*    what "the missing capability was fixed and the work got done" looks like on disk.
*
* Both are recorded, never inferred from the absence of evidence. Nothing is deleted here:
* the blocked record and its journal row stay as history.
* @param state - the folded store state.
* @param block - the blocked report to judge.
* @returns true when the block no longer describes an open problem.
*/
function blockedResolved(state, block) {
	if (state.tasks[block.taskId] === "completed") return true;
	return Object.values(state.executions ?? {}).some((execution) => execution.taskId === block.taskId && execution.status === "completed" && (execution.completedAt ?? execution.updatedAt ?? execution.createdAt) > block.createdAt);
}
/**
* Project the blocked records the panel must show.
*
* A blocked row is the product's "受阻" terminal state, so it is assembled here
* — headline included — rather than left for the client to word: the panel shows
* one plain-language Chinese line, and that line must not exist in two variants.
*
* Only UNRESOLVED blocks are projected (see {@link blockedResolved}); the durable records
* and their journal rows are untouched.
*/
function blockedRows(state, agentInstances) {
	return Object.values(state.blockedReports ?? {}).filter((item) => !blockedResolved(state, item)).map((item) => {
		const agentName = agentInstances.get(item.agentId)?.displayName ?? fixedAgentDisplayName(item.agentId);
		return {
			id: item.blockedId,
			taskId: item.taskId,
			agentId: item.agentId,
			agentName,
			gapKind: item.gapKind,
			missing: item.missing,
			suggestedOwner: item.suggestedOwner,
			reason: toSafeText(item.reason),
			headline: blockedHeadline(item, agentName),
			at: item.createdAt
		};
	}).sort((left, right) => right.at.localeCompare(left.at)).slice(0, 20);
}
/** Project one task-level Result to one bounded summary; no execution relationship is invented. */
function toSafeResult(result) {
	const detail = result.summary || result.issues[0] || result.verification[0] || result.changes[0] || result.nextSteps[0] || "";
	return {
		id: result.id,
		taskId: result.taskId,
		source: "result",
		at: result.createdAt,
		summary: toSafeText(detail)
	};
}
function toSafeReport(report, execution) {
	return {
		id: report.reportId,
		executionId: report.executionId,
		...execution?.taskId === void 0 ? {} : { taskId: execution.taskId },
		agentId: report.agentId,
		source: "report",
		status: report.status,
		at: report.updatedAt,
		summary: toSafeText(report.summary)
	};
}
function toSafeAttempt(attempt) {
	return {
		id: attempt.attemptId,
		executionId: attempt.executionId,
		source: "attempt",
		status: attempt.status,
		isRetry: attempt.parentAttemptId !== null,
		at: attempt.updatedAt,
		completedAt: attempt.completedAt
	};
}
/** Surface one safe report failure or a no-detail failed execution fact. */
function createFailures(executions, reports) {
	const reportFailures = reports.filter((report) => report.status === "failed" || report.status === "blocked").map((report) => ({
		id: `report-${report.id}`,
		executionId: report.executionId,
		...report.taskId === void 0 ? {} : { taskId: report.taskId },
		agentId: report.agentId,
		source: "report",
		status: report.status,
		at: report.at,
		summary: report.summary
	}));
	const failedExecutionIds = new Set(reportFailures.map((item) => item.executionId));
	const executionFailures = executions.filter((execution) => execution.status === "failed" && !failedExecutionIds.has(execution.executionId)).map((execution) => ({
		id: `execution-${execution.executionId}`,
		executionId: execution.executionId,
		...execution.taskId === void 0 ? {} : { taskId: execution.taskId },
		agentId: execution.agentId,
		source: "execution",
		status: "failed",
		at: execution.completedAt ?? execution.updatedAt,
		summary: null
	}));
	return latestFirst([...reportFailures, ...executionFailures], (item) => item.at, (item) => item.id).slice(0, 20);
}
/** Fail closed: strings with a sensitive signal become a generic disclosure notice. */
function toSafeText(value) {
	if (SENSITIVE_TEXT.test(value)) return {
		text: REDACTED_TEXT,
		truncated: false,
		redacted: true
	};
	if (value.length <= 500) return {
		text: value,
		truncated: false,
		redacted: false
	};
	return {
		text: value.slice(0, 500),
		truncated: true,
		redacted: false
	};
}
function latestFirst(items, at, id) {
	return [...items].sort((left, right) => {
		const time = at(right).localeCompare(at(left));
		return time === 0 ? id(left).localeCompare(id(right)) : time;
	});
}
//#endregion
//#region lib/host/client-bridge.js
/** Public Typert Remote bridge for the DevFlow client snapshot. */
var __runInitializers = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
var __esDecorate = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) {
			if (kind === "field") initializers.unshift(_);
			else descriptor[key] = _;
		}
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
const STATE_UNAVAILABLE = {
	code: "state-unavailable",
	message: "DevFlow state is unavailable. Refresh to try again."
};
/**
* The 第九步 refusal: this session has no workspace, so it has no project.
*
* It is a DIFFERENT code from the generic one on purpose. "Could not be
* isolated" and "failed to load" call for different responses, and a shared
* library served under the generic code would be indistinguishable from an
* isolated read.
*/
const SCOPE_UNAVAILABLE = {
	code: "scope-unavailable",
	message: "DevFlow cannot isolate this session: it has no project workspace. Shared state is not shown."
};
/** How long a quiet channel waits before proving itself with one signal. */
const KEEPALIVE_MS = 15e3;
/** Gateway-discoverable, path-free read/refresh service for the Canvas. */
let DevFlowClientBridge = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _snapshot_decorators;
	let _refresh_decorators;
	let _auditPage_decorators;
	let _follow_decorators;
	return class DevFlowClientBridge extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_snapshot_decorators = [Remote("snapshot")];
			_refresh_decorators = [Remote("refresh")];
			_auditPage_decorators = [Remote("audit-page")];
			_follow_decorators = [Remote({ mode: "stream" })];
			__esDecorate(this, null, _snapshot_decorators, {
				kind: "method",
				name: "snapshot",
				static: false,
				private: false,
				access: {
					has: (obj) => "snapshot" in obj,
					get: (obj) => obj.snapshot
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _refresh_decorators, {
				kind: "method",
				name: "refresh",
				static: false,
				private: false,
				access: {
					has: (obj) => "refresh" in obj,
					get: (obj) => obj.refresh
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _auditPage_decorators, {
				kind: "method",
				name: "auditPage",
				static: false,
				private: false,
				access: {
					has: (obj) => "auditPage" in obj,
					get: (obj) => obj.auditPage
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _follow_decorators, {
				kind: "method",
				name: "follow",
				static: false,
				private: false,
				access: {
					has: (obj) => "follow" in obj,
					get: (obj) => obj.follow
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			if (_metadata) Object.defineProperty(this, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		static inject = ["devflow"];
		constructor(ctx) {
			super(ctx, "devflowClient", { namespace: "devflow" });
			__runInitializers(this, _instanceExtraInitializers);
		}
		async snapshot(agent) {
			return this.read(agent);
		}
		async refresh(agent) {
			return this.read(agent);
		}
		async auditPage(agent, query) {
			try {
				return await new DevFlowAuditPager(this.ctx.devflow.resolveSessionScope(agent).store).page(query);
			} catch {
				return {
					kind: "error",
					error: {
						code: "audit-unavailable",
						message: "DevFlow audit is unavailable. Refresh to try again."
					}
				};
			}
		}
		/**
		* Follow the committed DevFlow state: one opening snapshot, then one signal per
		* coalesced change batch.
		*
		* The channel is intentionally thin. It never sends derived state — only the
		* read model the client could have fetched itself, plus "the state moved on".
		* That is what makes a frame droppable and a replay harmless: the client decides
		* what to re-read, and the existing snapshot path stays the single source of
		* truth. A quiet channel still emits a keepalive signal, so a dead carrier is
		* noticed rather than looking like "nothing is happening".
		*
		* @param agent - the scoped Agent whose session is being followed.
		* @param request - what the client already holds (`sequence`).
		* @param signal - cancellation owned by the Remote stream carrier.
		* @returns the opening snapshot followed by ordered change signals.
		*/
		async *follow(agent, request, signal) {
			const bus = this.ctx.devflow.changeBus;
			let sessionKey;
			try {
				sessionKey = this.ctx.devflow.resolveSessionScope(agent).sessionKey;
			} catch {
				return;
			}
			let baseline;
			try {
				baseline = {
					kind: "snapshot",
					snapshot: await createDevFlowClientSnapshot(this.ctx.devflow, agent)
				};
			} catch {
				baseline = {
					kind: "error",
					error: STATE_UNAVAILABLE
				};
			}
			if (baseline.kind === "error") return;
			yield {
				kind: "snapshot",
				snapshot: baseline.snapshot
			};
			const pending = [];
			let wake = null;
			const unsubscribe = bus.subscribe((signal) => {
				if (signal.sessionKey !== void 0 && signal.sessionKey !== sessionKey) return;
				pending.push(signal);
				wake?.();
			});
			const onAbort = () => {
				wake?.();
			};
			signal.addEventListener("abort", onAbort);
			try {
				while (!signal.aborted) {
					if (pending.length === 0) await new Promise((resolve) => {
						let settled = false;
						const finish = () => {
							if (settled) return;
							settled = true;
							clearTimeout(timer);
							wake = null;
							resolve();
						};
						const timer = setTimeout(finish, KEEPALIVE_MS);
						wake = finish;
					});
					if (signal.aborted) break;
					let latest = pending.pop();
					pending.length = 0;
					if (latest === void 0) latest = {
						revision: bus.currentRevision,
						sequence: bus.currentSequence,
						changed: [],
						changes: [],
						at: (/* @__PURE__ */ new Date()).toISOString()
					};
					yield {
						kind: "changed",
						revision: latest.revision,
						sequence: latest.sequence,
						changed: latest.changed,
						changes: latest.changes.map((change) => ({
							type: change.type,
							id: change.id,
							at: change.at
						})),
						at: latest.at
					};
				}
			} finally {
				signal.removeEventListener("abort", onAbort);
				unsubscribe();
			}
		}
		async read(agent) {
			try {
				return {
					kind: "snapshot",
					snapshot: await createDevFlowClientSnapshot(this.ctx.devflow, agent)
				};
			} catch (cause) {
				if (cause instanceof DevFlowSessionScopeError) return {
					kind: "error",
					error: SCOPE_UNAVAILABLE
				};
				return {
					kind: "error",
					error: STATE_UNAVAILABLE
				};
			}
		}
	};
})();
//#endregion
//#region lib/host/change-set.js
/** Identity fields to probe, in order, to name the entity a record refers to. */
const ID_FIELDS = [
	"taskId",
	"executionId",
	"assignmentId",
	"attemptId",
	"reportId",
	"phaseId",
	"decisionId"
];
/**
* Project one committed journal record onto the bounded change vocabulary.
*
* Reads only the record's own `type` and a small set of identity fields: it never
* re-reads a state file, so a busy project does not turn each frame into a burst of
* I/O. A record outside the catalogue returns an empty list, which is the intended
* "nothing the canvas draws changed" answer rather than an error.
* @param entry - the committed journal record.
* @returns zero or one change; the journal is one record per committed fact.
*/
function commitChangeOf(entry) {
	const kind = kindOf(entry.type, entry.data);
	if (kind === null) return null;
	const id = entityIdOf(entry.data);
	if (id === null) return null;
	return {
		type: kind,
		id,
		at: entry.at
	};
}
/** Map one durable record type (plus its payload) onto a kind, or null. */
function kindOf(type, data) {
	if (type === "devflow/task/transition") {
		const to = stringField(data, "to");
		if (to === "reviewing") return "task-reviewing";
		if (to === "executing") return "task-executing";
		if (to === "completed" || to === "failed" || to === "cancelled") return "task-settled";
		return null;
	}
	if (type === "devflow/execution/start") return "execution-started";
	if (type === "devflow/execution/complete" || type === "devflow/execution/fail" || type === "devflow/execution/close") return "execution-settled";
	if (type === "devflow/orchestration/assign") return "assignment-created";
	if (type === "devflow/orchestration/close") return "assignment-settled";
	return null;
}
/** The identity one record refers to, checked against the bounded id shape. */
function entityIdOf(data) {
	for (const field of ID_FIELDS) {
		const value = stringField(data, field);
		if (value !== null) return value;
	}
	if (typeof data === "object" && data !== null) for (const nested of Object.values(data)) {
		if (typeof nested !== "object" || nested === null) continue;
		for (const field of ID_FIELDS) {
			const value = stringField(nested, field);
			if (value !== null) return value;
		}
	}
	return null;
}
function stringField(value, field) {
	if (typeof value !== "object" || value === null) return null;
	const raw = value[field];
	return typeof raw === "string" && raw !== "" && raw.length <= 128 ? raw : null;
}
//#endregion
//#region lib/host/change-bus.js
/**
* Host-side change bus behind the live event channel.
*
* `.devflow` has no notification seam of its own: every mutation is a JSON file
* write through `storage.ts`'s single `writeJson` helper. This bus is that seam —
* storage reports each committed file, the bus coalesces reports into one signal
* per window, and the streaming Remote turns signals into frames.
*
* The bus carries no business state: a signal says "the committed state moved to
* revision N", never "task X is now done". A signal MAY additionally carry a
* bounded set of committed change KINDS (see `change-set.ts`), which is a hint the
* client uses to tell a busy canvas from an idle one — the client still re-reads
* the read model through the existing snapshot path, so a dropped or duplicated
* signal can never produce a state the model does not have.
*/
/**
* The committed-write observer handed to `DevFlowStore`, i.e. the wiring that turns
* a durable write into a live-channel signal.
*
* It is EXPORTED on purpose, and it lives beside the bus rather than inline in the
* controller. The frame's `changes` field was empty on the wire for a whole round
* because this callback dropped the record argument while the test that "proved"
* the wiring built its own, correct, callback — so the test never touched the line
* that was broken. One exported production function means a test can consume the
* real wiring instead of a look-alike.
* @param bus - the live-channel change bus.
* @returns the observer the store reports every committed write to.
*/
function committedWriteObserver(bus) {
	return (relativePath, sequence, record) => {
		bus.report(relativePath, sequence, record);
	};
}
/**
* Collect writes and publish at most one signal per window.
*
* `report` may be called from any write path; it is synchronous and cheap. The
* first report in a window arms a timer, later reports join the batch, and the
* flush publishes exactly one signal to every subscriber.
*/
var DevFlowChangeBus = class {
	windowMs;
	pathLimit;
	changeLimit;
	now;
	listeners = /* @__PURE__ */ new Set();
	paths = /* @__PURE__ */ new Set();
	changes = [];
	/** Session keys seen in this batch; more than one degrades to "project unknown". */
	sessionKeys = /* @__PURE__ */ new Set();
	/** Set once the batch outgrows the change limit; the list is then dropped whole. */
	changesOverflowed = false;
	timer = null;
	revision = 0;
	sequence = null;
	disposed = false;
	constructor(options = {}) {
		this.windowMs = Math.max(0, options.windowMs ?? 200);
		this.pathLimit = Math.max(1, options.pathLimit ?? 12);
		this.changeLimit = Math.max(1, options.changeLimit ?? 8);
		this.now = options.now ?? (() => (/* @__PURE__ */ new Date()).toISOString());
	}
	/** Current in-process revision (0 before the first flushed signal). */
	get currentRevision() {
		return this.revision;
	}
	/** Last durable journal sequence the bus observed, or null. */
	get currentSequence() {
		return this.sequence;
	}
	/** Subscribe to coalesced signals; the disposer is idempotent. */
	subscribe(listener) {
		this.listeners.add(listener);
		let active = true;
		return () => {
			if (!active) return;
			active = false;
			this.listeners.delete(listener);
		};
	}
	/**
	* Report one committed write.
	* @param relativePath - root-relative `.devflow` path, e.g. `tasks/<id>.json`.
	* @param sequence - durable journal head after this write, when the write was a journal publish.
	* @param record - the committed journal record, when this write published one. Only
	*   records are turned into semantic changes: a plain state-file write has no
	*   committed meaning of its own, and inferring one from its path would be a guess.
	* @param sessionKey - the store whose state moved, when the observer knows it. A
	*   batch that spans more than one store drops the key rather than naming one
	*   project for another project's change.
	*/
	report(relativePath, sequence, record, sessionKey) {
		if (this.disposed) return;
		if (this.paths.size < this.pathLimit) this.paths.add(relativePath);
		else this.paths.add("…");
		if (sessionKey !== void 0) this.sessionKeys.add(sessionKey);
		if (sequence !== void 0 && (this.sequence === null || sequence > this.sequence)) this.sequence = sequence;
		if (record !== void 0 && !this.changesOverflowed) {
			const change = commitChangeOf(record);
			if (change !== null) {
				if (this.changes.length < this.changeLimit) this.changes.push(change);
				else this.changesOverflowed = true;
			}
		}
		if (this.timer !== null) return;
		this.timer = setTimeout(() => {
			this.flush();
		}, this.windowMs);
		if (typeof this.timer === "object" && this.timer !== null && "unref" in this.timer) this.timer.unref();
	}
	/** Publish the pending batch immediately (used by tests and on teardown). */
	flush() {
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		const paths = [...this.paths];
		const changes = this.changesOverflowed ? [] : [...this.changes];
		const sequence = this.sequence;
		const sessionKeys = [...this.sessionKeys];
		const sessionKey = sessionKeys.length === 1 ? sessionKeys[0] : void 0;
		this.paths.clear();
		this.changes.length = 0;
		this.sessionKeys = /* @__PURE__ */ new Set();
		this.changesOverflowed = false;
		if (paths.length === 0 && sequence === null) return;
		this.revision += 1;
		const signal = {
			revision: this.revision,
			sequence,
			changed: paths.slice(0, this.pathLimit),
			changes,
			...sessionKey === void 0 ? {} : { sessionKey },
			at: this.now()
		};
		for (const listener of [...this.listeners]) try {
			listener(signal);
		} catch {}
	}
	/** Release every subscriber and drop pending work. */
	dispose() {
		this.disposed = true;
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		this.paths.clear();
		this.changes.length = 0;
		this.changesOverflowed = false;
		this.listeners.clear();
	}
};
//#endregion
//#region lib/host/index.js
/**
* DevFlow: Agent Team Workflow Orchestrator.
* v0.1 owns the `devflow` service key, file-backed store, tools, and commands.
* @module @xiaoxie-ide/dsh-devflow
*/
const DEFAULT_DEVFLOW_DIR = "./.devflow";
/**
* Validate deployment-owned config. Unknown keys fail at load rather than
* being silently ignored.
* @param config - raw plugin config.
* @returns a detached validated config.
*/
function resolveConfig(config) {
	const devflowDir = config.devflowDir ?? config.stateDir ?? DEFAULT_DEVFLOW_DIR;
	if (typeof devflowDir !== "string" || devflowDir.trim() === "") throw new Error("DevFlowConfig needs a non-empty string `devflowDir` or `stateDir`");
	const unknown = Object.keys(config).filter((key) => key !== "devflowDir" && key !== "stateDir");
	if (unknown.length > 0) throw new Error(`DevFlowConfig has unknown key(s) ${unknown.join(", ")}; config is { devflowDir?, stateDir? }`);
	return { devflowDir };
}
/**
* DevFlow orchestration service: owns project context, the task lifecycle,
* Agent handoff state, and their file-backed store.
*/
var DevflowController = class extends Service {
	static inject = ["fs", "tools"];
	/**
	* The retained mixed library at the host process cwd (`./.devflow`).
	*
	* Since 第九步 this is NOT the store any session uses: every session resolves
	* its own `<workspace>/.devflow` through {@link sessionStores}. It is kept
	* constructed because the existing mixed library must stay readable as-is
	* (decision 3: no moving, splitting, or re-attributing), and because a
	* session that carries no workspace fact at all is exactly what it holds.
	*/
	store;
	/** Per-session-workspace store resolution: the isolation this round adds. */
	sessionStores;
	/** Task lifecycle manager over the file-backed store. */
	workflow;
	/**
	* Committed-write notification seam behind the live event channel. It carries no
	* business state: subscribers learn only that the committed `.devflow` state moved.
	*/
	changeBus;
	/** Planner 闁?DevFlow 闁?Executor collaboration flow. */
	agentWorkflow;
	/** Interactive Commander controller; absent without the complete host services. */
	commanderMode;
	/**
	* The `devflow` preset activation adapter. It consumes the Harness generic
	* activation Hook for this deployment's single host controller: the preset
	* composition row calls {@link createActivationProvider} and provides the
	* returned value as the isolated `agentPresetActivation` service. No second
	* loader, service, Remote, or state source is created.
	*/
	presetActivation;
	/**
	* A provider value for one `devflow` preset composition's isolated row.
	* Each composition mount receives its own plain provider value, all sharing
	* this one host controller and the one `.devflow` store.
	*/
	createActivationProvider() {
		return this.presetActivation?.createProvider();
	}
	/** Read one session's verified activation posture for commands and snapshots. */
	readPresetActivation(agent) {
		return this.presetActivation?.report(agent);
	}
	/** Last hydrated mixed-library read model (diagnostics only; see {@link store}). */
	durableState = initialDevFlowState();
	/**
	* Read the last successful snapshot of the RETAINED MIXED LIBRARY.
	*
	* This is deliberately not any session's read model: since 第九步 a session's
	* state is read through {@link resolveSessionScope}, and this accessor only
	* serves diagnostics over the pre-isolation library that must stay visible
	* and unmodified.
	*/
	readState() {
		return this.durableState;
	}
	/**
	* Resolve the store, workspace, and identity of one calling session.
	*
	* Every stateful surface — tools, commands, the client bridge, the preset
	* activation adapter — goes through here, so there is exactly one place where
	* "which project is this session" is decided.
	* @param agent - the calling Agent, when the runtime supplied one.
	* @returns the session's store scope.
	* @throws DevFlowSessionScopeError when the session cannot be scoped.
	*/
	resolveSessionScope(agent) {
		return this.sessionStores.resolve(agent);
	}
	constructor(ctx, config = {}) {
		super(ctx, "devflow");
		this.changeBus = new DevFlowChangeBus();
		ctx.effect(() => () => {
			this.changeBus.dispose();
		}, "devflow: change bus");
		const devflowDir = resolveConfig(config).devflowDir;
		this.sessionStores = new DevFlowSessionStores(ctx.fs, devflowDir, (sessionKey, relativePath, sequence, record) => {
			this.changeBus.report(relativePath, sequence, record, sessionKey);
		}, (agent) => {
			if (agent === void 0) return void 0;
			const policy = ctx.get("sandboxPolicy")?.resolve({ session: agent.session });
			return policy === void 0 ? void 0 : {
				mode: policy.mode,
				workspaceRoot: policy.workspaceRoot
			};
		});
		this.store = new DevFlowStore(ctx.fs, devflowDir, committedWriteObserver(this.changeBus));
		this.workflow = new TaskWorkflow(this.store);
		this.agentWorkflow = new AgentWorkflow(this.store, this.workflow);
		const commander = DEFAULT_FIXED_AGENTS.find((agent) => agent.agentId === "commander");
		if (commander === void 0) throw new Error("devflow: default commander configuration is missing");
		this.commanderMode = new CommanderMode(commander.prompt);
		registerDevFlowTools(ctx, {
			store: this.store,
			sessionStores: this.sessionStores,
			workflow: this.workflow,
			agentWorkflow: this.agentWorkflow,
			isCommander: (agent) => this.commanderMode?.current(agent).mode === "commander"
		});
		this.presetActivation = new DevFlowPresetActivation(this.sessionStores, this.commanderMode, { composedPreset: (agent) => agent.ctx.get("agentPresets")?.composedPreset(agent.ctx) });
		new DevFlowClientBridge(ctx);
		this.store.loadState().then((state) => {
			this.durableState = state;
		}).catch(() => {
			this.durableState = initialDevFlowState();
		});
		registerDevFlowCommands(ctx, {
			store: this.store,
			sessionStores: this.sessionStores,
			agentWorkflow: this.agentWorkflow,
			getCommanderMode: () => this.commanderMode,
			readPresetActivation: (agent) => this.presetActivation?.report(agent)
		});
	}
};
//#endregion
export { DevflowController, DevflowController as default, resolveConfig };
