/**
 * Commander memory context: the commander context extended with the
 * project's structured memory — the additional input a decision flow may
 * inject without changing the provider seam or the context model.
 * @module @xiaoxie-ide/dsh-devflow/memory-context
 */
/**
 * Build the extended commander input for a project: the base context plus
 * the project's memory records folded from the projection snapshot.
 * @param context - the base commander context.
 * @param state - the current devflow projection snapshot.
 * @returns the extended input.
 */
export function buildMemoryContext(context, state) {
    const memories = Object.values(state.commanderMemory)
        .filter(memory => memory.projectId === context.projectId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { context, memories };
}
