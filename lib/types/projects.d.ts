/**
 * Project ranking. Pure, no IO, unit-tested in tests/projects.test.ts — the
 * planner and the page both consume it, so ordering cannot differ between them.
 *
 * METHOD — WSJF (Weighted Shortest Job First: Cost of Delay / Job Duration),
 * weighted for a solo operator whose goal is the FIRST dollar fast:
 *
 *   expectedMonthly = revenuePerMonth x confidence          (value, honesty-scaled)
 *   timeDiscount    = 1 / (1 + ttfdDays / 30)               (a first dollar a month out counts ~half)
 *   urgency         = 1 + 0.15 x (forcingFunction - 1)      (1.00-1.60; a live forcing function compresses the window)
 *   score           = expectedMonthly x timeDiscount x urgency / max(effortDays, 1)
 *
 * Units: **expected currency per month, per day of build effort**. Ranking by it
 * is literally "what makes money fastest for the work it costs": value rises
 * with revenue and with urgency, falls with time-to-first-dollar, and is divided
 * by complexity. Every input is shown in the UI so the order is auditable.
 *
 * The rubric deliberately does NOT feed the score. Averaging the dimensions
 * would produce one fake score and hide the dimension that is the real risk, so
 * the weakest one is reported alongside the score instead of being blended in.
 *
 * @module dsh-daily-progress-tab/projects
 */
import type { Checkin, Monitoring, Project, ProjectRubric, ProjectScore, ProjectSparks, RankedProject, RubricDimension, Spark, SparkBoard } from './types.ts';
export declare const MAX_TTFD_DAYS = 3650;
export declare const MAX_EFFORT_DAYS = 3650;
export declare const MAX_NAME = 120;
export declare const MAX_FULFILLS = 500;
export declare const MAX_SUMMARY = 2000;
export declare const MAX_KILL_SWITCH = 300;
/** Mid rubric when nothing is supplied: neither a strength nor a red flag. */
export declare const DEFAULT_RUBRIC: ProjectRubric;
export declare const PROJECT_STATUSES: readonly ["idea", "active", "parked", "shipped", "killed"];
/**
 * Statuses that mean "not started, or deliberately on hold" — the PENDING column.
 *
 * The split is by STATUS, not by score, because that is the question the two
 * columns answer: "what are we working on?" (active/shipped) versus "what is
 * waiting for us?" (idea/parked). A pending project keeps its score and its rank
 * — deferred is not the same as unmeasured — and nothing is shown twice.
 */
export declare const PENDING_STATUSES: readonly ["idea", "parked"];
/** Shipped — the project is in the world and must now be MEASURED. */
/** True when a project belongs in the Pending column. */
export declare function isPending(project: Project): boolean;
/** Score one project. Pure; no IO, no clock. */
export declare function scoreProject(project: Project): ProjectScore;
export declare const LIVE_STATUSES: readonly ["shipped"];
/** A shipped project with no check-in for longer than this is flagged stale. */
export declare const STALE_CHECKIN_DAYS = 7;
export declare const MAX_METRIC_NAME = 60;
export declare const MAX_CHECKIN_TEXT = 500;
/** Sparks captured in one check-in. Bounded like hurdles, so a record stays readable. */
export declare const MAX_SPARKS = 20;
/** The status vocabulary of a spark: open until it is promoted or dismissed. */
export declare const SPARK_STATUSES: readonly ["open", "promoted", "dismissed"];
/**
 * An open spark older than this is a decision avoided, not an idea held. Longer
 * than STALE_CHECKIN_DAYS on purpose: a weekly cadence must not make every idea
 * look overdue the moment it is written down, or the nag becomes noise.
 */
export declare const SPARK_TRIAGE_DAYS = 14;
/** True when a project belongs in the Live column. */
export declare function isLive(project: Project): boolean;
/**
 * Fold a project's check-ins into the monitoring state the Live column shows.
 *
 * Everything here is derived on read, so the summary can never disagree with the
 * check-ins behind it. `today` is passed in rather than read from a clock, which
 * keeps this pure and unit-testable — and means "stale" is decided by the
 * calendar the page is showing, not by the host's wall time.
 */
export declare function summarizeMonitoring(project: Project, checkins: readonly Checkin[], today: string): Monitoring;
/**
 * Counts for one project's OPEN/decided sparks. `sparks` must already be that
 * project's own — attribution happens in rankProjects, where the source id is
 * still meaningful.
 */
export declare function summarizeSparks(sparks: readonly Spark[], today: string): ProjectSparks;
/**
 * The whole spark board: the open queue, the decided history, the counts, and
 * the triage clock. Derived on every read like the monitoring summary, so the
 * clock cannot drift from the sparks behind it.
 */
export declare function sparkBoard(sparks: readonly Spark[], today: string): SparkBoard;
/** Shipped — the project is in the world and must now be MEASURED. */
export declare function rankProjects(projects: readonly Project[], checkins?: readonly Checkin[], today?: string, sparks?: readonly Spark[]): RankedProject[];
export type Normalized<T> = {
    ok: true;
    value: T;
} | {
    ok: false;
    message: string;
};
/** Validate a rubric, filling unrated dimensions with the neutral 3. */
export declare function normalizeRubric(raw: unknown): Normalized<ProjectRubric>;
/**
 * Validate and build a project. With `existing`, unspecified fields keep their
 * current value (a patch); without it, unspecified optional fields default.
 */
export declare function normalizeProject(raw: Record<string, unknown>, options: {
    id: string;
    nowIso: string;
    existing?: Project;
}): Normalized<Project>;
/**
 * Split a ranked list into in-flight work and pending work, preserving the ranked
 * order inside each part and keeping the ORIGINAL rank numbers — a card must never
 * appear to have moved just because it changed column.
 */
export declare function partitionProjects(ranked: readonly RankedProject[]): {
    working: Array<{
        project: RankedProject;
        rank: number;
    }>;
    pending: Array<{
        project: RankedProject;
        rank: number;
    }>;
    live: Array<{
        project: RankedProject;
        rank: number;
    }>;
    closed: Array<{
        project: RankedProject;
        rank: number;
    }>;
};
/** Human-readable one-liner for a score, used by the UI and the agent tools. */
export declare function describeScore(project: Project, score: ProjectScore): string;
export type { RubricDimension };
