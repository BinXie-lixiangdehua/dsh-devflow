/** Generated-artifact-compatible Host Remote contribution for the DevFlow bridge. */
import { z } from 'zod';
const SESSION_ID = z.string().min(1);
const STATE_UNAVAILABLE = {
    code: 'state-unavailable',
    message: 'DevFlow state is unavailable. Refresh to try again.',
};
const SNAPSHOT_RESPONSE = z.unknown().transform(parseSnapshotResponse);
/**
 * Explicit Host Remote declarations keep the bridge discoverable when the
 * linked package resolves a different physical copy of the decorator module.
 */
export const TYPERT = {
    package: '@xiaoxie-ide/dsh-devflow',
    face: 'host',
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: [
        descriptor('snapshot'),
        descriptor('refresh'),
    ],
};
function descriptor(method) {
    return {
        id: `@xiaoxie-ide/dsh-devflow#devflowClient/${method}`,
        service: 'devflowClient',
        namespace: 'devflow',
        method,
        invocation: { kind: 'direct' },
        scope: { context: 'agent', wire: 'agentId' },
        parameters: [{
                name: 'agent',
                wire: 'agentId',
                source: 'lookup',
                lookup: 'agent',
                codec: { mode: 'strict', typeSymbol: 'session-id', schema: SESSION_ID },
            }],
        result: {
            mode: 'strict',
            typeSymbol: 'devflow-client-snapshot-response',
            schema: SNAPSHOT_RESPONSE,
        },
    };
}
function parseSnapshotResponse(value) {
    if (!isRecord(value) || typeof value.kind !== 'string')
        throw new Error('invalid DevFlow bridge response');
    if (value.kind === 'error') {
        if (!isRecord(value.error) || value.error.code !== STATE_UNAVAILABLE.code || value.error.message !== STATE_UNAVAILABLE.message) {
            throw new Error('invalid DevFlow bridge error');
        }
        return value;
    }
    if (value.kind !== 'snapshot' || !isRecord(value.snapshot))
        throw new Error('invalid DevFlow bridge response');
    const snapshot = value.snapshot;
    if (snapshot.version !== 1 || typeof snapshot.generatedAt !== 'string' || !isRecord(snapshot.session)
        || typeof snapshot.session.id !== 'string'
        || (snapshot.session.commanderMode !== 'chat' && snapshot.session.commanderMode !== 'commander')
        || typeof snapshot.paused !== 'boolean' || !Array.isArray(snapshot.agents) || !Array.isArray(snapshot.tasks)
        || !Array.isArray(snapshot.phases) || !Array.isArray(snapshot.assignments) || !Array.isArray(snapshot.executions)
        || !Array.isArray(snapshot.decisions) || !Array.isArray(snapshot.decisionRequests)
        || (snapshot.project !== null && !isRecord(snapshot.project))) {
        throw new Error('invalid DevFlow snapshot');
    }
    return value;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
