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

import { CommanderScheduler } from './commander-scheduler.ts'
import { CommanderOrchestrator } from './commander-orchestrator.ts'
import { CommanderRuntimeDriver, type CommanderRunOutcome } from './commander-driver.ts'
import { CommanderLoopRunner } from './commander-loop.ts'
import { CommanderActionLoop } from './action-loop.ts'
import { CommanderActionExecutor } from './action-executor.ts'
import { DefaultCommanderRuntimeAdapter, type CommanderRuntimeAdapter } from './commander-runtime-adapter.ts'
import { CommanderDecisionEngine, createDefaultDecisionRules } from './decision-engine.ts'
import { CommanderDecisionValidator } from './decision-validator.ts'
import type { CommanderGovernanceChecker } from './governance.ts'
import type { CommanderDecisionProvider } from './decision-provider.ts'
import type { CommanderMemoryInput, CommanderCycleMemory, CommanderMemoryWriter } from './memory-integration.ts'
import type { CommanderExperienceContext } from './experience.ts'
import type { DevFlowStore } from './storage.ts'
import type { DevFlowProjectionState } from './types.ts'

/** The default runtime's wiring. */
export interface DefaultCommanderRuntimeOptions {
  /** The storage every record goes through. */
  readonly store: DevFlowStore
  /** The projection-state reader (context, validation, and memory loading). */
  readonly readState: () => DevFlowProjectionState
  /** The per-cycle memory slot a memory-aware provider reads. */
  readonly cycleMemory: CommanderCycleMemory
  /** The writer for caller-provided memory facts. */
  readonly memoryWriter: CommanderMemoryWriter
  /** Optional provider override; defaults to the rule decision engine. */
  readonly provider?: CommanderDecisionProvider
  /** Optional experience reader for the rule engine (memory-derived insights). */
  readonly experience?: () => CommanderExperienceContext | null
  /** Optional policy checker; the loop runner enforces it between validation and action creation. */
  readonly governance?: CommanderGovernanceChecker
  /** Optional runtime adapter the action loop executes through; defaults to the not-connected default adapter. */
  readonly adapter?: CommanderRuntimeAdapter
}

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
  readonly scheduler: CommanderScheduler
  /** The context source. */
  readonly orchestrator: CommanderOrchestrator
  /** The default rule decision engine (the provider unless overridden). */
  readonly engine: CommanderDecisionEngine
  /** The decision safety guard. */
  readonly validator: CommanderDecisionValidator
  /** The one-cycle persistence driver. */
  readonly runner: CommanderLoopRunner
  /** The run-flow connector. */
  readonly driver: CommanderRuntimeDriver
  /** The action performer — exposed for external callers, never called here. */
  readonly actionExecutor: CommanderActionExecutor
  /** The resolved runtime adapter the action loop executes through. */
  readonly adapter: CommanderRuntimeAdapter
  /** The action execution loop — the action-execution entry for external callers. */
  readonly actionLoop: CommanderActionLoop

  constructor(options: DefaultCommanderRuntimeOptions) {
    this.scheduler = new CommanderScheduler()
    this.orchestrator = new CommanderOrchestrator(options.readState)
    this.engine = new CommanderDecisionEngine(createDefaultDecisionRules(), options.experience)
    this.validator = new CommanderDecisionValidator(options.readState)
    this.runner = new CommanderLoopRunner(
      this.orchestrator,
      options.store,
      options.provider ?? this.engine,
      this.validator,
      options.governance,
    )
    this.driver = new CommanderRuntimeDriver({
      store: options.store,
      scheduler: this.scheduler,
      orchestrator: this.orchestrator,
      loopRunner: this.runner,
      readState: options.readState,
      cycleMemory: options.cycleMemory,
      memoryWriter: options.memoryWriter,
    })
    this.adapter = options.adapter ?? new DefaultCommanderRuntimeAdapter()
    this.actionExecutor = new CommanderActionExecutor(options.store)
    this.actionLoop = new CommanderActionLoop(this.adapter, options.store)
  }

  /**
   * Run one scheduled autonomous cycle for a project.
   * @param projectId - the project to drive.
   * @param now - the current time, ISO 8601 (the scheduler's clock).
   * @param summarize - optional caller-provided summary facts to write after
   *   a completed cycle; return null to write nothing.
   * @returns the run outcome, or null when no schedule is due.
   */
  runScheduledCycle(
    projectId: string,
    now: string,
    summarize?: (outcome: CommanderRunOutcome) => CommanderMemoryInput | null,
  ): Promise<CommanderRunOutcome | null> {
    return this.driver.runScheduledCycle(projectId, now, summarize)
  }

  /**
   * Run one autonomous cycle immediately, bypassing the schedule gate — the
   * explicit manual trigger. A schedule must exist for the project.
   * @param projectId - the project to drive.
   * @param summarize - optional caller-provided summary facts to write after
   *   a completed cycle; return null to write nothing.
   * @returns the run outcome.
   */
  runOnce(
    projectId: string,
    summarize?: (outcome: CommanderRunOutcome) => CommanderMemoryInput | null,
  ): Promise<CommanderRunOutcome> {
    return this.driver.runOnce(projectId, summarize)
  }
}
