import type { DevFlowJournalEntry, DevFlowStore } from './storage.ts'
import type { DevFlowJsonValue } from './json.ts'

type JournalWriter = Pick<DevFlowStore, 'appendJournal'>

/** One DevFlow business mutation that has already committed to `.devflow/`. */
export interface DevFlowChange {
  readonly type: `devflow/${string}`
  readonly data: DevFlowJsonValue
}

/**
 * Persist a post-mutation DevFlow audit fact in the plugin-owned journal.
 *
 * DevFlow events are never appended to Session: a third-party plugin cannot
 * reliably extend the host persistence vocabulary. Official tool lifecycle
 * records are independently produced by the dsh tool runtime and remain the
 * only session-level conversation anchors.
 */
export async function recordDevFlowChange(store: JournalWriter, type: `devflow/${string}`, data: unknown): Promise<DevFlowJournalEntry> {
  let json: DevFlowJsonValue
  try {
    json = JSON.parse(JSON.stringify(data)) as DevFlowJsonValue
  } catch (error) {
    throw new Error(`devflow: cannot journal ${type}: data is not JSON-serializable`, { cause: error })
  }
  return store.appendJournal(type, json)
}
