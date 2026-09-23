/** Pure Host-to-Client DevFlow snapshot adapter. */
import { type DevFlowClientSnapshot } from '../contract.ts';
import type { DevflowController } from './index.ts';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { BlockedReport } from './types.ts';
import type { DevFlowStoreState } from './storage.ts';
/** P0B bounds apply before serialization; client display repeats the cap defensively. */
export declare const DEVFLOW_SAFE_SUMMARY_LIMIT = 20;
export declare const DEVFLOW_SAFE_TEXT_LIMIT = 500;
/** Convert plugin-owned state into the narrow JSON-safe Canvas DTO. */
export declare function createDevFlowClientSnapshot(controller: DevflowController, agent: Agent): Promise<DevFlowClientSnapshot>;
/**
 * True when recorded FACTS say one block was resolved after it was reported.
 *
 * Live feedback (2026-09-24): the 受阻 banner kept listing blocks whose tasks had long
 * been delivered and accepted — it read as a stale alarm and covered the canvas. A block
 * is a durable record, so the panel is what must stop calling it open, and only two facts
 * count as resolution:
 *
 *  * the block's task reached `completed` (the work finished and the user accepted it);
 *  * a COMPLETED execution exists for the same task that ended after the block was
 *    reported — the task was dispatched again and this time it landed, which is exactly
 *    what "the missing capability was fixed and the work got done" looks like on disk.
 *
 * Both are recorded, never inferred from the absence of evidence. Nothing is deleted here:
 * the blocked record and its journal row stay as history.
 * @param state - the folded store state.
 * @param block - the blocked report to judge.
 * @returns true when the block no longer describes an open problem.
 */
export declare function blockedResolved(state: DevFlowStoreState, block: BlockedReport): boolean;
