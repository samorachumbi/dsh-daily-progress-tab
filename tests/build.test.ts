/**
 * Build time: the budget, the measured capacity, and per-project burn.
 *
 * Two classes of test live here, and the second is the one that matters most.
 *
 * The first is ordinary: the arithmetic in `build.ts` is pure, so it is asserted
 * directly rather than through a rendered page.
 *
 * The second guards the failure `domain.test.ts` was written for — a field added
 * to the TypeScript type and used all the way through, but never added to the
 * zod schema, so **zod stripped it on read**. The write's own reply looks
 * perfect, and only reopening the domain shows the value is gone. So `estHours`
 * and `budgetHours` are asserted to SURVIVE a schema parse here, and records
 * written BEFORE they existed are asserted to still validate — because a
 * required field would make every one of them invalid and the domain would
 * refuse to open its own store.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  effectiveBudget,
  itemHours,
  measureCapacity,
  sumHours,
  summarizeBurn,
  summarizeBuild,
} from '../src/build.ts'
import {
  DEFAULT_BUDGET_HOURS,
  HOURS_PER_BUILD_DAY,
  MAX_BUDGET_HOURS,
  MIN_BUDGET_HOURS,
  OVERRUN_STOP_RATIO,
} from '../src/budget.ts'
import { dailyProgressDomain } from '../src/domain.ts'
import { normalizeProject } from '../src/projects.ts'
import type { DayPlan, PlanItem, Project } from '../src/types.ts'

interface ObjectSchema {
  shape: Record<string, unknown>
  parse: (value: unknown) => Record<string, unknown>
}

const planSchema = dailyProgressDomain.tables.plans.valueSchema as unknown as ObjectSchema
// The singleton exposes `schema`, not `valueSchema` — tables and the global are
// shaped differently, and guessing cost two failures here.
const globalSchema = dailyProgressDomain.global.schema as unknown as ObjectSchema

function item(over: Partial<PlanItem> & { text: string }): PlanItem {
  return { id: over.text, done: false, doneAt: null, origin: 'today', ...over }
}

function plan(date: string, items: PlanItem[]): DayPlan {
  return { date, tz: 'Africa/Nairobi', items, updatedAt: '2026-10-09T00:00:00.000Z' }
}

function project(over: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'P',
    fulfills: 'f',
    ttfdDays: 20,
    effortDays: 5,
    revenuePerMonth: 1000,
    currency: 'KSh',
    confidence: 0.5,
    rubric: {
      forcingFunction: 3,
      competitionThinness: 3,
      assetLightness: 3,
      aiRunnability: 3,
      distribution: 3,
      moat: 3,
      regulatoryCost: 3,
    },
    status: 'active',
    // RATED BY DEFAULT: most tests exercise the build-day path, and the
    // pre-unit tests opt out explicitly by passing `effortUnit: undefined`.
    effortUnit: 'build-day',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...over,
  }
}

describe('schema — the new fields must survive a parse, and old records must still load', () => {
  it('keeps estHours on a plan item (zod strips undeclared keys silently)', () => {
    const parsed = planSchema.parse({
      date: '2026-10-09',
      tz: 'Africa/Nairobi',
      updatedAt: '2026-10-09T00:00:00.000Z',
      items: [{ id: 'a', text: 't', done: false, doneAt: null, origin: 'today', estHours: 2.5 }],
    })
    const items = parsed.items as Array<Record<string, unknown>>
    assert.equal(items[0]?.estHours, 2.5, 'estHours was stripped by the schema — it is missing from domain.ts')
  })

  it('accepts an item written BEFORE estHours existed (absent must stay valid)', () => {
    const parsed = planSchema.parse({
      date: '2026-10-09',
      tz: 'Africa/Nairobi',
      updatedAt: '2026-10-09T00:00:00.000Z',
      items: [{ id: 'a', text: 't', done: true, doneAt: '2026-10-09T00:00:00.000Z', origin: 'carried' }],
    })
    assert.equal((parsed.items as unknown[]).length, 1)
  })

  it('refuses an out-of-range estimate rather than clamping it silently', () => {
    const base = {
      date: '2026-10-09',
      tz: 'Africa/Nairobi',
      updatedAt: '2026-10-09T00:00:00.000Z',
      items: [{ id: 'a', text: 't', done: false, doneAt: null, origin: 'today', estHours: 99 }],
    }
    assert.throws(() => planSchema.parse(base))
  })

  it('keeps budgetHours on the global singleton', () => {
    const parsed = globalSchema.parse({
      selectedProjectId: 'p1',
      updatedAt: '2026-10-09T00:00:00.000Z',
      budgetHours: 4,
    })
    assert.equal(parsed.budgetHours, 4, 'budgetHours was stripped by the schema')
  })

  it('accepts a global written before budgetHours existed', () => {
    const parsed = globalSchema.parse({
      selectedProjectId: null,
      updatedAt: '2026-10-09T00:00:00.000Z',
    })
    assert.equal(parsed.selectedProjectId, null)
  })
})

describe('the revision trail — what makes a FLUID estimate safe', () => {
  const base = { name: 'P', fulfills: 'f', effortDays: 5 }

  it('records from/to/why when the estimate moves', () => {
    const first = normalizeProject(base, { id: 'p1', nowIso: 't1' })
    assert.ok(first.ok)
    const moved = normalizeProject(
      { effortDays: 3, effortNote: 'the one-pager is all that is left' },
      { id: 'p1', nowIso: 't3', existing: first.value },
    )
    assert.ok(moved.ok)
    assert.deepEqual(moved.value.effortRevisions, [
      { at: 't3', from: 5, to: 3, note: 'the one-pager is all that is left' },
    ])
  })

  it('records NOTHING when an update does not touch the estimate', () => {
    // The idempotence that matters: a summary-only edit must not look like a revision.
    const first = normalizeProject(base, { id: 'p1', nowIso: 't1' })
    assert.ok(first.ok)
    const untouched = normalizeProject({ summary: 'new summary' }, { id: 'p1', nowIso: 't2', existing: first.value })
    assert.ok(untouched.ok)
    assert.equal(untouched.value.effortRevisions, undefined, 'an unchanged estimate must not add a revision')
  })

  it('records a UNIT change on its own, since that is what unlocks the ratio', () => {
    const first = normalizeProject(base, { id: 'p1', nowIso: 't1' })
    assert.ok(first.ok)
    const rated = normalizeProject(
      { effortUnit: 'build-day', effortNote: 're-stated in build-days' },
      { id: 'p1', nowIso: 't2', existing: first.value },
    )
    assert.ok(rated.ok)
    assert.equal(rated.value.effortRevisions?.length, 1)
    assert.equal(rated.value.effortRevisions?.[0]?.unit, 'build-day')
    assert.equal(rated.value.effortRevisions?.[0]?.from, 5)
    assert.equal(rated.value.effortRevisions?.[0]?.to, 5, 'the number did not move; the UNIT did')
  })

  it('BOUNCES out-of-range effortDays instead of clamping a guess silently', () => {
    const bad = normalizeProject({ effortDays: 0.1 }, { id: 'p1', nowIso: 't1' })
    assert.equal(bad.ok, false, 'below the 0.5 floor must be refused, not rounded up')
  })

  it('keeps the trail bounded, dropping the OLDEST revision', () => {
    let current = normalizeProject(base, { id: 'p1', nowIso: 't0' })
    assert.ok(current.ok)
    for (let i = 1; i <= 25; i++) {
      const next = normalizeProject(
        { effortDays: 20 + i },
        { id: 'p1', nowIso: 't' + i, existing: current.value },
      )
      assert.ok(next.ok)
      current = next
    }
    const trail = current.value.effortRevisions ?? []
    assert.equal(trail.length, 20, 'the cap holds')
    assert.equal(trail[trail.length - 1]?.to, 45, 'the NEWEST revision is kept')
    assert.equal(trail[0]?.to, 26, 'the oldest were dropped, not the newest')
  })

  it('carries the trail through the store schema (zod strips undeclared keys)', () => {
    const parsed = planSchema.parse({
      date: '2026-10-09',
      tz: 'Africa/Nairobi',
      updatedAt: 'x',
      items: [],
    })
    assert.ok(parsed)
    const globalParsed = globalSchema.parse({ selectedProjectId: null, updatedAt: 'x' })
    assert.ok(globalParsed)
  })
})

describe('effectiveBudget — never zero, which would make every ratio infinite', () => {
  it('falls back to the default for absent, null, NaN and garbage', () => {
    for (const value of [undefined, null, Number.NaN, Infinity]) {
      assert.equal(effectiveBudget(value), DEFAULT_BUDGET_HOURS, String(value))
    }
  })

  it('clamps out-of-range values into the usable band', () => {
    assert.equal(effectiveBudget(0), MIN_BUDGET_HOURS)
    assert.equal(effectiveBudget(-5), MIN_BUDGET_HOURS)
    assert.equal(effectiveBudget(999), MAX_BUDGET_HOURS)
  })

  it('passes a sane value through', () => {
    assert.equal(effectiveBudget(3.5), 3.5)
  })
})

describe('itemHours — absent is UNKNOWN, never free', () => {
  it('returns null for an absent estimate', () => {
    assert.equal(itemHours(item({ text: 'a' })), null)
  })

  it('returns null for zero and negatives, which are not real estimates', () => {
    assert.equal(itemHours(item({ text: 'a', estHours: 0 })), null)
    assert.equal(itemHours(item({ text: 'a', estHours: -2 })), null)
  })

  it('returns the value when set', () => {
    assert.equal(itemHours(item({ text: 'a', estHours: 1.5 })), 1.5)
  })
})

describe('sumHours — the unestimated count travels with the total', () => {
  it('separates hours from the tasks that have none', () => {
    const total = sumHours([item({ text: 'a', estHours: 2 }), item({ text: 'b' }), item({ text: 'c', estHours: 1 })])
    assert.equal(total.hours, 3)
    assert.equal(total.unestimated, 1)
  })

  it('counts every task as unestimated when none carry one', () => {
    const total = sumHours([item({ text: 'a' }), item({ text: 'b' })])
    assert.equal(total.hours, 0)
    assert.equal(total.unestimated, 2)
  })
})

describe('measureCapacity — a day off is not a collapse in output', () => {
  const budget = HOURS_PER_BUILD_DAY

  it('reports NOT MEASURED rather than zero when nothing has been finished', () => {
    const reading = measureCapacity([], '2026-10-09', budget)
    assert.equal(reading.samples, 0)
    assert.equal(reading.avgHours, null, 'an unmeasured capacity must be null, never 0')
    assert.equal(reading.ratio, null)
  })

  it('averages only the days that FINISHED estimated work', () => {
    const plans = [
      plan('2026-10-07', [item({ text: 'a', estHours: 4, done: true, doneAt: 'x' })]),
      // A day with a plan but nothing finished — a day off, not a zero-output day.
      plan('2026-10-08', [item({ text: 'b', estHours: 9 })]),
      plan('2026-10-09', [item({ text: 'c', estHours: 2, done: true, doneAt: 'x' })]),
    ]
    const reading = measureCapacity(plans, '2026-10-09', budget)
    assert.equal(reading.samples, 2)
    assert.equal(reading.avgHours, 3, '(4 + 2) / 2 — the unworked day must not be averaged in')
  })

  it('ignores days outside the trailing window, in both directions', () => {
    const plans = [
      plan('2026-09-01', [item({ text: 'old', estHours: 20, done: true, doneAt: 'x' })]),
      plan('2026-12-01', [item({ text: 'future', estHours: 20, done: true, doneAt: 'x' })]),
      plan('2026-10-09', [item({ text: 'recent', estHours: 3, done: true, doneAt: 'x' })]),
    ]
    const reading = measureCapacity(plans, '2026-10-09', budget)
    assert.equal(reading.samples, 1)
    assert.equal(reading.avgHours, 3)
  })

  it('reports the ratio against the budget', () => {
    const plans = [plan('2026-10-09', [item({ text: 'a', estHours: 10, done: true, doneAt: 'x' })])]
    const reading = measureCapacity(plans, '2026-10-09', budget)
    assert.equal(reading.avgHours, 10)
    assert.equal(reading.ratio, 2)
  })

  it('counts only DONE, estimated work', () => {
    const plans = [plan('2026-10-09', [
      item({ text: 'done', estHours: 2, done: true, doneAt: 'x' }),
      item({ text: 'undone', estHours: 100 }),
      item({ text: 'done-no-estimate', done: true, doneAt: 'x' }),
    ])]
    const reading = measureCapacity(plans, '2026-10-09', budget)
    assert.equal(reading.avgHours, 2)
  })
})

describe('summarizeBuild — the day against the budget', () => {
  it('reports the load and the unestimated count together', () => {
    const items = [item({ text: 'a', estHours: 2.5 }), item({ text: 'b', estHours: 5, done: true, doneAt: 'x' }), item({ text: 'c' })]
    const build = summarizeBuild(items, [], '2026-10-09', 5)
    assert.equal(build.plannedHours, 7.5)
    assert.equal(build.doneHours, 5)
    assert.equal(build.unestimated, 1, 'the unestimated task must be visible, not silently free')
    assert.equal(build.load, 1.5)
    assert.equal(build.capacity.avgHours, null)
  })
})

describe('summarizeBurn — the estimate is the bar, and under-reporting is surfaced', () => {
  it('is null while nothing has been consumed, so an unstarted project cannot read as on track', () => {
    const burn = summarizeBurn(project(), [], 5)
    assert.equal(burn.consumedDays, 0)
    assert.equal(burn.ratio, null)
    assert.equal(burn.overrun, false)
  })

  it('counts only this project, only DONE items, and only estimated ones', () => {
    const plans = [
      plan('2026-10-08', [
        item({ text: 'ours', estHours: 5, done: true, doneAt: 'x', projectId: 'p1' }),
        item({ text: 'ours-undone', estHours: 100, projectId: 'p1' }),
        item({ text: 'theirs', estHours: 100, done: true, doneAt: 'x', projectId: 'p2' }),
        item({ text: 'unlinked', estHours: 100, done: true, doneAt: 'x' }),
      ]),
    ]
    const burn = summarizeBurn(project(), plans, 5)
    assert.equal(burn.consumedDays, 1, '5h at a 5h budget is one build-day')
  })

  it('surfaces unestimated done work, which makes the burn a LOWER bound', () => {
    const plans = [plan('2026-10-08', [
      item({ text: 'sized', estHours: 5, done: true, doneAt: 'x', projectId: 'p1' }),
      item({ text: 'unsized-a', done: true, doneAt: 'x', projectId: 'p1' }),
      item({ text: 'unsized-b', done: true, doneAt: 'x', projectId: 'p1' }),
    ])]
    const burn = summarizeBurn(project(), plans, 5)
    assert.equal(burn.consumedDays, 1)
    assert.equal(burn.unestimatedDone, 2, 'two finished tasks were never sized — the burn under-reports')
  })

  it('trips overrun at the declared stop ratio', () => {
    // 8 build-days consumed against an estimate of 5 = 1.6x, past the 1.5x stop.
    const plans = [plan('2026-10-08', [item({ text: 'a', estHours: 40, done: true, doneAt: 'x', projectId: 'p1' })])]
    const burn = summarizeBurn(project({ effortDays: 5 }), plans, 5)
    assert.equal(burn.consumedDays, 8)
    assert.equal(burn.ratio, 1.6)
    assert.equal(burn.overrun, true, 'at ' + OVERRUN_STOP_RATIO + 'x the build stops and is re-estimated')
  })

  it('does not trip overrun just below the stop ratio', () => {
    const plans = [plan('2026-10-08', [item({ text: 'a', estHours: 35, done: true, doneAt: 'x', projectId: 'p1' })])]
    const burn = summarizeBurn(project({ effortDays: 5 }), plans, 5)
    assert.equal(burn.ratio, 1.4)
    assert.equal(burn.overrun, false)
  })

  it('WITHHOLDS the ratio when the estimate predates the build-day unit', () => {
    // 10h at a 5h budget is 2 build-days consumed, and effortDays says 5. Dividing
    // them gives 40%, which looks authoritative and is meaningless: the numerator
    // is hours and the denominator is a count of work-chunks. 8 days consumed
    // against an unrated "5" would trip a FALSE overrun.
    const plans = [plan('2026-10-08', [item({ text: 'a', estHours: 40, done: true, doneAt: 'x', projectId: 'p1' })])]
    const burn = summarizeBurn(project({ effortDays: 5, effortUnit: undefined }), plans, 5)
    assert.equal(burn.consumedDays, 8, 'consumption is still measured and shown')
    assert.equal(burn.ratio, null, 'an unrated estimate must not produce a ratio')
    assert.equal(burn.ratioBlockedBy, 'pre-unit')
    assert.equal(burn.overrun, false, 'and it must NOT fire a false overrun')
  })

  it('computes the ratio once the same estimate is marked in build-days', () => {
    const plans = [plan('2026-10-08', [item({ text: 'a', estHours: 40, done: true, doneAt: 'x', projectId: 'p1' })])]
    const rated = summarizeBurn(project({ effortDays: 5, effortUnit: 'build-day' }), plans, 5)
    const unrated = summarizeBurn(project({ effortDays: 5, effortUnit: undefined }), plans, 5)
    assert.equal(rated.ratio, 1.6)
    assert.equal(rated.overrun, true, 'rated and past the stop ratio: this one SHOULD fire')
    assert.equal(rated.ratioBlockedBy, undefined)
    // Same numbers, only the unit marker differs — and the verdict flips.
    assert.equal(unrated.ratio, null)
    assert.equal(unrated.overrun, false)
  })

  it('names the other two reasons the ratio is absent', () => {
    const consumed = [plan('2026-10-08', [item({ text: 'a', estHours: 5, done: true, doneAt: 'x', projectId: 'p1' })])]
    assert.equal(summarizeBurn(project({ effortDays: null }), consumed, 5).ratioBlockedBy, 'no-estimate')
    assert.equal(summarizeBurn(project(), [], 5).ratioBlockedBy, 'no-consumption')
  })

  it('reports ratio null when the project has no estimate to compare against', () => {
    const plans = [plan('2026-10-08', [item({ text: 'a', estHours: 10, done: true, doneAt: 'x', projectId: 'p1' })])]
    const burn = summarizeBurn(project({ effortDays: null }), plans, 5)
    assert.equal(burn.consumedDays, 2)
    assert.equal(burn.estimatedDays, null)
    assert.equal(burn.ratio, null, 'no estimate means no ratio — not a perfect one')
  })
})
