/**
 * Default commander runtime: the pre-wired default composition of the
 * commander loop — scheduler → driver → decision engine → validator → loop
 * runner. The runtime only assembles existing seams; each keeps its
 * responsibility (the scheduler judges time, the engine thinks, the
 * validator guards, the runner persists, the driver connects). The action
 * loop executes through the runtime adapter seam (unconfigured runtimes use
 * the default adapter and fail every execution explicitly); the action
 * executor is exposed for external callers but never called here.
 * @module @xiaoxie-ide/dsh-devflow/default-commander-runtime
 */
import { CommanderScheduler } from "./commander-scheduler.js";
import { CommanderOrchestrator } from "./commander-orchestrator.js";
import { CommanderRuntimeDriver } from "./commander-driver.js";
import { CommanderLoopRunner } from "./commander-loop.js";
import { CommanderActionLoop } from "./action-loop.js";
import { CommanderActionExecutor } from "./action-executor.js";
import { DefaultCommanderRuntimeAdapter } from "./commander-runtime-adapter.js";
import { CommanderDecisionEngine, createDefaultDecisionRules } from "./decision-engine.js";
import { CommanderDecisionValidator } from "./decision-validator.js";
/**
 * The default autonomous commander cycle. `runScheduledCycle` runs the
 * composed flow — schedule due → context → engine decision → validator →
 * persisted decision and action — and returns the run outcome. The action
 * loop executes through the configured adapter (the default adapter fails
 * explicitly until a real runtime is wired); the action executor is
 * available as a field for external callers; the runtime never executes
 * actions itself.
 */
export class DefaultCommanderRuntime {
    /** The pure time judgment. */
    scheduler;
    /** The context source. */
    orchestrator;
    /** The default rule decision engine (the provider unless overridden). */
    engine;
    /** The decision safety guard. */
    validator;
    /** The one-cycle persistence driver. */
    runner;
    /** The run-flow connector. */
    driver;
    /** The action performer — exposed for external callers, never called here. */
    actionExecutor;
    /** The resolved runtime adapter the action loop executes through. */
    adapter;
    /** The action execution loop — the action-execution entry for external callers. */
    actionLoop;
    constructor(options) {
        this.scheduler = new CommanderScheduler();
        this.orchestrator = new CommanderOrchestrator(options.readState);
        this.engine = new CommanderDecisionEngine(createDefaultDecisionRules(), options.experience);
        this.validator = new CommanderDecisionValidator(options.readState);
        this.runner = new CommanderLoopRunner(this.orchestrator, options.store, options.provider ?? this.engine, this.validator, options.governance);
        this.driver = new CommanderRuntimeDriver({
            store: options.store,
            scheduler: this.scheduler,
            orchestrator: this.orchestrator,
            loopRunner: this.runner,
            readState: options.readState,
            cycleMemory: options.cycleMemory,
            memoryWriter: options.memoryWriter,
        });
        this.adapter = options.adapter ?? new DefaultCommanderRuntimeAdapter();
        this.actionExecutor = new CommanderActionExecutor(options.store);
        this.actionLoop = new CommanderActionLoop(this.adapter, options.store);
    }
    /**
     * Run one scheduled autonomous cycle for a project.
     * @param projectId - the project to drive.
     * @param now - the current time, ISO 8601 (the scheduler's clock).
     * @param summarize - optional caller-provided summary facts to write after
     *   a completed cycle; return null to write nothing.
     * @returns the run outcome, or null when no schedule is due.
     */
    runScheduledCycle(projectId, now, summarize) {
        return this.driver.runScheduledCycle(projectId, now, summarize);
    }
    /**
     * Run one autonomous cycle immediately, bypassing the schedule gate — the
     * explicit manual trigger. A schedule must exist for the project.
     * @param projectId - the project to drive.
     * @param summarize - optional caller-provided summary facts to write after
     *   a completed cycle; return null to write nothing.
     * @returns the run outcome.
     */
    runOnce(projectId, summarize) {
        return this.driver.runOnce(projectId, summarize);
    }
}
