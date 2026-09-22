/**
 * TEMPORARY activation diagnostic (removed before hand-off).
 *
 * Appends one JSON line per observed activation event to a file outside the
 * plugin, so the running host's in-process activation decisions can be read
 * without a debugger attached. Never throws, never changes behavior.
 */
/**
 * Append one diagnostic record.
 * @param event - short event name.
 * @param data - JSON-serializable payload.
 */
export declare function diagActivation(event: string, data: unknown): void;
