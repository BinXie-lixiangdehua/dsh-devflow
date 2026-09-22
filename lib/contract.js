/**
 * Versioned, JSON-safe DevFlow browser contract.
 *
 * This module deliberately has no Host or Client runtime imports: both sides
 * agree on this DTO without exposing `.devflow` files, journal records, or
 * execution credentials.
 */
export const DEVFLOW_CLIENT_SNAPSHOT_VERSION = 1;
/**
 * How many `devflow_dispatch_agent` calls may be in flight at once.
 *
 * **Single point of definition** (boss 2026-09-21 01:49: 起步 5). This module is
 * the only file both build targets compile (`tsconfig.json` includes
 * `src/contract.ts` for the host, `tsconfig.client.json` for the client), so the
 * host's admission predicate and the panel's `并发 N/5` read the SAME number and
 * cannot drift into two copies of "5" — a write-time contract, not a
 * convention. Editing the limit is editing this one line.
 *
 * The host enforces it (a dispatch beyond it is classified `exclusive` and waits
 * behind the running group — 超限排队); the client only DISPLAYS it.
 */
export const DEVFLOW_CONCURRENCY_LIMIT = 5;
/** P1A is independently versioned so V1 snapshot/refresh stays stable. */
export const DEVFLOW_CLIENT_AUDIT_PAGE_VERSION = 1;
export const DEVFLOW_CLIENT_AUDIT_PAGE_LIMIT = 20;
export const DEVFLOW_CLIENT_AUDIT_TEXT_LIMIT = 500;
export const DEVFLOW_CLIENT_AUDIT_PAGE_BYTES = 49_152;
/** Bound on the diagnostic path list one `changed` frame may carry. */
export const DEVFLOW_CLIENT_EVENT_PATH_LIMIT = 12;
/** Bound on the semantic change list one `changed` frame may carry. */
export const DEVFLOW_CLIENT_EVENT_CHANGE_LIMIT = 8;
/** The closed vocabulary a `changed` frame's `changes[].type` may use. */
export const DEVFLOW_CLIENT_CHANGE_KINDS = [
    'task-reviewing', 'task-executing', 'task-settled',
    'execution-started', 'execution-settled',
    'assignment-created', 'assignment-settled',
];
