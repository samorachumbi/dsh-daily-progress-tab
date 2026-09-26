import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  VERIFY_STALE_DAYS, isPublishable, portfolioCounts, portfolioView, publishBlockers,
} from '../src/portfolio.ts'
import type { PluginRecord } from '../src/types.ts'

/** A plugin that is ready in every respect, so each test can remove exactly one. */
function plugin(overrides: Partial<PluginRecord> = {}): PluginRecord {
  return {
    id: 'p1',
    name: 'dsh-cost-bubble',
    origin: 'ours',
    visibility: 'showcase',
    status: 'local',
    licence: 'MIT',
    sourcePath: '~/projects/plugins/dsh-cost-bubble',
    installed: true,
    hasLicenseFile: true,
    hasReadme: true,
    hasScreenshot: true,
    sourceOutsideProfile: true,
    leakScanPassed: true,
    gitReady: true,
    verifiedAt: '2026-09-26',
    createdAt: '2026-09-26T00:00:00.000Z',
    updatedAt: '2026-09-26T00:00:00.000Z',
    ...overrides,
  }
}

const TODAY = '2026-09-26'

describe('the publish gate', () => {
  it('passes a fully-verified plugin of ours', () => {
    assert.equal(isPublishable(plugin()), true)
    assert.deepEqual(publishBlockers(plugin(), TODAY), [])
  })

  it('refuses someone else\'s plugin outright, and says only why', () => {
    // The whole reason this is a gate and not a button: a list of INSTALLED
    // plugins contains third-party work, so publishing must be impossible rather
    // than merely discouraged.
    const theirs = plugin({ origin: 'third-party', visibility: 'internal' })
    assert.equal(isPublishable(theirs), false)
    // Both reasons, and NOT a to-do list of missing facts: there is nothing to fix.
    assert.deepEqual(publishBlockers(theirs, TODAY), [
      'not ours — a third-party plugin is never publishable',
      'marked internal — never publishable',
    ])
  })

  it('refuses anything marked internal, even our own', () => {
    // A plugin of ours that reads the loan plan or the vault is internal for good.
    assert.deepEqual(publishBlockers(plugin({ visibility: 'internal' }), TODAY), [
      'marked internal — never publishable',
    ])
  })

  it('names each missing fact, and lets a fork through when attributed', () => {
    assert.equal(publishBlockers(plugin({ hasLicenseFile: false }), TODAY).length, 1)
    assert.equal(publishBlockers(plugin({ hasReadme: false }), TODAY).length, 1)
    assert.equal(publishBlockers(plugin({ hasScreenshot: false }), TODAY).length, 1)
    assert.equal(publishBlockers(plugin({ sourceOutsideProfile: false }), TODAY).length, 1)
    assert.equal(publishBlockers(plugin({ leakScanPassed: false }), TODAY).length, 1)
    assert.equal(publishBlockers(plugin({ gitReady: false }), TODAY).length, 1)
    // A fork is publishable ONLY with its upstream recorded.
    assert.equal(publishBlockers(plugin({ origin: 'fork', upstream: 'omdsh-dev/x@bedbd28' }), TODAY).length, 0)
    assert.equal(publishBlockers(plugin({ origin: 'fork' }), TODAY).length, 1)
  })

  it('treats an unverified fact as missing, not as true', () => {
    // undefined is not false and must not read as "fine".
    assert.equal(publishBlockers(plugin({ leakScanPassed: undefined }), TODAY).length, 1)
    assert.equal(publishBlockers(plugin({ verifiedAt: undefined }), TODAY).length, 0)
  })

  it('expires the facts: a stale verification is itself a blocker', () => {
    // A leak scan that passed last year says nothing about the tree today.
    const fresh = publishBlockers(plugin({ verifiedAt: '2026-09-01' }), TODAY)
    assert.deepEqual(fresh, [])
    const stale = publishBlockers(plugin({ verifiedAt: '2026-07-01' }), TODAY)
    assert.equal(stale.length, 1)
    assert.match(stale[0]!, /re-verify/)
    // The boundary is exclusive, and both sides are asserted.
    assert.deepEqual(publishBlockers(plugin({ verifiedAt: '2026-08-27' }), TODAY), [])
    assert.equal(publishBlockers(plugin({ verifiedAt: '2026-08-26' }), TODAY).length, 1)
    assert.equal(VERIFY_STALE_DAYS, 30)
  })

  it('stops blocking once the decision is taken', () => {
    assert.deepEqual(publishBlockers(plugin({ status: 'public', hasScreenshot: false }), TODAY), [])
  })
})

describe('the counter', () => {
  it('counts ours and forks as authored, and never third-party work', () => {
    const counts = portfolioCounts([
      plugin({ id: 'a' }),
      plugin({ id: 'b', name: 'dsh-daily-progress-tab', origin: 'fork', upstream: 'omdsh-dev/x@bedbd28' }),
      plugin({ id: 'c', name: 'dsh-better-sidebar', origin: 'third-party', visibility: 'internal' }),
    ])
    assert.deepEqual(counts, {
      total: 3, ours: 1, fork: 1, thirdParty: 1, authored: 2,
      internal: 1, published: 0, ready: 2, installed: 3,
    })
  })

  it('separates published from ready', () => {
    const counts = portfolioCounts([
      plugin({ id: 'a', status: 'public', publicUrl: 'https://github.com/x/y' }),
      plugin({ id: 'b', name: 'blocked-one', hasScreenshot: false }),
    ])
    assert.equal(counts.published, 1)
    assert.equal(counts.ready, 0)
  })

  it('is derived, so an empty register counts zero rather than being unknown', () => {
    assert.equal(portfolioCounts([]).authored, 0)
  })
})

describe('the register as rendered', () => {
  it('puts what needs work first, then the fewest blockers, then alphabetical', () => {
    const view = portfolioView([
      plugin({ id: 'z', name: 'published-one', status: 'public' }),
      plugin({ id: 'y', name: 'almost', hasScreenshot: false }),
      plugin({ id: 'x', name: 'far-off', hasScreenshot: false, hasReadme: false, gitReady: false }),
      plugin({ id: 'w', name: 'aaa-far-off', hasScreenshot: false, hasReadme: false, gitReady: false }),
    ], TODAY)
    assert.deepEqual(view.entries.map((entry) => entry.name), [
      'almost', 'aaa-far-off', 'far-off', 'published-one',
    ])
  })

  it('sorts work above the rows that can never be published', () => {
    // Found by rendering: "Better sidebar" (third-party, unpublishable) sorted
    // ABOVE "Planner" (a fork with two fixable blockers), because both had two
    // blockers. The list is read as "what next", so a row that must not happen
    // can never lead it.
    const view = portfolioView([
      plugin({ id: 'a', name: 'aaa-theirs', origin: 'third-party', visibility: 'internal' }),
      plugin({ id: 'b', name: 'zzz-ours', hasScreenshot: false, hasReadme: false }),
    ], TODAY)
    assert.deepEqual(view.entries.map((entry) => entry.name), ['zzz-ours', 'aaa-theirs'])
  })

  it('carries the blockers and the age on every entry', () => {
    const view = portfolioView([plugin({ verifiedAt: '2026-09-20' })], TODAY)
    assert.equal(view.entries[0]?.publishable, true)
    assert.deepEqual(view.entries[0]?.blockers, [])
    assert.equal(view.entries[0]?.verifiedDaysAgo, 6)
  })

  it('reports no age when the facts were never verified', () => {
    const view = portfolioView([plugin({ verifiedAt: undefined })], TODAY)
    assert.equal(view.entries[0]?.verifiedDaysAgo, null)
  })
})
