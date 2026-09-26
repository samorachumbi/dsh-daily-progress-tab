/**
 * Shared wire types for the daily-progress domain. These are the shapes the
 * host routes serve, the agent tools return, and the planner page consumes;
 * keep them JSON-safe and free of implementation classes.
 */
/** Origin of one plan item. */
export type ItemOrigin = 'today' | 'carried' | 'tomorrow-write';
/**
 * Why a task is in the pool: `overdue` is an undone task on a PAST day (it did
 * not get done and is still asking), `upcoming` is one on a future day — tomorrow
 * or later. The board sorts by this, so the reason a task is on offer is visible
 * rather than inferred from its date.
 */
export type PoolBucket = 'overdue' | 'upcoming';
/**
 * One task the operator could choose to work on but that is NOT on today: it
 * lives on another day. Carries its date, because that is what makes it
 * addressable — a task can only be moved once you know which day holds it.
 */
export interface PoolEntry {
    /** The local date the task currently sits on. */
    date: string;
    bucket: PoolBucket;
    item: PlanItem;
}
/**
 * The task being worked on right now. Distinct from the selected PROJECT:
 * choosing a project says what you are building this season, choosing a task
 * says what you are doing in the next hour. Resolved fresh on every read, so a
 * completed or deleted task can never stay "current".
 */
export interface NowTask {
    /** The local date the task sits on today. */
    date: string;
    item: PlanItem;
}
/**
 * A task that EXISTS but is not scheduled on any day: the menu the operator
 * chooses from.
 *
 * This is the piece that was missing. Before it, a task came into existence
 * already attached to a date, so the only tasks that could be chosen were the
 * ones the board had already put in front of you — "work on any task" had
 * nothing to refer to. A backlog item is undated: it waits on its project until
 * someone pulls it into a day, which is what makes the choice real.
 */
export interface BacklogItem {
    id: string;
    /** The project this candidate task belongs to. */
    projectId: string;
    text: string;
    /** One line on what the task actually implements, carried onto the plan item. */
    summary?: string;
    createdAt: string;
}
/** What clicking a suggestion chip does. */
export type SuggestionAction = 'info' | 'complete' | 'defer' | 'split' | 'retitle' | 'drop';
/**
 * One agent-authored suggestion attached to a plan item. Suggestions are
 * written by the `daily_suggest` tool (the model authors them) and rendered as a
 * chip row under the task; the page applies them through the server so the
 * semantics live in one place.
 *
 * `info` is purely explanatory — the page shows `detail` without a round trip.
 * Every other action mutates, and carries what it needs:
 * `defer` → `date`, `split` → `items`, `retitle` → `text`.
 */
export interface TaskSuggestion {
    id: string;
    /** Short chip label, at most 60 chars. */
    label: string;
    action: SuggestionAction;
    /** Longer explanation, shown for `info` and as a tooltip. */
    detail?: string;
    /** `defer` target: YYYY-MM-DD, or the literal `tomorrow`. */
    date?: string;
    /** `split` replacement texts (1-50 chars each). */
    items?: string[];
    /** `retitle` replacement text. */
    text?: string;
}
/** One checklist entry of a daily plan. */
export interface PlanItem {
    /** Stable id (UUID); preserved when an item is carried into tomorrow. */
    id: string;
    /** Trimmed, non-empty text, at most 500 chars. */
    text: string;
    done: boolean;
    /** ISO 8601 instant of the last check, null when undone. */
    doneAt: string | null;
    origin: ItemOrigin;
    /** Project this task implements, when it belongs to one. */
    projectId?: string;
    /** One line on what this task actually implements — its summary box. */
    summary?: string;
    /** Model-authored chips; absent on records written before this field existed. */
    suggestions?: TaskSuggestion[];
}
/** One user-local calendar day of plans. `date` is the user's LOCAL date (YYYY-MM-DD), never UTC. */
export interface DayPlan {
    date: string;
    /** IANA zone the writing client reported; recorded for display only, never used in date math. */
    tz: string;
    items: PlanItem[];
    updatedAt: string;
}
/** One week heatmap cell (Monday-first). `rate` is null when the day has no plan. */
export interface WeekCell {
    date: string;
    total: number;
    done: number;
    rate: number | null;
}
/** The snapshot the page renders: today, tomorrow, week cells, streak, week rate. */
export interface Snapshot {
    today: DayPlan | null;
    tomorrow: DayPlan | null;
    week: WeekCell[];
    /** Consecutive achieved days ending today (if today achieved) or yesterday. */
    streak: number;
    /** Week done/total across all items of the current week; null when the week has no items yet. */
    weekRate: number | null;
    /** Every project, ranked by {@link scoreProject} — fastest money per day of effort first. */
    projects: RankedProject[];
    /** The project currently being executed, if one is chosen. */
    selectedProjectId: string | null;
    /** The single task being worked on right now, if one is picked. */
    now: NowTask | null;
    /**
     * Every undone task that is NOT on today, so the operator can choose any of
     * them instead of only what the plan already put in front of them. Ordered by
     * the planner (overdue first, most recent first, then upcoming by date) — the
     * page renders it in order and never re-sorts.
     */
    pool: PoolEntry[];
    /**
     * Every candidate task of every project, unscheduled. Oldest first, so a
     * project's list reads as a queue. The page groups by `projectId` and does not
     * re-sort.
     */
    backlog: BacklogItem[];
    /**
     * The spark board: business ideas sparked by live feedback, with the triage
     * clock. Derived on every read, like the monitoring summary.
     */
    sparks: SparkBoard;
}
/** Which day a mutation addresses. */
export type PlanTarget = 'today' | 'tomorrow';
/** The seven rubric dimensions, reused verbatim from the vault's own
 * `business-idea-generator` skill so the planner scores ideas the same way the
 * research memos do. Each is rated 1-5. */
export declare const RUBRIC_DIMENSIONS: readonly ["forcingFunction", "competitionThinness", "assetLightness", "aiRunnability", "distribution", "moat", "regulatoryCost"];
export type RubricDimension = (typeof RUBRIC_DIMENSIONS)[number];
/** 1 (weak) to 5 (strong) for each dimension. */
export type ProjectRubric = Record<RubricDimension, number>;
export type ProjectStatus = 'idea' | 'active' | 'parked' | 'shipped' | 'killed';
/**
 * One money-making project. The ranking inputs are deliberately explicit and
 * few, so the ordering can be audited rather than trusted: revenue and time to
 * the FIRST dollar drive it, effort divides it (WSJF), and the rubric records
 * which dimension is the real risk.
 */
export interface Project {
    id: string;
    name: string;
    /** One sentence: who it serves and what need it fulfils. The summary-box headline. */
    fulfills: string;
    /** Longer summary for the box: what "done" looks like and what it unblocks. */
    summary?: string;
    /** Days from starting to the FIRST dollar. null = not estimated yet, so it cannot be ranked. */
    ttfdDays: number | null;
    /** Build effort in days. null = not estimated yet. */
    effortDays: number | null;
    /** Expected revenue per month once running, in `currency`. null = not estimated yet. */
    revenuePerMonth: number | null;
    currency: string;
    /** 0-1 confidence in the revenue estimate; scales it down honestly. */
    confidence: number;
    rubric: ProjectRubric;
    status: ProjectStatus;
    /** Falsifiable kill-switch, e.g. "first paid deal by day 30". */
    killSwitch?: string;
    /**
     * The ONE number that matters once this project ships — e.g. "paid retainers".
     * Optional: a live board carrying ten numbers per venture gets ignored.
     */
    metricName?: string;
    createdAt: string;
    updatedAt: string;
}
/** Derived ordering facts. Never stored — recomputed on read so it cannot drift. */
export interface ProjectScore {
    /** Expected currency per month, per day of build effort. Higher = start sooner. null when unestimated. */
    score: number | null;
    /** revenuePerMonth x confidence. */
    expectedMonthly: number | null;
    /** 1/(1 + ttfdDays/30): a first dollar a month away counts about half. */
    timeDiscount: number;
    /** 1 + 0.15 x (forcingFunction - 1), i.e. 1.00-1.60. A live forcing function compresses the window. */
    urgency: number;
    /** The lowest-rated dimension — per the vault rubric, this is the real risk, not an average. */
    weakestDimension: RubricDimension;
    /** True when ttfdDays, effortDays or revenuePerMonth is missing, so no score can be computed. */
    unestimated: boolean;
}
export type CheckinVerdict = 'continue' | 'fix' | 'kill' | 'pause';
/** One hurdle or correction, tracked until it is closed. */
export interface CheckinItem {
    id: string;
    text: string;
    done: boolean;
    /** When it was opened. */
    at: string;
    /** When it was closed, or null while open. */
    closedAt: string | null;
}
/**
 * One dated check-in for a shipped project — the unit of the feedback loop.
 * `metric` is the project's ONE number that matters; `revenue` is money taken in
 * THIS period, not cumulative (the summary sums it).
 */
export interface Checkin {
    projectId: string;
    date: string;
    metric: number | null;
    metricNote: string | null;
    revenue: number | null;
    customers: number | null;
    progress: string | null;
    verdict: CheckinVerdict;
    note: string | null;
    hurdles: CheckinItem[];
    corrections: CheckinItem[];
    createdAt: string;
    updatedAt: string;
}
/**
 * Derived monitoring state for one shipped project. Never stored: recomputed on
 * every read so it cannot drift from the check-ins it summarises.
 */
export interface Monitoring {
    checkins: number;
    liveSince: string | null;
    lastCheckin: string | null;
    daysSinceCheckin: number | null;
    /** True when the loop has gone quiet for longer than STALE_CHECKIN_DAYS. */
    stale: boolean;
    totalRevenue: number;
    lastRevenue: number | null;
    customers: number | null;
    metricName: string | null;
    latestMetric: number | null;
    /** Change in the one metric since the previous check-in. */
    metricDelta: number | null;
    openHurdles: CheckinItem[];
    openCorrections: CheckinItem[];
    doneCorrections: number;
    verdict: CheckinVerdict | null;
    /** What the most recent check-in said actually advanced. */
    lastProgress: string | null;
}
export type SparkStatus = 'open' | 'promoted' | 'dismissed';
/**
 * One business idea sparked by feedback from a live project.
 *
 * Keyed by its OWN id and referencing its source by plain strings rather than a
 * join, on purpose. `removeProject` deletes a project's check-ins, and the
 * moment a venture dies is exactly when its sparks are worth most — a project
 * that failed because of hurdle X is telling you hurdle X IS the business. Stored
 * inside the check-in, the `kill` verdict would destroy the leads it generated,
 * so a spark outlives the venture that produced it. The source NAME is frozen at
 * capture for the same reason: after a deletion there is nothing left to look it
 * up from, and "sparked by —" is a worse record than a stale name.
 */
export interface Spark {
    id: string;
    text: string;
    /** The venture whose feedback sparked this. A hint for navigation; may dangle. */
    sourceProjectId: string | null;
    /** The source project's name AT CAPTURE, so the record still reads after deletion. */
    sourceProjectName: string | null;
    /** The check-in date it came from, when it came from one. */
    sourceDate: string | null;
    status: SparkStatus;
    /** Set when promoted: the pending project it became. */
    promotedProjectId: string | null;
    /** Set when dismissed: why the option was burned. */
    dismissedReason: string | null;
    createdAt: string;
    updatedAt: string;
}
/** Derived spark counts for one project. Never stored. */
export interface ProjectSparks {
    total: number;
    open: number;
    promoted: number;
    dismissed: number;
    /** Age in days of the oldest OPEN spark; null when none are open. */
    oldestOpenDays: number | null;
    /** True when the oldest open spark has waited longer than SPARK_TRIAGE_DAYS. */
    triageDue: boolean;
}
/**
 * The derived triage state of the spark board. Never stored: recomputed on every
 * read, so the clock cannot drift from the sparks behind it.
 *
 * The clock is the point. A capture surface with no clock becomes a museum that
 * feels like progress, so this reports how long the oldest undecided idea has
 * waited — the same mechanism that gives the Live column its teeth.
 */
export interface SparkBoard extends ProjectSparks {
    /** Every open spark, oldest first: the queue awaiting a decision. */
    openSparks: Spark[];
    /**
     * Every decided spark, newest first. Kept so a dismissal's reason stays
     * readable: "a dead end stays dead, with the reason" is a rule the register
     * already follows for killed projects, and it only holds if the reason is
     * still there to read.
     */
    decidedSparks: Spark[];
    /** How many sparks have actually been decided (promoted + dismissed). */
    decided: number;
}
export interface RankedProject extends Project {
    score: ProjectScore;
    /**
     * Derived, never stored: true when the project is not started or is on hold
     * (status `idea` or `parked`). Drives the Pending column, so the rule lives in
     * one place — `isPending()` — instead of being re-implemented in the page.
     */
    pending: boolean;
    /** True when the project has SHIPPED and is therefore being measured. */
    live: boolean;
    /** Derived from the project's check-ins; see summarizeMonitoring. */
    monitoring: Monitoring;
    /** Derived from the sparks this project's feedback produced; see summarizeSparks. */
    sparkSummary: ProjectSparks;
}
/** Mutation request body. */
export interface MutateRequest {
    /** User-local calendar date of the requesting client, YYYY-MM-DD. Omitted by agent tools, which resolve it from the configured zone. */
    localDate?: string;
    /** IANA zone of the requesting client (recorded only). */
    tz?: string;
    op: MutateOp;
    payload: Record<string, unknown>;
}
export type MutateOp = 'toggleItem' | 'logCheckin' | 'checkinItem' | 'addItem' | 'removeItem' | 'editItemText' | 'setTomorrow' | 'clearToday'
/** Move one item to another date (the `defer` suggestion). */
 | 'moveItem'
/** Choose — or with a null itemId clear — the one task being worked on now. */
 | 'selectItem'
/** Swap one item with its neighbour on the same day, so the order is the operator's. */
 | 'reorderItem'
/** Replace one item with several (the `split` suggestion). */
 | 'splitItem'
/** Replace an item's suggestion chips. */
 | 'setSuggestions'
/** Apply one suggestion chip by id. */
 | 'applySuggestion'
/** Patch one item's text, summary box or project link. */
 | 'updateItem' | 'addProject' | 'updateProject' | 'removeProject'
/** Choose the project being executed. */
 | 'selectProject'
/** Add a candidate task to a project's backlog (undated). */
 | 'addBacklogItem'
/** Rename a backlog candidate. */
 | 'editBacklogItem'
/** Drop a backlog candidate without ever scheduling it. */
 | 'removeBacklogItem'
/** Pull a backlog candidate onto a day: creates the plan item AND clears the backlog row, atomically. */
 | 'planBacklogItem'
/** Capture a business idea sparked by live feedback. */
 | 'sparkAdd'
/** Turn a spark into a pending project, UNRANKED until it is estimated. */
 | 'sparkPromote'
/** Close a spark without starting it, recording why the option was burned. */
 | 'sparkDismiss';
/** Business error codes the routes and tools return. */
export type MutateErrorCode = 'invalid_local_date' | 'invalid_tz' | 'unknown_op' | 'invalid_payload' | 'item_not_found' | 'suggestion_not_found' | 'project_not_found' | 'spark_not_found' | 'plan_locked' | 'too_many_items' | 'empty_text' | 'internal';
export type MutateResult = {
    ok: true;
    snapshot: Snapshot;
} | {
    ok: false;
    code: MutateErrorCode;
    message: string;
};
