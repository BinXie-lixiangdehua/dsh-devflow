import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { DEVFLOW_REMOTE } from './remote.ts'
import { DEVFLOW_ID, DEVFLOW_KIND, devflowDefinition } from './sidebar-definition.ts'
import { DevFlowCanvas } from './DevFlowCanvas.tsx'
import { DevFlowCanvasTitle } from './DevFlowCanvasTitle.tsx'
import { DevFlowOverview, OVERVIEW_REOPEN_EVENT } from './DevFlowOverview.tsx'
import { OVERVIEW_CELL_ID } from './overview.ts'
import { DevFlowSnapshotController, DevFlowLiveController } from './store.ts'
import type { DevFlowRemote } from './remote.ts'
import { installDevFlowStyles } from './styles.ts'

const NS = 'devflow'

/** The Agent preset that owns this panel; every other preset sees no DevFlow tab. */
const DEVFLOW_PRESET_ID = 'devflow'

export const inject = [
  'slots', 'locale', 'remote', 'sessions', 'sidebarRightTabs', 'sidebarRight',
]

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    devflow: string
  }
}

/** Mount DevFlow's typed Remote and expose one session-scoped Canvas tab. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const dispose = installDevFlowStyles()
    return dispose
  }, 'devflow: styles')

  ctx.effect(() => ctx.locale.register(NS, {
    en: {
      canvas: 'DevFlow Canvas',
      sidebarGuideTitle: 'DevFlow state',
      sidebarGuideDescription: 'Read-only project, phase, task, and dispatch state',
      loading: 'Restoring DevFlow state...',
      refreshing: 'Refreshing DevFlow state',
      retry: 'Retry',
      empty: 'No project has been initialized yet. Run /devflow init <name>.',
      unavailable: 'DevFlow state is unavailable. Refresh to try again.',
      scopeUnavailable: 'This session has no project workspace, so DevFlow refuses to share state: no project data is shown here.',
      project: 'Project route',
      team: 'Team roster',
      work: 'Dispatch ledger',
      assignments: 'Assignments',
      noAssignments: 'No assignments yet',
      noTasks: 'No tasks yet',
      noAgents: 'No agents registered',
      pause: 'Paused',
      live: 'Dispatch live',
      commander: 'Commander',
      chat: 'Native chat',
      task: 'Task',
      phase: 'Phase',
      agent: 'Agent',
      status: 'Status',
      goal: 'Goal',
      stage: 'Stage',
      decisions: 'Decision queue',
      noDecisions: 'No pending decisions',
      decisionHistory: 'Decision history',
      noDecisionHistory: 'No decisions recorded',
      executions: 'Execution status',
      noExecutions: 'No executions recorded',
      relation: 'route',
    },
    zh: {
      canvas: 'DevFlow 画布',
      sidebarGuideTitle: 'DevFlow 状态',
      sidebarGuideDescription: '只读查看项目、阶段、任务与派发状态',
      loading: '正在恢复 DevFlow 状态...',
      refreshing: '正在刷新 DevFlow 状态',
      retry: '重试',
      empty: '还没有初始化项目，请运行 /devflow init <name>。',
      unavailable: 'DevFlow 状态暂时不可用，请刷新重试。',
      scopeUnavailable: '本会话没有工作区，DevFlow 拒绝与其它项目共享状态：这里不显示任何项目数据。',
      project: '项目路线',
      team: '团队 roster',
      work: '派发台账',
      assignments: '任务关系',
      noAssignments: '暂无任务关系',
      noTasks: '暂无任务',
      noAgents: '暂无 Agent',
      pause: '已暂停',
      live: '派发中',
      commander: '总指挥',
      chat: '原生对话',
      task: '任务',
      phase: '阶段',
      agent: 'Agent',
      status: '状态',
      goal: '目标',
      stage: '阶段',
      decisions: '待处理决定',
      noDecisions: '暂无待处理决定',
      decisionHistory: '决定记录',
      noDecisionHistory: '暂无决定记录',
      executions: '执行状态',
      noExecutions: '暂无执行记录',
      relation: '路线',
    },
  }), 'devflow: dictionaries')

  const controllers = new Map<SessionId, DevFlowSnapshotController>()
  const liveControllers = new Map<SessionId, DevFlowLiveController>()
  let remoteReady = false
  const scopedRemoteFor = (sessionId: SessionId): DevFlowRemote | undefined => {
    // The client `sessions` service is the Session Controller's `ISessions` in
    // 0.1.5. The host plane declares the same `Context.sessions` key with its
    // own `SessionStore`, so the client program resolves the ambient property to
    // the host type; naming the client contract explicitly keeps the client
    // call site honest about which service it addresses.
    const agentCtx = (ctx.sessions as unknown as ISessions).scope(sessionId)
    if (agentCtx === undefined || !remoteReady) return undefined
    return agentCtx.get('remote.devflow') as DevFlowRemote | undefined
  }
  const remoteFor = (sessionId: SessionId): DevFlowRemote | undefined => {
    return scopedRemoteFor(sessionId)
  }
  const controllerFor = (sessionId: SessionId): DevFlowSnapshotController => {
    let controller = controllers.get(sessionId)
    if (controller === undefined) {
      controller = new DevFlowSnapshotController(remoteFor(sessionId), sessionId)
      controllers.set(sessionId, controller)
      // One live channel per session. It never derives state: a change signal only
      // marks the snapshot stale and lets the component re-read through the same
      // snapshot path, so a dropped frame cannot invent a state.
      const live = new DevFlowLiveController(remoteFor(sessionId), sessionId, {
        snapshot: snapshot => { controller?.acceptSnapshot(snapshot) },
        frame: () => { controller?.refresh() },
      })
      liveControllers.set(sessionId, live)
      live.start()
    }
    return controller
  }
  const liveFor = (sessionId: SessionId): DevFlowLiveController | undefined => liveControllers.get(sessionId)
  const refreshControllers = (): void => {
    for (const [sessionId, controller] of controllers) controller.setRemote(remoteFor(sessionId))
    for (const [sessionId, live] of liveControllers) live.setRemote(remoteFor(sessionId))
  }

  ctx.effect(() => {
    // Stage two: the body and the chip title, both keyed by the type's `id`.
    const disposeCanvas = ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab',
      key: DEVFLOW_ID,
      locale: NS,
      inject: (sessionId: SessionId) => {
        const controller = controllerFor(sessionId)
        const live = liveFor(sessionId)
        return {
          hooks: { devflow: controller, audit: controller.audit, live },
          refresh: () => controller.refresh(),
          getInspectorTab: () => controller.getInspectorTab(),
          setInspectorTab: (tab: import('./store.ts').DevFlowInspectorTab) => { controller.setInspectorTab(tab) },
          audit: {
            ensure: (filter: import('../contract.ts').DevFlowClientAuditFilter, scopeKey?: string) => controller.audit.ensure(filter, scopeKey),
            refresh: () => controller.audit.refresh(),
            loadMore: () => controller.audit.loadMore(),
            retry: () => controller.audit.retry(),
          },
          /** §二·3: the panel is where the closed overview float is reopened from. */
          reopenOverview: () => { window.dispatchEvent(new Event(OVERVIEW_REOPEN_EVENT)) },
        }
      },
    }, DevFlowCanvas))
    const disposeTitle = ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab.title',
      key: DEVFLOW_ID,
      locale: NS,
    }, DevFlowCanvasTitle))

    // Stage one: the tab TYPE. A page type is opened by kind and its guide entry is
    // the user's only door into it, and neither carries a per-session predicate — so
    // preset binding is done by REGISTERING the type only while the current session
    // runs the DevFlow preset. Outside it the kind is unregistered, which is what
    // removes both the tab and the guide capsule, per the preset-first route the
    // product committed to.
    const list = (ctx.sessions as unknown as ISessions).list
    let disposeType: (() => void) | null = null
    const syncType = (): void => {
      const state = list.getSnapshot()
      const session = state.current === undefined ? undefined : state.byId[state.current]
      const wanted = session?.projectionValues?.agentPreset === DEVFLOW_PRESET_ID
      // Diagnostic marker so the preset binding can be checked from the DOM.
      try {
        document.documentElement.dataset.devflowPreset = String(session?.projectionValues?.agentPreset ?? 'none')
        document.documentElement.dataset.devflowPresetWanted = String(wanted)
      } catch { /* document may be absent in tests */ }
      if (wanted && disposeType === null) disposeType = ctx.sidebarRightTabs.register(devflowDefinition(ctx.locale.bind(NS)))
      else if (!wanted && disposeType !== null) { disposeType(); disposeType = null }
    }
    const disposeWatch = list.subscribe(syncType)
    syncType()

    /**
     * The top-right overview float (step 3B, §二~§五).
     *
     * `shell.overlay` is ROOT-scoped, so it is registered ONCE and the filter lives
     * inside the cell: the round's hard requirement is that the float is absent in
     * every session whose preset is not `devflow`, and a registration that exists but
     * renders `null` is exactly "缺席即正确语义" — no placeholder, no empty strip.
     *
     * `openPanel` is the float's one action: expand the right column and focus the
     * DevFlow tab. The kind is only registered while the CURRENT session runs the
     * DevFlow preset, so asking for it elsewhere would throw — the guard keeps the
     * float's own gate honest rather than relying on the throw.
     */
    const openPanel = (): void => {
      try {
        if (document.documentElement.dataset.devflowPresetWanted !== 'true') return
        ctx.sidebarRight.openTab(DEVFLOW_KIND)
      } catch { /* No mounted panel or no registered kind: the float simply does nothing. */ }
    }
    const disposeOverview = ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay',
      id: OVERVIEW_CELL_ID,
      order: 10,
      label: 'DevFlow 概览',
      // The cell's `useSessions` seat is a framework standard prop for a root-scoped
      // slot; only the plugin's own face is injected here.
      inject: () => ({ controllerFor, liveFor, openPanel }),
    }, DevFlowOverview))

    return () => {
      disposeWatch()
      disposeOverview()
      if (disposeType !== null) disposeType()
      disposeTitle()
      disposeCanvas()
      for (const live of liveControllers.values()) live.dispose()
      liveControllers.clear()
      for (const controller of controllers.values()) controller.dispose()
      controllers.clear()
    }
  }, 'devflow: right Sidebar tab')

  ctx.effect(async () => {
    const disposeRemote = await ctx.remote.$mount(DEVFLOW_REMOTE)
    remoteReady = true
    refreshControllers()

    const disposeReset = ctx.on('connection/reset', () => {
      refreshControllers()
      for (const controller of controllers.values()) controller.markStale()
    })
    return async () => {
      disposeReset()
      remoteReady = false
      for (const live of liveControllers.values()) live.dispose()
      liveControllers.clear()
      for (const controller of controllers.values()) controller.dispose()
      await disposeRemote()
    }
  }, 'devflow: Remote')
}

export { DevFlowCanvas }
