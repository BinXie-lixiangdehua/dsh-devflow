import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.tsx'
import { DEVFLOW_ID, DEVFLOW_KIND } from '../src/client/sidebar-definition.ts'
import type { DevFlowRemote } from '../src/client/remote.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(innerResolve => { resolve = innerResolve })
  return { promise, resolve }
}

interface ListState {
  current: string | undefined
  byId: Record<string, { sessionId: string; projectionValues?: { agentPreset?: string } }>
  phase: string
}

/** A stand-in for the client session list store the preset gate subscribes to. */
function fakeSessions(state: ListState, scope = vi.fn(() => undefined)) {
  const listeners = new Set<() => void>()
  let snapshot = state
  return {
    scope,
    list: {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    },
    set(next: ListState) { snapshot = next; for (const listener of listeners) listener() },
  }
}

/** A fake `document` for the style installer. */
function stubDocument(): void {
  vi.stubGlobal('document', {
    createElement: () => ({ dataset: {}, textContent: '', remove: () => {} }),
    head: { append: () => {} },
  })
}

function typeRegistrations(sidebarRightTabs: { register: ReturnType<typeof vi.fn> }): number {
  return sidebarRightTabs.register.mock.calls.length
}

describe('DevFlow client apply', () => {
  it('registers the DevFlow right-Sidebar tab type before its Remote bridge finishes mounting', async () => {
    const ctx = new Context()
    const mounted = deferred<() => Promise<void>>()
    const registrations: Array<Record<string, unknown>> = []
    const slots = {
      inject: vi.fn((_key: string, callback: () => () => void) => callback()),
      register: vi.fn((options: Record<string, unknown>) => {
        registrations.push(options)
        return () => {}
      }),
    }
    const locale = {
      register: vi.fn(() => () => {}),
      bind: vi.fn(() => (key: string) => key === 'canvas' ? 'DevFlow Canvas' : key),
    }
    const remote = {
      $mount: vi.fn(() => mounted.promise),
      devflow: { snapshot: vi.fn(), refresh: vi.fn() },
    }
    const sidebarRightTabs = { register: vi.fn(() => () => {}) }
    stubDocument()
    ctx.provide('slots', slots as never)
    ctx.provide('locale', locale as never)
    ctx.provide('remote', remote as never)
    ctx.provide('sessions', fakeSessions({
      current: 'session-devflow',
      byId: { 'session-devflow': { sessionId: 'session-devflow', projectionValues: { agentPreset: 'devflow' } } },
      phase: 'ready',
    }) as never)
    ctx.provide('sidebarRightTabs', sidebarRightTabs as never)

    apply(ctx as never)

    // Stage one: the tab type, which is also what puts DevFlow on the guide page.
    expect(sidebarRightTabs.register).toHaveBeenCalledOnce()
    expect(sidebarRightTabs.register).toHaveBeenCalledWith(expect.objectContaining({
      id: DEVFLOW_ID, kind: DEVFLOW_KIND, priority: 'extension',
    }))
    // Stage two: body and chip title, both keyed by the type's id.
    expect(slots.inject).toHaveBeenCalledWith('sidebar.right.pane.tab', expect.any(Function))
    expect(slots.inject).toHaveBeenCalledWith('sidebar.right.pane.tab.title', expect.any(Function))
    expect(registrations).toContainEqual(expect.objectContaining({
      name: 'sidebar.right.pane.tab', key: DEVFLOW_ID, locale: 'devflow',
    }))
    expect(registrations).toContainEqual(expect.objectContaining({
      name: 'sidebar.right.pane.tab.title', key: DEVFLOW_ID, locale: 'devflow',
    }))
    // The conversation-area seat is gone: DevFlow state no longer rides a chat tab.
    expect(slots.inject).not.toHaveBeenCalledWith('conversation.view', expect.any(Function))
    expect(registrations.some(entry => entry.name === 'conversation.view')).toBe(false)
    expect(remote.$mount).toHaveBeenCalledOnce()

    mounted.resolve(async () => undefined)
    await mounted.promise
    await ctx.fiber.dispose()
    vi.unstubAllGlobals()
  })

  it('binds the tab type to the session preset and follows session switches', async () => {
    const ctx = new Context()
    let disposed = 0
    const sidebarRightTabs = { register: vi.fn(() => () => { disposed += 1 }) }
    const slots = {
      inject: vi.fn((_key: string, callback: () => () => void) => callback()),
      register: vi.fn(() => () => {}),
    }
    const locale = { register: vi.fn(() => () => {}), bind: vi.fn(() => (key: string) => key) }
    const remote = { $mount: vi.fn(() => Promise.resolve(async () => {})) }
    stubDocument()
    const sessions = fakeSessions({
      current: 'session-standard',
      byId: { 'session-standard': { sessionId: 'session-standard', projectionValues: { agentPreset: 'standard' } } },
      phase: 'ready',
    })
    ctx.provide('slots', slots as never)
    ctx.provide('locale', locale as never)
    ctx.provide('remote', remote as never)
    ctx.provide('sessions', sessions as never)
    ctx.provide('sidebarRightTabs', sidebarRightTabs as never)

    apply(ctx as never)
    // Standard preset: no DevFlow type, so neither the tab nor the guide capsule exists.
    expect(typeRegistrations(sidebarRightTabs)).toBe(0)

    // Switch to a DevFlow session: the type appears.
    sessions.set({
      current: 'session-devflow',
      byId: { 'session-devflow': { sessionId: 'session-devflow', projectionValues: { agentPreset: 'devflow' } } },
      phase: 'ready',
    })
    expect(typeRegistrations(sidebarRightTabs)).toBe(1)

    // Repeated list notifications for the same session must not re-register.
    sessions.set({
      current: 'session-devflow',
      byId: {
        'session-devflow': { sessionId: 'session-devflow', projectionValues: { agentPreset: 'devflow' } },
        'session-other': { sessionId: 'session-other', projectionValues: { agentPreset: 'devflow' } },
      },
      phase: 'ready',
    })
    expect(typeRegistrations(sidebarRightTabs)).toBe(1)

    // Switch away again: the disposer runs and the type is gone.
    sessions.set({
      current: 'session-standard',
      byId: { 'session-standard': { sessionId: 'session-standard', projectionValues: { agentPreset: 'standard' } } },
      phase: 'ready',
    })
    expect(typeRegistrations(sidebarRightTabs)).toBe(1)
    expect(disposed).toBe(1)

    await ctx.fiber.dispose()
    vi.unstubAllGlobals()
  })

  it('uses the session Agent context Remote after mounting', async () => {
    const ctx = new Context()
    const mounted = deferred<() => Promise<void>>()
    const registrations: Array<Record<string, unknown>> = []
    const scopedRemote = {
      snapshot: vi.fn(),
      refresh: vi.fn(),
    } as unknown as DevFlowRemote
    const rootRemote = {
      $mount: vi.fn(() => mounted.promise),
      devflow: { snapshot: vi.fn(), refresh: vi.fn() },
    }
    const slots = {
      inject: vi.fn((_key: string, callback: () => () => void) => callback()),
      register: vi.fn((options: Record<string, unknown>) => {
        registrations.push(options)
        return () => {}
      }),
    }
    const locale = {
      register: vi.fn(() => () => {}),
      bind: vi.fn(() => (key: string) => key),
    }
    const sessions = fakeSessions({
      current: 'session-a',
      byId: { 'session-a': { sessionId: 'session-a', projectionValues: { agentPreset: 'devflow' } } },
      phase: 'ready',
    }, vi.fn(() => ({ get: vi.fn(() => scopedRemote) })))
    const sidebarRightTabs = { register: vi.fn(() => () => {}) }
    stubDocument()
    ctx.provide('slots', slots as never)
    ctx.provide('locale', locale as never)
    ctx.provide('remote', rootRemote as never)
    ctx.provide('sessions', sessions as never)
    ctx.provide('sidebarRightTabs', sidebarRightTabs as never)

    apply(ctx as never)
    const canvas = registrations.find(entry => entry.name === 'sidebar.right.pane.tab')
    const injected = canvas?.inject as ((sessionId: string) => { refresh: () => Promise<void> }) | undefined
    expect(injected).toBeDefined()
    const face = injected?.('session-a')
    await face?.refresh()
    expect(scopedRemote.refresh).not.toHaveBeenCalled()
    expect(rootRemote.devflow.refresh).not.toHaveBeenCalled()

    mounted.resolve(async () => undefined)
    await mounted.promise
    await vi.waitFor(() => { expect(scopedRemote.refresh).toHaveBeenCalledWith() })
    expect(rootRemote.devflow.refresh).not.toHaveBeenCalled()
    expect(sessions.scope).toHaveBeenCalledWith('session-a')
    await ctx.fiber.dispose()
    vi.unstubAllGlobals()
  })
})
