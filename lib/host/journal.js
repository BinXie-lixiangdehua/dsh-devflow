/**
 * Persist a post-mutation DevFlow audit fact in the plugin-owned journal.
 *
 * DevFlow events are never appended to Session: a third-party plugin cannot
 * reliably extend the host persistence vocabulary. Official tool lifecycle
 * records are independently produced by the dsh tool runtime and remain the
 * only session-level conversation anchors.
 */
export async function recordDevFlowChange(store, type, data) {
    let json;
    try {
        json = JSON.parse(JSON.stringify(data));
    }
    catch (error) {
        throw new Error(`devflow: cannot journal ${type}: data is not JSON-serializable`, { cause: error });
    }
    return store.appendJournal(type, json);
}
