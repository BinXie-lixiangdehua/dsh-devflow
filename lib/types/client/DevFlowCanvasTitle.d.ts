/**
 * The DevFlow type's chip title, registered under `sidebar.right.pane.tab.title`.
 *
 * Without this registration the chip shows the title the registry captured at
 * open time (the definition's `title()`), which is already correct; registering
 * here is what lets the chip track the live locale and the tab's own state. The
 * tab's identity is fixed, so the chip text is the namespace-bound label.
 */
import type { ReactNode } from 'react';
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
/**
 * The title as the chip and a floating panel's header show it.
 * @param props - the tab information hook and the bound copy namespace.
 * @returns the DevFlow label for the tab.
 */
export declare function DevFlowCanvasTitle({ t }: PropsRuntime<'sidebar.right.pane.tab.title'> & PropsLocale<'devflow'>): ReactNode;
