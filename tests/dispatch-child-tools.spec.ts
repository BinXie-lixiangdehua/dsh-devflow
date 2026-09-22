/**
 * Commander `tools.restrict()` vs. dispatched child agents.
 *
 * The Commander restricts its OWN agent scope to the DevFlow tool family. The
 * subagent provider composes a child by joining it to the PARENT'S PRESET
 * STANDING SCOPE (`agentPresets.composeFrom(childCtx, parent.ctx)` →
 * `bindScopeParent(childKey, standingKey)`), so the child's scope chain is
 * standing → root: the Commander's own restriction is NOT on that chain. These
 * tests pin that mechanism with the real `dsh-scope` binding and the real
 * `ToolRuntime` restriction, because "the child inherits an empty tool set" was
 * exactly the production symptom.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope, bindScopeParent, scopeOf } from '@deepseek-ai/dsh-scope'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { DEFAULT_FIXED_AGENTS } from '../src/host/default-agents.ts'

const DEVFLOW_TOOLS = ['devflow_create_task', 'devflow_assign_agent', 'devflow_dispatch_agent']
/** The capability tools the `devflow` preset registers on win32. */
const CAPABILITY_TOOLS = ['read', 'write', 'edit', 'str_replace_editor', 'glob', 'grep', 'read_image', 'pwsh']

function tool(name: string) {
  return defineTool({
    name,
    description: `${name} fixture`,
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { name: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.name }],
    },
    execute: async () => ({ name }),
  })
}

/** A root runtime carrying both the DevFlow tools and the capability tools. */
function runtime() {
  const root = new Context()
  new SystemPrompt(root, {})
  const tools = new ToolRuntime(root)
  for (const name of [...DEVFLOW_TOOLS, ...CAPABILITY_TOOLS]) tools.register(tool(name))
  return { root, tools }
}

function joinedAgent(id: string, under: Context): Agent {
  const agent = { id } as Agent
  const scope = createScope(under, agent)
  Object.assign(agent, { ctx: scope.ctx })
  return agent
}

const names = (tools: ToolRuntime, agent: Agent): string[] =>
  tools.schemas(agent).map(schema => schema.name).sort()

const employeeTools = (agentId: string): readonly string[] =>
  DEFAULT_FIXED_AGENTS.find(agent => agent.agentId === agentId)?.tools ?? []

describe('Commander restriction and dispatched children', () => {
  it('does not mask a child joined to the preset standing scope', () => {
    const { root, tools } = runtime()
    // The preset standing scope: what `mountPreset` composes and what every
    // session naming the preset joins.
    const standing = createScope(root, { kind: 'standing' })
    const parent = joinedAgent('commander-parent', standing.ctx)
    parent.ctx.tools.restrict({ allow: DEVFLOW_TOOLS })
    expect(names(tools, parent)).toEqual([...DEVFLOW_TOOLS].sort())

    // What the subagent provider does: create the child's scope and JOIN it to
    // the parent's preset standing scope.
    const child = joinedAgent('child-backend', standing.ctx)
    bindScopeParent(scopeOf(child.ctx)!, scopeOf(standing.ctx))
    child.ctx.tools.restrict({ allow: [...employeeTools('backend-engineer')] })

    // The child keeps every capability tool the runtime registers; the
    // Commander's DevFlow-only mask is not on its chain.
    const visible = names(tools, child)
    expect(visible).toContain('read')
    expect(visible).toContain('write')
    expect(visible).toContain('edit')
    expect(visible).toContain('pwsh')
    expect(visible).not.toContain('devflow_create_task')
  })

  it('would mask a child bound under the restricted Commander scope (counterfactual)', () => {
    const { root, tools } = runtime()
    const standing = createScope(root, { kind: 'standing' })
    const parent = joinedAgent('commander-parent', standing.ctx)
    parent.ctx.tools.restrict({ allow: DEVFLOW_TOOLS })

    // NOT what the provider does — the explicit binding is what makes the
    // restriction inherit; kept as the reason the preset JOIN (not the parent
    // agent's ctx) is what keeps a child usable.
    const child = joinedAgent('child-under-parent', standing.ctx)
    bindScopeParent(scopeOf(child.ctx)!, scopeOf(parent.ctx))
    expect(names(tools, child)).toEqual([...DEVFLOW_TOOLS].sort())
    expect(names(tools, child)).not.toContain('write')
  })

  it('leaves the auditor without a writer while the engineer keeps one', () => {
    const { root, tools } = runtime()
    const standing = createScope(root, { kind: 'standing' })
    const child = (id: string, agentId: string) => {
      const agent = joinedAgent(id, standing.ctx)
      bindScopeParent(scopeOf(agent.ctx)!, scopeOf(standing.ctx))
      agent.ctx.tools.restrict({ allow: [...employeeTools(agentId)] })
      return agent
    }

    const backend = names(tools, child('child-backend', 'backend-engineer'))
    const auditor = names(tools, child('child-auditor', 'code-auditor'))
    expect(backend).toContain('write')
    expect(auditor).not.toContain('write')
    expect(auditor).toContain('read')
    expect(auditor).toContain('pwsh')
  })
})
