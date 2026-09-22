import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { describe, expect, it, vi } from 'vitest'
import { DevFlowStore } from '../src/host/storage.ts'
import { DevFlowAuditPager, DEVFLOW_AUDIT_CANDIDATE_SCAN_LIMIT, toSafeAuditItem } from '../src/host/client-audit.ts'

function makeStore(root: string): DevFlowStore {
  return new DevFlowStore(new LocalFileSystem(new Context(), { cwd: root, diffBasisMaxBytes: 1024 * 1024 }), './.devflow')
}

async function appendEntries(store: DevFlowStore, count: number): Promise<void> {
  for (let index = 0; index < count; index++) {
    await store.appendJournal('devflow/task/transition', {
      taskId: `task-${index}`, title: `Task ${index}`, from: 'planned', to: index === 0 ? 'completed' : 'executing', at: `2026-08-29T10:${String(index % 60).padStart(2, '0')}:00.000Z`,
    })
  }
}

describe('P1A bounded audit storage and adapter', () => {
  it('reads a direct bounded sequence page without listJournal and pins later pages to the captured head', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devflow-audit-page-'))
    try {
      const store = makeStore(root)
      await appendEntries(store, 250)
      const list = vi.spyOn(store, 'listJournal')
      const first = await store.readCommittedJournalSequencePage(undefined, undefined, 20)
      expect(first.entries).toHaveLength(20)
      expect(first.scannedCount).toBe(20)
      expect(first.entries[0]?.sequence).toBe(249)
      expect(first.entries.at(-1)?.sequence).toBe(230)
      expect(list).not.toHaveBeenCalled()
      await store.appendJournal('devflow/task/transition', { taskId: 'new-task', title: 'New', from: 'planned', to: 'executing', at: '2026-08-30T00:00:00.000Z' })
      const second = await store.readCommittedJournalSequencePage(first.capturedHeadSequence, first.nextExclusiveSequence ?? 0, 20)
      expect(second.capturedHeadSequence).toBe(first.capturedHeadSequence)
      expect(second.entries[0]?.sequence).toBe(229)
      expect(second.entries.at(-1)?.sequence).toBe(210)
      expect(list).not.toHaveBeenCalled()
    } finally { await rm(root, { recursive: true, force: true }) }
  }, 15_000)

  it('caps filter scans rather than degrading to a full journal read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devflow-audit-scan-'))
    try {
      const store = makeStore(root)
      await appendEntries(store, DEVFLOW_AUDIT_CANDIDATE_SCAN_LIMIT + 30)
      const scan = await store.readCommittedJournalSequencePage(undefined, undefined, DEVFLOW_AUDIT_CANDIDATE_SCAN_LIMIT)
      expect(scan.scannedCount).toBe(DEVFLOW_AUDIT_CANDIDATE_SCAN_LIMIT)
      expect(scan.nextExclusiveSequence).toBe(30)
    } finally { await rm(root, { recursive: true, force: true }) }
  }, 15_000)

  it('builds allowlisted safe pages with opaque context-bound cursors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devflow-audit-contract-'))
    try {
      const store = makeStore(root)
      await store.saveProject({ id: 'project-a', name: 'Audit', goal: 'safe', currentStage: 'M7', createdAt: '2026-08-29T00:00:00.000Z', updatedAt: '2026-08-29T00:00:00.000Z' })
      await appendEntries(store, 25)
      await store.appendJournal('devflow/agent/update-config', { agentId: 'agent-a', patch: { prompt: 'system prompt token=secret' }, at: '2026-08-29T11:00:00.000Z' })
      // The page's range is built from `now`, NOT from a literal date: the store stamps
      // every journal entry with the REAL clock (`appendJournalUnlocked` writes
      // `new Date().toISOString()`), so a fixed window silently empties the page once the
      // calendar moves past it — which is exactly how this case stayed red. The window
      // below is anchored to the run, so everything THIS test writes is inside it.
      const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      const to = new Date(Date.now() + 1_000).toISOString()
      const pager = new DevFlowAuditPager(store)
      const first = await pager.page({ filter: { kind: 'project' }, range: { from, to } })
      expect(first.kind).toBe('page')
      if (first.kind !== 'page') throw new Error('expected page')
      // The WINNING range is normalized and echoed, so the window really was the input.
      expect(first.page.range).toEqual({ from, to })
      expect(first.page.items).toHaveLength(20)
      expect(first.page.nextCursor).toEqual(expect.any(String))
      expect(first.page.nextCursor).not.toContain('project-a')
      expect(first.page.omittedUnsafeCount).toBe(1)
      expect(JSON.stringify(first)).not.toContain('system prompt')
      expect(JSON.stringify(first)).not.toContain('secret')
      const invalid = await pager.page({ cursor: `${first.page.nextCursor}tampered` })
      expect(invalid).toEqual({ kind: 'error', error: { code: 'cursor-invalid', message: 'DevFlow audit history changed. Refresh to try again.' } })
      const next = await pager.page({ cursor: first.page.nextCursor! })
      expect(next.kind).toBe('page')
      if (next.kind === 'page') expect(next.page.items.map(item => item.sequence)).toEqual([4, 3, 2, 1, 0])
    } finally { await rm(root, { recursive: true, force: true }) }
  }, 15_000)

  it('applies BOTH ends of the range instead of passing any window through', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devflow-audit-range-'))
    try {
      const store = makeStore(root)
      await store.saveProject({ id: 'project-a', name: 'Range', goal: 'safe', currentStage: 'M7', createdAt: '2026-08-29T00:00:00.000Z', updatedAt: '2026-08-29T00:00:00.000Z' })
      await appendEntries(store, 3)
      const pager = new DevFlowAuditPager(store)
      const filter = { kind: 'project' } as const
      // Every entry was written on the real clock, so a window anchored to now holds
      // all of them...
      const inside = await pager.page({ filter, range: {
        from: new Date(Date.now() - 60_000).toISOString(),
        to: new Date(Date.now() + 1_000).toISOString(),
      } })
      expect(inside.kind).toBe('page')
      if (inside.kind === 'page') expect(inside.page.items).toHaveLength(3)
      // ...a window that ENDS before the run wrote anything holds none of them (the
      // upper bound is enforced, not ignored)...
      const beforeRun = await pager.page({ filter, range: { from: '2000-01-01T00:00:00.000Z', to: '2000-01-02T00:00:00.000Z' } })
      expect(beforeRun.kind).toBe('page')
      if (beforeRun.kind === 'page') expect(beforeRun.page.items).toHaveLength(0)
      // ...and a window that STARTS after the run excludes them too (the lower bound).
      const afterRun = await pager.page({ filter, range: {
        from: new Date(Date.now() + 60_000).toISOString(),
        to: new Date(Date.now() + 120_000).toISOString(),
      } })
      expect(afterRun.kind).toBe('page')
      if (afterRun.kind === 'page') expect(afterRun.page.items).toHaveLength(0)
    } finally { await rm(root, { recursive: true, force: true }) }
  }, 15_000)

  it('fails closed on sensitive report text and keeps completed separate from accepted', () => {
    const report = toSafeAuditItem({ sequence: 1, id: '00000000-0000-4000-8000-000000000001', type: 'devflow/agent/report/create', at: '2026-08-29T10:00:00.000Z', data: { report: { reportId: 'report-a', executionId: 'execution-a', agentId: 'agent-a', status: 'failed', summary: 'C:\\Users\\me\\secret token=abc', outputReference: 'C:\\raw' } } })
    expect(report?.summary).toEqual({ text: 'Sensitive content is hidden.', truncated: false, redacted: true })
    const completed = toSafeAuditItem({ sequence: 2, id: '00000000-0000-4000-8000-000000000002', type: 'devflow/task/transition', at: '2026-08-29T10:00:00.000Z', data: { taskId: 'task-a', title: 'Task', from: 'reviewing', to: 'completed', at: '2026-08-29T10:00:00.000Z' } })
    const accepted = toSafeAuditItem({ sequence: 3, id: '00000000-0000-4000-8000-000000000003', type: 'devflow/bridge/import', at: '2026-08-29T10:00:00.000Z', data: { taskId: 'task-a', resultId: 'result-a', protocolVersion: '1', verdict: 'accepted', at: '2026-08-29T10:00:00.000Z' } })
    expect(completed?.status).toBe('completed')
    expect(completed?.status).not.toBe('accepted')
    expect(accepted?.status).toBe('accepted')
  })

  it('fails closed when a committed entry is missing inside a bounded page', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devflow-audit-corrupt-'))
    try {
      const journal = join(root, '.devflow', 'journal')
      await mkdir(journal, { recursive: true })
      await writeFile(join(journal, 'head.json'), JSON.stringify({ nextSequence: 1 }))
      const store = makeStore(root)
      await expect(store.readCommittedJournalSequencePage(undefined, undefined, 20)).rejects.toThrow('committed journal entry is unavailable')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
