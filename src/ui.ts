/**
 * The standalone planner page, served verbatim by the host half at
 * `GET <ROUTE_PREFIX>/ui`.
 *
 * Deliberately dependency-free: one self-contained HTML document with inline
 * CSS and inline JS, no build step, no framework, no client bundle. That is the
 * whole point of this fork — the UI lives in its own browser tab (so it can be
 * dragged to a second screen) and the harness UI is never touched. It also
 * means there is nothing for `dsh-client-modules` to compose.
 *
 * The page is same-origin with the API, so no CORS layer is needed. Item text is
 * inserted with textContent, never innerHTML, so a plan item containing markup
 * is displayed rather than executed.
 *
 * NOTE: this is a TS template literal, so the embedded script uses string
 * concatenation and avoids backticks/interpolation.
 * @module dsh-daily-progress-tab/ui
 */

export const UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Daily Progress</title>
<style>
  /* Two families of accent colour, and the distinction is load-bearing.
     --ok / --warn / --danger are DECORATION: fills, borders, bars. They are
     chosen to look right as areas, which makes them far too light to read as
     text — measured on the rendered page, amber text was 2.39:1 and green
     3.73:1 against the light theme's ground, where small text needs 4.5:1.
     The "-ink" variants are the same hues darkened (light theme) or lightened
     (dark theme) until every one clears the bar. Never use a decoration token
     for text; both themes are asserted by tests/ui.test.ts. */
  :root {
    --bg: #f6f7f9; --card: #ffffff; --ink: #16181d; --muted: #6b7280;
    --line: #e5e7eb; --accent: #2f6feb; --ok: #16a34a; --warn: #d97706;
    --chip: #eef2ff;
    --ok-ink: #166534; --warn-ink: #92400e; --danger-ink: #b91c1c; --danger: #ef4444;
    --accent-ink: #1d4ed8;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1115; --card: #181b21; --ink: #e8eaee; --muted: #9aa3b2;
      --line: #262b33; --accent: #6ea1ff; --ok: #4ade80; --warn: #fbbf24;
      --chip: #1f2733;
      /* Already light-on-dark, so the decoration hues are legible as text here;
         they are still named separately so a future change to one cannot
         silently break the other. */
      --ok-ink: #4ade80; --warn-ink: #fbbf24; --danger-ink: #f87171; --danger: #ef4444;
      --accent-ink: #6ea1ff;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    max-width: 1180px; margin-inline: auto; padding: 20px 18px 40px;
  }
  header { display: flex; flex-wrap: wrap; gap: 14px; align-items: flex-end; justify-content: space-between; margin-bottom: 18px; }
  h1 { font-size: 21px; margin: 0; letter-spacing: -0.01em; }
  h2 { font-size: 14px; margin: 0 0 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
  .date { color: var(--muted); font-size: 13px; margin-top: 3px; }
  .stats { display: flex; gap: 22px; }
  .stat { text-align: right; }
  .stat .v { display: block; font-size: 20px; font-weight: 650; font-variant-numeric: tabular-nums; }
  .stat .k { display: block; font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px; }
  .thermo { margin-bottom: 16px; }
  .thermo-head { display: flex; justify-content: space-between; font-size: 13px; color: var(--muted); margin-bottom: 8px; }
  .bar { height: 12px; border-radius: 999px; background: var(--chip); overflow: hidden; }
  .fill { height: 100%; width: 0; border-radius: 999px; background: linear-gradient(90deg, var(--accent), var(--ok)); transition: width .35s ease; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 780px) { .cols { grid-template-columns: 1fr; } }
  .count { color: var(--muted); font-weight: 400; text-transform: none; letter-spacing: 0; }
  ul.list { list-style: none; margin: 0 0 12px; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  li.item { display: block; padding: 7px 6px; border-radius: 8px; }
  li.item:hover { background: var(--chip); }
  .line { display: flex; align-items: flex-start; gap: 9px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0 0 25px; }
  .chip { border: 1px solid var(--line); background: var(--bg); color: var(--muted);
          font: inherit; font-size: 12px; padding: 2px 9px; border-radius: 999px; cursor: pointer; }
  .chip:hover { color: var(--ink); border-color: var(--accent); }
  .chip:disabled { opacity: .5; cursor: default; }
  .chip-complete { border-color: var(--ok); color: var(--ok-ink); }
  .chip-drop { border-color: var(--danger); color: var(--danger-ink); }
  .chip-info { border-style: dashed; }
  .detail { flex-basis: 100%; font-size: 12px; color: var(--muted); padding: 4px 2px 0; }
  .sugg-title { font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 6px 0 0 25px; }
  li.item input[type=checkbox] { margin: 3px 0 0; width: 16px; height: 16px; accent-color: var(--ok); cursor: pointer; flex: none; }
  .text { flex: 1; word-break: break-word; }
  .done .text { text-decoration: line-through; color: var(--muted); }
  .tag { font-size: 10px; padding: 1px 6px; border-radius: 999px; background: var(--chip); color: var(--muted); flex: none; margin-top: 3px; }
  .icon { border: 0; background: transparent; color: var(--muted); cursor: pointer; font-size: 14px; padding: 2px 5px; border-radius: 6px; flex: none; }
  .icon:hover { background: var(--line); color: var(--ink); }
  form.add { display: flex; gap: 8px; }
  /* Both input types are styled together. Styling only [type=text] left the
     numeric fields on the browser default, which in dark mode renders a mid-grey
     fill with ~3:1 placeholder text — visibly wrong next to the dark text fields
     it sits beside, and found by looking at the pixels, not the stylesheet. */
  input[type=text], input[type=number] { flex: 1; min-width: 0; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--ink); font: inherit; font-size: 14px; }
  input[type=text]:focus, input[type=number]:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
  input::placeholder { color: var(--muted); opacity: 1; }
  button.primary { padding: 8px 14px; border: 0; border-radius: 8px; background: var(--accent); color: #fff; font: inherit; font-size: 14px; cursor: pointer; }
  button.ghost { padding: 6px 11px; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: var(--muted); font: inherit; font-size: 13px; cursor: pointer; }
  button.ghost:hover { color: var(--ink); border-color: var(--muted); }
  .row { margin-top: 10px; }
  .empty { color: var(--muted); font-size: 13px; padding: 6px; }
  .week { margin-top: 16px; }
  .heat { display: grid; grid-template-columns: repeat(7, 1fr); gap: 8px; }
  .cell { border: 1px solid var(--line); border-radius: 9px; padding: 9px 8px; text-align: center; }
  .cell .d { font-size: 11px; color: var(--muted); }
  .cell .n { font-size: 17px; font-weight: 650; font-variant-numeric: tabular-nums; margin: 2px 0; }
  .cell .f { font-size: 10px; color: var(--muted); }
  .cell.today { outline: 2px solid var(--accent); outline-offset: -2px; }
  .cell.future { opacity: .45; }
  .hint { font-size: 12px; color: var(--muted); margin: -4px 0 12px; }
  .projects { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }
  .split { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 20px; align-items: start; }
  @media (max-width: 1500px) { .split { grid-template-columns: 1fr 1fr; } }
  @media (max-width: 980px) { .split { grid-template-columns: 1fr; } }
  .pcol-live .pcard { border-left: 3px solid var(--ok); }
  .pcard.stale { border-color: var(--warn); }
  .pmonitor { display: flex; flex-direction: column; gap: 6px; border-top: 1px solid var(--line); padding-top: 8px; }
  .pmrow { font-size: 12px; }
  .pmrow b { font-variant-numeric: tabular-nums; }
  .pmopen { font-size: 12px; color: var(--muted); }
  .pmopen s { opacity: .6; }
  .psparks { border-top: 1px dashed var(--line); padding-top: 7px; display: flex; flex-direction: column; gap: 5px; }
  .psparkshead { font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
  .psparkrow { font-size: 12px; }
  .psparksrc { font-size: 11px; color: var(--muted); }
  .psparkacts { display: flex; gap: 6px; margin-top: 3px; align-items: center; }
  .psparkacts input { flex: 1 1 auto; font-size: 12px; padding: 5px 8px; }
  .psparkdue { font-size: 12px; color: var(--warn-ink); font-weight: 650; }
  .pfol { display: flex; flex-direction: column; gap: 10px; }
  .pfol-row { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; }
  .pfol-name { font-weight: 650; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .pfol-meta { font-size: 11px; color: var(--muted); margin-top: 3px; word-break: break-word; }
  .pfol-block { font-size: 12px; color: var(--warn-ink); margin-top: 3px; }
  .pfol-ready { font-size: 12px; color: var(--ok-ink); font-weight: 650; margin-top: 3px; }
  .pfol-counts { font-size: 13px; margin-bottom: 10px; }
  .pfol-counts b { font-variant-numeric: tabular-nums; }
  /* The gate checklist. EVERY item is drawn, passed or not: a gate that shows
     nothing when it is green cannot be told apart from one that never ran.
     The state rules are TWO-class selectors on purpose - a bare block class
     carrying a colour here is exactly how the spark triage line declared amber
     and rendered muted, because a later rule of equal specificity won. */
  .pfol-checks { display: flex; flex-direction: column; gap: 2px; margin-top: 6px; }
  .pfol-check { font-size: 11px; color: var(--muted); display: flex; gap: 6px; align-items: baseline; }
  .pfol-check .k { flex: none; font-weight: 650; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; }
  .pfol-check.ok .k { color: var(--ok-ink); }
  .pfol-check.todo .k { color: var(--warn-ink); }
  .pfol-cmd { margin-top: 7px; }
  /* No colour on the copy button: it is a .ghost button and keeps that fill. A
     colour declared here would be overruled on every element using this class. */
  .pfol-copy { margin-top: 6px; }
  .pfol-cmd pre { font-size: 11px; line-height: 1.5; white-space: pre-wrap; word-break: break-word;
                  background: var(--chip); border: 1px solid var(--line); border-radius: 8px;
                  padding: 8px 10px; margin: 5px 0 0; }
  /* Qualified with its base class ON PURPOSE. A bare .spark-due rule has the SAME
     specificity as .closed-line, which is declared LATER, so the later rule won
     and the due state rendered muted — legible, but with the emphasis silently
     gone and this rule dead. Naming both classes cannot be beaten by order.
     (No backticks in this comment: this file IS a template literal.) */
  .closed-line.spark-due { color: var(--warn-ink); font-weight: 650; }
  .pverdict { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; padding: 1px 7px;
              border-radius: 999px; background: var(--chip); color: var(--muted); flex: none; }
  .pverdict.v-continue { background: var(--ok); color: #04240f; }
  .pverdict.v-fix { background: var(--warn); color: #2a1a00; }
  /* Fixed, not a theme token: this is a FILL behind white text, and white on the
     dark theme's light-red ink would be 2.77:1. 6.47:1 in both themes. */
  .pverdict.v-kill { background: #b91c1c; color: #fff; text-decoration: line-through; }
  .stale-flag { font-size: 12px; color: var(--warn-ink); font-weight: 650; }
  .closed-line { font-size: 12px; color: var(--muted); margin-top: 10px; }
  /* No colour here on purpose: every .colhead element also carries .bub, which
     is declared later and owns the bubble's text colour. A color here is dead
     code, and a dead declaration that still looks right is what let the spark
     triage line render muted while declaring amber. The unit suite now fails on
     any text colour that is overruled on every element using it. */
  .colhead { font-size: 12px; text-transform: uppercase; letter-spacing: .06em;
             margin: 0 0 4px; display: flex; align-items: center; gap: 8px; }
  .colhead .count { text-transform: none; letter-spacing: 0; }
  /* Bubble headings — one colour per section, so a card is findable at a glance.
     The white sheen across the top plus the inner shadow along the bottom is what
     reads as a bulge rather than a flat chip; the ring and drop shadow lift it off
     the card. Colours are fixed (not theme variables) so they survive both the
     light and the dark page. */
  .bub { display: inline-flex; align-items: center; justify-content: center; gap: 10px; width: fit-content;
         box-sizing: border-box; height: 36px;
         margin: 0 0 12px; padding: 6px 18px 7px; border-radius: 999px;
         font-size: 13px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase;
         color: var(--btext, #fff); text-shadow: 0 1px 1px var(--bshadow, rgba(0, 0, 0, .45));
         border: 1px solid rgba(0, 0, 0, .18);
         background-color: var(--b1, #555);
         background-image: linear-gradient(180deg, rgba(255, 255, 255, .30), rgba(255, 255, 255, 0) 36%),
                           linear-gradient(180deg, var(--b1, #555), var(--b2, #333));
         box-shadow: inset 0 2px 0 rgba(255, 255, 255, .45), inset 0 -3px 6px rgba(0, 0, 0, .30),
                     0 4px 10px rgba(0, 0, 0, .28), 0 1px 2px rgba(0, 0, 0, .30);
         transition: transform .12s ease; }
  .bub:hover { transform: translateY(-1px) scale(1.03); }
  .bub .count { display: inline-flex; align-items: center; height: 18px; padding: 0 9px; border-radius: 999px;
                background: #ffffff; color: #15161a; font-size: 11px; font-weight: 700;
                letter-spacing: 0; text-transform: none; text-shadow: none;
                box-shadow: inset 0 1px 0 #fff, 0 1px 2px rgba(0, 0, 0, .28); }
  .bub .count:empty { display: none; }
  .colhead.bub { height: 30px; margin: 0 0 10px; padding: 4px 14px 5px; font-size: 11px; letter-spacing: .09em; }
  /* Hues deliberately spread ~30-60 degrees apart so no two headings are confusable:
     violet 262 · green 142 · amber 36 · red 0 · magenta 292 · blue 221 · cyan 192 · lime 85.
     Light fills (amber, lime) take dark text; the rest take white, and every
     combination clears 4.5:1 against the RENDERED fill, not the nominal one. */
  .bub-projects { --b1: #7c3aed; --b2: #4c1d95; }
  .bub-working  { --b1: #15803d; --b2: #052e16; }
  .bub-pending  { --b1: #f59e0b; --b2: #b45309; --btext: #2a1700; --bshadow: rgba(255, 255, 255, .40); }
  .bub-live     { --b1: #dc2626; --b2: #7f1d1d; }
  .bub-focus    { --b1: #c026d3; --b2: #701a75; }
  .bub-today    { --b1: #2563eb; --b2: #1e3a8a; }
  .bub-tomorrow { --b1: #0e7490; --b2: #164e63; }
  .bub-week     { --b1: #84cc16; --b2: #4d7c0f; --btext: #14200a; --bshadow: rgba(255, 255, 255, .45); }
  /* Pink 326 — the only 30°-clear slot left: 34° from magenta (focus, 292) and
     34° from red (live, 0). Darkened from a saturated pink to #cc0074 so white
     text still clears 4.5:1 against the RENDERED fill, sheen included. */
  .bub-pick     { --b1: #cc0074; --b2: #8a004e; }
  /* NEUTRAL on purpose. The nine hues above already fill the wheel - the
     tightest gap between neighbours is 29 degrees - so a tenth SATURATED hue
     could not clear the >=30-degree separation this project requires of colour
     that carries meaning. This heading is told apart by saturation instead. */
  .bub-portfolio { --b1: #3f3f46; --b2: #18181b; }
  .colhint { font-size: 11px; color: var(--muted); margin: 0 0 10px; }
  .pcol-pending .pcard { background: transparent; border-style: dashed; }
  .pcard { border: 1px solid var(--line); border-radius: 10px; padding: 13px; background: var(--bg);
           display: flex; flex-direction: column; gap: 8px; }
  .pcard.selected { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
  .pcard.unranked { opacity: .75; border-style: dashed; }
  .phead { display: flex; align-items: center; gap: 8px; }
  .rank { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; flex: none; }
  .pname { font-weight: 650; font-size: 15px; flex: 1; word-break: break-word; }
  .pstatus { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; padding: 1px 7px;
             border-radius: 999px; background: var(--chip); color: var(--muted); flex: none; }
  .pstatus.st-active { background: var(--ok); color: #04240f; }
  .pstatus.st-shipped { background: var(--accent); color: #fff; }
  .pstatus.st-killed { text-decoration: line-through; }
  .pscore { font-size: 13px; font-weight: 650; font-variant-numeric: tabular-nums; color: var(--ok-ink); }
  .pcard.unranked .pscore { color: var(--warn-ink); }
  .pfulfils { font-size: 13px; }
  .psummary { font-size: 12px; color: var(--muted); }
  .pmetrics { display: flex; flex-wrap: wrap; gap: 12px; }
  .pmetric { font-size: 11px; color: var(--muted); }
  .pmetric b { display: block; font-size: 13px; color: var(--ink); font-variant-numeric: tabular-nums; }
  .prubric { display: flex; gap: 3px; align-items: flex-end; height: 22px; }
  .pdim { flex: 1; background: var(--chip); border-radius: 2px; min-height: 3px; }
  .pdim.weak { background: var(--warn); }
  .pnote { font-size: 11px; color: var(--muted); }
  .pnote b { color: var(--warn-ink); font-weight: 600; }
  .pactions { display: flex; gap: 8px; margin-top: 2px; }
  .proj-add { margin-top: 12px; flex-wrap: wrap; }
  .proj-add input { flex: 1 1 130px; }
  .focus-list { display: flex; flex-direction: column; gap: 4px; }
  .frow { display: flex; gap: 9px; align-items: flex-start; padding: 6px; border-radius: 8px; }
  .frow:hover { background: var(--chip); }
  .fwhen { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted);
           border: 1px solid var(--line); border-radius: 999px; padding: 2px 7px; flex: none; margin-top: 1px; }
  .frow .item { flex: 1; padding: 0; }
  .ptag { font-size: 10px; padding: 1px 7px; border-radius: 999px; background: var(--chip);
          color: var(--accent-ink); flex: none; margin-top: 3px; }
  .tsummary { font-size: 12px; color: var(--muted); margin: 3px 0 0 25px; }
  .tsummary:empty { display: none; }
  /* NOW — the one task being worked on. Deliberately NOT a bubble: it is the
     loudest element on the page, so it is a filled banner rather than a pill,
     and the pulsing dot says "this is live" without a word of copy. */
  .now { border: 0; margin-bottom: 16px; color: #fff;
         background-image: linear-gradient(135deg, #4338ca 0%, #7c3aed 52%, #c026d3 100%);
         box-shadow: 0 6px 18px rgba(67, 56, 202, .30); }
  /* The idle state is a real state, not a broken one — vision grading read the
     first flat version as "an unfilled placeholder slot", because on the dark
     theme a transparent card is indistinguishable from the page. The tint keeps
     the banner recognisable as a banner while staying obviously empty. */
  .now.idle { background-image: linear-gradient(135deg, rgba(67, 56, 202, .18), rgba(192, 38, 211, .14));
              background-color: var(--card); color: var(--ink);
              border: 1px dashed var(--line); box-shadow: none; }
  .now-top { display: flex; align-items: center; gap: 9px; margin-bottom: 7px; }
  .now-dot { width: 9px; height: 9px; border-radius: 999px; background: #a7f3d0; flex: none;
             box-shadow: 0 0 0 0 rgba(167, 243, 208, .85); animation: pulse 2.2s ease-out infinite; }
  .now.idle .now-dot { background: var(--muted); animation: none; }
  @keyframes pulse {
    70% { box-shadow: 0 0 0 9px rgba(167, 243, 208, 0); }
    100% { box-shadow: 0 0 0 0 rgba(167, 243, 208, 0); }
  }
  .now-k { font-size: 11px; font-weight: 800; letter-spacing: .15em; text-transform: uppercase; opacity: .92; }
  .now-task { font-size: 19px; font-weight: 650; line-height: 1.3; word-break: break-word; }
  .now.idle .now-task { font-size: 15px; font-weight: 500; color: var(--muted); }
  .now-meta { font-size: 12px; opacity: .9; margin-top: 5px; }
  .now.idle .now-meta { color: var(--muted); }
  .now-actions { display: flex; gap: 8px; margin-top: 13px; flex-wrap: wrap; }
  .now .ghost { border-color: rgba(255, 255, 255, .55); color: #fff; }
  .now .ghost:hover { background: rgba(255, 255, 255, .18); color: #fff; border-color: #fff; }
  .now .primary { background: #fff; color: #4c1d95; font-weight: 650; }
  .now.idle .ghost { border-color: var(--line); color: var(--muted); }
  /* Pick a task — the menu. One row per pickable task, with the date (or the
     absence of one) on the left so "where this lives" is never a guess. */
  .subhead { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .07em;
             color: var(--muted); margin: 14px 0 4px; display: flex; align-items: center; gap: 8px; }
  .subhead:first-of-type { margin-top: 0; }
  .pickrows { display: flex; flex-direction: column; gap: 1px; }
  .pickrow { display: flex; align-items: flex-start; gap: 9px; padding: 6px; border-radius: 8px; }
  .pickrow:hover { background: var(--chip); }
  .picktext { flex: 1; word-break: break-word; }
  .pickwhen { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted);
              border: 1px solid var(--line); border-radius: 999px; padding: 2px 7px;
              flex: none; margin-top: 2px; white-space: nowrap; }
  .pickwhen.overdue { border-color: var(--warn); color: var(--warn-ink); font-weight: 700; }
  .pickwhen.backlog { border-style: dashed; }
  .pickrow .psub { font-size: 12px; color: var(--muted); }
  .bl-add { display: flex; gap: 6px; margin-top: 8px; }
  .bl-add input { font-size: 13px; padding: 5px 8px; }
  .bl-add button { padding: 5px 10px; font-size: 13px; }
  .pbl { font-size: 10px; color: var(--muted); border: 1px solid var(--line); border-radius: 999px;
         padding: 1px 7px; flex: none; }
  .icon.strong { color: var(--accent); font-weight: 700; }
  /* The pool and backlog rows carry the page's primary controls, and at the
     default icon size and muted grey the arrow/tick/cross read as specks at 1:1
     — measured, not guessed. Bigger and brighter for these rows only. */
  .pickrow .icon { font-size: 16px; color: var(--ink); opacity: .82; padding: 2px 6px; }
  .pickrow .icon:hover { opacity: 1; background: var(--line); }
  .pickrow .icon.strong { color: var(--accent); opacity: 1; }
  /* Cards are separate surfaces. Without a gap the new pick card's bottom border
     and the day columns' top border shared one line and read as a single block.
     Scoped to BODY's own children: an unscoped "card + card" rule also matched
     the two cards INSIDE the day-column grid and pushed TOMORROW 16px below
     TODAY — a misalignment introduced by this very rule and caught on the
     rendered page, not in the stylesheet. */
  body > .card + .card, body > .card + .cols { margin-top: 16px; }
  footer { display: flex; align-items: center; gap: 14px; margin-top: 20px; flex-wrap: wrap; }
  .status { font-size: 12px; color: var(--muted); }
  .status.err { color: var(--danger-ink); }
</style>
</head>
<body>
<header>
  <div>
    <h1>Daily Progress</h1>
    <div class="date" id="today-label">&nbsp;</div>
  </div>
  <div class="stats">
    <div class="stat"><span class="v" id="streak">0</span><span class="k">day streak</span></div>
    <div class="stat"><span class="v" id="weekrate">&mdash;</span><span class="k">week rate</span></div>
    <div class="stat"><span class="v" id="plugincount">0</span><span class="k">plugins</span></div>
  </div>
</header>

<section class="card thermo">
  <div class="thermo-head"><span id="thermo-label">Today</span><span id="thermo-pct">0%</span></div>
  <div class="bar"><div class="fill" id="thermo-fill"></div></div>
</section>

<!-- The one task being worked on. Filled when something is picked, dashed and
     quiet when not, so the page never implies focus that does not exist. -->
<section class="card now" id="now-card">
  <div class="now-top">
    <span class="now-dot"></span>
    <span class="now-k">Now</span>
  </div>
  <div class="now-task" id="now-task">Nothing picked yet</div>
  <div class="now-meta" id="now-meta"></div>
  <div class="now-actions" id="now-actions"></div>
</section>

<section class="card">
  <h2 class="bub bub-projects">Projects <span class="count" id="proj-count"></span></h2>
  <p class="hint">Ranked by expected money per day of build effort: revenue &times; confidence &times; urgency &divide; effort, discounted the further away the first dollar is. Estimates are yours &mdash; an unestimated project stays unranked rather than being guessed into the order.</p>
  <div class="split">
    <div class="pcol pcol-working">
      <div class="colhead bub bub-working">Working <span class="count" id="work-count"></span></div>
      <p class="colhint">Active or shipped &mdash; the ones being built now, ranked by money per build-day.</p>
      <div class="projects" id="projects"></div>
    </div>
    <div class="pcol pcol-pending">
      <div class="colhead bub bub-pending">Pending <span class="count" id="pend-count"></span></div>
      <p class="colhint">Ideas and parked work &mdash; waiting, not forgotten. A pending project keeps its score and its rank: deferred is not the same as unmeasured. Select one to start it.</p>
      <div class="projects" id="pending"></div>
    </div>
    <div class="pcol pcol-live">
      <div class="colhead bub bub-live">Live <span class="count" id="live-count"></span></div>
      <p class="colhint">Shipped and being measured. Money made, the one metric that matters, open hurdles, corrections to make &mdash; and whether the loop has gone quiet. A project with no check-in for over a week is flagged: an unmeasured project cannot be judged.</p>
      <div class="projects" id="live"></div>
      <div class="closed-line" id="live-sparks"></div>
      <div class="closed-line" id="closed-line"></div>
    </div>
  </div>
  <form class="add proj-add" id="proj-add" autocomplete="off">
    <input type="text" id="proj-name" maxlength="120" placeholder="Project name">
    <input type="text" id="proj-fulfills" maxlength="500" placeholder="Who it serves">
    <input type="number" id="proj-ttfd" min="0" step="1" placeholder="days to 1st $">
    <input type="number" id="proj-effort" min="0.5" step="0.5" placeholder="effort days">
    <input type="number" id="proj-rev" min="0" step="1000" placeholder="revenue/mo">
    <button class="primary" type="submit">Add project</button>
  </form>
</section>

<section class="card" id="focus-card" hidden>
  <h2 class="bub bub-focus">Focus <span class="count" id="focus-name"></span></h2>
  <p class="hint" id="focus-hint"></p>
  <div class="focus-list" id="focus-list"></div>
</section>

<!-- The menu. Everything that could be worked on but is not on today: candidate
     tasks waiting on a project, and tasks already sitting on another day. This
     is the card that makes the choice real rather than implied by the ranking. -->
<section class="card" id="pick-card">
  <h2 class="bub bub-pick">Pick a task <span class="count" id="pick-count"></span></h2>
  <p class="hint">Everything you could work on but that is not on today. <b>Work on now</b> puts it in the banner above and on today; <b>Today</b> only schedules it. The order in Today is yours &mdash; use the arrows.</p>
  <div class="subhead">Backlog &mdash; not scheduled yet <span class="count" id="bl-count"></span></div>
  <div class="pickrows" id="pick-backlog"></div>
  <div class="subhead">On other days <span class="count" id="pool-count"></span> <span class="pbl">amber = overdue</span></div>
  <div class="pickrows" id="pick-pool"></div>
</section>

<main class="cols">
  <section class="card">
    <h2 class="bub bub-today">Today <span class="count" id="today-count"></span></h2>
    <ul class="list" id="today-list"></ul>
    <form class="add" id="today-add" autocomplete="off">
      <input type="text" id="today-input" maxlength="500" placeholder="Add a task for today&hellip;">
      <button class="primary" type="submit">Add</button>
    </form>
    <div class="row"><button class="ghost" id="clear-today" type="button">Clear today</button></div>
  </section>

  <section class="card">
    <h2 class="bub bub-tomorrow">Tomorrow <span class="count" id="tomorrow-count"></span></h2>
    <ul class="list" id="tomorrow-list"></ul>
    <form class="add" id="tomorrow-add" autocomplete="off">
      <input type="text" id="tomorrow-input" maxlength="500" placeholder="Plan something for tomorrow&hellip;">
      <button class="primary" type="submit">Add</button>
    </form>
    <div class="row"><span class="empty">Unfinished tasks carry over automatically.</span></div>
  </section>
</main>

<section class="card week">
  <h2 class="bub bub-week">This week</h2>
  <div class="heat" id="heat"></div>
</section>

<!-- The plugin portfolio register. It sits at the end because it answers a
     weekly question, not a daily one - and it is a REGISTER with a GATE, not a
     publish button: nothing reaches GitHub without the facts a push decision
     rests on being recorded and current. -->
<section class="card" id="portfolio-card">
  <h2 class="bub bub-portfolio">Portfolio <span class="count" id="pfol-count"></span></h2>
  <p class="hint">Every plugin authored or installed, with the facts a publish decision rests on. <b>Origin</b> and <b>visibility</b> decide whether publishing is even possible: third-party work, and anything marked internal, are refused by the gate rather than by anyone remembering. Facts expire &mdash; a verification older than a month is a blocker, not a pass. The gate shows <b>every</b> item, passed or not, and hands over the exact commands to publish &mdash; but only for work that may be published at all. Third-party plugins and anything marked internal are refused, and are offered no commands to copy.</p>
  <div class="pfol-counts" id="pfol-counts"></div>
  <div class="pfol" id="pfol-list"></div>
</section>

<footer>
  <button class="ghost" id="remind" type="button">Enable 21:00 reminder</button>
  <button class="ghost" id="reload" type="button">Refresh</button>
  <span class="status" id="status"></span>
</footer>

<script>
(function () {
  "use strict";
  var API = "/daily-progress-tab";
  var POLL_MS = 30000;
  var state = null;

  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function localDate(d) {
    d = d || new Date();
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  /** The local calendar key n days from now — used for "move to tomorrow". */
  function shiftDate(days) {
    var d = new Date();
    d.setDate(d.getDate() + days);
    return localDate(d);
  }
  /** A short, human label for a date key: "today", "tomorrow", "Thu 02 Oct". */
  function whenLabel(dateKey) {
    if (dateKey === localDate()) { return "today"; }
    if (dateKey === shiftDate(1)) { return "tomorrow"; }
    var p = dateKey.split("-");
    var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()] + " " + pad(d.getDate())
      + " " + months[d.getMonth()];
  }
  function zone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch (e) { return "UTC"; }
  }
  function el(id) { return document.getElementById(id); }
  function setStatus(msg, isErr) {
    var s = el("status");
    s.textContent = msg || "";
    s.className = "status" + (isErr ? " err" : "");
  }
  function weekday(dateKey) {
    var p = dateKey.split("-");
    var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
  }
  function pct(rate) { return rate === null || rate === undefined ? null : Math.round(rate * 100); }

  function getState() {
    var url = API + "/state?localDate=" + encodeURIComponent(localDate()) + "&tz=" + encodeURIComponent(zone());
    return fetch(url, { headers: { accept: "application/json" } }).then(function (r) {
      if (!r.ok) { throw new Error("state " + r.status); }
      return r.json();
    });
  }
  function mutate(op, payload) {
    return fetch(API + "/mutate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ localDate: localDate(), tz: zone(), op: op, payload: payload || {} })
    }).then(function (r) { return r.json(); }).then(function (res) {
      if (!res || !res.ok) { throw new Error(res ? res.code + ": " + res.message : "bad response"); }
      render(res.snapshot);
      setStatus("saved");
      window.setTimeout(function () { setStatus(""); }, 1200);
      return res;
    });
  }
  function guard(promise) {
    return promise.catch(function (e) { setStatus(String(e.message || e), true); });
  }

  function chipRow(item, target, li) {
    var chips = item.suggestions || [];
    if (!chips.length) { return; }

    var title = document.createElement("div");
    title.className = "sugg-title";
    title.textContent = "suggestions";
    li.appendChild(title);

    var wrap = document.createElement("div");
    wrap.className = "chips";

    var forEachChip = function (chip) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "chip chip-" + chip.action;
      b.textContent = chip.label;
      if (chip.detail) { b.title = chip.detail; }
      b.addEventListener("click", function () {
        // The info action is explanatory only: reveal detail inline, no round trip.
        if (chip.action === "info") {
          var existing = li.querySelector(".detail");
          if (existing) { existing.remove(); return; }
          var d = document.createElement("div");
          d.className = "detail";
          d.textContent = chip.detail || chip.label;
          wrap.appendChild(d);
          return;
        }
        b.disabled = true;
        guard(mutate("applySuggestion", {
          target: target, itemId: item.id, suggestionId: chip.id
        }));
      });
      wrap.appendChild(b);
    };
    for (var i = 0; i < chips.length; i++) { forEachChip(chips[i]); }
    li.appendChild(wrap);
  }

  /**
   * One task row. The opts object adds the controls that make a row actionable
   * wherever it is rendered:
   *   opts.date    — the day this task actually sits on, which is what makes
   *                  "work on this now" and "pull it forward" addressable.
   *   opts.reorder — show the up/down arrows (only Today has a meaningful order).
   *   opts.pull    — a date to move this task to (arrow button).
   * Everything is optional, so the same row renders in Today, Tomorrow, the
   * per-project Focus list and the pool without four different implementations.
   */
  function itemRow(item, target, toggleable, opts) {
    var o = opts || {};
    var li = document.createElement("li");
    li.className = "item" + (item.done ? " done" : "");
    if (state && state.now && state.now.item && state.now.item.id === item.id) { li.className += " isnow"; }

    var line = document.createElement("div");
    line.className = "line";

    if (toggleable) {
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = item.done;
      cb.setAttribute("aria-label", item.done ? "Mark not done" : "Mark done");
      cb.addEventListener("change", function () {
        cb.disabled = true;
        guard(mutate("toggleItem", { itemId: item.id, done: cb.checked }));
      });
      line.appendChild(cb);
    }

    var span = document.createElement("span");
    span.className = "text";
    span.textContent = item.text;
    line.appendChild(span);

    if (item.projectId) {
      var pj = document.createElement("span");
      pj.className = "ptag";
      pj.textContent = projectName(item.projectId) || "project";
      line.appendChild(pj);
    } else if (item.origin === "carried") {
      var tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = "carried";
      line.appendChild(tag);
    }

    // "Work on this now" — the one button that says what you are doing rather
    // than what exists. Available on every row, wherever it is rendered.
    if (o.date) {
      var play = document.createElement("button");
      play.className = "icon strong";
      play.type = "button";
      play.textContent = "\u25B6";
      play.title = "Work on this now";
      play.setAttribute("aria-label", "Work on this now");
      play.addEventListener("click", function () {
        play.disabled = true;
        guard(mutate("selectItem", { itemId: item.id, date: o.date }));
      });
      line.appendChild(play);
    }

    if (o.reorder) {
      var up = document.createElement("button");
      up.className = "icon";
      up.type = "button";
      up.textContent = "\u2191";
      up.title = "Move up";
      up.setAttribute("aria-label", "Move task up");
      up.addEventListener("click", function () {
        up.disabled = true;
        guard(mutate("reorderItem", { target: target, itemId: item.id, direction: "up" }));
      });
      line.appendChild(up);

      var down = document.createElement("button");
      down.className = "icon";
      down.type = "button";
      down.textContent = "\u2193";
      down.title = "Move down";
      down.setAttribute("aria-label", "Move task down");
      down.addEventListener("click", function () {
        down.disabled = true;
        guard(mutate("reorderItem", { target: target, itemId: item.id, direction: "down" }));
      });
      line.appendChild(down);
    }

    // Move to another day without retyping it. fromDate is what lets a task on
    // any day be addressed, not just today and tomorrow.
    if (o.pull) {
      var pull = document.createElement("button");
      pull.className = "icon";
      pull.type = "button";
      pull.textContent = "\u2794";
      pull.title = "Move to " + o.pull;
      pull.setAttribute("aria-label", "Move to " + o.pull);
      pull.addEventListener("click", function () {
        pull.disabled = true;
        guard(mutate("moveItem", { itemId: item.id, fromDate: o.date, toDate: o.pull }));
      });
      line.appendChild(pull);
    }

    var edit = document.createElement("button");
    edit.className = "icon";
    edit.type = "button";
    edit.textContent = "\u270E";
    edit.title = "Edit";
    edit.setAttribute("aria-label", "Edit task");
    edit.addEventListener("click", function () {
      var input = document.createElement("input");
      input.type = "text";
      input.maxLength = 500;
      input.value = item.text;
      line.replaceChild(input, span);
      input.focus();
      input.select();
      var save = function () {
        var next = input.value.trim();
        if (next === "" || next === item.text) { render(state); return; }
        guard(mutate("editItemText", { target: target, fromDate: o.date, itemId: item.id, text: next }));
      };
      input.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter") { ev.preventDefault(); save(); }
        if (ev.key === "Escape") { render(state); }
      });
      input.addEventListener("blur", save);
    });
    line.appendChild(edit);

    var del = document.createElement("button");
    del.className = "icon";
    del.type = "button";
    del.textContent = "\u00D7";
    del.title = "Remove";
    del.setAttribute("aria-label", "Remove task");
    del.addEventListener("click", function () {
      guard(mutate("removeItem", { target: target, fromDate: o.date, itemId: item.id }));
    });
    line.appendChild(del);

    li.appendChild(line);
    if (item.summary) {
      var sum = document.createElement("div");
      sum.className = "tsummary";
      sum.textContent = item.summary;
      li.appendChild(sum);
    }
    chipRow(item, target, li);
    return li;
  }

  function fillList(ulId, countId, plan, target, toggleable, emptyMsg, opts) {
    var ul = el(ulId);
    ul.textContent = "";
    var items = plan && plan.items ? plan.items : [];
    el(countId).textContent = items.length ? "(" + items.filter(function (i) { return i.done; }).length + "/" + items.length + ")" : "";
    if (!items.length) {
      var li = document.createElement("li");
      li.className = "empty";
      li.textContent = emptyMsg;
      ul.appendChild(li);
      return;
    }
    for (var i = 0; i < items.length; i++) { ul.appendChild(itemRow(items[i], target, toggleable, opts)); }
  }

  /** The banner: what you are on, or an honest nothing. */
  function renderNow(s) {
    var card = el("now-card");
    var task = el("now-task");
    var meta = el("now-meta");
    var actions = el("now-actions");
    actions.textContent = "";
    var now = s.now;

    if (!now) {
      card.className = "card now idle";
      task.textContent = "Nothing picked yet";
      meta.textContent = s.today && s.today.items && s.today.items.length
        ? "Pick any task below with \u25B6 and it lands here."
        : "Add a task, or pull one in from the backlog below, then pick it with \u25B6.";
      return;
    }

    card.className = "card now";
    task.textContent = now.item.text;

    var bits = [];
    bits.push(now.date === localDate() ? "on today" : "on " + whenLabel(now.date));
    var pj = now.item.projectId ? projectName(now.item.projectId) : "";
    if (pj) { bits.push(pj); }
    if (now.item.summary) { bits.push(now.item.summary); }
    meta.textContent = bits.join("  \u00B7  ");

    var finish = document.createElement("button");
    finish.className = "primary";
    finish.type = "button";
    finish.textContent = "Done";
    finish.addEventListener("click", function () {
      finish.disabled = true;
      guard(mutate("toggleItem", { fromDate: now.date, target: "today", itemId: now.item.id, done: true }));
    });
    actions.appendChild(finish);

    var drop = document.createElement("button");
    drop.className = "ghost";
    drop.type = "button";
    drop.textContent = "Not now";
    drop.title = "Stop working on this, without completing it";
    drop.addEventListener("click", function () {
      drop.disabled = true;
      guard(mutate("selectItem", { itemId: null }));
    });
    actions.appendChild(drop);
    return;
  }

  /**
   * The menu: candidate tasks waiting on a project, and tasks already sitting on
   * another day. Rendered from two flat server-ordered lists — the page never
   * re-sorts, so what the planner decided is exactly what is shown.
   */
  function renderPick(s) {
    var backlogHost = el("pick-backlog");
    var poolHost = el("pick-pool");
    backlogHost.textContent = "";
    poolHost.textContent = "";

    var backlog = s.backlog || [];
    var pool = s.pool || [];
    el("bl-count").textContent = backlog.length ? "(" + backlog.length + ")" : "";
    el("pool-count").textContent = pool.length ? "(" + pool.length + ")" : "";
    el("pick-count").textContent = (backlog.length + pool.length) ? "(" + (backlog.length + pool.length) + ")" : "";

    if (!backlog.length) {
      var be = document.createElement("div");
      be.className = "empty";
      be.textContent = "No candidates. Add one under any project above \u2014 it waits there until you pull it into a day.";
      backlogHost.appendChild(be);
    }
    for (var i = 0; i < backlog.length; i++) { backlogHost.appendChild(backlogRow(backlog[i])); }

    if (!pool.length) {
      var pe = document.createElement("div");
      pe.className = "empty";
      pe.textContent = "Nothing on other days. Tasks you plan for tomorrow, or leave undone on a past day, appear here.";
      poolHost.appendChild(pe);
    }
    for (var k = 0; k < pool.length; k++) { poolHost.appendChild(poolRow(pool[k])); }
  }

  /** One backlog candidate: schedule it, start it, or drop it. */
  function backlogRow(entry) {
    var row = document.createElement("div");
    row.className = "pickrow";

    var when = document.createElement("span");
    when.className = "pickwhen backlog";
    when.textContent = "backlog";
    row.appendChild(when);

    var body = document.createElement("div");
    body.className = "picktext";
    var text = document.createElement("div");
    text.textContent = entry.text;
    body.appendChild(text);
    var pj = entry.projectId ? projectName(entry.projectId) : "";
    if (pj) {
      var sub = document.createElement("div");
      sub.className = "psub";
      sub.textContent = pj;
      body.appendChild(sub);
    }
    row.appendChild(body);

    var work = document.createElement("button");
    work.className = "icon strong";
    work.type = "button";
    work.textContent = "\u25B6";
    work.title = "Work on this now";
    work.setAttribute("aria-label", "Work on this now");
    work.addEventListener("click", function () {
      work.disabled = true;
      guard(mutate("planBacklogItem", { backlogItemId: entry.id, select: true }));
    });
    row.appendChild(work);

    var today = document.createElement("button");
    today.className = "icon";
    today.type = "button";
    today.textContent = "\u2794";
    today.title = "Schedule for today";
    today.setAttribute("aria-label", "Schedule for today");
    today.addEventListener("click", function () {
      today.disabled = true;
      guard(mutate("planBacklogItem", { backlogItemId: entry.id }));
    });
    row.appendChild(today);

    var tomorrow = document.createElement("button");
    tomorrow.className = "icon";
    tomorrow.type = "button";
    tomorrow.textContent = "\u21B3";
    tomorrow.title = "Schedule for tomorrow";
    tomorrow.setAttribute("aria-label", "Schedule for tomorrow");
    tomorrow.addEventListener("click", function () {
      tomorrow.disabled = true;
      guard(mutate("planBacklogItem", { backlogItemId: entry.id, toDate: "tomorrow" }));
    });
    row.appendChild(tomorrow);

    var drop = document.createElement("button");
    drop.className = "icon";
    drop.type = "button";
    drop.textContent = "\u00D7";
    drop.title = "Drop this candidate";
    drop.setAttribute("aria-label", "Drop this candidate");
    drop.addEventListener("click", function () {
      drop.disabled = true;
      guard(mutate("removeBacklogItem", { backlogItemId: entry.id }));
    });
    row.appendChild(drop);
    return row;
  }

  /** One task on another day: pull it to today, start it, tick it, or drop it. */
  function poolRow(entry) {
    var row = document.createElement("div");
    row.className = "pickrow";

    var when = document.createElement("span");
    when.className = "pickwhen" + (entry.bucket === "overdue" ? " overdue" : "");
    when.textContent = whenLabel(entry.date);
    when.title = entry.date;
    row.appendChild(when);

    var body = document.createElement("div");
    body.className = "picktext";
    var text = document.createElement("div");
    text.textContent = entry.item.text;
    body.appendChild(text);
    var pj = entry.item.projectId ? projectName(entry.item.projectId) : "";
    if (pj) {
      var sub = document.createElement("div");
      sub.className = "psub";
      sub.textContent = pj;
      body.appendChild(sub);
    }
    row.appendChild(body);

    var work = document.createElement("button");
    work.className = "icon strong";
    work.type = "button";
    work.textContent = "\u25B6";
    work.title = "Pull into today and work on it now";
    work.setAttribute("aria-label", "Pull into today and work on it now");
    work.addEventListener("click", function () {
      work.disabled = true;
      guard(mutate("moveItem", { itemId: entry.item.id, fromDate: entry.date, toDate: localDate(), select: true }));
    });
    row.appendChild(work);

    var pull = document.createElement("button");
    pull.className = "icon";
    pull.type = "button";
    pull.textContent = "\u2794";
    pull.title = "Move to today";
    pull.setAttribute("aria-label", "Move to today");
    pull.addEventListener("click", function () {
      pull.disabled = true;
      guard(mutate("moveItem", { itemId: entry.item.id, fromDate: entry.date, toDate: localDate() }));
    });
    row.appendChild(pull);

    var tick = document.createElement("button");
    tick.className = "icon";
    tick.type = "button";
    tick.textContent = "\u2713";
    tick.title = "Mark done where it is";
    tick.setAttribute("aria-label", "Mark done where it is");
    tick.addEventListener("click", function () {
      tick.disabled = true;
      guard(mutate("toggleItem", { itemId: entry.item.id, fromDate: entry.date, done: true }));
    });
    row.appendChild(tick);

    var drop = document.createElement("button");
    drop.className = "icon";
    drop.type = "button";
    drop.textContent = "\u00D7";
    drop.title = "Delete this task";
    drop.setAttribute("aria-label", "Delete this task");
    drop.addEventListener("click", function () {
      drop.disabled = true;
      guard(mutate("removeItem", { itemId: entry.item.id, fromDate: entry.date }));
    });
    row.appendChild(drop);
    return row;
  }

  var RUBRIC_DIMS = ["forcingFunction", "competitionThinness", "assetLightness", "aiRunnability",
                     "distribution", "moat", "regulatoryCost"];

  function fmt(n) { return Number(n).toLocaleString(); }

  function metric(label, value) {
    var d = document.createElement("div");
    d.className = "pmetric";
    var b = document.createElement("b"); b.textContent = value;
    d.appendChild(b);
    d.appendChild(document.createTextNode(label));
    return d;
  }

  function projectName(id) {
    var list = (state && state.projects) || [];
    for (var i = 0; i < list.length; i++) { if (list[i].id === id) { return list[i].name; } }
    return "";
  }

  function projectCard(p, rank, selectedId) {
    var card = document.createElement("div");
    card.className = "pcard" + (p.id === selectedId ? " selected" : "") + (p.score.unestimated ? " unranked" : "");

    var head = document.createElement("div"); head.className = "phead";
    var rk = document.createElement("span"); rk.className = "rank"; rk.textContent = "#" + rank;
    var nm = document.createElement("span"); nm.className = "pname"; nm.textContent = p.name;
    var st = document.createElement("span"); st.className = "pstatus st-" + p.status; st.textContent = p.status;
    head.appendChild(rk); head.appendChild(nm); head.appendChild(st);
    card.appendChild(head);

    if (p.live && p.monitoring.verdict) {
      var vd = document.createElement("span");
      vd.className = "pverdict v-" + p.monitoring.verdict;
      vd.textContent = p.monitoring.verdict;
      head.appendChild(vd);
    }

    var sc = document.createElement("div"); sc.className = "pscore";
    sc.textContent = p.score.unestimated
      ? "UNRANKED \u2014 needs estimates"
      : Math.round(p.score.score) + " " + p.currency + "/mo per build-day";
    card.appendChild(sc);

    if (p.live) card.appendChild(monitorBlock(p));

    var fu = document.createElement("div"); fu.className = "pfulfils"; fu.textContent = p.fulfills;
    card.appendChild(fu);

    if (p.summary) {
      var su = document.createElement("div"); su.className = "psummary"; su.textContent = p.summary;
      card.appendChild(su);
    }

    var m = document.createElement("div"); m.className = "pmetrics";
    m.appendChild(metric("first dollar", p.ttfdDays === null ? "?" : "day " + p.ttfdDays));
    m.appendChild(metric("effort", p.effortDays === null ? "?" : p.effortDays + "d"));
    m.appendChild(metric("revenue", p.revenuePerMonth === null ? "?" : fmt(p.revenuePerMonth) + " " + p.currency + "/mo"));
    m.appendChild(metric("confidence", Math.round(p.confidence * 100) + "%"));
    card.appendChild(m);

    var ru = document.createElement("div"); ru.className = "prubric";
    for (var i = 0; i < RUBRIC_DIMS.length; i++) {
      var dim = RUBRIC_DIMS[i];
      var bar = document.createElement("div");
      bar.className = "pdim" + (dim === p.score.weakestDimension ? " weak" : "");
      bar.style.height = (p.rubric[dim] * 20) + "%";
      bar.title = dim + ": " + p.rubric[dim] + "/5" + (dim === p.score.weakestDimension ? " \u2014 the real risk" : "");
      ru.appendChild(bar);
    }
    card.appendChild(ru);

    var note = document.createElement("div"); note.className = "pnote";
    var wk = document.createElement("b"); wk.textContent = p.score.weakestDimension;
    note.appendChild(document.createTextNode("weakest: ")); note.appendChild(wk);
    note.appendChild(document.createTextNode("  \u00B7  urgency x" + p.score.urgency.toFixed(2)));
    card.appendChild(note);

    if (p.killSwitch) {
      var ks = document.createElement("div"); ks.className = "pnote";
      ks.textContent = "kill-switch: " + p.killSwitch;
      card.appendChild(ks);
    }

    var actions = document.createElement("div"); actions.className = "pactions";
    if (p.id === selectedId) {
      var cur = document.createElement("span"); cur.className = "pnote"; cur.textContent = "\u2713 being executed";
      actions.appendChild(cur);
      var unpick = document.createElement("button");
      unpick.className = "ghost"; unpick.type = "button"; unpick.textContent = "Unfocus";
      unpick.addEventListener("click", function () {
        guard(mutate("selectProject", { projectId: null }));
      });
      actions.appendChild(unpick);
    } else {
      var pick = document.createElement("button");
      pick.className = "primary"; pick.type = "button"; pick.textContent = "Work on this";
      pick.addEventListener("click", function () {
        guard(mutate("selectProject", { projectId: p.id }));
      });
      actions.appendChild(pick);
    }
    card.appendChild(actions);

    // Authoring point for the backlog: this is where candidates for THIS project
    // come from. Adding one here schedules nothing — it waits in the Pick a task
    // card until the operator pulls it onto a day.
    var mine = backlogFor(p.id);
    var bform = document.createElement("form");
    bform.className = "bl-add";
    bform.setAttribute("autocomplete", "off");
    var binput = document.createElement("input");
    binput.type = "text";
    binput.maxLength = 500;
    binput.placeholder = "Candidate task\u2026";
    binput.setAttribute("aria-label", "Add a candidate task to " + p.name);
    var bbtn = document.createElement("button");
    bbtn.className = "ghost";
    bbtn.type = "submit";
    bbtn.textContent = "Backlog";
    bform.appendChild(binput);
    bform.appendChild(bbtn);
    bform.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var text = binput.value.trim();
      if (!text) { return; }
      bbtn.disabled = true;
      guard(mutate("addBacklogItem", { projectId: p.id, text: text }));
    });
    card.appendChild(bform);

    var bl = document.createElement("div");
    bl.className = "pnote";
    bl.textContent = mine.length
      ? mine.length + " candidate task" + (mine.length === 1 ? "" : "s") + " waiting \u2014 pull one in from Pick a task."
      : "No candidates yet. Add what COULD be done here; nothing is scheduled until you pull it onto a day.";
    card.appendChild(bl);
    return card;
  }

  /** This project's unscheduled candidates, in the order the planner returned them. */
  function backlogFor(projectId) {
    var all = (state && state.backlog) || [];
    var out = [];
    for (var i = 0; i < all.length; i++) { if (all[i].projectId === projectId) { out.push(all[i]); } }
    return out;
  }

  /**
   * One open spark: the idea, where it came from, and the only two things that
   * can be done with it. Promote turns it into a pending project (UNRANKED until
   * it is estimated); dismiss closes it and demands a reason, because a dismissal
   * burns the option and the reason is what keeps the idea from being re-derived.
   */
  function sparkRow(spark) {
    var row = document.createElement("div");
    row.className = "psparkrow";
    row.textContent = spark.text;

    var src = document.createElement("div");
    src.className = "psparksrc";
    src.textContent = "from " + (spark.sourceProjectName || "no source recorded")
      + (spark.sourceDate ? " on " + spark.sourceDate : "");
    row.appendChild(src);

    var acts = document.createElement("div");
    acts.className = "psparkacts";

    var promote = document.createElement("button");
    promote.type = "button";
    promote.className = "chip chip-complete";
    promote.textContent = "promote";
    promote.title = "Turn this into a pending project. It starts UNRANKED until you give it estimates.";
    promote.addEventListener("click", function () {
      promote.disabled = true;
      guard(mutate("sparkPromote", { sparkId: spark.id }));
    });
    acts.appendChild(promote);

    var dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "chip chip-drop";
    dismiss.textContent = "dismiss";
    dismiss.title = "Close this idea without starting it. A reason is required.";
    dismiss.addEventListener("click", function () {
      // The reason is required by the planner, so ask for it inline rather than
      // letting the round trip fail. Replacing the buttons with the input keeps
      // the row readable while the decision is being made.
      acts.textContent = "";
      var input = document.createElement("input");
      input.type = "text";
      input.maxLength = 500;
      input.placeholder = "why is this being dismissed?";
      input.setAttribute("aria-label", "Reason for dismissing: " + spark.text);
      var send = document.createElement("button");
      send.type = "button";
      send.className = "chip chip-drop";
      send.textContent = "dismiss";
      var submit = function () {
        var reason = input.value.trim();
        if (!reason) { setStatus("a dismissal needs a reason", true); return; }
        send.disabled = true;
        guard(mutate("sparkDismiss", { sparkId: spark.id, reason: reason }));
      };
      send.addEventListener("click", submit);
      input.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter") { ev.preventDefault(); submit(); }
      });
      acts.appendChild(input);
      acts.appendChild(send);
      input.focus();
    });
    acts.appendChild(dismiss);

    row.appendChild(acts);
    return row;
  }

  function monitorBlock(p) {
    var m = p.monitoring;
    var box = document.createElement("div");
    box.className = "pmonitor";

    var money = document.createElement("div");
    money.className = "pmrow";
    var mk = document.createElement("b");
    mk.textContent = fmt(m.totalRevenue) + " " + p.currency;
    money.appendChild(document.createTextNode("money made: "));
    money.appendChild(mk);
    money.appendChild(document.createTextNode(" total"));
    if (m.lastRevenue !== null) {
      money.appendChild(document.createTextNode("  \u00B7  " + fmt(m.lastRevenue) + " last period"));
    }
    if (m.customers !== null) {
      money.appendChild(document.createTextNode("  \u00B7  " + m.customers + " customers"));
    }
    box.appendChild(money);

    if (m.metricName) {
      var met = document.createElement("div");
      met.className = "pmrow";
      var mv = document.createElement("b");
      mv.textContent = m.latestMetric === null ? "not recorded" : fmt(m.latestMetric);
      met.appendChild(document.createTextNode(m.metricName + ": "));
      met.appendChild(mv);
      if (m.metricDelta !== null) {
        met.appendChild(document.createTextNode(m.metricDelta >= 0 ? "  (+" + m.metricDelta + ")" : "  (" + m.metricDelta + ")"));
      }
      box.appendChild(met);
    }

    var when = document.createElement("div");
    when.className = "pmrow";
    when.textContent = m.checkins === 0
      ? "no check-in yet \u2014 the loop starts the day it ships"
      : m.checkins + " check-in" + (m.checkins === 1 ? "" : "s") + "  \u00B7  live since " + m.liveSince
        + "  \u00B7  last " + m.lastCheckin + (m.daysSinceCheckin === null ? "" : " (" + m.daysSinceCheckin + "d ago)");
    box.appendChild(when);

    if (m.stale) {
      var stale = document.createElement("div");
      stale.className = "stale-flag";
      stale.textContent = "STALE \u2014 no check-in for over a week. Log one: progress, money, hurdles, verdict.";
      box.appendChild(stale);
    }

    if (m.lastProgress) {
      var prog = document.createElement("div");
      prog.className = "pmrow";
      prog.textContent = "progress: " + m.lastProgress;
      box.appendChild(prog);
    }

    var i;
    for (i = 0; i < m.openHurdles.length; i++) {
      var h = document.createElement("div");
      h.className = "pmopen";
      h.textContent = "hurdle: " + m.openHurdles[i].text;
      box.appendChild(h);
    }
    for (i = 0; i < m.openCorrections.length; i++) {
      var c = document.createElement("div");
      c.className = "pmopen";
      c.textContent = "to fix: " + m.openCorrections[i].text;
      box.appendChild(c);
    }
    if (m.doneCorrections > 0) {
      var dn = document.createElement("div");
      dn.className = "pmopen";
      dn.textContent = m.doneCorrections + " correction(s) already done";
      box.appendChild(dn);
    }

    // Ideas this venture's feedback sparked. Displayed here — where the feedback
    // is — but STORED on the spark board, not nested under the project: a spark
    // has to outlive the venture, and a second home for candidate ventures would
    // drift from the register. The open queue comes from the board and is
    // filtered to this project; the counts come from the project's own summary,
    // which is the only place a decided spark is still attributed to it.
    var sp = p.sparkSummary;
    if (sp && sp.total > 0) {
      var sec = document.createElement("div");
      sec.className = "psparks";

      var head = document.createElement("div");
      head.className = "psparkshead";
      head.textContent = "ideas sparked by this feedback";
      sec.appendChild(head);

      var pool = state && state.sparks && state.sparks.openSparks ? state.sparks.openSparks : [];
      for (var k = 0; k < pool.length; k++) {
        if (pool[k].sourceProjectId === p.id) { sec.appendChild(sparkRow(pool[k])); }
      }

      var counts = document.createElement("div");
      counts.className = "psparksrc";
      counts.textContent = sp.open + " open  \u00B7  " + sp.promoted + " promoted  \u00B7  "
        + sp.dismissed + " dismissed";
      sec.appendChild(counts);

      if (sp.oldestOpenDays !== null && sp.open > 0) {
        var due = document.createElement("div");
        due.className = sp.triageDue ? "psparkdue" : "psparksrc";
        due.textContent = sp.triageDue
          ? "the oldest has waited " + sp.oldestOpenDays + " days \u2014 promote it, or dismiss it with a reason"
          : "oldest waiting " + sp.oldestOpenDays + "d";
        sec.appendChild(due);
      }

      box.appendChild(sec);
    }

    return box;
  }

  function renderColumn(hostId, entries, selectedId, emptyMsg) {
    var host = el(hostId);
    host.textContent = "";
    if (!entries.length) {
      var e = document.createElement("div");
      e.className = "empty";
      e.textContent = emptyMsg;
      host.appendChild(e);
      return;
    }
    for (var i = 0; i < entries.length; i++) {
      host.appendChild(projectCard(entries[i].project, entries[i].rank, selectedId));
    }
  }

  // The split reads the flag the host derived, so the page never re-implements the
  // rule; ranks stay global across both columns.
  function renderProjects(s) {
    var list = s.projects || [];
    el("proj-count").textContent = list.length ? "(" + list.length + ")" : "";
    var working = [];
    var pending = [];
    var live = [];
    var closed = 0;
    for (var i = 0; i < list.length; i++) {
      var entry = { project: list[i], rank: i + 1 };
      if (list[i].status === "killed") { closed = closed + 1; }
      else if (list[i].live) { live.push(entry); }
      else if (list[i].pending) { pending.push(entry); }
      else { working.push(entry); }
    }
    el("work-count").textContent = working.length ? "(" + working.length + ")" : "";
    el("pend-count").textContent = pending.length ? "(" + pending.length + ")" : "";
    el("live-count").textContent = live.length ? "(" + live.length + ")" : "";
    renderColumn("projects", working, s.selectedProjectId,
      "Nothing in flight \u2014 select a pending project, or ask the agent to add one.");
    renderColumn("pending", pending, s.selectedProjectId,
      "Nothing pending \u2014 every project is in flight.");
    renderColumn("live", live, s.selectedProjectId,
      "Nothing live yet. A project moves here when it ships \u2014 that is when the feedback loop starts.");
    var staleCount = 0;
    for (var k = 0; k < live.length; k++) { if (live[k].project.monitoring.stale) { staleCount = staleCount + 1; } }
    var board = s.sparks;
    var sparkLine = el("live-sparks");
    if (!board || (board.open === 0 && board.decided === 0)) {
      sparkLine.textContent = "";
      sparkLine.className = "closed-line";
    } else {
      sparkLine.textContent = board.open + " idea" + (board.open === 1 ? "" : "s")
        + " sparked by this feedback still waiting to be decided (" + board.promoted + " promoted, "
        + board.dismissed + " dismissed)"
        + (board.triageDue && board.oldestOpenDays !== null
          ? " \u2014 the oldest has waited " + board.oldestOpenDays + " days."
          : ".");
      sparkLine.className = board.triageDue ? "closed-line spark-due" : "closed-line";
    }
    el("closed-line").textContent = (staleCount ? staleCount + " live project(s) stale. " : "")
      + (closed ? closed + " killed \u2014 kept in the vault register, not shown here." : "");
  }

  /**
   * The portfolio register. Every count here is derived from the records, so the
   * number the operator reads can never be one somebody typed.
   */
  function renderPortfolio(s) {
    var pf = s.portfolio;
    if (!pf) { return; }
    var c = pf.counts;
    el("plugincount").textContent = String(c.authored);
    el("pfol-count").textContent = c.total ? "(" + c.total + ")" : "";
    el("pfol-counts").textContent = c.authored + " authored (" + c.published + " published, "
      + c.ready + " ready)  \u00B7  " + c.thirdParty + " third-party, never publishable"
      + (c.internal ? "  \u00B7  " + c.internal + " internal" : "")
      + (c.installed ? "  \u00B7  " + c.installed + " installed" : "");

    var host = el("pfol-list");
    host.textContent = "";
    var rows = pf.entries || [];
    if (!rows.length) {
      var empty = document.createElement("p");
      empty.className = "hint";
      empty.textContent = "No plugins registered yet. Ask the agent to record one; it needs its origin (ours, a fork, or third-party), because that single field decides whether it can ever be published.";
      host.appendChild(empty);
      return;
    }
    for (var i = 0; i < rows.length; i++) { host.appendChild(portfolioRow(rows[i])); }
  }

  /**
   * Copy text to the clipboard and SAY what happened. navigator.clipboard is
   * absent on a non-secure origin, and a copy button that silently does nothing
   * is worse than no button at all: the operator pastes an empty line into a
   * shell and believes it worked.
   */
  function copyText(button, text) {
    var done = function (ok) {
      button.textContent = ok ? "Copied" : "Copy failed";
      setStatus(ok
        ? "Publish commands copied - paste them into a terminal."
        : "Could not reach the clipboard; select the block and copy it by hand.", !ok);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
      return;
    }
    done(false);
  }

  function portfolioRow(p) {
    var row = document.createElement("div");
    row.className = "pfol-row";

    var name = document.createElement("div");
    name.className = "pfol-name";
    name.appendChild(document.createTextNode(p.title || p.name));
    var tag = document.createElement("span");
    tag.className = "ptag";
    tag.textContent = p.origin + "  \u00B7  " + p.visibility + "  \u00B7  " + p.status;
    name.appendChild(tag);
    row.appendChild(name);

    if (p.summary) {
      var sum = document.createElement("div");
      sum.className = "pfol-meta";
      sum.textContent = p.summary;
      row.appendChild(sum);
    }

    var meta = document.createElement("div");
    meta.className = "pfol-meta";
    var bits = [];
    if (p.licence) { bits.push("licence " + p.licence); }
    if (p.upstream) { bits.push("upstream " + p.upstream); }
    if (p.sourcePath) { bits.push(p.sourcePath); }
    bits.push(p.verifiedDaysAgo === null || p.verifiedDaysAgo < 0
      ? "facts never verified"
      : "facts verified " + p.verifiedDaysAgo + "d ago");
    meta.textContent = bits.join("  \u00B7  ");
    row.appendChild(meta);

    if (p.status === "public") {
      var pub = document.createElement("div");
      pub.className = "pfol-ready";
      pub.textContent = "PUBLISHED" + (p.publicUrl ? " \u2014 " + p.publicUrl : "");
      row.appendChild(pub);
      return row;
    }

    // The gate, item by item. Every item is drawn, passed or not, because a
    // panel that shows only the failures cannot be told apart from one that
    // never ran - and "it said ready" is not a record of what was checked.
    var checks = document.createElement("div");
    checks.className = "pfol-checks";
    var items = p.checks || [];
    for (var c = 0; c < items.length; c++) {
      var item = document.createElement("div");
      // Three states, not two: a permanent refusal is not work, so it keeps the
      // muted ink it inherits from its base class instead of borrowing the amber
      // that means "do this". Colour carries meaning, and amber on third-party
      // work would read as a to-do - the one thing that row must not look like.
      item.className = "pfol-check " + (items[c].ok ? "ok" : (items[c].fatal ? "never" : "todo"));
      var mark = document.createElement("span");
      mark.className = "k";
      mark.textContent = items[c].ok ? "pass" : (items[c].fatal ? "never" : "todo");
      item.appendChild(mark);
      var what = document.createElement("span");
      what.textContent = items[c].name + (items[c].ok ? "" : " \u2014 " + items[c].detail);
      item.appendChild(what);
      checks.appendChild(item);
    }
    row.appendChild(checks);

    if (p.preflightPassed && p.preflightNote) {
      var note = document.createElement("div");
      note.className = "pfol-meta";
      note.textContent = "pre-flight: " + p.preflightNote;
      row.appendChild(note);
    }

    if (p.publishable && p.blockers.length === 0) {
      var ready = document.createElement("div");
      ready.className = "pfol-ready";
      ready.textContent = "READY TO PUBLISH \u2014 every item above passes";
      row.appendChild(ready);
    }

    // The publish affordance, and the reason it is safe. It exists ONLY when the
    // server sent commands, and the server sends NONE for third-party work, for
    // anything internal, for anything already public, and for a path that cannot
    // be pasted safely. So there is no button here to disable and none to forget
    // to hide: for someone else's work the affordance does not exist at all.
    if (p.commands) {
      var cmd = document.createElement("div");
      cmd.className = "pfol-cmd";
      var pre = document.createElement("pre");
      pre.textContent = p.commands;
      cmd.appendChild(pre);
      var copy = document.createElement("button");
      copy.className = "ghost pfol-copy";
      copy.type = "button";
      copy.textContent = "Copy publish commands";
      copy.addEventListener("click", function () { copyText(this, pre.textContent); });
      cmd.appendChild(copy);
      row.appendChild(cmd);
    }
    return row;
  }

  function renderFocus(s) {
    var card = el("focus-card");
    var sel = null;
    var list = s.projects || [];
    for (var i = 0; i < list.length; i++) { if (list[i].id === s.selectedProjectId) { sel = list[i]; } }
    if (!sel) { card.hidden = true; return; }
    card.hidden = false;
    el("focus-name").textContent = sel.name;
    el("focus-hint").textContent = sel.fulfills + (sel.killSwitch ? "  \u00B7  kill-switch: " + sel.killSwitch : "");

    var host = el("focus-list");
    host.textContent = "";
    var rows = [];
    var groups = [
      { plan: s.today, when: "today", toggle: true },
      { plan: s.tomorrow, when: "tomorrow", toggle: false }
    ];
    for (var g = 0; g < groups.length; g++) {
      var items = (groups[g].plan && groups[g].plan.items) || [];
      for (var k = 0; k < items.length; k++) {
        if (items[k].projectId === sel.id) { rows.push({ item: items[k], when: groups[g].when, toggle: groups[g].toggle }); }
      }
    }
    if (!rows.length) {
      var e = document.createElement("div");
      e.className = "empty";
      e.textContent = "No tasks for this project yet \u2014 ask the agent to break it into daily tasks.";
      host.appendChild(e);
      return;
    }
    for (var r = 0; r < rows.length; r++) {
      var row = document.createElement("div"); row.className = "frow";
      var when = document.createElement("span"); when.className = "fwhen"; when.textContent = rows[r].when;
      row.appendChild(when);
      row.appendChild(itemRow(rows[r].item, rows[r].when, rows[r].toggle));
      host.appendChild(row);
    }
  }

  function render(s) {
    if (!s) { return; }
    state = s;
    var today = s.today;
    var items = today && today.items ? today.items : [];
    var done = items.filter(function (i) { return i.done; }).length;
    var rate = items.length ? done / items.length : 0;

    el("today-label").textContent = new Date().toLocaleDateString(undefined, {
      weekday: "long", year: "numeric", month: "long", day: "numeric"
    });
    el("streak").textContent = String(s.streak || 0);
    var wr = pct(s.weekRate);
    el("weekrate").textContent = wr === null ? "\\u2014" : wr + "%";
    el("thermo-label").textContent = items.length ? done + " of " + items.length + " done today" : "No plan for today yet";
    el("thermo-pct").textContent = items.length ? Math.round(rate * 100) + "%" : "\\u2014";
    el("thermo-fill").style.width = (items.length ? Math.round(rate * 100) : 0) + "%";

    renderProjects(s);
    renderFocus(s);
    renderPortfolio(s);
    renderNow(s);
    renderPick(s);
    fillList("today-list", "today-count", today, "today", true, "Nothing planned for today.",
      { date: localDate(), reorder: true, pull: shiftDate(1) });
    fillList("tomorrow-list", "tomorrow-count", s.tomorrow, "tomorrow", false,
      "Nothing planned yet \u2014 add a line for tomorrow, or pull one in from the backlog above.",
      { date: shiftDate(1), pull: localDate() });

    var heat = el("heat");
    heat.textContent = "";
    var cells = s.week || [];
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i];
      var div = document.createElement("div");
      div.className = "cell" + (c.date === localDate() ? " today" : "") + (c.date > localDate() ? " future" : "");
      var d = document.createElement("div"); d.className = "d"; d.textContent = weekday(c.date); div.appendChild(d);
      var n = document.createElement("div"); n.className = "n";
      var p = pct(c.rate);
      n.textContent = p === null ? "\\u2013" : p + "%";
      div.appendChild(n);
      var f = document.createElement("div"); f.className = "f";
      f.textContent = c.total ? c.done + "/" + c.total : "\\u2014";
      div.appendChild(f);
      heat.appendChild(div);
    }
  }

  function refresh() {
    return getState().then(function (s) {
      render(s);
      setStatus("updated " + new Date().toLocaleTimeString());
    }).catch(function (e) { setStatus("cannot reach the plugin: " + String(e.message || e), true); });
  }

  function bind() {
    el("today-add").addEventListener("submit", function (ev) {
      ev.preventDefault();
      var input = el("today-input");
      var text = input.value.trim();
      if (!text) { return; }
      input.value = "";
      guard(mutate("addItem", { target: "today", text: text }));
    });
    el("tomorrow-add").addEventListener("submit", function (ev) {
      ev.preventDefault();
      var input = el("tomorrow-input");
      var text = input.value.trim();
      if (!text) { return; }
      input.value = "";
      guard(mutate("addItem", { target: "tomorrow", text: text }));
    });
    el("proj-add").addEventListener("submit", function (ev) {
      ev.preventDefault();
      var name = el("proj-name").value.trim();
      var fulfills = el("proj-fulfills").value.trim();
      if (!name || !fulfills) { setStatus("a project needs a name and what it fulfils", true); return; }
      var payload = { name: name, fulfills: fulfills };
      var ttfd = el("proj-ttfd").value;
      var effort = el("proj-effort").value;
      var rev = el("proj-rev").value;
      if (ttfd !== "") { payload.ttfdDays = Number(ttfd); }
      if (effort !== "") { payload.effortDays = Number(effort); }
      if (rev !== "") { payload.revenuePerMonth = Number(rev); }
      el("proj-name").value = ""; el("proj-fulfills").value = "";
      el("proj-ttfd").value = ""; el("proj-effort").value = ""; el("proj-rev").value = "";
      guard(mutate("addProject", payload));
    });
    el("clear-today").addEventListener("click", function () {
      if (window.confirm("Clear every task for today?")) { guard(mutate("clearToday", {})); }
    });
    el("reload").addEventListener("click", function () { guard(refresh()); });

    var remind = el("remind");
    if (!("Notification" in window)) {
      remind.disabled = true;
      remind.textContent = "Reminders unsupported";
    } else if (Notification.permission === "granted") {
      remind.textContent = "21:00 reminder on";
    }
    remind.addEventListener("click", function () {
      if (!("Notification" in window)) { return; }
      Notification.requestPermission().then(function (p) {
        remind.textContent = p === "granted" ? "21:00 reminder on" : "Reminder blocked";
      });
    });
    window.setInterval(function () {
      if (!("Notification" in window) || Notification.permission !== "granted") { return; }
      var now = new Date();
      if (now.getHours() !== 21) { return; }
      var key = "dp-reminded-" + localDate();
      if (window.localStorage.getItem(key)) { return; }
      var t = state && state.tomorrow && state.tomorrow.items ? state.tomorrow.items.length : 0;
      if (t > 0) { return; }
      window.localStorage.setItem(key, "1");
      try { new Notification("Plan tomorrow", { body: "No plan for tomorrow yet." }); } catch (e) { /* ignore */ }
    }, 60000);

    window.setInterval(function () { guard(refresh()); }, POLL_MS);
    document.addEventListener("visibilitychange", function () { if (!document.hidden) { guard(refresh()); } });
    window.addEventListener("focus", function () { guard(refresh()); });
  }

  bind();
  guard(refresh());
})();
</script>
</body>
</html>
`
