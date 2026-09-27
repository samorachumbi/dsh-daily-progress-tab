import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  NO_PUBLISH_SETTINGS, VERIFY_STALE_DAYS, gateChecks, isPublishable, portfolioCounts, portfolioView,
  publishBlockers, publishCommands, withheldNote,
} from '../src/portfolio.ts'
import type { PluginRecord } from '../src/types.ts'
import type { PublishSettings } from '../src/portfolio.ts'

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
    preflightPassed: true,
    preflightAt: '2026-09-26',
    gitReady: true,
    verifiedAt: '2026-09-26',
    createdAt: '2026-09-26T00:00:00.000Z',
    updatedAt: '2026-09-26T00:00:00.000Z',
    ...overrides,
  }
}

const TODAY = '2026-09-26'

/**
 * A CONFIGURED deployment.
 *
 * The owner and the scanner are config now, not constants. As constants they held
 * the author's GitHub account and the path to the author's private scanner, so
 * every reader's page offered a command aimed at an account that was not theirs.
 * Nothing here is the author's: a fixture in a public repository must be
 * reproducible by the reader who runs it.
 */
const SETTINGS: PublishSettings = { owner: 'octo-dev', scan: '~/bin/leak-scan.sh' }

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
    // A plugin of ours that reads private material is internal for good.
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
describe('the gate as a checklist', () => {
  it('reports EVERY item, passed ones included, in a fixed order', () => {
    // The point of the panel: "it said ready" is not a record of what was
    // checked. A gate that renders nothing when it is green cannot be told apart
    // from one that never ran, so the passed items have to be named too.
    assert.deepEqual(gateChecks(plugin(), TODAY).map((item) => item.key), [
      'origin', 'visibility', 'leak-scan', 'preflight', 'source', 'address',
      'licence', 'upstream', 'readme', 'screenshot', 'git', 'recency',
    ])
    assert.equal(gateChecks(plugin(), TODAY).every((item) => item.ok), true)
  })

  it('gives every failed item a reason and every passed item none', () => {
    const checks = gateChecks(plugin({ hasScreenshot: false, gitReady: false }), TODAY)
    const bad = checks.filter((item) => !item.ok)
    assert.deepEqual(bad.map((item) => item.key), ['screenshot', 'git'])
    assert.deepEqual(bad.map((item) => item.detail), ['no screenshot', 'no git repository with a clean tree'])
    assert.equal(checks.filter((item) => item.ok).every((item) => item.detail === ''), true)
  })

  it('derives the blocker list from the checklist, so the two cannot disagree', () => {
    // The invariant that makes the short list safe to trust: it IS the long one.
    // Every state the gate can be in, including the ones where the two rules
    // (refusal first, published means nothing blocks) change the answer.
    for (const sample of [
      plugin(), plugin({ hasScreenshot: false }), plugin({ leakScanPassed: undefined }),
      plugin({ preflightPassed: false }), plugin({ origin: 'third-party', visibility: 'internal' }),
      plugin({ origin: 'third-party', visibility: 'showcase' }), plugin({ visibility: 'internal' }),
      plugin({ verifiedAt: '2026-01-01' }), plugin({ origin: 'fork' }), plugin({ status: 'public' }),
      plugin({ status: 'public', hasScreenshot: false }),
    ]) {
      const failed = gateChecks(sample, TODAY).filter((item) => !item.ok)
      const fatal = failed.filter((item) => item.fatal)
      const expected = fatal.length > 0
        ? fatal.map((item) => item.detail)
        : (sample.status === 'public' ? [] : failed.map((item) => item.detail))
      assert.deepEqual(publishBlockers(sample, TODAY), expected)
    }
  })

  it('treats the pre-flight as its own fact, separate from the leak scan', () => {
    // The scan says the tree is safe to publish; the pre-flight says it still
    // WORKS. A plugin that no longer builds damages the goal this register
    // serves more than an unpublished one does, so they cannot collapse.
    assert.deepEqual(publishBlockers(plugin({ preflightPassed: false }), TODAY),
      ['the pre-flight has not passed for this tree — run it and record the result'])
    assert.equal(publishBlockers(plugin({ preflightPassed: undefined }), TODAY).length, 1)
    assert.equal(publishBlockers(plugin({ leakScanPassed: false }), TODAY).length, 1)
  })

  it('shows a refusal as permanent and adds no to-do list behind it', () => {
    // Everything else is broken, and the origin still refuses. The panel must
    // show the refusal and stop, not nine items of work on something that must
    // not happen.
    const theirs = plugin({ origin: 'third-party', hasScreenshot: false, gitReady: false, hasReadme: false })
    const checks = gateChecks(theirs, TODAY)
    assert.deepEqual(checks.map((item) => item.key), ['origin', 'visibility'])
    assert.deepEqual(checks.filter((item) => !item.ok).map((item) => [item.key, item.fatal]), [['origin', true]])
  })
})

describe('the commands offered to publish', () => {
  it('carries the whole sequence for a publishable plugin', () => {
    const commands = publishCommands(plugin(), TODAY, SETTINGS)
    assert.match(commands, /^# Publish dsh-cost-bubble as octo-dev\/dsh-cost-bubble/m)
    assert.ok(commands.includes('bash ~/bin/leak-scan.sh .'))
    assert.ok(commands.includes('cd ~/projects/plugins/dsh-cost-bubble'))
    assert.ok(commands.includes('git remote add origin https://github.com/octo-dev/dsh-cost-bubble.git'))
    assert.ok(commands.includes('git push -u origin main'))
  })

  it('is EMPTY for third-party work, internal work and anything already public', () => {
    // The affordance is absent in code, not hidden at render time: there is
    // nothing here for a page to switch off and nothing for the model to hand
    // over. This is the property that makes any publish button safe to ship.
    assert.equal(publishCommands(plugin({ origin: 'third-party' }), TODAY, SETTINGS), '')
    assert.equal(publishCommands(plugin({ origin: 'third-party', visibility: 'showcase' }), TODAY, SETTINGS), '')
    assert.equal(publishCommands(plugin({ visibility: 'internal' }), TODAY, SETTINGS), '')
    assert.equal(publishCommands(plugin({ status: 'public' }), TODAY, SETTINGS), '')
    // The control: the same record with none of those three flags DOES get them.
    // A fork needs its upstream recorded before the gate is green, and that is a
    // gate item rather than part of this refusal, so it is supplied here.
    assert.ok(publishCommands(plugin({ origin: 'fork', upstream: 'omdsh-dev/x@bedbd28' }), TODAY, SETTINGS)
      .includes('git push -u origin main'))
  })

  it('is EMPTY when the source path is missing or cannot be pasted safely', () => {
    // The text is COPIED AND PASTED, so a metacharacter inside it is an
    // instruction to a shell. A path that is not a bare word yields NO commands
    // rather than a command that does something else.
    assert.equal(publishCommands(plugin({ sourcePath: undefined }), TODAY, SETTINGS), '')
    assert.equal(publishCommands(plugin({ sourcePath: '   ' }), TODAY, SETTINGS), '')
    const hostile = [
      '~/x; rm -rf /', '~/a b', '~/x$(whoami)', '~/x`id`', '~/x\nls',
      '~/x|tee /etc/passwd', '~/x&', '~/x>out', '~/x"y"', "~/x'y'", '~/x*y',
    ]
    for (const path of hostile) {
      assert.equal(publishCommands(plugin({ sourcePath: path }), TODAY, SETTINGS), '',
        'accepted ' + JSON.stringify(path))
    }
  })

  it('emits nothing the shell would act on, for any accepted record', () => {
    // The positive half: what IS emitted must be inert. Trailing newlines and a
    // leading dot are exercised too, because the pattern is a whitelist and a
    // whitelist is only as good as the characters it actually rejects.
    const commands = publishCommands(plugin(), TODAY, SETTINGS)
    // NON-VACUITY FIRST. With no configured deployment this block is empty, and
    // three assertions about an empty string prove nothing — this test passed
    // vacuously for the length of one edit, because a marker collided with the
    // same line inserted by another edit and the change was skipped. A check that
    // cannot fail is not a check.
    assert.ok(commands.length > 100, 'the fixture emitted nothing to inspect')
    assert.equal(/[`$]/.test(commands), false)
    assert.equal(/\$\(/.test(commands), false)
    assert.equal(/\n\nrm/.test(commands), false)
  })

  it('is EMPTY for a name that is not a repository name', () => {
    assert.equal(publishCommands(plugin({ name: 'a b' }), TODAY, SETTINGS), '')
    assert.equal(publishCommands(plugin({ name: '../escape' }), TODAY, SETTINGS), '')
  })

  it('withholds every command when the deployment has no publish owner', () => {
    // The default, and the state a reader's own instance starts in. Withholding
    // is the safe direction: with no account there is no repository URL to
    // compose, and a placeholder pasted into a shell is a push to a place nobody
    // intended. An old version of this file answered with the AUTHOR's account.
    assert.equal(publishCommands(plugin(), TODAY), '')
    assert.equal(publishCommands(plugin(), TODAY, NO_PUBLISH_SETTINGS), '')
    // A scanner alone does not make a block publishable: the account is the part
    // that cannot be substituted.
    assert.equal(publishCommands(plugin(), TODAY, { owner: '', scan: SETTINGS.scan }), '')
  })

  it('is EMPTY for an owner that is not a GitHub account name', () => {
    for (const owner of ['samora; rm -rf /', 'a b', '', '   ', 'x/y', '$(id)', '-lead', 'x`id`']) {
      assert.equal(publishCommands(plugin(), TODAY, { owner, scan: SETTINGS.scan }), '',
        'accepted ' + JSON.stringify(owner))
    }
    // The control: the characters GitHub actually allows in an account name pass.
    assert.ok(publishCommands(plugin(), TODAY, { owner: 'octo-dev.9_x', scan: '~/.local/bin/scan.sh' })
      .includes('octo-dev.9_x/dsh-cost-bubble'))
  })

  it('degrades ONE line, not the block, when no scanner is configured', () => {
    // The rest of the sequence is still what the reader needs, so an unset
    // scanner replaces its own line. What it must never do is point at a file
    // that exists on the author's machine and nowhere else.
    const commands = publishCommands(plugin(), TODAY, { owner: SETTINGS.owner, scan: '' })
    assert.ok(commands.includes('git push -u origin main'))
    assert.ok(commands.includes('# scan this tree for anything that must not be public'))
    // It names the field, so the reader can wire it instead of guessing.
    assert.ok(commands.includes('leakScan'))
    assert.equal(/^bash /m.test(commands), false, 'emitted a scanner command with no scanner configured')
  })

  it('is EMPTY for a configured scanner that cannot be pasted', () => {
    // A configured value IS an instruction to a shell, so a bad one withholds
    // everything — it never yields a different command.
    for (const scan of ['~/x; rm -rf /', '~/a b', '~/x$(id)', '~/x`id`', '~/x|tee /etc/passwd', '~/x&']) {
      assert.equal(publishCommands(plugin(), TODAY, { owner: SETTINGS.owner, scan }), '',
        'accepted ' + JSON.stringify(scan))
    }
  })

  it('ships no account and no scanner path of its own', () => {
    // THE REGRESSION GUARD, and it is mechanical on purpose. The defect: two
    // constants named the author's GitHub account and the author's private
    // scanner, so the emitted block was a command a reader could not run, aimed
    // at an account that was not theirs — and the leak scan reported CLEAN,
    // because a lexical scan cannot tell a handle from a word.
    //
    // It is VALUE-FREE deliberately: asserting the absence of the author's handle
    // would write the handle into a repository that has no business carrying it.
    // So the check is on the mechanism that made the defect expressible, plus the
    // behaviour a reader actually meets.
    const source = readFileSync(new URL('../src/portfolio.ts', import.meta.url), 'utf8')
    assert.equal(source.match(/PUBLISH_OWNER|PUBLISH_SCAN/), null)
    assert.deepEqual(NO_PUBLISH_SETTINGS, { owner: '', scan: '' })
  })

  it('reaches the page on the entry, so the two views cannot differ', () => {
    const internal = portfolioView([plugin({ visibility: 'internal' })], TODAY)
    assert.equal(internal.entries[0]?.commands, '')
    assert.equal(internal.entries[0]?.checks.every((item) => item.name.length > 0), true)
    const ready = portfolioView([plugin()], TODAY, SETTINGS)
    assert.ok(ready.entries[0]?.commands.includes('git push -u origin main'))
  })

  it('offers the commands when, and ONLY when, every gate item passes', () => {
    // Both directions, because each is a different failure. The dangerous one is
    // the first: commands under a BLOCKED row let the gate be pasted past, and
    // this register's own fork was exactly that case - publishable, with a leak
    // scan that failed on material in README.md that must not be public.
    const samples = [
      plugin(), plugin({ sourcePath: undefined }), plugin({ sourcePath: '   ' }),
      plugin({ sourcePath: '~/a b' }), plugin({ sourcePath: '~/x; rm -rf /' }),
      plugin({ name: 'a b' }), plugin({ name: '../escape' }),
      plugin({ hasScreenshot: false }), plugin({ leakScanPassed: false }),
      plugin({ preflightPassed: false }), plugin({ gitReady: false }),
      plugin({ verifiedAt: '2026-01-01' }),
      plugin({ origin: 'fork' }), plugin({ origin: 'fork', upstream: 'omdsh-dev/x@bedbd28' }),
      plugin({ status: 'public' }), plugin({ visibility: 'internal' }),
      plugin({ origin: 'third-party', visibility: 'showcase' }),
    ]
    let green = 0
    for (const sample of samples) {
      const commands = publishCommands(sample, TODAY, SETTINGS)
      const allowed = isPublishable(sample) && sample.status !== 'public'
      if (!allowed) {
        assert.equal(commands, '', 'offered commands for ' + sample.origin + '/' + sample.visibility)
        continue
      }
      const blocked = publishBlockers(sample, TODAY).length > 0
      assert.equal(commands !== '', !blocked,
        'blocked=' + blocked + ' but the commands were ' + commands.length + ' characters for ' + sample.name)
      if (!blocked) green += 1
    }
    // Both branches were reached, so the equivalence above is not vacuous.
    assert.ok(green > 0, 'no sample reached a green gate')
    // And the address check is still doing its own job when everything else is
    // green, which is the only case where a blank panel would otherwise be silent.
    const bad = plugin({ sourcePath: '~/a b' })
    assert.deepEqual(gateChecks(bad, TODAY).filter((item) => !item.ok).map((item) => item.key), ['address'])
    assert.equal(publishCommands(bad, TODAY, SETTINGS), '')
    assert.ok(gateChecks(plugin(), TODAY).find((item) => item.key === 'address')?.ok)
  })
})

describe('a green row with nothing to paste says why', () => {
  it('names the missing config field instead of rendering nothing', () => {
    // Found by wiring the two config fields: without this, an unconfigured
    // deployment rendered "READY TO PUBLISH — every item above passes" above
    // NOTHING. That is the exact self-contradiction the `address` gate item
    // exists to prevent, so the reason is derived onto the entry instead.
    //
    // The gate stays TWELVE items: the account is a property of the deployment,
    // not a defect in the plugin, and reddening every row for someone who never
    // publishes would be worse than the blank it fixes.
    const entry = portfolioView([plugin()], TODAY).entries[0]
    assert.equal(entry?.commands, '')
    assert.match(entry?.commandsNote ?? '', /no publish owner is configured/)
    assert.match(entry?.commandsNote ?? '', /publishOwner/)
    // The gate itself is untouched by it, in both directions.
    assert.deepEqual(entry?.blockers, [])
    assert.equal(entry?.checks.filter((item) => !item.ok).length, 0)
    // And with a configured deployment there is nothing to explain.
    assert.equal(portfolioView([plugin()], TODAY, SETTINGS).entries[0]?.commandsNote, '')
  })

  it('says nothing when the row already has its own answer', () => {
    // A refusal and a failed gate item are reported on the row already; a second
    // reason in different words would be two answers to one question.
    const quiet = [
      plugin({ origin: 'third-party', visibility: 'internal' }),
      plugin({ visibility: 'internal' }),
      plugin({ hasScreenshot: false }),
      plugin({ sourcePath: '~/a b' }),
      plugin({ status: 'public' }),
    ]
    for (const sample of quiet) {
      assert.equal(portfolioView([sample], TODAY).entries[0]?.commandsNote, '',
        'explained a row that already had an answer: ' + sample.origin + '/' + sample.visibility)
    }
    assert.equal(withheldNote(plugin(), TODAY, SETTINGS), '')
  })

  it('explains a configured value it cannot hand over', () => {
    // The other states that would otherwise be silent: config IS set, and cannot
    // be pasted. Both are named rather than swallowed.
    assert.match(withheldNote(plugin(), TODAY, { owner: 'a b', scan: '' }), /publishOwner cannot be pasted/)
    assert.match(withheldNote(plugin(), TODAY, { owner: SETTINGS.owner, scan: '~/a b' }), /leakScan cannot be pasted/)
  })
})
