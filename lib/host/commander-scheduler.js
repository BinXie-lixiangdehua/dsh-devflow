/**
 * Commander scheduling foundation: the pure should-run judgment for one
 * commander cycle schedule. The scheduler only answers whether the loop is
 * due — it never runs the loop, never touches a runtime, and never writes
 * state; the caller drives the cycle and records the run through the
 * schedule store.
 * @module @xiaoxie-ide/dsh-devflow/commander-scheduler
 */
/**
 * The pure commander cycle scheduler. Stateless by design: the judgment is a
 * function of the schedule and the clock, so the same inputs always produce
 * the same answer.
 */
export class CommanderScheduler {
    /**
     * Decide whether one commander cycle is due for a schedule.
     * @param schedule - the schedule to judge.
     * @param now - the current time, ISO 8601.
     * @returns true when the schedule is active and its `nextRunAt` has passed.
     */
    shouldRun(schedule, now) {
        return schedule.status === 'active' && schedule.nextRunAt <= now;
    }
}
