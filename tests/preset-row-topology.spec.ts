/**
 * N1-e-1 cordis-level regression for the `devflow` preset activation row.
 *
 * The previous round missed the shipped defect because its coverage only read
 * the YAML composition and called the adapter CLASS directly — it never let
 * cordis load the row plugin in a sibling fiber branch, which is exactly the
 * topology the preset standing subtree has in production. These tests load the
 * REAL row module (never a stand-in) through `ctx.plugin` so the service-read
 * path is exercised the way the host exercises it.
 */

import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import {
  devFlowActivationRow, apply as rowApply, name as rowName,
} from '../src/host/preset-activation.ts'

const HOST_UNAVAILABLE = 'devflow: preset activation requires the DevFlow host controller (devflow service)'
const BUILT_ROW = 'D:/Deepseek/DevFlow/lib/host/preset-activation.js'

interface GlobalImpl {
  readonly name: string
  readonly value: unknown
}

/** Every implementation in the runtime's global service store, by name. */
function globalImpls(ctx: Context, name: string): GlobalImpl[] {
  const store = ctx.reflect.store as Record<symbol, GlobalImpl | undefined>
  return Object.getOwnPropertySymbols(store)
    .map(key => store[key])
    .filter((impl): impl is GlobalImpl => impl !== undefined && impl.name === name)
}

/** A host controller double with the one capability the row needs. */
function hostController(): { createActivationProvider(): { activate(): Promise<{ deactivate(): Promise<void>; restore(): Promise<void> }> } } {
  return {
    createActivationProvider: () => ({
      activate: async () => ({ deactivate: async () => {}, restore: async () => {} }),
    }),
  }
}

/**
 * Boot a context where the host `devflow` service lives on ONE plugin branch,
 * then hand back a loader that mounts the row on a SEPARATE (sibling) branch —
 * the preset standing subtree topology.
 */
async function siblingTopology(host?: unknown) {
  const ctx = new Context()
  if (host !== undefined) {
    await ctx.plugin({
      name: 'devflow-deployment-bundle',
      apply(c: Context) { c.provide('devflow', host as never) },
    })
  }
  return {
    ctx,
    /** Mount a row value the way the preset loader does: a sibling branch. */
    mount: (row: Parameters<Context['plugin']>[0]) => ctx.plugin(row, {}),
  }
}

async function settled<T>(operation: PromiseLike<T>): Promise<unknown> {
  return await operation.then(() => undefined, (error: unknown) => error)
}

describe('devflow preset row service read topology', () => {
  it('mounts the real row in a sibling branch and publishes exactly one provider', async () => {
    const { ctx, mount } = await siblingTopology(hostController())

    // Pre-fix this rejected with `cannot get property "devflow" without inject`:
    // the property proxy walks only the ancestor chain, and the host service
    // lives on a sibling fiber.
    await expect(mount(devFlowActivationRow)).resolves.toBeDefined()

    const providers = globalImpls(ctx, 'agentPresetActivation')
    expect(providers).toHaveLength(1)
    expect(typeof (providers[0]?.value as { activate?: unknown } | undefined)?.activate).toBe('function')
  })

  it('withdraws the provider when the row fiber is disposed', async () => {
    const { ctx, mount } = await siblingTopology(hostController())
    const fiber = await mount(devFlowActivationRow)
    expect(globalImpls(ctx, 'agentPresetActivation')).toHaveLength(1)

    await Promise.resolve((fiber as unknown as { dispose(): unknown }).dispose())
    await Promise.resolve()

    expect(globalImpls(ctx, 'agentPresetActivation')).toHaveLength(0)
  })

  it('fails closed with the fixed message when no host controller is composed', async () => {
    const { mount } = await siblingTopology()
    const failure = await settled(mount(devFlowActivationRow))

    expect(failure).toBeInstanceOf(Error)
    const message = failure instanceof Error ? failure.message : String(failure)
    expect(message).toBe(HOST_UNAVAILABLE)
    expect(message).not.toContain('without inject')
    expect(failure).not.toBeInstanceOf(TypeError)
  })

  it('fails closed with the fixed message when the host controller lacks the capability', async () => {
    const { mount } = await siblingTopology({ someOtherCapability: true })
    const failure = await settled(mount(devFlowActivationRow))

    expect(failure).toBeInstanceOf(Error)
    const message = failure instanceof Error ? failure.message : String(failure)
    expect(message).toBe(HOST_UNAVAILABLE)
    expect(message).not.toContain('without inject')
    expect(failure).not.toBeInstanceOf(TypeError)
  })

  it('keeps the named entry surface loadable as a row', async () => {
    expect(rowName).toBe('devflow-preset-activation')
    const { ctx, mount } = await siblingTopology(hostController())
    await expect(mount({ name: rowName, apply: rowApply })).resolves.toBeDefined()
    expect(globalImpls(ctx, 'agentPresetActivation')).toHaveLength(1)
  })

  it('mounts the built artifact under the same sibling topology', async () => {
    if (!existsSync(BUILT_ROW)) {
      // The built module is the file the deployed preset row loads. When a
      // build has not run yet the source-module cases above still represent
      // the topology; this case is the extra guard for the shipped file.
      expect(existsSync(BUILT_ROW)).toBe(true)
      return
    }
    const built = await import(pathToFileURL(BUILT_ROW).href) as { default: Parameters<Context['plugin']>[0] }
    const { ctx, mount } = await siblingTopology(hostController())
    await expect(mount(built.default)).resolves.toBeDefined()
    expect(globalImpls(ctx, 'agentPresetActivation')).toHaveLength(1)
  })
})
