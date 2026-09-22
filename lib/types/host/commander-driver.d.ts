/**
 * Commander runtime driver: the run-flow connector that drives one scheduled
 * commander cycle end to end. The driver checks the schedule (through the
 * scheduler), loads the project memory for the cycle (through the memory
 * integration layer), calls the loop runner, records the run, and writes
 * caller-provided summary facts back to memory. It never generates a
 * decision, never calls a model, never executes an action, and never touches
 * the runtime — the scheduler judges time, the runner creates the
 * decision/action, the action executor executes, and this layer connects the
 * flow and records what happened.
 * @module @xiaoxie-ide/dsh-devflow/commander-driver
 */
import type { CommanderMemoryInput, CommanderCycleMemory, CommanderMemoryWriter } from './memory-integration.ts';
import type { CommanderOrchestrator } from './commander-orchestrator.ts';
import type { CommanderLoopRunner } from './commander-loop.ts';
import type { CommanderScheduler } from './commander-scheduler.ts';
import type { DevFlowStore } from './storage.ts';
import type { CommanderRunStatus, DevFlowProjectionState } from './types.ts';
export interface CommanderRunOutcome {
    /** The persisted run id. */
    readonly runId: string;
    /** The driven project. */
    readonly projectId: string;
    /** The schedule that drove the run. */
    readonly scheduleId: string;
    /** The settled run status. */
    readonly status: CommanderRunStatus;
    /** The decision the cycle created; null when the run failed. */
    readonly decisionId: string | null;
    /** The action the cycle created; null when the run failed. */
    readonly actionId: string | null;
    /** The failure message; null on success. */
    readonly error: string | null;
}
/** The driver's wiring: every seam it connects. */
export interface CommanderRuntimeDriverOptions {
    /** The storage the run, schedule, decision, action, and memory records go through. */
    readonly store: DevFlowStore;
    /** The pure time judgment for the schedule. */
    readonly scheduler: CommanderScheduler;
    /** The context source for the cycle. */
    readonly orchestrator: CommanderOrchestrator;
    /** The one-cycle driver. */
    readonly loopRunner: CommanderLoopRunner;
    /** The projection-state reader used to load the project memory. */
    readonly readState: () => DevFlowProjectionState;
    /** The per-cycle memory slot a memory-aware provider reads. */
    readonly cycleMemory: CommanderCycleMemory;
    /** The writer for caller-provided memory facts. */
    readonly memoryWriter: CommanderMemoryWriter;
}
/**
 * The commander run-flow connector. `runScheduledCycle` returns null when no
 * schedule exists for the project or the schedule is not due; `runOnce`
 * drives the same cycle explicitly, bypassing the schedule gate (a schedule
 * must exist for the run record's link). Either way the flow records a run,
 * loads the project memory into the cycle slot, drives the loop runner,
 * settles the run, and writes the caller-supplied summary fact (if any).
 * Schedule advancement (`markRunAt`) stays with the caller, and action
 * execution stays with the caller through the action executor.
 */
export declare class CommanderRuntimeDriver {
    private readonly options;
    constructor(options: CommanderRuntimeDriverOptions);
    /**
     * Drive one scheduled cycle for a project.
     * @param projectId - the project to drive.
     * @param now - the current time, ISO 8601 (the scheduler's clock).
     * @param summarize - optional caller-supplied summary facts to write after
     *   a completed cycle; return null to write nothing.
     * @returns the run outcome, or null when no schedule is due.
     */
    runScheduledCycle(projectId: string, now: string, summarize?: (outcome: CommanderRunOutcome) => CommanderMemoryInput | null): Promise<CommanderRunOutcome | null>;
    /**
     * Drive one cycle for a project immediately, bypassing the schedule gate —
     * the explicit manual trigger. A schedule must exist (the run record links
     * to it); projects without one fail loud.
     * @param projectId - the project to drive.
     * @param summarize - optional caller-supplied summary facts to write after
     *   a completed cycle; return null to write nothing.
     * @returns the run outcome.
     */
    runOnce(projectId: string, summarize?: (outcome: CommanderRunOutcome) => CommanderMemoryInput | null): Promise<CommanderRunOutcome>;
    /** Drive one cycle for a project against a schedule link. */
    private runCycle;
}
