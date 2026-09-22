/**
 * Commander feedback cycle: an action execution's outcome converted into
 * structured feedback plus a memory candidate. The processor never decides
 * and never writes memory — the candidate is handed to the caller, who
 * writes it through the memory writer (or the bridge) when appropriate. No
 * LLM, no embedding, no vector store.
 * @module @xiaoxie-ide/dsh-devflow/feedback
 */

import { randomUUID } from 'node:crypto'
import type { ActionExecutionResult } from './action-executor.ts'
import type { CommanderMemoryWriter } from './memory-integration.ts'
import type { DevFlowProjectionState } from './types.ts'
import type { CommanderMemory } from './types.ts'

/** Commander feedback lifecycle status. */
export type CommanderFeedbackStatus = 'success' | 'failed'

/** One structured feedback about an action execution. */
export interface CommanderFeedback {
  /** Stable feedback id (UUID). */
  readonly feedbackId: string
  /** The action the feedback describes. */
  readonly actionId: string
  /** The action outcome. */
  readonly status: CommanderFeedbackStatus
  /** One-paragraph structured summary. */
  readonly summary: string
  /** Creation time, ISO 8601. */
  readonly createdAt: string
}

/** A memory candidate: what the caller MAY write through the memory writer. */
export type FeedbackMemoryCandidate = Omit<CommanderMemory, 'memoryId' | 'createdAt' | 'updatedAt'>

/** The processor output: the feedback plus its optional memory candidate. */
export interface CommanderFeedbackResult {
  /** The structured feedback. */
  readonly feedback: CommanderFeedback
  /** The memory candidate; null when the project cannot be resolved. */
  readonly memoryCandidate: FeedbackMemoryCandidate | null
}

/**
 * The memory feedback bridge: converts a feedback into a memory candidate
 * and, on explicit caller request, writes it through the memory writer. The
 * bridge never writes on its own — the caller decides.
 * @param writer - the memory writer the bridge writes through.
 */
export class MemoryFeedbackBridge {
  constructor(private readonly writer: CommanderMemoryWriter) {}

  /**
   * The execution-memory candidate for a feedback (no writing). Success and
   * failure feedback both yield an `execution` memory whose content carries
   * the summary — failure summaries carry the failure signal that the
   * experience layer reads as a warning.
   * @param feedback - the feedback to convert.
   * @param projectId - the project the candidate belongs to.
   * @returns the memory input ready for the writer.
   */
  candidateFor(feedback: CommanderFeedback, projectId: string): FeedbackMemoryCandidate {
    return {
      projectId,
      memoryType: 'execution',
      content: feedback.summary,
      source: `action ${feedback.actionId}`,
    }
  }

  /**
   * Write a candidate through the memory writer (caller-invoked).
   * @param candidate - the candidate to persist.
   * @returns the persisted memory record.
   */
  write(candidate: FeedbackMemoryCandidate): Promise<CommanderMemory> {
    return this.writer.write(candidate)
  }
}

/**
 * The feedback processor: converts an action execution result (plus the
 * current projection state, which resolves the action and its project) into
 * structured feedback and a memory candidate. Pure conversion — no decision,
 * no memory write.
 * @param readState - the projection-state reader used to resolve the action.
 * @param bridge - the memory feedback bridge producing the candidate.
 */
export class CommanderFeedbackProcessor {
  constructor(
    private readonly readState: () => DevFlowProjectionState,
    private readonly bridge: MemoryFeedbackBridge,
  ) {}

  /**
   * Process one action execution result into feedback.
   * @param result - the action execution result.
   * @returns the feedback and its optional memory candidate.
   */
  process(result: ActionExecutionResult): CommanderFeedbackResult {
    const state = this.readState()
    const action = state.commanderActions[result.actionId]
    const actionLabel = action === undefined ? '' : ` (${action.actionType})`
    const status: CommanderFeedbackStatus = result.success ? 'success' : 'failed'
    const summary = status === 'success'
      ? `action ${result.actionId}${actionLabel} completed successfully`
      : `action ${result.actionId}${actionLabel} failed: ${result.error ?? 'unknown error'}`
    const feedback: CommanderFeedback = {
      feedbackId: randomUUID(),
      actionId: result.actionId,
      status,
      summary,
      createdAt: new Date().toISOString(),
    }
    const decision = action === undefined ? undefined : state.commanderDecisions[action.decisionId]
    const memoryCandidate = decision === undefined ? null : this.bridge.candidateFor(feedback, decision.projectId)
    return { feedback, memoryCandidate }
  }
}
