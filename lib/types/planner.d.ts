/**
 * Domain logic, independent of transport. Both the HTTP routes and the agent
 * tools are thin adapters over this module, so the two can never drift.
 *
 * Concurrency: ONE write chain serializes every read-modify-write in the
 * process. A per-date chain would be enough for single-day ops, but `moveItem`
 * touches two dates, and a single chain removes that whole class of
 * interleaving at no cost for a single-user planner. Upstream hand-rolled
 * get→put with no serialization at all: eight concurrent adds persisted one.
 *
 * Records are immutable — every mutation builds NEW DayPlan/PlanItem objects.
 * @module dsh-daily-progress-tab/planner
 */
import type { Domain } from '@deepseek-ai/dsh-storage-domain';
import type { DailyProgressDomainSpec } from './domain.ts';
import type { PublishSettings } from './portfolio.ts';
import type { ItemOrigin, MutateErrorCode, MutateOp, MutateResult, PlanItem, Snapshot } from './types.ts';
export declare const MAX_ITEMS = 50;
export declare const MAX_TEXT = 500;
export declare const MAX_TZ = 64;
/**
 * How far the pickable pool reaches on either side of today. Bounded because the
 * pool is rendered as a flat list: an unbounded scan would let one stale store
 * turn the page into a wall of rows.
 */
export declare const POOL_BACK_DAYS = 14;
export declare const POOL_AHEAD_DAYS = 14;
/** Hard cap on pooled rows, whatever the window holds. */
export declare const MAX_POOL = 60;
/** Candidate tasks one project may hold. */
export declare const MAX_BACKLOG = 100;
export interface Planner {
    /** Read the snapshot for one user-local date. */
    snapshot(date: string, tz: string): Promise<Snapshot>;
    /** Apply one mutation to one user-local date. */
    apply(op: MutateOp, date: string, tz: string, payload: Record<string, unknown>): Promise<MutateResult>;
}
type Failed = {
    ok: false;
    code: MutateErrorCode;
    message: string;
};
/** A bounded, non-empty zone label; recorded for display only. */
export declare function normalizeTz(value: unknown): string;
export declare function normalizeText(value: unknown): string | null;
/**
 * Validate a batch of new tasks and build their records, WITHOUT writing
 * anything.
 *
 * Exported so a caller adding to more than one day can reject every group
 * before the first write lands. Validating inside the write loop is exactly how
 * a half-written batch shipped: seven tasks were requested, the sixth had an
 * over-long summary, and five were already stored by the time the error
 * surfaced (2026-10-01, bug-census A14). One write per call plus this check up
 * front makes that impossible rather than merely unlikely.
 */
export declare function buildNewItems(rawItems: unknown, existingCount: number, origin: ItemOrigin): {
    ok: true;
    items: PlanItem[];
} | Failed;
export declare function createPlanner(domainPromise: Promise<Domain<DailyProgressDomainSpec>>, publish?: PublishSettings): Planner;
export {};
