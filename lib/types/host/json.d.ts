/**
 * Shared JSON shape guards used at the durable-file and wire boundaries.
 * @module @xiaoxie-ide/dsh-devflow/json
 */
/** A lossless JSON tree accepted by the plugin-owned store and journal. */
export type DevFlowJsonValue = null | boolean | number | string | DevFlowJsonValue[] | {
    [key: string]: DevFlowJsonValue;
};
/** Whether a parsed value is a plain object (not null, not an array). */
export declare function isRecord(value: unknown): value is Record<string, unknown>;
/** Whether a parsed value is a string. */
export declare function isString(value: unknown): value is string;
/** Whether a parsed value is an array of strings. */
export declare function isStringArray(value: unknown): value is string[];
