import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_RUBRIC, STALE_CHECKIN_DAYS, isLive, isPending, normalizeProject, normalizeRubric, partitionProjects, rankProjects, scoreProject, summarizeMonitoring } from '../src/projects.ts'
import type { Checkin, CheckinItem, Project } from '../src/types.ts'

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Test project',
    fulfills: 'Serves a buyer a need they already pay for.',
    ttfdDays: 30,
    effortDays: 10,
    revenuePerMonth: 20000,
    currency: 'KSh',
    confidence: 1,
    rubric: { ...DEFAULT_RUBRIC, forcingFunction: 5 },
    status: 'idea',
    createdAt: '2026-09-25T00:00:00.000Z',
    updatedAt: '2026-09-25T00:00:00.000Z',
    ...overrides,
  }
}

describe('scoreProject', () => {
  it('is expected monthly revenue x time discount x urgency / effort', () => {
    // 20000 x 1 x (1/(1+30/30)=0.5) x (1+0.15x4=1.6) / 10 = 1600
    assert.equal(scoreProject(project()).score, 1600)
  })

  it('rewards a nearer first dollar at identical revenue', () => {
    const now = scoreProject(project({ ttfdDays: 0 })).score ?? 0
    const later = scoreProject(project({ ttfdDays: 90 })).score ?? 0
    // ttfd 0 -> discount 1 -> 3200;  ttfd 90 -> 1/4 -> 800
    assert.equal(now, 3200)
    assert.equal(later, 800)
    assert.ok(now > later)
  })

  it('scales by confidence', () => {
    assert.equal(scoreProject(project({ confidence: 0.5 })).score, 800)
    assert.equal(scoreProject(project({ confidence: 0 })).score, 0)
  })

  it('lifts urgency with the forcing function', () => {
    const weak = scoreProject(project({ rubric: { ...DEFAULT_RUBRIC, forcingFunction: 1 } }))
    const strong = scoreProject(project({ rubric: { ...DEFAULT_RUBRIC, forcingFunction: 5 } }))
    assert.equal(weak.urgency, 1)
    assert.equal(strong.urgency, 1.6)
    assert.ok((strong.score ?? 0) > (weak.score ?? 0))
  })

  it('divides by complexity, so a cheaper build wins at equal value', () => {
    const cheap = scoreProject(project({ effortDays: 2 })).score ?? 0
    const costly = scoreProject(project({ effortDays: 40 })).score ?? 0
    assert.ok(cheap > costly)
    assert.equal(cheap / costly, 20)
  })

  it('refuses to score a project with a missing estimate', () => {
    for (const missing of [{ ttfdDays: null }, { effortDays: null }, { revenuePerMonth: null }] as const) {
      const score = scoreProject(project(missing))
      assert.equal(score.score, null)
      assert.equal(score.unestimated, true)
    }
  })

  it('reports the weakest rubric dimension instead of averaging it away', () => {
    const score = scoreProject(project({ rubric: { ...DEFAULT_RUBRIC, moat: 1, forcingFunction: 5 } }))
    assert.equal(score.weakestDimension, 'moat')
  })
})

describe('rankProjects', () => {
  it('puts the fastest money per unit effort first, not the biggest number', () => {
    const slowBig = project({
      id: 'slow', name: 'Slow big', revenuePerMonth: 30000, ttfdDays: 180, effortDays: 20,
      rubric: { ...DEFAULT_RUBRIC, forcingFunction: 3 },
    })
    const fastSmall = project({
      id: 'fast', name: 'Fast small', revenuePerMonth: 15000, ttfdDays: 14, effortDays: 7,
      rubric: { ...DEFAULT_RUBRIC, forcingFunction: 4 },
    })
    const ranked = rankProjects([slowBig, fastSmall])
    assert.deepEqual(ranked.map((p) => p.id), ['fast', 'slow'])
  })

  it('sorts unestimated projects after every scored one, alphabetically', () => {
    const ranked = rankProjects([
      project({ id: 'b', name: 'B unranked', ttfdDays: null }),
      project({ id: 'ok', name: 'Ranked', revenuePerMonth: 1 }),
      project({ id: 'a', name: 'A unranked', effortDays: null }),
    ])
    assert.deepEqual(ranked.map((p) => p.id), ['ok', 'a', 'b'])
    assert.equal(ranked[1]!.score.unestimated, true)
  })
})

describe('normalizeProject', () => {
  const now = '2026-09-25T00:00:00.000Z'

  it('defaults currency, confidence, status and a neutral rubric', () => {
    const result = normalizeProject({ name: 'X', fulfills: 'Y' }, { id: 'id1', nowIso: now })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.value.currency, 'KSh')
    assert.equal(result.value.confidence, 0.5)
    assert.equal(result.value.status, 'idea')
    assert.deepEqual(result.value.rubric, DEFAULT_RUBRIC)
    assert.equal(result.value.ttfdDays, null)
  })

  it('requires a name and what it fulfils', () => {
    assert.equal(normalizeProject({ fulfills: 'Y' }, { id: 'i', nowIso: now }).ok, false)
    assert.equal(normalizeProject({ name: 'X' }, { id: 'i', nowIso: now }).ok, false)
    assert.equal(normalizeProject({ name: '   ', fulfills: 'Y' }, { id: 'i', nowIso: now }).ok, false)
  })

  it('rejects out-of-range rubric ratings and confidence', () => {
    assert.equal(normalizeProject({ name: 'X', fulfills: 'Y', rubric: { moat: 9 } }, { id: 'i', nowIso: now }).ok, false)
    assert.equal(normalizeProject({ name: 'X', fulfills: 'Y', rubric: { moat: 2.5 } }, { id: 'i', nowIso: now }).ok, false)
    assert.equal(normalizeProject({ name: 'X', fulfills: 'Y', confidence: 2 }, { id: 'i', nowIso: now }).ok, false)
  })

  it('patches only the fields supplied and preserves createdAt', () => {
    const existing = project({ id: 'keep', name: 'Old' })
    const result = normalizeProject({ revenuePerMonth: 5000 }, { id: 'keep', nowIso: now, existing })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.value.name, 'Old')
    assert.equal(result.value.revenuePerMonth, 5000)
    assert.equal(result.value.effortDays, existing.effortDays)
    assert.equal(result.value.createdAt, existing.createdAt)
    assert.equal(result.value.updatedAt, now)
  })

  it('accepts explicit nulls to clear an estimate', () => {
    const result = normalizeProject({ ttfdDays: null }, { id: 'i', nowIso: now, existing: project() })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.value.ttfdDays, null)
  })
})

describe('normalizeRubric', () => {
  it('fills unrated dimensions with the neutral 3', () => {
    const result = normalizeRubric({ moat: 5 })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.value.moat, 5)
    assert.equal(result.value.distribution, 3)
  })

  it('rejects a non-integer or out-of-range rating', () => {
    assert.equal(normalizeRubric({ moat: 0 }).ok, false)
    assert.equal(normalizeRubric({ moat: 6 }).ok, false)
    assert.equal(normalizeRubric({ moat: 3.5 }).ok, false)
  })
})

describe('partitionProjects / the Pending column', () => {
  it('treats an idea as pending and an active project as working', () => {
    assert.equal(isPending(project({ status: 'idea' })), true)
    assert.equal(isPending(project({ status: 'parked' })), true)
    assert.equal(isPending(project({ status: 'active' })), false)
    assert.equal(isPending(project({ status: 'shipped' })), false)
    // a killed project is decided, not waiting on us
    assert.equal(isPending(project({ status: 'killed' })), false)
  })

  it('splits without duplicating, and keeps the global rank numbers', () => {
    const ranked = rankProjects([
      project({ id: 'a', name: 'Active one', status: 'active' }),
      project({ id: 'b', name: 'An idea', status: 'idea' }),
      project({ id: 'c', name: 'A parked one', status: 'parked', ttfdDays: 10 }),
      project({ id: 'd', name: 'Shipped one', status: 'shipped' }),
    ])
    const { working, pending, live, closed } = partitionProjects(ranked)

    // all four buckets together hold every project exactly once
    assert.equal(working.length + pending.length + live.length + closed.length, ranked.length)
    assert.deepEqual(
      [...working, ...pending, ...live, ...closed].map((e) => e.project.id).sort(),
      ['a', 'b', 'c', 'd'],
    )
    // every rank is the position in the ORIGINAL ranking, not the position in the column
    const byId = new Map(ranked.map((p, i) => [p.id, i + 1]))
    for (const entry of [...working, ...pending, ...live, ...closed]) {
      assert.equal(entry.rank, byId.get(entry.project.id))
    }
    // 'd' is shipped, so it belongs to the Live column, not Working.
    assert.deepEqual(working.map((e) => e.project.id), ['a'])
    assert.deepEqual(live.map((e) => e.project.id), ['d'])
    // Pending preserves the GLOBAL order, not insertion order: the parked project
    // reaches its first dollar on day 10 against the idea's day 30, so it scores
    // higher and leads the column.
    assert.deepEqual(pending.map((e) => e.project.id), ['c', 'b'])
  })

  it('keeps the score on a pending project — deferred is not unmeasured', () => {
    const ranked = rankProjects([project({ status: 'idea', ttfdDays: 30, effortDays: 10 })])
    const { pending } = partitionProjects(ranked)
    assert.equal(pending.length, 1)
    assert.equal(pending[0]!.project.pending, true)
    assert.equal(pending[0]!.project.score.unestimated, false)
    assert.equal(pending[0]!.project.score.score, 1600)
  })

  it('returns two empty columns rather than throwing on an empty board', () => {
    assert.deepEqual(partitionProjects([]), { working: [], pending: [], live: [], closed: [] })
  })
})

function checkin(overrides: Partial<Checkin> = {}): Checkin {
  return {
    projectId: 'p1',
    date: '2026-09-01',
    metric: null,
    metricNote: null,
    revenue: null,
    customers: null,
    progress: null,
    verdict: 'continue',
    note: null,
    hurdles: [],
    corrections: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  }
}

function item(text: string, done = false): CheckinItem {
  return { id: 'i-' + text, text, done, at: '2026-09-01T00:00:00.000Z', closedAt: done ? '2026-09-02T00:00:00.000Z' : null }
}

describe('the feedback loop (Live monitoring)', () => {
  it('sums money across check-ins but reports the period figure separately', () => {
    const m = summarizeMonitoring(project(), [
      checkin({ date: '2026-09-01', revenue: 5000 }),
      checkin({ date: '2026-09-08', revenue: 7000 }),
    ], '2026-09-09')
    assert.equal(m.totalRevenue, 12000)
    assert.equal(m.lastRevenue, 7000)
    assert.equal(m.checkins, 2)
    assert.equal(m.liveSince, '2026-09-01')
    assert.equal(m.lastCheckin, '2026-09-08')
    assert.equal(m.daysSinceCheckin, 1)
  })

  it('flags a quiet loop as stale past the threshold, and not before', () => {
    const exactly = summarizeMonitoring(project(), [checkin({ date: '2026-09-10' })], '2026-09-17')
    assert.equal(exactly.daysSinceCheckin, STALE_CHECKIN_DAYS)
    assert.equal(exactly.stale, false)
    const quiet = summarizeMonitoring(project(), [checkin({ date: '2026-09-10' })], '2026-09-18')
    assert.equal(quiet.stale, true)
  })

  it('reports the change in the one metric since the previous check-in', () => {
    const m = summarizeMonitoring(project({ metricName: 'paid retainers' }), [
      checkin({ date: '2026-09-01', metric: 1 }),
      checkin({ date: '2026-09-08', metric: 3 }),
    ], '2026-09-08')
    assert.equal(m.metricName, 'paid retainers')
    assert.equal(m.latestMetric, 3)
    assert.equal(m.metricDelta, 2)
  })

  it('has no delta to report from a single check-in', () => {
    const m = summarizeMonitoring(project(), [checkin({ metric: 4 })], '2026-09-01')
    assert.equal(m.latestMetric, 4)
    assert.equal(m.metricDelta, null)
  })

  it('carries open hurdles and counts only closed corrections as done', () => {
    const m = summarizeMonitoring(project(), [
      checkin({ date: '2026-09-01', hurdles: [item('GBP access is slow'), item('no case study', true)] }),
      checkin({ date: '2026-09-08', corrections: [item('add a kickoff checklist'), item('rewrite the pitch', true)] }),
    ], '2026-09-08')
    assert.deepEqual(m.openHurdles.map((h) => h.text), ['GBP access is slow'])
    assert.deepEqual(m.openCorrections.map((c) => c.text), ['add a kickoff checklist'])
    assert.equal(m.doneCorrections, 1)
  })

  it('keeps the score on a live project and marks it live, not pending', () => {
    const ranked = rankProjects([project({ status: 'shipped' })], [], '')
    assert.equal(ranked[0]!.live, true)
    assert.equal(ranked[0]!.pending, false)
    assert.equal(isLive(ranked[0]!), true)
    // the same arithmetic as the active case: 20000 x 1 x 0.5 x 1.6 / 10 = 1600
    assert.equal(ranked[0]!.score.score, 1600)
  })

  it('routes check-ins to the right project, and only that one', () => {
    const ranked = rankProjects([project({ id: 'a' }), project({ id: 'b' })], [
      checkin({ projectId: 'a', date: '2026-09-01', revenue: 100 }),
      checkin({ projectId: 'b', date: '2026-09-01', revenue: 900 }),
    ], '2026-09-02')
    assert.equal(ranked.find((p) => p.id === 'a')!.monitoring.totalRevenue, 100)
    assert.equal(ranked.find((p) => p.id === 'b')!.monitoring.totalRevenue, 900)
  })

  it('sends a killed project to the closed bucket, not to the live board', () => {
    const parts = partitionProjects(rankProjects([project({ id: 'k', status: 'killed' })], [], ''))
    assert.equal(parts.closed.length, 1)
    assert.deepEqual(
      [parts.live.length, parts.pending.length, parts.working.length],
      [0, 0, 0],
    )
  })
})
