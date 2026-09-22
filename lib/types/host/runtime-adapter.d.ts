/**
 * Runtime adapter seam: the replaceable interface that turns a task package
 * into a result package, plus a default adapter that performs no external I/O.
 * Vendor-neutral by design — it speaks `RuntimeTaskPackage`/`RuntimeResultPackage`
 * only, with no model or provider binding. A future Harness Runtime adapter
 * swaps in here without touching the orchestration layer.
 * @module @xiaoxie-ide/dsh-devflow/runtime-adapter
 */
import type { RuntimeResultPackage, RuntimeTaskPackage } from './types.ts';
/** A request to execute one runtime task package. */
export interface RuntimeExecutionRequest {
    /** The task package handed to the runtime. */
    readonly taskPackage: RuntimeTaskPackage;
}
/** A response carrying one runtime result package. */
export interface RuntimeExecutionResponse {
    /** The result package produced by the runtime. */
    readonly resultPackage: RuntimeResultPackage;
}
/**
 * The runtime adapter contract: execute a task package and normalize a
 * returned result package. Implementations own the transport; the interface
 * stays model- and vendor-agnostic.
 */
export interface RuntimeAdapter {
    /**
     * Execute one task package and return its result package.
     * @param request - the task package wrapped as an execution request.
     * @returns the runtime's standardized result.
     */
    execute(request: RuntimeExecutionRequest): Promise<RuntimeExecutionResponse>;
    /**
     * Normalize an imported result package before it reaches the Commander.
     * @param resultPackage - the result package imported from the runtime.
     * @returns the normalized result package.
     */
    handleResult(resultPackage: RuntimeResultPackage): RuntimeResultPackage;
}
/**
 * Default adapter: performs no external service call and returns a
 * standardized failed result (the runtime is not connected), while passing
 * result packages through unchanged. Replaceable via the `RuntimeAdapter`
 * seam.
 */
export declare class DefaultRuntimeAdapter implements RuntimeAdapter {
    execute(request: RuntimeExecutionRequest): Promise<RuntimeExecutionResponse>;
    handleResult(resultPackage: RuntimeResultPackage): RuntimeResultPackage;
}
