/**
 * Test scaffolding for the session-scoped `.devflow` resolver.
 *
 * The host derives each session's store from its workspace (第九步 项目隔离).
 * Most unit tests are not about that decision: they exercise one store's
 * behaviour and therefore need the resolver to answer with exactly that store.
 * `testScopeResolver` states that explicitly — the same way the production
 * single-store composition does — instead of relying on a silent default.
 *
 * It lives under `tests/` on purpose: it is test scaffolding, never shipped.
 * @module devflow-tests/session-scope
 */

import type { DevFlowSessionScope, DevFlowSessionScopeResolver } from '../src/host/session-store.ts'
import type { DevFlowStore } from '../src/host/storage.ts'

/** The store surface a snapshot read needs; a fake store satisfies it structurally. */
type ScopeStore = DevFlowSessionScope['store']

/**
 * A resolver that always answers with one fixed store scope.
 * @param store - the store (or structurally compatible fake) every read uses.
 * @param options - the identity to report: session id, workspace path, and root.
 * @returns a resolver with no isolation behavior of its own.
 */
export function testScopeResolver(
  store: ScopeStore,
  options: {
    readonly sessionId?: string
    readonly workspacePath?: string | null
    readonly storeRoot?: string
  } = {},
): DevFlowSessionScopeResolver {
  const storeRoot = options.storeRoot ?? (store instanceof Object && 'rootPath' in store ? String((store as DevFlowStore).rootPath) : './.devflow')
  const scope: DevFlowSessionScope = {
    store,
    sessionId: options.sessionId ?? 'test-session',
    workspacePath: options.workspacePath ?? null,
    storeRoot,
    sessionKey: storeRoot,
  }
  return () => scope
}

/**
 * A read-only store facade over an in-memory read model.
 *
 * A snapshot read used to be handed its state by a stubbed `refreshState`; now
 * it reads the CALLING SESSION's store, so a unit test that owns a literal
 * state object supplies it here instead. Only the read methods a snapshot calls
 * are provided — there is no write path, so this fake cannot silently become a
 * second state source.
 * @param state - the `.devflow` read model the snapshot must project.
 * @param tasks - the task list the store reports.
 * @returns a structurally compatible store facade.
 */
export function testReadStore(
  state: unknown,
  tasks: readonly unknown[] = [],
  results: readonly unknown[] = [],
): ScopeStore {
  return {
    rootPath: './.devflow',
    loadState: async () => state,
    listTasks: async () => tasks,
    listResults: async () => results,
  } as unknown as ScopeStore
}
