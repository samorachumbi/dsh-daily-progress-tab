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
 * The rubric deliberately does NOT feed the score. The vault's own rubric says
 * "don't average into a single fake score — call out which dimensions are strong
 * and which are the real risk", so the weakest dimension is reported alongside
 * the score instead of being blended into it.
 *
 * @module dsh-daily-progress-tab/projects
 */

import { RUBRIC_DIMENSIONS } from './types.ts'
import type { Checkin, CheckinItem, Monitoring, Project, ProjectRubric, ProjectScore, ProjectSparks, ProjectStatus, RankedProject, RubricDimension, Spark, SparkBoard } from './types.ts'

export const MAX_TTFD_DAYS = 3650
export const MAX_EFFORT_DAYS = 3650
export const MAX_NAME = 120
export const MAX_FULFILLS = 500
export const MAX_SUMMARY = 2000
export const MAX_KILL_SWITCH = 300

/** Mid rubric when nothing is supplied: neither a strength nor a red flag. */
export const DEFAULT_RUBRIC: ProjectRubric = {
  forcingFunction: 3,
  competitionThinness: 3,
  assetLightness: 3,
  aiRunnability: 3,
  distribution: 3,
  moat: 3,
  regulatoryCost: 3,
}

// `as const` (not an explicit annotation) so the zod enum in domain.ts keeps the
// literal union instead of widening `status` to string.
export const PROJECT_STATUSES = ['idea', 'active', 'parked', 'shipped', 'killed'] as const

/**
 * Statuses that mean "not started, or deliberately on hold" — the PENDING column.
 *
 * The split is by STATUS, not by score, because that is the question the two
 * columns answer: "what are we working on?" (active/shipped) versus "what is
 * waiting for us?" (idea/parked). A pending project keeps its score and its rank
 * — deferred is not the same as unmeasured — and nothing is shown twice.
 */
export const PENDING_STATUSES = ['idea', 'parked'] as const

/** Shipped — the project is in the world and must now be MEASURED. */
/** True when a project belongs in the Pending column. */
export function isPending(project: Project): boolean {
  return (PENDING_STATUSES as readonly string[]).includes(project.status)
}

/** Score one project. Pure; no IO, no clock. */
export function scoreProject(project: Project): ProjectScore {
  const rated = RUBRIC_DIMENSIONS.map((dimension) => ({ dimension, value: project.rubric[dimension] }))
  let weakest = rated[0]!
  for (const entry of rated) if (entry.value < weakest.value) weakest = entry

  const urgency = 1 + 0.15 * (project.rubric.forcingFunction - 1)

  const { ttfdDays, effortDays, revenuePerMonth } = project

  if (ttfdDays === null || effortDays === null || revenuePerMonth === null) {
    return {
      score: null,
      expectedMonthly: null,
      timeDiscount: 0,
      urgency,
      weakestDimension: weakest.dimension,
      unestimated: true,
    }
  }

  // Value is honesty-scaled by confidence, discounted the further away the first
  // dollar is, lifted by urgency, and divided by the effort it costs to build.
  const expectedMonthly = revenuePerMonth * project.confidence
  const timeDiscount = 1 / (1 + ttfdDays / 30)
  const effort = Math.max(effortDays, 1)
  return {
    score: (expectedMonthly * timeDiscount * urgency) / effort,
    expectedMonthly,
    timeDiscount,
    urgency,
    weakestDimension: weakest.dimension,
    unestimated: false,
  }
}

export const LIVE_STATUSES = ['shipped'] as const

/** A shipped project with no check-in for longer than this is flagged stale. */
export const STALE_CHECKIN_DAYS = 7

export const MAX_METRIC_NAME = 60
export const MAX_CHECKIN_TEXT = 500

/** Sparks captured in one check-in. Bounded like hurdles, so a record stays readable. */
export const MAX_SPARKS = 20

/** The status vocabulary of a spark: open until it is promoted or dismissed. */
export const SPARK_STATUSES = ['open', 'promoted', 'dismissed'] as const

/**
 * An open spark older than this is a decision avoided, not an idea held. Longer
 * than STALE_CHECKIN_DAYS on purpose: a weekly cadence must not make every idea
 * look overdue the moment it is written down, or the nag becomes noise.
 */
export const SPARK_TRIAGE_DAYS = 14

/** True when a project belongs in the Live column. */
export function isLive(project: Project): boolean {
  return (LIVE_STATUSES as readonly string[]).includes(project.status)
}

const DAY_MS = 86400000

/** Whole days from `a` to `b`, both YYYY-MM-DD. Pure; no clock. */
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY_MS)
}

/**
 * Fold a project's check-ins into the monitoring state the Live column shows.
 *
 * Everything here is derived on read, so the summary can never disagree with the
 * check-ins behind it. `today` is passed in rather than read from a clock, which
 * keeps this pure and unit-testable — and means "stale" is decided by the
 * calendar the page is showing, not by the host's wall time.
 */
export function summarizeMonitoring(project: Project, checkins: readonly Checkin[], today: string): Monitoring {
  const sorted = [...checkins].sort((a, b) => a.date.localeCompare(b.date))
  const first = sorted[0] ?? null
  const last = sorted.length > 0 ? sorted[sorted.length - 1]! : null
  const prev = sorted.length > 1 ? sorted[sorted.length - 2]! : null

  const openHurdles: CheckinItem[] = []
  const openCorrections: CheckinItem[] = []
  let doneCorrections = 0
  for (const entry of sorted) {
    for (const hurdle of entry.hurdles) if (!hurdle.done) openHurdles.push(hurdle)
    for (const fix of entry.corrections) {
      if (fix.done) doneCorrections += 1
      else openCorrections.push(fix)
    }
  }

  const totalRevenue = sorted.reduce((sum, entry) => sum + (entry.revenue ?? 0), 0)
  const daysSinceCheckin = last !== null && today !== '' ? Math.max(0, daysBetween(last.date, today)) : null

  return {
    checkins: sorted.length,
    liveSince: first === null ? null : first.date,
    lastCheckin: last === null ? null : last.date,
    daysSinceCheckin,
    stale: daysSinceCheckin !== null && daysSinceCheckin > STALE_CHECKIN_DAYS,
    totalRevenue,
    lastRevenue: last === null ? null : last.revenue,
    customers: last === null ? null : last.customers,
    metricName: project.metricName ?? null,
    latestMetric: last === null ? null : last.metric,
    metricDelta: last !== null && prev !== null && last.metric !== null && prev.metric !== null
      ? last.metric - prev.metric
      : null,
    openHurdles,
    openCorrections,
    doneCorrections,
    verdict: last === null ? null : last.verdict,
    lastProgress: last === null ? null : last.progress,
  }
}

/** The calendar day of an ISO timestamp, for age arithmetic. */
function isoDay(iso: string): string {
  return iso.slice(0, 10)
}

/** Whole days a spark has been waiting. `today` is passed in, never read. */
function sparkAgeDays(createdAt: string, today: string): number | null {
  if (today === '' || createdAt === '') return null
  return Math.max(0, daysBetween(isoDay(createdAt), today))
}

/**
 * Counts for one project's OPEN/decided sparks. `sparks` must already be that
 * project's own — attribution happens in rankProjects, where the source id is
 * still meaningful.
 */
export function summarizeSparks(sparks: readonly Spark[], today: string): ProjectSparks {
  let open = 0
  let promoted = 0
  let dismissed = 0
  let oldest: string | null = null
  for (const spark of sparks) {
    if (spark.status === 'promoted') promoted += 1
    else if (spark.status === 'dismissed') dismissed += 1
    else {
      open += 1
      if (oldest === null || spark.createdAt < oldest) oldest = spark.createdAt
    }
  }
  const oldestOpenDays = oldest === null ? null : sparkAgeDays(oldest, today)
  return {
    total: sparks.length,
    open,
    promoted,
    dismissed,
    oldestOpenDays,
    // The clock is computed HERE and nowhere else, so neither the page nor the
    // tools carries its own copy of the threshold to drift from.
    triageDue: oldestOpenDays !== null && oldestOpenDays > SPARK_TRIAGE_DAYS,
  }
}

/**
 * The whole spark board: the open queue, the decided history, the counts, and
 * the triage clock. Derived on every read like the monitoring summary, so the
 * clock cannot drift from the sparks behind it.
 */
export function sparkBoard(sparks: readonly Spark[], today: string): SparkBoard {
  const counts = summarizeSparks(sparks, today)
  const oldestFirst = (a: Spark, b: Spark): number =>
    (a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt))
  return {
    ...counts,
    // Oldest first: the queue is read top-down, and the thing that has waited
    // longest is the thing to decide.
    openSparks: sparks.filter((spark) => spark.status === 'open').sort(oldestFirst),
    // Newest first: this half is history, read to answer "did we already say no
    // to this?", where the most recent decision is the relevant one.
    decidedSparks: sparks.filter((spark) => spark.status !== 'open').sort((a, b) => -oldestFirst(a, b)),
    // triageDue arrives with the counts: one expression, one place.
    decided: counts.promoted + counts.dismissed,
  }
}

/** Shipped — the project is in the world and must now be MEASURED. */

export function rankProjects(
  projects: readonly Project[],
  checkins: readonly Checkin[] = [],
  today = '',
  sparks: readonly Spark[] = [],
): RankedProject[] {
  return projects
    .map((project) => ({
      ...project,
      score: scoreProject(project),
      pending: isPending(project),
      live: isLive(project),
      monitoring: summarizeMonitoring(project, checkins.filter((entry) => entry.projectId === project.id), today),
      // Only the sparks this project's OWN feedback produced. A spark whose
      // source project has been deleted is attributed to nobody and lives on the
      // triage board alone — which is the whole point of it outliving the
      // venture, and counting it here would be counting a ghost.
      sparkSummary: summarizeSparks(sparks.filter((spark) => spark.sourceProjectId === project.id), today),
    }))
    .sort((a, b) => {
      if (a.score.unestimated !== b.score.unestimated) return a.score.unestimated ? 1 : -1
      if (!a.score.unestimated && !b.score.unestimated) {
        const delta = (b.score.score ?? 0) - (a.score.score ?? 0)
        if (delta !== 0) return delta
      }
      return a.name.localeCompare(b.name)
    })
}

export type Normalized<T> = { ok: true; value: T } | { ok: false; message: string }

function numberOrNull(value: unknown, min: number, max: number, label: string): Normalized<number | null> {
  if (value === null || value === undefined || value === '') return { ok: true, value: null }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { ok: false, message: label + ' must be a number or null' }
  }
  if (value < min || value > max) return { ok: false, message: label + ' must be between ' + min + ' and ' + max }
  return { ok: true, value }
}

function text(value: unknown, max: number, label: string, required: boolean): Normalized<string | null> {
  if (value === null || value === undefined) {
    return required ? { ok: false, message: label + ' is required' } : { ok: true, value: null }
  }
  if (typeof value !== 'string') return { ok: false, message: label + ' must be text' }
  const trimmed = value.trim()
  if (trimmed.length === 0) return required ? { ok: false, message: label + ' is required' } : { ok: true, value: null }
  if (trimmed.length > max) return { ok: false, message: label + ' must be at most ' + max + ' characters' }
  return { ok: true, value: trimmed }
}

/** Validate a rubric, filling unrated dimensions with the neutral 3. */
export function normalizeRubric(raw: unknown): Normalized<ProjectRubric> {
  const rubric: ProjectRubric = { ...DEFAULT_RUBRIC }
  if (raw === undefined || raw === null) return { ok: true, value: rubric }
  if (typeof raw !== 'object') return { ok: false, message: 'rubric must be an object' }
  for (const dimension of RUBRIC_DIMENSIONS) {
    const value = (raw as Record<string, unknown>)[dimension]
    if (value === undefined || value === null) continue
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 5) {
      return { ok: false, message: 'rubric.' + dimension + ' must be an integer 1-5' }
    }
    rubric[dimension] = value
  }
  return { ok: true, value: rubric }
}

/**
 * Validate and build a project. With `existing`, unspecified fields keep their
 * current value (a patch); without it, unspecified optional fields default.
 */
export function normalizeProject(
  raw: Record<string, unknown>,
  options: { id: string; nowIso: string; existing?: Project },
): Normalized<Project> {
  const prior = options.existing
  const has = (key: string): boolean => Object.hasOwn(raw, key)

  const name = has('name') ? text(raw.name, MAX_NAME, 'name', true) : (prior ? { ok: true as const, value: prior.name } : text(undefined, MAX_NAME, 'name', true))
  if (!name.ok) return name
  const fulfills = has('fulfills') ? text(raw.fulfills, MAX_FULFILLS, 'fulfills', true) : (prior ? { ok: true as const, value: prior.fulfills } : text(undefined, MAX_FULFILLS, 'fulfills', true))
  if (!fulfills.ok) return fulfills

  const summary = has('summary') ? text(raw.summary, MAX_SUMMARY, 'summary', false) : { ok: true as const, value: prior?.summary ?? null }
  if (!summary.ok) return summary
  const killSwitch = has('killSwitch') ? text(raw.killSwitch, MAX_KILL_SWITCH, 'killSwitch', false) : { ok: true as const, value: prior?.killSwitch ?? null }
  if (!killSwitch.ok) return killSwitch

  // The ONE number that matters once this ships. A live board with ten numbers
  // per venture gets ignored; one number per venture gets read.
  const metricName = has('metricName') ? text(raw.metricName, MAX_METRIC_NAME, 'metricName', false) : { ok: true as const, value: prior?.metricName ?? null }
  if (!metricName.ok) return metricName

  const ttfdDays = has('ttfdDays') ? numberOrNull(raw.ttfdDays, 0, MAX_TTFD_DAYS, 'ttfdDays') : { ok: true as const, value: prior?.ttfdDays ?? null }
  if (!ttfdDays.ok) return ttfdDays
  const effortDays = has('effortDays') ? numberOrNull(raw.effortDays, 0.5, MAX_EFFORT_DAYS, 'effortDays') : { ok: true as const, value: prior?.effortDays ?? null }
  if (!effortDays.ok) return effortDays
  const revenuePerMonth = has('revenuePerMonth') ? numberOrNull(raw.revenuePerMonth, 0, 1e12, 'revenuePerMonth') : { ok: true as const, value: prior?.revenuePerMonth ?? null }
  if (!revenuePerMonth.ok) return revenuePerMonth

  const currency = has('currency') ? text(raw.currency, 8, 'currency', true) : { ok: true as const, value: prior?.currency ?? 'KSh' }
  if (!currency.ok) return currency

  let confidence = prior?.confidence ?? 0.5
  if (has('confidence')) {
    const value = raw.confidence
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      return { ok: false, message: 'confidence must be a number between 0 and 1' }
    }
    confidence = value
  }

  const rubric = has('rubric') || prior === undefined ? normalizeRubric(raw.rubric) : { ok: true as const, value: prior.rubric }
  if (!rubric.ok) return rubric

  let status: ProjectStatus = prior?.status ?? 'idea'
  if (has('status')) {
    if (typeof raw.status !== 'string' || !PROJECT_STATUSES.includes(raw.status as ProjectStatus)) {
      return { ok: false, message: 'status must be one of ' + PROJECT_STATUSES.join('|') }
    }
    status = raw.status as ProjectStatus
  }

  return {
    ok: true,
    value: {
      id: options.id,
      name: name.value as string,
      fulfills: fulfills.value as string,
      ...(summary.value === null ? {} : { summary: summary.value }),
      ttfdDays: ttfdDays.value,
      effortDays: effortDays.value,
      revenuePerMonth: revenuePerMonth.value,
      currency: currency.value as string,
      confidence,
      rubric: rubric.value,
      status,
      ...(killSwitch.value === null ? {} : { killSwitch: killSwitch.value }),
      ...(metricName.value === null ? {} : { metricName: metricName.value }),
      createdAt: prior?.createdAt ?? options.nowIso,
      updatedAt: options.nowIso,
    },
  }
}

/**
 * Split a ranked list into in-flight work and pending work, preserving the ranked
 * order inside each part and keeping the ORIGINAL rank numbers — a card must never
 * appear to have moved just because it changed column.
 */
export function partitionProjects(ranked: readonly RankedProject[]): {
  working: Array<{ project: RankedProject; rank: number }>
  pending: Array<{ project: RankedProject; rank: number }>
  live: Array<{ project: RankedProject; rank: number }>
  closed: Array<{ project: RankedProject; rank: number }>
} {
  const working: Array<{ project: RankedProject; rank: number }> = []
  const pending: Array<{ project: RankedProject; rank: number }> = []
  const live: Array<{ project: RankedProject; rank: number }> = []
  const closed: Array<{ project: RankedProject; rank: number }> = []
  ranked.forEach((project, index) => {
    const entry = { project, rank: index + 1 }
    // A killed project is decided, not waiting and not running: it leaves the
    // three stage columns entirely and is reported as a count instead, so
    // nothing is silently hidden but the board stays honest about what is live.
    if (project.status === 'killed') closed.push(entry)
    else if (project.live) live.push(entry)
    else if (project.pending) pending.push(entry)
    else working.push(entry)
  })
  return { working, pending, live, closed }
}

/** Human-readable one-liner for a score, used by the UI and the agent tools. */
export function describeScore(project: Project, score: ProjectScore): string {
  if (score.unestimated) {
    const missing: string[] = []
    if (project.ttfdDays === null) missing.push('time to first dollar')
    if (project.effortDays === null) missing.push('effort')
    if (project.revenuePerMonth === null) missing.push('monthly revenue')
    return 'unranked — needs ' + missing.join(', ')
  }
  const unit = project.currency + '/mo per build-day'
  return Math.round(score.score ?? 0).toLocaleString('en-US') + ' ' + unit
}

export type { RubricDimension }
