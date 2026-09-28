/**
 * The public-resume export: the register, rendered for people who are not the operator.
 *
 * WHY THIS EXISTS. The portfolio register is a private console: it carries the gate, the
 * blockers, the verification dates and the exact shell to publish. None of that belongs
 * in front of a client — and none of the numbers in a public résumé should be TYPED,
 * because a typed count drifts the first time a plugin is added. So the public section
 * is DERIVED from the same records the gate reads, and it is spliced into a hand-written
 * document rather than replacing it: the prose is the operator's voice, the facts are
 * generated facts, and the boundary between them is a pair of markers.
 *
 * WHAT IT REFUSES, and why each refusal is a rule rather than a preference:
 *
 *   - **Nothing unpublished appears.** A résumé that links to a repository that does not
 *     exist yet is worse than a shorter résumé: the link 404s, and the reader learns the
 *     author advertises vapour. So an entry is exported only when it is `public` AND
 *     carries a URL — which also means the published COUNT always equals the list.
 *   - **`internal` and `third-party` never appear**, at all. That is the gate's own
 *     refusal: someone else's work is not ours to advertise, and work marked internal is
 *     internal.
 *   - **No gate internals.** No commands, no pre-flight notes, no scan dates: they are
 *     the console's language, and one of them is a private scanner path that exists
 *     only on the operator's machine.
 *   - **No silent append.** `spliceExport` refuses a document whose markers are missing
 *     or out of order, because appending a generated block to a hand-written file turns a
 *     readme into a mess the first time the marker is renamed.
 *
 * Pure: no IO, no clock, no context. The caller supplies the entries and the document
 * text, which is what makes the refusals above testable rather than hoped for.
 * @module dsh-daily-progress-tab/export
 */

import type { PortfolioEntry } from './types.ts'

/** Every display field on a record is OPTIONAL — the register is written by hand and by tool. */
const text = (value: string | undefined): string => (value ?? '').trim()

/** The pair of markers the generated block lives between. */
export const EXPORT_BEGIN = '<!-- dsh-portfolio:begin — generated, do not edit by hand -->'
export const EXPORT_END = '<!-- dsh-portfolio:end -->'

/** True when this record may appear in public, on the evidence the register holds. */
export function isExportable(entry: PortfolioEntry): boolean {
  if (entry.visibility !== 'showcase') return false
  if (entry.origin !== 'ours' && entry.origin !== 'fork') return false
  if (entry.status !== 'public') return false
  return text(entry.publicUrl).length > 0
}

/** The public-facing count, derived from the same predicate that decides the list. */
export function exportCounts(entries: readonly PortfolioEntry[]): {
  published: number
  ready: number
  open: number
} {
  let published = 0
  let ready = 0
  for (const entry of entries) {
    if (isExportable(entry)) published += 1
    // "Ready" is the gate's word for publishable with nothing outstanding — a state a
    // reader is told about as a queue, never as a link.
    else if (entry.publishable && entry.status !== 'public' && entry.blockers.length === 0) ready += 1
  }
  return { published, ready, open: published + ready }
}

/**
 * An upstream reference as a link, when it looks like `owner/repo@commit`.
 *
 * Free text is passed through unlinked rather than guessed at: a link built from a string
 * that is not a repository is a 404 with extra steps.
 */
export function upstreamLink(upstream: string): string {
  const trimmed = upstream.trim()
  if (trimmed.length === 0) return ''
  const match = /^([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)(?:@(\S+))?$/.exec(trimmed)
  if (match === null) return trimmed
  const repo = match[1] as string
  const commit = match[2]
  const link = '[' + repo + '](https://github.com/' + repo + ')'
  return commit === undefined ? link : link + ' at `' + commit + '`'
}

/** One plugin, as a résumé line. */
export function renderEntry(entry: PortfolioEntry): string {
  const name = entry.name.trim()
  const url = text(entry.publicUrl)
  const body = text(entry.summary) || text(entry.title)
  const parts: string[] = ['**[' + name + '](' + url + ')**']
  if (body.length > 0) parts.push(' — ' + body)
  const licence = text(entry.licence)
  if (licence.length > 0) parts.push(' `' + licence + '`')
  let line = parts.join('')
  const upstream = text(entry.upstream)
  if (entry.origin === 'fork' && upstream.length > 0) {
    line += '\n  <br>A fork of ' + upstreamLink(upstream) + ', with the upstream licence retained.'
  }
  return line
}

/**
 * The generated block, markers included.
 *
 * Published first and then by name, so the same register always produces the same
 * document — a résumé that reshuffles itself between runs is a diff nobody can review.
 */
export function renderExportBlock(entries: readonly PortfolioEntry[]): string {
  const counts = exportCounts(entries)
  const lines: string[] = [EXPORT_BEGIN, '', '#### Plugins', '']
  if (counts.published === 0) {
    lines.push('**Nothing published yet.**')
  } else {
    const heading = counts.published === 1 ? '1 plugin' : counts.published + ' plugins'
    lines.push('**' + heading + '**, all of them installable today'
      + (counts.ready > 0 ? ' · ' + counts.ready + ' more in the queue' : '') + '.')
    lines.push('')
    const published = entries.filter(isExportable)
      .sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of published) {
      lines.push(renderEntry(entry))
      lines.push('')
    }
  }
  lines.push(EXPORT_END)
  return lines.join('\n')
}

/**
 * Put `block` between the markers of `document`.
 *
 * Returns `null` — never a best guess — when the markers are missing, duplicated or
 * reversed. The caller reports that; the alternative is a generated block appended to the
 * end of a hand-written readme, which is how a document starts lying about itself.
 */
export function spliceExport(document: string, block: string): string | null {
  const begin = document.indexOf(EXPORT_BEGIN)
  const end = document.indexOf(EXPORT_END)
  if (begin === -1 || end === -1) return null
  if (document.indexOf(EXPORT_BEGIN, begin + 1) !== -1) return null
  if (document.indexOf(EXPORT_END, end + 1) !== -1) return null
  if (end < begin) return null
  return document.slice(0, begin) + block + document.slice(end + EXPORT_END.length)
}

/**
 * The same records as a standalone page — the destination the résumé links to, and what a
 * GitHub Pages site would serve. One source, two outputs.
 */
export function renderSiteIndex(entries: readonly PortfolioEntry[]): string {
  const published = entries.filter(isExportable).sort((a, b) => a.name.localeCompare(b.name))
  const items = published.map((entry) => {
    const body = text(entry.summary) || text(entry.title)
    const licence = text(entry.licence)
    return '      <li>\n'
      + '        <a href="' + escapeHtml(text(entry.publicUrl)) + '">' + escapeHtml(entry.name.trim()) + '</a>\n'
      + (body.length > 0 ? '        <p>' + escapeHtml(body) + '</p>\n' : '')
      + (licence.length > 0 ? '        <p class="licence">' + escapeHtml(licence) + '</p>\n' : '')
      + '      </li>'
  })
  return [
    '<!doctype html>',
    '<html lang="en">',
    '  <head>',
    '    <meta charset="utf-8">',
    '    <meta name="viewport" content="width=device-width, initial-scale=1">',
    '    <title>DeepSeek Harness plugins</title>',
    '    <style>',
    '      body { max-width: 44rem; margin: 4rem auto; padding: 0 1rem;',
    '             font: 16px/1.6 system-ui, -apple-system, Segoe UI, sans-serif; }',
    '      h1 { font-size: 1.5rem; }',
    '      ul { list-style: none; padding: 0; }',
    '      li { border-top: 1px solid #8883; padding: 1rem 0; }',
    '      a { font-weight: 650; }',
    '      p { margin: .3rem 0; }',
    '      .licence { opacity: .6; font-size: .85rem; }',
    '    </style>',
    '  </head>',
    '  <body>',
    '    <h1>DeepSeek Harness plugins</h1>',
    published.length === 0
      ? '    <p>Nothing published yet.</p>'
      : '    <ul>\n' + items.join('\n') + '\n    </ul>',
    '  </body>',
    '</html>',
    '',
  ].join('\n')
}

/** The register's text is operator-authored, but a page still has to be a valid document. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
