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

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { FileSystem, FsTarget, FsWriteIntent } from '@deepseek-ai/dsh-fs'
import { applyDevFlowStateEvent, initialDevFlowState } from './state.ts'
import { recordDevFlowChange } from './journal.ts'
import { isRecord, isString, isStringArray, type DevFlowJsonValue } from './json.ts'
import { isDevFlowCloseReason } from './types.ts'
import { DEVFLOW_SKILLS, validateAgentSkills, type ResolvedSkillContent } from './skill-binding.ts'
import type { AgentInstance, AssignedRole, Project, Result, Task, TaskStatus } from './types.ts'
import type {
  AgentConfigPatch, AgentKind, DecisionAnswer, DecisionRequest, DispatchDiagnostic, ScopeBoundaryHit, AgentLifecycleStatus, AgentModelConfig, AgentReport,
  AgentReportStatus, AgentReportUpdate, AssignmentStatus, BlockedReport, CommanderAction, CommanderActionStatus,
  CommanderActionType, CommanderCheckpoint, CommanderCheckpointUpdate,
  CommanderDecision, CommanderDecisionType, CommanderDecisionUpdate, CommanderMemory,
  CommanderMemoryType, CommanderMemoryUpdate, CommanderPlan, CommanderPlanStatus,
  CommanderPlanUpdate, CommanderReview, CommanderReviewStatus, CommanderActionExecutionRecord,
  CommanderActionExecutionStatus, CommanderPolicy, CommanderProposal, CommanderProposalStatus,
  CommanderRiskLevel, CommanderRunRecord, CommanderRunStatus,
  CommanderSchedule,
  CommanderScheduleStatus, CommanderScheduleUpdate, CommanderStepStatus, CommanderWorkflow,
  CommanderWorkflowExecution, CommanderWorkflowExecutionResult, CommanderWorkflowStatus,
  CommanderWorkflowStep, DevFlowCloseReason, ExecutionAttempt, ExecutionAttemptStatus,
  ExecutionBatch, ExecutionBatchStatus, ExecutionRecord, ExecutionStatus, Improvement,
  MvpPlan, OrchestrationAgent, Phase, PhaseAssignment, PhaseStatus, RuntimeSession, RuntimeSessionStatus,
  ScopeGuard, TemporaryAgentStatus, DevFlowJournalEvent, DevFlowProjectionState,
} from './types.ts'

const JOURNAL_DIR = 'journal'
const PROJECT_FILE = 'project.json'
const TASKS_DIR = 'tasks'
const RESULTS_DIR = 'results'
const AGENTS_DIR = 'agents'
const IMPORTS_DIR = 'imports'
const FILE_SUFFIX = '.json'
const MARKDOWN_SUFFIX = '.md'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Per-journal-root tail that serializes local concurrent append operations. */
const journalTails = new Map<string, Promise<void>>()
/** Agent instance ids are human-recognizable lowercase slugs, never UUIDs. */
const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/** One self-contained, append-only DevFlow journal entry. */
export interface DevFlowJournalEntry {
  /** Monotonic sequence assigned under the journal head's optimistic lock. */
  readonly sequence: number
  /** Stable UUID for idempotent callers. */
  readonly id: string
  /** Plugin-owned audit category; never a Session event type. */
  readonly type: string
  /** Lossless JSON payload. */
  readonly data: DevFlowJsonValue
  /** ISO-8601 publication timestamp. */
  readonly at: string
}

/** One bounded backwards scan of committed journal entry files. */
export interface DevFlowJournalSequencePage {
  /** Exclusive committed head captured for this scan. */
  readonly capturedHeadSequence: number
  /** Entries in descending sequence order. */
  readonly entries: readonly DevFlowJournalEntry[]
  /** Next exclusive sequence to scan, or null at the beginning of the journal. */
  readonly nextExclusiveSequence: number | null
  /** Direct entry files read during this bounded scan. */
  readonly scannedCount: number
}

/** Complete read model recovered from plugin-owned journal records. */
export type DevFlowStoreState = DevFlowProjectionState

interface JournalHead {
  readonly nextSequence: number
}

const JOURNAL_HEAD_FILE = 'head.json'
/** Root-relative journal head, in the backend-independent `/` form observers see. */
const JOURNAL_HEAD_RELATIVE = `${JOURNAL_DIR}/${JOURNAL_HEAD_FILE}`

function isJsonValue(value: unknown): value is DevFlowJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  return isRecord(value) && Object.values(value).every(isJsonValue)
}

function validateJournalEntry(value: unknown, displayPath: string): DevFlowJournalEntry {
  if (!isRecord(value) || typeof value.sequence !== 'number' || !Number.isSafeInteger(value.sequence) || value.sequence < 0
    || !isString(value.id) || !UUID_PATTERN.test(value.id) || !isString(value.type) || value.type.trim() === ''
    || !isJsonValue(value.data) || !isString(value.at)) {
    throw new Error(`devflow: invalid journal entry in ${displayPath}`)
  }
  return { sequence: value.sequence, id: value.id, type: value.type, data: value.data, at: value.at }
}

function validateJournalHead(value: unknown, displayPath: string): JournalHead {
  if (!isRecord(value) || typeof value.nextSequence !== 'number' || !Number.isSafeInteger(value.nextSequence) || value.nextSequence < 0) {
    throw new Error(`devflow: invalid journal head in ${displayPath}`)
  }
  return { nextSequence: value.nextSequence }
}

const TASK_STATUSES: readonly TaskStatus[] = ['created', 'planned', 'executing', 'reviewing', 'completed', 'failed', 'cancelled']
const ASSIGNED_ROLES: readonly AssignedRole[] = ['planner', 'backend-engineer', 'frontend-engineer', 'reviewer']

const ORCHESTRATION_AGENTS_DIR = 'orchestration-agents'
const MVP_FILE = 'mvp.json'
const PHASES_DIR = 'phases'
const SCOPE_FILE = 'scope.json'
/** Directory holding one scope guard per task (`scopes/<taskId>.json`). */
const SCOPES_DIR = 'scopes'
const IMPROVEMENTS_DIR = 'improvements'

const AGENT_KINDS: readonly AgentKind[] = ['fixed', 'temporary']
const FIXED_STATUSES: readonly AgentLifecycleStatus[] = ['active']
const TEMPORARY_STATUSES: readonly AgentLifecycleStatus[] = ['created', 'running', 'terminated']
const PHASE_STATUSES: readonly PhaseStatus[] = ['planned', 'in_progress', 'completed']
/** Valid temporary-agent lifecycle transitions: created → running → terminated. */
const TEMPORARY_TRANSITIONS: Readonly<Record<TemporaryAgentStatus, readonly TemporaryAgentStatus[]>> = {
  created: ['running'],
  running: ['terminated'],
  terminated: [],
}

const CHECKPOINTS_DIR = 'checkpoints'
const ASSIGNMENTS_DIR = 'assignments'
const ASSIGNMENT_STATUSES: readonly AssignmentStatus[] = ['assigned', 'in_progress', 'completed', 'closed']
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
const ASSIGNMENT_TRANSITIONS: Readonly<Record<AssignmentStatus, readonly AssignmentStatus[]>> = {
  assigned: ['in_progress', 'completed', 'closed'],
  in_progress: ['assigned', 'completed', 'closed'],
  completed: [],
  closed: [],
}

const PLANNING_DIR = 'planning'
const BATCHES_DIR = 'batches'
const COMMANDER_PLAN_STATUSES: readonly CommanderPlanStatus[] = ['draft', 'active', 'completed']
const EXECUTION_BATCH_STATUSES: readonly ExecutionBatchStatus[] = ['planned', 'running', 'paused', 'completed']
/** Valid execution-batch transitions: planned → running → paused/completed; paused → running. */
const EXECUTION_BATCH_TRANSITIONS: Readonly<Record<ExecutionBatchStatus, readonly ExecutionBatchStatus[]>> = {
  planned: ['running'],
  running: ['paused', 'completed'],
  paused: ['running'],
  completed: [],
}

const EXECUTIONS_DIR = 'executions'
const REPORTS_DIR = 'reports'
const EXECUTION_STATUSES: readonly ExecutionStatus[] = ['pending', 'running', 'completed', 'failed', 'closed']
/**
 * Valid execution transitions: pending → running → completed/failed, and → `closed`
 * from either live state. `closed` is terminal and is the ONLY status that may be
 * stamped with a close reason; the other terminal states already say what happened.
 */
const EXECUTION_TRANSITIONS: Readonly<Record<ExecutionStatus, readonly ExecutionStatus[]>> = {
  pending: ['running', 'closed'],
  running: ['completed', 'failed', 'closed'],
  completed: [],
  failed: [],
  closed: [],
}
const AGENT_REPORT_STATUSES: readonly AgentReportStatus[] = ['success', 'failed', 'blocked']

const DECISIONS_DIR = 'decisions'
const DECISION_TYPES: readonly CommanderDecisionType[] = ['continue', 'retry', 'pause', 'request_user']

const ACTIONS_DIR = 'actions'
const ACTION_TYPES: readonly CommanderActionType[] = ['start_batch', 'pause_batch', 'retry_execution', 'complete_batch']
const ACTION_STATUSES: readonly CommanderActionStatus[] = ['created', 'executing', 'completed']
/** Valid commander control-action transitions: created → executing → completed. */
const ACTION_TRANSITIONS: Readonly<Record<CommanderActionStatus, readonly CommanderActionStatus[]>> = {
  created: ['executing'],
  executing: ['completed'],
  completed: [],
}

const SESSIONS_DIR = 'runtime-sessions'
const RUNTIME_SESSION_STATUSES: readonly RuntimeSessionStatus[] = ['created', 'running', 'completed', 'failed']
/** Valid runtime session transitions: created → running → completed/failed. */
const RUNTIME_SESSION_TRANSITIONS: Readonly<Record<RuntimeSessionStatus, readonly RuntimeSessionStatus[]>> = {
  created: ['running'],
  running: ['completed', 'failed'],
  completed: [],
  failed: [],
}

const ATTEMPTS_DIR = 'attempts'
const ATTEMPT_STATUSES: readonly ExecutionAttemptStatus[] = ['created', 'running', 'completed', 'failed']
/** Valid execution attempt transitions: created → running → completed/failed. */
const ATTEMPT_TRANSITIONS: Readonly<Record<ExecutionAttemptStatus, readonly ExecutionAttemptStatus[]>> = {
  created: ['running'],
  running: ['completed', 'failed'],
  completed: [],
  failed: [],
}

const REVIEWS_DIR = 'reviews'
const REVIEW_STATUSES: readonly CommanderReviewStatus[] = ['pending', 'reviewed']
/** Valid commander review transitions: pending → reviewed. */
const REVIEW_TRANSITIONS: Readonly<Record<CommanderReviewStatus, readonly CommanderReviewStatus[]>> = {
  pending: ['reviewed'],
  reviewed: [],
}

const MEMORY_DIR = 'memory'
const MEMORY_TYPES: readonly CommanderMemoryType[] = ['project', 'decision', 'execution', 'preference']

const SCHEDULES_DIR = 'schedules'
const SCHEDULE_STATUSES: readonly CommanderScheduleStatus[] = ['active', 'paused']

const RUNS_DIR = 'runs'
const RUN_STATUSES: readonly CommanderRunStatus[] = ['running', 'completed', 'failed']
/** Valid commander run transitions: running → completed/failed (terminal). */
const RUN_TRANSITIONS: Readonly<Record<CommanderRunStatus, readonly CommanderRunStatus[]>> = {
  running: ['completed', 'failed'],
  completed: [],
  failed: [],
}

const ACTION_EXECUTIONS_DIR = 'action-executions'
const ACTION_EXECUTION_STATUSES: readonly CommanderActionExecutionStatus[] = ['running', 'completed', 'failed']
/** Valid commander action-execution transitions: running → completed/failed (terminal). */
const ACTION_EXECUTION_TRANSITIONS: Readonly<Record<CommanderActionExecutionStatus, readonly CommanderActionExecutionStatus[]>> = {
  running: ['completed', 'failed'],
  completed: [],
  failed: [],
}

const POLICIES_DIR = 'policies'
const RISK_LEVELS: readonly CommanderRiskLevel[] = ['low', 'medium', 'high']

const PROPOSALS_DIR = 'proposals'
const PROPOSAL_STATUSES: readonly CommanderProposalStatus[] = ['created', 'approved', 'rejected']
/** Valid commander proposal transitions: created → approved/rejected (terminal). */
const PROPOSAL_TRANSITIONS: Readonly<Record<CommanderProposalStatus, readonly CommanderProposalStatus[]>> = {
  created: ['approved', 'rejected'],
  approved: [],
  rejected: [],
}

const WORKFLOWS_DIR = 'workflows'
const WORKFLOW_STATUSES: readonly CommanderWorkflowStatus[] = ['created', 'running', 'completed', 'failed']
/** Valid commander workflow transitions: created → running → completed/failed (terminal). */
const WORKFLOW_TRANSITIONS: Readonly<Record<CommanderWorkflowStatus, readonly CommanderWorkflowStatus[]>> = {
  created: ['running'],
  running: ['completed', 'failed'],
  completed: [],
  failed: [],
}

const STEPS_DIR = 'steps'
const STEP_STATUSES: readonly CommanderStepStatus[] = ['pending', 'running', 'completed', 'failed']
/** Valid commander step transitions: pending → running → completed/failed (terminal). */
const STEP_TRANSITIONS: Readonly<Record<CommanderStepStatus, readonly CommanderStepStatus[]>> = {
  pending: ['running'],
  running: ['completed', 'failed'],
  completed: [],
  failed: [],
}

/**
 * Task update patch. Unlike a plain `Partial<Task>`, `assignedRole` may be
 * explicitly `undefined`, which clears the assignment; an omitted key leaves
 * it untouched.
 */
export type TaskUpdate = Partial<Omit<Task, 'id' | 'createdAt' | 'assignedRole'>> & {
  assignedRole?: AssignedRole | undefined
}

/**
 * Agent instance update patch. An omitted or `undefined` key leaves the
 * stored value untouched; the id and `createdAt` are immutable and
 * `updatedAt` is refreshed by the store.
 */
export type AgentInstanceUpdate = {
  role?: AssignedRole | undefined
  displayName?: string | undefined
  description?: string | undefined
  capabilities?: readonly string[] | undefined
  metadata?: Record<string, unknown> | undefined
}

/** Parse one stored JSON document; corrupted content fails loud, never silently drops. */
function parseJson(text: string, displayPath: string): unknown {
  try {
    return JSON.parse(text)
  } catch (cause) {
    throw new Error(`devflow: corrupted JSON in ${displayPath}`, { cause })
  }
}

/** Validate one project record at the durable-file boundary. */
function validateProject(value: unknown, displayPath: string): Project {
  if (!isRecord(value)) throw new Error(`devflow: invalid project record in ${displayPath}`)
  const { id, name, goal, currentStage, createdAt, updatedAt } = value
  if (!isString(id) || !isString(name) || !isString(goal) || !isString(currentStage)
    || !isString(createdAt) || !isString(updatedAt)) {
    throw new Error(`devflow: invalid project fields in ${displayPath}`)
  }
  return { id, name, goal, currentStage, createdAt, updatedAt }
}

/** Validate one task record at the durable-file boundary. */
function validateTask(value: unknown, displayPath: string): Task {
  if (!isRecord(value)) throw new Error(`devflow: invalid task record in ${displayPath}`)
  const { id, title, description, status, assignedRole, createdAt, updatedAt } = value
  if (!isString(id) || !isString(title) || !isString(description) || !isString(status)
    || !isString(createdAt) || !isString(updatedAt)) {
    throw new Error(`devflow: invalid task fields in ${displayPath}`)
  }
  if (!TASK_STATUSES.includes(status as TaskStatus)) {
    throw new Error(`devflow: invalid task status ${JSON.stringify(status)} in ${displayPath}`)
  }
  if (assignedRole !== undefined) {
    if (!ASSIGNED_ROLES.includes(assignedRole as AssignedRole)) {
      throw new Error(`devflow: invalid assigned role ${JSON.stringify(assignedRole)} in ${displayPath}`)
    }
  }
  return {
    id,
    title,
    description,
    status: status as TaskStatus,
    ...(assignedRole === undefined ? {} : { assignedRole: assignedRole as AssignedRole }),
    createdAt,
    updatedAt,
  }
}

/** Validate one result record at the durable-file boundary. */
function validateResult(value: unknown, displayPath: string): Result {
  if (!isRecord(value)) throw new Error(`devflow: invalid result record in ${displayPath}`)
  const { id, taskId, summary, changes, verification, issues, nextSteps, createdAt } = value
  if (!isString(id) || !isString(taskId) || !isString(summary) || !isString(createdAt)
    || !isStringArray(changes) || !isStringArray(verification) || !isStringArray(issues) || !isStringArray(nextSteps)) {
    throw new Error(`devflow: invalid result fields in ${displayPath}`)
  }
  return { id, taskId, summary, changes, verification, issues, nextSteps, createdAt }
}

/** Reject ids that could escape the per-kind directory before they enter a path. */
function assertUuid(id: string, kind: 'task' | 'result' | 'phase' | 'improvement' | 'checkpoint' | 'assignment' | 'planning' | 'batch' | 'execution' | 'report' | 'decision' | 'action' | 'session' | 'attempt' | 'review' | 'memory' | 'schedule' | 'run' | 'action-execution' | 'proposal' | 'workflow' | 'workflow-entry' | 'step'): void {
  if (!UUID_PATTERN.test(id)) {
    throw new Error(`devflow: invalid ${kind} id ${JSON.stringify(id)}`)
  }
}

/** Reject agent instance ids that are not lowercase slugs (also blocks path traversal). */
function assertAgentId(id: string): void {
  if (!AGENT_ID_PATTERN.test(id)) {
    throw new Error(`devflow: invalid agent instance id ${JSON.stringify(id)}; expected a lowercase slug`)
  }
}

/** Reject project ids that could escape the policies directory (also blocks path traversal). */
function assertProjectId(projectId: string): void {
  if (!AGENT_ID_PATTERN.test(projectId)) {
    throw new Error(`devflow: invalid project id ${JSON.stringify(projectId)}; expected a lowercase slug`)
  }
}

/** Validate one agent instance record at the durable-file boundary. */
function validateAgentInstance(value: unknown, displayPath: string): AgentInstance {
  if (!isRecord(value)) throw new Error(`devflow: invalid agent instance record in ${displayPath}`)
  const { id, role, displayName, description, capabilities, metadata, createdAt, updatedAt } = value
  if (!isString(id) || !AGENT_ID_PATTERN.test(id)) {
    throw new Error(`devflow: invalid agent instance id in ${displayPath}`)
  }
  if (!isString(role) || !ASSIGNED_ROLES.includes(role as AssignedRole)) {
    throw new Error(`devflow: invalid agent instance role ${JSON.stringify(role)} in ${displayPath}`)
  }
  if (!isString(displayName) || displayName.trim() === '') {
    throw new Error(`devflow: invalid agent instance displayName in ${displayPath}`)
  }
  if (description !== undefined && !isString(description)) {
    throw new Error(`devflow: invalid agent instance description in ${displayPath}`)
  }
  if (capabilities !== undefined && !isStringArray(capabilities)) {
    throw new Error(`devflow: invalid agent instance capabilities in ${displayPath}`)
  }
  if (metadata !== undefined && !isRecord(metadata)) {
    throw new Error(`devflow: invalid agent instance metadata in ${displayPath}`)
  }
  if (!isString(createdAt) || !isString(updatedAt)) {
    throw new Error(`devflow: invalid agent instance timestamps in ${displayPath}`)
  }
  return {
    id,
    role: role as AssignedRole,
    displayName,
    ...(description === undefined ? {} : { description }),
    ...(capabilities === undefined ? {} : { capabilities }),
    ...(metadata === undefined ? {} : { metadata }),
    createdAt,
    updatedAt,
  }
}

/** A tombstone marker for logically-removed records (fs has no delete primitive). */
function isTombstone(value: unknown): boolean {
  return isRecord(value) && value.removed === true
}

/** Validate one agent model-config record at the durable-file boundary. */
function validateModelConfig(value: unknown, displayPath: string): AgentModelConfig {
  if (!isRecord(value)) throw new Error(`devflow: invalid agent modelConfig in ${displayPath}`)
  const { model, provider, baseURL, apiKey, temperature, maxTokens, options } = value
  if (!isString(model) || model.trim() === '') {
    throw new Error(`devflow: invalid agent modelConfig.model in ${displayPath}`)
  }
  if (provider !== undefined && !isString(provider)) {
    throw new Error(`devflow: invalid agent modelConfig.provider in ${displayPath}`)
  }
  if (baseURL !== undefined && !isString(baseURL)) {
    throw new Error(`devflow: invalid agent modelConfig.baseURL in ${displayPath}`)
  }
  if (apiKey !== undefined && !isString(apiKey)) {
    throw new Error(`devflow: invalid agent modelConfig.apiKey in ${displayPath}`)
  }
  if (temperature !== undefined && typeof temperature !== 'number') {
    throw new Error(`devflow: invalid agent modelConfig.temperature in ${displayPath}`)
  }
  if (maxTokens !== undefined && typeof maxTokens !== 'number') {
    throw new Error(`devflow: invalid agent modelConfig.maxTokens in ${displayPath}`)
  }
  if (options !== undefined && !isRecord(options)) {
    throw new Error(`devflow: invalid agent modelConfig.options in ${displayPath}`)
  }
  return {
    model,
    ...(provider === undefined ? {} : { provider }),
    ...(baseURL === undefined ? {} : { baseURL }),
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(temperature === undefined ? {} : { temperature }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(options === undefined ? {} : { options }),
  }
}

/** Validate one orchestration agent record at the durable-file boundary. */
function validateOrchestrationAgent(value: unknown, displayPath: string): OrchestrationAgent {
  if (!isRecord(value)) throw new Error(`devflow: invalid orchestration agent record in ${displayPath}`)
  const {
    agentId, kind, role, status, prompt, modelConfig, tools, capabilities, skills, delegationDepth, createdAt, updatedAt,
  } = value
  if (!isString(agentId) || !AGENT_ID_PATTERN.test(agentId)) {
    throw new Error(`devflow: invalid orchestration agent id in ${displayPath}`)
  }
  if (!isString(kind) || !AGENT_KINDS.includes(kind as AgentKind)) {
    throw new Error(`devflow: invalid orchestration agent kind ${JSON.stringify(kind)} in ${displayPath}`)
  }
  if (!isString(role) || !ASSIGNED_ROLES.includes(role as AssignedRole)) {
    throw new Error(`devflow: invalid orchestration agent role ${JSON.stringify(role)} in ${displayPath}`)
  }
  const allowedStatuses = kind === 'fixed' ? FIXED_STATUSES : TEMPORARY_STATUSES
  if (!isString(status) || !allowedStatuses.includes(status as AgentLifecycleStatus)) {
    throw new Error(`devflow: invalid orchestration agent status ${JSON.stringify(status)} in ${displayPath}`)
  }
  if (!isString(prompt)) throw new Error(`devflow: invalid orchestration agent prompt in ${displayPath}`)
  if (!isStringArray(tools)) throw new Error(`devflow: invalid orchestration agent tools in ${displayPath}`)
  if (!isStringArray(capabilities)) throw new Error(`devflow: invalid orchestration agent capabilities in ${displayPath}`)
  if (!isStringArray(skills)) throw new Error(`devflow: invalid orchestration agent skills in ${displayPath}`)
  validateAgentSkills(skills, displayPath)
  if (typeof delegationDepth !== 'number' || !Number.isSafeInteger(delegationDepth) || delegationDepth < 0) {
    throw new Error(`devflow: invalid orchestration agent delegationDepth in ${displayPath}`)
  }
  if (!isString(createdAt) || !isString(updatedAt)) {
    throw new Error(`devflow: invalid orchestration agent timestamps in ${displayPath}`)
  }
  return {
    agentId,
    kind: kind as AgentKind,
    role: role as AssignedRole,
    status: status as AgentLifecycleStatus,
    prompt,
    modelConfig: validateModelConfig(modelConfig, displayPath),
    tools,
    capabilities,
    skills,
    delegationDepth,
    createdAt,
    updatedAt,
  }
}

/** Validate one MVP plan record at the durable-file boundary. */
function validateMvpPlan(value: unknown, displayPath: string): MvpPlan {
  if (!isRecord(value)) throw new Error(`devflow: invalid mvp plan record in ${displayPath}`)
  const { goal, scope, phaseIds, createdAt, updatedAt } = value
  if (!isString(goal) || !isStringArray(scope) || !isStringArray(phaseIds)
    || !isString(createdAt) || !isString(updatedAt)) {
    throw new Error(`devflow: invalid mvp plan fields in ${displayPath}`)
  }
  return { goal, scope, phaseIds, createdAt, updatedAt }
}

/** Validate one phase record at the durable-file boundary. */
function validatePhase(value: unknown, displayPath: string): Phase {
  if (!isRecord(value)) throw new Error(`devflow: invalid phase record in ${displayPath}`)
  const { id, name, description, status, createdAt, updatedAt } = value
  if (!isString(id) || !isString(name) || !isString(description) || !isString(status)
    || !isString(createdAt) || !isString(updatedAt)) {
    throw new Error(`devflow: invalid phase fields in ${displayPath}`)
  }
  if (!PHASE_STATUSES.includes(status as PhaseStatus)) {
    throw new Error(`devflow: invalid phase status ${JSON.stringify(status)} in ${displayPath}`)
  }
  return { id, name, description, status: status as PhaseStatus, createdAt, updatedAt }
}

/** Validate one scope guard record at the durable-file boundary. */
function validateScopeGuard(value: unknown, displayPath: string): ScopeGuard {
  if (!isRecord(value)) throw new Error(`devflow: invalid scope guard record in ${displayPath}`)
  const { summary, inScope, maxModifiedFiles, maxToolSteps, completionCriteria, createdAt, updatedAt } = value
  if (!isString(summary) || !isStringArray(inScope) || !isString(createdAt) || !isString(updatedAt)) {
    throw new Error(`devflow: invalid scope guard fields in ${displayPath}`)
  }
  if (typeof maxModifiedFiles !== 'number' || !Number.isSafeInteger(maxModifiedFiles) || maxModifiedFiles < 1) {
    throw new Error(`devflow: invalid scope guard maxModifiedFiles in ${displayPath}`)
  }
  if (typeof maxToolSteps !== 'number' || !Number.isSafeInteger(maxToolSteps) || maxToolSteps < 1) {
    throw new Error(`devflow: invalid scope guard maxToolSteps in ${displayPath}`)
  }
  if (!isStringArray(completionCriteria) || completionCriteria.length === 0
    || completionCriteria.some(criterion => criterion.trim() === '')) {
    throw new Error(`devflow: invalid scope guard completionCriteria in ${displayPath}`)
  }
  return { summary, inScope, maxModifiedFiles, maxToolSteps, completionCriteria, createdAt, updatedAt }
}

/** Validate one improvement record at the durable-file boundary. */
function validateImprovement(value: unknown, displayPath: string): Improvement {
  if (!isRecord(value)) throw new Error(`devflow: invalid improvement record in ${displayPath}`)
  const { id, title, description, createdAt } = value
  if (!isString(id) || !isString(title) || !isString(description) || !isString(createdAt)) {
    throw new Error(`devflow: invalid improvement fields in ${displayPath}`)
  }
  return { id, title, description, createdAt }
}

/** Validate one commander checkpoint record at the durable-file boundary. */
function validateCommanderCheckpoint(value: unknown, displayPath: string): CommanderCheckpoint {
  if (!isRecord(value)) throw new Error(`devflow: invalid commander checkpoint record in ${displayPath}`)
  const {
    checkpointId, projectId, currentMvp, currentIteration, currentPhase, currentTask,
    completedItems, decisions, nextSteps, createdAt, updatedAt,
  } = value
  if (!isString(checkpointId)) throw new Error(`devflow: invalid commander checkpoint id in ${displayPath}`)
  if (!isString(projectId)) throw new Error(`devflow: invalid commander checkpoint projectId in ${displayPath}`)
  if (currentMvp !== null && !isString(currentMvp)) {
    throw new Error(`devflow: invalid commander checkpoint currentMvp in ${displayPath}`)
  }
  if (currentIteration !== null && !isString(currentIteration)) {
    throw new Error(`devflow: invalid commander checkpoint currentIteration in ${displayPath}`)
  }
  if (currentPhase !== null && !isString(currentPhase)) {
    throw new Error(`devflow: invalid commander checkpoint currentPhase in ${displayPath}`)
  }
  if (currentTask !== null && !isString(currentTask)) {
    throw new Error(`devflow: invalid commander checkpoint currentTask in ${displayPath}`)
  }
  if (!isStringArray(completedItems) || !isStringArray(decisions) || !isStringArray(nextSteps)) {
    throw new Error(`devflow: invalid commander checkpoint string-array fields in ${displayPath}`)
  }
  if (!isString(createdAt) || !isString(updatedAt)) {
    throw new Error(`devflow: invalid commander checkpoint timestamps in ${displayPath}`)
  }
  return {
    checkpointId, projectId, currentMvp, currentIteration, currentPhase, currentTask,
    completedItems, decisions, nextSteps, createdAt, updatedAt,
  }
}

/** Validate one phase-assignment record at the durable-file boundary. */
function validatePhaseAssignment(value: unknown, displayPath: string): PhaseAssignment {
  if (!isRecord(value)) throw new Error(`devflow: invalid phase assignment record in ${displayPath}`)
  const { assignmentId, taskId, phaseId, agentId, role, status, closedAt, closeReason, createdAt, updatedAt } = value
  if (!isString(assignmentId)) throw new Error(`devflow: invalid phase assignment id in ${displayPath}`)
  if (taskId !== undefined && (!isString(taskId) || taskId.trim() === '')) {
    throw new Error(`devflow: invalid phase assignment taskId in ${displayPath}`)
  }
  if (!isString(phaseId)) throw new Error(`devflow: invalid phase assignment phaseId in ${displayPath}`)
  if (!isString(agentId) || !AGENT_ID_PATTERN.test(agentId)) {
    throw new Error(`devflow: invalid phase assignment agentId in ${displayPath}`)
  }
  if (!isString(role) || !ASSIGNED_ROLES.includes(role as AssignedRole)) {
    throw new Error(`devflow: invalid phase assignment role ${JSON.stringify(role)} in ${displayPath}`)
  }
  if (!isString(status) || !ASSIGNMENT_STATUSES.includes(status as AssignmentStatus)) {
    throw new Error(`devflow: invalid phase assignment status ${JSON.stringify(status)} in ${displayPath}`)
  }
  // The close stamp is EXACTLY the `closed` state: both fields together or neither.
  if (status === 'closed') {
    if (!isString(closedAt) || !isDevFlowCloseReason(closeReason)) {
      throw new Error(`devflow: closed phase assignment must carry closedAt and a close reason in ${displayPath}`)
    }
  } else if (closedAt !== undefined || closeReason !== undefined) {
    throw new Error(`devflow: phase assignment carries a close stamp without being closed in ${displayPath}`)
  }
  if (!isString(createdAt) || !isString(updatedAt)) {
    throw new Error(`devflow: invalid phase assignment timestamps in ${displayPath}`)
  }
  return {
    assignmentId, ...(taskId === undefined ? {} : { taskId }), phaseId, agentId,
    role: role as AssignedRole,
    status: status as AssignmentStatus,
    ...(status === 'closed' ? { closedAt: closedAt as string, closeReason: closeReason as DevFlowCloseReason } : {}),
    createdAt, updatedAt,
  }
}

/** Validate one commander plan record at the durable-file boundary. */
function validateCommanderPlan(value: unknown, displayPath: string): CommanderPlan {
  if (!isRecord(value)) throw new Error(`devflow: invalid commander plan record in ${displayPath}`)
  const { planningId, projectId, goal, status, mvpPlanId, createdAt, updatedAt } = value
  if (!isString(planningId)) throw new Error(`devflow: invalid commander plan id in ${displayPath}`)
  if (!isString(projectId)) throw new Error(`devflow: invalid commander plan projectId in ${displayPath}`)
  if (!isString(goal)) throw new Error(`devflow: invalid commander plan goal in ${displayPath}`)
  if (!isString(status) || !COMMANDER_PLAN_STATUSES.includes(status as CommanderPlanStatus)) {
    throw new Error(`devflow: invalid commander plan status ${JSON.stringify(status)} in ${displayPath}`)
  }
  if (mvpPlanId !== null && !isString(mvpPlanId)) {
    throw new Error(`devflow: invalid commander plan mvpPlanId in ${displayPath}`)
  }
  if (!isString(createdAt) || !isString(updatedAt)) {
    throw new Error(`devflow: invalid commander plan timestamps in ${displayPath}`)
  }
  return {
    planningId, projectId, goal,
    status: status as CommanderPlanStatus,
    mvpPlanId, createdAt, updatedAt,
  }
}

/** Validate one execution batch record at the durable-file boundary. */
function validateExecutionBatch(value: unknown, displayPath: string): ExecutionBatch {
  if (!isRecord(value)) throw new Error(`devflow: invalid execution batch record in ${displayPath}`)
  const { batchId, projectId, planningId, phaseIds, assignmentIds, status, createdAt, updatedAt } = value
  if (!isString(batchId)) throw new Error(`devflow: invalid execution batch id in ${displayPath}`)
  if (!isString(projectId)) throw new Error(`devflow: invalid execution batch projectId in ${displayPath}`)
  if (!isString(planningId)) throw new Error(`devflow: invalid execution batch planningId in ${displayPath}`)
  if (!isStringArray(phaseIds)) throw new Error(`devflow: invalid execution batch phaseIds in ${displayPath}`)
  if (!isStringArray(assignmentIds)) throw new Error(`devflow: invalid execution batch assignmentIds in ${displayPath}`)
  if (!isString(status) || !EXECUTION_BATCH_STATUSES.includes(status as ExecutionBatchStatus)) {
    throw new Error(`devflow: invalid execution batch status ${JSON.stringify(status)} in ${displayPath}`)
  }
  if (!isString(createdAt) || !isString(updatedAt)) {
    throw new Error(`devflow: invalid execution batch timestamps in ${displayPath}`)
  }
  return {
    batchId, projectId, planningId, phaseIds, assignmentIds,
    status: status as ExecutionBatchStatus,
    createdAt, updatedAt,
  }
}

/** Validate an optional task-level ScopeGuard override at the durable-file boundary. */
function validateTaskScopeGuard(value: unknown, displayPath: string): import('./types.ts').TaskScopeGuard | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new Error(`devflow: invalid task scope guard in ${displayPath}`)
  const { maxModifiedFiles, maxToolSteps, completionCriteria } = value
  if (typeof maxModifiedFiles !== 'number' || !Number.isSafeInteger(maxModifiedFiles) || maxModifiedFiles < 1
    || typeof maxToolSteps !== 'number' || !Number.isSafeInteger(maxToolSteps) || maxToolSteps < 1
    || !isStringArray(completionCriteria) || completionCriteria.length === 0
    || completionCriteria.some(criterion => criterion.trim() === '')) {
    throw new Error(`devflow: invalid task scope guard fields in ${displayPath}`)
  }
  return { maxModifiedFiles, maxToolSteps, completionCriteria }
}

/** Validate one execution record at the durable-file boundary. */
function validateExecutionRecord(value: unknown, displayPath: string): ExecutionRecord {
  if (!isRecord(value)) throw new Error(`devflow: invalid execution record in ${displayPath}`)
  const { executionId, batchId, assignmentId, agentId, taskId, scopeGuard, status, startedAt, completedAt, closedAt, closeReason, createdAt, updatedAt } = value
  if (!isString(executionId)) throw new Error(`devflow: invalid execution id in ${displayPath}`)
  if (!isString(batchId)) throw new Error(`devflow: invalid execution batchId in ${displayPath}`)
  if (!isString(assignmentId)) throw new Error(`devflow: invalid execution assignmentId in ${displayPath}`)
  if (!isString(agentId) || !AGENT_ID_PATTERN.test(agentId)) {
    throw new Error(`devflow: invalid execution agentId in ${displayPath}`)
  }
  if (taskId !== undefined && (!isString(taskId) || taskId.trim() === '')) {
    throw new Error(`devflow: invalid execution taskId in ${displayPath}`)
  }
  const validatedScopeGuard = validateTaskScopeGuard(scopeGuard, displayPath)
  if (!isString(status) || !EXECUTION_STATUSES.includes(status as ExecutionStatus)) {
    throw new Error(`devflow: invalid execution status ${JSON.stringify(status)} in ${displayPath}`)
  }
  if (startedAt !== null && !isString(startedAt)) throw new Error(`devflow: invalid execution startedAt in ${displayPath}`)
  if (completedAt !== null && !isString(completedAt)) throw new Error(`devflow: invalid execution completedAt in ${displayPath}`)
  // The close stamp is EXACTLY the `closed` state: both fields together or neither.
  if (status === 'closed') {
    if (!isString(closedAt) || !isDevFlowCloseReason(closeReason)) {
      throw new Error(`devflow: closed execution must carry closedAt and a close reason in ${displayPath}`)
    }
  } else if (closedAt !== undefined || closeReason !== undefined) {
    throw new Error(`devflow: execution carries a close stamp without being closed in ${displayPath}`)
  }
  if (!isString(createdAt) || !isString(updatedAt)) throw new Error(`devflow: invalid execution timestamps in ${displayPath}`)
  return {
    executionId, batchId, assignmentId, agentId,
    ...(taskId === undefined ? {} : { taskId }),
    ...(validatedScopeGuard === undefined ? {} : { scopeGuard: validatedScopeGuard }),
    status: status as ExecutionStatus,
    startedAt, completedAt,
    ...(status === 'closed' ? { closedAt: closedAt as string, closeReason: closeReason as DevFlowCloseReason } : {}),
    createdAt, updatedAt,
  }
}

/** Validate one agent report record at the durable-file boundary. */
function validateAgentReport(value: unknown, displayPath: string): AgentReport {
  if (!isRecord(value)) throw new Error(`devflow: invalid agent report record in ${displayPath}`)
  const {
    reportId, executionId, agentId, status, summary, outputReference,
    modifiedFiles, toolStepCount, completedCriteria, createdAt, updatedAt,
  } = value
  if (!isString(reportId)) throw new Error(`devflow: invalid agent report id in ${displayPath}`)
  if (!isString(executionId)) throw new Error(`devflow: invalid agent report executionId in ${displayPath}`)
  if (!isString(agentId) || !AGENT_ID_PATTERN.test(agentId)) {
    throw new Error(`devflow: invalid agent report agentId in ${displayPath}`)
  }
  if (!isString(status) || !AGENT_REPORT_STATUSES.includes(status as AgentReportStatus)) {
    throw new Error(`devflow: invalid agent report status ${JSON.stringify(status)} in ${displayPath}`)
  }
  if (!isString(summary)) throw new Error(`devflow: invalid agent report summary in ${displayPath}`)
  if (!isString(outputReference)) throw new Error(`devflow: invalid agent report outputReference in ${displayPath}`)
  if (modifiedFiles !== undefined && !isStringArray(modifiedFiles)) {
    throw new Error(`devflow: invalid agent report modifiedFiles in ${displayPath}`)
  }
  if (toolStepCount !== undefined && (typeof toolStepCount !== 'number'
    || !Number.isSafeInteger(toolStepCount) || toolStepCount < 0)) {
    throw new Error(`devflow: invalid agent report toolStepCount in ${displayPath}`)
  }
  if (completedCriteria !== undefined && !isStringArray(completedCriteria)) {
    throw new Error(`devflow: invalid agent report completedCriteria in ${displayPath}`)
  }
  if (!isString(createdAt) || !isString(updatedAt)) throw new Error(`devflow: invalid agent report timestamps in ${displayPath}`)
  return {
    reportId, executionId, agentId,
    status: status as AgentReportStatus,
    summary, outputReference,
    ...(modifiedFiles === undefined ? {} : { modifiedFiles }),
    ...(toolStepCount === undefined ? {} : { toolStepCount }),
    ...(completedCriteria === undefined ? {} : { completedCriteria }),
    createdAt, updatedAt,
  }
}

/** Validate one commander decision record at the durable-file boundary. */
function validateCommanderDecision(value: unknown, displayPath: string): CommanderDecision {
  if (!isRecord(value)) throw new Error(`devflow: invalid commander decision record in ${displayPath}`)
  const {
    decisionId, projectId, checkpointId, relatedExecutionIds, decisionType, summary, nextAction,
    createdAt, updatedAt,
  } = value
  if (!isString(decisionId)) throw new Error(`devflow: invalid commander decision id in ${displayPath}`)
  if (!isString(projectId)) throw new Error(`devflow: invalid commander decision projectId in ${displayPath}`)
  if (checkpointId !== null && !isString(checkpointId)) {
    throw new Error(`devflow: invalid commander decision checkpointId in ${displayPath}`)
  }
  if (!isStringArray(relatedExecutionIds)) {
    throw new Error(`devflow: invalid commander decision relatedExecutionIds in ${displayPath}`)
  }
  if (!isString(decisionType) || !DECISION_TYPES.includes(decisionType as CommanderDecisionType)) {
    throw new Error(`devflow: invalid commander decision type ${JSON.stringify(decisionType)} in ${displayPath}`)
  }
  if (!isString(summary)) throw new Error(`devflow: invalid commander decision summary in ${displayPath}`)
  if (!isString(nextAction)) throw new Error(`devflow: invalid commander decision nextAction in ${displayPath}`)
  if (!isString(createdAt) || !isString(updatedAt)) {
    throw new Error(`devflow: invalid commander decision timestamps in ${displayPath}`)
  }
  return {
    decisionId, projectId, checkpointId, relatedExecutionIds,
    decisionType: decisionType as CommanderDecisionType,
    summary, nextAction, createdAt, updatedAt,
  }
}

/** Validate one commander control action record at the durable-file boundary. */
function validateCommanderAction(value: unknown, displayPath: string): CommanderAction {
  if (!isRecord(value)) throw new Error(`devflow: invalid commander action record in ${displayPath}`)
  const { actionId, decisionId, actionType, targetId, status, createdAt, updatedAt } = value
  if (!isString(actionId)) throw new Error(`devflow: invalid commander action id in ${displayPath}`)
  if (!isString(decisionId)) throw new Error(`devflow: invalid commander action decisionId in ${displayPath}`)
  if (!isString(actionType) || !ACTION_TYPES.includes(actionType as CommanderActionType)) {
    throw new Error(`devflow: invalid commander action type ${JSON.stringify(actionType)} in ${displayPath}`)
  }
  if (!isString(targetId) || targetId.trim() === '') {
    throw new Error(`devflow: invalid commander action targetId in ${displayPath}`)
  }
  if (!isString(status) || !ACTION_STATUSES.includes(status as CommanderActionStatus)) {
    throw new Error(`devflow: invalid commander action status ${JSON.stringify(status)} in ${displayPath}`)
  }
  if (!isString(createdAt) || !isString(updatedAt)) {
    throw new Error(`devflow: invalid commander action timestamps in ${displayPath}`)
  }
  return {
    actionId, decisionId,
    actionType: actionType as CommanderActionType,
    targetId,
    status: status as CommanderActionStatus,
    createdAt, updatedAt,
  }
}

/** Validate one runtime session record at the durable-file boundary. */
function validateRuntimeSession(value: unknown, displayPath: string): RuntimeSession {
  if (!isRecord(value)) throw new Error(`devflow: invalid runtime session record in ${displayPath}`)
  const { sessionId, executionId, agentId, status, startedAt, completedAt, metadata, createdAt, updatedAt } = value
  if (!isString(sessionId)) throw new Error(`devflow: invalid runtime session id in ${displayPath}`)
  if (!isString(executionId)) throw new Error(`devflow: invalid runtime session executionId in ${displayPath}`)
  if (!isString(agentId) || !AGENT_ID_PATTERN.test(agentId)) {
    throw new Error(`devflow: invalid runtime session agentId in ${displayPath}`)
  }
  if (!isString(status) || !RUNTIME_SESSION_STATUSES.includes(status as RuntimeSessionStatus)) {
    throw new Error(`devflow: invalid runtime session status ${JSON.stringify(status)} in ${displayPath}`)
  }
  if (startedAt !== null && !isString(startedAt)) {
    throw new Error(`devflow: invalid runtime session startedAt in ${displayPath}`)
  }
  if (completedAt !== null && !isString(completedAt)) {
    throw new Error(`devflow: invalid runtime session completedAt in ${displayPath}`)
  }
  if (!isRecord(metadata)) throw new Error(`devflow: invalid runtime session metadata in ${displayPath}`)
  if (!isString(createdAt) || !isString(updatedAt)) {
    throw new Error(`devflow: invalid runtime session timestamps in ${displayPath}`)
  }
  return {
    sessionId, executionId, agentId,
    status: status as RuntimeSessionStatus,
    startedAt, completedAt, metadata, createdAt, updatedAt,
  }
}

/** Validate one execution attempt record at the durable-file boundary. */
function validateExecutionAttempt(value: unknown, displayPath: string): ExecutionAttempt {
  if (!isRecord(value)) throw new Error(`devflow: invalid execution attempt record in ${displayPath}`)
  const { attemptId, executionId, parentAttemptId, status, reason, createdAt, completedAt, updatedAt } = value
  if (!isString(attemptId)) throw new Error(`devflow: invalid execution attempt id in ${displayPath}`)
  if (!isString(executionId)) throw new Error(`devflow: invalid execution attempt executionId in ${displayPath}`)
  if (parentAttemptId !== null && !isString(parentAttemptId)) {
    throw new Error(`devflow: invalid execution attempt parentAttemptId in ${displayPath}`)
  }
  if (!isString(status) || !ATTEMPT_STATUSES.includes(status as ExecutionAttemptStatus)) {
    throw new Error(`devflow: invalid execution attempt status ${JSON.stringify(status)} in ${displayPath}`)
  }
  if (reason !== null && !isString(reason)) {
    throw new Error(`devflow: invalid execution attempt reason in ${displayPath}`)
  }
  if (!isString(createdAt)) throw new Error(`devflow: invalid execution attempt createdAt in ${displayPath}`)
  if (completedAt !== null && !isString(completedAt)) {
    throw new Error(`devflow: invalid execution attempt completedAt in ${displayPath}`)
  }
  if (!isString(updatedAt)) throw new Error(`devflow: invalid execution attempt updatedAt in ${displayPath}`)
  return {
    attemptId, executionId, parentAttemptId,
    status: status as ExecutionAttemptStatus,
    reason, createdAt, completedAt, updatedAt,
  }
}

/** Validate one commander review record at the durable-file boundary. */
function validateCommanderReview(value: unknown, displayPath: string): CommanderReview {
  if (!isRecord(value)) throw new Error(`devflow: invalid commander review record in ${displayPath}`)
  const { reviewId, projectId, reportId, executionId, status, summary, createdAt, updatedAt } = value
  if (!isString(reviewId)) throw new Error(`devflow: invalid commander review id in ${displayPath}`)
  if (!isString(projectId)) throw new Error(`devflow: invalid commander review projectId in ${displayPath}`)
  if (!isString(reportId)) throw new Error(`devflow: invalid commander review reportId in ${displayPath}`)
  if (!isString(executionId)) throw new Error(`devflow: invalid commander review executionId in ${displayPath}`)
  if (!isString(status) || !REVIEW_STATUSES.includes(status as CommanderReviewStatus)) {
    throw new Error(`devflow: invalid commander review status ${JSON.stringify(status)} in ${displayPath}`)
  }
  if (!isString(summary)) throw new Error(`devflow: invalid commander review summary in ${displayPath}`)
  if (!isString(createdAt) || !isString(updatedAt)) {
    throw new Error(`devflow: invalid commander review timestamps in ${displayPath}`)
  }
  return {
    reviewId, projectId, reportId, executionId,
    status: status as CommanderReviewStatus,
    summary, createdAt, updatedAt,
  }
}

/** Validate one commander memory record at the durable-file boundary. */
function validateCommanderMemory(value: unknown, displayPath: string): CommanderMemory {
  if (!isRecord(value)) throw new Error(`devflow: invalid commander memory record in ${displayPath}`)
  const { memoryId, projectId, memoryType, content, source, createdAt, updatedAt } = value
  if (!isString(memoryId)) throw new Error(`devflow: invalid commander memory id in ${displayPath}`)
  if (!isString(projectId)) throw new Error(`devflow: invalid commander memory projectId in ${displayPath}`)
  if (!isString(memoryType) || !MEMORY_TYPES.includes(memoryType as CommanderMemoryType)) {
    throw new Error(`devflow: invalid commander memory type ${JSON.stringify(memoryType)} in ${displayPath}`)
  }
  if (!isString(content) || content.trim() === '') {
    throw new Error(`devflow: invalid commander memory content in ${displayPath}`)
  }
  if (!isString(source) || source.trim() === '') {
    throw new Error(`devflow: invalid commander memory source in ${displayPath}`)
  }
  if (!isString(createdAt) || !isString(updatedAt)) {
    throw new Error(`devflow: invalid commander memory timestamps in ${displayPath}`)
  }
  return {
    memoryId, projectId,
    memoryType: memoryType as CommanderMemoryType,
    content, source, createdAt, updatedAt,
  }
}

/** Validate one commander schedule record at the durable-file boundary. */
function validateCommanderSchedule(value: unknown, displayPath: string): CommanderSchedule {
  if (!isRecord(value)) throw new Error(`devflow: invalid commander schedule record in ${displayPath}`)
  const { scheduleId, projectId, status, interval, lastRunAt, nextRunAt, createdAt, updatedAt } = value
  if (!isString(scheduleId)) throw new Error(`devflow: invalid commander schedule id in ${displayPath}`)
  if (!isString(projectId)) throw new Error(`devflow: invalid commander schedule projectId in ${displayPath}`)
  if (!isString(status) || !SCHEDULE_STATUSES.includes(status as CommanderScheduleStatus)) {
    throw new Error(`devflow: invalid commander schedule status ${JSON.stringify(status)} in ${displayPath}`)
  }
  if (typeof interval !== 'number' || !Number.isFinite(interval) || interval <= 0) {
    throw new Error(`devflow: invalid commander schedule interval in ${displayPath}`)
  }
  if (lastRunAt !== null && !isString(lastRunAt)) {
    throw new Error(`devflow: invalid commander schedule lastRunAt in ${displayPath}`)
  }
  if (!isString(nextRunAt)) throw new Error(`devflow: invalid commander schedule nextRunAt in ${displayPath}`)
  if (!isString(createdAt) || !isString(updatedAt)) {
    throw new Error(`devflow: invalid commander schedule timestamps in ${displayPath}`)
  }
  return {
    scheduleId, projectId,
    status: status as CommanderScheduleStatus,
    interval, lastRunAt, nextRunAt, createdAt, updatedAt,
  }
}

/**
 * Apply one schedule patch: an interval change or a completed-run stamp rolls
 * `nextRunAt` forward from the last run (or the patch time when no run exists).
 * @param existing - the schedule being patched.
 * @param patch - the fields to apply; omitted keys stay untouched.
 * @param at - the patch time (ISO 8601).
 * @returns the updated schedule.
 */
function applySchedulePatch(existing: CommanderSchedule, patch: CommanderScheduleUpdate, at: string): CommanderSchedule {
  const interval = patch.interval ?? existing.interval
  const lastRunAt = patch.markRunAt !== undefined ? patch.markRunAt : existing.lastRunAt
  const rollBase = patch.markRunAt !== undefined ? patch.markRunAt : (lastRunAt ?? at)
  const nextRunAt = (patch.interval !== undefined || patch.markRunAt !== undefined)
    ? new Date(Date.parse(rollBase) + interval).toISOString()
    : existing.nextRunAt
  return { ...existing, interval, lastRunAt, nextRunAt, updatedAt: at }
}

/** Validate one commander run record at the durable-file boundary. */
function validateCommanderRunRecord(value: unknown, displayPath: string): CommanderRunRecord {
  if (!isRecord(value)) throw new Error(`devflow: invalid commander run record in ${displayPath}`)
  const { runId, projectId, scheduleId, status, decisionId, actionId, startedAt, completedAt, updatedAt } = value
  if (!isString(runId)) throw new Error(`devflow: invalid commander run id in ${displayPath}`)
  if (!isString(projectId)) throw new Error(`devflow: invalid commander run projectId in ${displayPath}`)
  if (!isString(scheduleId)) throw new Error(`devflow: invalid commander run scheduleId in ${displayPath}`)
  if (!isString(status) || !RUN_STATUSES.includes(status as CommanderRunStatus)) {
    throw new Error(`devflow: invalid commander run status ${JSON.stringify(status)} in ${displayPath}`)
  }
  if (decisionId !== null && !isString(decisionId)) {
    throw new Error(`devflow: invalid commander run decisionId in ${displayPath}`)
  }
  if (actionId !== null && !isString(actionId)) {
    throw new Error(`devflow: invalid commander run actionId in ${displayPath}`)
  }
  if (!isString(startedAt)) throw new Error(`devflow: invalid commander run startedAt in ${displayPath}`)
  if (completedAt !== null && !isString(completedAt)) {
    throw new Error(`devflow: invalid commander run completedAt in ${displayPath}`)
  }
  if (!isString(updatedAt)) throw new Error(`devflow: invalid commander run updatedAt in ${displayPath}`)
  return {
    runId, projectId, scheduleId,
    status: status as CommanderRunStatus,
    decisionId, actionId, startedAt, completedAt, updatedAt,
  }
}

/** Validate one commander action execution record at the durable-file boundary. */
function validateCommanderActionExecution(value: unknown, displayPath: string): CommanderActionExecutionRecord {
  if (!isRecord(value)) throw new Error(`devflow: invalid commander action execution record in ${displayPath}`)
  const { executionId, actionId, status, success, error, createdAt, completedAt, updatedAt } = value
  if (!isString(executionId)) throw new Error(`devflow: invalid commander action execution id in ${displayPath}`)
  if (!isString(actionId)) throw new Error(`devflow: invalid commander action execution actionId in ${displayPath}`)
  if (!isString(status) || !ACTION_EXECUTION_STATUSES.includes(status as CommanderActionExecutionStatus)) {
    throw new Error(`devflow: invalid commander action execution status ${JSON.stringify(status)} in ${displayPath}`)
  }
  if (success !== null && typeof success !== 'boolean') {
    throw new Error(`devflow: invalid commander action execution success in ${displayPath}`)
  }
  if (error !== null && !isString(error)) {
    throw new Error(`devflow: invalid commander action execution error in ${displayPath}`)
  }
  if (!isString(createdAt)) throw new Error(`devflow: invalid commander action execution createdAt in ${displayPath}`)
  if (completedAt !== null && !isString(completedAt)) {
    throw new Error(`devflow: invalid commander action execution completedAt in ${displayPath}`)
  }
  if (!isString(updatedAt)) throw new Error(`devflow: invalid commander action execution updatedAt in ${displayPath}`)
  return {
    executionId, actionId,
    status: status as CommanderActionExecutionStatus,
    success, error, createdAt, completedAt, updatedAt,
  }
}

/** Validate one commander policy record at the durable-file boundary. */
function validateCommanderPolicy(value: unknown, displayPath: string): CommanderPolicy {
  if (!isRecord(value)) throw new Error(`devflow: invalid commander policy record in ${displayPath}`)
  const { projectId, maxRetryCount, allowedActionTypes, requireApprovalActionTypes, riskLevel, createdAt, updatedAt } = value
  if (!isString(projectId) || !AGENT_ID_PATTERN.test(projectId)) {
    throw new Error(`devflow: invalid commander policy projectId in ${displayPath}`)
  }
  if (typeof maxRetryCount !== 'number' || !Number.isInteger(maxRetryCount) || maxRetryCount < 0) {
    throw new Error(`devflow: invalid commander policy maxRetryCount in ${displayPath}`)
  }
  if (!isStringArray(allowedActionTypes) || !allowedActionTypes.every(type => ACTION_TYPES.includes(type as CommanderActionType))) {
    throw new Error(`devflow: invalid commander policy allowedActionTypes in ${displayPath}`)
  }
  if (!isStringArray(requireApprovalActionTypes)
    || !requireApprovalActionTypes.every(type => ACTION_TYPES.includes(type as CommanderActionType))) {
    throw new Error(`devflow: invalid commander policy requireApprovalActionTypes in ${displayPath}`)
  }
  if (!isString(riskLevel) || !RISK_LEVELS.includes(riskLevel as CommanderRiskLevel)) {
    throw new Error(`devflow: invalid commander policy riskLevel in ${displayPath}`)
  }
  if (!isString(createdAt) || !isString(updatedAt)) {
    throw new Error(`devflow: invalid commander policy timestamps in ${displayPath}`)
  }
  return {
    projectId, maxRetryCount,
    allowedActionTypes: allowedActionTypes as CommanderActionType[],
    requireApprovalActionTypes: requireApprovalActionTypes as CommanderActionType[],
    riskLevel: riskLevel as CommanderRiskLevel, createdAt, updatedAt,
  }
}

/** Validate one commander proposal record at the durable-file boundary. */
function validateCommanderProposal(value: unknown, displayPath: string): CommanderProposal {
  if (!isRecord(value)) throw new Error(`devflow: invalid commander proposal record in ${displayPath}`)
  const { proposalId, decisionId, actionType, targetId, riskLevel, status, createdAt, updatedAt } = value
  if (!isString(proposalId)) throw new Error(`devflow: invalid commander proposal id in ${displayPath}`)
  if (!isString(decisionId)) throw new Error(`devflow: invalid commander proposal decisionId in ${displayPath}`)
  if (!isString(actionType) || !ACTION_TYPES.includes(actionType as CommanderActionType)) {
    throw new Error(`devflow: invalid commander proposal actionType in ${displayPath}`)
  }
  if (!isString(targetId) || targetId.trim() === '') {
    throw new Error(`devflow: invalid commander proposal targetId in ${displayPath}`)
  }
  if (!isString(riskLevel) || !RISK_LEVELS.includes(riskLevel as CommanderRiskLevel)) {
    throw new Error(`devflow: invalid commander proposal riskLevel in ${displayPath}`)
  }
  if (!isString(status) || !PROPOSAL_STATUSES.includes(status as CommanderProposalStatus)) {
    throw new Error(`devflow: invalid commander proposal status in ${displayPath}`)
  }
  if (!isString(createdAt) || !isString(updatedAt)) {
    throw new Error(`devflow: invalid commander proposal timestamps in ${displayPath}`)
  }
  return {
    proposalId, decisionId,
    actionType: actionType as CommanderActionType,
    targetId,
    riskLevel: riskLevel as CommanderRiskLevel,
    status: status as CommanderProposalStatus,
    createdAt, updatedAt,
  }
}

/** Validate one workflow execution-history entry at the durable-file boundary. */
function validateCommanderWorkflowExecution(value: unknown, displayPath: string): CommanderWorkflowExecution {
  if (!isRecord(value)) throw new Error(`devflow: invalid workflow execution entry in ${displayPath}`)
  const { entryId, stepId, decisionId, proposalId, approved, contextId, actionExecutionId, result, feedbackId, createdAt } = value
  if (!isString(entryId)) throw new Error(`devflow: invalid workflow execution entryId in ${displayPath}`)
  if (stepId !== null && !isString(stepId)) {
    throw new Error(`devflow: invalid workflow execution stepId in ${displayPath}`)
  }
  if (!isString(decisionId)) throw new Error(`devflow: invalid workflow execution decisionId in ${displayPath}`)
  if (proposalId !== null && !isString(proposalId)) {
    throw new Error(`devflow: invalid workflow execution proposalId in ${displayPath}`)
  }
  if (typeof approved !== 'boolean') throw new Error(`devflow: invalid workflow execution approved in ${displayPath}`)
  if (contextId !== null && !isString(contextId)) {
    throw new Error(`devflow: invalid workflow execution contextId in ${displayPath}`)
  }
  if (actionExecutionId !== null && !isString(actionExecutionId)) {
    throw new Error(`devflow: invalid workflow execution actionExecutionId in ${displayPath}`)
  }
  let resultSnapshot: CommanderWorkflowExecutionResult | null = null
  if (result !== null) {
    if (!isRecord(result)) throw new Error(`devflow: invalid workflow execution result in ${displayPath}`)
    const { success, error } = result
    if (typeof success !== 'boolean' || (error !== null && !isString(error))) {
      throw new Error(`devflow: invalid workflow execution result in ${displayPath}`)
    }
    resultSnapshot = { success, error: error === null ? null : error }
  }
  if (feedbackId !== null && !isString(feedbackId)) {
    throw new Error(`devflow: invalid workflow execution feedbackId in ${displayPath}`)
  }
  if (!isString(createdAt)) throw new Error(`devflow: invalid workflow execution createdAt in ${displayPath}`)
  return {
    entryId, stepId, decisionId, proposalId, approved, contextId, actionExecutionId,
    result: resultSnapshot,
    feedbackId, createdAt,
  }
}

/** Validate one commander workflow record at the durable-file boundary. */
function validateCommanderWorkflow(value: unknown, displayPath: string): CommanderWorkflow {
  if (!isRecord(value)) throw new Error(`devflow: invalid commander workflow record in ${displayPath}`)
  const { workflowId, projectId, title, description, status, history, createdAt, updatedAt } = value
  if (!isString(workflowId)) throw new Error(`devflow: invalid commander workflow id in ${displayPath}`)
  if (!isString(projectId)) throw new Error(`devflow: invalid commander workflow projectId in ${displayPath}`)
  if (!isString(title) || title.trim() === '') {
    throw new Error(`devflow: invalid commander workflow title in ${displayPath}`)
  }
  if (!isString(description)) throw new Error(`devflow: invalid commander workflow description in ${displayPath}`)
  if (!isString(status) || !WORKFLOW_STATUSES.includes(status as CommanderWorkflowStatus)) {
    throw new Error(`devflow: invalid commander workflow status ${JSON.stringify(status)} in ${displayPath}`)
  }
  if (!Array.isArray(history)) throw new Error(`devflow: invalid commander workflow history in ${displayPath}`)
  const entries = history.map(entry => validateCommanderWorkflowExecution(entry, displayPath))
  if (!isString(createdAt) || !isString(updatedAt)) {
    throw new Error(`devflow: invalid commander workflow timestamps in ${displayPath}`)
  }
  return {
    workflowId, projectId, title, description,
    status: status as CommanderWorkflowStatus,
    history: entries,
    createdAt, updatedAt,
  }
}

/** Validate one commander workflow step record at the durable-file boundary. */
function validateCommanderWorkflowStep(value: unknown, displayPath: string): CommanderWorkflowStep {
  if (!isRecord(value)) throw new Error(`devflow: invalid commander workflow step record in ${displayPath}`)
  const { stepId, workflowId, stepIndex, title, status, createdAt, updatedAt } = value
  if (!isString(stepId)) throw new Error(`devflow: invalid commander workflow step id in ${displayPath}`)
  if (!isString(workflowId)) throw new Error(`devflow: invalid commander workflow step workflowId in ${displayPath}`)
  if (typeof stepIndex !== 'number' || !Number.isInteger(stepIndex) || stepIndex < 0) {
    throw new Error(`devflow: invalid commander workflow step stepIndex in ${displayPath}`)
  }
  if (!isString(title) || title.trim() === '') {
    throw new Error(`devflow: invalid commander workflow step title in ${displayPath}`)
  }
  if (!isString(status) || !STEP_STATUSES.includes(status as CommanderStepStatus)) {
    throw new Error(`devflow: invalid commander workflow step status ${JSON.stringify(status)} in ${displayPath}`)
  }
  if (!isString(createdAt) || !isString(updatedAt)) {
    throw new Error(`devflow: invalid commander workflow step timestamps in ${displayPath}`)
  }
  return {
    stepId, workflowId, stepIndex, title,
    status: status as CommanderStepStatus,
    createdAt, updatedAt,
  }
}

/**
 * File-backed DevFlow store over the `ctx.fs` seam.
 * @param fs - the filesystem backend all storage I/O goes through.
 * @param root - the `.devflow` root; a relative path resolves against the
 *   backend's cwd, an absolute path is used verbatim.
 */
export class DevFlowStore {
  /** The committed journal id index at one observed head sequence. */
  private journalIdCache: { nextSequence: number; entries: Map<string, DevFlowJournalEntry> } | undefined
  /** Cached absolute store root, resolved once; see {@link relativeToRoot}. */
  private absoluteRoot: string | null = null
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
  private pendingJournalRecord: { readonly type: string; readonly data: unknown; readonly at: string } | null = null

  constructor(
    private readonly fs: FileSystem,
    private readonly root: string,
    /**
     * Optional committed-write observer. Every `.devflow` mutation funnels through
     * {@link writeJson}, which is the store's only write seam — this is how the live
     * event channel learns that the committed state moved, without the store having
     * to know anything about who listens.
     *
     * The third argument is supplied only for a published journal record, whose
     * committed meaning is known at write time. A plain state-file write reports its
     * path alone, because inventing a meaning from a path would be a guess.
     */
    private readonly onChange?: (
      relativePath: string,
      sequence?: number,
      record?: { readonly type: string; readonly data: unknown; readonly at: string },
    ) => void,
    /**
     * The sandbox policy every write of this store carries, when the caller
     * knows which session's workspace this store belongs to.
     *
     * Since 第九步 a store's root lives inside a project session's workspace,
     * which may sit OUTSIDE the host process cwd. The host filesystem fences a
     * write by the per-call policy and falls back to the deployment default —
     * a default whose workspace root is the host cwd — so a store write without
     * this policy is refused as out-of-bounds exactly where the project lives.
     * Supplying it states "this write belongs to that session's workspace".
     *
     * Omitted by callers that own a single store outside any session (tests, a
     * programmatic mount): they keep the backend's own default.
     */
    private readonly sandboxPolicyOf?: () => { readonly mode: string; readonly workspaceRoot: string } | undefined,
  ) {}

  /**
   * The configured `.devflow` root of this store.
   *
   * Exposed for the session-scope resolver, which reports which project a
   * session is bound to: a panel that cannot name the root cannot show that two
   * sessions are on two projects.
   */
  get rootPath(): string {
    return this.root
  }

  /** Resolve the append-only journal directory. */
  private journalDirTarget(): Promise<FsTarget> {
    return this.fs.resolve(join(this.root, JOURNAL_DIR))
  }

  /** Resolve the optimistic journal-head record. */
  private journalHeadTarget(): Promise<FsTarget> {
    return this.fs.resolve(join(this.root, JOURNAL_DIR, JOURNAL_HEAD_FILE))
  }

  /** Resolve one journal entry by its stable sequence. */
  private journalEntryTarget(sequence: number): Promise<FsTarget> {
    return this.fs.resolve(join(this.root, JOURNAL_DIR, `${String(sequence).padStart(16, '0')}${FILE_SUFFIX}`))
  }

  /** Resolve the project record file. */
  private projectTarget(): Promise<FsTarget> {
    return this.fs.resolve(join(this.root, PROJECT_FILE))
  }

  /** Resolve one task record file. */
  private taskTarget(id: string): Promise<FsTarget> {
    return this.fs.resolve(join(this.root, TASKS_DIR, `${id}${FILE_SUFFIX}`))
  }

  /** Resolve one result record file. */
  private resultTarget(id: string): Promise<FsTarget> {
    return this.fs.resolve(join(this.root, RESULTS_DIR, `${id}${FILE_SUFFIX}`))
  }

  /** Resolve one agent instance record file. */
  private agentTarget(id: string): Promise<FsTarget> {
    return this.fs.resolve(join(this.root, AGENTS_DIR, `${id}${FILE_SUFFIX}`))
  }

  /** Read one JSON record; returns undefined when the file is absent. */
  private async readJson(target: FsTarget): Promise<unknown | undefined> {
    const info = await this.fs.stat(target)
    if (info === undefined) return undefined
    if (info.type !== 'file') {
      throw new Error(`devflow: not a regular file: ${target.displayPath}`)
    }
    return parseJson(await this.fs.readText(target), target.displayPath)
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
  private async writeJson(target: FsTarget, value: unknown, expected?: FsWriteIntent, options?: { readonly report?: boolean; readonly carryPendingRecord?: boolean }): Promise<void> {
    // The store's ONE write seam. Since 第九步 it also carries the owning
    // session's sandbox policy, so a store rooted inside a project workspace
    // that lies outside the host cwd is still written as that workspace's write
    // rather than judged against the deployment default root. A bare backend
    // ignores the policy; a sandboxing backend fences by it.
    await this.fs.writeText(
      target,
      `${JSON.stringify(value, null, 2)}\n`,
      expected,
      undefined,
      this.sandboxPolicyOf?.() as never,
    )
    if (this.onChange === undefined || options?.report === false) return
    const relative = await this.relativeToRoot(target)
    if (relative === null) return
    // A journal-head write is where a commit becomes visible; it carries the next
    // sequence, which is the durable cursor the event channel reports.
    const sequence = relative === JOURNAL_HEAD_RELATIVE && isRecord(value) && typeof value.nextSequence === 'number'
      ? value.nextSequence
      : undefined
    // The head write is also where a just-written record's MEANING is attached, so
    // the frame carries the change and the watermark together (see
    // {@link pendingJournalRecord}).
    const record = options?.carryPendingRecord === true ? this.pendingJournalRecord ?? undefined : undefined
    if (options?.carryPendingRecord === true) this.pendingJournalRecord = null
    try {
      if (sequence === undefined && record === undefined) this.onChange(relative)
      else this.onChange(relative, sequence, record)
    } catch { /* an observer must never fail a committed write */ }
  }

  /**
   * Root-relative path of one store target, or null when it lives outside the root.
   *
   * Backends hand back an absolute `displayPath` even when the configured root is
   * relative, so the root is resolved once through the same seam that builds the
   * targets and cached; a relative display path still falls back to a literal
   * prefix match.
   */
  private async relativeToRoot(target: FsTarget): Promise<string | null> {
    const display = target.displayPath.replace(/\\/g, '/')
    if (this.absoluteRoot === null) {
      try { this.absoluteRoot = (await this.fs.resolve(this.root)).displayPath.replace(/\\/g, '/') }
      catch { this.absoluteRoot = '' }
    }
    for (const candidate of [this.absoluteRoot, this.root.replace(/\\/g, '/')]) {
      const prefix = candidate.replace(/\/+$/, '')
      if (prefix !== '' && display.startsWith(`${prefix}/`)) return display.slice(prefix.length + 1)
    }
    if (!display.includes('/') && !display.includes(':')) return display
    return null
  }

  /**
   * Look up one committed id without making every append rescan the journal.
   * The cache is valid only at its observed head sequence, so a changed head
   * refreshes it before relying on a negative result from another writer.
   */
  private async findJournalEntry(id: string, nextSequence: number): Promise<DevFlowJournalEntry | undefined> {
    if (this.journalIdCache?.nextSequence !== nextSequence) {
      const entries = await this.listJournal()
      this.journalIdCache = {
        nextSequence,
        entries: new Map(entries.map(entry => [entry.id, entry])),
      }
    }
    return this.journalIdCache.entries.get(id)
  }

  /** Remember one locally committed entry without invalidating the observed head. */
  private rememberJournalEntry(entry: DevFlowJournalEntry): void {
    if (this.journalIdCache?.nextSequence === entry.sequence) {
      this.journalIdCache.entries.set(entry.id, entry)
      this.journalIdCache = { ...this.journalIdCache, nextSequence: entry.sequence + 1 }
    }
  }

  /**
   * Append one durable DevFlow audit record. The head file uses the filesystem
   * version as a compare-and-swap guard, so concurrent workers retry rather
   * than silently sharing a sequence. The entry is published before the head;
   * a crash can leave an unreachable tail entry, but can never make the head
   * point at a missing entry.
   */
  async appendJournal(type: string, data: DevFlowJsonValue, id: string = randomUUID()): Promise<DevFlowJournalEntry> {
    const journalRoot = this.root
    const prior = journalTails.get(journalRoot) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const tail = prior.then(() => gate)
    journalTails.set(journalRoot, tail)
    await prior
    try {
      return await this.appendJournalUnlocked(type, data, id)
    } finally {
      release()
      if (journalTails.get(journalRoot) === tail) journalTails.delete(journalRoot)
    }
  }

  /** Perform one journal append while this process owns the journal tail. */
  private async appendJournalUnlocked(type: string, data: DevFlowJsonValue, id: string): Promise<DevFlowJournalEntry> {
    if (!isString(type) || type.trim() === '') throw new Error('devflow: journal type must be a non-empty string')
    if (!isJsonValue(data)) throw new Error(`devflow: journal ${type} carries non-JSON data`)
    for (;;) {
      const headTarget = await this.journalHeadTarget()
      const headInfo = await this.fs.stat(headTarget)
      const head = headInfo === undefined
        ? { nextSequence: 0 }
        : validateJournalHead(await this.readJson(headTarget), headTarget.displayPath)
      const alreadyCommitted = await this.findJournalEntry(id, head.nextSequence)
      if (alreadyCommitted !== undefined) return alreadyCommitted
      const entryTarget = await this.journalEntryTarget(head.nextSequence)
      const entry: DevFlowJournalEntry = {
        sequence: head.nextSequence,
        id,
        type,
        data,
        at: new Date().toISOString(),
      }
      const existing = await this.fs.stat(entryTarget)
      if (existing !== undefined) {
        const prior = validateJournalEntry(await this.readJson(entryTarget), entryTarget.displayPath)
        // The matching id is an idempotent replay. A different id is an orphan
        // tail left after the entry write won but head publication did not.
        // Commit that immutable entry by advancing the guarded head, then retry
        // the caller at the next sequence.
        if (prior.id === id) {
          this.rememberJournalEntry(prior)
          return prior
        }
        try {
          await this.writeJson(
            headTarget,
            { nextSequence: prior.sequence + 1 },
            headInfo === undefined ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: headInfo.version },
          )
        } catch (error) {
          if (headInfo === undefined || (error as { code?: unknown }).code === 'FS_STALE_VERSION') continue
          throw error
        }
        continue
      }
      try {
        await this.writeJson(entryTarget, entry, { kind: 'createIfAbsent' }, { report: false })
      } catch (error) {
        // A competing writer won this sequence after our stat. Its immutable
        // entry is authoritative; restart from the current head.
        if ((error as { code?: unknown }).code === 'FS_NOT_OBSERVED') continue
        throw error
      }
      // Park the record's MEANING for the head write to publish alongside the
      // watermark. Reporting it here instead would race the head report across the
      // coalescing window (measured: the record's signal arrived first and the
      // watermark-only one second, i.e. backwards).
      this.pendingJournalRecord = { type: entry.type, data: entry.data, at: entry.at }
      try {
        await this.writeJson(
          headTarget,
          { nextSequence: entry.sequence + 1 },
          headInfo === undefined ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: headInfo.version },
          { carryPendingRecord: true },
        )
        this.rememberJournalEntry(entry)
        return entry
      } catch (error) {
        // The immutable entry remains harmlessly unreachable; retry from the
        // latest head rather than reporting a committed mutation as success.
        if (headInfo === undefined || (error as { code?: unknown }).code === 'FS_STALE_VERSION') continue
        throw error
      }
    }
  }

  /**
   * Read a bounded descending sequence window without listing or parsing the
   * complete journal. Callers supply an exclusive position pinned to a
   * previously observed committed head, so later appends cannot move a page.
   */
  async readCommittedJournalSequencePage(
    capturedHeadSequence: number | undefined,
    nextExclusiveSequence: number | undefined,
    scanLimit: number,
  ): Promise<DevFlowJournalSequencePage> {
    if (!Number.isSafeInteger(scanLimit) || scanLimit < 1) {
      throw new Error('devflow: journal page scanLimit must be a positive safe integer')
    }
    const headTarget = await this.journalHeadTarget()
    const headRaw = await this.readJson(headTarget)
    const head = headRaw === undefined ? { nextSequence: 0 } : validateJournalHead(headRaw, headTarget.displayPath)
    const captured = capturedHeadSequence ?? head.nextSequence
    if (!Number.isSafeInteger(captured) || captured < 0 || captured > head.nextSequence) {
      throw new Error('devflow: invalid committed journal page head')
    }
    const start = nextExclusiveSequence ?? captured
    if (!Number.isSafeInteger(start) || start < 0 || start > captured) {
      throw new Error('devflow: invalid committed journal page position')
    }
    const entries: DevFlowJournalEntry[] = []
    let scannedCount = 0
    let cursor = start
    while (cursor > 0 && scannedCount < scanLimit) {
      const sequence = cursor - 1
      const target = await this.journalEntryTarget(sequence)
      const raw = await this.readJson(target)
      // A sequence below a committed head must be an immutable entry. Missing
      // data is corruption, never a reason to silently skip business history.
      if (raw === undefined) throw new Error('devflow: committed journal entry is unavailable')
      const entry = validateJournalEntry(raw, target.displayPath)
      if (entry.sequence !== sequence) throw new Error('devflow: committed journal sequence mismatch')
      entries.push(entry)
      scannedCount++
      cursor = sequence
    }
    return {
      capturedHeadSequence: captured,
      entries,
      nextExclusiveSequence: cursor === 0 ? null : cursor,
      scannedCount,
    }
  }

  /** Read committed journal entries only, in their stable sequence order. */
  async listJournal(): Promise<DevFlowJournalEntry[]> {
    const dir = await this.journalDirTarget()
    const info = await this.fs.stat(dir)
    if (info === undefined) return []
    if (info.type !== 'directory') throw new Error(`devflow: not a directory: ${dir.displayPath}`)
    const entries: DevFlowJournalEntry[] = []
    for (const entry of await this.fs.listDir(dir)) {
      if (entry.type !== 'file' || !entry.name.endsWith(FILE_SUFFIX) || entry.name === JOURNAL_HEAD_FILE) continue
      const raw = await this.readJson(entry.target)
      if (raw !== undefined) entries.push(validateJournalEntry(raw, entry.target.displayPath))
    }
    const headTarget = await this.journalHeadTarget()
    const headRaw = await this.readJson(headTarget)
    if (headRaw === undefined) return []
    const head = validateJournalHead(headRaw, headTarget.displayPath)
    return entries
      .filter(entry => entry.sequence < head.nextSequence)
      .sort((left, right) => left.sequence - right.sequence)
  }

  /** Save (create or replace) the project context. */
  async saveProject(project: Project): Promise<void> {
    validateProject(project, 'memory')
    await this.writeJson(await this.projectTarget(), project)
  }

  /** Load the project context; undefined when the project has never been saved. */
  async loadProject(): Promise<Project | undefined> {
    const target = await this.projectTarget()
    const raw = await this.readJson(target)
    return raw === undefined ? undefined : validateProject(raw, target.displayPath)
  }

  /**
   * Create and persist one task with a generated id and timestamps.
   * @param input - task fields without the store-owned id and timestamps.
   * @returns the persisted task.
   */
  async createTask(input: Omit<Task, 'id' | 'createdAt' | 'updatedAt'>): Promise<Task> {
    const now = new Date().toISOString()
    const task: Task = { ...input, id: randomUUID(), createdAt: now, updatedAt: now }
    validateTask(task, 'memory')
    await this.writeJson(await this.taskTarget(task.id), task, { kind: 'createIfAbsent' })
    return task
  }

  /** Load one task; undefined when the task id is unknown. */
  async getTask(id: string): Promise<Task | undefined> {
    assertUuid(id, 'task')
    const target = await this.taskTarget(id)
    const raw = await this.readJson(target)
    return raw === undefined ? undefined : validateTask(raw, target.displayPath)
  }

  /** Load every task in the store, oldest first; an empty tasks/ is an empty list. */
  async listTasks(): Promise<Task[]> {
    const dir = await this.fs.resolve(join(this.root, TASKS_DIR))
    const info = await this.fs.stat(dir)
    if (info === undefined) return []
    if (info.type !== 'directory') {
      throw new Error(`devflow: not a directory: ${dir.displayPath}`)
    }
    const tasks: Task[] = []
    for (const entry of await this.fs.listDir(dir)) {
      if (entry.type !== 'file' || !entry.name.endsWith(FILE_SUFFIX)) continue
      const raw = await this.readJson(entry.target)
      if (raw !== undefined) tasks.push(validateTask(raw, entry.target.displayPath))
    }
    return tasks.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
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
  async updateTask(id: string, patch: TaskUpdate): Promise<Task> {
    assertUuid(id, 'task')
    const existing = await this.getTask(id)
    if (existing === undefined) {
      throw new Error(`devflow: cannot update unknown task ${id}`)
    }
    const { assignedRole, ...rest } = patch
    const { assignedRole: existingRole, ...existingRest } = existing
    const rolePart = 'assignedRole' in patch
      ? (assignedRole === undefined ? {} : { assignedRole })
      : (existingRole === undefined ? {} : { assignedRole: existingRole })
    const updated: Task = {
      ...existingRest,
      ...rest,
      ...rolePart,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    }
    validateTask(updated, 'memory')
    await this.writeJson(await this.taskTarget(id), updated)
    return updated
  }

  /**
   * Create and persist one result with a generated id and creation time.
   * @param input - result fields without the store-owned id and `createdAt`.
   * @returns the persisted result.
   */
  async saveResult(input: Omit<Result, 'id' | 'createdAt'>): Promise<Result> {
    const result: Result = { ...input, id: randomUUID(), createdAt: new Date().toISOString() }
    validateResult(result, 'memory')
    await this.writeJson(await this.resultTarget(result.id), result, { kind: 'createIfAbsent' })
    return result
  }

  /** Load one result; undefined when the result id is unknown. */
  async getResult(id: string): Promise<Result | undefined> {
    assertUuid(id, 'result')
    const target = await this.resultTarget(id)
    const raw = await this.readJson(target)
    return raw === undefined ? undefined : validateResult(raw, target.displayPath)
  }

  /** Load every result in the store, oldest first; an empty results/ is an empty list. */
  async listResults(): Promise<Result[]> {
    const dir = await this.fs.resolve(join(this.root, RESULTS_DIR))
    const info = await this.fs.stat(dir)
    if (info === undefined) return []
    if (info.type !== 'directory') {
      throw new Error(`devflow: not a directory: ${dir.displayPath}`)
    }
    const results: Result[] = []
    for (const entry of await this.fs.listDir(dir)) {
      if (entry.type !== 'file' || !entry.name.endsWith(FILE_SUFFIX)) continue
      const raw = await this.readJson(entry.target)
      if (raw !== undefined) results.push(validateResult(raw, entry.target.displayPath))
    }
    return results.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /** Load every result for one task, oldest first; an empty results/ is an empty list. */
  async listResultsByTask(taskId: string): Promise<Result[]> {
    assertUuid(taskId, 'task')
    const dir = await this.fs.resolve(join(this.root, RESULTS_DIR))
    const info = await this.fs.stat(dir)
    if (info === undefined) return []
    if (info.type !== 'directory') {
      throw new Error(`devflow: not a directory: ${dir.displayPath}`)
    }
    const results: Result[] = []
    for (const entry of await this.fs.listDir(dir)) {
      if (entry.type !== 'file' || !entry.name.endsWith(FILE_SUFFIX)) continue
      const raw = await this.readJson(entry.target)
      if (raw !== undefined) {
        const result = validateResult(raw, entry.target.displayPath)
        if (result.taskId === taskId) results.push(result)
      }
    }
    return results.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /**
   * Read the convention import document for one task
   * (`.devflow/imports/<taskId>.md`); undefined when the user has not placed
   * a document there yet. Reads only — writing stays with the caller layer.
   */
  async readImportMarkdown(taskId: string): Promise<string | undefined> {
    assertUuid(taskId, 'task')
    const target = await this.fs.resolve(join(this.root, IMPORTS_DIR, `${taskId}${MARKDOWN_SUFFIX}`))
    const info = await this.fs.stat(target)
    if (info === undefined) return undefined
    if (info.type !== 'file') {
      throw new Error(`devflow: not a regular file: ${target.displayPath}`)
    }
    return this.fs.readText(target)
  }

  /**
   * Create and persist one agent instance with caller-supplied slug id and
   * store-generated timestamps. Duplicate ids fail (createIfAbsent).
   * @param input - instance fields without the store-owned timestamps.
   * @returns the persisted instance.
   */
  async createAgentInstance(input: Omit<AgentInstance, 'createdAt' | 'updatedAt'>): Promise<AgentInstance> {
    assertAgentId(input.id)
    const now = new Date().toISOString()
    const instance: AgentInstance = { ...input, createdAt: now, updatedAt: now }
    validateAgentInstance(instance, 'memory')
    await this.writeJson(await this.agentTarget(input.id), instance, { kind: 'createIfAbsent' })
    return instance
  }

  /** Load one agent instance; undefined when the id is unknown. */
  async getAgentInstance(id: string): Promise<AgentInstance | undefined> {
    assertAgentId(id)
    const target = await this.agentTarget(id)
    const raw = await this.readJson(target)
    return raw === undefined ? undefined : validateAgentInstance(raw, target.displayPath)
  }

  /** Load every agent instance in the store, oldest first; an empty agents/ is an empty list. */
  async listAgentInstances(): Promise<AgentInstance[]> {
    const dir = await this.fs.resolve(join(this.root, AGENTS_DIR))
    const info = await this.fs.stat(dir)
    if (info === undefined) return []
    if (info.type !== 'directory') {
      throw new Error(`devflow: not a directory: ${dir.displayPath}`)
    }
    const instances: AgentInstance[] = []
    for (const entry of await this.fs.listDir(dir)) {
      if (entry.type !== 'file' || !entry.name.endsWith(FILE_SUFFIX)) continue
      const raw = await this.readJson(entry.target)
      if (raw !== undefined) instances.push(validateAgentInstance(raw, entry.target.displayPath))
    }
    return instances.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /**
   * Apply a partial update to one agent instance and refresh its `updatedAt`.
   * The id and `createdAt` are immutable; unknown instances fail loud.
   * @param id - the instance to update.
   * @param patch - the fields to replace; undefined keys leave values untouched.
   * @returns the updated instance.
   */
  async updateAgentInstance(id: string, patch: AgentInstanceUpdate): Promise<AgentInstance> {
    assertAgentId(id)
    const existing = await this.getAgentInstance(id)
    if (existing === undefined) {
      throw new Error(`devflow: cannot update unknown agent instance ${id}`)
    }
    const { role, displayName, description, capabilities, metadata } = patch
    const updated: AgentInstance = {
      id: existing.id,
      role: role ?? existing.role,
      displayName: displayName ?? existing.displayName,
      ...((description ?? existing.description) === undefined ? {} : { description: description ?? existing.description }),
      ...((capabilities ?? existing.capabilities) === undefined ? {} : { capabilities: capabilities ?? existing.capabilities }),
      ...((metadata ?? existing.metadata) === undefined ? {} : { metadata: metadata ?? existing.metadata }),
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    }
    validateAgentInstance(updated, 'memory')
    await this.writeJson(await this.agentTarget(id), updated)
    return updated
  }

  /** Resolve one orchestration agent record file. */
  private orchestrationAgentTarget(agentId: string): Promise<FsTarget> {
    return this.fs.resolve(join(this.root, ORCHESTRATION_AGENTS_DIR, `${agentId}${FILE_SUFFIX}`))
  }

  /** Resolve the MVP plan record file. */
  private mvpTarget(): Promise<FsTarget> {
    return this.fs.resolve(join(this.root, MVP_FILE))
  }

  /** Resolve one phase record file. */
  private phaseTarget(id: string): Promise<FsTarget> {
    return this.fs.resolve(join(this.root, PHASES_DIR, `${id}${FILE_SUFFIX}`))
  }

  /** Resolve the scope guard record file. */
  private scopeTarget(): Promise<FsTarget> {
    return this.fs.resolve(join(this.root, SCOPE_FILE))
  }

  /** Resolve one task's scope-guard file. */
  private taskScopeTarget(taskId: string): Promise<FsTarget> {
    return this.fs.resolve(join(this.root, SCOPES_DIR, `${taskId}${FILE_SUFFIX}`))
  }

  /** Resolve one improvement record file. */
  private improvementTarget(id: string): Promise<FsTarget> {
    return this.fs.resolve(join(this.root, IMPROVEMENTS_DIR, `${id}${FILE_SUFFIX}`))
  }

  /**
   * Register one orchestration agent. Fixed agents start `active`; temporary
   * agents start `created`. Duplicate ids fail (createIfAbsent).
   * @param input - agent fields without the store-owned status and timestamps.
   * @returns the persisted agent.
   */
  async registerAgent(input: Omit<OrchestrationAgent, 'status' | 'createdAt' | 'updatedAt'>): Promise<OrchestrationAgent> {
    assertAgentId(input.agentId)
    const now = new Date().toISOString()
    const status: AgentLifecycleStatus = input.kind === 'fixed' ? 'active' : 'created'
    const agent: OrchestrationAgent = { ...input, status, createdAt: now, updatedAt: now }
    validateOrchestrationAgent(agent, 'memory')
    await this.writeJson(await this.orchestrationAgentTarget(input.agentId), agent, { kind: 'createIfAbsent' })
    return agent
  }

  /** Load one orchestration agent; undefined when the id is unknown or removed. */
  async getAgent(agentId: string): Promise<OrchestrationAgent | undefined> {
    assertAgentId(agentId)
    const target = await this.orchestrationAgentTarget(agentId)
    const raw = await this.readJson(target)
    if (raw === undefined || isTombstone(raw)) return undefined
    return validateOrchestrationAgent(raw, target.displayPath)
  }

  /** Read the repository-backed Skill contents bound to one agent, preserving binding order. */
  async resolveAgentSkills(agent: Pick<OrchestrationAgent, 'skills'>): Promise<ResolvedSkillContent[]> {
    validateAgentSkills(agent.skills, 'agent Skill resolution')
    const resolved: ResolvedSkillContent[] = []
    for (const skillId of agent.skills) {
      const definition = DEVFLOW_SKILLS[skillId]
      if (definition === undefined) throw new Error(`devflow: unknown skill id ${JSON.stringify(skillId)}`)
      const target = await this.fs.resolve(definition.sourcePath)
      const info = await this.fs.stat(target)
      if (info?.type !== 'file') {
        throw new Error(`devflow: Skill source ${definition.sourcePath} for ${skillId} is unavailable`)
      }
      resolved.push({ id: skillId, content: await this.fs.readText(target) })
    }
    return resolved
  }

  /** Load every registered orchestration agent, oldest first; skips removed agents. */
  async listAgents(): Promise<OrchestrationAgent[]> {
    const dir = await this.fs.resolve(join(this.root, ORCHESTRATION_AGENTS_DIR))
    const info = await this.fs.stat(dir)
    if (info === undefined) return []
    if (info.type !== 'directory') throw new Error(`devflow: not a directory: ${dir.displayPath}`)
    const agents: OrchestrationAgent[] = []
    for (const entry of await this.fs.listDir(dir)) {
      if (entry.type !== 'file' || !entry.name.endsWith(FILE_SUFFIX)) continue
      const raw = await this.readJson(entry.target)
      if (raw !== undefined && !isTombstone(raw)) agents.push(validateOrchestrationAgent(raw, entry.target.displayPath))
    }
    return agents.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /**
   * Remove one orchestration agent. fs has no delete primitive, so removal is
   * a logical tombstone: the record file is replaced with a marker and every
   * reader skips it. Unknown agents fail loud.
   * @param agentId - the agent to remove.
   */
  async removeAgent(agentId: string): Promise<void> {
    assertAgentId(agentId)
    const existing = await this.getAgent(agentId)
    if (existing === undefined) throw new Error(`devflow: cannot remove unknown agent ${agentId}`)
    await this.writeJson(await this.orchestrationAgentTarget(agentId), {
      removed: true,
      removedAt: new Date().toISOString(),
    })
  }

  /**
   * Apply a partial config patch to one orchestration agent and refresh
   * `updatedAt`. The id, kind, status, and `createdAt` are immutable.
   * @param agentId - the agent to update.
   * @param patch - the fields to replace; omitted keys stay untouched.
   * @returns the updated agent.
   */
  async updateAgentConfig(agentId: string, patch: AgentConfigPatch): Promise<OrchestrationAgent> {
    assertAgentId(agentId)
    const existing = await this.getAgent(agentId)
    if (existing === undefined) throw new Error(`devflow: cannot update unknown agent ${agentId}`)
    const { role, prompt, modelConfig, tools, capabilities, skills, delegationDepth } = patch
    const updated: OrchestrationAgent = {
      ...existing,
      role: role ?? existing.role,
      prompt: prompt ?? existing.prompt,
      modelConfig: modelConfig === undefined ? existing.modelConfig : { ...existing.modelConfig, ...modelConfig },
      tools: tools ?? existing.tools,
      capabilities: capabilities ?? existing.capabilities,
      skills: skills ?? existing.skills,
      delegationDepth: delegationDepth ?? existing.delegationDepth,
      updatedAt: new Date().toISOString(),
    }
    validateOrchestrationAgent(updated, 'memory')
    await this.writeJson(await this.orchestrationAgentTarget(agentId), updated)
    return updated
  }

  /**
   * Transition one temporary agent through its lifecycle. Only the legal
   * created → running → terminated edges are accepted; fixed agents have no
   * transitions.
   * @param agentId - the temporary agent to transition.
   * @param to - the target status.
   * @returns the updated agent.
   */
  async transitionAgent(agentId: string, to: TemporaryAgentStatus): Promise<OrchestrationAgent> {
    assertAgentId(agentId)
    const existing = await this.getAgent(agentId)
    if (existing === undefined) throw new Error(`devflow: cannot transition unknown agent ${agentId}`)
    if (existing.kind !== 'temporary') {
      throw new Error(`devflow: fixed agent ${agentId} has no lifecycle transitions`)
    }
    const allowed = TEMPORARY_TRANSITIONS[existing.status as TemporaryAgentStatus]
    if (!allowed.includes(to)) {
      throw new Error(`devflow: illegal temporary-agent transition ${existing.status} -> ${to} for ${agentId}`)
    }
    const updated: OrchestrationAgent = { ...existing, status: to, updatedAt: new Date().toISOString() }
    validateOrchestrationAgent(updated, 'memory')
    await this.writeJson(await this.orchestrationAgentTarget(agentId), updated)
    return updated
  }

  /** Save (create or replace) the MVP plan. */
  async saveMvpPlan(plan: MvpPlan): Promise<void> {
    validateMvpPlan(plan, 'memory')
    await this.writeJson(await this.mvpTarget(), plan)
  }

  /** Load the MVP plan; undefined when it has never been saved. */
  async getMvpPlan(): Promise<MvpPlan | undefined> {
    const target = await this.mvpTarget()
    const raw = await this.readJson(target)
    return raw === undefined ? undefined : validateMvpPlan(raw, target.displayPath)
  }

  /** Create and persist one phase with a generated id and timestamps. */
  async createPhase(input: Omit<Phase, 'id' | 'createdAt' | 'updatedAt'>): Promise<Phase> {
    const now = new Date().toISOString()
    const phase: Phase = { ...input, id: randomUUID(), createdAt: now, updatedAt: now }
    validatePhase(phase, 'memory')
    await this.writeJson(await this.phaseTarget(phase.id), phase, { kind: 'createIfAbsent' })
    return phase
  }

  /** Load one phase; undefined when the id is unknown. */
  async getPhase(id: string): Promise<Phase | undefined> {
    assertUuid(id, 'phase')
    const target = await this.phaseTarget(id)
    const raw = await this.readJson(target)
    return raw === undefined ? undefined : validatePhase(raw, target.displayPath)
  }

  /** Change one phase's status and refresh its `updatedAt`. */
  async updatePhaseStatus(id: string, status: PhaseStatus): Promise<Phase> {
    assertUuid(id, 'phase')
    const existing = await this.getPhase(id)
    if (existing === undefined) throw new Error(`devflow: cannot update unknown phase ${id}`)
    const updated: Phase = { ...existing, status, updatedAt: new Date().toISOString() }
    validatePhase(updated, 'memory')
    await this.writeJson(await this.phaseTarget(id), updated)
    return updated
  }

  /**
   * Update (create or replace) the scope guard. The first update sets
   * `createdAt`; later updates keep it and refresh `updatedAt`.
   */
  async updateScope(scope: Omit<ScopeGuard, 'createdAt' | 'updatedAt'>): Promise<ScopeGuard> {
    const existing = await this.getScope()
    const now = new Date().toISOString()
    const updated: ScopeGuard = { ...scope, createdAt: existing?.createdAt ?? now, updatedAt: now }
    validateScopeGuard(updated, 'memory')
    await this.writeJson(await this.scopeTarget(), updated)
    return updated
  }

  /** Load the scope guard; undefined when it has never been saved or was cleared. */
  async getScope(): Promise<ScopeGuard | undefined> {
    const target = await this.scopeTarget()
    const raw = await this.readJson(target)
    if (raw === undefined || isTombstone(raw)) return undefined
    return validateScopeGuard(raw, target.displayPath)
  }

  /** Clear the PROJECT default scope (the file stays as a tombstone record). */
  async clearScope(): Promise<void> {
    await this.writeJson(await this.scopeTarget(), { removed: true })
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
  async saveTaskScope(taskId: string, scope: Omit<ScopeGuard, 'createdAt' | 'updatedAt'>): Promise<ScopeGuard> {
    assertUuid(taskId, 'task')
    const existing = await this.getTaskScope(taskId)
    const now = new Date().toISOString()
    const updated: ScopeGuard = { ...scope, createdAt: existing?.createdAt ?? now, updatedAt: now }
    validateScopeGuard(updated, 'memory')
    await this.writeJson(await this.taskScopeTarget(taskId), updated)
    return updated
  }

  /** Load one task's scope guard; undefined when that task never set bounds. */
  async getTaskScope(taskId: string): Promise<ScopeGuard | undefined> {
    assertUuid(taskId, 'task')
    const target = await this.taskScopeTarget(taskId)
    const raw = await this.readJson(target)
    if (raw === undefined || isTombstone(raw)) return undefined
    return validateScopeGuard(raw, target.displayPath)
  }

  /** Clear one task's scope guard (tombstone; the project default is untouched). */
  async clearTaskScope(taskId: string): Promise<void> {
    assertUuid(taskId, 'task')
    await this.writeJson(await this.taskScopeTarget(taskId), { removed: true })
  }

  /** Queue one out-of-scope improvement with a generated id and creation time. */
  async addImprovement(input: Omit<Improvement, 'id' | 'createdAt'>): Promise<Improvement> {
    const improvement: Improvement = { ...input, id: randomUUID(), createdAt: new Date().toISOString() }
    validateImprovement(improvement, 'memory')
    await this.writeJson(await this.improvementTarget(improvement.id), improvement, { kind: 'createIfAbsent' })
    return improvement
  }

  /** Load the improvement queue, oldest first; an empty improvements/ is an empty list. */
  async listImprovements(): Promise<Improvement[]> {
    const dir = await this.fs.resolve(join(this.root, IMPROVEMENTS_DIR))
    const info = await this.fs.stat(dir)
    if (info === undefined) return []
    if (info.type !== 'directory') throw new Error(`devflow: not a directory: ${dir.displayPath}`)
    const improvements: Improvement[] = []
    for (const entry of await this.fs.listDir(dir)) {
      if (entry.type !== 'file' || !entry.name.endsWith(FILE_SUFFIX)) continue
      const raw = await this.readJson(entry.target)
      if (raw !== undefined) improvements.push(validateImprovement(raw, entry.target.displayPath))
    }
    return improvements.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /** Resolve one commander checkpoint record file. */
  private checkpointTarget(id: string): Promise<FsTarget> {
    return this.fs.resolve(join(this.root, CHECKPOINTS_DIR, `${id}${FILE_SUFFIX}`))
  }

  /** Resolve one phase-assignment record file. */
  private assignmentTarget(id: string): Promise<FsTarget> {
    return this.fs.resolve(join(this.root, ASSIGNMENTS_DIR, `${id}${FILE_SUFFIX}`))
  }

  /** Create and persist one commander checkpoint with a generated id and timestamps. */
  async createCheckpoint(input: Omit<CommanderCheckpoint, 'checkpointId' | 'createdAt' | 'updatedAt'>): Promise<CommanderCheckpoint> {
    const now = new Date().toISOString()
    const checkpoint: CommanderCheckpoint = { ...input, checkpointId: randomUUID(), createdAt: now, updatedAt: now }
    validateCommanderCheckpoint(checkpoint, 'memory')
    await this.writeJson(await this.checkpointTarget(checkpoint.checkpointId), checkpoint, { kind: 'createIfAbsent' })
    return checkpoint
  }

  /** Load one commander checkpoint; undefined when the id is unknown. */
  async getCheckpoint(id: string): Promise<CommanderCheckpoint | undefined> {
    assertUuid(id, 'checkpoint')
    const target = await this.checkpointTarget(id)
    const raw = await this.readJson(target)
    return raw === undefined ? undefined : validateCommanderCheckpoint(raw, target.displayPath)
  }

  /**
   * Apply a partial update to one commander checkpoint and refresh `updatedAt`.
   * The checkpoint id and `createdAt` are immutable; unknown ids fail loud.
   */
  async updateCheckpoint(id: string, patch: CommanderCheckpointUpdate): Promise<CommanderCheckpoint> {
    assertUuid(id, 'checkpoint')
    const existing = await this.getCheckpoint(id)
    if (existing === undefined) throw new Error(`devflow: cannot update unknown checkpoint ${id}`)
    const { currentMvp, currentIteration, currentPhase, currentTask, completedItems, decisions, nextSteps } = patch
    const updated: CommanderCheckpoint = {
      ...existing,
      ...(currentMvp !== undefined ? { currentMvp } : {}),
      ...(currentIteration !== undefined ? { currentIteration } : {}),
      ...(currentPhase !== undefined ? { currentPhase } : {}),
      ...(currentTask !== undefined ? { currentTask } : {}),
      ...(completedItems !== undefined ? { completedItems } : {}),
      ...(decisions !== undefined ? { decisions } : {}),
      ...(nextSteps !== undefined ? { nextSteps } : {}),
      updatedAt: new Date().toISOString(),
    }
    validateCommanderCheckpoint(updated, 'memory')
    await this.writeJson(await this.checkpointTarget(id), updated)
    return updated
  }

  /** Load every commander checkpoint, oldest first; an empty checkpoints/ is an empty list. */
  async listCheckpoints(): Promise<CommanderCheckpoint[]> {
    const dir = await this.fs.resolve(join(this.root, CHECKPOINTS_DIR))
    const info = await this.fs.stat(dir)
    if (info === undefined) return []
    if (info.type !== 'directory') throw new Error(`devflow: not a directory: ${dir.displayPath}`)
    const checkpoints: CommanderCheckpoint[] = []
    for (const entry of await this.fs.listDir(dir)) {
      if (entry.type !== 'file' || !entry.name.endsWith(FILE_SUFFIX)) continue
      const raw = await this.readJson(entry.target)
      if (raw !== undefined) checkpoints.push(validateCommanderCheckpoint(raw, entry.target.displayPath))
    }
    return checkpoints.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /** Create and persist one phase assignment with a generated id and timestamps. */
  async createAssignment(input: Omit<PhaseAssignment, 'assignmentId' | 'createdAt' | 'updatedAt'>): Promise<PhaseAssignment> {
    const now = new Date().toISOString()
    const assignment: PhaseAssignment = { ...input, assignmentId: randomUUID(), createdAt: now, updatedAt: now }
    validatePhaseAssignment(assignment, 'memory')
    await this.writeJson(await this.assignmentTarget(assignment.assignmentId), assignment, { kind: 'createIfAbsent' })
    return assignment
  }

  /** Load one phase assignment; undefined when the id is unknown or removed. */
  async getAssignment(id: string): Promise<PhaseAssignment | undefined> {
    assertUuid(id, 'assignment')
    const target = await this.assignmentTarget(id)
    const raw = await this.readJson(target)
    if (raw === undefined || isTombstone(raw)) return undefined
    return validatePhaseAssignment(raw, target.displayPath)
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
  async updateAssignmentStatus(id: string, status: AssignmentStatus, closeReason?: DevFlowCloseReason): Promise<PhaseAssignment> {
    assertUuid(id, 'assignment')
    const existing = await this.getAssignment(id)
    if (existing === undefined) throw new Error(`devflow: cannot update unknown assignment ${id}`)
    const allowed = ASSIGNMENT_TRANSITIONS[existing.status]
    if (!allowed.includes(status)) {
      throw new Error(`devflow: illegal assignment transition ${existing.status} -> ${status} for ${id}`)
    }
    if (status === 'closed' && !isDevFlowCloseReason(closeReason)) {
      throw new Error(`devflow: closing assignment ${id} requires a close reason`)
    }
    if (status !== 'closed' && closeReason !== undefined) {
      throw new Error(`devflow: assignment ${id} may only carry a close reason while closed`)
    }
    const now = new Date().toISOString()
    const { closedAt: _closedAt, closeReason: _closeReason, ...rest } = existing
    const updated: PhaseAssignment = {
      ...rest,
      status,
      ...(status === 'closed' ? { closedAt: now, closeReason: closeReason as DevFlowCloseReason } : {}),
      updatedAt: now,
    }
    validatePhaseAssignment(updated, 'memory')
    await this.writeJson(await this.assignmentTarget(id), updated)
    if (updated.status === 'closed') {
      // Both fields are guaranteed present on a validated `closed` record; the
      // validator above enforces that pairing, so they are read from the record
      // rather than re-derived from possibly-undefined arguments.
      await this.appendClosure('devflow/orchestration/close', {
        assignmentId: id,
        closeReason: updated.closeReason as DevFlowCloseReason,
        at: updated.closedAt as string,
      })
    }
    return updated
  }

  /** Remove one phase assignment via a logical tombstone (fs has no delete). */
  async unassignAssignment(id: string): Promise<void> {
    assertUuid(id, 'assignment')
    const existing = await this.getAssignment(id)
    if (existing === undefined) throw new Error(`devflow: cannot unassign unknown assignment ${id}`)
    await this.writeJson(await this.assignmentTarget(id), { removed: true, removedAt: new Date().toISOString() })
  }

  /** Load every phase assignment, oldest first; skips removed assignments. */
  async listAssignments(): Promise<PhaseAssignment[]> {
    const dir = await this.fs.resolve(join(this.root, ASSIGNMENTS_DIR))
    const info = await this.fs.stat(dir)
    if (info === undefined) return []
    if (info.type !== 'directory') throw new Error(`devflow: not a directory: ${dir.displayPath}`)
    const assignments: PhaseAssignment[] = []
    for (const entry of await this.fs.listDir(dir)) {
      if (entry.type !== 'file' || !entry.name.endsWith(FILE_SUFFIX)) continue
      const raw = await this.readJson(entry.target)
      if (raw !== undefined && !isTombstone(raw)) assignments.push(validatePhaseAssignment(raw, entry.target.displayPath))
    }
    return assignments.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /** Resolve one commander plan record file. */
  private planningTarget(id: string): Promise<FsTarget> {
    return this.fs.resolve(join(this.root, PLANNING_DIR, `${id}${FILE_SUFFIX}`))
  }

  /** Resolve one execution batch record file. */
  private batchTarget(id: string): Promise<FsTarget> {
    return this.fs.resolve(join(this.root, BATCHES_DIR, `${id}${FILE_SUFFIX}`))
  }

  /** Create and persist one commander plan (starts `draft`). */
  async createPlanning(input: Omit<CommanderPlan, 'planningId' | 'status' | 'createdAt' | 'updatedAt'>): Promise<CommanderPlan> {
    const now = new Date().toISOString()
    const plan: CommanderPlan = { ...input, planningId: randomUUID(), status: 'draft', createdAt: now, updatedAt: now }
    validateCommanderPlan(plan, 'memory')
    await this.writeJson(await this.planningTarget(plan.planningId), plan, { kind: 'createIfAbsent' })
    return plan
  }

  /** Load one commander plan; undefined when the id is unknown. */
  async getPlanning(id: string): Promise<CommanderPlan | undefined> {
    assertUuid(id, 'planning')
    const target = await this.planningTarget(id)
    const raw = await this.readJson(target)
    return raw === undefined ? undefined : validateCommanderPlan(raw, target.displayPath)
  }

  /** Apply a partial update to one commander plan and refresh `updatedAt`. */
  async updatePlanning(id: string, patch: CommanderPlanUpdate): Promise<CommanderPlan> {
    assertUuid(id, 'planning')
    const existing = await this.getPlanning(id)
    if (existing === undefined) throw new Error(`devflow: cannot update unknown plan ${id}`)
    const { goal, mvpPlanId, status } = patch
    const updated: CommanderPlan = {
      ...existing,
      ...(goal !== undefined ? { goal } : {}),
      ...(mvpPlanId !== undefined ? { mvpPlanId } : {}),
      ...(status !== undefined ? { status } : {}),
      updatedAt: new Date().toISOString(),
    }
    validateCommanderPlan(updated, 'memory')
    await this.writeJson(await this.planningTarget(id), updated)
    return updated
  }

  /** Activate one commander plan (draft → active). */
  async activatePlanning(id: string): Promise<CommanderPlan> {
    assertUuid(id, 'planning')
    const existing = await this.getPlanning(id)
    if (existing === undefined) throw new Error(`devflow: cannot activate unknown plan ${id}`)
    if (existing.status !== 'draft') {
      throw new Error(`devflow: cannot activate plan ${id} in status ${existing.status}`)
    }
    const updated: CommanderPlan = { ...existing, status: 'active', updatedAt: new Date().toISOString() }
    validateCommanderPlan(updated, 'memory')
    await this.writeJson(await this.planningTarget(id), updated)
    return updated
  }

  /** Load every commander plan, oldest first; an empty planning/ is an empty list. */
  async listPlanning(): Promise<CommanderPlan[]> {
    const dir = await this.fs.resolve(join(this.root, PLANNING_DIR))
    const info = await this.fs.stat(dir)
    if (info === undefined) return []
    if (info.type !== 'directory') throw new Error(`devflow: not a directory: ${dir.displayPath}`)
    const plans: CommanderPlan[] = []
    for (const entry of await this.fs.listDir(dir)) {
      if (entry.type !== 'file' || !entry.name.endsWith(FILE_SUFFIX)) continue
      const raw = await this.readJson(entry.target)
      if (raw !== undefined) plans.push(validateCommanderPlan(raw, entry.target.displayPath))
    }
    return plans.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /** Create and persist one execution batch (starts `planned`). */
  async createBatch(input: Omit<ExecutionBatch, 'batchId' | 'status' | 'createdAt' | 'updatedAt'>): Promise<ExecutionBatch> {
    const now = new Date().toISOString()
    const batch: ExecutionBatch = { ...input, batchId: randomUUID(), status: 'planned', createdAt: now, updatedAt: now }
    validateExecutionBatch(batch, 'memory')
    await this.writeJson(await this.batchTarget(batch.batchId), batch, { kind: 'createIfAbsent' })
    return batch
  }

  /** Load one execution batch; undefined when the id is unknown. */
  async getBatch(id: string): Promise<ExecutionBatch | undefined> {
    assertUuid(id, 'batch')
    const target = await this.batchTarget(id)
    const raw = await this.readJson(target)
    return raw === undefined ? undefined : validateExecutionBatch(raw, target.displayPath)
  }

  /** Transition one execution batch's status, validating the lifecycle edge. */
  async updateBatchStatus(id: string, status: ExecutionBatchStatus): Promise<ExecutionBatch> {
    assertUuid(id, 'batch')
    const existing = await this.getBatch(id)
    if (existing === undefined) throw new Error(`devflow: cannot update unknown batch ${id}`)
    const allowed = EXECUTION_BATCH_TRANSITIONS[existing.status]
    if (!allowed.includes(status)) {
      throw new Error(`devflow: illegal execution-batch transition ${existing.status} -> ${status} for ${id}`)
    }
    const updated: ExecutionBatch = { ...existing, status, updatedAt: new Date().toISOString() }
    validateExecutionBatch(updated, 'memory')
    await this.writeJson(await this.batchTarget(id), updated)
    return updated
  }

  /** Load every execution batch, oldest first; an empty batches/ is an empty list. */
  async listBatches(): Promise<ExecutionBatch[]> {
    const dir = await this.fs.resolve(join(this.root, BATCHES_DIR))
    const info = await this.fs.stat(dir)
    if (info === undefined) return []
    if (info.type !== 'directory') throw new Error(`devflow: not a directory: ${dir.displayPath}`)
    const batches: ExecutionBatch[] = []
    for (const entry of await this.fs.listDir(dir)) {
      if (entry.type !== 'file' || !entry.name.endsWith(FILE_SUFFIX)) continue
      const raw = await this.readJson(entry.target)
      if (raw !== undefined) batches.push(validateExecutionBatch(raw, entry.target.displayPath))
    }
    return batches.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /** Resolve one execution record file. */
  private executionTarget(id: string): Promise<FsTarget> {
    return this.fs.resolve(join(this.root, EXECUTIONS_DIR, `${id}${FILE_SUFFIX}`))
  }

  /** Resolve one agent report record file. */
  private reportTarget(id: string): Promise<FsTarget> {
    return this.fs.resolve(join(this.root, REPORTS_DIR, `${id}${FILE_SUFFIX}`))
  }

  /** Create and persist one execution record (starts `pending`). */
  async createExecutionRecord(
    input: Omit<ExecutionRecord, 'executionId' | 'status' | 'startedAt' | 'completedAt' | 'createdAt' | 'updatedAt'>,
  ): Promise<ExecutionRecord> {
    const now = new Date().toISOString()
    const execution: ExecutionRecord = {
      ...input,
      executionId: randomUUID(),
      status: 'pending',
      startedAt: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    }
    validateExecutionRecord(execution, 'memory')
    await this.writeJson(await this.executionTarget(execution.executionId), execution, { kind: 'createIfAbsent' })
    return execution
  }

  /** Load one execution record; undefined when the id is unknown. */
  async getExecutionRecord(id: string): Promise<ExecutionRecord | undefined> {
    assertUuid(id, 'execution')
    const target = await this.executionTarget(id)
    const raw = await this.readJson(target)
    return raw === undefined ? undefined : validateExecutionRecord(raw, target.displayPath)
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
  async updateExecutionStatus(id: string, status: ExecutionStatus, closeReason?: DevFlowCloseReason): Promise<ExecutionRecord> {
    assertUuid(id, 'execution')
    const existing = await this.getExecutionRecord(id)
    if (existing === undefined) throw new Error(`devflow: cannot update unknown execution ${id}`)
    const allowed = EXECUTION_TRANSITIONS[existing.status]
    if (!allowed.includes(status)) {
      throw new Error(`devflow: illegal execution transition ${existing.status} -> ${status} for ${id}`)
    }
    if (status === 'closed' && !isDevFlowCloseReason(closeReason)) {
      throw new Error(`devflow: closing execution ${id} requires a close reason`)
    }
    if (status !== 'closed' && closeReason !== undefined) {
      throw new Error(`devflow: execution ${id} may only carry a close reason while closed`)
    }
    const now = new Date().toISOString()
    const { closedAt: _closedAt, closeReason: _closeReason, ...rest } = existing
    const updated: ExecutionRecord = {
      ...rest,
      status,
      ...(status === 'running' && existing.startedAt === null ? { startedAt: now } : {}),
      ...((status === 'completed' || status === 'failed') && existing.completedAt === null ? { completedAt: now } : {}),
      ...(status === 'closed' ? { closedAt: now, closeReason: closeReason as DevFlowCloseReason } : {}),
      updatedAt: now,
    }
    validateExecutionRecord(updated, 'memory')
    await this.writeJson(await this.executionTarget(id), updated)
    if (updated.status === 'closed') {
      await this.appendClosure('devflow/execution/close', {
        executionId: id,
        closeReason: updated.closeReason as DevFlowCloseReason,
        at: updated.closedAt as string,
      })
    }
    return updated
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
  private async appendClosure(
    type: 'devflow/orchestration/close' | 'devflow/execution/close',
    data: DevFlowJsonValue,
  ): Promise<void> {
    try {
      await recordDevFlowChange(this, type, data)
    } catch {
      // Deliberately swallowed; see the method contract above.
    }
  }

  /** Load every execution record for one task, oldest first. */
  async listExecutionsByTask(taskId: string): Promise<ExecutionRecord[]> {
    if (!isString(taskId) || taskId.trim() === '') throw new Error('devflow: taskId must be a non-empty string')
    const dir = await this.fs.resolve(join(this.root, EXECUTIONS_DIR))
    const info = await this.fs.stat(dir)
    if (info === undefined) return []
    if (info.type !== 'directory') throw new Error(`devflow: not a directory: ${dir.displayPath}`)
    const executions: ExecutionRecord[] = []
    for (const entry of await this.fs.listDir(dir)) {
      if (entry.type !== 'file' || !entry.name.endsWith(FILE_SUFFIX)) continue
      const raw = await this.readJson(entry.target)
      if (raw !== undefined) {
        const record = validateExecutionRecord(raw, entry.target.displayPath)
        if (record.taskId === taskId) executions.push(record)
      }
    }
    return executions.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /** Load every execution record for one batch, oldest first. */
  async listExecutionsByBatch(batchId: string): Promise<ExecutionRecord[]> {
    const dir = await this.fs.resolve(join(this.root, EXECUTIONS_DIR))
    const info = await this.fs.stat(dir)
    if (info === undefined) return []
    if (info.type !== 'directory') throw new Error(`devflow: not a directory: ${dir.displayPath}`)
    const executions: ExecutionRecord[] = []
    for (const entry of await this.fs.listDir(dir)) {
      if (entry.type !== 'file' || !entry.name.endsWith(FILE_SUFFIX)) continue
      const raw = await this.readJson(entry.target)
      if (raw !== undefined) {
        const record = validateExecutionRecord(raw, entry.target.displayPath)
        if (record.batchId === batchId) executions.push(record)
      }
    }
    return executions.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /** Create and persist one agent report with a generated id and timestamps. */
  async createReport(input: Omit<AgentReport, 'reportId' | 'createdAt' | 'updatedAt'>): Promise<AgentReport> {
    const now = new Date().toISOString()
    const report: AgentReport = { ...input, reportId: randomUUID(), createdAt: now, updatedAt: now }
    validateAgentReport(report, 'memory')
    await this.writeJson(await this.reportTarget(report.reportId), report, { kind: 'createIfAbsent' })
    return report
  }

  /** Load one agent report; undefined when the id is unknown. */
  async getReport(id: string): Promise<AgentReport | undefined> {
    assertUuid(id, 'report')
    const target = await this.reportTarget(id)
    const raw = await this.readJson(target)
    return raw === undefined ? undefined : validateAgentReport(raw, target.displayPath)
  }

  /** Load every report for all executions of one task, oldest first. */
  async listReportsByTask(taskId: string): Promise<AgentReport[]> {
    const executionIds = new Set((await this.listExecutionsByTask(taskId)).map(execution => execution.executionId))
    if (executionIds.size === 0) return []
    const dir = await this.fs.resolve(join(this.root, REPORTS_DIR))
    const info = await this.fs.stat(dir)
    if (info === undefined) return []
    if (info.type !== 'directory') throw new Error(`devflow: not a directory: ${dir.displayPath}`)
    const reports: AgentReport[] = []
    for (const entry of await this.fs.listDir(dir)) {
      if (entry.type !== 'file' || !entry.name.endsWith(FILE_SUFFIX)) continue
      const raw = await this.readJson(entry.target)
      if (raw !== undefined) {
        const report = validateAgentReport(raw, entry.target.displayPath)
        if (executionIds.has(report.executionId)) reports.push(report)
      }
    }
    return reports.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /** Load every report for one execution, oldest first. */
  async listReportsByExecution(executionId: string): Promise<AgentReport[]> {
    const dir = await this.fs.resolve(join(this.root, REPORTS_DIR))
    const info = await this.fs.stat(dir)
    if (info === undefined) return []
    if (info.type !== 'directory') throw new Error(`devflow: not a directory: ${dir.displayPath}`)
    const reports: AgentReport[] = []
    for (const entry of await this.fs.listDir(dir)) {
      if (entry.type !== 'file' || !entry.name.endsWith(FILE_SUFFIX)) continue
      const raw = await this.readJson(entry.target)
      if (raw !== undefined) {
        const report = validateAgentReport(raw, entry.target.displayPath)
        if (report.executionId === executionId) reports.push(report)
      }
    }
    return reports.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /** Apply a partial update to one agent report and refresh `updatedAt`. */
  async updateReport(id: string, patch: AgentReportUpdate): Promise<AgentReport> {
    assertUuid(id, 'report')
    const existing = await this.getReport(id)
    if (existing === undefined) throw new Error(`devflow: cannot update unknown report ${id}`)
    const { status, summary, outputReference } = patch
    const updated: AgentReport = {
      ...existing,
      ...(status !== undefined ? { status } : {}),
      ...(summary !== undefined ? { summary } : {}),
      ...(outputReference !== undefined ? { outputReference } : {}),
      updatedAt: new Date().toISOString(),
    }
    validateAgentReport(updated, 'memory')
    await this.writeJson(await this.reportTarget(id), updated)
    return updated
  }

  /** Resolve one commander decision record file. */
  private decisionTarget(id: string): Promise<FsTarget> {
    return this.fs.resolve(join(this.root, DECISIONS_DIR, `${id}${FILE_SUFFIX}`))
  }

  /** Create and persist one commander decision with a generated id and timestamps. */
  async createDecision(input: Omit<CommanderDecision, 'decisionId' | 'createdAt' | 'updatedAt'>): Promise<CommanderDecision> {
    const now = new Date().toISOString()
    const decision: CommanderDecision = { ...input, decisionId: randomUUID(), createdAt: now, updatedAt: now }
    validateCommanderDecision(decision, 'memory')
    await this.writeJson(await this.decisionTarget(decision.decisionId), decision, { kind: 'createIfAbsent' })
    return decision
  }

  /** Load one commander decision; undefined when the id is unknown. */
  async getDecision(id: string): Promise<CommanderDecision | undefined> {
    assertUuid(id, 'decision')
    const target = await this.decisionTarget(id)
    const raw = await this.readJson(target)
    return raw === undefined ? undefined : validateCommanderDecision(raw, target.displayPath)
  }

  /** Load every commander decision, oldest first; an empty decisions/ is an empty list. */
  async listDecisions(): Promise<CommanderDecision[]> {
    const dir = await this.fs.resolve(join(this.root, DECISIONS_DIR))
    const info = await this.fs.stat(dir)
    if (info === undefined) return []
    if (info.type !== 'directory') throw new Error(`devflow: not a directory: ${dir.displayPath}`)
    const decisions: CommanderDecision[] = []
    for (const entry of await this.fs.listDir(dir)) {
      if (entry.type !== 'file' || !entry.name.endsWith(FILE_SUFFIX)) continue
      const raw = await this.readJson(entry.target)
      if (raw !== undefined) decisions.push(validateCommanderDecision(raw, entry.target.displayPath))
    }
    return decisions.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /** Apply a partial update to one commander decision and refresh `updatedAt`. */
  async updateDecision(id: string, patch: CommanderDecisionUpdate): Promise<CommanderDecision> {
    assertUuid(id, 'decision')
    const existing = await this.getDecision(id)
    if (existing === undefined) throw new Error(`devflow: cannot update unknown decision ${id}`)
    const { checkpointId, relatedExecutionIds, decisionType, summary, nextAction } = patch
    const updated: CommanderDecision = {
      ...existing,
      ...(checkpointId !== undefined ? { checkpointId } : {}),
      ...(relatedExecutionIds !== undefined ? { relatedExecutionIds } : {}),
      ...(decisionType !== undefined ? { decisionType } : {}),
      ...(summary !== undefined ? { summary } : {}),
      ...(nextAction !== undefined ? { nextAction } : {}),
      updatedAt: new Date().toISOString(),
    }
    validateCommanderDecision(updated, 'memory')
    await this.writeJson(await this.decisionTarget(id), updated)
    return updated
  }

  /** Resolve one commander control action record file. */
  private actionTarget(id: string): Promise<FsTarget> {
    return this.fs.resolve(join(this.root, ACTIONS_DIR, `${id}${FILE_SUFFIX}`))
  }

  /** Create and persist one commander control action with a generated id and timestamps. */
  async createAction(input: Omit<CommanderAction, 'actionId' | 'status' | 'createdAt' | 'updatedAt'>): Promise<CommanderAction> {
    const now = new Date().toISOString()
    const action: CommanderAction = {
      ...input,
      actionId: randomUUID(),
      status: 'created',
      createdAt: now,
      updatedAt: now,
    }
    validateCommanderAction(action, 'memory')
    await this.writeJson(await this.actionTarget(action.actionId), action, { kind: 'createIfAbsent' })
    return action
  }

  /** Load one commander control action; undefined when the id is unknown. */
  async getAction(id: string): Promise<CommanderAction | undefined> {
    assertUuid(id, 'action')
    const target = await this.actionTarget(id)
    const raw = await this.readJson(target)
    return raw === undefined ? undefined : validateCommanderAction(raw, target.displayPath)
  }

  /** Load every commander control action, oldest first; an empty actions/ is an empty list. */
  async listActions(): Promise<CommanderAction[]> {
    const dir = await this.fs.resolve(join(this.root, ACTIONS_DIR))
    const info = await this.fs.stat(dir)
    if (info === undefined) return []
    if (info.type !== 'directory') throw new Error(`devflow: not a directory: ${dir.displayPath}`)
    const actions: CommanderAction[] = []
    for (const entry of await this.fs.listDir(dir)) {
      if (entry.type !== 'file' || !entry.name.endsWith(FILE_SUFFIX)) continue
      const raw = await this.readJson(entry.target)
      if (raw !== undefined) actions.push(validateCommanderAction(raw, entry.target.displayPath))
    }
    return actions.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /**
   * Transition one commander control action's status through the created →
   * executing → completed chain and refresh `updatedAt`.
   */
  async updateActionStatus(id: string, status: CommanderActionStatus): Promise<CommanderAction> {
    assertUuid(id, 'action')
    const existing = await this.getAction(id)
    if (existing === undefined) throw new Error(`devflow: cannot update unknown action ${id}`)
    if (!ACTION_TRANSITIONS[existing.status].includes(status)) {
      throw new Error(`devflow: illegal action transition ${existing.status} -> ${status} for ${id}`)
    }
    const updated: CommanderAction = { ...existing, status, updatedAt: new Date().toISOString() }
    validateCommanderAction(updated, 'memory')
    await this.writeJson(await this.actionTarget(id), updated)
    return updated
  }

  /** Resolve one runtime session record file. */
  private sessionTarget(id: string): Promise<FsTarget> {
    return this.fs.resolve(join(this.root, SESSIONS_DIR, `${id}${FILE_SUFFIX}`))
  }

  /**
   * Create and persist one runtime session (starts `created`).
   * @param input - session fields without the store-owned id, status,
   *   timestamps, and start/complete stamps.
   * @returns the persisted session.
   */
  async createRuntimeSession(
    input: Omit<RuntimeSession, 'sessionId' | 'status' | 'startedAt' | 'completedAt' | 'createdAt' | 'updatedAt'>,
  ): Promise<RuntimeSession> {
    const now = new Date().toISOString()
    const session: RuntimeSession = {
      ...input,
      sessionId: randomUUID(),
      status: 'created',
      startedAt: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    }
    validateRuntimeSession(session, 'memory')
    await this.writeJson(await this.sessionTarget(session.sessionId), session, { kind: 'createIfAbsent' })
    return session
  }

  /** Load one runtime session; undefined when the id is unknown. */
  async getRuntimeSession(id: string): Promise<RuntimeSession | undefined> {
    assertUuid(id, 'session')
    const target = await this.sessionTarget(id)
    const raw = await this.readJson(target)
    return raw === undefined ? undefined : validateRuntimeSession(raw, target.displayPath)
  }

  /**
   * Transition one runtime session's status, validating the lifecycle edge
   * and stamping `startedAt`/`completedAt` on the crossing edges.
   */
  async updateRuntimeSessionStatus(id: string, status: RuntimeSessionStatus): Promise<RuntimeSession> {
    assertUuid(id, 'session')
    const existing = await this.getRuntimeSession(id)
    if (existing === undefined) throw new Error(`devflow: cannot update unknown runtime session ${id}`)
    const allowed = RUNTIME_SESSION_TRANSITIONS[existing.status]
    if (!allowed.includes(status)) {
      throw new Error(`devflow: illegal runtime session transition ${existing.status} -> ${status} for ${id}`)
    }
    const now = new Date().toISOString()
    const updated: RuntimeSession = {
      ...existing,
      status,
      ...(status === 'running' && existing.startedAt === null ? { startedAt: now } : {}),
      ...((status === 'completed' || status === 'failed') && existing.completedAt === null ? { completedAt: now } : {}),
      updatedAt: now,
    }
    validateRuntimeSession(updated, 'memory')
    await this.writeJson(await this.sessionTarget(id), updated)
    return updated
  }

  /** Load every runtime session for one execution, oldest first. */
  async listRuntimeSessionsByExecution(executionId: string): Promise<RuntimeSession[]> {
    const dir = await this.fs.resolve(join(this.root, SESSIONS_DIR))
    const info = await this.fs.stat(dir)
    if (info === undefined) return []
    if (info.type !== 'directory') throw new Error(`devflow: not a directory: ${dir.displayPath}`)
    const sessions: RuntimeSession[] = []
    for (const entry of await this.fs.listDir(dir)) {
      if (entry.type !== 'file' || !entry.name.endsWith(FILE_SUFFIX)) continue
      const raw = await this.readJson(entry.target)
      if (raw !== undefined) {
        const session = validateRuntimeSession(raw, entry.target.displayPath)
        if (session.executionId === executionId) sessions.push(session)
      }
    }
    return sessions.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /**
   * Persist one complete agent report record as-is (validate + write). This
   * keeps the report id and timestamps produced by the runtime bridge — the
   * caller layer that converted a runtime result package — authoritative.
   * @param report - the complete report record to persist.
   */
  async saveReport(report: AgentReport): Promise<void> {
    validateAgentReport(report, 'memory')
    await this.writeJson(await this.reportTarget(report.reportId), report, { kind: 'createIfAbsent' })
  }

  /** Resolve one execution attempt record file. */
  private attemptTarget(id: string): Promise<FsTarget> {
    return this.fs.resolve(join(this.root, ATTEMPTS_DIR, `${id}${FILE_SUFFIX}`))
  }

  /**
   * Create and persist one execution attempt (starts `created`). A retry
   * chains a new attempt under the previous one via `parentAttemptId` and
   * records why it exists in `reason`.
   * @param input - attempt fields without the store-owned id, status,
   *   `createdAt`, `completedAt`, and `updatedAt`.
   * @returns the persisted attempt.
   */
  async createAttempt(
    input: Omit<ExecutionAttempt, 'attemptId' | 'status' | 'createdAt' | 'completedAt' | 'updatedAt'>,
  ): Promise<ExecutionAttempt> {
    const now = new Date().toISOString()
    const attempt: ExecutionAttempt = {
      ...input,
      attemptId: randomUUID(),
      status: 'created',
      createdAt: now,
      completedAt: null,
      updatedAt: now,
    }
    validateExecutionAttempt(attempt, 'memory')
    await this.writeJson(await this.attemptTarget(attempt.attemptId), attempt, { kind: 'createIfAbsent' })
    return attempt
  }

  /** Load one execution attempt; undefined when the id is unknown. */
  async getAttempt(id: string): Promise<ExecutionAttempt | undefined> {
    assertUuid(id, 'attempt')
    const target = await this.attemptTarget(id)
    const raw = await this.readJson(target)
    return raw === undefined ? undefined : validateExecutionAttempt(raw, target.displayPath)
  }

  /**
   * Transition one execution attempt's status, validating the lifecycle edge
   * and stamping `completedAt` on the terminal edges.
   */
  async updateAttemptStatus(id: string, status: ExecutionAttemptStatus): Promise<ExecutionAttempt> {
    assertUuid(id, 'attempt')
    const existing = await this.getAttempt(id)
    if (existing === undefined) throw new Error(`devflow: cannot update unknown execution attempt ${id}`)
    const allowed = ATTEMPT_TRANSITIONS[existing.status]
    if (!allowed.includes(status)) {
      throw new Error(`devflow: illegal execution attempt transition ${existing.status} -> ${status} for ${id}`)
    }
    const now = new Date().toISOString()
    const updated: ExecutionAttempt = {
      ...existing,
      status,
      ...((status === 'completed' || status === 'failed') && existing.completedAt === null ? { completedAt: now } : {}),
      updatedAt: now,
    }
    validateExecutionAttempt(updated, 'memory')
    await this.writeJson(await this.attemptTarget(id), updated)
    return updated
  }

  /** Load every execution attempt for one execution, oldest first. */
  async listAttemptsByExecution(executionId: string): Promise<ExecutionAttempt[]> {
    const dir = await this.fs.resolve(join(this.root, ATTEMPTS_DIR))
    const info = await this.fs.stat(dir)
    if (info === undefined) return []
    if (info.type !== 'directory') throw new Error(`devflow: not a directory: ${dir.displayPath}`)
    const attempts: ExecutionAttempt[] = []
    for (const entry of await this.fs.listDir(dir)) {
      if (entry.type !== 'file' || !entry.name.endsWith(FILE_SUFFIX)) continue
      const raw = await this.readJson(entry.target)
      if (raw !== undefined) {
        const attempt = validateExecutionAttempt(raw, entry.target.displayPath)
        if (attempt.executionId === executionId) attempts.push(attempt)
      }
    }
    return attempts.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /** Resolve one commander review record file. */
  private reviewTarget(id: string): Promise<FsTarget> {
    return this.fs.resolve(join(this.root, REVIEWS_DIR, `${id}${FILE_SUFFIX}`))
  }

  /**
   * Create and persist one commander review (starts `pending`).
   * @param input - review fields without the store-owned id, status, and
   *   timestamps.
   * @returns the persisted review.
   */
  async createReview(input: Omit<CommanderReview, 'reviewId' | 'status' | 'createdAt' | 'updatedAt'>): Promise<CommanderReview> {
    const now = new Date().toISOString()
    const review: CommanderReview = {
      ...input,
      reviewId: randomUUID(),
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    }
    validateCommanderReview(review, 'memory')
    await this.writeJson(await this.reviewTarget(review.reviewId), review, { kind: 'createIfAbsent' })
    return review
  }

  /** Load one commander review; undefined when the id is unknown. */
  async getReview(id: string): Promise<CommanderReview | undefined> {
    assertUuid(id, 'review')
    const target = await this.reviewTarget(id)
    const raw = await this.readJson(target)
    return raw === undefined ? undefined : validateCommanderReview(raw, target.displayPath)
  }

  /**
   * Complete one commander review (pending → reviewed) and refresh
   * `updatedAt`. The review carries no decision content — a future Commander
   * fills the decision from an explicit review outcome.
   */
  async completeReview(id: string): Promise<CommanderReview> {
    assertUuid(id, 'review')
    const existing = await this.getReview(id)
    if (existing === undefined) throw new Error(`devflow: cannot complete unknown review ${id}`)
    if (!REVIEW_TRANSITIONS[existing.status].includes('reviewed')) {
      throw new Error(`devflow: illegal review transition ${existing.status} -> reviewed for ${id}`)
    }
    const updated: CommanderReview = { ...existing, status: 'reviewed', updatedAt: new Date().toISOString() }
    validateCommanderReview(updated, 'memory')
    await this.writeJson(await this.reviewTarget(id), updated)
    return updated
  }

  /** Load every commander review for one execution, oldest first. */
  async listReviewsByExecution(executionId: string): Promise<CommanderReview[]> {
    const dir = await this.fs.resolve(join(this.root, REVIEWS_DIR))
    const info = await this.fs.stat(dir)
    if (info === undefined) return []
    if (info.type !== 'directory') throw new Error(`devflow: not a directory: ${dir.displayPath}`)
    const reviews: CommanderReview[] = []
    for (const entry of await this.fs.listDir(dir)) {
      if (entry.type !== 'file' || !entry.name.endsWith(FILE_SUFFIX)) continue
      const raw = await this.readJson(entry.target)
      if (raw !== undefined) {
        const review = validateCommanderReview(raw, entry.target.displayPath)
        if (review.executionId === executionId) reviews.push(review)
      }
    }
    return reviews.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /** Resolve one commander memory record file. */
  private memoryTarget(id: string): Promise<FsTarget> {
    return this.fs.resolve(join(this.root, MEMORY_DIR, `${id}${FILE_SUFFIX}`))
  }

  /**
   * Create and persist one structured commander memory with a generated id
   * and timestamps.
   * @param input - memory fields without the store-owned id and timestamps.
   * @returns the persisted memory.
   */
  async createMemory(input: Omit<CommanderMemory, 'memoryId' | 'createdAt' | 'updatedAt'>): Promise<CommanderMemory> {
    const now = new Date().toISOString()
    const memory: CommanderMemory = { ...input, memoryId: randomUUID(), createdAt: now, updatedAt: now }
    validateCommanderMemory(memory, 'memory')
    await this.writeJson(await this.memoryTarget(memory.memoryId), memory, { kind: 'createIfAbsent' })
    return memory
  }

  /** Load one commander memory; undefined when the id is unknown. */
  async getMemory(id: string): Promise<CommanderMemory | undefined> {
    assertUuid(id, 'memory')
    const target = await this.memoryTarget(id)
    const raw = await this.readJson(target)
    return raw === undefined ? undefined : validateCommanderMemory(raw, target.displayPath)
  }

  /**
   * Apply a partial update to one commander memory and refresh `updatedAt`.
   * The id, project, type, and `createdAt` are immutable; unknown ids fail
   * loud.
   */
  async updateMemory(id: string, patch: CommanderMemoryUpdate): Promise<CommanderMemory> {
    assertUuid(id, 'memory')
    const existing = await this.getMemory(id)
    if (existing === undefined) throw new Error(`devflow: cannot update unknown memory ${id}`)
    const { content, source } = patch
    const updated: CommanderMemory = {
      ...existing,
      ...(content !== undefined ? { content } : {}),
      ...(source !== undefined ? { source } : {}),
      updatedAt: new Date().toISOString(),
    }
    validateCommanderMemory(updated, 'memory')
    await this.writeJson(await this.memoryTarget(id), updated)
    return updated
  }

  /** Load every commander memory for one project, oldest first. */
  async listMemoriesByProject(projectId: string): Promise<CommanderMemory[]> {
    const dir = await this.fs.resolve(join(this.root, MEMORY_DIR))
    const info = await this.fs.stat(dir)
    if (info === undefined) return []
    if (info.type !== 'directory') throw new Error(`devflow: not a directory: ${dir.displayPath}`)
    const memories: CommanderMemory[] = []
    for (const entry of await this.fs.listDir(dir)) {
      if (entry.type !== 'file' || !entry.name.endsWith(FILE_SUFFIX)) continue
      const raw = await this.readJson(entry.target)
      if (raw !== undefined) {
        const memory = validateCommanderMemory(raw, entry.target.displayPath)
        if (memory.projectId === projectId) memories.push(memory)
      }
    }
    return memories.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /** Resolve one commander schedule record file. */
  private scheduleTarget(id: string): Promise<FsTarget> {
    return this.fs.resolve(join(this.root, SCHEDULES_DIR, `${id}${FILE_SUFFIX}`))
  }

  /**
   * Create and persist one commander schedule (starts `active` with no last
   * run and the first `nextRunAt` one interval ahead).
   * @param input - schedule fields without the store-owned id, status,
   *   run stamps, and timestamps.
   * @returns the persisted schedule.
   */
  async createSchedule(
    input: Omit<CommanderSchedule, 'scheduleId' | 'status' | 'lastRunAt' | 'nextRunAt' | 'createdAt' | 'updatedAt'>,
  ): Promise<CommanderSchedule> {
    const now = new Date().toISOString()
    const schedule: CommanderSchedule = {
      ...input,
      scheduleId: randomUUID(),
      status: 'active',
      lastRunAt: null,
      nextRunAt: new Date(Date.parse(now) + input.interval).toISOString(),
      createdAt: now,
      updatedAt: now,
    }
    validateCommanderSchedule(schedule, 'memory')
    await this.writeJson(await this.scheduleTarget(schedule.scheduleId), schedule, { kind: 'createIfAbsent' })
    return schedule
  }

  /** Load one commander schedule; undefined when the id is unknown. */
  async getSchedule(id: string): Promise<CommanderSchedule | undefined> {
    assertUuid(id, 'schedule')
    const target = await this.scheduleTarget(id)
    const raw = await this.readJson(target)
    return raw === undefined ? undefined : validateCommanderSchedule(raw, target.displayPath)
  }

  /**
   * Apply a partial update to one commander schedule: an interval change
   * rolls `nextRunAt` forward, and a `markRunAt` stamp records a completed
   * run. Unknown ids fail loud.
   */
  async updateSchedule(id: string, patch: CommanderScheduleUpdate): Promise<CommanderSchedule> {
    assertUuid(id, 'schedule')
    const existing = await this.getSchedule(id)
    if (existing === undefined) throw new Error(`devflow: cannot update unknown schedule ${id}`)
    const updated = applySchedulePatch(existing, patch, new Date().toISOString())
    validateCommanderSchedule(updated, 'memory')
    await this.writeJson(await this.scheduleTarget(id), updated)
    return updated
  }

  /** Pause one commander schedule (active → paused) and refresh `updatedAt`. */
  async pauseSchedule(id: string): Promise<CommanderSchedule> {
    assertUuid(id, 'schedule')
    const existing = await this.getSchedule(id)
    if (existing === undefined) throw new Error(`devflow: cannot pause unknown schedule ${id}`)
    if (existing.status !== 'active') {
      throw new Error(`devflow: cannot pause schedule ${id} in status ${existing.status}`)
    }
    const updated: CommanderSchedule = { ...existing, status: 'paused', updatedAt: new Date().toISOString() }
    validateCommanderSchedule(updated, 'memory')
    await this.writeJson(await this.scheduleTarget(id), updated)
    return updated
  }

  /** Load every commander schedule, oldest first; an empty schedules/ is an empty list. */
  async listSchedules(): Promise<CommanderSchedule[]> {
    const dir = await this.fs.resolve(join(this.root, SCHEDULES_DIR))
    const info = await this.fs.stat(dir)
    if (info === undefined) return []
    if (info.type !== 'directory') throw new Error(`devflow: not a directory: ${dir.displayPath}`)
    const schedules: CommanderSchedule[] = []
    for (const entry of await this.fs.listDir(dir)) {
      if (entry.type !== 'file' || !entry.name.endsWith(FILE_SUFFIX)) continue
      const raw = await this.readJson(entry.target)
      if (raw !== undefined) schedules.push(validateCommanderSchedule(raw, entry.target.displayPath))
    }
    return schedules.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /** Resolve one commander run record file. */
  private runTarget(id: string): Promise<FsTarget> {
    return this.fs.resolve(join(this.root, RUNS_DIR, `${id}${FILE_SUFFIX}`))
  }

  /**
   * Create and persist one commander run record (born `running`).
   * @param input - run fields without the store-owned id, status, produced
   *   ids, and timestamps.
   * @returns the persisted run.
   */
  async createRunRecord(
    input: Omit<CommanderRunRecord, 'runId' | 'status' | 'decisionId' | 'actionId' | 'startedAt' | 'completedAt' | 'updatedAt'>,
  ): Promise<CommanderRunRecord> {
    const now = new Date().toISOString()
    const run: CommanderRunRecord = {
      ...input,
      runId: randomUUID(),
      status: 'running',
      decisionId: null,
      actionId: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
    }
    validateCommanderRunRecord(run, 'memory')
    await this.writeJson(await this.runTarget(run.runId), run, { kind: 'createIfAbsent' })
    return run
  }

  /** Load one commander run record; undefined when the id is unknown. */
  async getRunRecord(id: string): Promise<CommanderRunRecord | undefined> {
    assertUuid(id, 'run')
    const target = await this.runTarget(id)
    const raw = await this.readJson(target)
    return raw === undefined ? undefined : validateCommanderRunRecord(raw, target.displayPath)
  }

  /**
   * Complete one commander run (running → completed): record the produced
   * decision and action ids and stamp `completedAt`.
   */
  async completeRunRecord(id: string, decisionId: string, actionId: string): Promise<CommanderRunRecord> {
    assertUuid(id, 'run')
    const existing = await this.getRunRecord(id)
    if (existing === undefined) throw new Error(`devflow: cannot complete unknown run ${id}`)
    if (!RUN_TRANSITIONS[existing.status].includes('completed')) {
      throw new Error(`devflow: illegal run transition ${existing.status} -> completed for ${id}`)
    }
    const now = new Date().toISOString()
    const updated: CommanderRunRecord = {
      ...existing, status: 'completed', decisionId, actionId, completedAt: now, updatedAt: now,
    }
    validateCommanderRunRecord(updated, 'memory')
    await this.writeJson(await this.runTarget(id), updated)
    return updated
  }

  /** Fail one commander run (running → failed) and stamp `completedAt`. */
  async failRunRecord(id: string): Promise<CommanderRunRecord> {
    assertUuid(id, 'run')
    const existing = await this.getRunRecord(id)
    if (existing === undefined) throw new Error(`devflow: cannot fail unknown run ${id}`)
    if (!RUN_TRANSITIONS[existing.status].includes('failed')) {
      throw new Error(`devflow: illegal run transition ${existing.status} -> failed for ${id}`)
    }
    const now = new Date().toISOString()
    const updated: CommanderRunRecord = { ...existing, status: 'failed', completedAt: now, updatedAt: now }
    validateCommanderRunRecord(updated, 'memory')
    await this.writeJson(await this.runTarget(id), updated)
    return updated
  }

  /** Load every commander run record for one project, oldest first. */
  async listRunRecordsByProject(projectId: string): Promise<CommanderRunRecord[]> {
    const dir = await this.fs.resolve(join(this.root, RUNS_DIR))
    const info = await this.fs.stat(dir)
    if (info === undefined) return []
    if (info.type !== 'directory') throw new Error(`devflow: not a directory: ${dir.displayPath}`)
    const runs: CommanderRunRecord[] = []
    for (const entry of await this.fs.listDir(dir)) {
      if (entry.type !== 'file' || !entry.name.endsWith(FILE_SUFFIX)) continue
      const raw = await this.readJson(entry.target)
      if (raw !== undefined) {
        const run = validateCommanderRunRecord(raw, entry.target.displayPath)
        if (run.projectId === projectId) runs.push(run)
      }
    }
    return runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  }

  /** Resolve one commander action execution record file. */
  private actionExecutionTarget(id: string): Promise<FsTarget> {
    return this.fs.resolve(join(this.root, ACTION_EXECUTIONS_DIR, `${id}${FILE_SUFFIX}`))
  }

  /**
   * Create and persist one commander action execution (born `running` with no
   * outcome yet).
   * @param input - execution fields without the store-owned id, status,
   *   outcome, and timestamps.
   * @returns the persisted execution.
   */
  async createActionExecution(
    input: Omit<CommanderActionExecutionRecord, 'executionId' | 'status' | 'success' | 'error' | 'createdAt' | 'completedAt' | 'updatedAt'>,
  ): Promise<CommanderActionExecutionRecord> {
    const now = new Date().toISOString()
    const execution: CommanderActionExecutionRecord = {
      ...input,
      executionId: randomUUID(),
      status: 'running',
      success: null,
      error: null,
      createdAt: now,
      completedAt: null,
      updatedAt: now,
    }
    validateCommanderActionExecution(execution, 'memory')
    await this.writeJson(await this.actionExecutionTarget(execution.executionId), execution, { kind: 'createIfAbsent' })
    return execution
  }

  /** Load one commander action execution; undefined when the id is unknown. */
  async getActionExecution(id: string): Promise<CommanderActionExecutionRecord | undefined> {
    assertUuid(id, 'action-execution')
    const target = await this.actionExecutionTarget(id)
    const raw = await this.readJson(target)
    return raw === undefined ? undefined : validateCommanderActionExecution(raw, target.displayPath)
  }

  /** Complete one action execution (running → completed, success true) and stamp `completedAt`. */
  async completeActionExecution(id: string): Promise<CommanderActionExecutionRecord> {
    assertUuid(id, 'action-execution')
    const existing = await this.getActionExecution(id)
    if (existing === undefined) throw new Error(`devflow: cannot complete unknown action execution ${id}`)
    if (!ACTION_EXECUTION_TRANSITIONS[existing.status].includes('completed')) {
      throw new Error(`devflow: illegal action execution transition ${existing.status} -> completed for ${id}`)
    }
    const now = new Date().toISOString()
    const updated: CommanderActionExecutionRecord = {
      ...existing, status: 'completed', success: true, completedAt: now, updatedAt: now,
    }
    validateCommanderActionExecution(updated, 'memory')
    await this.writeJson(await this.actionExecutionTarget(id), updated)
    return updated
  }

  /** Fail one action execution (running → failed, success false) with the error, and stamp `completedAt`. */
  async failActionExecution(id: string, error: string): Promise<CommanderActionExecutionRecord> {
    assertUuid(id, 'action-execution')
    const existing = await this.getActionExecution(id)
    if (existing === undefined) throw new Error(`devflow: cannot fail unknown action execution ${id}`)
    if (!ACTION_EXECUTION_TRANSITIONS[existing.status].includes('failed')) {
      throw new Error(`devflow: illegal action execution transition ${existing.status} -> failed for ${id}`)
    }
    const now = new Date().toISOString()
    const updated: CommanderActionExecutionRecord = {
      ...existing, status: 'failed', success: false, error, completedAt: now, updatedAt: now,
    }
    validateCommanderActionExecution(updated, 'memory')
    await this.writeJson(await this.actionExecutionTarget(id), updated)
    return updated
  }

  /** Load every commander action execution for one action, oldest first. */
  async listActionExecutionsByAction(actionId: string): Promise<CommanderActionExecutionRecord[]> {
    const dir = await this.fs.resolve(join(this.root, ACTION_EXECUTIONS_DIR))
    const info = await this.fs.stat(dir)
    if (info === undefined) return []
    if (info.type !== 'directory') throw new Error(`devflow: not a directory: ${dir.displayPath}`)
    const executions: CommanderActionExecutionRecord[] = []
    for (const entry of await this.fs.listDir(dir)) {
      if (entry.type !== 'file' || !entry.name.endsWith(FILE_SUFFIX)) continue
      const raw = await this.readJson(entry.target)
      if (raw !== undefined) {
        const execution = validateCommanderActionExecution(raw, entry.target.displayPath)
        if (execution.actionId === actionId) executions.push(execution)
      }
    }
    return executions.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /** Resolve one project policy record file. */
  private policyTarget(projectId: string): Promise<FsTarget> {
    return this.fs.resolve(join(this.root, POLICIES_DIR, `${projectId}${FILE_SUFFIX}`))
  }

  /**
   * Save (create or replace) the governance policy for one project. The
   * first save sets `createdAt`; later saves keep it and refresh `updatedAt`.
   * @param policy - policy fields without the store-owned timestamps.
   * @returns the persisted policy.
   */
  async savePolicy(policy: Omit<CommanderPolicy, 'createdAt' | 'updatedAt'>): Promise<CommanderPolicy> {
    assertProjectId(policy.projectId)
    const existing = await this.getPolicy(policy.projectId)
    const now = new Date().toISOString()
    const saved: CommanderPolicy = { ...policy, createdAt: existing?.createdAt ?? now, updatedAt: now }
    validateCommanderPolicy(saved, 'memory')
    await this.writeJson(await this.policyTarget(policy.projectId), saved)
    return saved
  }

  /** Load the governance policy for one project; undefined when never saved. */
  async getPolicy(projectId: string): Promise<CommanderPolicy | undefined> {
    assertProjectId(projectId)
    const target = await this.policyTarget(projectId)
    const raw = await this.readJson(target)
    return raw === undefined ? undefined : validateCommanderPolicy(raw, target.displayPath)
  }

  /** Resolve one commander proposal record file. */
  private proposalTarget(id: string): Promise<FsTarget> {
    return this.fs.resolve(join(this.root, PROPOSALS_DIR, `${id}${FILE_SUFFIX}`))
  }

  /**
   * Create and persist one commander proposal (starts `created`).
   * @param input - proposal fields without the store-owned id, status, and
   *   timestamps.
   * @returns the persisted proposal.
   */
  async createProposal(
    input: Omit<CommanderProposal, 'proposalId' | 'status' | 'createdAt' | 'updatedAt'>,
  ): Promise<CommanderProposal> {
    const now = new Date().toISOString()
    const proposal: CommanderProposal = {
      ...input,
      proposalId: randomUUID(),
      status: 'created',
      createdAt: now,
      updatedAt: now,
    }
    validateCommanderProposal(proposal, 'memory')
    await this.writeJson(await this.proposalTarget(proposal.proposalId), proposal, { kind: 'createIfAbsent' })
    return proposal
  }

  /** Load one commander proposal; undefined when the id is unknown. */
  async getProposal(id: string): Promise<CommanderProposal | undefined> {
    assertUuid(id, 'proposal')
    const target = await this.proposalTarget(id)
    const raw = await this.readJson(target)
    return raw === undefined ? undefined : validateCommanderProposal(raw, target.displayPath)
  }

  /** Approve one commander proposal (created → approved) and refresh `updatedAt`. */
  async approveProposal(id: string): Promise<CommanderProposal> {
    assertUuid(id, 'proposal')
    const existing = await this.getProposal(id)
    if (existing === undefined) throw new Error(`devflow: cannot approve unknown proposal ${id}`)
    if (!PROPOSAL_TRANSITIONS[existing.status].includes('approved')) {
      throw new Error(`devflow: illegal proposal transition ${existing.status} -> approved for ${id}`)
    }
    const updated: CommanderProposal = { ...existing, status: 'approved', updatedAt: new Date().toISOString() }
    validateCommanderProposal(updated, 'memory')
    await this.writeJson(await this.proposalTarget(id), updated)
    return updated
  }

  /** Reject one commander proposal (created → rejected) and refresh `updatedAt`. */
  async rejectProposal(id: string): Promise<CommanderProposal> {
    assertUuid(id, 'proposal')
    const existing = await this.getProposal(id)
    if (existing === undefined) throw new Error(`devflow: cannot reject unknown proposal ${id}`)
    if (!PROPOSAL_TRANSITIONS[existing.status].includes('rejected')) {
      throw new Error(`devflow: illegal proposal transition ${existing.status} -> rejected for ${id}`)
    }
    const updated: CommanderProposal = { ...existing, status: 'rejected', updatedAt: new Date().toISOString() }
    validateCommanderProposal(updated, 'memory')
    await this.writeJson(await this.proposalTarget(id), updated)
    return updated
  }

  /** Load every commander proposal for one decision, oldest first. */
  async listProposalsByDecision(decisionId: string): Promise<CommanderProposal[]> {
    const dir = await this.fs.resolve(join(this.root, PROPOSALS_DIR))
    const info = await this.fs.stat(dir)
    if (info === undefined) return []
    if (info.type !== 'directory') throw new Error(`devflow: not a directory: ${dir.displayPath}`)
    const proposals: CommanderProposal[] = []
    for (const entry of await this.fs.listDir(dir)) {
      if (entry.type !== 'file' || !entry.name.endsWith(FILE_SUFFIX)) continue
      const raw = await this.readJson(entry.target)
      if (raw !== undefined) {
        const proposal = validateCommanderProposal(raw, entry.target.displayPath)
        if (proposal.decisionId === decisionId) proposals.push(proposal)
      }
    }
    return proposals.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /** Resolve one commander workflow record file. */
  private workflowTarget(id: string): Promise<FsTarget> {
    return this.fs.resolve(join(this.root, WORKFLOWS_DIR, `${id}${FILE_SUFFIX}`))
  }

  /**
   * Create and persist one commander development workflow (born `created`
   * with an empty execution history).
   * @param input - workflow fields without the store-owned id, status,
   *   history, and timestamps.
   * @returns the persisted workflow.
   */
  async createWorkflow(
    input: Omit<CommanderWorkflow, 'workflowId' | 'status' | 'history' | 'createdAt' | 'updatedAt'>,
  ): Promise<CommanderWorkflow> {
    const now = new Date().toISOString()
    const workflow: CommanderWorkflow = {
      ...input,
      workflowId: randomUUID(),
      status: 'created',
      history: [],
      createdAt: now,
      updatedAt: now,
    }
    validateCommanderWorkflow(workflow, 'memory')
    await this.writeJson(await this.workflowTarget(workflow.workflowId), workflow, { kind: 'createIfAbsent' })
    return workflow
  }

  /** Load one commander workflow; undefined when the id is unknown. */
  async getWorkflow(id: string): Promise<CommanderWorkflow | undefined> {
    assertUuid(id, 'workflow')
    const target = await this.workflowTarget(id)
    const raw = await this.readJson(target)
    return raw === undefined ? undefined : validateCommanderWorkflow(raw, target.displayPath)
  }

  /** Start one commander workflow (created → running) and refresh `updatedAt`. */
  async startWorkflow(id: string): Promise<CommanderWorkflow> {
    assertUuid(id, 'workflow')
    const existing = await this.getWorkflow(id)
    if (existing === undefined) throw new Error(`devflow: cannot start unknown workflow ${id}`)
    if (!WORKFLOW_TRANSITIONS[existing.status].includes('running')) {
      throw new Error(`devflow: illegal workflow transition ${existing.status} -> running for ${id}`)
    }
    const updated: CommanderWorkflow = { ...existing, status: 'running', updatedAt: new Date().toISOString() }
    validateCommanderWorkflow(updated, 'memory')
    await this.writeJson(await this.workflowTarget(id), updated)
    return updated
  }

  /** Complete one commander workflow (running → completed) and refresh `updatedAt`. */
  async completeWorkflow(id: string): Promise<CommanderWorkflow> {
    assertUuid(id, 'workflow')
    const existing = await this.getWorkflow(id)
    if (existing === undefined) throw new Error(`devflow: cannot complete unknown workflow ${id}`)
    if (!WORKFLOW_TRANSITIONS[existing.status].includes('completed')) {
      throw new Error(`devflow: illegal workflow transition ${existing.status} -> completed for ${id}`)
    }
    const updated: CommanderWorkflow = { ...existing, status: 'completed', updatedAt: new Date().toISOString() }
    validateCommanderWorkflow(updated, 'memory')
    await this.writeJson(await this.workflowTarget(id), updated)
    return updated
  }

  /** Fail one commander workflow (running → failed) and refresh `updatedAt`. */
  async failWorkflow(id: string): Promise<CommanderWorkflow> {
    assertUuid(id, 'workflow')
    const existing = await this.getWorkflow(id)
    if (existing === undefined) throw new Error(`devflow: cannot fail unknown workflow ${id}`)
    if (!WORKFLOW_TRANSITIONS[existing.status].includes('failed')) {
      throw new Error(`devflow: illegal workflow transition ${existing.status} -> failed for ${id}`)
    }
    const updated: CommanderWorkflow = { ...existing, status: 'failed', updatedAt: new Date().toISOString() }
    validateCommanderWorkflow(updated, 'memory')
    await this.writeJson(await this.workflowTarget(id), updated)
    return updated
  }

  /** Append one execution-history entry to a running workflow and refresh `updatedAt`. */
  async appendWorkflowExecution(id: string, entry: CommanderWorkflowExecution): Promise<CommanderWorkflow> {
    assertUuid(id, 'workflow')
    assertUuid(entry.entryId, 'workflow-entry')
    const existing = await this.getWorkflow(id)
    if (existing === undefined) throw new Error(`devflow: cannot append to unknown workflow ${id}`)
    if (existing.status !== 'running') {
      throw new Error(`devflow: cannot append to workflow ${id} in status ${existing.status}`)
    }
    validateCommanderWorkflowExecution(entry, 'memory')
    const updated: CommanderWorkflow = {
      ...existing,
      history: [...existing.history, entry],
      updatedAt: new Date().toISOString(),
    }
    validateCommanderWorkflow(updated, 'memory')
    await this.writeJson(await this.workflowTarget(id), updated)
    return updated
  }

  /** Load every commander workflow for one project, oldest first. */
  async listWorkflowsByProject(projectId: string): Promise<CommanderWorkflow[]> {
    const dir = await this.fs.resolve(join(this.root, WORKFLOWS_DIR))
    const info = await this.fs.stat(dir)
    if (info === undefined) return []
    if (info.type !== 'directory') throw new Error(`devflow: not a directory: ${dir.displayPath}`)
    const workflows: CommanderWorkflow[] = []
    for (const entry of await this.fs.listDir(dir)) {
      if (entry.type !== 'file' || !entry.name.endsWith(FILE_SUFFIX)) continue
      const raw = await this.readJson(entry.target)
      if (raw !== undefined) {
        const workflow = validateCommanderWorkflow(raw, entry.target.displayPath)
        if (workflow.projectId === projectId) workflows.push(workflow)
      }
    }
    return workflows.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /** Resolve one commander workflow step record file. */
  private stepTarget(id: string): Promise<FsTarget> {
    return this.fs.resolve(join(this.root, STEPS_DIR, `${id}${FILE_SUFFIX}`))
  }

  /**
   * Create and persist one commander workflow step (born `pending`).
   * @param input - step fields without the store-owned id, status, and
   *   timestamps.
   * @returns the persisted step.
   */
  async createStep(
    input: Omit<CommanderWorkflowStep, 'stepId' | 'status' | 'createdAt' | 'updatedAt'>,
  ): Promise<CommanderWorkflowStep> {
    const now = new Date().toISOString()
    const step: CommanderWorkflowStep = {
      ...input,
      stepId: randomUUID(),
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    }
    validateCommanderWorkflowStep(step, 'memory')
    await this.writeJson(await this.stepTarget(step.stepId), step, { kind: 'createIfAbsent' })
    return step
  }

  /** Load one commander workflow step; undefined when the id is unknown. */
  async getStep(id: string): Promise<CommanderWorkflowStep | undefined> {
    assertUuid(id, 'step')
    const target = await this.stepTarget(id)
    const raw = await this.readJson(target)
    return raw === undefined ? undefined : validateCommanderWorkflowStep(raw, target.displayPath)
  }

  /** Start one commander workflow step (pending → running) and refresh `updatedAt`. */
  async startStep(id: string): Promise<CommanderWorkflowStep> {
    assertUuid(id, 'step')
    const existing = await this.getStep(id)
    if (existing === undefined) throw new Error(`devflow: cannot start unknown step ${id}`)
    if (!STEP_TRANSITIONS[existing.status].includes('running')) {
      throw new Error(`devflow: illegal step transition ${existing.status} -> running for ${id}`)
    }
    const updated: CommanderWorkflowStep = { ...existing, status: 'running', updatedAt: new Date().toISOString() }
    validateCommanderWorkflowStep(updated, 'memory')
    await this.writeJson(await this.stepTarget(id), updated)
    return updated
  }

  /** Complete one commander workflow step (running → completed) and refresh `updatedAt`. */
  async completeStep(id: string): Promise<CommanderWorkflowStep> {
    assertUuid(id, 'step')
    const existing = await this.getStep(id)
    if (existing === undefined) throw new Error(`devflow: cannot complete unknown step ${id}`)
    if (!STEP_TRANSITIONS[existing.status].includes('completed')) {
      throw new Error(`devflow: illegal step transition ${existing.status} -> completed for ${id}`)
    }
    const updated: CommanderWorkflowStep = { ...existing, status: 'completed', updatedAt: new Date().toISOString() }
    validateCommanderWorkflowStep(updated, 'memory')
    await this.writeJson(await this.stepTarget(id), updated)
    return updated
  }

  /** Fail one commander workflow step (running → failed) and refresh `updatedAt`. */
  async failStep(id: string): Promise<CommanderWorkflowStep> {
    assertUuid(id, 'step')
    const existing = await this.getStep(id)
    if (existing === undefined) throw new Error(`devflow: cannot fail unknown step ${id}`)
    if (!STEP_TRANSITIONS[existing.status].includes('failed')) {
      throw new Error(`devflow: illegal step transition ${existing.status} -> failed for ${id}`)
    }
    const updated: CommanderWorkflowStep = { ...existing, status: 'failed', updatedAt: new Date().toISOString() }
    validateCommanderWorkflowStep(updated, 'memory')
    await this.writeJson(await this.stepTarget(id), updated)
    return updated
  }

  /** Load every commander workflow step for one workflow, in sequence order. */
  async listStepsByWorkflow(workflowId: string): Promise<CommanderWorkflowStep[]> {
    const steps = await this.listRecords(STEPS_DIR, validateCommanderWorkflowStep)
    return steps.filter(step => step.workflowId === workflowId).sort((a, b) => a.stepIndex - b.stepIndex)
  }

  /** Read all valid records in one store directory, ordered by creation time. */
  private async listRecords<T extends { readonly updatedAt: string }>(
    directory: string,
    validate: (value: unknown, displayPath: string) => T,
  ): Promise<T[]> {
    const dir = await this.fs.resolve(join(this.root, directory))
    const info = await this.fs.stat(dir)
    if (info === undefined) return []
    if (info.type !== 'directory') throw new Error(`devflow: not a directory: ${dir.displayPath}`)
    const records: T[] = []
    for (const entry of await this.fs.listDir(dir)) {
      if (entry.type !== 'file' || !entry.name.endsWith(FILE_SUFFIX)) continue
      const raw = await this.readJson(entry.target)
      if (raw !== undefined) records.push(validate(raw, entry.target.displayPath))
    }
    return records.sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
  }

  /**
   * Recover the complete state from entity files plus the committed plugin
   * journal. Entity files are authoritative for current records; the journal
   * supplies ordering and control facts that have no standalone file.
   */
  async loadState(): Promise<DevFlowStoreState> {
    const [project, tasks, agentInstances, agents, phases, scope, improvements, checkpoints, assignments,
      plans, batches, executions, attempts, reports, decisions, actions, reviews, runtimeSessions, memories,
      schedules, runs, actionExecutions, policies, proposals, workflows, steps, journal] = await Promise.all([
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
      this.listJournal(),
    ])
    const by = <T>(items: readonly T[], id: (item: T) => string): Record<string, T> => (
      Object.fromEntries(items.map(item => [id(item), item]))
    )
    let state: DevFlowStoreState = {
      project: project ?? null,
      tasks: Object.fromEntries(tasks.map(task => [task.id, task.status])),
      taskTitles: Object.fromEntries(tasks.map(task => [task.id, task.title])),
      agents: agentInstances,
      orchestrationAgents: by(agents, agent => agent.agentId),
      plan: (await this.getMvpPlan()) ?? null,
      phases: by(phases, phase => phase.id),
      scope: scope ?? null,
      improvements,
      commanderCheckpoints: by(checkpoints, checkpoint => checkpoint.checkpointId),
      assignments: by(assignments, assignment => assignment.assignmentId),
      commanderPlans: by(plans, plan => plan.planningId),
      executionBatches: by(batches, batch => batch.batchId),
      executions: by(executions, execution => execution.executionId),
      executionAttempts: by(attempts, attempt => attempt.attemptId),
      agentReports: by(reports, report => report.reportId),
      // Blocked reports have no standalone entity file: they are journal-only
      // facts, folded here the same way the reducer folds them in memory.
      blockedReports: Object.fromEntries(journal
        .filter(entry => entry.type === 'devflow/blocked/report')
        .map(entry => entry.data as unknown as { blocked: BlockedReport })
        .map(payload => payload.blocked)
        .map(report => [report.blockedId, report])),
      commanderDecisions: by(decisions, decision => decision.decisionId),
      commanderActions: by(actions, action => action.actionId),
      commanderReviews: by(reviews, review => review.reviewId),
      runtimePackages: {},
      runtimeResults: {},
      runtimeSessions: by(runtimeSessions, session => session.sessionId),
      commanderMemory: by(memories, memory => memory.memoryId),
      commanderSchedules: by(schedules, schedule => schedule.scheduleId),
      commanderRuns: by(runs, run => run.runId),
      commanderActionExecutions: by(actionExecutions, execution => execution.executionId),
      policies: by(policies, policy => policy.projectId),
      commanderProposals: by(proposals, proposal => proposal.proposalId),
      commanderExecutionContexts: {},
      commanderWorkflows: by(workflows, workflow => workflow.workflowId),
      commanderWorkflowSteps: by(steps, step => step.stepId),
      scopeBoundaryHits: [],
      decisionRequests: {},
      dispatchDiagnostics: {},
      reviewFailCounts: {},
      commanderMode: 'chat',
      paused: false,
    }
    const journalOnlyTypes = new Set([
      'devflow/bridge/import',
      'devflow/decision/request',
      'devflow/decision/answer',
      'devflow/dispatch/diagnostic',
      'devflow/commander/mode-enter',
      'devflow/commander/mode-exit',
      'devflow/control/pause',
      'devflow/control/resume',
      'devflow/scope/boundary-hit',
      'devflow/runtime/export',
      'devflow/runtime/import',
      'devflow/commander/execution-context/create',
    ])
    for (const entry of journal) {
      if (!journalOnlyTypes.has(entry.type)) continue
      state = applyDevFlowStateEvent(state, {
        type: entry.type,
        seq: entry.sequence,
        time: Date.parse(entry.at),
        data: entry.data,
      } as DevFlowJournalEvent)
    }
    return state
  }

}
