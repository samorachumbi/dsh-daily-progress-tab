/**
 * Structural tests for the single-page UI.
 *
 * The page has no framework and no build step, so nothing typechecks it and
 * nothing imports it: a typo in an element id, a backtick that terminates the
 * enclosing template literal, or a section that stopped being rendered are all
 * invisible until someone looks at a screenshot. These tests make those failures
 * loud and cheap.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { UI_HTML } from '../src/ui.ts'

/**
 * Every id the script looks up. Two shapes reach the DOM: el("id"), and the
 * (listId, countId) pair fillList takes as plain strings — miss the second and
 * this check silently stops covering the day lists, which is how the vacuity
 * guard below earns its place.
 */
function referencedIds(html: string): string[] {
  const ids = new Set<string>()
  for (const match of html.matchAll(/\bel\(\s*"([^"]+)"\s*\)/g)) ids.add(match[1]!)
  for (const match of html.matchAll(/\bfillList\(\s*"([^"]+)"\s*,\s*"([^"]+)"/g)) {
    ids.add(match[1]!)
    ids.add(match[2]!)
  }
  return [...ids]
}

/** Every id the document actually defines. */
function definedIds(html: string): string[] {
  const ids = new Set<string>()
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) ids.add(match[1]!)
  return [...ids]
}

describe('the planner page is a valid single document', () => {
  it('contains no backtick, which would terminate the enclosing template literal', () => {
    // The invariant is a property of the file, not a count of occurrences: the
    // delimiters are stripped by the time UI_HTML exists, so the string itself
    // must contain none at all. A backtick inside an embedded comment once broke
    // the build with a TS1005 far from the real cause.
    assert.equal(UI_HTML.includes('`'), false)
  })

  it('contains no interpolation marker, which would be evaluated by TypeScript', () => {
    assert.equal(UI_HTML.includes('${'), false)
  })

  it('defines every id its script looks up', () => {
    const defined = new Set(definedIds(UI_HTML))
    const missing = referencedIds(UI_HTML).filter((id) => !defined.has(id))
    // A missing id does not throw: getElementById returns null, the render
    // function throws on the first property access, and the page silently keeps
    // showing the previous snapshot. Nothing else catches that.
    assert.deepEqual(missing, [])
  })

  it('looks up at least the sections it renders, so the check above cannot pass vacuously', () => {
    const referenced = referencedIds(UI_HTML)
    for (const id of ['now-task', 'now-meta', 'now-actions', 'pick-backlog', 'pick-pool',
      'pick-count', 'bl-count', 'pool-count', 'today-list', 'tomorrow-list', 'heat']) {
      assert.ok(referenced.includes(id), 'nothing looks up #' + id)
    }
  })

  it('renders the surfaces that let the operator choose', () => {
    for (const needle of ['id="now-card"', 'bub-pick', 'id="pick-card"', 'Backlog', 'On other days',
      'Work on this now']) {
      assert.ok(UI_HTML.toLowerCase().includes(needle.toLowerCase()), 'missing: ' + needle)
    }
  })

  it('labels every bubble heading with a class that exists in the stylesheet', () => {
    const used = new Set([...UI_HTML.matchAll(/class="[^"]*\bbub-([a-z]+)\b[^"]*"/g)].map((m) => m[1]!))
    for (const hue of used) {
      assert.ok(UI_HTML.includes('.bub-' + hue + ' '), 'no style rule for .bub-' + hue)
    }
    assert.ok(used.size >= 8, 'expected the full palette, found ' + used.size)
  })

  it('gives the new pink heading a hue-clearing fill rather than a red one', () => {
    // Hues are kept >=30 degrees apart so no two headings are confusable. The
    // nearest neighbours are magenta (focus, 292) and red (live, 0); a mid pink
    // sits 34 degrees from each. This asserts the chosen fill, not the intent.
    assert.ok(UI_HTML.includes('.bub-pick     { --b1: #cc0074; --b2: #8a004e; }'))
  })

  it('never declares a text colour that another class on the same element overrules', () => {
    // A colour rule that can never take effect still looks plausible in the
    // stylesheet, which is how the spark triage line declared amber and rendered
    // muted: .spark-due was declared BEFORE .closed-line, so on the one element
    // carrying both classes the later rule won and the amber was dead code.
    //
    // Two rules may share an element and BOTH work — that is normal — as long as
    // the one meant to win is declared later. The defect is a declaration that is
    // overruled on EVERY element that uses it, so it never reaches the page.
    const rules = [...UI_HTML.matchAll(/(?:^|\n)\s*\.([a-z][a-z0-9-]*)\s*\{([^}]*)\}/gi)]
      .filter((match) => /(^|;|\s)color\s*:/.test(match[2]!))
      .map((match, index) => ({ name: match[1]!, index }))

    // Every element in the page, as its set of classes. The strings come from the
    // WHOLE className statement rather than only a directly-quoted one: the first
    // version of this check matched just className = "..." and so never saw the
    // very element it was written for, whose class list is chosen in a ternary.
    // It passed while the defect was reintroduced — a guard that cannot fail on
    // the thing it describes is not a guard.
    const elements: string[][] = []
    for (const statement of UI_HTML.matchAll(/className\s*=\s*([^;]*);/g)) {
      for (const literal of statement[1]!.matchAll(/"([^"]*)"/g)) {
        elements.push(literal[1]!.split(/\s+/).filter(Boolean))
      }
    }
    for (const attribute of UI_HTML.matchAll(/\sclass="([^"]*)"/g)) {
      elements.push(attribute[1]!.split(/\s+/).filter(Boolean))
    }

    const overruled = rules.filter((rule) => {
      const carriers = elements.filter((classes) => classes.includes(rule.name))
      if (carriers.length === 0) return false
      return carriers.every((classes) => classes.some((other) => {
        const rival = rules.find((candidate) => candidate.name === other)
        return rival !== undefined && rival.index > rule.index
      }))
    }).map((rule) => '.' + rule.name)

    assert.deepEqual(overruled, [], 'these text colours are always beaten by a later rule on the same element')
  })
})

/** WCAG relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const channel = (index: number): number => {
    const value = parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16) / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2)
}

/** WCAG contrast ratio between two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * The custom properties declared in one of the page's two theme blocks. The dark
 * block is stripped out first, so whichever `:root` remains is the light one.
 */
function themeTokens(html: string, theme: 'light' | 'dark'): Record<string, string> {
  const darkBlock = /@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(html)
  const block = theme === 'dark'
    ? darkBlock?.[1] ?? ''
    : /:root\s*\{([^}]*)\}/.exec(html.replace(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{[^}]*\}\s*\}/, ''))?.[1] ?? ''
  const out: Record<string, string> = {}
  for (const match of block.matchAll(/--([a-z-]+)\s*:\s*(#[0-9a-fA-F]{6})/g)) out[match[1]!] = match[2]!
  return out
}

describe('colour carries meaning legibly, in both themes', () => {
  // Measured on a rendered page before this existed: amber text at 2.39:1 and
  // green at 3.73:1 in the light theme. The cause was one accent colour doing two
  // jobs — reading well as a fill, far too light as text. These assertions are the
  // mechanical half of that fix; the rendered measurement is the evidence.
  it('parses both theme blocks, so the checks below cannot pass vacuously', () => {
    for (const theme of ['light', 'dark'] as const) {
      const tokens = themeTokens(UI_HTML, theme)
      for (const required of ['bg', 'card', 'ink', 'muted', 'ok-ink', 'warn-ink', 'danger-ink', 'accent-ink']) {
        assert.ok(tokens[required], theme + ' theme is missing --' + required)
      }
    }
  })

  it('clears 4.5:1 for every token used as text, on both surfaces of both themes', () => {
    for (const theme of ['light', 'dark'] as const) {
      const tokens = themeTokens(UI_HTML, theme)
      for (const token of ['ink', 'muted', 'ok-ink', 'warn-ink', 'danger-ink', 'accent-ink']) {
        for (const surface of ['card', 'bg']) {
          const ratio = contrast(tokens[token]!, tokens[surface]!)
          assert.ok(ratio >= 4.5,
            theme + ': --' + token + ' on --' + surface + ' is ' + ratio.toFixed(2) + ':1, needs 4.5:1')
        }
      }
    }
  })

  it('never uses a decoration token as ink', () => {
    // The structural half of the fix. `--ok`/`--warn`/`--danger` are chosen to look
    // right as AREAS; the moment one is used for `color:` the class of bug returns.
    const misuse = [...UI_HTML.matchAll(/(?<![-a-z])color:\s*var\(--(?:ok|warn|danger)\)/g)]
    assert.deepEqual(misuse.map((m) => m[0]), [])
  })

  it('never puts white text on an ink token used as a fill', () => {
    // A fill needs a fill colour. White on the dark theme's light-red ink is
    // 2.77:1 — a real mistake made and caught while fixing this.
    assert.equal(/background:\s*var\(--[a-z-]*-ink\)[^}]*color:\s*#fff/i.test(UI_HTML), false)
  })

  it('keeps white text on the killed-verdict fill legible in both themes', () => {
    // Fixed rather than themed, so it holds whichever theme is on screen.
    const fill = /--danger-ink: #b91c1c/.test(UI_HTML) ? '#b91c1c' : '#dc2626'
    assert.ok(contrast('#ffffff', fill) >= 4.5, 'white on the kill fill is ' + contrast('#ffffff', fill).toFixed(2) + ':1')
  })
})
