/**
 * 第九步 追加修复：会话工作区可能落在**宿主进程 cwd 之外**，而宿主文件系统会把
 * 没有 per-call 政策的写入按"部署默认根"判定 ⇒ 插件直写 `ctx.fs` 被判越界拒绝
 * （实测原文：`file access denied under workspace-write mode`）。
 *
 * 这条用例把那套**判定规则**在测试里如实搭出来（`workspace-write` ⇒ 目标必须
 * 落在 `workspaceRoot` 或临时目录之下，否则拒绝；缺政策 ⇒ 退回部署默认根），
 * 然后断言两件事：
 *  - **不带政策**：真 `DevFlowStore` 的写入被拒（＝线上实测的失败，可反复复现）；
 *  - **带会话政策**：同一写入落在 `<会话工作区>\.devflow`，且**不会**落到部署默认根。
 *
 * 这样这条修复不依赖"重启后碰运气"，而是有一条可执行的回归。用本地替身而不是
 * `dsh-fs-sandbox`：后者不是本插件的依赖（宿主才装），而这里要断言的正是政策
 * 是否**传到了**文件系统边界，替身把这条边界如实表达出来即可。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import type { FsTarget, FsWriteIntent, FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import { afterEach, describe, expect, it } from 'vitest'
import { DevFlowSessionStores, type DevFlowSandboxPolicyResolver } from '../src/host/session-store.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function tempDir(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `devflow-policy-${label}-`))
  roots.push(root)
  return root
}

/** Whether `path` is inside `root` (segment-aware, case-insensitive on Windows). */
function isUnder(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * A filesystem that fences writes the way the host's sandboxing backend does:
 * `workspace-write` requires containment; a missing per-call policy falls back
 * to the deployment root, exactly as `SandboxedFileSystem.checkedTarget` does.
 */
class FencedFileSystem extends LocalFileSystem {
  constructor(ctx: Context, config: { cwd: string }, private readonly deploymentRoot: string) {
    super(ctx, { ...config, diffBasisMaxBytes: 1024 * 1024 })
  }

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: { readonly mode: string; readonly workspaceRoot?: string },
  ): Promise<FsWriteOutcome> {
    const policy = sandboxPolicy ?? { mode: 'workspace-write', workspaceRoot: this.deploymentRoot }
    if (policy.mode === 'workspace-write') {
      // Only the policy's own root confines; there is deliberately NO temp-area
      // allowance here, so the containment under test is the policy root alone.
      const root = policy.workspaceRoot ?? this.deploymentRoot
      if (!isUnder(root, target.displayPath)) {
        throw new Error(`cannot write "${target.displayPath}": file access denied under workspace-write mode`)
      }
    }
    return await super.writeText(target, content, expected, signal)
  }
}

describe('第九步 会话工作区写在宿主 cwd 之外', () => {
  it('stamps the calling session policy, and the fenced write lands in the project workspace', async () => {
    const hostRoot = await tempDir('host')
    const projectWorkspace = await tempDir('project')
    const ctx = new Context()
    // The production condition: the deployment fallback root is the HOST cwd,
    // while the project workspace (the session cwd) lives elsewhere.
    new FencedFileSystem(ctx, { cwd: hostRoot }, hostRoot)
    const agent = {
      id: 'session-bound',
      session: { id: 'session-bound', header: { cwd: projectWorkspace } },
    } as unknown as Agent

    // 1) WITHOUT the policy the store's own write is refused — the production
    //    failure, reproduced deterministically (the deployment fallback root is
    //    the host cwd, and the project workspace is not under it).
    const loose = new DevFlowSessionStores(ctx.fs, './.devflow')
    const looseScope = loose.resolve(agent)
    await expect(looseScope.store.saveProject({
      id: 'p', name: 'P', goal: 'g', currentStage: '', createdAt: 'a', updatedAt: 'b',
    })).rejects.toThrow(/file access denied under workspace-write mode/)

    // 2) WITH the policy resolver wired in, the same store writes into the
    //    project's own workspace and never into the deployment fallback root.
    const policyOf: DevFlowSandboxPolicyResolver = caller => {
      const session = (caller as { session?: { header?: { cwd?: string } } } | undefined)?.session
      const cwd = session?.header?.cwd
      return cwd === undefined ? undefined : { mode: 'workspace-write', workspaceRoot: cwd }
    }
    const wired = new DevFlowSessionStores(ctx.fs, './.devflow', undefined, policyOf)
    const scope = wired.resolve(agent)
    expect(scope.storeRoot).toBe(join(projectWorkspace, '.devflow'))
    await scope.store.saveProject({
      id: 'project-in-workspace', name: 'Project', goal: 'g', currentStage: '', createdAt: 'a', updatedAt: 'b',
    })
    expect((await scope.store.loadProject())?.id).toBe('project-in-workspace')

    const written = JSON.parse(
      await readFile(join(projectWorkspace, '.devflow', 'project.json'), 'utf8'),
    ) as { id: string }
    expect(written.id).toBe('project-in-workspace')
    // The deployment fallback root was NOT used: no `.devflow` appeared there.
    await expect(readFile(join(hostRoot, '.devflow', 'project.json'), 'utf8')).rejects.toThrow()
    expect(sep).toBeDefined()
  })

  /**
   * 回归：政策解析必须拿到**真会话**。
   *
   * 宿主 `SandboxPolicyService.resolve({ session })` 会读会话自身的投影
   * （`overrideOf` ⇒ `sessionProjections.stateOf(session, …)`），所以一个"合成
   * 的会话对象"会让它抛 `session.snapshotEvents is not a function`（线上实测
   * 就是这个错）。这条用例把宿主那次访问建模成"必须存在的方法"，并断言
   * DevFlow 侧只传真会话——包括 store 建立之后的第二次写入。
   */
  it('never hands the host a synthesized session when resolving the write policy', async () => {
    const hostRoot = await tempDir('host2')
    const projectWorkspace = await tempDir('project2')
    const ctx = new Context()
    new FencedFileSystem(ctx, { cwd: hostRoot }, hostRoot)

    /** A real session stand-in: the projection read the host performs works. */
    let projectionReads = 0
    const sessionStand = {
      id: 'session-real',
      header: { cwd: projectWorkspace },
      snapshotEvents: (): readonly unknown[] => { projectionReads += 1; return [] },
    }
    const agent = { id: 'session-real', session: sessionStand } as unknown as Agent

    const wired = new DevFlowSessionStores(ctx.fs, './.devflow', undefined, caller => {
      const session = (caller as { session?: { snapshotEvents?: unknown } } | undefined)?.session
      if (session === undefined) return undefined
      // Exactly what the host does with the session it is handed.
      if (typeof session.snapshotEvents !== 'function') {
        throw new Error('session.snapshotEvents is not a function')
      }
      ;(session.snapshotEvents as () => unknown)()
      return { mode: 'workspace-write', workspaceRoot: projectWorkspace }
    })

    const scope = wired.resolve(agent)
    await scope.store.saveProject({
      id: 'p2', name: 'P2', goal: 'g', currentStage: '', createdAt: 'a', updatedAt: 'b',
    })
    // A second write exercises the already-resolved store, where a fabricated
    // carrier would have replaced the real session.
    await scope.store.updateScope({
      summary: 's', inScope: ['i'], maxModifiedFiles: 1, maxToolSteps: 1, completionCriteria: ['c'],
    })
    expect(projectionReads).toBeGreaterThan(0)
    expect((await scope.store.loadProject())?.id).toBe('p2')
  })
})
