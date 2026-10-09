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
import { CAPACITY_WINDOW_DAYS, DEFAULT_BUDGET_HOURS, MAX_BUDGET_HOURS, MIN_BUDGET_HOURS, OVERRUN_STOP_RATIO, } from "./budget.js";
import { addDays } from "./metrics.js";
/** Rounded to 2dp, so floating-point noise never reaches the page. */
const round2 = (value) => Math.round(value * 100) / 100;
/**
 * The stored budget, clamped, falling back to the default.
 *
 * A budget that is absent, null, NaN or out of range resolves to
 * {@link DEFAULT_BUDGET_HOURS} rather than to zero — a zero budget would make
 * every load ratio infinite and every project infinitely overrun.
 */
export function effectiveBudget(stored) {
    if (typeof stored !== 'number' || !Number.isFinite(stored))
        return DEFAULT_BUDGET_HOURS;
    return Math.min(Math.max(stored, MIN_BUDGET_HOURS), MAX_BUDGET_HOURS);
}
/**
 * Hours on an item, or null when it carries no usable estimate.
 *
 * Absent must never be read as zero: a task nobody estimated is UNKNOWN work,
 * and counting it as free is how a plan reports itself as fitting when it does
 * not. {@link sumHours} returns the count of those separately so the page can
 * say so.
 */
export function itemHours(item) {
    const hours = item.estHours;
    return typeof hours === 'number' && Number.isFinite(hours) && hours > 0 ? hours : null;
}
/** Estimated hours across items, plus how many carry no estimate at all. */
export function sumHours(items) {
    let hours = 0;
    let unestimated = 0;
    for (const item of items) {
        const value = itemHours(item);
        if (value === null)
            unestimated += 1;
        else
            hours += value;
    }
    return { hours: round2(hours), unestimated };
}
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
export function measureCapacity(plans, today, budgetHours, windowDays = CAPACITY_WINDOW_DAYS) {
    const days = Math.max(1, Math.floor(windowDays));
    const from = addDays(today, -(days - 1));
    const perDay = [];
    for (const plan of plans) {
        // YYYY-MM-DD compares correctly as a string, and the window is inclusive of today.
        if (plan.date < from || plan.date > today)
            continue;
        const { hours } = sumHours(plan.items.filter((item) => item.done));
        if (hours > 0)
            perDay.push(hours);
    }
    const samples = perDay.length;
    if (samples === 0)
        return { days, samples: 0, avgHours: null, ratio: null };
    const avgHours = round2(perDay.reduce((total, value) => total + value, 0) / samples);
    return {
        days,
        samples,
        avgHours,
        ratio: budgetHours > 0 ? round2(avgHours / budgetHours) : null,
    };
}
/** The target day's load against the budget, plus the measured capacity. */
export function summarizeBuild(items, plans, today, budgetHours, windowDays = CAPACITY_WINDOW_DAYS) {
    const planned = sumHours(items);
    const done = sumHours(items.filter((item) => item.done));
    return {
        plannedHours: planned.hours,
        doneHours: done.hours,
        unestimated: planned.unestimated,
        budgetHours: round2(budgetHours),
        load: budgetHours > 0 ? round2(planned.hours / budgetHours) : null,
        capacity: measureCapacity(plans, today, budgetHours, windowDays),
    };
}
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
export function summarizeBurn(project, plans, budgetHours) {
    let hours = 0;
    let unestimatedDone = 0;
    for (const plan of plans) {
        for (const item of plan.items) {
            if (item.projectId !== project.id || !item.done)
                continue;
            const value = itemHours(item);
            if (value === null)
                unestimatedDone += 1;
            else
                hours += value;
        }
    }
    const consumedDays = budgetHours > 0 ? round2(hours / budgetHours) : 0;
    const estimatedDays = project.effortDays;
    // An estimate recorded BEFORE the build-day unit existed cannot be divided
    // into: the numerator is hours and the denominator is a count of work-chunks.
    // So the ratio is WITHHELD rather than computed. A percentage that cannot be
    // supported is worse than no percentage, and a false overrun is worse still —
    // it would stop a build that is inside its real budget.
    const rated = project.effortUnit === 'build-day';
    const ratio = rated && estimatedDays !== null && estimatedDays > 0 && hours > 0
        ? round2(consumedDays / estimatedDays)
        : null;
    const ratioBlockedBy = ratio !== null
        ? undefined
        : estimatedDays === null
            ? 'no-estimate'
            : !rated
                ? 'pre-unit'
                : 'no-consumption';
    return {
        consumedDays,
        estimatedDays,
        ratio,
        ...(ratioBlockedBy === undefined ? {} : { ratioBlockedBy }),
        revisions: project.effortRevisions?.length ?? 0,
        unestimatedDone,
        overrun: ratio !== null && ratio >= OVERRUN_STOP_RATIO,
    };
}
