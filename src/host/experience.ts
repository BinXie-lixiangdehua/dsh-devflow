/**
 * Commander experience foundation: historical memory read as decision-aiding
 * information. Not machine learning and not training — structured experience
 * reading only: the memory store's records are converted into insights
 * (warnings and preferences) that a decision engine may consume. The
 * insights only inform; they never modify a decision by themselves. No
 * embedding, no vector store, no LLM.
 * @module @xiaoxie-ide/dsh-devflow/experience
 */

import type { CommanderContext } from './commander-orchestrator.ts'
import type { CommanderMemoryContext } from './memory-context.ts'
import type { CommanderMemory } from './types.ts'

/** One experience-derived insight. */
export interface ExperienceInsight {
  /** The memory that produced this insight. */
  readonly memoryId: string
  /** What the insight is: a warning, a preference, a success pattern, or retry history. */
  readonly kind: 'warning' | 'preference' | 'success' | 'retry'
  /** The insight text. */
  readonly text: string
}

/** The experience summary derived from a project's memory. */
export interface CommanderExperienceContext {
  /** The base commander context. */
  readonly context: CommanderContext
  /** The derived insights, in memory order. */
  readonly insights: readonly ExperienceInsight[]
}

/**
 * The replaceable experience provider: memory → insights. The default rule
 * implementation sits behind it; a future rule, LLM-memory, or vector-memory
 * provider swaps in without touching the decision seam.
 */
export interface ExperienceProvider {
  /**
   * Derive decision-aiding insights from the project's memory.
   * @param memory - the project's memory records with their context.
   * @returns the insights; empty when nothing applies.
   */
  derive(memory: CommanderMemoryContext): readonly ExperienceInsight[]
}

/** The first-version rule provider: explicit, deterministic, no learning. */
export class RuleExperienceProvider implements ExperienceProvider {
  derive(memory: CommanderMemoryContext): readonly ExperienceInsight[] {
    const insights: ExperienceInsight[] = []
    for (const record of memory.memories) {
      if (hasFailureSignal(record.content)) {
        insights.push({
          memoryId: record.memoryId,
          kind: 'warning',
          text: `memory ${record.memoryId} reports failure: ${record.content}`,
        })
      }
      if (hasPreferenceSignal(record)) {
        insights.push({
          memoryId: record.memoryId,
          kind: 'preference',
          text: `memory ${record.memoryId} records preference: ${record.content}`,
        })
      }
    }
    return insights
  }
}

/** Failure signal: any of the tokens fail/flaky/error/broken in the content. */
function hasFailureSignal(content: string): boolean {
  return /fail|flaky|error|broken/i.test(content)
}

/** Preference signal: the token prefer in a decision or preference memory. */
function hasPreferenceSignal(record: CommanderMemory): boolean {
  return (record.memoryType === 'decision' || record.memoryType === 'preference') && /prefer/i.test(record.content)
}

/**
 * The feedback experience provider: reads execution feedback memory — the
 * `execution`-type records the memory feedback bridge writes, whose content
 * is the feedback summary (`action <id> (<type>) …`) — and derives
 * structured insights: success patterns (`completed successfully`), failure
 * patterns (`failed: …`), retry history (an aggregate of `retry_execution`
 * memories), and execution preferences (the token prefer). Only information —
 * no rule is changed automatically.
 */
export class FeedbackExperienceProvider implements ExperienceProvider {
  derive(memory: CommanderMemoryContext): readonly ExperienceInsight[] {
    const insights: ExperienceInsight[] = []
    const feedbackMemories = memory.memories.filter(record => record.memoryType === 'execution')
    let retryCount = 0
    let lastRetryId: string | null = null
    for (const record of feedbackMemories) {
      if (/completed successfully/i.test(record.content)) {
        insights.push({
          memoryId: record.memoryId,
          kind: 'success',
          text: `memory ${record.memoryId} records a successful action: ${record.content}`,
        })
      }
      if (/failed/i.test(record.content)) {
        insights.push({
          memoryId: record.memoryId,
          kind: 'warning',
          text: `memory ${record.memoryId} reports failure: ${record.content}`,
        })
      }
      if (/retry_execution/.test(record.content)) {
        retryCount++
        lastRetryId = record.memoryId
      }
      if (/prefer/i.test(record.content)) {
        insights.push({
          memoryId: record.memoryId,
          kind: 'preference',
          text: `memory ${record.memoryId} records an execution preference: ${record.content}`,
        })
      }
    }
    if (retryCount > 0 && lastRetryId !== null) {
      insights.push({
        memoryId: lastRetryId,
        kind: 'retry',
        text: `${retryCount} retry execution(s) recorded in feedback memory`,
      })
    }
    return insights
  }
}

/**
 * Build the experience summary for a project's memory through a provider.
 * @param memory - the project's memory records with their context.
 * @param provider - the experience provider to derive through.
 * @returns the experience context: the base context plus the derived insights.
 */
export function buildExperienceContext(
  memory: CommanderMemoryContext,
  provider: ExperienceProvider,
): CommanderExperienceContext {
  return { context: memory.context, insights: provider.derive(memory) }
}
