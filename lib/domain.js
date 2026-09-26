/**
 * Domain declaration and record schemas. The domain rides the host's
 * storage-domain facility (`ctx.storageDomain`) and is routed to whatever
 * backend the deployment configured (the standard web composition: json).
 *
 * The domain name is `daily_progress_tab`, deliberately distinct from the
 * upstream plugin's `daily_progress`: a domain name may be open only once per
 * process, so a distinct name lets this fork coexist with an upstream install
 * instead of failing open with `already-open`.
 *
 * The version stays at 1 even though `projects` and `global` were added later.
 * Bumping it would make the existing medium — already stamped version 1 —
 * reject at open, i.e. the plugin would refuse to start on the very store it
 * created. A new table simply loads empty and the unwritten global falls back to
 * its initial value, so no migration is needed.
 *
 * Optional fields are optional for the same reason: a required field would fail
 * every record written before it existed with `invalid-record` and the domain
 * would refuse to open.
 *
 * Record keys are `<scope>:<date>` for plans (see calendar.ts); V1 uses scope
 * `'default'`.
 * @module dsh-daily-progress-tab/domain
 */
import z from 'zod';
import { defineDomain } from '@deepseek-ai/dsh-storage-domain';
import { DATE_RE } from "./calendar.js";
import { MAX_CHECKIN_TEXT, MAX_EFFORT_DAYS, MAX_FULFILLS, MAX_KILL_SWITCH, MAX_METRIC_NAME, MAX_NAME, MAX_SUMMARY, MAX_TTFD_DAYS, PROJECT_STATUSES, SPARK_STATUSES } from "./projects.js";
/** Chips per item. Keeps a task row readable and bounds what one suggest call writes. */
export const MAX_SUGGESTIONS = 6;
/** Hurdles/corrections tracked per check-in. Bounded so one record stays readable. */
export const MAX_CHECKIN_ITEMS = 20;
/** The verdict vocabulary: what the check-in decided to DO about the project. */
export const CHECKIN_VERDICTS = ['continue', 'fix', 'kill', 'pause'];
const SUGGESTION_ACTIONS = ['info', 'complete', 'defer', 'split', 'retitle', 'drop'];
const TaskSuggestionSchema = z.object({
    id: z.string().min(1).max(64),
    label: z.string().min(1).max(60),
    action: z.enum(SUGGESTION_ACTIONS),
    detail: z.string().max(500).optional(),
    date: z.string().max(10).optional(),
    items: z.array(z.string().min(1).max(500)).max(20).optional(),
    text: z.string().min(1).max(500).optional(),
});
const PlanItemSchema = z.object({
    id: z.string().min(1).max(64),
    text: z.string().min(1).max(500),
    done: z.boolean(),
    doneAt: z.string().nullable(),
    origin: z.enum(['today', 'carried', 'tomorrow-write']),
    projectId: z.string().max(64).optional(),
    summary: z.string().max(500).optional(),
    suggestions: z.array(TaskSuggestionSchema).max(MAX_SUGGESTIONS).optional(),
});
const DayPlanSchema = z.object({
    date: z.string().regex(DATE_RE),
    tz: z.string().max(64),
    items: z.array(PlanItemSchema).max(50),
    updatedAt: z.string(),
});
/** 1 (weak) to 5 (strong); mirrors RUBRIC_DIMENSIONS in projects.ts. */
const rating = z.number().int().min(1).max(5);
const ProjectRubricSchema = z.object({
    forcingFunction: rating,
    competitionThinness: rating,
    assetLightness: rating,
    aiRunnability: rating,
    distribution: rating,
    moat: rating,
    regulatoryCost: rating,
});
const ProjectSchema = z.object({
    id: z.string().min(1).max(64),
    name: z.string().min(1).max(MAX_NAME),
    fulfills: z.string().min(1).max(MAX_FULFILLS),
    summary: z.string().max(MAX_SUMMARY).optional(),
    /** null = not estimated yet, which keeps the project out of the ranking. */
    ttfdDays: z.number().min(0).max(MAX_TTFD_DAYS).nullable(),
    effortDays: z.number().min(0.5).max(MAX_EFFORT_DAYS).nullable(),
    revenuePerMonth: z.number().min(0).nullable(),
    currency: z.string().min(1).max(8),
    confidence: z.number().min(0).max(1),
    rubric: ProjectRubricSchema,
    status: z.enum(PROJECT_STATUSES),
    killSwitch: z.string().max(MAX_KILL_SWITCH).optional(),
    /** The one number that matters for this project. Optional: every record written before it existed stays valid. */
    metricName: z.string().min(1).max(MAX_METRIC_NAME).optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
});
/**
 * Domain global singleton: which project is being executed, and which single
 * task is being worked on right now. A global rather than per-row flags because
 * "the one we are working on" is genuinely singular in both cases.
 *
 * The object itself must reject `null` (the medium's "never written" sentinel),
 * which it does — only the inner fields are nullable.
 *
 * The two task fields are OPTIONAL on purpose. A global written before they
 * existed has no such keys, and a required field would fail that record with
 * `invalid-record` — the domain would then refuse to open on its own store. The
 * version stays 1 for the same reason. `selectedItemDate` is stored beside the
 * id only as a hint for a cheap lookup; the planner re-resolves the id across
 * days and ignores the hint when it has gone stale, so a moved task cannot
 * leave a dangling selection behind.
 */
const GlobalSchema = z.object({
    selectedProjectId: z.string().nullable(),
    selectedItemId: z.string().max(64).nullable().optional(),
    selectedItemDate: z.string().max(10).nullable().optional(),
    updatedAt: z.string(),
});
const CheckinItemSchema = z.object({
    id: z.string().min(1).max(64),
    text: z.string().min(1).max(MAX_CHECKIN_TEXT),
    done: z.boolean(),
    at: z.string(),
    closedAt: z.string().nullable(),
});
/**
 * One check-in record. Keyed `<projectId>:<date>` so a re-run on the same day
 * updates that day's entry instead of piling up duplicates.
 */
const CheckinSchema = z.object({
    projectId: z.string().min(1).max(64),
    date: z.string().regex(DATE_RE),
    metric: z.number().nullable(),
    metricNote: z.string().max(MAX_CHECKIN_TEXT).nullable(),
    /** Money taken in THIS period. The summary sums it; it is not cumulative. */
    revenue: z.number().min(0).nullable(),
    customers: z.number().min(0).nullable(),
    progress: z.string().max(MAX_CHECKIN_TEXT).nullable(),
    verdict: z.enum(CHECKIN_VERDICTS),
    note: z.string().max(MAX_CHECKIN_TEXT).nullable(),
    hurdles: z.array(CheckinItemSchema).max(MAX_CHECKIN_ITEMS),
    corrections: z.array(CheckinItemSchema).max(MAX_CHECKIN_ITEMS),
    createdAt: z.string(),
    updatedAt: z.string(),
});
/**
 * One business idea sparked by feedback from a live project.
 *
 * Keyed by its OWN id, never by project. A spark is not a child of the venture
 * that produced it but a lead it produced: `removeProject` deletes a project's
 * check-ins, and the moment a venture dies is exactly when its sparks are worth
 * most. `sourceProjectId` is therefore a soft reference that is ALLOWED to
 * dangle, and `sourceProjectName` is frozen at capture so the record still says
 * where it came from after the venture is gone.
 */
const SparkSchema = z.object({
    id: z.string().min(1).max(64),
    text: z.string().min(1).max(MAX_CHECKIN_TEXT),
    sourceProjectId: z.string().max(64).nullable(),
    sourceProjectName: z.string().max(MAX_NAME).nullable(),
    sourceDate: z.string().max(10).nullable(),
    status: z.enum(SPARK_STATUSES),
    promotedProjectId: z.string().max(64).nullable(),
    dismissedReason: z.string().max(MAX_CHECKIN_TEXT).nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
});
/**
 * One unscheduled candidate task. Keyed by its own id (not by project): a
 * backlog item is pulled onto a day by id alone, and the project it belongs to
 * travels on the record.
 */
const BacklogItemSchema = z.object({
    id: z.string().min(1).max(64),
    projectId: z.string().min(1).max(64),
    text: z.string().min(1).max(500),
    summary: z.string().max(500).optional(),
    createdAt: z.string(),
});
/** The domain spec: one `plans` table per (scope, date), plus `projects`, `checkins`, `backlog` and `sparks`. */
export const dailyProgressDomain = defineDomain({
    name: 'daily_progress_tab',
    version: 1,
    global: {
        schema: GlobalSchema,
        initial: { selectedProjectId: null, selectedItemId: null, selectedItemDate: null, updatedAt: '' },
    },
    tables: {
        plans: {
            valueSchema: DayPlanSchema,
        },
        projects: {
            valueSchema: ProjectSchema,
        },
        checkins: {
            valueSchema: CheckinSchema,
        },
        backlog: {
            valueSchema: BacklogItemSchema,
        },
        sparks: {
            valueSchema: SparkSchema,
        },
    },
});
