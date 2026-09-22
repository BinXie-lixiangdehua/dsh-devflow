/**
 * Commander memory integration: the layer that connects the commander loop's
 * run cycle to the structured memory store — a per-cycle memory slot a
 * memory-aware decision provider reads, and a writer for caller-provided
 * facts. Nothing here calls a model, generates text, embeds, or retrieves.
 *
 * Memory type usage: `project` records long-term project facts; `decision`
 * records important decisions; `execution` records execution-result
 * summaries; `preference` records user preferences.
 * @module @xiaoxie-ide/dsh-devflow/memory-integration
 */

import type { CommanderMemoryContext } from './memory-context.ts'
import type { DevFlowStore } from './storage.ts'
import type { CommanderMemory } from './types.ts'

/** One caller-provided fact ready for the memory store. */
import { recordDevFlowChange } from './journal.ts'
export type CommanderMemoryInput = Omit<CommanderMemory, 'memoryId' | 'createdAt' | 'updatedAt'>

/**
 * The per-cycle memory slot: the project memory the driver loads for the
 * cycle being driven, readable by any memory-aware decision provider without
 * changing the provider seam. `current` is null outside a driven cycle.
 */
export class CommanderCycleMemory {
  private currentContext: CommanderMemoryContext | null = null

  /** The memory context of the cycle being driven; null outside a cycle. */
  get current(): CommanderMemoryContext | null {
    return this.currentContext
  }

  /** Begin a cycle with its loaded memory context. */
  begin(context: CommanderMemoryContext): void {
    this.currentContext = context
  }

  /** End the current cycle; the slot returns to null. */
  end(): void {
    this.currentContext = null
  }
}

/**
 * Writes caller-provided facts into the structured memory store. The caller
 * supplies the full fact (project, type, content, source) — this layer
 * persists it and logs the event; it never invents content.
 * @param store - the storage the memory records go through.
 * @param session - the session whose event log records every committed write.
 */
export class CommanderMemoryWriter {
  constructor(
    private readonly store: DevFlowStore,
  ) {}

  /**
   * Write one caller-provided fact into the memory store.
   * @param input - the fact to persist.
   * @returns the persisted memory record.
   */
  async write(input: CommanderMemoryInput): Promise<CommanderMemory> {
    const memory = await this.store.createMemory(input)
    await recordDevFlowChange(this.store, 'devflow/memory/create', { memory })
    return memory
  }
}
