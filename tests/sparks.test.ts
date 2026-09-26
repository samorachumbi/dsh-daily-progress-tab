import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_RUBRIC, SPARK_TRIAGE_DAYS, rankProjects, sparkBoard, summarizeSparks } from '../src/projects.ts'
import type { Project, Spark } from '../src/types.ts'

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Live venture',
    fulfills: 'Serves a buyer a need they already pay for.',
    ttfdDays: 30,
    effortDays: 10,
    revenuePerMonth: 20000,
    currency: 'KSh',
    confidence: 1,
    rubric: { ...DEFAULT_RUBRIC },
    status: 'shipped',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  }
}

function spark(overrides: Partial<Spark> = {}): Spark {
  return {
    id: 's1',
    text: 'Sell the compliance pack as its own product',
    sourceProjectId: 'p1',
    sourceProjectName: 'Live venture',
    sourceDate: '2026-09-14',
    status: 'open',
    promotedProjectId: null,
    dismissedReason: null,
    createdAt: '2026-09-14T10:00:00.000Z',
    updatedAt: '2026-09-14T10:00:00.000Z',
    ...overrides,
  }
}

describe('summarizeSparks', () => {
  it('counts each status and ignores nothing', () => {
    const counts = summarizeSparks([
      spark({ id: 'a' }),
      spark({ id: 'b', status: 'promoted', promotedProjectId: 'p9' }),
      spark({ id: 'c', status: 'dismissed', dismissedReason: 'not a business' }),
    ], '2026-09-15')
    assert.deepEqual(counts, { total: 3, open: 1, promoted: 1, dismissed: 1, oldestOpenDays: 1, triageDue: false })
  })

  it('reports the age of the OLDEST OPEN spark, not the newest', () => {
    const counts = summarizeSparks([
      spark({ id: 'new', createdAt: '2026-09-24T10:00:00.000Z' }),
      spark({ id: 'old', createdAt: '2026-09-04T10:00:00.000Z' }),
    ], '2026-09-25')
    assert.equal(counts.oldestOpenDays, 21)
  })

  it('ignores a decided spark when ageing the queue', () => {
    // The oldest spark is decided, so it must not hold the clock open.
    const counts = summarizeSparks([
      spark({ id: 'ancient', createdAt: '2026-01-01T10:00:00.000Z', status: 'dismissed' }),
      spark({ id: 'recent', createdAt: '2026-09-24T10:00:00.000Z' }),
    ], '2026-09-25')
    assert.equal(counts.oldestOpenDays, 1)
    assert.equal(counts.triageDue, false)
  })

  it('has no age and no clock when nothing is open', () => {
    const counts = summarizeSparks([spark({ status: 'promoted' })], '2026-09-25')
    assert.equal(counts.oldestOpenDays, null)
    assert.equal(counts.triageDue, false)
  })

  it('does not trip the clock at the threshold, and does one day past it', () => {
    // The boundary is the whole point: `>` not `>=`. Both sides are asserted,
    // because a threshold that is off by one still passes a one-sided test.
    const at = summarizeSparks([spark({ createdAt: '2026-10-01T09:00:00.000Z' })], '2026-10-15')
    const past = summarizeSparks([spark({ createdAt: '2026-10-01T09:00:00.000Z' })], '2026-10-16')
    assert.equal(at.oldestOpenDays, SPARK_TRIAGE_DAYS)
    assert.equal(at.triageDue, false)
    assert.equal(past.oldestOpenDays, SPARK_TRIAGE_DAYS + 1)
    assert.equal(past.triageDue, true)
  })

  it('survives an unreadable date instead of reporting a false age', () => {
    const counts = summarizeSparks([spark({ createdAt: '' })], '2026-09-25')
    assert.equal(counts.oldestOpenDays, null)
    assert.equal(counts.triageDue, false)
  })
})

describe('sparkBoard', () => {
  it('queues open sparks oldest-first, so the top row is the one to decide', () => {
    const board = sparkBoard([
      spark({ id: 'newer', createdAt: '2026-09-20T10:00:00.000Z' }),
      spark({ id: 'older', createdAt: '2026-09-10T10:00:00.000Z' }),
    ], '2026-09-25')
    assert.deepEqual(board.openSparks.map((s) => s.id), ['older', 'newer'])
  })

  it('reads the decided history newest-first, because the last word is the relevant one', () => {
    const board = sparkBoard([
      spark({ id: 'first', createdAt: '2026-09-10T10:00:00.000Z', status: 'dismissed' }),
      spark({ id: 'last', createdAt: '2026-09-20T10:00:00.000Z', status: 'dismissed' }),
    ], '2026-09-25')
    assert.deepEqual(board.decidedSparks.map((s) => s.id), ['last', 'first'])
  })

  it('keeps a decided spark out of the queue but readable, with its reason', () => {
    const board = sparkBoard([
      spark({ id: 'no', status: 'dismissed', dismissedReason: 'no capacity this quarter' }),
    ], '2026-09-25')
    assert.equal(board.openSparks.length, 0)
    assert.equal(board.decidedSparks[0]?.dismissedReason, 'no capacity this quarter')
    assert.equal(board.decided, 1)
  })

  it('carries the same clock as the counts, so the two cannot disagree', () => {
    // Guards the single-expression rule: the board must not recompute the
    // threshold independently, or the page and the tools could disagree.
    const sparks = [spark({ createdAt: '2026-01-01T10:00:00.000Z' })]
    const board = sparkBoard(sparks, '2026-09-25')
    const counts = summarizeSparks(sparks, '2026-09-25')
    assert.equal(board.triageDue, counts.triageDue)
    assert.equal(board.oldestOpenDays, counts.oldestOpenDays)
    assert.equal(board.triageDue, true)
  })
})

describe('a project owns only the sparks ITS feedback produced', () => {
  it('attributes a spark to its source project and to no other', () => {
    const mine = project({ id: 'p1', name: 'Mine' })
    const other = project({ id: 'p2', name: 'Other' })
    const ranked = rankProjects([mine, other], [], '2026-09-25', [spark({ sourceProjectId: 'p1' })])
    assert.equal(ranked.find((p) => p.id === 'p1')?.sparkSummary.total, 1)
    assert.equal(ranked.find((p) => p.id === 'p2')?.sparkSummary.total, 0)
  })

  it('attributes a spark whose source is GONE to nobody', () => {
    // A spark outlives the venture that produced it, so its sourceProjectId can
    // dangle. Counting it against an unrelated project that reused the id, or
    // against the board as if it still had a home, would both be wrong: it is
    // attributed to nothing and lives on the triage board instead.
    const ranked = rankProjects([project({ id: 'p1' })], [], '2026-09-25', [
      spark({ sourceProjectId: 'deleted-venture' }),
    ])
    assert.equal(ranked[0]?.sparkSummary.total, 0)
    assert.equal(sparkBoard([spark({ sourceProjectId: 'deleted-venture' })], '2026-09-25').open, 1)
  })

  it('reports zero counts when no sparks are supplied at all', () => {
    // The parameter defaults to empty, so a caller that forgets it gets a
    // silence rather than a crash — which is exactly why the integration probes
    // assert the counts through the real snapshot path.
    const ranked = rankProjects([project()])
    assert.deepEqual(ranked[0]?.sparkSummary, {
      total: 0, open: 0, promoted: 0, dismissed: 0, oldestOpenDays: null, triageDue: false,
    })
  })
})
