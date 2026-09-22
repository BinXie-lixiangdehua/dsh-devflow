/**
 * Session-scoped `.devflow` store resolution (第九步 · 项目隔离).
 *
 * The store root used to be one process-wide constant, so every project session
 * on the machine shared one `.devflow` — one task list, one roster, one "memory".
 * This module derives the root from the CALLING SESSION'S WORKSPACE instead:
 * `<session cwd>/.devflow`, so project A and project B cannot see each other.
 *
 * Three rules carry the product decision:
 *
 * 1. **Derived from the session workspace.** The session cwd is the only input.
 *    It is read from `agent.session.header.cwd` — the same durable session fact
 *    the Harness filesystem tools resolve relative paths against.
 * 2. **Session-level lock.** The first resolution for a session PINS its root.
 *    A later workspace change inside the same session does not re-point the
 *    store: a session keeps talking to the project it started on (decision 4).
 * 3. **Never a silent fallback.** A session with no workspace facts does not
 *    quietly inherit the shared library. It throws
 *    {@link DevFlowSessionScopeError}, and the caller surfaces that refusal —
 *    an unisolated read must never look like a successful isolated one.
 *
 * The pre-existing mixed library (`<host cwd>/.devflow`) is deliberately still
 * readable and untouched: nothing is moved, split, deleted, or re-attributed
 * (decision 3). No session is served from it, though — unlike before 第九步, a
 * session that cannot name its workspace is refused rather than pointed at it.
 * @module @xiaoxie-ide/dsh-devflow/session-store
 */

import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { DevFlowStore } from './storage.ts'

/** The state directory name created inside one session workspace. */
export const DEVFLOW_STATE_DIR_NAME = '.devflow'

/**
 * Stable machine-readable code for "this session has no usable workspace".
 *
 * It is a code rather than free text because it crosses the tool boundary and
 * the panel: the point of the refusal is that the caller can SEE that the
 * session was not isolated.
 */
export const DEVFLOW_SESSION_SCOPE_UNAVAILABLE = 'DEVFLOW_SESSION_SCOPE_UNAVAILABLE'

/** The refusal raised when a session cannot be scoped to its own workspace. */
export class DevFlowSessionScopeError extends Error {
  readonly code = DEVFLOW_SESSION_SCOPE_UNAVAILABLE
  /** The session that could not be scoped, or `(no agent)` for a caller-less call. */
  readonly sessionId: string
  /** What was missing, in plain terms. */
  readonly detail: string

  constructor(sessionId: string, detail: string) {
    super(
      `devflow: ${DEVFLOW_SESSION_SCOPE_UNAVAILABLE}: session ${sessionId} has no workspace to derive `
      + `\`.devflow\` from (${detail}); refusing to fall back to the shared library because that would `
      + 'report a shared project as an isolated one.',
    )
    this.name = 'DevFlowSessionScopeError'
    this.sessionId = sessionId
    this.detail = detail
  }
}

/** One resolved session scope: the store plus the identity the panel must show. */
export interface DevFlowSessionScope {
  /** The store bound to this session's workspace. */
  readonly store: DevFlowStore
  /** Session identity this scope was resolved for. */
  readonly sessionId: string
  /**
   * The workspace directory this session is pinned to.
   *
   * It is the identity the panel names, and it is read from the PINNED binding:
   * a session whose observed cwd later moves keeps reporting the workspace it
   * actually writes to, never the one it merely happens to be observed in.
   */
  readonly workspacePath: string | null
  /** The `.devflow` root every read and write of this scope goes through. */
  readonly storeRoot: string
  /**
   * Opaque key identifying this store on the committed-write channel. Two
   * sessions in one workspace share it; two projects never do.
   */
  readonly sessionKey: string
}

/** The read end of the resolver as consumers see it. */
export type DevFlowSessionScopeResolver = (agent: Agent | undefined) => DevFlowSessionScope

/**
 * Resolve the sandbox policy a session's OWN workspace writes must carry.
 *
 * 第九步 把 store 根放进会话工作区，而工作区可能在**宿主进程 cwd 之外**。
 * 宿主文件系统在缺少 per-call 政策时退回"部署默认"（部署 mode + 默认
 * workspace root），于是插件直写 `ctx.fs` 被判越界而拒（实测原文：
 * `file access denied under workspace-write mode`）。会话自己的政策里
 * `workspaceRoot = session.header.cwd`，带上它才是"写进本会话工作区"的正确
 * 表述——这不是放宽限制，而是把限制指向本该指向的那棵树。
 *
 * `agent` 为 undefined（无调用者的程序化写入）时返回 `undefined`，让宿主沿用
 * 它自己的默认判定：没有会话就没有可声明的边界，不替它做主。
 */
export type DevFlowSandboxPolicyResolver = (
  agent: Agent | undefined,
) => { readonly mode: string; readonly workspaceRoot: string } | undefined

/** Read the durable session cwd off one live Agent, if it has one. */
function workspaceOf(agent: Agent | undefined): string | undefined {
  // Read structurally: a programmatic caller may hand over an Agent-shaped
  // object with no session at all, and that is a refusal case (no workspace),
  // never a crash on a path that only wants to answer "is there one?".
  const session = (agent as { session?: { header?: { cwd?: unknown } } } | undefined)?.session
  const cwd: unknown = session?.header?.cwd
  return typeof cwd === 'string' && cwd.trim() !== '' ? cwd : undefined
}

/** Read the session id off one live Agent, if it has one. */
function sessionIdOf(agent: Agent | undefined): string {
  const direct = (agent as { id?: unknown } | undefined)?.id
  const session = (agent as { session?: { id?: unknown } } | undefined)?.session
  const id: unknown = session?.id ?? direct
  return typeof id === 'string' && id !== '' ? id : '(unknown session)'
}

/**
 * Derive a new project's NAME from the session workspace directory.
 *
 * A project created inside `D:\Desktop\贪吃蛇` is the 贪吃蛇 project, so its name
 * is that directory's last segment. Naming every project `DevFlow` made the
 * panel read "本项目 DevFlow @ 贪吃蛇" — a name that contradicts the workspace it
 * sits in — and it is the one string an operator reads first.
 *
 * The rule is total, and both project-creation paths use THIS function so the
 * two can never drift apart:
 *
 * - trailing separators are ignored (`D:\a\b\` ⇒ `b`);
 * - a path whose last segment is empty (a drive or filesystem root, `C:\` or
 *   `/`) falls back to the path's own last non-empty segment (`C:` / `/`), and
 *   the report records that branch;
 * - a path with no usable segment at all returns the workspace verbatim rather
 *   than an invented label: an unrecognizable name is still not a WRONG name.
 *
 * An unresolvable workspace never reaches here — that case is already refused by
 * {@link deriveSessionStoreRoot} with `DEVFLOW_SESSION_SCOPE_UNAVAILABLE`, and
 * this function deliberately does NOT reintroduce a hard-coded fallback name.
 * @param workspace - the resolved session workspace directory.
 * @returns the new project's name.
 */
export function deriveProjectNameFromWorkspace(workspace: string): string {
  const segments = workspace.split(/[\\/]+/).filter(segment => segment !== '')
  const last = segments[segments.length - 1]
  if (last !== undefined && last.trim() !== '') return last
  const rootSegment = workspace.split(/[\\/]+/).find(segment => segment !== '')
  return rootSegment ?? workspace
}

/**
 * The name and goal a NEWLY created project starts with.
 *
 * `goal` is deliberately EMPTY: the previous placeholder (`'DevFlow'`) was a
 * meaningless word that read as a real objective and misled the Commander's
 * direction judgement. "未设定" is the honest state, and an empty string says
 * exactly that — no placeholder is written in its place.
 * @param workspace - the session workspace the project is being created in.
 * @returns the new project's name and empty goal.
 */
export function deriveNewProjectIdentity(workspace: string): { readonly name: string; readonly goal: string } {
  return { name: deriveProjectNameFromWorkspace(workspace), goal: '' }
}

/**
 * Derive one session's `.devflow` root.
 *
 * A session with no workspace fact has NO project of its own, and this is the
 * one place that decides so: it throws rather than answering with the retained
 * mixed library. That is the whole point of 第九步 — a shared answer dressed as
 * an isolated one is worse than a refusal, because nobody can tell them apart.
 *
 * Kept separate (and exported) so the rule is testable on its own and so the
 * refusal message has exactly one home.
 * @param workspace - the session's workspace directory, when it has one.
 * @param defaultRoot - the retained mixed-library root. It is reported for
 *   diagnostics and is deliberately NOT a fallback: it is never returned here.
 * @param sessionId - the session id, for the refusal message.
 * @returns the `.devflow` root inside this session's workspace.
 * @throws DevFlowSessionScopeError when the session carries no workspace.
 */
export function deriveSessionStoreRoot(
  workspace: string | undefined,
  defaultRoot: string,
  sessionId: string,
): string {
  if (workspace === undefined) {
    throw new DevFlowSessionScopeError(
      sessionId,
      'the session header carries no workspace (cwd), so no project can be derived',
    )
  }
  if (workspace.trim() === '') {
    throw new DevFlowSessionScopeError(sessionId, 'the session workspace path is empty')
  }
  void defaultRoot
  return join(workspace, DEVFLOW_STATE_DIR_NAME)
}

/**
 * Resolve and cache one {@link DevFlowStore} per session workspace.
 *
 * The resolver is a plain object rather than a service: it owns no protocol and
 * no lifecycle, and every consumer already receives it explicitly, so a second
 * Cordis service would be a second place for the same fact to live.
 */
export class DevFlowSessionStores {
  /** Session id → the root pinned for it (the session-level lock). */
  private readonly boundRoots = new Map<string, string>()
  /** Session id → the workspace directory that root was derived from. */
  private readonly boundWorkspaces = new Map<string, string | null>()
  /** Store root → the one store instance for it, so caches and journal gates are shared. */
  private readonly storeByRoot = new Map<string, DevFlowStore>()

  /**
   * @param fs - the filesystem seam every store goes through.
   * @param defaultRoot - the retained mixed-library root (`./.devflow`, i.e. the
   *   host process cwd). Reported for diagnostics only: it is never used to
   *   serve a session.
   * @param onChange - committed-write observer, called with the observing
   *   store's session key so the live channel can address one project's frames.
   * @param sandboxPolicyOf - the calling session's sandbox policy, stamped on
   *   every write so a store inside the session's own workspace is written AS a
   *   session workspace write (see {@link DevFlowSandboxPolicyResolver}).
   */
  constructor(
    private readonly fs: ConstructorParameters<typeof DevFlowStore>[0],
    private readonly defaultRoot: string,
    private readonly onChange?: (
      sessionKey: string,
      relativePath: string,
      sequence?: number,
      record?: { readonly type: string; readonly data: unknown; readonly at: string },
    ) => void,
    private readonly sandboxPolicyOf?: DevFlowSandboxPolicyResolver,
  ) {}

  /** The retained mixed-library root, as configured. Never a session's root. */
  get mixedLibraryRoot(): string {
    return this.defaultRoot
  }

  /** Every root this run has actually opened, for diagnostics and reports. */
  get openedRoots(): readonly string[] {
    return [...this.storeByRoot.keys()]
  }

  /**
   * Resolve the store for one calling session, pinning the session's root on
   * first use.
   *
   * A caller with no Agent at all (a programmatic tool call) is refused rather
   * than defaulted: there is no session to isolate, so there is no honest
   * answer that is not a guess.
   * @param agent - the calling Agent, when the runtime supplied one.
   * @returns the session's store and identity.
   * @throws DevFlowSessionScopeError when the caller has no session, or the
   *   session carries no workspace to derive a project from.
   */
  resolve(agent: Agent | undefined): DevFlowSessionScope {
    if (agent === undefined) {
      throw new DevFlowSessionScopeError('(no agent)', 'the tool call carried no calling agent')
    }
    const sessionId = sessionIdOf(agent)
    const pinned = this.boundRoots.get(sessionId)
    // The lock: once pinned, the session keeps its project even if its cwd is
    // observed elsewhere afterwards. The live Agent still rides along so an
    // already-cached store can be created with a real session to derive its
    // sandbox policy from.
    if (pinned !== undefined) {
      return this.scopeOf(pinned, this.boundWorkspaces.get(sessionId) ?? null, sessionId, agent)
    }
    const workspace = workspaceOf(agent)
    const root = deriveSessionStoreRoot(workspace, this.defaultRoot, sessionId)
    // Pin BEFORE any await: two concurrent first calls in one session must not
    // race into two different roots.
    this.boundRoots.set(sessionId, root)
    this.boundWorkspaces.set(sessionId, workspace ?? null)
    return this.scopeOf(root, workspace ?? null, sessionId, agent)
  }

  /**
   * The workspace a session is currently pinned to, without resolving a store.
   * @param sessionId - the session to look up.
   * @returns the pinned root, or undefined when the session never resolved one.
   */
  pinnedRoot(sessionId: string): string | undefined {
    return this.boundRoots.get(sessionId)
  }

  /** Build (or reuse) the store for one pinned root. */
  private scopeOf(root: string, workspacePath: string | null, sessionId: string, agent?: Agent): DevFlowSessionScope {
    let store = this.storeByRoot.get(root)
    if (store === undefined) {
      const sessionKey = root
      // The policy is read from a session whose workspace this root IS. The
      // caller's own Agent is the only such session available — a synthesized
      // one is not acceptable, because the host reads session state off it
      // (`overrideOf` walks the session's projections), and a fabricated object
      // has none. `resolve` always has the real Agent, so the binding below is
      // taken there; a scope rebuilt later without one simply states no policy
      // and lets the backend apply its own default.
      const boundAgent = agent
      store = new DevFlowStore(
        this.fs,
        root,
        this.onChange === undefined
          ? undefined
          : (relativePath, sequence, record) => this.onChange?.(sessionKey, relativePath, sequence, record),
        this.sandboxPolicyOf === undefined || boundAgent === undefined
          ? undefined
          : () => this.sandboxPolicyOf?.(boundAgent),
      )
      this.storeByRoot.set(root, store)
    }
    return { store, sessionId, workspacePath, storeRoot: root, sessionKey: root }
  }
}
