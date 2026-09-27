/**
 * Grade the demo page BEFORE photographing it, so the image is a claim about what
 * actually rendered.
 *
 * Run it through the shipped driver, which evaluates this against the rendered
 * DOM and prints the result:
 *
 *   node scripts/screenshot.mjs http://127.0.0.1:3098/daily-progress-tab/ui out.png \
 *     --theme dark --full --wait '.pfol-row' --grade scripts/grade-demo.js
 *
 * WHY IT EXISTS. A screenshot is a claim: "this page shows a green gate and the
 * commands to publish". If a card failed to render, the picture is not evidence
 * of it — and a picture of the wrong store is evidence of nothing at all. So the
 * counts are read from the DOM first, and the numbers this prints are the numbers
 * the README's caption describes.
 *
 * The values come from a demo store seeded through the plugin's own API (see
 * seed-demo-store.py), never from the operator's real register.
 *
 * `pfolNote` counts the withheld-command notes: a row that is green with no
 * commands must SAY why, and this is how a render is checked for it.
 */
;(() => {
  const text = (id) => (document.getElementById(id)?.textContent || '').trim()
  const count = (sel) => document.querySelectorAll(sel).length

  return {
    pagePx: [document.body.scrollWidth, document.body.scrollHeight],
    now: text('now-task'),
    nowMeta: text('now-meta').slice(0, 80),
    thermo: text('thermo-label') + ' / ' + text('thermo-pct'),
    projectCards: count('#projects > *') + count('#pending > *') + count('#live > *'),
    workingColumn: count('#projects > *'),
    pendingColumn: count('#pending > *'),
    liveColumn: count('#live > *'),
    todayRows: count('#today-list li'),
    todayCount: text('today-count'),
    tomorrowRows: count('#tomorrow-list li'),
    backlogRows: count('#pick-backlog .pickrow'),
    poolRows: count('#pick-pool .pickrow'),
    overdueChips: count('.pickwhen.overdue'),
    sparkRows: count('.pspark'),
    portfolioRows: count('.pfol-row'),
    readyBanners: count('.pfol-ready'),
    commandBlocks: count('.pfol-cmd'),
    noteBlocks: count('.pfol-note'),
    neverMarks: count('.pfol-check.never'),
    passMarks: count('.pfol-check.ok'),
    portfolioCounts: text('pfol-counts'),
  }
})()
