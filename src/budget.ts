/**
 * The build budget's vocabulary, in a LEAF module that imports nothing.
 *
 * These constants first lived in `domain.ts`, which was the obvious home and the
 * wrong one: `domain.ts` already imports `MAX_NAME` from `projects.ts`, so the
 * moment `projects.ts` imported a constant back from `domain.ts` the two closed
 * a cycle. Under it, whichever module loaded second saw the other's `const`
 * bindings before initialization and died with
 * `ReferenceError: Cannot access 'MAX_NAME' before initialization` — a failure
 * two test files caught and no amount of reading the diff would have.
 *
 * **A module that imports nothing can be imported from anywhere.** Constants
 * shared across a cyclic graph belong in one.
 *
 * @module dsh-daily-progress-tab/budget
 */

/**
 * **One build-day is five hours.** The unit was previously undefined, which made
 * `effortDays` an unlabelled divisor in the ranking —
 * `score = expectedMonthly × timeDiscount × urgency / max(effortDays, 1)` — so
 * every score rested on an assumption nobody had written down.
 */
export const HOURS_PER_BUILD_DAY = 5

export const MIN_TASK_HOURS = 0.25
export const MAX_TASK_HOURS = 24
export const MIN_BUDGET_HOURS = 0.5
export const MAX_BUDGET_HOURS = 24

/**
 * The daily budget used when a store has never had one written.
 *
 * **PROVISIONAL — to be MEASURED, not assumed.** If real capacity is 10 h/week
 * and this says 25, every project reads 2.5× over estimate and the feedback
 * becomes noise, which is how a good metric gets ignored. `measureCapacity()`
 * reports the observed figure so this can be replaced by evidence.
 */
export const DEFAULT_BUDGET_HOURS = 5

/** Trailing days the measured capacity averages over. */
export const CAPACITY_WINDOW_DAYS = 7

/** How many estimate revisions are kept per project. Bounded so the record cannot grow forever. */
export const MAX_EFFORT_REVISIONS = 20

/** At or above this multiple of estimate, the build stops and is re-estimated. */
export const OVERRUN_STOP_RATIO = 1.5
