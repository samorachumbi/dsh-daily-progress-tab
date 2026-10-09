/**
 * Build time: the day's estimated load against a budget, the capacity that
 * budget should be measured from, and each project's burn against its estimate.
 *
 * Pure and exported, so every number the page shows is callable from a test
 * rather than living inside a component body.
 *
 * **One build-day is five hours (the default).** The unit was previously
 * undefined, which made `effortDays` an unlabelled divisor in the ranking —
 * `score = … / max(effortDays, 1)` — so every score rested on an assumption
 * nobody had written down. `DEFAULT_BUDGET_HOURS` is PROVISIONAL: it is meant to
 * be replaced by {@link measureCapacity}'s reading once a week of real work
 * exists, because an assumed capacity makes every burn ratio noise.
 *
 * @module dsh-daily-progress-tab/build
 */
import type { BuildSummary, CapacityReading, DayPlan, PlanItem, Project, ProjectBurn } from './types.ts';
/**
 * The stored budget, clamped, falling back to the default.
 *
 * A budget that is absent, null, NaN or out of range resolves to
 * {@link DEFAULT_BUDGET_HOURS} rather than to zero — a zero budget would make
 * every load ratio infinite and every project infinitely overrun.
 */
export declare function effectiveBudget(stored: number | null | undefined): number;
/**
 * Hours on an item, or null when it carries no usable estimate.
 *
 * Absent must never be read as zero: a task nobody estimated is UNKNOWN work,
 * and counting it as free is how a plan reports itself as fitting when it does
 * not. {@link sumHours} returns the count of those separately so the page can
 * say so.
 */
export declare function itemHours(item: PlanItem): number | null;
/** Estimated hours across items, plus how many carry no estimate at all. */
export declare function sumHours(items: readonly PlanItem[]): {
    hours: number;
    unestimated: number;
};
/**
 * Measured capacity over the trailing window: what actually got FINISHED, in
 * estimated hours, on the days that finished anything.
 *
 * Three decisions worth stating, because each is a way to get this wrong:
 *
 * - **Only sampled days count.** A day with nothing completed is NOT read as a
 *   zero-output day — it may be a day off, and averaging it in would report a
 *   collapse in capacity that never happened.
 * - **No samples yields null, never 0.** "No data yet" and "you achieve
 *   nothing" are different claims and only the first one is true on day one.
 * - **It averages finished work only**, so it is a LOWER bound on time spent:
 *   work in progress counts for nothing here. That direction is deliberate —
 *   the reading is used to set a budget, and a budget set from a floor is
 *   conservative rather than flattering.
 */
export declare function measureCapacity(plans: readonly DayPlan[], today: string, budgetHours: number, windowDays?: number): CapacityReading;
/** The target day's load against the budget, plus the measured capacity. */
export declare function summarizeBuild(items: readonly PlanItem[], plans: readonly DayPlan[], today: string, budgetHours: number, windowDays?: number): BuildSummary;
/**
 * One project's burn: build-days consumed against its stored `effortDays`.
 *
 * `unestimatedDone` is returned rather than folded in, because it is the honest
 * caveat on the number beside it: every completed task with no estimate makes
 * `consumedDays` a LOWER bound. A project showing "1.2 of 5 days" whose twenty
 * finished tasks carried no estimates has not been measured at all, and the
 * page has to be able to say that instead of implying it is on track.
 *
 * `ratio` is null while the consumed side is zero, so a project that has not
 * been worked cannot read as "0% — comfortably inside estimate".
 */
export declare function summarizeBurn(project: Project, plans: readonly DayPlan[], budgetHours: number): ProjectBurn;
