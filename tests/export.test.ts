/**
 * The public-résumé export. Every rule in `src/export.ts` is a REFUSAL, so every test here
 * is about what must NOT appear: unpublished work, internal work, someone else's work, a
 * link that would 404, and the console's own language (commands, scan notes, private paths).
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  EXPORT_BEGIN, EXPORT_END, exportCounts, isExportable, renderEntry, renderExportBlock,
  renderSiteIndex, spliceExport, upstreamLink,
} from '../src/export.ts'
import type { PortfolioEntry } from '../src/types.ts'

/** A published record, so each test can remove exactly one thing and watch the export refuse. */
function entry(overrides: Partial<PortfolioEntry> = {}): PortfolioEntry {
  return {
    id: 'p1',
    name: 'dsh-cost-bubble',
    title: 'Cost bubble',
    origin: 'ours',
    visibility: 'showcase',
    status: 'public',
    licence: 'MIT',
    summary: 'A draggable pill showing the live cost of the current chat.',
    sourcePath: '~/projects/plugins/dsh-cost-bubble',
    publicUrl: 'https://github.com/octo-dev/dsh-cost-bubble',
    upstream: '',
    installed: true,
    hasLicenseFile: true,
    hasReadme: true,
    hasScreenshot: true,
    sourceOutsideProfile: true,
    leakScanPassed: true,
    preflightPassed: true,
    preflightAt: '2026-09-20',
    preflightNote: 'leak-scan clean over 61 tracked files; commits at 444a931',
    gitReady: true,
    verifiedAt: '2026-09-24',
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
    publishable: true,
    blockers: [],
    verifiedDaysAgo: 3,
    checks: [],
    commands: 'bash ~/bin/leak-scan.sh .   # must print SCAN CLEAN',
    commandsNote: '',
    ...overrides,
  }
}

describe('what the export refuses to publish', () => {
  it('drops work that is not public yet, even when it is ready', () => {
    // A résumé that links to a repository that does not exist is worse than a short one:
    // the reader learns the author advertises vapour.
    assert.equal(isExportable(entry({ status: 'local' })), false)
    assert.equal(renderExportBlock([entry({ status: 'local' })]).includes('dsh-cost-bubble'), false)
  })

  it('drops a public record with no URL, and does NOT count it', () => {
    // The count and the list must agree, or the number is a claim nothing backs.
    const withoutUrl = entry({ publicUrl: '   ' })
    assert.equal(isExportable(withoutUrl), false)
    assert.deepEqual(exportCounts([withoutUrl]), { published: 0, ready: 0, open: 0 })
    assert.match(renderExportBlock([withoutUrl]), /Nothing published yet\./)
  })

  it('never exports internal work, however ready it is', () => {
    assert.equal(isExportable(entry({ visibility: 'internal' })), false)
    assert.equal(renderExportBlock([entry({ visibility: 'internal' })]).includes('cost-bubble'), false)
  })

  it("never exports someone else's work", () => {
    // The gate refuses a third-party plugin at all; a résumé must not be the way around it.
    assert.equal(isExportable(entry({ origin: 'third-party' })), false)
    assert.equal(renderExportBlock([entry({ origin: 'third-party' })]).includes('cost-bubble'), false)
  })

  it('carries no gate internals: no commands, no scan notes, no private paths', () => {
    const block = renderExportBlock([entry()])
    assert.equal(block.includes('leak-scan.sh'), false, 'the command the register holds reached the résumé')
    assert.equal(block.includes('SCAN CLEAN'), false, 'the publish command reached the résumé')
    assert.equal(block.includes('tracked files'), false, "the pre-flight note reached the résumé")
    assert.equal(block.includes('TODO'), false)
    assert.equal(/verified/i.test(block), false, 'the gate checklist reached the résumé')
  })

  it('never appends a generated block to a document without markers', () => {
    // Silently appending is how a hand-written readme starts lying about itself.
    assert.equal(spliceExport('# No markers here\n', 'BLOCK'), null)
    assert.equal(spliceExport(EXPORT_END + 'x' + EXPORT_BEGIN, 'BLOCK'), null, 'reversed markers must be refused')
    assert.equal(spliceExport(EXPORT_BEGIN + 'a' + EXPORT_BEGIN + EXPORT_END, 'BLOCK'), null, 'duplicate begin')
    assert.equal(spliceExport(EXPORT_BEGIN + EXPORT_END + EXPORT_END, 'BLOCK'), null, 'duplicate end')
  })
})

describe('what the export produces', () => {
  it('counts from the same predicate that decides the list', () => {
    const entries = [
      entry({ id: 'a' }),
      entry({ id: 'b', name: 'not-yet-public', status: 'local', publishable: true, blockers: [] }),
    ]
    assert.deepEqual(exportCounts(entries), { published: 1, ready: 1, open: 2 })
    const block = renderExportBlock(entries)
    assert.match(block, /\*\*1 plugin\*\*, all of them installable today · 1 more in the queue\./)
    // Asserted by NAME, not by counting occurrences of a substring: the published entry's
    // own URL contains its name, so a count is ambiguous and reported a false failure.
    assert.equal(block.includes('not-yet-public'), false, 'the unpublished entry must not be listed')
  })

  it('is deterministic: published first, then by name', () => {
    const entries = [entry({ id: 'b', name: 'zebra-plugin' }), entry({ id: 'a', name: 'aaa-plugin' })]
    const first = renderExportBlock(entries)
    const second = renderExportBlock([...entries].reverse())
    assert.equal(first, second, 'the same register must always produce the same document')
    assert.ok(first.indexOf('aaa-plugin') < first.indexOf('zebra-plugin'))
  })

  it('links a fork to its upstream when the reference is a repository, and does not guess otherwise', () => {
    assert.equal(upstreamLink('omdsh-dev/dsh-daily-progress@bedbd28'),
      '[omdsh-dev/dsh-daily-progress](https://github.com/omdsh-dev/dsh-daily-progress) at `bedbd28`')
    assert.equal(upstreamLink('some private note, no repo'), 'some private note, no repo')
    assert.equal(upstreamLink(''), '')
    const fork = renderEntry(entry({ origin: 'fork', upstream: 'omdsh-dev/dsh-daily-progress@bedbd28' }))
    assert.match(fork, /A fork of \[omdsh-dev\/dsh-daily-progress\]/)
    assert.match(fork, /upstream licence retained/)
  })

  it('falls back to the title when there is no summary, and never renders an empty line', () => {
    assert.match(renderEntry(entry({ summary: '' })), /— Cost bubble/)
    // Neither summary nor title: the line is still a link, with no dangling dash.
    assert.equal(renderEntry(entry({ summary: '', title: '' })).includes('—'), false)
  })

  it('says so when nothing is published instead of emitting an empty list', () => {
    const block = renderExportBlock([])
    assert.match(block, /Nothing published yet\./)
    assert.equal(block.includes('#### Plugins\n\n\n'), false, 'an empty list renders as a stray blank')
    assert.ok(block.startsWith(EXPORT_BEGIN))
    assert.ok(block.trimEnd().endsWith(EXPORT_END))
  })

  it('splices between the markers, and does it idempotently', () => {
    const document = '# Me\n\nprose above\n\n' + EXPORT_BEGIN + '\nstale\n' + EXPORT_END + '\n\nprose below\n'
    const block = renderExportBlock([entry()])
    const once = spliceExport(document, block)
    assert.ok(once !== null)
    assert.match(once, /prose above/)
    assert.match(once, /prose below/)
    assert.equal(once.includes('stale'), false, 'the old generated block survived')
    assert.equal(spliceExport(once, block), once, 'splicing twice must change nothing')
  })

  it('escapes the site index, because a generated page is still a page', () => {
    const hostile = entry({ summary: '<script>alert(1)</script> & "quotes"' })
    const html = renderSiteIndex([hostile])
    assert.equal(html.includes('<script>'), false)
    assert.match(html, /&lt;script&gt;/)
    assert.match(html, /&amp;/)
    // And the same refusals hold for the page as for the block.
    assert.equal(renderSiteIndex([entry({ status: 'local' })]).includes('cost-bubble'), false)
    assert.match(renderSiteIndex([]), /Nothing published yet\./)
  })
})
