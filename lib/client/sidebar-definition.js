/** The tab kind this plugin owns; what `openTab` names. */
export const DEVFLOW_KIND = 'devflow';
/** This implementation's identity in the tab system, and the key its body and title register under. */
export const DEVFLOW_ID = '@xiaoxie-ide/dsh-devflow';
/**
 * The DevFlow type's registry definition.
 * @param t - namespace-bound translate, read fresh on every label call.
 * @returns the definition to register into `ctx.sidebarRightTabs`.
 */
export function devflowDefinition(t) {
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
    };
}
