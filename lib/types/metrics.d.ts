/**
 * Pure metric and calendar logic. No IO, no host services: every function is
 * a deterministic fold over DayPlan values, unit-tested in tests/metrics.test.ts.
 *
 * Calendar convention: all date keys are the USER's local calendar dates
 * (YYYY-MM-DD strings). Arithmetic uses Date.UTC exclusively so DST gaps and
 * timezone offsets can never shift a day boundary — the same trap that bit
 * pon-honor-system (UTC formatting vs local-day comparison) is avoided by
 * treating date keys as opaque calendar labels.
 * @module dsh-daily-progress/metrics
 */
import type { DayPlan, WeekCell } from './types.ts';
/** Add (possibly negative) calendar days to a date key. */
export declare function addDays(key: string, delta: number): string;
/** The seven date keys of the Monday-first week containing `today`, oldest first. */
export declare function weekKeys(today: string): string[];
/** Completion rate of one plan: null when the day has no plan, 0..1 otherwise. */
export declare function dayRate(plan: DayPlan | null): number | null;
/** An achieved day: has at least one item and every item is done. */
export declare function isAchieved(plan: DayPlan | null): boolean;
/**
 * Consecutive achieved days ending at `today` when today is achieved, or at
 * yesterday otherwise — an unachieved today PAUSES the streak, it does not
 * break it. Walks at most `cap` days back.
 */
export declare function computeStreak(lookup: (date: string) => DayPlan | null, today: string, cap?: number): number;
/**
 * Build the week heatmap cells for the Monday-first week containing `today`.
 * Future days (after today) render as plan-less cells: plans already written
 * for them exist but do not count toward this week's rate yet.
 */
export declare function weekCells(lookup: (date: string) => DayPlan | null, today: string): WeekCell[];
/**
 * Week completion rate: all items of the current week through TODAY,
 * done/total; null when no items exist yet. Future days of the week are
 * deliberately excluded — tomorrow's undone plan must not lower today's rate.
 */
export declare function weekRate(lookup: (date: string) => DayPlan | null, today: string): number | null;
/**
 * Lazy cross-day rollover: when today has no record yet, yesterday's undone
 * items are carried into today as `origin:'carried'`. Idempotent — returns
 * the existing record untouched when one already exists. Returns the plan to
 * store (or null for a no-op) and whether a record was created.
 */
export declare function rollover(yesterday: DayPlan | null, today: DayPlan | null, todayKey: string, tz: string, nowIso: string): {
    plan: DayPlan | null;
    created: boolean;
};
