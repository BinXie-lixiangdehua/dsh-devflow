import type { Context as ClientContext } from '@deepseek-ai/cordis';
import { DevFlowCanvas } from './DevFlowCanvas.tsx';
export declare const inject: string[];
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        devflow: string;
    }
}
/** Mount DevFlow's typed Remote and expose one session-scoped Canvas tab. */
export declare function apply(ctx: ClientContext): void;
export { DevFlowCanvas };
