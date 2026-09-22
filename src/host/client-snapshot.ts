/** Pure Host-to-Client DevFlow snapshot adapter. */

import {
  DEVFLOW_CLIENT_SNAPSHOT_VERSION,
  type DevFlowClientAttemptSummary,
  type DevFlowClientBlocked,
  type DevFlowClientFailureSummary,
  type DevFlowClientReportSummary,
  type DevFlowClientResultSummary,
  type DevFlowClientSafeText,
  type DevFlowClientSnapshot,
} from '../contract.ts'
import type { DevflowController } from './index.ts'
import { fixedAgentDisplayName } from './display.ts'
import { blockedHeadline } from './blocked-report.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AgentInstance, AgentReport, BlockedReport, ExecutionAttempt, ExecutionRecord, Result } from './types.ts'
import type { DevFlowStoreState } from './storage.ts'

/** P0B bounds apply before serialization; client display repeats the cap defensively. */
export const DEVFLOW_SAFE_SUMMARY_LIMIT = 20
export const DEVFLOW_SAFE_TEXT_LIMIT = 500

const REDACTED_TEXT = 'Sensitive content is hidden.'
const SENSITIVE_TEXT = /(?:\b(?:prompt|system[\s_-]*prompt|credential|token|cookie|authorization|api[\s_-]*key|secret|password|raw\s*(?:tool\s*)?(?:input|output)|tool\s*(?:input|output)|stack\s*trace)\b|(?:[A-Za-z]:\\|\\\\|\/Users\/|\/home\/|\/tmp\/|\/var\/tmp\/|\/private\/var\/)|(?:Bearer\s+\S+))/i

/** Convert plugin-owned state into the narrow JSON-safe Canvas DTO. */
export async function createDevFlowClientSnapshot(
  controller: DevflowController,
  agent: Agent,
): Promise<DevFlowClientSnapshot> {
  // The snapshot is THIS session's project and nothing else: the store is
  // resolved from the calling session's workspace, so a canvas opened in
  // project B cannot render project A's tasks, executions, or memory. When the
  // session cannot be scoped the read is refused instead of silently answered
  // from the retained mixed library.
  const scope = controller.resolveSessionScope(agent)
  const [state, tasks, results] = await Promise.all([
    scope.store.loadState(),
    scope.store.listTasks(),
    typeof scope.store.listResults === 'function' ? scope.store.listResults() : Promise.resolve([]),
  ])
  const mode = controller.commanderMode?.current(agent).mode ?? 'chat'
  // Verified activation report, when the preset adapter is composed. The
  // report is computed live (never from a journal alone); an unavailable or
  // failing report degrades to `error`, never to a claimed `bound`.
  const report = controller.presetActivation === undefined
    ? null
    : await controller.presetActivation.report(agent).catch(() => null)
  const executions = Object.values(state.executions)
  const executionById = new Map(executions.map(item => [item.executionId, item]))
  const agentInstances = new Map(state.agents.map(item => [item.id, item]))
  const reports = latestFirst(Object.values(state.agentReports), item => item.updatedAt, item => item.reportId)
    .map(item => toSafeReport(item, executionById.get(item.executionId)))
  const failures = createFailures(executions, reports)
  const visibleReports = reports.slice(0, DEVFLOW_SAFE_SUMMARY_LIMIT)

  return {
    version: DEVFLOW_CLIENT_SNAPSHOT_VERSION,
    generatedAt: new Date().toISOString(),
    session: {
      id: agent.id,
      // The project identifier the panel shows: THIS session's workspace, i.e.
      // the 当前项目, never the host's shared root.
      workspacePath: scope.workspacePath,
      storeRoot: scope.storeRoot,
      commanderMode: report?.commanderMode ?? mode,
      presetId: report?.presetId ?? null,
      activation: report === null
        ? 'unbound'
        : report.activation,
      activationError: report?.activationError ?? null,
      verifiedAt: report?.verifiedAt ?? null,
      // The recorded refusal rides its own field rather than replacing
      // `activationError`: a session that failed and later recovered must still
      // be able to show what went wrong, and the two answer different questions
      // (current posture vs. last attempt).
      lastActivationFailure: report?.lastFailure ?? null,
    },
    paused: state.paused,
    project: state.project === null ? null : {
      id: state.project.id,
      name: state.project.name,
      goal: state.project.goal,
      currentStage: state.project.currentStage,
    },
    agents: Object.values(state.orchestrationAgents).map(item => ({
      id: item.agentId,
      role: item.role,
      kind: item.kind,
      status: item.status,
      // A fixed employee has no AgentInstance record, so the instance lookup
      // cannot name it: without this table the architect would reach the panel
      // and the canvas under its agent id — or, via its shared `planner` role,
      // as a second 总指挥.
      displayName: agentInstances.get(item.agentId)?.displayName ?? fixedAgentDisplayName(item.agentId),
      model: item.modelConfig.model,
      ...(item.modelConfig.provider === undefined ? {} : { provider: item.modelConfig.provider }),
      // Roster pass-through for the dispatch-flow canvas: the same stored
      // Orchestration Agent record already read above, so an older snapshot
      // without these fields still parses (they are optional in the contract).
      skills: [...item.skills],
      capabilities: [...item.capabilities],
      delegationDepth: item.delegationDepth,
    })).sort((left, right) => left.displayName.localeCompare(right.displayName)),
    tasks: tasks.map(item => ({
      id: item.id,
      title: item.title,
      description: item.description,
      status: item.status,
      ...(item.assignedRole === undefined ? {} : { assignedRole: item.assignedRole }),
      updatedAt: item.updatedAt,
    })).sort((left, right) => left.updatedAt.localeCompare(right.updatedAt)),
    phases: Object.values(state.phases).map(item => ({
      id: item.id, name: item.name, description: item.description, status: item.status,
    })).sort((left, right) => left.id.localeCompare(right.id)),
    assignments: Object.values(state.assignments).map(item => ({
      id: item.assignmentId,
      ...(item.taskId === undefined ? {} : { taskId: item.taskId }),
      phaseId: item.phaseId,
      agentId: item.agentId,
      role: item.role,
      status: item.status,
      // The close stamp rides with the status, so the panel can say WHY without a
      // second read: the host's validator guarantees both or neither.
      ...(item.status === 'closed' ? { closedAt: item.closedAt, closeReason: item.closeReason } : {}),
    })).sort((left, right) => left.id.localeCompare(right.id)),
    executions: executions.map(item => ({
      id: item.executionId,
      assignmentId: item.assignmentId,
      ...(item.taskId === undefined ? {} : { taskId: item.taskId }),
      agentId: item.agentId,
      status: item.status,
      startedAt: item.startedAt,
      completedAt: item.completedAt,
      ...(item.status === 'closed' ? { closedAt: item.closedAt, closeReason: item.closeReason } : {}),
    })).sort((left, right) => left.id.localeCompare(right.id)),
    results: latestFirst(results, item => item.createdAt, item => item.id)
      .slice(0, DEVFLOW_SAFE_SUMMARY_LIMIT)
      .map(toSafeResult),
    reports: visibleReports,
    attempts: latestFirst(Object.values(state.executionAttempts), item => item.updatedAt, item => item.attemptId)
      .slice(0, DEVFLOW_SAFE_SUMMARY_LIMIT)
      .map(toSafeAttempt),
    failures,
    decisions: Object.values(state.commanderDecisions).map(item => ({
      id: item.decisionId,
      type: item.decisionType,
      summary: item.summary,
      nextAction: item.nextAction,
      createdAt: item.createdAt,
    })).sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    decisionRequests: Object.values(state.decisionRequests).map(item => ({
      id: item.requestId,
      taskId: item.taskId,
      trigger: item.trigger,
      question: item.question,
      options: item.options.map(option => ({
        id: option.id,
        label: option.label,
        description: option.description,
        recommended: option.recommended,
      })),
      status: item.status,
    })).sort((left, right) => left.id.localeCompare(right.id)),
    blocked: blockedRows(state, agentInstances),
  }
}

/**
 * Project the blocked records the panel must show.
 *
 * A blocked row is the product's "受阻" terminal state, so it is assembled here
 * — headline included — rather than left for the client to word: the panel shows
 * one plain-language Chinese line, and that line must not exist in two variants.
 */
function blockedRows(
  state: DevFlowStoreState,
  agentInstances: ReadonlyMap<string, AgentInstance>,
): readonly DevFlowClientBlocked[] {
  return Object.values(state.blockedReports ?? {})
    .map((item: BlockedReport): DevFlowClientBlocked => {
      const agentName = agentInstances.get(item.agentId)?.displayName ?? fixedAgentDisplayName(item.agentId)
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
        at: item.createdAt,
      }
    })
    .sort((left, right) => right.at.localeCompare(left.at))
    .slice(0, DEVFLOW_SAFE_SUMMARY_LIMIT)
}

/** Project one task-level Result to one bounded summary; no execution relationship is invented. */
function toSafeResult(result: Result): DevFlowClientResultSummary {
  const detail = result.summary
    || result.issues[0]
    || result.verification[0]
    || result.changes[0]
    || result.nextSteps[0]
    || ''
  return { id: result.id, taskId: result.taskId, source: 'result', at: result.createdAt, summary: toSafeText(detail) }
}

function toSafeReport(report: AgentReport, execution: ExecutionRecord | undefined): DevFlowClientReportSummary {
  return {
    id: report.reportId,
    executionId: report.executionId,
    ...(execution?.taskId === undefined ? {} : { taskId: execution.taskId }),
    agentId: report.agentId,
    source: 'report',
    status: report.status,
    at: report.updatedAt,
    summary: toSafeText(report.summary),
  }
}

function toSafeAttempt(attempt: ExecutionAttempt): DevFlowClientAttemptSummary {
  return {
    id: attempt.attemptId,
    executionId: attempt.executionId,
    source: 'attempt',
    status: attempt.status,
    isRetry: attempt.parentAttemptId !== null,
    at: attempt.updatedAt,
    completedAt: attempt.completedAt,
  }
}

/** Surface one safe report failure or a no-detail failed execution fact. */
function createFailures(
  executions: readonly ExecutionRecord[],
  reports: readonly DevFlowClientReportSummary[],
): readonly DevFlowClientFailureSummary[] {
  const reportFailures = reports
    .filter((report): report is DevFlowClientReportSummary & { readonly status: 'failed' | 'blocked' } => report.status === 'failed' || report.status === 'blocked')
    .map(report => ({
      id: `report-${report.id}`,
      executionId: report.executionId,
      ...(report.taskId === undefined ? {} : { taskId: report.taskId }),
      agentId: report.agentId,
      source: 'report' as const,
      status: report.status,
      at: report.at,
      summary: report.summary,
    }))
  const failedExecutionIds = new Set(reportFailures.map(item => item.executionId))
  const executionFailures = executions
    .filter(execution => execution.status === 'failed' && !failedExecutionIds.has(execution.executionId))
    .map(execution => ({
      id: `execution-${execution.executionId}`,
      executionId: execution.executionId,
      ...(execution.taskId === undefined ? {} : { taskId: execution.taskId }),
      agentId: execution.agentId,
      source: 'execution' as const,
      status: 'failed' as const,
      at: execution.completedAt ?? execution.updatedAt,
      summary: null,
    }))
  return latestFirst([...reportFailures, ...executionFailures], item => item.at, item => item.id)
    .slice(0, DEVFLOW_SAFE_SUMMARY_LIMIT)
}

/** Fail closed: strings with a sensitive signal become a generic disclosure notice. */
function toSafeText(value: string): DevFlowClientSafeText {
  if (SENSITIVE_TEXT.test(value)) return { text: REDACTED_TEXT, truncated: false, redacted: true }
  if (value.length <= DEVFLOW_SAFE_TEXT_LIMIT) return { text: value, truncated: false, redacted: false }
  return { text: value.slice(0, DEVFLOW_SAFE_TEXT_LIMIT), truncated: true, redacted: false }
}

function latestFirst<T>(items: readonly T[], at: (item: T) => string, id: (item: T) => string): T[] {
  return [...items].sort((left, right) => {
    const time = at(right).localeCompare(at(left))
    return time === 0 ? id(left).localeCompare(id(right)) : time
  })
}
