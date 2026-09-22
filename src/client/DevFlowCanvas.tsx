import { useEffect, useId, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  DevFlowClientActivationFailure,
  DevFlowClientAuditFilter,
  DevFlowClientAuditItem,
  DevFlowClientDecision,
  DevFlowClientDecisionRequest,
  DevFlowClientSession,
} from '../contract.ts'
import { FlowCanvas } from './FlowCanvas.tsx'
import type { DevFlowClientBlocked } from '../contract.ts'
import type {
  DevFlowConnectionState,
  DevFlowClientAuditLoadState,
  DevFlowClientLoadState,
  DevFlowInspectorTab,
  DevFlowLiveController,
  DevFlowSnapshotController,
} from './store.ts'
import {
  equalCurrentSessionToolsState,
  mapCurrentSessionTools,
  type CurrentSessionToolsState,
  type SafeOfficialToolActivity,
} from './tool-activity.ts'
import {
  PROJECT_SELECTION,
  auditFilterForSelection,
  createWorkspaceModel,
  selectionExists,
  selectionLabel,
  selectionParent,
  shortId,
  type WorkspaceModel,
  type WorkspaceSelection,
} from './workspace.ts'

interface DevFlowCanvasInjected {
  readonly hooks: { readonly devflow: DevFlowSnapshotController; readonly audit?: { readonly getSnapshot: () => DevFlowClientAuditLoadState; readonly subscribe: (listener: () => void) => () => void }; readonly live?: DevFlowLiveController }
  readonly refresh: () => Promise<void>
  readonly audit?: {
    readonly ensure: (filter: DevFlowClientAuditFilter, scopeKey?: string) => Promise<void>
    readonly refresh: () => Promise<void>
    readonly loadMore: () => Promise<void>
    readonly retry: () => Promise<void>
  }
  readonly getInspectorTab: () => DevFlowInspectorTab
  readonly setInspectorTab: (tab: DevFlowInspectorTab) => void
  /** §二·3: the only way back in after the overview float was closed. */
  readonly reopenOverview?: () => void
}

type Props = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'devflow'> & InjectFace<DevFlowCanvasInjected>
type InspectorTab = DevFlowInspectorTab
const INSPECTOR_TABS: readonly InspectorTab[] = ['flow', 'audit', 'tools']

/**
 * Fixed readable phrase per refusal phase, mirroring the Host's own vocabulary
 * so the panel and `/devflow commander status` name the same act the same way.
 */
const ACTIVATION_PHASE_LABELS: Record<string, string> = {
  initial: '首次激活',
  recompose: '切换 preset',
  deactivate: '撤销激活',
  restore: '回滚恢复',
  journal: '留痕写入',
}

/**
 * The one readable conclusion for a recorded activation refusal.
 *
 * The banner's old headline was the raw refusal code, which reads as an internal
 * identifier rather than as an answer: an operator who saw
 * `devflow-activation-verification-failed` once read it as an employee id. The
 * code stays in the DOM (it is the one string that can be quoted into a report),
 * but it is no longer the sentence that carries the meaning.
 *
 * Only two conclusions are drawn, both from data the Host verified:
 *
 *  - `session` `bound` ⇒ the refusal was absorbed by the bounded settle retry and
 *    this session is live now, so the banner says so and points at the readable
 *    verdict rather than at the code;
 *  - anything else ⇒ the refusal stands, and the sentence is
 *    `激活未通过（原因：…）` with the recorded Chinese reason.
 *
 * No third branch invents a recovery: a refusal that was never followed by a
 * verified bound posture is never described as retried-and-recovered.
 * @param failure - the refusal record carried by the snapshot.
 * @param activation - the Host-verified posture of the same session.
 * @returns the headline, the factual meta line, and the fixed phase phrase.
 */
function activationFailureVerdict(
  failure: DevFlowClientActivationFailure,
  activation: DevFlowClientSession['activation'],
): { readonly headline: string; readonly meta: string; readonly phase: string } {
  const retried = Math.max(failure.attempts - 1, 0)
  const meta = retried === 0
    ? `首次尝试即被拒绝 · ${failure.at}`
    : `已自动重试 ${String(retried)} 次 · ${failure.attempts} 次尝试 · ${failure.at}`
  return {
    headline: activation === 'bound'
      ? 'DevFlow 激活未通过，重试后已恢复绑定（不影响当前会话）'
      : `DevFlow 激活未通过（原因：${failure.reason}）`,
    meta,
    phase: ACTIVATION_PHASE_LABELS[failure.phase] ?? '激活',
  }
}

/** Render the read-only DevFlow workspace as the right Sidebar's DevFlow tab body. */
export function DevFlowCanvas(props: Props) {
  const { useDevflow, useSession, useChat, sessionId, refresh, t, audit, getInspectorTab, setInspectorTab: persistInspectorTab, reopenOverview } = props
  const state = useDevflow((value: DevFlowClientLoadState) => value)
  const auditHook = (props as Props & { useAudit?: <T>(selector: (value: DevFlowClientAuditLoadState) => T) => T }).useAudit
  const auditState = auditHook === undefined ? null : auditHook((value: DevFlowClientAuditLoadState) => value)
  const liveHook = (props as Props & { useLive?: <T>(selector: (value: DevFlowConnectionState) => T) => T }).useLive
  const connection = liveHook === undefined ? null : (liveHook((value: DevFlowConnectionState) => value) ?? null)
  // The event channel supersedes the poll while it is live; polling stays the
  // fallback (and is announced in the canvas), never a silent parallel reader.
  const liveConnected = connection?.phase === 'live'
  const [selection, setSelection] = useState<WorkspaceSelection>(PROJECT_SELECTION)
  const [history, setHistory] = useState<readonly WorkspaceSelection[]>([])
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null)
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>(() => getInspectorTab())
  const inspectorRegionId = useId()
  const changeInspectorTab = (tab: InspectorTab) => {
    persistInspectorTab(tab)
    setInspectorTab(tab)
  }

  useEffect(() => {
    void refresh()
  }, [refresh])

  const snapshot = state.snapshot
  const devflowSessionId = snapshot?.session.id
  const projectId = snapshot?.project?.id
  const previousProjectId = useRef(projectId)
  const projectChanged = previousProjectId.current !== projectId
  const model = snapshot === null ? null : createWorkspaceModel(snapshot)
  useEffect(() => {
    previousProjectId.current = projectId
    if (model === null || (!projectChanged && selectionExists(model, selection))) return
    setSelection(PROJECT_SELECTION)
    setHistory([])
    setSelectionNotice(projectChanged
      ? '当前项目已变更，已回到项目总览。'
      : '原先选中的对象已不在当前快照，已回到项目总览。')
  }, [projectId, model, selection])

  useEffect(() => {
    if (devflowSessionId === undefined || projectId === undefined || audit === undefined || inspectorTab !== 'audit') return
    if (projectChanged) {
      void audit.ensure({ kind: 'project' }, projectId)
      return
    }
    void audit.ensure(auditFilterForSelection(selection), projectId)
  }, [devflowSessionId, projectId, projectChanged, audit, inspectorTab, selection])

  // The fallback reader is installed last: the mount read and the audit-scope
  // effects above are the load-bearing ones, and this timer only ever covers the
  // case where the event channel is not live (it is announced in the canvas).
  useEffect(() => {
    if (liveConnected) return
    const timer = window.setInterval(() => { void refresh() }, 5_000)
    return () => { window.clearInterval(timer) }
  }, [refresh, liveConnected])

  const select = (next: WorkspaceSelection) => {
    setHistory(previous => [...previous, selection])
    setSelection(next)
    setSelectionNotice(null)
    setInspectorOpen(true)
  }
  const goBack = () => {
    const previous = history.at(-1)
    if (previous !== undefined) {
      setHistory(history.slice(0, -1))
      setSelection(previous)
      setSelectionNotice(null)
      return
    }
    if (model !== null) {
      const parent = selectionParent(model, selection)
      if (parent !== undefined) {
        setSelection(parent)
        setSelectionNotice(null)
      }
    }
  }

  if (state.phase === 'loading') return <main className={'devflow-canvas devflow-flow'} aria-busy="true"><p className={'devflow-notice'}>{t('loading')}</p></main>
  if (snapshot === null || model === null) {
    return <main className={'devflow-canvas devflow-flow'}><div className={'devflow-notice'}><p>{t('unavailable')}</p><button type="button" onClick={() => { void refresh() }}>{t('retry')}</button></div></main>
  }

  /*
   * Read the recorded refusal defensively: it is a newer field than the rest of
   * the session block, so an older snapshot (a pinned fixture, a replay from a
   * previous build) legitimately lacks it. A missing diagnosis must degrade to
   * "nothing to show", never to a blank panel — this surface's whole job is to
   * stay readable when something else went wrong.
   */
  const failure = snapshot.session.lastActivationFailure ?? null
  /** Blocked dispatches, newest first; empty for snapshots that predate them. */
  const blockedRows: readonly DevFlowClientBlocked[] = snapshot.blocked ?? []
  const verdict = failure === null ? null : activationFailureVerdict(failure, snapshot.session.activation)

  return <main className={'devflow-canvas devflow-flow'} data-phase={state.phase} data-preset={snapshot.session.presetId ?? 'none'} data-devflow-panel="true" data-activation-failure={failure?.code ?? 'none'}>
    {failure !== null && verdict !== null && (
      /*
       * The refusal banner is always mounted while a refusal is recorded — not
       * only while `activation` is `error` — because a session that recovered
       * still needs to explain the failure the user just watched. The banner is
       * three tiers on purpose — the readable conclusion, the internal code as
       * small mono text (the one string that can be quoted into a report or a
       * search, kept as text and repeated in `title`), then the bounded facts —
       * and the reason sentence rides the headline itself while the refusal
       * stands, so it is stated once rather than twice.
       */
      <div className={'devflow-activation-failure'} role="status" data-activation-code={failure.code} data-activation-phase={failure.phase} data-activation-attempts={String(failure.attempts)} data-activation-recovered={String(snapshot.session.activation === 'bound')}>
        <span className={'devflow-activation-failure-head'}>{verdict.headline}</span>
        <span className={'devflow-activation-failure-code'} title={`内部编码：${failure.code}`}>内部编码 〈{failure.code}〉</span>
        <span className={'devflow-activation-failure-meta'}>{`${verdict.phase} · ${verdict.meta}`}</span>
      </div>
    )}
    {state.phase === 'error' && <div className={'devflow-error-notice'} role="alert" data-error-code={state.error.code}><span>{state.error.code === 'scope-unavailable'
      /* 隔离拒绝：本会话没有工作区，所以这里既不显示共享库，也不宣称"最近一次成功数据"。 */
      ? t('scopeUnavailable')
      : `${t('unavailable')} 显示最近一次成功的数据。`}</span><button type="button" onClick={() => { void refresh() }}>{t('retry')}</button></div>}
    {/*
      The 受阻 banner. An employee that reported it could not do the work must be
      visible WITHOUT opening the conversation: a user who does not read chat
      cannot be expected to discover a blocker buried in a message. It carries no
      action on purpose — the fix is a configuration fix, not a choice to click.
    */}
    {blockedRows.length > 0 && <div className={'devflow-blocked-banner'} role="status" data-blocked-count={String(blockedRows.length)}>
      <span className={'devflow-blocked-head'}>受阻 · 需要处理</span>
      {blockedRows.slice(0, 3).map(row => <span className={'devflow-blocked-row'} key={row.id} data-gap-kind={row.gapKind} data-task-id={row.taskId}>
        {row.headline}
        <span className={'devflow-blocked-why'}>{row.reason.text}</span>
      </span>)}
    </div>}
    <FlowCanvas
      model={model}
      phase={state.phase}
      tab={inspectorTab}
      now={(props as Props & { now?: number }).now}
      connection={connection}
      /* 会话级提示交给画布自己的提示行渲染：绝不再横贯画布盖住连线。 */
      notice={selectionNotice}
      onTabChange={changeInspectorTab}
      onReopenOverview={reopenOverview}
      auditPanel={snapshot.project === null
        ? <EmptyProject t={t} />
        : <BusinessAudit state={projectChanged ? null : auditState} model={model} onSelect={select} onRefresh={() => { void audit?.refresh() }} onMore={() => { void audit?.loadMore() }} onRetry={() => { void audit?.retry() }} />}
      toolsPanel={<CurrentSessionToolsView useSession={useSession} useChat={useChat} sessionId={sessionId} />}
    />
  </main>
}

function EmptyProject({ t }: { t: (key: string) => string }) {
  return <section className={'devflow-empty-state'}><h1>共享 DevFlow 项目</h1><p>{t('empty')}</p><p>在本机 Chat 里执行 <code>/devflow init &lt;name&gt;</code> 即可初始化。本工作区只读。</p></section>
}

function DetailInspector({ model, selection, history, tab, inspectorRegionId, projectChanged, useSession, useChat, sessionId, auditState, onTabChange, onAuditRefresh, onAuditMore, onAuditRetry, onSelect, onBack }: {
  model: WorkspaceModel
  selection: WorkspaceSelection
  history: readonly WorkspaceSelection[]
  tab: InspectorTab
  inspectorRegionId: string
  projectChanged: boolean
  useSession: Props['useSession']
  useChat: Props['useChat']
  sessionId: Props['sessionId']
  auditState: DevFlowClientAuditLoadState | null
  onTabChange: (tab: InspectorTab) => void
  onAuditRefresh: () => void
  onAuditMore: () => void
  onAuditRetry: () => void
  onSelect: (selection: WorkspaceSelection) => void
  onBack: () => void
}) {
  const tabGroupId = useId()
  const tabId = (value: InspectorTab) => `${tabGroupId}-${value}-tab`
  const panelId = (value: InspectorTab) => `${tabGroupId}-${value}-panel`
  const title = tab === 'tools' ? 'Current session tools' : selectionLabel(model, selection)
  const onTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, current: InspectorTab) => {
    let nextIndex: number | undefined
    const currentIndex = INSPECTOR_TABS.indexOf(current)
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % INSPECTOR_TABS.length
    if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + INSPECTOR_TABS.length) % INSPECTOR_TABS.length
    if (event.key === 'Home') nextIndex = 0
    if (event.key === 'End') nextIndex = INSPECTOR_TABS.length - 1
    if (nextIndex === undefined) return
    event.preventDefault()
    const next = INSPECTOR_TABS[nextIndex]!
    onTabChange(next)
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]?.focus()
  }

  return <section id={inspectorRegionId} className={'devflow-inspector'}>
    <header><div><p className={'devflow-kicker'}>Inspector</p><h2>{title}</h2></div>{tab !== 'tools' && (history.length > 0 || selection.kind !== 'project') && <button type="button" className={'devflow-back-button'} onClick={onBack}>Back</button>}</header>
    <div className={'devflow-inspector-tabs'} role="tablist" aria-label="Inspector views" aria-orientation="horizontal">
      {INSPECTOR_TABS.map(value => <button
        key={value}
        id={tabId(value)}
        type="button"
        role="tab"
        tabIndex={tab === value ? 0 : -1}
        aria-controls={panelId(value)}
        aria-selected={tab === value}
        data-selected={tab === value}
        onClick={() => { onTabChange(value) }}
        onKeyDown={event => { onTabKeyDown(event, value) }}
      >{inspectorTabLabel(value)}</button>)}
    </div>
    <section id={panelId('flow')} role="tabpanel" aria-labelledby={tabId('flow')} hidden={tab !== 'flow'}>
      {tab === 'flow' && <InspectorSourceHeading title="Dispatch flow" badges={['Shared · .devflow', 'Current session · scoped state']} />}
    </section>
    <section id={panelId('audit')} role="tabpanel" aria-labelledby={tabId('audit')} hidden={tab !== 'audit'}>
      {tab === 'audit' && <BusinessAudit state={projectChanged ? null : auditState} model={model} onSelect={onSelect} onRefresh={onAuditRefresh} onMore={onAuditMore} onRetry={onAuditRetry} />}
    </section>
    <section id={panelId('tools')} role="tabpanel" aria-labelledby={tabId('tools')} hidden={tab !== 'tools'}>
      {tab === 'tools' && <CurrentSessionToolsView useSession={useSession} useChat={useChat} sessionId={sessionId} />}
    </section>
  </section>
}

function InspectorSourceHeading({ title, badges }: { title: string; badges: readonly string[] }) {
  return <header className={'devflow-panel-heading'}><div><h3>{title}</h3>{badges.map(badge => <span key={badge} className={'devflow-source-badge'}>{badge}</span>)}</div></header>
}

function CurrentSessionToolsView({ useSession, useChat, sessionId }: { useSession: Props['useSession']; useChat: Props['useChat']; sessionId: Props['sessionId'] }) {
  // The official window splits across two framework targets: session lifecycle
  // state from the Session Controller adapter, loaded Chat nodes from the Chat
  // target. Both are selected separately and joined in the pure mapper. The
  // parameters are annotated because the framework's selector hook types are
  // not always inferable from the slot props alone.
  const chat = useChat((snapshot: ChatSnapshot) => snapshot)
  const state = useSession(
    (session: SessionSnapshot) => mapCurrentSessionTools(sessionId, { session, chat }),
    equalCurrentSessionToolsState,
  )
  return <CurrentSessionTools state={state} />
}

function CurrentSessionTools({ state }: { state: CurrentSessionToolsState }) {
  const hasItems = state.items.length > 0
  return <section className={'devflow-tools'} aria-busy={state.phase === 'loading'}>
    <InspectorSourceHeading title="本会话工具动态" badges={['本会话 · Harness 官方数据', '当前已加载会话窗口', '最新最多 20 条']} />
    <p className={'devflow-detail-note'}>这里显示当前会话已加载窗口里可见的官方工具动态；当前的 DevFlow 选择不参与过滤。</p>
    {state.phase === 'loading' && !hasItems && <p className={'devflow-muted'}>正在从当前已加载的会话窗口读取官方工具动态…</p>}
    {state.phase === 'loading' && hasItems && <p className={'devflow-tools-stale'} role="status">会话窗口仍在加载，这里只显示当前可见的安全内容。</p>}
    {state.phase === 'unavailable' && !hasItems && <p className={'devflow-tools-unavailable'} role="status">当前会话的官方工具动态不可用。此处不会用 `.devflow` 记录顶替。</p>}
    {state.phase === 'unavailable' && hasItems && <p className={'devflow-tools-stale'} role="status">官方工具动态当前不可用，显示仍留在已加载窗口中的安全条目。</p>}
    {state.phase === 'ready' && !hasItems && state.incompleteCount === 0 && <p className={'devflow-muted'}>当前会话已加载窗口里没有可见的官方工具动态。</p>}
    {state.incompleteCount > 0 && <p className={'devflow-muted'}>有 {state.incompleteCount} 条可见工具调用因为没有确认到活跃结果而被略过。</p>}
    {hasItems && <ol className={'devflow-tool-list'}>{state.items.map(item => <ToolActivityItem key={item.id} item={item} />)}</ol>}
    {state.hasMore && <p className={'devflow-muted'}>更早的会话历史在这个已加载窗口之外，本视图不会去加载它。</p>}
  </section>
}

function ToolActivityItem({ item }: { item: SafeOfficialToolActivity }) {
  return <li data-status={item.status}>
    <div className={'devflow-tool-title'}><strong>{item.toolName}</strong><em>{toolStatusLabel(item.status)}</em></div>
    <dl className={'devflow-tool-meta'}>
      <div><dt>调用</dt><dd title={item.callId}>{shortId(item.callId, 18)}</dd></div>
      <div><dt>开始</dt><dd>{item.startedAt ?? '不可见'}{item.startSeq === null ? '' : ` · #${item.startSeq}`}</dd></div>
      <div><dt>结果</dt><dd>{item.endedAt ?? '不可见'}{item.resultSeq === null ? '' : ` · #${item.resultSeq}`}</dd></div>
      <div><dt>耗时</dt><dd>{item.durationMs === null ? '不可用' : `${item.durationMs} 毫秒`}</dd></div>
    </dl>
    <p className={'devflow-tool-summary'}>结果 · {item.resultSummary}</p>
    <p className={'devflow-tool-relation'}>未知 — 没有记录到 DevFlow 关联</p>
  </li>
}

function toolStatusLabel(status: SafeOfficialToolActivity['status']): string {
  return ({ running: '进行中', succeeded: '成功', failed: '失败', 'result-without-call': '只有结果、看不到调用' })[status]
}

function inspectorTabLabel(tab: InspectorTab): string {
  return ({ flow: '派发流', audit: '审计', tools: '本会话' })[tab]
}

function BusinessAudit({ state, model, onSelect, onRefresh, onMore, onRetry }: {
  state: DevFlowClientAuditLoadState | null
  model: WorkspaceModel
  onSelect: (selection: WorkspaceSelection) => void
  onRefresh: () => void
  onMore: () => void
  onRetry: () => void
}) {
  if (state === null) return <section className={'devflow-audit'}><InspectorSourceHeading title="业务审计" badges={['共享 · .devflow']} /><p className={'devflow-muted'}>当前客户端版本没有业务审计能力。</p></section>
  if (state.phase === 'idle' || state.phase === 'loading') return <section className={'devflow-audit'} aria-busy="true"><AuditHeading onRefresh={onRefresh} /><p className={'devflow-muted'}>正在读取共享 DevFlow 业务审计…</p></section>
  if (state.phase === 'error' && state.page === null) return <section className={'devflow-audit'}><AuditHeading onRefresh={onRefresh} /><p className={'devflow-audit-error'}>DevFlow 审计不可用，请刷新重试。</p><button type="button" className={'devflow-audit-action'} onClick={onRetry}>重试</button></section>
  const page = state.page
  if (page === null) return null
  return <section className={'devflow-audit'}>
    <AuditHeading onRefresh={onRefresh} />
    {state.phase === 'refreshing' && <p className={'devflow-audit-stale'}>刷新中 · 显示最近一次成功的审计数据</p>}
    {state.phase === 'error' && <div className={'devflow-audit-error'} role="alert">DevFlow 审计不可用，显示最近一次成功的数据。<button type="button" className={'devflow-audit-action'} onClick={onRetry}>重试</button></div>}
    {page.items.length === 0
      ? <p className={'devflow-muted'}>当前项目或对象没有可展示的 DevFlow 业务审计记录。</p>
      : <ol className={'devflow-audit-list'}>{page.items.map(item => <AuditItem key={item.id} item={item} model={model} onSelect={onSelect} />)}</ol>}
    {page.omittedUnsafeCount > 0 && <p className={'devflow-muted'}>有 {page.omittedUnsafeCount} 条不安全或不受支持的审计记录已隐藏。</p>}
    {page.truncated && <p className={'devflow-muted'}>本页在完整记录边界处被安全截断。</p>}
    {page.nextCursor !== null && <button type="button" className={'devflow-audit-action'} disabled={state.phase !== 'ready'} onClick={onMore}>{state.phase === 'loading-more' ? '加载中…' : '加载更多'}</button>}
  </section>
}

function AuditHeading({ onRefresh, disabled = false }: { onRefresh: () => void; disabled?: boolean }) {
  return <header className={'devflow-audit-heading'}><div><h3>业务审计</h3><span className={'devflow-source-badge'}>共享 · .devflow</span></div><button type="button" className={'devflow-audit-action'} disabled={disabled} onClick={onRefresh}>刷新</button></header>
}

function AuditItem({ item, model, onSelect }: { item: DevFlowClientAuditItem; model: WorkspaceModel; onSelect: (selection: WorkspaceSelection) => void }) {
  const related = relatedSelection(item, model)
  return <li data-incomplete={item.incomplete}><div className={'devflow-audit-meta'}><time>{item.at}</time><span>#{item.sequence}</span></div><strong>{auditLabel(item.category)} · {auditLabel(item.action)}</strong>{item.status !== null && <em>{item.status}</em>}
    {related === undefined ? <p>{item.entity.display?.text ?? (item.incomplete ? '未知 / 历史遗留记录' : '当前没有对应对象')}</p> : <button type="button" onClick={() => { onSelect(related) }}>{auditEntityLabel(item, model)}</button>}
    {item.summary !== null && <SafeText text={item.summary.text} truncated={item.summary.truncated} redacted={item.summary.redacted} />}
    {item.incomplete && <small>历史遗留或不完整记录</small>}
  </li>
}

function relatedSelection(item: DevFlowClientAuditItem, model: WorkspaceModel): WorkspaceSelection | undefined {
  const id = item.entity.id
  if (item.entity.type === 'phase' && id !== null && model.phases.some(phase => phase.id === id)) return { kind: 'phase', id }
  if (item.entity.type === 'task' && id !== null && model.taskById.has(id)) return { kind: 'task', id }
  if (item.entity.type === 'agent' && id !== null && model.agentById.has(id)) return { kind: 'agent', id }
  if (item.entity.type === 'execution' && id !== null && model.executionById.has(id)) return { kind: 'execution', id }
  if ((item.entity.type === 'decision' || item.entity.type === 'decision-request') && id !== null && (model.decisionsById.has(id) || model.decisionRequestsById.has(id))) return { kind: 'decision', id }
  return undefined
}

function auditEntityLabel(item: DevFlowClientAuditItem, model: WorkspaceModel): string {
  const id = item.entity.id
  if (id === null) return '未知 / 历史遗留记录'
  if (item.entity.type === 'phase') return model.phases.find(phase => phase.id === id)?.name ?? '未知 / 阶段已删除'
  if (item.entity.type === 'task') return model.taskById.get(id)?.task.title ?? '未知 / 任务已删除'
  if (item.entity.type === 'agent') return model.agentById.get(id)?.agent.displayName ?? '未知 / Agent 已删除'
  if (item.entity.type === 'execution') return `执行 ${shortId(id)}`
  return `决策 ${shortId(id)}`
}

/**
 * Audit categories/actions arrive as stored English enum values. The panel shows
 * a Chinese name where one exists and falls back to the stored value, so an
 * unmapped code is visible rather than silently blanked.
 */
const AUDIT_WORDS: Readonly<Record<string, string>> = {
  project: '项目', task: '任务', phase: '阶段', agent: 'Agent', assignment: '派发',
  execution: '执行', attempt: '尝试', report: '报告', decision: '决策', control: '控制',
  scope: '范围', 'bridge-review': '桥接复核', runtime: '运行时', 'commander-action': '总指挥动作',
  updated: '更新', created: '创建', removed: '移除', transitioned: '状态流转', assigned: '已派发',
  unassigned: '已取消派发', started: '开始', completed: '完成', failed: '失败', blocked: '阻塞',
  requested: '已请求', answered: '已回答', paused: '已暂停', resumed: '已恢复', imported: '已导入',
  exported: '已导出', 'boundary-hit': '触达边界', executed: '已执行',
}

function auditLabel(value: string): string {
  const known = AUDIT_WORDS[value]
  if (known !== undefined) return known
  return value.split('-').map(part => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(' ')
}

/** Render one bounded audit summary without ever echoing raw runtime text. */
function SafeText({ text, truncated, redacted }: { text: string; truncated: boolean; redacted: boolean }) {
  return <p>{text}{redacted ? <em> · 敏感内容已隐藏</em> : truncated ? <em> · 已截断</em> : null}</p>
}

