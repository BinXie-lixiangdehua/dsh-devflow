/**
 * Stage one of DevFlow's right-Sidebar registration: what the `devflow` tab type IS.
 *
 * A page type, not a viewer: DevFlow state is addressed by nothing, so the type
 * declares no resource `patterns` and claims no address. It is opened by kind.
 * The guide page offers it as an entry capsule
 * (`GuideBody.tsx`: `tab.actions.openTab(entry.kind, { replaceTab: true })`), and
 * that capsule is the user's door into the tab — a page type that stays off the
 * guide is a type no user can reach.
 *
 * The body and the chip title are stage two, registered under {@link DEVFLOW_ID}
 * into `sidebar.right.pane.tab` and `sidebar.right.pane.tab.title`.
 */
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'

/** The tab kind this plugin owns; what `openTab` names. */
export const DEVFLOW_KIND = 'devflow'

/** This implementation's identity in the tab system, and the key its body and title register under. */
export const DEVFLOW_ID = '@xiaoxie-ide/dsh-devflow'

/**
 * The DevFlow type's registry definition.
 * @param t - namespace-bound translate, read fresh on every label call.
 * @returns the definition to register into `ctx.sidebarRightTabs`.
 */
export function devflowDefinition(t: TranslateNS<'devflow'>): SidebarRightTabDefinition {
  return {
    id: DEVFLOW_ID,
    kind: DEVFLOW_KIND,
    priority: 'extension',
    title: () => t('canvas'),
    guide: [{
      order: 20,
      title: () => t('sidebarGuideTitle'),
      description: () => t('sidebarGuideDescription'),
    }],
  }
}
