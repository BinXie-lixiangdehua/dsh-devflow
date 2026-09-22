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
/** One caller-provided fact ready for the memory store. */
import { recordDevFlowChange } from "./journal.js";
/**
 * The per-cycle memory slot: the project memory the driver loads for the
 * cycle being driven, readable by any memory-aware decision provider without
 * changing the provider seam. `current` is null outside a driven cycle.
 */
export class CommanderCycleMemory {
    currentContext = null;
    /** The memory context of the cycle being driven; null outside a cycle. */
    get current() {
        return this.currentContext;
    }
    /** Begin a cycle with its loaded memory context. */
    begin(context) {
        this.currentContext = context;
    }
    /** End the current cycle; the slot returns to null. */
    end() {
        this.currentContext = null;
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
    store;
    constructor(store) {
        this.store = store;
    }
    /**
     * Write one caller-provided fact into the memory store.
     * @param input - the fact to persist.
     * @returns the persisted memory record.
     */
    async write(input) {
        const memory = await this.store.createMemory(input);
        await recordDevFlowChange(this.store, 'devflow/memory/create', { memory });
        return memory;
    }
}
