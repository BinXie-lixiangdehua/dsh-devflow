/** TEMPORARY row diagnostic (removed before hand-off). Never throws. */
import { appendFileSync } from 'node:fs';
const FILE = 'D:\\Deepseek\\DevFlow\\outputs\\row-diag.jsonl';
/**
 * Append one diagnostic record.
 * @param event - event name.
 * @param data - payload.
 */
export function rowDiag(event, data) {
    try {
        appendFileSync(FILE, `${JSON.stringify({ at: new Date().toISOString(), event, data })}\n`);
    }
    catch {
        // Diagnostics never affect the activation path.
    }
}
