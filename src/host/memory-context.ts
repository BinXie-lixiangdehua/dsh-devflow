/**
 * Commander memory context: the commander context extended with the
 * project's structured memory — the additional input a decision flow may
 * inject without changing the provider seam or the context model.
 * @module @xiaoxie-ide/dsh-devflow/memory-context
 */

import type { CommanderContext } from './commander-orchestrator.ts'
import type { CommanderMemory, DevFlowProjectionState } from './types.ts'

/**
 * The commander context extended with the project's structured memory: what
 * a caller may hand to a decision flow alongside the base context. No
 * vectors, no retrieval — just the project's plain memory records.
 */
export interface CommanderMemoryContext {
  /** The base commander context. */
  readonly context: CommanderContext
  /** The project's structured memory, oldest first. */
  readonly memories: readonly CommanderMemory[]
}

/**
 * Build the extended commander input for a project: the base context plus
 * the project's memory records folded from the projection snapshot.
 * @param context - the base commander context.
 * @param state - the current devflow projection snapshot.
 * @returns the extended input.
 */
export function buildMemoryContext(context: CommanderContext, state: DevFlowProjectionState): CommanderMemoryContext {
  const memories = Object.values(state.commanderMemory)
    .filter(memory => memory.projectId === context.projectId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  return { context, memories }
}
