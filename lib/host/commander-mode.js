/** Current-session Commander persona lifecycle for DevFlow developer mode. */
const COMMANDER_TOOL_NAMES = [
    'ask_user_question',
    'devflow_project_status', 'devflow_create_task', 'devflow_transition_task', 'devflow_submit_result',
    'devflow_create_task_package', 'devflow_export_task', 'devflow_import_result', 'devflow_resume',
    'devflow_create_phase', 'devflow_update_phase', 'devflow_set_scope', 'devflow_clear_scope', 'devflow_assign_agent',
    'devflow_request_decision', 'devflow_pause', 'devflow_resume_dispatch', 'devflow_dispatch_agent',
    // Employee registration. It must stay reachable through the Commander seat:
    // the tool's own allow-list is "the caller holds the Commander seat", so a
    // restriction that hid the tool would make it unreachable by its only
    // authorized caller.
    'devflow_agent_upsert',
    // Read-only navigation: the Commander reads the project's own navigation files
    // at kickoff (root rule file, then `docs/`). These three are the ONLY native
    // tools allowed through; no writing or shell tool may be appended here.
    'read', 'glob', 'grep',
];
/**
 * Installs the Commander persona into the current session Agent's scoped
 * system prompt. It creates neither an Agent nor a Session: normal user input
 * remains in the same native conversation while DevFlow state stays in the
 * plugin-owned `.devflow` store.
 */
export class CommanderMode {
    persona;
    active = new Map();
    constructor(persona) {
        this.persona = persona;
    }
    /** Enter Commander mode for the current session Agent. */
    enter(agent, projectId) {
        if (projectId.trim() === '')
            throw new Error('devflow: commander mode needs a non-empty projectId');
        // Re-selecting the SAME project for an already-bound Agent is a no-op: the
        // preset activation transaction relies on idempotent enter to avoid
        // re-installing persona/tool/presentation layers on repeat selection.
        const current = this.active.get(agent.id);
        if (current?.projectId === projectId) {
            return { mode: 'commander', sessionId: agent.id, projectId, changedAt: current.changedAt };
        }
        this.exit(agent);
        const changedAt = new Date().toISOString();
        const disposePresentation = agent.ctx.tools.presentAs('native');
        try {
            const available = new Set(agent.ctx.tools.schemas(agent).map(tool => tool.name));
            const disposeTools = agent.ctx.tools.restrict({
                allow: COMMANDER_TOOL_NAMES.filter(name => available.has(name)),
            });
            try {
                const disposePersona = agent.ctx.systemPrompt.section({
                    name: 'devflow-commander-persona',
                    order: 1,
                    text: this.persona,
                });
                this.active.set(agent.id, { projectId, disposePersona, disposeTools, disposePresentation, changedAt });
            }
            catch (error) {
                disposeTools();
                throw error;
            }
        }
        catch (error) {
            disposePresentation();
            throw error;
        }
        return { mode: 'commander', sessionId: agent.id, projectId, changedAt };
    }
    /** Remove the Commander persona from the current session Agent. */
    exit(agent) {
        const active = this.active.get(agent.id);
        if (active !== undefined) {
            this.active.delete(agent.id);
            try {
                active.disposePersona();
            }
            finally {
                try {
                    active.disposeTools();
                }
                finally {
                    active.disposePresentation();
                }
            }
        }
        return { mode: 'chat', sessionId: null, projectId: null, changedAt: new Date().toISOString() };
    }
    /** Read one session Agent's mode state. */
    current(agent) {
        const active = this.active.get(agent.id);
        return active === undefined
            ? { mode: 'chat', sessionId: null, projectId: null, changedAt: '' }
            : { mode: 'commander', sessionId: agent.id, projectId: active.projectId, changedAt: active.changedAt };
    }
    /**
     * Verify that one Agent's Commander installation is live and complete.
     *
     * Map presence alone is not proof: the entry records that persona, tools,
     * and presentation disposers were installed, but only a live scope read can
     * confirm the tool restriction still hides native tools. Cold-restart and
     * recompose verification therefore checks both the entry and the visible
     * schema set before anything may be reported `bound`.
     * @param agent - the session Agent to verify.
     * @param projectId - when given, the entry must be bound to this project.
     */
    verify(agent, projectId) {
        const active = this.active.get(agent.id);
        if (active === undefined)
            return { ok: false, failureCode: 'devflow-mode-not-installed' };
        if (projectId !== undefined && active.projectId !== projectId) {
            return { ok: false, failureCode: 'devflow-project-mismatch' };
        }
        const visible = new Set(agent.ctx.tools.schemas(agent).map(tool => tool.name));
        const allowed = new Set(COMMANDER_TOOL_NAMES);
        for (const name of visible) {
            if (!allowed.has(name))
                return { ok: false, failureCode: 'devflow-tool-restriction-missing' };
        }
        return { ok: true };
    }
}
