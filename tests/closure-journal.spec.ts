/**
 * 第六步任务 2 取证：**真实收尾**确实在 journal 留痕（隔离根，零副作用）。
 *
 * 为什么这样取证而不是去关一条真实记录：
 *  - `appendClosure` 的写入方就是 `updateAssignmentStatus` / `updateExecutionStatus`
 *    这两个方法本身，**没有任何别的路径能绕过它们**；所以在这两个方法上取证，
 *    等价于在真实收尾上取证，而不是"等价物"。
 *  - 真实 `.devflow` 里的陈旧记录属**业务数据**：关掉它们会改变真实状态，且那些
 *    记录正是第四步段三回填的证据载体。取证不需要付这个代价。
 *
 * 本用例用**真的** `DevFlowStore`（真写 assignment / execution / journal 文件），
 * 覆盖两件事：
 *  1. 转入 `closed` ⇒ 追加专用 close 事件（`orchestration/close` / `execution/close`）；
 *  2. 转入**非** closed 的状态 ⇒ **不**追加（否则审计轨会被噪声淹没）。
 * 并断言这两条事件确实被 state 折叠消费（段一交付的事件类型终于有真实生产者）。
 */
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { DevFlowStore } from '../src/host/storage.ts'
import { initialDevFlowState } from '../src/host/state.ts'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** A real store writing real files under a temp root. */
async function store() {
  const root = await mkdtemp(join(tmpdir(), 'devflow-closure-'))
  roots.push(root)
  const devflow = new DevFlowStore(
    new LocalFileSystem(new Context(), { cwd: root, diffBasisMaxBytes: 1024 * 1024 }),
    './.devflow',
  )
  return { root, store: devflow, journalDir: join(root, '.devflow', 'journal') }
}

/** Every journal record of one type, read back from the files the store wrote. */
async function recordsOfType(journalDir: string, type: string) {
  let names: string[] = []
  try { names = await readdir(journalDir) } catch { return [] }
  const out: Record<string, unknown>[] = []
  for (const name of names) {
    if (name === 'head.json' || !name.endsWith('.json')) continue
    const parsed = JSON.parse(await readFile(join(journalDir, name), 'utf8')) as Record<string, unknown>
    if (parsed.type === type) out.push(parsed)
  }
  return out
}

describe('收尾留痕：变更终结态时写入专用 close 事件', () => {
  it('closes one assignment and one execution, and journals both closures', async () => {
    const env = await store()
    // Real records, created through the store's own public API.
    const assignment = await env.store.createAssignment({
      taskId: 'task-closure', phaseId: 'phase-closure', agentId: 'backend-engineer',
      role: 'backend-engineer', status: 'assigned',
    })
    const execution = await env.store.createExecutionRecord({
      batchId: '00000000-0000-4000-8000-0000000000c1',
      assignmentId: assignment.assignmentId,
      agentId: 'backend-engineer',
      taskId: 'task-closure',
    })

    expect(await recordsOfType(env.journalDir, 'devflow/orchestration/close')).toHaveLength(0)
    expect(await recordsOfType(env.journalDir, 'devflow/execution/close')).toHaveLength(0)

    const closedAssignment = await env.store.updateAssignmentStatus(assignment.assignmentId, 'closed', 'stale-lost')
    const closedExecution = await env.store.updateExecutionStatus(execution.executionId, 'closed', 'stale-lost')

    // The records themselves carry the closure (existing semantics untouched).
    expect(closedAssignment).toMatchObject({ status: 'closed', closeReason: 'stale-lost' })
    expect(closedExecution).toMatchObject({ status: 'closed', closeReason: 'stale-lost' })

    // And each closure left exactly one dedicated audit record on disk.
    const assignmentClosures = await recordsOfType(env.journalDir, 'devflow/orchestration/close')
    const executionClosures = await recordsOfType(env.journalDir, 'devflow/execution/close')
    expect(assignmentClosures).toHaveLength(1)
    expect(executionClosures).toHaveLength(1)
    expect(assignmentClosures[0]?.data).toMatchObject({
      assignmentId: assignment.assignmentId,
      closeReason: 'stale-lost',
      at: closedAssignment.closedAt,
    })
    expect(executionClosures[0]?.data).toMatchObject({
      executionId: execution.executionId,
      closeReason: 'stale-lost',
      at: closedExecution.closedAt,
    })

    // Evidence mode (DEVFLOW_DUMP_CLOSURE=1): print the records exactly as they
    // were written, so the report can quote real bytes instead of paraphrasing.
    if (process.env.DEVFLOW_DUMP_CLOSURE === '1') {
      process.stdout.write(`DEVFLOW_CLOSURE_DUMP ${JSON.stringify({
        orchestration: assignmentClosures[0], execution: executionClosures[0],
      }, null, 2)}\n`)
    }
  })

  it('journals no closure for a transition that is not a close', async () => {
    const env = await store()
    const assignment = await env.store.createAssignment({
      taskId: 'task-move', phaseId: 'phase-move', agentId: 'frontend-engineer',
      role: 'frontend-engineer', status: 'assigned',
    })
    const moved = await env.store.updateAssignmentStatus(assignment.assignmentId, 'in_progress')
    expect(moved.status).toBe('in_progress')
    // A non-terminal transition must stay silent, or the audit trail stops being
    // a record of terminal facts and becomes a second copy of the status log.
    expect(await recordsOfType(env.journalDir, 'devflow/orchestration/close')).toHaveLength(0)
  })

  it('feeds the closure into the durable read model through the same fold', async () => {
    const env = await store()
    const assignment = await env.store.createAssignment({
      taskId: 'task-fold', phaseId: 'phase-fold', agentId: 'code-auditor',
      role: 'reviewer', status: 'assigned',
    })
    await env.store.updateAssignmentStatus(assignment.assignmentId, 'closed', 'abandoned')

    // The fold is the reader every surface shares; proving it here proves the
    // producer and the consumer agree, not merely that a file appeared.
    const state = await env.store.loadState()
    expect(state.assignments[assignment.assignmentId]).toMatchObject({
      status: 'closed', closeReason: 'abandoned',
    })
    expect(initialDevFlowState().assignments).toEqual({})
  })
})
