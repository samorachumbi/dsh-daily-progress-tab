/**
 * HTTP surface. A thin adapter over {@link createPlanner}: it owns transport
 * concerns (routing, body limits, the loopback guard, content types) and
 * delegates every semantic decision to the planner, which the agent tools share.
 *
 *   GET  /daily-progress-tab/ui     → the planner page
 *   GET  /daily-progress-tab/state  → Snapshot
 *   POST /daily-progress-tab/mutate → MutateResult
 *
 * The page is served by this plugin, so it is same-origin with the API and can
 * live in its own browser tab (movable to a second screen) with no harness
 * client bundle anywhere.
 *
 * All routes are loopback-guarded — the same posture as the connection
 * carrier's `/api` fence, cheap for a plugin.
 * @module dsh-daily-progress-tab/routes
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { type Planner } from './planner.ts';
/** Mount prefix owned by this plugin (distinct from upstream's `/daily-progress`). */
export declare const ROUTE_PREFIX = "/daily-progress-tab";
export interface DailyProgressHandlers {
    handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
}
/**
 * @param planner - shared domain logic.
 * @param defaultDate - resolves "today" when a request omits `localDate` (agent-originated or curl).
 */
export declare function createHandlers(planner: Planner, defaultDate: () => string): DailyProgressHandlers;
