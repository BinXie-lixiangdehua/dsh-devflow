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

import { buildMemoryContext } from './memory-context.ts'
import type { CommanderMemoryInput, CommanderCycleMemory, CommanderMemoryWriter } from './memory-integration.ts'
import type { CommanderOrchestrator } from './commander-orchestrator.ts'
import type { CommanderLoopResult, CommanderLoopRunner } from './commander-loop.ts'
import type { CommanderScheduler } from './commander-scheduler.ts'
import type { DevFlowStore } from './storage.ts'
import type { CommanderRunStatus, DevFlowProjectionState } from './types.ts'

/** The outcome of one driven run. */
import { recordDevFlowChange } from './journal.ts'
export interface CommanderRunOutcome {
  /** The persisted run id. */
  readonly runId: string
  /** The driven project. */
  readonly projectId: string
  /** The schedule that drove the run. */
  readonly scheduleId: string
  /** The settled run status. */
  readonly status: CommanderRunStatus
  /** The decision the cycle created; null when the run failed. */
  readonly decisionId: string | null
  /** The action the cycle created; null when the run failed. */
  readonly actionId: string | null
  /** The failure message; null on success. */
  readonly error: string | null
}

/** The driver's wiring: every seam it connects. */
export interface CommanderRuntimeDriverOptions {
  /** The storage the run, schedule, decision, action, and memory records go through. */
  readonly store: DevFlowStore
  /** The pure time judgment for the schedule. */
  readonly scheduler: CommanderScheduler
  /** The context source for the cycle. */
  readonly orchestrator: CommanderOrchestrator
  /** The one-cycle driver. */
  readonly loopRunner: CommanderLoopRunner
  /** The projection-state reader used to load the project memory. */
  readonly readState: () => DevFlowProjectionState
  /** The per-cycle memory slot a memory-aware provider reads. */
  readonly cycleMemory: CommanderCycleMemory
  /** The writer for caller-provided memory facts. */
  readonly memoryWriter: CommanderMemoryWriter
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
export class CommanderRuntimeDriver {
  constructor(private readonly options: CommanderRuntimeDriverOptions) {}

  /**
   * Drive one scheduled cycle for a project.
   * @param projectId - the project to drive.
   * @param now - the current time, ISO 8601 (the scheduler's clock).
   * @param summarize - optional caller-supplied summary facts to write after
   *   a completed cycle; return null to write nothing.
   * @returns the run outcome, or null when no schedule is due.
   */
  async runScheduledCycle(
    projectId: string,
    now: string,
    summarize?: (outcome: CommanderRunOutcome) => CommanderMemoryInput | null,
  ): Promise<CommanderRunOutcome | null> {
    const { store, scheduler } = this.options
    const schedule = (await store.listSchedules()).find(item => item.projectId === projectId)
    if (schedule === undefined || !scheduler.shouldRun(schedule, now)) return null
    return this.runCycle(projectId, schedule.scheduleId, summarize)
  }

  /**
   * Drive one cycle for a project immediately, bypassing the schedule gate —
   * the explicit manual trigger. A schedule must exist (the run record links
   * to it); projects without one fail loud.
   * @param projectId - the project to drive.
   * @param summarize - optional caller-supplied summary facts to write after
   *   a completed cycle; return null to write nothing.
   * @returns the run outcome.
   */
  async runOnce(
    projectId: string,
    summarize?: (outcome: CommanderRunOutcome) => CommanderMemoryInput | null,
  ): Promise<CommanderRunOutcome> {
    const schedule = (await this.options.store.listSchedules()).find(item => item.projectId === projectId)
    if (schedule === undefined) {
      throw new Error(`devflow: cannot run once for project ${projectId}: no schedule`)
    }
    return this.runCycle(projectId, schedule.scheduleId, summarize)
  }

  /** Drive one cycle for a project against a schedule link. */
  private async runCycle(
    projectId: string,
    scheduleId: string,
    summarize?: (outcome: CommanderRunOutcome) => CommanderMemoryInput | null,
  ): Promise<CommanderRunOutcome> {
    const { store, orchestrator, loopRunner, readState, cycleMemory, memoryWriter } = this.options
    const run = await store.createRunRecord({ projectId, scheduleId })
    await recordDevFlowChange(store, 'devflow/commander/run/create', { run })
    try {
      const context = orchestrator.processProject(projectId).context
      const memoryContext = buildMemoryContext(context, readState())
      cycleMemory.begin(memoryContext)
      let result: CommanderLoopResult
      try {
        result = await loopRunner.runCycle(projectId)
      } finally {
        cycleMemory.end()
      }
      const completed = await store.completeRunRecord(run.runId, result.decisionId, result.actionId)
      await recordDevFlowChange(store, 'devflow/commander/run/complete', {
        runId: run.runId,
        decisionId: result.decisionId,
        actionId: result.actionId,
        at: completed.completedAt ?? completed.updatedAt,
      })
      const outcome: CommanderRunOutcome = {
        runId: run.runId,
        projectId,
        scheduleId,
        status: 'completed',
        decisionId: result.decisionId,
        actionId: result.actionId,
        error: null,
      }
      const summary = summarize?.(outcome) ?? null
      if (summary !== null) await memoryWriter.write(summary)
      return outcome
    } catch (cause) {
      const failed = await store.failRunRecord(run.runId)
      await recordDevFlowChange(store, 'devflow/commander/run/fail', {
        runId: run.runId,
        at: failed.completedAt ?? failed.updatedAt,
      })
      const error = cause instanceof Error ? cause.message : String(cause)
      return {
        runId: run.runId,
        projectId,
        scheduleId,
        status: 'failed',
        decisionId: null,
        actionId: null,
        error,
      }
    }
  }
}
