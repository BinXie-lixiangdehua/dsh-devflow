/** Generated-artifact-compatible Host Remote contribution for the DevFlow bridge. */
import { z } from 'zod';
/**
 * Explicit Host Remote declarations keep the bridge discoverable when the
 * linked package resolves a different physical copy of the decorator module.
 */
export declare const TYPERT: {
    package: string;
    face: "host";
    schemas: never[];
    model: {
        services: never[];
        events: never[];
        objects: never[];
    };
    invocations: {
        id: string;
        service: string;
        namespace: string;
        method: "snapshot" | "refresh";
        invocation: {
            kind: "direct";
        };
        scope: {
            context: string;
            wire: string;
        };
        parameters: {
            name: string;
            wire: string;
            source: "lookup";
            lookup: string;
            codec: {
                mode: "strict";
                typeSymbol: string;
                schema: z.ZodString;
            };
        }[];
        result: {
            mode: "strict";
            typeSymbol: string;
            schema: z.ZodPipe<z.ZodUnknown, z.ZodTransform<unknown, unknown>>;
        };
    }[];
};
