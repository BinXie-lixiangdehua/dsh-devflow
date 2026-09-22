/**
 * Runtime adapter seam: the replaceable interface that turns a task package
 * into a result package, plus a default adapter that performs no external I/O.
 * Vendor-neutral by design — it speaks `RuntimeTaskPackage`/`RuntimeResultPackage`
 * only, with no model or provider binding. A future Harness Runtime adapter
 * swaps in here without touching the orchestration layer.
 * @module @xiaoxie-ide/dsh-devflow/runtime-adapter
 */
import { randomUUID } from 'node:crypto';
/**
 * Default adapter: performs no external service call and returns a
 * standardized failed result (the runtime is not connected), while passing
 * result packages through unchanged. Replaceable via the `RuntimeAdapter`
 * seam.
 */
export class DefaultRuntimeAdapter {
    execute(request) {
        return Promise.resolve({
            resultPackage: {
                resultId: randomUUID(),
                executionId: request.taskPackage.executionId,
                status: 'failed',
                output: 'runtime not connected',
                metadata: {},
                createdAt: new Date().toISOString(),
            },
        });
    }
    handleResult(resultPackage) {
        return resultPackage;
    }
}
