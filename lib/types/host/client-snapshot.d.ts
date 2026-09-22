/** Pure Host-to-Client DevFlow snapshot adapter. */
import { type DevFlowClientSnapshot } from '../contract.ts';
import type { DevflowController } from './index.ts';
import type { Agent } from '@deepseek-ai/dsh-agent';
/** P0B bounds apply before serialization; client display repeats the cap defensively. */
export declare const DEVFLOW_SAFE_SUMMARY_LIMIT = 20;
export declare const DEVFLOW_SAFE_TEXT_LIMIT = 500;
/** Convert plugin-owned state into the narrow JSON-safe Canvas DTO. */
export declare function createDevFlowClientSnapshot(controller: DevflowController, agent: Agent): Promise<DevFlowClientSnapshot>;
