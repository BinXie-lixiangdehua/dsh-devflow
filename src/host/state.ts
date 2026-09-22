/**
 * Store-journal DevFlow read model.
 *
 * This is the former session projection's pure fold, reused over plugin-owned
 * journal records so third-party state never depends on session event support.
 * @module @xiaoxie-ide/dsh-devflow/state
 */

import {
  activateCommanderPlan, answerDecisionRequest, appendCommanderWorkflowExecution, appendScopeBoundaryHit,
  approveCommanderProposal, completeCommanderActionExecution, completeCommanderRun,
  completeCommanderReview, completeCommanderWorkflow, completeCommanderWorkflowStep,
  devflowProjectionSchema,
  failCommanderActionExecution, failCommanderRun, failCommanderWorkflow, failCommanderWorkflowStep, patchAgentReport,
  patchAssignmentStatus,
  patchCheckpoint, patchCommanderDecision, patchCommanderMemory, patchCommanderPlan,
  patchCommanderSchedule, patchOrchestrationAgent,
  pauseCommanderSchedule,
  rejectCommanderProposal,
  removeAssignment, removeOrchestrationAgent, startCommanderWorkflow, startCommanderWorkflowStep,
  transitionCommanderAction, transitionExecution,
  transitionExecutionAttempt, transitionExecutionBatch, transitionOrchestrationAgent,
  transitionRuntimeSession, upsertAgent,
  upsertAgentReport,
  upsertBlockedReport,
  upsertAssignment, upsertCheckpoint, upsertCommanderAction, upsertCommanderActionExecution,
  upsertCommanderDecision,
  upsertCommanderExecutionContext,
  upsertCommanderMemory, upsertCommanderPlan, upsertCommanderProposal, upsertCommanderReview,
  upsertCommanderRun,
  upsertCommanderSchedule,
  upsertCommanderWorkflow, upsertCommanderWorkflowStep,
  upsertExecution, upsertExecutionAttempt,
  upsertExecutionBatch, upsertOrchestrationAgent, upsertPhase,
  upsertPolicy,
  upsertDecisionRequest, upsertDispatchDiagnostic, upsertRuntimePackage, upsertRuntimeResult, upsertRuntimeSession,
  foldReviewFailCount, resetReviewFailCount,
} from './projection.ts'
import type { DevFlowJournalEvent, DevFlowProjectionState } from './types.ts'

/** Create the empty durable DevFlow state. */
export function initialDevFlowState(): DevFlowProjectionState {
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
          commanderMode: 'chat',
           paused: false,
        }
}

/** Fold one plugin-owned journal record using the established DevFlow rules. */
export function applyDevFlowStateEvent(state: DevFlowProjectionState, event: DevFlowJournalEvent): DevFlowProjectionState {

  if (event.type === 'devflow/project/update') {
    return { ...state, project: event.data.project }
  }
  if (event.type === 'devflow/task/transition') {
    return {
      ...state,
      tasks: { ...state.tasks, [event.data.taskId]: event.data.to },
      ...(event.data.title === undefined
        ? {}
        : { taskTitles: { ...(state.taskTitles ?? {}), [event.data.taskId]: event.data.title } }),
      ...(event.data.to === 'completed'
        ? { reviewFailCounts: resetReviewFailCount(state.reviewFailCounts, event.data.taskId) }
        : {}),
    }
  }
  if (event.type === 'devflow/bridge/import') {
    return {
      ...state,
      reviewFailCounts: foldReviewFailCount(state.reviewFailCounts, event.data.taskId, event.data.verdict),
    }
  }
  if (event.type === 'devflow/agent/upsert') {
    return { ...state, agents: upsertAgent(state.agents, event.data.instance) }
  }
  if (event.type === 'devflow/agent/register') {
    return { ...state, orchestrationAgents: upsertOrchestrationAgent(state.orchestrationAgents, event.data.agent) }
  }
  if (event.type === 'devflow/agent/remove') {
    return { ...state, orchestrationAgents: removeOrchestrationAgent(state.orchestrationAgents, event.data.agentId) }
  }
  if (event.type === 'devflow/agent/update-config') {
    return {
      ...state,
      orchestrationAgents: patchOrchestrationAgent(
        state.orchestrationAgents, event.data.agentId, event.data.patch, event.data.at,
      ),
    }
  }
  if (event.type === 'devflow/agent/transition') {
    return {
      ...state,
      orchestrationAgents: transitionOrchestrationAgent(
        state.orchestrationAgents, event.data.agentId, event.data.to, event.data.at,
      ),
    }
  }
  if (event.type === 'devflow/mvp/create') {
    return { ...state, plan: event.data.plan }
  }
  if (event.type === 'devflow/phase/create') {
    return { ...state, phases: upsertPhase(state.phases, event.data.phase) }
  }
  if (event.type === 'devflow/phase/update') {
    const existing = state.phases[event.data.phaseId]
    if (existing === undefined) return state
    return {
      ...state,
      phases: {
        ...state.phases,
        [event.data.phaseId]: { ...existing, status: event.data.status, updatedAt: event.data.at },
      },
    }
  }
  if (event.type === 'devflow/scope/update') {
    return { ...state, scope: event.data.scope }
  }
  if (event.type === 'devflow/scope/clear') {
    return { ...state, scope: null }
  }
  if (event.type === 'devflow/decision/request') {
    return { ...state, decisionRequests: upsertDecisionRequest(state.decisionRequests, event.data.request) }
  }
  if (event.type === 'devflow/decision/answer') {
    const decisionRequests = answerDecisionRequest(
      state.decisionRequests, event.data.requestId, event.data.answer, event.data.at,
    )
    const request = decisionRequests[event.data.requestId]
    if (request?.trigger === 'review-failed-twice' && request.taskId !== null) {
      const { [request.taskId]: _reset, ...reviewFailCounts } = state.reviewFailCounts
      return { ...state, decisionRequests, reviewFailCounts }
    }
    return { ...state, decisionRequests }
  }
  if (event.type === 'devflow/dispatch/diagnostic') {
    return { ...state, dispatchDiagnostics: upsertDispatchDiagnostic(state.dispatchDiagnostics ?? {}, event.data.diagnostic) }
  }
  if (event.type === 'devflow/commander/mode-enter') {
    const { commanderModeExitAt: _exit, ...rest } = state
    return { ...rest, commanderMode: 'commander' }
  }
  if (event.type === 'devflow/commander/mode-exit') return { ...state, commanderMode: 'chat', commanderModeExitAt: event.data.at }
   if (event.type === 'devflow/control/pause') return { ...state, paused: true }
  if (event.type === 'devflow/control/resume') return { ...state, paused: false }
  if (event.type === 'devflow/improvement/add') {
    return { ...state, improvements: [...state.improvements, event.data.improvement] }
  }
  if (event.type === 'devflow/scope/boundary-hit') {
    return { ...state, scopeBoundaryHits: appendScopeBoundaryHit(state.scopeBoundaryHits, event.data.hit) }
  }
  if (event.type === 'devflow/commander/checkpoint/create') {
    return { ...state, commanderCheckpoints: upsertCheckpoint(state.commanderCheckpoints, event.data.checkpoint) }
  }
  if (event.type === 'devflow/commander/checkpoint/update') {
    return {
      ...state,
      commanderCheckpoints: patchCheckpoint(
        state.commanderCheckpoints, event.data.checkpointId, event.data.patch, event.data.at,
      ),
    }
  }
  if (event.type === 'devflow/orchestration/assign') {
    return { ...state, assignments: upsertAssignment(state.assignments, event.data.assignment) }
  }
  if (event.type === 'devflow/orchestration/unassign') {
    return { ...state, assignments: removeAssignment(state.assignments, event.data.assignmentId) }
  }
  if (event.type === 'devflow/orchestration/update') {
    return {
      ...state,
      assignments: patchAssignmentStatus(
        state.assignments, event.data.assignmentId, event.data.status, event.data.at, event.data.closeReason,
      ),
    }
  }
  if (event.type === 'devflow/orchestration/close') {
    return {
      ...state,
      assignments: patchAssignmentStatus(
        state.assignments, event.data.assignmentId, 'closed', event.data.at, event.data.closeReason,
      ),
    }
  }
  if (event.type === 'devflow/commander/plan/create') {
    return { ...state, commanderPlans: upsertCommanderPlan(state.commanderPlans, event.data.plan) }
  }
  if (event.type === 'devflow/commander/plan/activate') {
    return {
      ...state,
      commanderPlans: activateCommanderPlan(state.commanderPlans, event.data.planningId, event.data.at),
    }
  }
  if (event.type === 'devflow/commander/plan/update') {
    return {
      ...state,
      commanderPlans: patchCommanderPlan(
        state.commanderPlans, event.data.planningId, event.data.patch, event.data.at,
      ),
    }
  }
  if (event.type === 'devflow/execution/batch/create') {
    return { ...state, executionBatches: upsertExecutionBatch(state.executionBatches, event.data.batch) }
  }
  if (event.type === 'devflow/execution/batch/start') {
    return {
      ...state,
      executionBatches: transitionExecutionBatch(state.executionBatches, event.data.batchId, 'running', event.data.at),
    }
  }
  if (event.type === 'devflow/execution/batch/pause') {
    return {
      ...state,
      executionBatches: transitionExecutionBatch(state.executionBatches, event.data.batchId, 'paused', event.data.at),
    }
  }
  if (event.type === 'devflow/execution/batch/complete') {
    return {
      ...state,
      executionBatches: transitionExecutionBatch(state.executionBatches, event.data.batchId, 'completed', event.data.at),
    }
  }
  if (event.type === 'devflow/execution/start') {
    return { ...state, executions: upsertExecution(state.executions, event.data.execution) }
  }
  if (event.type === 'devflow/execution/update') {
    return {
      ...state,
      executions: transitionExecution(state.executions, event.data.executionId, event.data.status, event.data.at, event.data.closeReason),
    }
  }
  if (event.type === 'devflow/execution/close') {
    return {
      ...state,
      executions: transitionExecution(state.executions, event.data.executionId, 'closed', event.data.at, event.data.closeReason),
    }
  }
  if (event.type === 'devflow/execution/complete') {
    return {
      ...state,
      executions: transitionExecution(state.executions, event.data.executionId, 'completed', event.data.at),
    }
  }
  if (event.type === 'devflow/execution/fail') {
    return {
      ...state,
      executions: transitionExecution(state.executions, event.data.executionId, 'failed', event.data.at),
    }
  }
  if (event.type === 'devflow/execution/attempt/create') {
    return { ...state, executionAttempts: upsertExecutionAttempt(state.executionAttempts, event.data.attempt) }
  }
  if (event.type === 'devflow/execution/attempt/start') {
    return {
      ...state,
      executionAttempts: transitionExecutionAttempt(state.executionAttempts, event.data.attemptId, 'running', event.data.at),
    }
  }
  if (event.type === 'devflow/execution/attempt/complete') {
    return {
      ...state,
      executionAttempts: transitionExecutionAttempt(state.executionAttempts, event.data.attemptId, 'completed', event.data.at),
    }
  }
  if (event.type === 'devflow/execution/attempt/fail') {
    return {
      ...state,
      executionAttempts: transitionExecutionAttempt(state.executionAttempts, event.data.attemptId, 'failed', event.data.at),
    }
  }
  if (event.type === 'devflow/agent/report/create') {
    return { ...state, agentReports: upsertAgentReport(state.agentReports, event.data.report) }
  }
  if (event.type === 'devflow/blocked/report') {
    return { ...state, blockedReports: upsertBlockedReport(state.blockedReports ?? {}, event.data.blocked) }
  }
  if (event.type === 'devflow/agent/report/update') {
    return {
      ...state,
      agentReports: patchAgentReport(
        state.agentReports, event.data.reportId, event.data.patch, event.data.at,
      ),
    }
  }
  if (event.type === 'devflow/commander/decision/create') {
    return { ...state, commanderDecisions: upsertCommanderDecision(state.commanderDecisions, event.data.decision) }
  }
  if (event.type === 'devflow/commander/decision/update') {
    return {
      ...state,
      commanderDecisions: patchCommanderDecision(
        state.commanderDecisions, event.data.decisionId, event.data.patch, event.data.at,
      ),
    }
  }
  if (event.type === 'devflow/runtime/export') {
    return { ...state, runtimePackages: upsertRuntimePackage(state.runtimePackages, event.data.package) }
  }
  if (event.type === 'devflow/runtime/import') {
    return { ...state, runtimeResults: upsertRuntimeResult(state.runtimeResults, event.data.result) }
  }
  if (event.type === 'devflow/runtime/session/create') {
    return { ...state, runtimeSessions: upsertRuntimeSession(state.runtimeSessions, event.data.session) }
  }
  if (event.type === 'devflow/runtime/session/start') {
    return {
      ...state,
      runtimeSessions: transitionRuntimeSession(state.runtimeSessions, event.data.sessionId, 'running', event.data.at),
    }
  }
  if (event.type === 'devflow/runtime/session/complete') {
    return {
      ...state,
      runtimeSessions: transitionRuntimeSession(state.runtimeSessions, event.data.sessionId, 'completed', event.data.at),
    }
  }
  if (event.type === 'devflow/runtime/session/fail') {
    return {
      ...state,
      runtimeSessions: transitionRuntimeSession(state.runtimeSessions, event.data.sessionId, 'failed', event.data.at),
    }
  }
  if (event.type === 'devflow/commander/action/create') {
    return { ...state, commanderActions: upsertCommanderAction(state.commanderActions, event.data.action) }
  }
  if (event.type === 'devflow/commander/action/execute') {
    return {
      ...state,
      commanderActions: transitionCommanderAction(
        state.commanderActions, event.data.actionId, 'executing', event.data.at,
      ),
    }
  }
  if (event.type === 'devflow/commander/action/complete') {
    return {
      ...state,
      commanderActions: transitionCommanderAction(
        state.commanderActions, event.data.actionId, 'completed', event.data.at,
      ),
    }
  }
  if (event.type === 'devflow/commander/review/create') {
    return { ...state, commanderReviews: upsertCommanderReview(state.commanderReviews, event.data.review) }
  }
  if (event.type === 'devflow/commander/review/complete') {
    return {
      ...state,
      commanderReviews: completeCommanderReview(state.commanderReviews, event.data.reviewId, event.data.at),
    }
  }
  if (event.type === 'devflow/memory/create') {
    return { ...state, commanderMemory: upsertCommanderMemory(state.commanderMemory, event.data.memory) }
  }
  if (event.type === 'devflow/memory/update') {
    return {
      ...state,
      commanderMemory: patchCommanderMemory(
        state.commanderMemory, event.data.memoryId, event.data.patch, event.data.at,
      ),
    }
  }
  if (event.type === 'devflow/commander/schedule/create') {
    return { ...state, commanderSchedules: upsertCommanderSchedule(state.commanderSchedules, event.data.schedule) }
  }
  if (event.type === 'devflow/commander/schedule/update') {
    return {
      ...state,
      commanderSchedules: patchCommanderSchedule(
        state.commanderSchedules, event.data.scheduleId, event.data.patch, event.data.at,
      ),
    }
  }
  if (event.type === 'devflow/commander/schedule/pause') {
    return {
      ...state,
      commanderSchedules: pauseCommanderSchedule(state.commanderSchedules, event.data.scheduleId, event.data.at),
    }
  }
  if (event.type === 'devflow/commander/run/create') {
    return { ...state, commanderRuns: upsertCommanderRun(state.commanderRuns, event.data.run) }
  }
  if (event.type === 'devflow/commander/run/complete') {
    return {
      ...state,
      commanderRuns: completeCommanderRun(
        state.commanderRuns, event.data.runId, event.data.decisionId, event.data.actionId, event.data.at,
      ),
    }
  }
  if (event.type === 'devflow/commander/run/fail') {
    return { ...state, commanderRuns: failCommanderRun(state.commanderRuns, event.data.runId, event.data.at) }
  }
  if (event.type === 'devflow/commander/action-execution/create') {
    return {
      ...state,
      commanderActionExecutions: upsertCommanderActionExecution(state.commanderActionExecutions, event.data.execution),
    }
  }
  if (event.type === 'devflow/commander/action-execution/complete') {
    return {
      ...state,
      commanderActionExecutions: completeCommanderActionExecution(
        state.commanderActionExecutions, event.data.executionId, event.data.at,
      ),
    }
  }
  if (event.type === 'devflow/commander/action-execution/fail') {
    return {
      ...state,
      commanderActionExecutions: failCommanderActionExecution(
        state.commanderActionExecutions, event.data.executionId, event.data.error, event.data.at,
      ),
    }
  }
  if (event.type === 'devflow/policy/update') {
    return { ...state, policies: upsertPolicy(state.policies, event.data.policy) }
  }
  if (event.type === 'devflow/commander/proposal/create') {
    return { ...state, commanderProposals: upsertCommanderProposal(state.commanderProposals, event.data.proposal) }
  }
  if (event.type === 'devflow/commander/proposal/approve') {
    return {
      ...state,
      commanderProposals: approveCommanderProposal(state.commanderProposals, event.data.proposalId, event.data.at),
    }
  }
  if (event.type === 'devflow/commander/proposal/reject') {
    return {
      ...state,
      commanderProposals: rejectCommanderProposal(state.commanderProposals, event.data.proposalId, event.data.at),
    }
  }
  if (event.type === 'devflow/commander/execution-context/create') {
    return {
      ...state,
      commanderExecutionContexts: upsertCommanderExecutionContext(state.commanderExecutionContexts, event.data.context),
    }
  }
  if (event.type === 'devflow/commander/workflow/create') {
    return { ...state, commanderWorkflows: upsertCommanderWorkflow(state.commanderWorkflows, event.data.workflow) }
  }
  if (event.type === 'devflow/commander/workflow/start') {
    return {
      ...state,
      commanderWorkflows: startCommanderWorkflow(state.commanderWorkflows, event.data.workflowId, event.data.at),
    }
  }
  if (event.type === 'devflow/commander/workflow/complete') {
    return {
      ...state,
      commanderWorkflows: completeCommanderWorkflow(state.commanderWorkflows, event.data.workflowId, event.data.at),
    }
  }
  if (event.type === 'devflow/commander/workflow/fail') {
    return {
      ...state,
      commanderWorkflows: failCommanderWorkflow(state.commanderWorkflows, event.data.workflowId, event.data.at),
    }
  }
  if (event.type === 'devflow/commander/workflow/execution/add') {
    return {
      ...state,
      commanderWorkflows: appendCommanderWorkflowExecution(
        state.commanderWorkflows, event.data.workflowId, event.data.entry, event.data.at,
      ),
    }
  }
  if (event.type === 'devflow/commander/step/create') {
    return { ...state, commanderWorkflowSteps: upsertCommanderWorkflowStep(state.commanderWorkflowSteps, event.data.step) }
  }
  if (event.type === 'devflow/commander/step/start') {
    return {
      ...state,
      commanderWorkflowSteps: startCommanderWorkflowStep(state.commanderWorkflowSteps, event.data.stepId, event.data.at),
    }
  }
  if (event.type === 'devflow/commander/step/complete') {
    return {
      ...state,
      commanderWorkflowSteps: completeCommanderWorkflowStep(state.commanderWorkflowSteps, event.data.stepId, event.data.at),
    }
  }
  if (event.type === 'devflow/commander/step/fail') {
    return {
      ...state,
      commanderWorkflowSteps: failCommanderWorkflowStep(state.commanderWorkflowSteps, event.data.stepId, event.data.at),
    }
  }
  return state
}
