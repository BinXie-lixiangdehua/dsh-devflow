/**
 * TEMPORARY activation diagnostic (removed before hand-off).
 *
 * Appends one JSON line per observed activation event to a file outside the
 * plugin, so the running host's in-process activation decisions can be read
 * without a debugger attached. Never throws, never changes behavior.
 */
import { appendFileSync } from 'node:fs';
const DIAG_FILE = 'D:\\Deepseek\\DevFlow\\outputs\\activation-diag.jsonl';
/**
 * Append one diagnostic record.
 * @param event - short event name.
 * @param data - JSON-serializable payload.
 */
export function diagActivation(event, data) {
    try {
        appendFileSync(DIAG_FILE, `${JSON.stringify({ at: new Date().toISOString(), event, data })}\n`);
    }
    catch {
        // Diagnostics must never affect the activation path.
    }
}
