/**
 * DevFlow durable data types. Pure structural types only; all runtime logic
 * lives in the storage and tool layers.
 * @module @xiaoxie-ide/dsh-devflow/types
 */
/** Every close reason, in one place, so all layers validate the same set. */
export const DEVFLOW_CLOSE_REASONS = ['stale-lost', 'superseded', 'abandoned'];
/** Is this value one of the three close reasons? */
export function isDevFlowCloseReason(value) {
    return typeof value === 'string' && DEVFLOW_CLOSE_REASONS.includes(value);
}
