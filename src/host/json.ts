/**
 * Shared JSON shape guards used at the durable-file and wire boundaries.
 * @module @xiaoxie-ide/dsh-devflow/json
 */

/** A lossless JSON tree accepted by the plugin-owned store and journal. */
export type DevFlowJsonValue = null | boolean | number | string | DevFlowJsonValue[] | { [key: string]: DevFlowJsonValue }

/** Whether a parsed value is a plain object (not null, not an array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a parsed value is a string. */
export function isString(value: unknown): value is string {
  return typeof value === 'string'
}

/** Whether a parsed value is an array of strings. */
export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString)
}
