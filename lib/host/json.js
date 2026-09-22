/**
 * Shared JSON shape guards used at the durable-file and wire boundaries.
 * @module @xiaoxie-ide/dsh-devflow/json
 */
/** Whether a parsed value is a plain object (not null, not an array). */
export function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** Whether a parsed value is a string. */
export function isString(value) {
    return typeof value === 'string';
}
/** Whether a parsed value is an array of strings. */
export function isStringArray(value) {
    return Array.isArray(value) && value.every(isString);
}
