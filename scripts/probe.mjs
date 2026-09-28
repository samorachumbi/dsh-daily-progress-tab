/**
 * Live-runtime probe for dsh-daily-progress-tab.
 *
 * Unlike a hand-written fake ctx, this probe mounts the plugin on a REAL
 * @deepseek-ai/cordis Context with REAL service names, so a wrong name in
 * `inject` fails the probe instead of silently passing. It then drives the
 * compiled handler end-to-end against the real json storage backend.
 *
 * Sections marked [regression] cover defects inherited from upstream and fixed
 * in this fork; each one failed before the fix.
 *
 * Run: node scripts/probe.mjs
 */

import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

const { Context } = await import('@deepseek-ai/cordis')
const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json')
const { DomainFacility } = await import('@deepseek-ai/dsh-storage-domain')
const Plugin = await import('../lib/index.js')
const { dailyProgressDomain } = await import('../lib/domain.js')

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label)
  if (!ok) {
    console.log('   expected: ' + JSON.stringify(expected))
    console.log('   actual:   ' + JSON.stringify(actual))
  }
}

const TZ = 'Africa/Nairobi'
const DATE = '2026-08-13'

// The publish values are CONFIG now, so the harness supplies a fixture. It is
// deliberately not an account anybody owns: a value that could equally have come
// from a built-in default would prove nothing, and the point of these probes is
// that the configured value is what reaches the register.
const PROBE_OWNER = 'probe-owner-7'
const PROBE_SCAN = '~/bin/probe-scan.sh'

// ---------------------------------------------------------------- static contract
// The plugin's inject names must exist in the harness packages we depend on.
const wsTypes = readFileSync('node_modules/@deepseek-ai/dsh-host-webserver/lib/types/index.d.ts', 'utf8')
const sdTypes = readFileSync('node_modules/@deepseek-ai/dsh-storage-domain/lib/types/index.d.ts', 'utf8')
check('inject lists exactly the real services', Plugin.inject, ['storageDomain', 'webServer'])
check('harness declares webServer on Context', /webServer:\s*WebServer/.test(wsTypes), true)
check('harness declares storageDomain on Context', /storageDomain:\s*DomainFacility/.test(sdTypes), true)
check('no client bundle is shipped', existsSync(new URL('../lib/client.js', import.meta.url)), false)
check('package.json declares no client half',
  Object.hasOwn(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).dsh, 'client'), false)

// The config SCHEMA, exercised in process. A field the schema rejects fails at
// BOOT, where assertEntriesActivated takes the whole harness down with it — so
// the schema is proved here, where a mistake costs a line of output instead.
check('the publish fields default to EMPTY, never to somebody else\'s account',
  [Plugin.Config({}).publishOwner, Plugin.Config({}).leakScan], ['', ''])
check('a non-string publish field is REFUSED by the schema rather than coerced',
  (() => { try { Plugin.Config({ publishOwner: 42 }); return 'accepted' } catch { return 'refused' } })(),
  'refused')
check('and null is read as unset, which is the safe direction',
  Plugin.Config({ publishOwner: null, leakScan: null }).publishOwner, '')

// ---------------------------------------------------------------- boot the real ctx
const root = mkdtempSync(join(tmpdir(), 'dpt-probe-'))
const changes = []
const facility = new DomainFacility({
  storage: { backend: { get: (name) => (name === 'json' ? new JsonStorageBackend(root) : undefined) } },
  emit: (event, payload) => { if (event === 'domain/changed') changes.push(payload) },
  logger: { warn: () => {} },
}, { backend: 'json' })

// A domain may be opened only once per process, so the probe cannot open its own:
// it records the instance the plugin opens, which is how the orphan check below can
// read a raw table (orphans are invisible in the snapshot by construction).
let openDomain = null
const realOpen = facility.open.bind(facility)
facility.open = async (spec) => {
  const opened = await realOpen(spec)
  openDomain = opened
  return opened
}

let route = null
const ctx = new Context()
ctx.provide('storageDomain', facility)
ctx.provide('webServer', {
  register: (r) => { route = r; return () => { route = null } },
})

let activated = false
ctx.plugin({
  name: Plugin.name,
  inject: Plugin.inject,
  // Configured, so the HTTP-driven register probes exercise the configured
  // path; the NO-config path is proved separately below.
  apply: (c) => {
    activated = true
    return Plugin.apply(c, { timezone: TZ, publishOwner: PROBE_OWNER, leakScan: PROBE_SCAN })
  },
})
await new Promise((r) => setTimeout(r, 400))

check('plugin ACTIVATED on real cordis (inject resolved)', activated, true)
check('plugin registered a route', route !== null, true)
check('route prefix is fork-specific', route && route.path, '/daily-progress-tab')

// ---------------------------------------------------------------- request driver
function call(method, path, body, host = '127.0.0.1:3080') {
  return new Promise((resolve, reject) => {
    let status = 0
    let payload = ''
    const req = {
      method,
      url: path,
      headers: { host },
      [Symbol.asyncIterator]: async function* () {
        if (body !== undefined) yield Buffer.from(JSON.stringify(body))
      },
    }
    const res = {
      writeHead: (code) => { status = code },
      end: (chunk) => {
        payload = typeof chunk === 'string' ? chunk : (chunk ?? '').toString()
        let parsed = null
        try { parsed = JSON.parse(payload) } catch { /* html */ }
        resolve({ status, parsed, raw: payload })
      },
    }
    void Promise.resolve(route.handler(req, res)).catch(reject)
  })
}
const get = (p, host) => call('GET', p, undefined, host)
const post = (body) => call('POST', '/daily-progress-tab/mutate', body)

// ---------------------------------------------------------------- the planner page
let r = await get('/daily-progress-tab/ui')
check('GET /ui serves html 200', { s: r.status, html: r.raw.startsWith('<!doctype html>') }, { s: 200, html: true })
check('page is self-contained (no external script/style)',
  /<script[^>]+src=|<link[^>]+stylesheet/.test(r.raw), false)
check('page posts to the fork prefix', r.raw.includes('"/daily-progress-tab"'), true)
check('bare prefix also serves the page', (await get('/daily-progress-tab')).status, 200)
check('trailing slash tolerated', (await get('/daily-progress-tab/ui/')).status, 200)
check('page declares the Live column',
  { host: r.raw.includes('id="live"'), head: r.raw.includes('>Live <'), hint: r.raw.includes('an unmeasured project cannot be judged') },
  { host: true, head: true, hint: true })
check('page declares the Pending column',
  { host: r.raw.includes('id="pending"'), head: r.raw.includes('>Pending <'), hint: r.raw.includes('deferred is not the same as unmeasured') },
  { host: true, head: true, hint: true })
check('page renders the gate checklist and a copy affordance',
  { checks: r.raw.includes('pfol-checks'), copy: r.raw.includes('pfol-copy'),
    clipboard: r.raw.includes('navigator.clipboard') },
  { checks: true, copy: true, clipboard: true })

// ---------------------------------------------------------------- loopback guard
check('non-loopback host refused', (await get('/daily-progress-tab/state?localDate=' + DATE, 'evil.example.com')).status, 403)
check('host-suffix trick refused', (await get('/daily-progress-tab/state?localDate=' + DATE, '127.0.0.1.evil.com')).status, 403)
check('[regression] IPv6 loopback ACCEPTED', (await get('/daily-progress-tab/state?localDate=' + DATE, '[::1]:3080')).status, 200)
check('[regression] bare IPv6 loopback accepted', (await get('/daily-progress-tab/state?localDate=' + DATE, '::1')).status, 200)

// ---------------------------------------------------------------- core flows
r = await get('/daily-progress-tab/state?localDate=' + DATE + '&tz=' + TZ)
check('empty state', { s: r.status, today: r.parsed.today, streak: r.parsed.streak, weekRate: r.parsed.weekRate },
  { s: 200, today: null, streak: 0, weekRate: null })

r = await post({ localDate: DATE, tz: TZ, op: 'addItem', payload: { target: 'today', text: 'write the fork' } })
const itemA = r.parsed.snapshot.today.items[0]
check('addItem today', { n: r.parsed.snapshot.today.items.length, text: itemA.text }, { n: 1, text: 'write the fork' })

r = await post({ localDate: DATE, tz: TZ, op: 'toggleItem', payload: { itemId: itemA.id } })
check('toggle → achieved', { done: r.parsed.snapshot.today.items[0].done, streak: r.parsed.snapshot.streak, weekRate: r.parsed.snapshot.weekRate },
  { done: true, streak: 1, weekRate: 1 })

r = await post({ localDate: DATE, tz: TZ, op: 'setTomorrow', payload: { items: [{ text: 'tomorrow one' }] } })
check('setTomorrow', r.parsed.snapshot.tomorrow.items[0].text, 'tomorrow one')

r = await post({ localDate: '2026-08-14', tz: TZ, op: 'clearToday', payload: {} })
check('clearToday', r.parsed.snapshot.today.items.length, 0)

// ---------------------------------------------------------------- regression: races & errors
r = await post({ localDate: DATE, tz: TZ, op: 'removeItem', payload: { itemId: 'ghost' } })
check('[regression] removeItem ghost id reports item_not_found', { s: r.status, code: r.parsed.code }, { s: 404, code: 'item_not_found' })

r = await post({ localDate: DATE, tz: TZ, op: 'setTomorrow', payload: { items: [{ id: 'dup', text: 'a' }, { id: 'dup', text: 'b' }] } })
const dupIds = r.parsed.snapshot.tomorrow.items.map((i) => i.id)
check('[regression] setTomorrow de-duplicates ids', new Set(dupIds).size, dupIds.length)

check('[regression] invalid date rejected', (await post({ localDate: '2026-02-30', tz: TZ, op: 'addItem', payload: {} })).parsed.code, 'invalid_local_date')
check('blank text rejected', (await post({ localDate: DATE, tz: TZ, op: 'addItem', payload: { text: '   ' } })).parsed.code, 'empty_text')
check('501-char text rejected', (await post({ localDate: DATE, tz: TZ, op: 'addItem', payload: { text: 'x'.repeat(501) } })).parsed.code, 'empty_text')
check('unknown op rejected', (await post({ localDate: DATE, tz: TZ, op: 'nope', payload: {} })).parsed.code, 'unknown_op')
check('oversized tz is clamped, not stored verbatim',
  (await post({ localDate: '2026-08-20', tz: 'Z'.repeat(5000), op: 'addItem', payload: { text: 'tz check' } })).parsed.snapshot.today.tz, 'UTC')

// [regression] lost-update race: concurrent writes must all survive
const RACE_DATE = '2026-09-01'
const N = 8
await Promise.all(Array.from({ length: N }, (_, i) =>
  post({ localDate: RACE_DATE, tz: TZ, op: 'addItem', payload: { target: 'today', text: 'concurrent-' + i } })))
const persisted = (await get('/daily-progress-tab/state?localDate=' + RACE_DATE + '&tz=' + TZ)).parsed.today
check('[regression] ' + N + ' concurrent addItem all persist', persisted.items.length, N)

// [regression] a failing rollover write must not raise an unhandled rejection
let unhandled = 0
const onUnhandled = () => { unhandled += 1 }
process.on('unhandledRejection', onUnhandled)
const yesterdayPlan = { date: '2026-10-09', tz: TZ, items: [{ id: 'y1', text: 'carry me', done: false, doneAt: null, origin: 'today' }], updatedAt: 'x' }
const { createHandlers } = await import('../lib/routes.js')
const { createPlanner } = await import('../lib/planner.js')
const failing = createHandlers(createPlanner(Promise.resolve({
  table: () => ({
    get: (k) => (k === 'default:2026-10-09' ? yesterdayPlan : undefined),
    put: async () => { throw new Error('backend down') },
    delete: async () => false, entries: function* () {}, keys: function* () {}, size: 0,
  }),
  // The real domain always carries the global slot (declared in the spec), so a
  // stub that omits it is an incomplete fixture, not a product bug.
  global: { get: () => ({ selectedProjectId: null, updatedAt: '' }), set: async () => {} },
})), () => '2026-10-10')
const failedRes = await new Promise((resolve) => {
  let status = 0
  const req = { method: 'GET', url: '/daily-progress-tab/state?localDate=2026-10-10&tz=UTC', headers: { host: '127.0.0.1:3080' }, [Symbol.asyncIterator]: async function* () {} }
  const res = { writeHead: (c) => { status = c }, end: () => resolve(status) }
  void Promise.resolve(failing.handle(req, res)).catch(() => resolve('THREW'))
})
await new Promise((r2) => setTimeout(r2, 250))
process.off('unhandledRejection', onUnhandled)
check('[regression] failed rollover write: read still succeeds', failedRes, 200)
check('[regression] failed rollover write: no unhandled rejection', unhandled, 0)

// ---------------------------------------------------------------- suggestion chips
const SUG_DATE = '2026-09-10'
const NEXT_DATE = '2026-09-11'
await post({ localDate: SUG_DATE, tz: TZ, op: 'addItem', payload: { target: 'today', text: 'draft the report' } })
let sugItem = (await get('/daily-progress-tab/state?localDate=' + SUG_DATE + '&tz=' + TZ)).parsed.today.items[0]

r = await post({ localDate: SUG_DATE, tz: TZ, op: 'setSuggestions', payload: { itemId: sugItem.id, suggestions: [
  { label: 'Break into steps', action: 'split', items: ['outline it', 'write it', 'review it'] },
  { label: 'Not today', action: 'defer', date: 'tomorrow' },
  { label: 'Needs ~2h', action: 'info', detail: 'Roughly two focused hours.' },
] } })
let chips = r.parsed.snapshot.today.items[0].suggestions
check('setSuggestions attaches a chip row', chips.length, 3)
check('chips get ids assigned', chips.every((c) => typeof c.id === 'string' && c.id.length > 0), true)

check('defer without a date rejected',
  (await post({ localDate: SUG_DATE, tz: TZ, op: 'setSuggestions', payload: { itemId: sugItem.id, suggestions: [{ label: 'x', action: 'defer' }] } })).parsed.code,
  'invalid_payload')
check('split without items rejected',
  (await post({ localDate: SUG_DATE, tz: TZ, op: 'setSuggestions', payload: { itemId: sugItem.id, suggestions: [{ label: 'x', action: 'split' }] } })).parsed.code,
  'invalid_payload')
check('bad action rejected',
  (await post({ localDate: SUG_DATE, tz: TZ, op: 'setSuggestions', payload: { itemId: sugItem.id, suggestions: [{ label: 'x', action: 'explode' }] } })).parsed.code,
  'invalid_payload')
check('too many chips rejected',
  (await post({ localDate: SUG_DATE, tz: TZ, op: 'setSuggestions', payload: { itemId: sugItem.id, suggestions: Array.from({ length: 7 }, (_, i) => ({ label: 'c' + i, action: 'info' })) } })).parsed.code,
  'invalid_payload')
check('unknown suggestion id rejected',
  (await post({ localDate: SUG_DATE, tz: TZ, op: 'applySuggestion', payload: { itemId: sugItem.id, suggestionId: 'nope' } })).parsed.code,
  'suggestion_not_found')

// apply the split chip: one task becomes three, and the chip is consumed
let splitChip = chips.find((c) => c.action === 'split')
r = await post({ localDate: SUG_DATE, tz: TZ, op: 'applySuggestion', payload: { itemId: sugItem.id, suggestionId: splitChip.id } })
check('applySuggestion split → 3 tasks', r.parsed.snapshot.today.items.length, 3)
check('applied chip is consumed', (r.parsed.snapshot.today.items[0].suggestions || []).length, 0)

// apply defer on one of the new tasks
const deferTarget = r.parsed.snapshot.today.items[1]
await post({ localDate: SUG_DATE, tz: TZ, op: 'setSuggestions', payload: { itemId: deferTarget.id, suggestions: [{ label: 'Push to tomorrow', action: 'defer', date: 'tomorrow' }] } })
const deferred = (await get('/daily-progress-tab/state?localDate=' + SUG_DATE + '&tz=' + TZ)).parsed.today.items[1]
r = await post({ localDate: SUG_DATE, tz: TZ, op: 'applySuggestion', payload: { itemId: deferred.id, suggestionId: deferred.suggestions[0].id } })
check('applySuggestion defer → moved off today', r.parsed.snapshot.today.items.length, 2)
check('defer landed on tomorrow', r.parsed.snapshot.tomorrow.items.some((i) => i.id === deferred.id), true)

// apply complete via chip
const compItem = r.parsed.snapshot.today.items[0]
await post({ localDate: SUG_DATE, tz: TZ, op: 'setSuggestions', payload: { itemId: compItem.id, suggestions: [{ label: 'Done', action: 'complete' }] } })
const comp2 = (await get('/daily-progress-tab/state?localDate=' + SUG_DATE + '&tz=' + TZ)).parsed.today.items[0]
r = await post({ localDate: SUG_DATE, tz: TZ, op: 'applySuggestion', payload: { itemId: comp2.id, suggestionId: comp2.suggestions[0].id } })
check('applySuggestion complete → task done', r.parsed.snapshot.today.items[0].done, true)

// ---------------------------------------------------------------- agent tools
// A second isolated instance, this time WITH a tool registry, to prove the
// tools register and actually drive the same planner.
const toolRoot = mkdtempSync(join(tmpdir(), 'dpt-tools-'))
const toolFacility = new DomainFacility({
  storage: { backend: { get: (name) => (name === 'json' ? new JsonStorageBackend(toolRoot) : undefined) } },
  emit: () => {}, logger: { warn: () => {} },
}, { backend: 'json' })
const toolDefs = new Map()
const toolCtx = new Context()
toolCtx.provide('storageDomain', toolFacility)
toolCtx.provide('webServer', { register: () => () => {} })
toolCtx.provide('tools', { register: (def) => { toolDefs.set(def.name, def); return () => {} } })

let toolActivated = false
toolCtx.plugin({
  name: Plugin.name,
  inject: Plugin.inject,
  apply: (c) => {
    toolActivated = true
    return Plugin.apply(c, { timezone: TZ, publishOwner: PROBE_OWNER, leakScan: PROBE_SCAN })
  },
})
await new Promise((r2) => setTimeout(r2, 500))

check('plugin activates WITH a tools service', toolActivated, true)
const expectedNames = ['daily_add_project', 'daily_add_task', 'daily_backlog_add', 'daily_backlog_plan', 'daily_backlog_remove', 'daily_checkin', 'daily_checkin_item', 'daily_edit_task', 'daily_export',
  'daily_live', 'daily_move_task', 'daily_now', 'daily_plan', 'daily_plan_project', 'daily_plugin', 'daily_plugin_remove', 'daily_plugins', 'daily_projects', 'daily_remove_task', 'daily_reorder_task', 'daily_select_project', 'daily_set_task_done', 'daily_spark', 'daily_spark_dismiss', 'daily_spark_promote', 'daily_sparks', 'daily_suggest', 'daily_update_project', 'daily_update_task']
check('all agent tools registered', [...toolDefs.keys()].sort(), expectedNames)

const runTool = async (name, args) => {
  const def = toolDefs.get(name)
  if (!def) throw new Error('no tool ' + name)
  return await def.execute(args, {})
}

// tools resolve "today" from the configured zone, not from a browser
const expectedToday = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
let view = await runTool('daily_plan', {})
check('daily_plan uses the configured timezone', view.date, expectedToday)

view = await runTool('daily_add_task', { text: 'agent scheduled this', target: 'today' })
check('daily_add_task schedules on today', view.today.some((task) => task.text === 'agent scheduled this'), true)

view = await runTool('daily_add_task', { text: 'agent planned this', target: 'tomorrow' })
check('daily_add_task can target tomorrow', view.tomorrow.some((task) => task.text === 'agent planned this'), true)

check('tools reject an empty task', await runTool('daily_add_task', { text: '  ' }).then(() => 'no-error', (e) => String(e.message).split(':')[0]), 'empty_text')

// complete by TEXT substring, not id — the model usually knows the words
view = await runTool('daily_set_task_done', { task: 'agent scheduled', done: true })
check('daily_set_task_done completes by text match', view.today.find((task) => task.text === 'agent scheduled this').done, true)

view = await runTool('daily_set_task_done', { task: 'agent scheduled', done: false })
check('daily_set_task_done reopens', view.today.find((task) => task.text === 'agent scheduled this').done, false)

view = await runTool('daily_edit_task', { task: 'agent scheduled', newText: 'agent renamed this' })
check('daily_edit_task rewrites text', view.today.some((task) => task.text === 'agent renamed this'), true)

// ambiguity must be reported, not guessed — two tasks sharing a substring
await runTool('daily_add_task', { text: 'dup alpha' })
await runTool('daily_add_task', { text: 'dup beta' })
check('ambiguous text match is refused',
  await runTool('daily_set_task_done', { task: 'dup', done: true }).then(() => 'no-error', (e) => String(e.message).split(':')[0]),
  'invalid_payload')
// clear the duplicates again so every later matcher stays unique
for (const d of (await runTool('daily_plan', {})).today.filter((task) => task.text.indexOf('dup ') === 0)) {
  await runTool('daily_remove_task', { itemId: d.id })
}
await runTool('daily_add_task', { text: 'agent extra task' })

view = await runTool('daily_suggest', {
  task: 'agent renamed this',
  suggestions: [
    { label: 'Break into 3', action: 'split', items: ['a', 'b', 'c'] },
    { label: 'Tomorrow', action: 'defer', date: 'tomorrow' },
    { label: 'Context', action: 'info', detail: 'why this matters' },
  ],
})
check('daily_suggest attaches chips', (view.today.find((task) => task.text === 'agent renamed this').suggestions || []).length, 3)

view = await runTool('daily_move_task', { task: 'agent extra', toDate: NEXT_DATE })
check('daily_move_task defers a task', view.today.some((task) => task.text === 'agent extra task'), false)

view = await runTool('daily_remove_task', { task: 'agent renamed this' })
check('daily_remove_task deletes', view.today.some((task) => task.text === 'agent renamed this'), false)


// ---- project tools ----
let pv = await runTool('daily_add_project', { name: 'Fast small', fulfills: 'Retainer for SMEs.', ttfdDays: 14, effortDays: 7, revenuePerMonth: 15000, confidence: 1, rubric: { forcingFunction: 4, moat: 2 } })
check('daily_add_project ranks it', pv.projects[0].name, 'Fast small')
check('daily_projects style output carries the score', pv.projects[0].score > 0, true)
pv = await runTool('daily_add_project', { name: 'Unestimated', fulfills: 'Not costed.' })
check('unestimated project sorts last', pv.projects.map((p) => p.name), ['Fast small', 'Unestimated'])
pv = await runTool('daily_projects', {})
check('daily_projects reads the board', pv.projects.length, 2)
pv = await runTool('daily_select_project', { project: 'Fast' })
check('daily_select_project matches by substring', pv.selectedProjectName, 'Fast small')
check('selecting activates the project', pv.projects.find((p) => p.name === 'Fast small').status, 'active')
check('daily_select_project refuses an unknown name',
  await runTool('daily_select_project', { project: 'ghost' }).then(() => 'no-error', (e) => String(e.message).split(':')[0]), 'project_not_found')

pv = await runTool('daily_plan_project', { tasks: [
  { text: 'Draft the pricing page', summary: 'Writes the offer so a buyer can self-qualify.' },
  { text: 'Book five calls', summary: 'Fills the pipeline for next week.', target: 'tomorrow' },
] })
check('daily_plan_project links tasks to the selected project',
  pv.today.some((task) => task.text === 'Draft the pricing page' && task.projectId !== '' && task.summary === 'Writes the offer so a buyer can self-qualify.'), true)
check('daily_plan_project honours the per-task day',
  pv.tomorrow.some((task) => task.text === 'Book five calls'), true)

pv = await runTool('daily_update_task', { task: 'Draft the pricing', summary: 'Rewritten by the agent.' })
check('daily_update_task rewrites a summary box',
  pv.today.find((task) => task.text === 'Draft the pricing page').summary, 'Rewritten by the agent.')
pv = await runTool('daily_update_task', { task: 'Book five calls', projectId: null })
check('daily_update_task can unlink a project',
  pv.tomorrow.find((task) => task.text === 'Book five calls').projectId, '')
pv = await runTool('daily_update_project', { project: 'Unestimated', ttfdDays: 5, effortDays: 2, revenuePerMonth: 40000, confidence: 0.8 })
check('daily_update_project promotes an unestimated project', pv.projects[0].name, 'Unestimated')

// ---- choosing what to work on, through the tools ----
view = await runTool('daily_backlog_add', { project: 'Fast', text: 'call the accountant' })
check('daily_backlog_add files an unscheduled candidate',
  view.backlog.some((b) => b.text === 'call the accountant' && b.projectId !== ''), true)
check('daily_plan reports the backlog', view.backlog.length, 1)
check('an empty store has nothing picked', view.now, null)

view = await runTool('daily_backlog_plan', { task: 'accountant', select: true })
check('daily_backlog_plan schedules the candidate', view.today.some((task) => task.text === 'call the accountant'), true)
check('and clears it from the backlog', view.backlog.length, 0)
check('and picks it when asked', view.now.text, 'call the accountant')

view = await runTool('daily_now', { clear: true })
check('daily_now clears the pick', view.now, null)

view = await runTool('daily_now', { itemId: view.today.find((task) => task.text === 'call the accountant').id })
check('daily_now picks a task by id', view.now.text, 'call the accountant')

await runTool('daily_backlog_add', { project: 'Fast', text: 'delete me from the backlog' })
view = await runTool('daily_backlog_remove', { task: 'delete me' })
check('daily_backlog_remove drops a candidate', view.backlog.some((b) => b.text === 'delete me from the backlog'), false)

await runTool('daily_add_task', { text: 'alpha task' })
view = await runTool('daily_add_task', { text: 'beta task' })
const beforeOrder = view.today.map((task) => task.text)
view = await runTool('daily_reorder_task', { task: 'beta task', direction: 'up' })
check('daily_reorder_task moves it up the list',
  view.today.map((task) => task.text).indexOf('beta task') < beforeOrder.indexOf('beta task'), true)

// a task parked on another day is offered in the pool with the day it sits on
view = await runTool('daily_add_task', { text: 'parked on tomorrow', target: 'tomorrow' })
const parked = view.pool.find((p) => p.text === 'parked on tomorrow')
check('daily_plan lists a task parked on another day', Boolean(parked), true)
check('a future task is bucketed as upcoming', parked.bucket, 'upcoming')
const todayKey = view.date
const pulled = await runTool('daily_move_task', { itemId: parked.id, fromDate: parked.date, toDate: todayKey })
check('daily_move_task pulls a pooled task forward by fromDate', pulled.today.some((task) => task.id === parked.id), true)
check('and it leaves the pool', pulled.pool.some((p) => p.id === parked.id), false)
await runTool('daily_remove_task', { task: 'parked on tomorrow' })

// ---- the feedback loop, driven entirely through the agent tools
pv = await runTool('daily_update_project', { project: 'Unestimated', status: 'shipped', metricName: 'paid pilots', revenuePerMonth: 9000, effortDays: 3, ttfdDays: 20 })
check('shipping sets the status', pv.projects.find((p) => p.name === 'Unestimated').status, 'shipped')
let liveView = await runTool('daily_live', {})
check('a shipped project is on the live board', liveView.projects.map((p) => p.name), ['Unestimated'])
check('nothing is stale before the first check-in', liveView.staleCount, 0)
liveView = await runTool('daily_checkin', { project: 'Unestimated', date: '2026-09-14', revenue: 4500, customers: 1, metric: 1, progress: 'Pilot signed.', hurdles: ['No case study yet'], verdict: 'fix' })
check('daily_checkin records the money', liveView.projects[0].totalRevenue, 4500)
check('daily_checkin records the verdict', liveView.projects[0].verdict, 'fix')
check('daily_checkin records the one metric', { n: liveView.projects[0].metricName, v: liveView.projects[0].latestMetric }, { n: 'paid pilots', v: 1 })
check('daily_checkin opens a hurdle', liveView.projects[0].openHurdles, ['No case study yet'])
liveView = await runTool('daily_checkin_item', { project: 'Unestimated', kind: 'hurdle', match: 'case study' })
check('daily_checkin_item closes the hurdle', liveView.projects[0].openHurdles.length, 0)
liveView = await runTool('daily_checkin', { project: 'Unestimated', date: '2026-09-21', revenue: 2500, metric: 3 })
check('a later check-in adds to the money', liveView.projects[0].totalRevenue, 7000)
check('the metric delta is reported', liveView.projects[0].metricDelta, 2)
// Re-running a check-in for the SAME day updates that day. Accumulating instead
// would double-count money every time the agent re-stated the same numbers.
liveView = await runTool('daily_checkin', { project: 'Unestimated', date: '2026-09-21', revenue: 1000 })
check('re-checking in the same day replaces that day, it does not double-count', liveView.projects[0].totalRevenue, 5500)

// ---- sparks: the ideas the feedback produced, driven through the tools
liveView = await runTool('daily_checkin', { project: 'Unestimated', date: '2026-09-28', verdict: 'fix', sparks: ['Sell the onboarding checklist as a product'] })
check('daily_checkin captures the ideas it sparked', liveView.projects[0].sparkOpen, 1)
let sparkView = await runTool('daily_sparks', {})
check('daily_sparks lists the open idea',
  sparkView.sparks.filter((s) => s.status === 'open').map((s) => s.text), ['Sell the onboarding checklist as a product'])
const toolSpark = sparkView.sparks.find((s) => s.status === 'open')
check('the idea names the feedback it came from', toolSpark.source, 'Unestimated on 2026-09-28')
check('an idea captured today is not yet due for triage', sparkView.triageDue, false)
sparkView = await runTool('daily_spark', { text: 'A standalone idea, no venture behind it' })
check('daily_spark captures one idea on its own', sparkView.open, 2)
const standaloneSpark = sparkView.sparks.find((s) => s.text === 'A standalone idea, no venture behind it')
check('an unattributed idea says so rather than guessing', standaloneSpark.source, 'no source recorded')
check('a dismissal with no reason is refused',
  await runTool('daily_spark_dismiss', { sparkId: standaloneSpark.id, reason: '   ' }).then(() => 'no-error', (e) => String(e.message).split(':')[0]), 'invalid_payload')
sparkView = await runTool('daily_spark_dismiss', { sparkId: standaloneSpark.id, reason: 'It is a feature of the existing offer, not a business' })
check('the dismissal records the reason',
  sparkView.sparks.find((s) => s.id === standaloneSpark.id).outcome, 'dismissed: It is a feature of the existing offer, not a business')
check('the dismissed idea left the queue', sparkView.open, 1)
sparkView = await runTool('daily_spark_promote', { sparkId: toolSpark.id })
check('promoting closes the idea as promoted', sparkView.open, 0)
check('the promotion reports the project it became',
  sparkView.sparks.find((s) => s.id === toolSpark.id).outcome, 'promoted to project: Sell the onboarding checklist as a product')
liveView = await runTool('daily_checkin', { project: 'Unestimated', date: '2026-09-28', sparks: ['Sell the onboarding checklist as a product'] })
check('re-stating the check-in does not resurrect a promoted idea', liveView.projects[0].sparkOpen, 0)
check('an unknown spark id is refused',
  await runTool('daily_spark_promote', { sparkId: 'not-a-spark' }).then(() => 'no-error', (e) => String(e.message).split(':')[0]), 'spark_not_found')

// ---- the portfolio register, through the tools
let folio = await runTool('daily_plugins', {})
check('the register starts empty', [folio.authored, folio.plugins.length], [0, 0])
folio = await runTool('daily_plugin', {
  name: 'dsh-demo', origin: 'ours', visibility: 'showcase', licence: 'MIT',
  sourcePath: '~/projects/plugins/dsh-demo',
  hasLicenseFile: true, hasReadme: true, hasScreenshot: true, sourceOutsideProfile: true,
  leakScanPassed: true, preflightPassed: true, preflightAt: expectedToday,
  preflightNote: 'tests + probes + build', gitReady: true, verifiedAt: expectedToday,
})
check('daily_plugin records one plugin', folio.authored, 1)
check('a fully verified plugin is ready to publish', [folio.ready, folio.plugins[0].blockers], [1, []])
check('the facts are dated, so they can expire', folio.plugins[0].verifiedDaysAgo, 0)
check('the gate reports EVERY item, passed ones included',
  folio.plugins[0].checks.map((item) => item.key),
  ['origin', 'visibility', 'leak-scan', 'preflight', 'source', 'address',
    'licence', 'upstream', 'readme', 'screenshot', 'git', 'recency'])
check('and every one of them passes here', folio.plugins[0].checks.filter((item) => !item.ok).length, 0)
check('a publishable plugin is handed the exact commands to publish it',
  [folio.plugins[0].commands.includes('git push -u origin main'),
    // The CONFIGURED account and the CONFIGURED scanner — proof the value was
    // read from config, not that some default happened to be in place.
    folio.plugins[0].commands.includes(PROBE_OWNER + '/dsh-demo'),
    folio.plugins[0].commands.includes('bash ' + PROBE_SCAN + ' .')], [true, true, true])
check('and a row that HAS commands is given no reason for their absence',
  folio.plugins[0].commandsNote, '')
folio = await runTool('daily_plugin', { name: 'dsh-demo', hasScreenshot: false })
check('daily_plugin UPDATES the same record rather than adding a second', folio.plugins.length, 1)
check('a missing screenshot blocks it', folio.plugins[0].blockers.length, 1)
check('and it is no longer ready', folio.ready, 0)
check('the failed item names itself and says what to do',
  folio.plugins[0].checks.filter((item) => !item.ok).map((item) => [item.key, item.detail.length > 0]),
  [['screenshot', true]])
check('the blocker list is DERIVED from the checklist, so the two cannot disagree',
  folio.plugins[0].blockers,
  folio.plugins[0].checks.filter((item) => !item.ok).map((item) => item.detail))
check('and one outstanding item is enough to withhold the commands entirely',
  folio.plugins[0].commands, '')
// Our OWN plugin with everything else in place, marked internal: the single flag
// has to remove the commands by itself, or the gate is not what does the refusing.
folio = await runTool('daily_plugin', { name: 'dsh-demo', hasScreenshot: true, visibility: 'internal' })
check('our own plugin marked INTERNAL is offered NO commands at all',
  folio.plugins.find((p) => p.name === 'dsh-demo').commands, '')
check('and its refusal is marked permanent rather than as work to do',
  folio.plugins.find((p) => p.name === 'dsh-demo').checks
    .filter((item) => !item.ok).map((item) => [item.key, item.fatal]),
  [['visibility', true]])
folio = await runTool('daily_plugin', { name: 'dsh-demo', visibility: 'showcase' })
check('showcase restores them, so the flag is the only thing that refused',
  folio.plugins.find((p) => p.name === 'dsh-demo').commands.includes('git push -u origin main'), true)
check('and they are safe to paste: no substitution, no interpolation',
  /[$`]/.test(folio.plugins.find((p) => p.name === 'dsh-demo').commands), false)
// A path the shell would act on. The commands must vanish - and the gate must SAY
// so, or the panel would read READY TO PUBLISH while handing over nothing.
folio = await runTool('daily_plugin', { name: 'dsh-demo', sourcePath: '~/x; rm -rf /' })
check('a source path that is not a bare word yields NO commands rather than a dangerous one',
  folio.plugins.find((p) => p.name === 'dsh-demo').commands, '')
check('and the gate names that as the reason, instead of reading ready',
  folio.plugins.find((p) => p.name === 'dsh-demo').checks
    .filter((item) => !item.ok).map((item) => item.key),
  ['address'])
folio = await runTool('daily_plugin', { name: 'dsh-demo', sourcePath: '~/projects/plugins/dsh-demo' })
check('and a pasteable path puts them back', 
  folio.plugins.find((p) => p.name === 'dsh-demo').commands.includes('cd ~/projects/plugins/dsh-demo'), true)
folio = await runTool('daily_plugin', { name: 'dsh-somebody-elses', origin: 'third-party' })
check('third-party work is not publishable at all', folio.plugins.find((p) => p.name === 'dsh-somebody-elses').publishable, false)
check('and is never counted as authored', folio.authored, 1)
check('a new plugin is internal unless told otherwise',
  folio.plugins.find((p) => p.name === 'dsh-somebody-elses').visibility, 'internal')
// Make it showcase, with every fact true, so ORIGIN is the only thing refusing
// it. Left internal it would be refused twice over and would prove nothing about
// the rule that matters: someone else's work is never offered for publication.
folio = await runTool('daily_plugin', {
  name: 'dsh-somebody-elses', visibility: 'showcase', licence: 'MIT',
  sourcePath: '~/projects/plugins/dsh-theirs',
  hasLicenseFile: true, hasReadme: true, hasScreenshot: true, sourceOutsideProfile: true,
  leakScanPassed: true, preflightPassed: true, preflightAt: expectedToday,
  gitReady: true, verifiedAt: expectedToday,
})
const theirs = folio.plugins.find((p) => p.name === 'dsh-somebody-elses')
check('someone else\'s otherwise PERFECT plugin still gets no commands', theirs.commands, '')
check('and the gate shows the refusal alone, not a to-do list to work through',
  theirs.checks.map((item) => item.key), ['origin', 'visibility'])
folio = await runTool('daily_plugin_remove', { plugin: 'dsh-somebody-elses' })
check('removing takes it out of the register', folio.plugins.length, 1)
check('an unknown plugin is refused',
  await runTool('daily_plugin_remove', { plugin: 'ghost' }).then(() => 'no-error', (e) => String(e.message).split(':')[0]), 'plugin_not_found')

// ---------------------------------------------------------------- the public export (tool)
// The résumé is DERIVED from the register, so most of these checks are about what does NOT
// appear: unpublished work, someone else's work, and the gate's own language.
//
// THIS BLOCK LIVES HERE ON PURPOSE: it needs the TOOLS store, which the probe removes a few
// sections below (the bare-context check deletes its directory). A write after that point
// fails with ENOENT rather than a useful message — which is how this was found.
const { EXPORT_BEGIN, EXPORT_END } = await import('../lib/export.js')
const resume = await runTool('daily_export', {})
check('daily_export renders the block with both markers',
  [resume.block.startsWith(EXPORT_BEGIN), resume.block.trimEnd().endsWith(EXPORT_END)], [true, true])
check('the public block carries none of the gate\'s language',
  [/^bash /m.test(resume.block), /SCAN CLEAN/.test(resume.block), /\/home\//.test(resume.block),
    /TODO/.test(resume.block), /pass\b/.test(resume.block)], [false, false, false, false, false])
check('with nothing public it says so instead of emitting an empty list',
  [resume.published, /Nothing published yet\./.test(resume.block)], [0, true])

// Record ONE known public plugin, then assert it appears — and that nothing ELSE does.
await runTool('daily_plugin', {
  name: 'dsh-demo', status: 'public', publicUrl: 'https://github.com/' + PROBE_OWNER + '/dsh-demo',
})
const named = await runTool('daily_export', {})
check('a plugin that IS public and carries a URL is listed',
  named.block.includes('[dsh-demo](https://github.com/' + PROBE_OWNER + '/dsh-demo)'), true)
check('and the published count follows the list', named.published, 1)
const others = (await runTool('daily_plugins', {})).plugins.filter((p) => p.name !== 'dsh-demo')
check('and NO other plugin is listed', others.filter((p) => named.block.includes(p.name)).map((p) => p.name), [])

const spliced = await runTool('daily_export', {
  document: 'PROSE ABOVE\n' + EXPORT_BEGIN + '\nstale\n' + EXPORT_END + '\nPROSE BELOW\n',
})
check('a document with markers comes back spliced, prose intact',
  [spliced.spliced.includes('PROSE ABOVE'), spliced.spliced.includes('PROSE BELOW'),
    spliced.spliced.includes('stale'), spliced.spliceError], [true, true, false, ''])
const refused = await runTool('daily_export', { document: 'a document with no markers at all' })
check('a document without markers is REFUSED rather than appended to',
  [refused.spliced, refused.spliceError.length > 0], ['', true])

// The plugin must still boot when NO tool registry exists (optional dependency).
const bareCtx = new Context()
bareCtx.provide('storageDomain', new DomainFacility({
  storage: { backend: { get: (name) => (name === 'json' ? new JsonStorageBackend(mkdtempSync(join(tmpdir(), 'dpt-bare-'))) : undefined) } },
  emit: () => {}, logger: { warn: () => {} },
}, { backend: 'json' }))
let bareRoute = null
bareCtx.provide('webServer', { register: (r2) => { bareRoute = r2; return () => {} } })
let bareActivated = false
bareCtx.plugin({ name: Plugin.name, inject: Plugin.inject, apply: (c) => { bareActivated = true; return Plugin.apply(c, { timezone: TZ }) } })
await new Promise((r2) => setTimeout(r2, 400))
check('activates with NO tools service (optional dep)', { activated: bareActivated, route: bareRoute !== null }, { activated: true, route: true })

// ---- a deployment that has configured NOTHING, which is the state a reader's
// own instance starts in. Two things must hold: the commands are withheld, and
// the row SAYS WHY. A green row above a silent blank is the one shape the
// register's own `address` gate item exists to prevent.
const noneTools = new Map()
const noneCtx = new Context()
noneCtx.provide('storageDomain', new DomainFacility({
  storage: { backend: { get: (name) => (name === 'json' ? new JsonStorageBackend(mkdtempSync(join(tmpdir(), 'dpt-none-'))) : undefined) } },
  emit: () => {}, logger: { warn: () => {} },
}, { backend: 'json' }))
noneCtx.provide('webServer', { register: () => () => {} })
noneCtx.provide('tools', { register: (def) => { noneTools.set(def.name, def); return () => {} } })
let noneActivated = false
// NO config at all — not even a timezone. This is the state a reader's own
// instance starts in, so it must activate AND withhold, and this is now the only
// zero-config boot in the suite.
noneCtx.plugin({
  name: Plugin.name,
  inject: Plugin.inject,
  apply: (c) => { noneActivated = true; return Plugin.apply(c) },
})
await new Promise((r3) => setTimeout(r3, 500))
check('activates with NO config at all', noneActivated, true)
const noneTool = async (name, args) => {
  const def = noneTools.get(name)
  if (!def) throw new Error('no tool ' + name + ' on the unconfigured harness')
  return await def.execute(args, {})
}
const noneView = await noneTool('daily_plugin', {
  name: 'dsh-unconfigured', origin: 'ours', visibility: 'showcase', licence: 'MIT',
  sourcePath: '~/projects/plugins/dsh-unconfigured',
  hasLicenseFile: true, hasReadme: true, hasScreenshot: true, sourceOutsideProfile: true,
  leakScanPassed: true, preflightPassed: true, preflightAt: expectedToday, gitReady: true,
  verifiedAt: expectedToday,
})
check('with no publish owner configured the commands are WITHHELD',
  noneView.plugins[0].commands, '')
check('and the gate stays GREEN — a deployment setting is not a plugin defect',
  [noneView.ready, noneView.plugins[0].blockers], [1, []])
check('and the row names the field that would produce them',
  [/no publish owner is configured/.test(noneView.plugins[0].commandsNote),
    /publishOwner/.test(noneView.plugins[0].commandsNote)], [true, true])
const noneDef = noneTools.get('daily_plugins')
// The renderer hangs off `output`, and that is ASSERTED rather than guarded with
// a typeof: the first version of this check read `def.render`, found undefined,
// and quietly asserted on an empty string. A guard that hides its own cause turns
// a real failure into a confusing one.
check('daily_plugins exposes the renderer this check reads',
  typeof noneDef.output.render, 'function')
const noneText = noneDef.output.render({}, await noneTool('daily_plugins', {}))
  .map((part) => part.text).join('\n')
check('the tool report carries the reason, not just a blank where the shell should be',
  /no publish owner is configured/.test(noneText), true)
check('and it does not invite a paste it cannot supply',
  /Paste this to publish it/.test(noneText), false)

rmSync(toolRoot, { recursive: true, force: true })

// ---------------------------------------------------------------- projects
const PROJ_DATE = '2026-09-20'
r = await post({ localDate: PROJ_DATE, tz: TZ, op: 'addProject', payload: {
  name: 'Fast small', fulfills: 'Retainer for SMEs who already pay for this.', ttfdDays: 14, effortDays: 7,
  revenuePerMonth: 15000, confidence: 1, rubric: { forcingFunction: 4, moat: 2 },
} })
const fastProject = r.parsed.snapshot.projects[0]
check('addProject adds it to the board', { n: r.parsed.snapshot.projects.length, name: fastProject.name }, { n: 1, name: 'Fast small' })
check('a new project is pending until it is selected', fastProject.pending, true)
check('addProject computes a score', fastProject.score.score > 0, true)
check('weakest rubric dimension reported', fastProject.score.weakestDimension, 'moat')

r = await post({ localDate: PROJ_DATE, tz: TZ, op: 'addProject', payload: {
  name: 'Slow big', fulfills: 'Much bigger, much later.', ttfdDays: 180, effortDays: 20,
  revenuePerMonth: 30000, confidence: 1, rubric: { forcingFunction: 3 },
} })
check('ranking prefers fast money over the bigger number', r.parsed.snapshot.projects.map((p) => p.name), ['Fast small', 'Slow big'])

r = await post({ localDate: PROJ_DATE, tz: TZ, op: 'addProject', payload: { name: 'No estimates', fulfills: 'Not costed yet.' } })
check('unestimated sorts last', r.parsed.snapshot.projects.map((p) => p.name), ['Fast small', 'Slow big', 'No estimates'])
check('unestimated is flagged, not scored', { u: r.parsed.snapshot.projects[2].score.unestimated, s: r.parsed.snapshot.projects[2].score.score }, { u: true, s: null })
check('duplicate project name rejected',
  (await post({ localDate: PROJ_DATE, tz: TZ, op: 'addProject', payload: { name: 'Fast small', fulfills: 'dup' } })).parsed.code, 'invalid_payload')
check('out-of-range rubric rejected',
  (await post({ localDate: PROJ_DATE, tz: TZ, op: 'addProject', payload: { name: 'Bad rubric', fulfills: 'x', rubric: { moat: 9 } } })).parsed.code, 'invalid_payload')

r = await post({ localDate: PROJ_DATE, tz: TZ, op: 'updateProject', payload: {
  project: 'No estimates', ttfdDays: 5, effortDays: 2, revenuePerMonth: 40000, confidence: 0.8,
} })
check('estimating promotes it to the top', r.parsed.snapshot.projects[0].name, 'No estimates')
check('patched project keeps its name', r.parsed.snapshot.projects[0].fulfills, 'Not costed yet.')

r = await post({ localDate: PROJ_DATE, tz: TZ, op: 'selectProject', payload: { project: 'Fast' } })
check('selectProject sets the selection', r.parsed.snapshot.selectedProjectId, fastProject.id)
check('selecting an idea activates it', r.parsed.snapshot.projects.find((p) => p.id === fastProject.id).status, 'active')
check('selecting it moves it out of Pending', r.parsed.snapshot.projects.find((p) => p.id === fastProject.id).pending, false)
check('ambiguous project name refused',
  (await post({ localDate: PROJ_DATE, tz: TZ, op: 'selectProject', payload: { project: 's' } })).parsed.code, 'invalid_payload')

// tasks linked to the project, each with its own summary box
await post({ localDate: PROJ_DATE, tz: TZ, op: 'addItem', payload: {
  target: 'today', text: 'Draft the pricing page', summary: 'Writes the offer so a buyer can self-qualify.', projectId: fastProject.id,
} })
r = await get('/daily-progress-tab/state?localDate=' + PROJ_DATE + '&tz=' + TZ)
check('task carries its summary box and project link',
  { s: r.parsed.today.items[0].summary, p: r.parsed.today.items[0].projectId },
  { s: 'Writes the offer so a buyer can self-qualify.', p: fastProject.id })
check('unknown project link rejected',
  (await post({ localDate: PROJ_DATE, tz: TZ, op: 'addItem', payload: { target: 'today', text: 'x', projectId: 'ghost' } })).parsed.code, 'project_not_found')

r = await post({ localDate: PROJ_DATE, tz: TZ, op: 'updateItem', payload: {
  itemId: r.parsed.today.items[0].id, match: 'Draft the pricing page', summary: 'Rewritten summary.',
} })
check('updateItem rewrites the summary box', r.parsed.snapshot.today.items[0].summary, 'Rewritten summary.')

r = await post({ localDate: PROJ_DATE, tz: TZ, op: 'removeProject', payload: { projectId: fastProject.id } })
check('removeProject clears the selection', r.parsed.snapshot.selectedProjectId, null)
check('removeProject unlinks today tasks', r.parsed.snapshot.today.items.every((item) => item.projectId === undefined), true)
check('removeProject drops it from the board', r.parsed.snapshot.projects.some((p) => p.id === fastProject.id), false)

// Orphans are invisible on the board, so this has to read the raw table. It is how
// a leftover check-in from a deleted demo project was found in a backup dump.
const orphanCheckins = [...openDomain.table('checkins').entries()].filter(([, c]) => c.projectId === liveProject.id)
check('removeProject leaves no orphaned check-ins', orphanCheckins.length, 0)
check('unknown project id rejected',
  (await post({ localDate: PROJ_DATE, tz: TZ, op: 'removeProject', payload: { project: 'ghost' } })).parsed.code, 'project_not_found')

// ---------------------------------------------------------------- feedback loop (Live)
r = await post({ localDate: PROJ_DATE, tz: TZ, op: 'addProject', payload: {
  name: 'Live test', fulfills: 'A shipped venture under measurement.', ttfdDays: 10, effortDays: 5,
  revenuePerMonth: 12000, confidence: 0.5, status: 'shipped', metricName: 'paid retainers',
  killSwitch: 'two retainers by day 60',
} })
const liveProject = r.parsed.snapshot.projects.find((p) => p.name === 'Live test')
check('a shipped project is live and not pending', { live: liveProject.live, pending: liveProject.pending }, { live: true, pending: false })
check('a shipped project starts with no check-ins', liveProject.monitoring.checkins, 0)

r = await post({ localDate: PROJ_DATE, tz: TZ, op: 'logCheckin', payload: {
  projectId: liveProject.id, date: '2026-09-14', revenue: 5000, customers: 1, metric: 1,
  progress: 'First retainer signed.', verdict: 'continue',
  hurdles: ['Client slow to share GBP access'], corrections: ['Add a kickoff checklist'],
} })
let liveProject2 = r.parsed.snapshot.projects.find((p) => p.id === liveProject.id)
check('a check-in is recorded', liveProject2.monitoring.checkins, 1)
check('money is carried on the project', liveProject2.monitoring.totalRevenue, 5000)
check('the hurdle is tracked open', liveProject2.monitoring.openHurdles.map((h) => h.text), ['Client slow to share GBP access'])
check('the correction is tracked open', liveProject2.monitoring.openCorrections.map((c) => c.text), ['Add a kickoff checklist'])
check('progress is carried for the column', liveProject2.monitoring.lastProgress, 'First retainer signed.')

r = await post({ localDate: PROJ_DATE, tz: TZ, op: 'logCheckin', payload: {
  projectId: liveProject.id, date: '2026-09-18', revenue: 7000, customers: 2, metric: 2,
} })
liveProject2 = r.parsed.snapshot.projects.find((p) => p.id === liveProject.id)
check('money accumulates across check-ins', liveProject2.monitoring.totalRevenue, 12000)
check('the metric delta is the change since the previous check-in', liveProject2.monitoring.metricDelta, 1)
check('a second check-in keeps the earlier hurdle open', liveProject2.monitoring.openHurdles.length, 1)
check('a fresh loop is not stale', liveProject2.monitoring.stale, false)

r = await post({ localDate: PROJ_DATE, tz: TZ, op: 'checkinItem', payload: { projectId: liveProject.id, kind: 'hurdle', match: 'GBP access' } })
liveProject2 = r.parsed.snapshot.projects.find((p) => p.id === liveProject.id)
check('closing a hurdle clears it from the open list', liveProject2.monitoring.openHurdles.length, 0)
check('unknown hurdle rejected',
  (await post({ localDate: PROJ_DATE, tz: TZ, op: 'checkinItem', payload: { project: 'Live test', kind: 'hurdle', match: 'nothing like this' } })).parsed.code, 'item_not_found')
check('an unknown kind is rejected',
  (await post({ localDate: PROJ_DATE, tz: TZ, op: 'checkinItem', payload: { project: 'Live test', kind: 'nonsense', match: 'x' } })).parsed.code, 'invalid_payload')
check('negative revenue is rejected',
  (await post({ localDate: PROJ_DATE, tz: TZ, op: 'logCheckin', payload: { project: 'Live test', revenue: -1 } })).parsed.code, 'invalid_payload')

// staleness is judged against the CALENDAR BEING SHOWN, not the host clock
r = await get('/daily-progress-tab/state?localDate=2026-10-20')
liveProject2 = r.parsed.projects.find((p) => p.id === liveProject.id)
check('a quiet loop is flagged stale', liveProject2.monitoring.stale, true)
check('staleness counts the days since the last check-in', liveProject2.monitoring.daysSinceCheckin, 32)

r = await post({ localDate: PROJ_DATE, tz: TZ, op: 'logCheckin', payload: { project: 'Live test', verdict: 'kill', note: 'No second client.' } })
check('a kill verdict kills the project', r.parsed.snapshot.projects.find((p) => p.id === liveProject.id).status, 'killed')
check('a killed project leaves the live board', r.parsed.snapshot.projects.find((p) => p.id === liveProject.id).live, false)

// removing a project must take its check-ins with it
r = await post({ localDate: PROJ_DATE, tz: TZ, op: 'removeProject', payload: { projectId: liveProject.id } })
check('the removed project is off the board', r.parsed.snapshot.projects.some((p) => p.id === liveProject.id), false)

// ------------------------------------------- sparks: ideas the feedback produced
// A spark is a business idea a live project's feedback suggested — a hurdle that
// turns out to be the real product. It is the ONE record deliberately NOT deleted
// with its project, so this section deletes its source venture at the end and
// asserts the ideas it produced are still there.
const SPARK_DATE = '2026-09-14'
r = await post({ localDate: PROJ_DATE, tz: TZ, op: 'addProject', payload: {
  name: 'Spark source', fulfills: 'A live venture whose feedback sparks ideas.', ttfdDays: 10,
  effortDays: 5, revenuePerMonth: 9000, confidence: 0.5, status: 'shipped', metricName: 'quotes sent',
} })
const sparkSource = r.parsed.snapshot.projects.find((p) => p.name === 'Spark source')

r = await post({ localDate: PROJ_DATE, tz: TZ, op: 'logCheckin', payload: {
  projectId: sparkSource.id, date: SPARK_DATE, revenue: 1000, verdict: 'fix',
  hurdles: ['Buyers keep asking for the compliance pack'],
  sparks: ['Sell the compliance pack as its own product', 'Offer a paid onboarding sprint'],
} })
let sparkSource2 = r.parsed.snapshot.projects.find((p) => p.id === sparkSource.id)
check('a check-in captures the ideas it sparked', sparkSource2.sparkSummary.total, 2)
check('captured ideas start open', sparkSource2.sparkSummary.open, 2)
check('the ideas are on the board as well as the card', r.parsed.snapshot.sparks.open, 2)
check('an idea is NOT a hurdle: the hurdle stays open', sparkSource2.monitoring.openHurdles.length, 1)

const sparkOne = r.parsed.snapshot.sparks.openSparks.find((s) => s.text === 'Sell the compliance pack as its own product')
const sparkTwo = r.parsed.snapshot.sparks.openSparks.find((s) => s.text === 'Offer a paid onboarding sprint')
check('an idea records where it came from, frozen at capture',
  { source: sparkOne.sourceProjectName, date: sparkOne.sourceDate, own: sparkOne.sourceProjectId === sparkSource.id },
  { source: 'Spark source', date: SPARK_DATE, own: true })

r = await post({ localDate: PROJ_DATE, tz: TZ, op: 'sparkDismiss', payload: { sparkId: sparkTwo.id, reason: 'No capacity for a second offer this quarter' } })
check('a dismissed idea keeps its reason',
  r.parsed.snapshot.sparks.decidedSparks.find((s) => s.id === sparkTwo.id).dismissedReason, 'No capacity for a second offer this quarter')
check('a dismissed idea leaves the open queue', r.parsed.snapshot.sparks.open, 1)
check('a dismissal with no reason is refused',
  (await post({ localDate: PROJ_DATE, tz: TZ, op: 'sparkDismiss', payload: { sparkId: sparkOne.id } })).parsed.code, 'invalid_payload')

// Re-running the same day's check-in replaces the OPEN list only. A decision
// already taken must survive a re-statement of the feedback that produced it.
r = await post({ localDate: PROJ_DATE, tz: TZ, op: 'logCheckin', payload: {
  projectId: sparkSource.id, date: SPARK_DATE,
  sparks: ['Sell the compliance pack as its own product', 'Offer a paid onboarding sprint', 'Bundle the pack with a training day'],
} })
check('a re-run adds only the idea that is new', r.parsed.snapshot.sparks.open, 2)
check('a dismissed idea is NOT resurrected by a re-run',
  r.parsed.snapshot.sparks.decidedSparks.some((s) => s.text === 'Offer a paid onboarding sprint'), true)
check('a still-listed idea keeps its identity across a re-run',
  r.parsed.snapshot.sparks.openSparks.find((s) => s.text === sparkOne.text).id, sparkOne.id)
check('the newly added idea is captured',
  r.parsed.snapshot.sparks.openSparks.some((s) => s.text === 'Bundle the pack with a training day'), true)

// A check-in that says nothing about ideas must leave them alone.
r = await post({ localDate: PROJ_DATE, tz: TZ, op: 'logCheckin', payload: { projectId: sparkSource.id, date: '2026-10-01', revenue: 2000 } })
check('a check-in with no sparks field touches nothing', r.parsed.snapshot.sparks.open, 2)

// Promote: the idea becomes a real candidate, UNRANKED because it has no numbers.
r = await post({ localDate: PROJ_DATE, tz: TZ, op: 'sparkPromote', payload: { sparkId: sparkOne.id } })
const promoted = r.parsed.snapshot.projects.find((p) => p.name === 'Sell the compliance pack as its own product')
check('promoting an idea creates a pending project named after it', promoted !== undefined, true)
check('a promoted idea starts as an idea, in Pending',
  { status: promoted.status, pending: promoted.pending }, { status: 'idea', pending: true })
check('a promoted idea starts UNRANKED, with no invented numbers', promoted.score.unestimated, true)
check('the promotion names the feedback the idea came from', promoted.fulfills, 'Sparked by feedback on Spark source (2026-09-14)')
check('the idea records the project it became',
  r.parsed.snapshot.sparks.decidedSparks.find((s) => s.id === sparkOne.id).promotedProjectId, promoted.id)
check('promoting an already-decided idea is refused',
  (await post({ localDate: PROJ_DATE, tz: TZ, op: 'sparkPromote', payload: { sparkId: sparkOne.id } })).parsed.code, 'invalid_payload')
check('an unknown idea id is refused',
  (await post({ localDate: PROJ_DATE, tz: TZ, op: 'sparkDismiss', payload: { sparkId: 'nope', reason: 'x' } })).parsed.code, 'spark_not_found')

// An idea with no live project behind it is still capturable.
r = await post({ localDate: PROJ_DATE, tz: TZ, op: 'sparkAdd', payload: { text: 'A standalone idea with no source' } })
check('an idea with no source is allowed', r.parsed.snapshot.sparks.open, 2)
check('an unattributed idea records no source rather than guessing',
  r.parsed.snapshot.sparks.openSparks.find((s) => s.text === 'A standalone idea with no source').sourceProjectName, null)
check('a NAMED but unresolvable source is an error, not a silent null',
  (await post({ localDate: PROJ_DATE, tz: TZ, op: 'sparkAdd', payload: { text: 'orphan', project: 'no such venture' } })).parsed.code, 'project_not_found')
check('empty idea text is refused',
  (await post({ localDate: PROJ_DATE, tz: TZ, op: 'sparkAdd', payload: { text: '   ' } })).parsed.code, 'empty_text')

// The triage clock, judged against the CALENDAR BEING SHOWN rather than the host
// clock — the same rule staleness follows. The expected age is computed here
// independently, so this checks the day arithmetic and not just the wiring.
const openRows = [...openDomain.table('sparks').entries()].map(([, s]) => s).filter((s) => s.status === 'open')
const oldestCreated = openRows.map((s) => s.createdAt.slice(0, 10)).sort()[0]
const expectedAge = Math.max(0, Math.round((Date.parse('2027-06-01T00:00:00Z') - Date.parse(oldestCreated + 'T00:00:00Z')) / 86400000))
r = await get('/daily-progress-tab/state?localDate=2027-06-01')
check('the clock counts the days the oldest undecided idea has waited', r.parsed.sparks.oldestOpenDays, expectedAge)
check('an idea nobody has decided on trips the triage clock', r.parsed.sparks.triageDue, true)

// THE ASYMMETRY. Check-ins are children of a project and go with it; sparks are
// leads it produced and stay. A venture that dies of a hurdle is telling you the
// hurdle is the business, so a kill must not delete its best output.
r = await post({ localDate: PROJ_DATE, tz: TZ, op: 'removeProject', payload: { projectId: sparkSource.id } })
check('the source venture is gone', r.parsed.snapshot.projects.some((p) => p.id === sparkSource.id), false)
const survivors = [...openDomain.table('sparks').entries()].map(([, s]) => s)
check('its ideas SURVIVE the deletion of the venture', survivors.length, 4)
check('a surviving idea keeps the frozen name of its dead source',
  survivors.every((s) => s.sourceProjectName === 'Spark source' || s.sourceProjectName === null), true)
check('a surviving idea keeps its decision', survivors.filter((s) => s.status === 'dismissed').length, 1)
check('the project an idea became is still on the board',
  r.parsed.snapshot.projects.some((p) => p.id === promoted.id), true)
check('the triage board still counts every surviving idea', r.parsed.snapshot.sparks.total, 4)

// ------------------------------------------------- choosing what to work on
// The board used to offer only what it had already scheduled. These probes cover
// the three surfaces that make the choice real: a backlog that exists before any
// date is attached, a pool of tasks sitting on other days, and a pick that names
// the ONE task being worked on.
const PICK_DATE = '2026-11-10'
const FUTURE_DATE = '2026-11-13'
const PAST_RECENT = '2026-11-09'
const PAST_OLD = '2026-11-08'

r = await post({ localDate: PICK_DATE, tz: TZ, op: 'addProject', payload: {
  name: 'Pick test', fulfills: 'A project to choose tasks for.', ttfdDays: 7, effortDays: 3,
  revenuePerMonth: 20000, confidence: 0.5,
} })
const pickProject = r.parsed.snapshot.projects.find((p) => p.name === 'Pick test')
check('a new project has an empty backlog', r.parsed.snapshot.backlog, [])

r = await post({ localDate: PICK_DATE, tz: TZ, op: 'addBacklogItem', payload: { projectId: pickProject.id, text: 'first candidate' } })
await new Promise((res) => setTimeout(res, 5))
r = await post({ localDate: PICK_DATE, tz: TZ, op: 'addBacklogItem', payload: { projectId: pickProject.id, text: 'second candidate' } })
check('backlog holds unscheduled candidates', r.parsed.snapshot.backlog.map((b) => b.text), ['first candidate', 'second candidate'])
check('a backlog task carries its project', r.parsed.snapshot.backlog[0].projectId, pickProject.id)
check('a backlog task is on no day at all', r.parsed.snapshot.today === null ? 0 : r.parsed.snapshot.today.items.length, 0)
check('unknown project refused for a candidate',
  (await post({ localDate: PICK_DATE, tz: TZ, op: 'addBacklogItem', payload: { project: 'ghost', text: 'x' } })).parsed.code, 'project_not_found')
check('empty candidate text refused',
  (await post({ localDate: PICK_DATE, tz: TZ, op: 'addBacklogItem', payload: { projectId: pickProject.id, text: '   ' } })).parsed.code, 'empty_text')

// scheduling a candidate turns a possibility into a commitment, atomically
const firstCandidate = r.parsed.snapshot.backlog[0].id
r = await post({ localDate: PICK_DATE, tz: TZ, op: 'planBacklogItem', payload: { backlogItemId: firstCandidate } })
check('scheduling a candidate puts it on today', r.parsed.snapshot.today.items.map((i) => i.text), ['first candidate'])
check('the scheduled task keeps its project link', r.parsed.snapshot.today.items[0].projectId, pickProject.id)
check('scheduling it clears it from the backlog', r.parsed.snapshot.backlog.map((b) => b.text), ['second candidate'])

// the same move by text, and picking it in the same call
r = await post({ localDate: PICK_DATE, tz: TZ, op: 'planBacklogItem', payload: { match: 'second candidate', select: true } })
check('a candidate can be scheduled by text match', r.parsed.snapshot.today.items.map((i) => i.text), ['first candidate', 'second candidate'])
check('select:true also picks it as the task being worked on', r.parsed.snapshot.now.item.text, 'second candidate')
check('the pick records the day the task is on', r.parsed.snapshot.now.date, PICK_DATE)
check('an unknown candidate id is refused',
  (await post({ localDate: PICK_DATE, tz: TZ, op: 'planBacklogItem', payload: { backlogItemId: 'nope' } })).parsed.code, 'item_not_found')

// a backlog candidate is undated, so it is never in the pool
check('a candidate is not in the pool', r.parsed.snapshot.pool.length, 0)

// ---- the pool: undone tasks on other days
await post({ localDate: PICK_DATE, tz: TZ, op: 'addItem', payload: { target: 'today', text: 'future thing' } })
const futureId = (await get('/daily-progress-tab/state?localDate=' + PICK_DATE + '&tz=' + TZ)).parsed.today.items.find((i) => i.text === 'future thing').id
await post({ localDate: PICK_DATE, tz: TZ, op: 'moveItem', payload: { itemId: futureId, toDate: FUTURE_DATE } })

// A past day is written straight into the store: nothing in the API creates a
// plan in the past, and the pool's whole point is that such tasks are visible.
const plans = openDomain.table('plans')
for (const [day, id, text] of [[PAST_OLD, 'past-old', 'missed two days ago'], [PAST_RECENT, 'past-recent', 'missed yesterday']]) {
  await plans.put('default:' + day, {
    date: day, tz: TZ, updatedAt: 'x',
    items: [{ id, text, done: false, doneAt: null, origin: 'today' }],
  })
}
r = await get('/daily-progress-tab/state?localDate=' + PICK_DATE + '&tz=' + TZ)
check('the pool lists tasks from other days', r.parsed.pool.map((p) => p.item.text), ['missed yesterday', 'missed two days ago', 'future thing'])
check('overdue leads, most recent first, then upcoming by date',
  r.parsed.pool.map((p) => p.bucket), ['overdue', 'overdue', 'upcoming'])
check('a pool entry carries the day it sits on', r.parsed.pool[0].date, PAST_RECENT)
check('pool days are shown oldest-last within overdue', r.parsed.pool[2].date, FUTURE_DATE)
check('today is never in its own pool', r.parsed.pool.some((p) => p.date === PICK_DATE), false)
check('a done task leaves the pool', await (async () => {
  await post({ localDate: PICK_DATE, tz: TZ, op: 'toggleItem', payload: { itemId: 'past-old', fromDate: PAST_OLD, done: true } })
  const after = await get('/daily-progress-tab/state?localDate=' + PICK_DATE + '&tz=' + TZ)
  return after.parsed.pool.some((p) => p.item.id === 'past-old')
})(), false)

// ---- pulling something forward from another day
r = await post({ localDate: PICK_DATE, tz: TZ, op: 'moveItem', payload: { itemId: 'past-recent', fromDate: PAST_RECENT, toDate: PICK_DATE } })
check('fromDate moves a task that lives on any day', r.parsed.snapshot.today.items.map((i) => i.text).includes('missed yesterday'), true)
check('the moved task leaves the pool', r.parsed.snapshot.pool.some((p) => p.item.id === 'past-recent'), false)
check('a bad fromDate is refused',
  (await post({ localDate: PICK_DATE, tz: TZ, op: 'moveItem', payload: { itemId: futureId, fromDate: '13-11-2026', toDate: PICK_DATE } })).parsed.code, 'invalid_local_date')
check('moving to the same day is refused',
  (await post({ localDate: PICK_DATE, tz: TZ, op: 'moveItem', payload: { itemId: 'past-recent', fromDate: PICK_DATE, toDate: PICK_DATE } })).parsed.code, 'invalid_payload')

// ---- the pick follows its task
await post({ localDate: PICK_DATE, tz: TZ, op: 'selectItem', payload: { itemId: 'past-recent', date: PICK_DATE } })
r = await get('/daily-progress-tab/state?localDate=' + PICK_DATE + '&tz=' + TZ)
check('a task can be picked as the one being worked on', r.parsed.now.item.id, 'past-recent')
const movedPick = await post({ localDate: PICK_DATE, tz: TZ, op: 'moveItem', payload: { itemId: 'past-recent', toDate: FUTURE_DATE } })
check('the pick follows the task to its new day', movedPick.parsed.snapshot.now.date, FUTURE_DATE)
check('the pick still names the same task', movedPick.parsed.snapshot.now.item.id, 'past-recent')
// and it must not be left dangling by a move that the hint no longer describes
r = await get('/daily-progress-tab/state?localDate=' + PICK_DATE + '&tz=' + TZ)
check('a stale hint is re-resolved, not trusted', r.parsed.now.date, FUTURE_DATE)

r = await post({ localDate: PICK_DATE, tz: TZ, op: 'selectItem', payload: { itemId: null } })
check('the pick can be cleared', r.parsed.snapshot.now, null)
check('an unknown task cannot be picked',
  (await post({ localDate: PICK_DATE, tz: TZ, op: 'selectItem', payload: { itemId: 'ghost-task' } })).parsed.code, 'item_not_found')
check('the selected PROJECT survives a task pick',
  (await post({ localDate: PICK_DATE, tz: TZ, op: 'selectProject', payload: { projectId: pickProject.id } })).parsed.snapshot.selectedProjectId, pickProject.id)
r = await post({ localDate: PICK_DATE, tz: TZ, op: 'selectItem', payload: { itemId: 'past-recent', date: FUTURE_DATE } })
// The global holds two selections now. Writing one must never drop the other —
// `set` replaces the whole record, which is exactly how this would break.
check('picking a task does not clear the project selection', r.parsed.snapshot.selectedProjectId, pickProject.id)
check('and the task pick is still set', r.parsed.snapshot.now.item.id, 'past-recent')

// completing or deleting the picked task must end the pick
r = await post({ localDate: PICK_DATE, tz: TZ, op: 'toggleItem', payload: { itemId: 'past-recent', fromDate: FUTURE_DATE, done: true } })
check('finishing the picked task clears the pick', r.parsed.snapshot.now, null)
check('a done task cannot be picked as the one being worked on',
  (await post({ localDate: PICK_DATE, tz: TZ, op: 'selectItem', payload: { itemId: 'past-recent', date: FUTURE_DATE } })).parsed.code, 'invalid_payload')
await post({ localDate: PICK_DATE, tz: TZ, op: 'toggleItem', payload: { itemId: 'past-recent', fromDate: FUTURE_DATE, done: false } })
r = await post({ localDate: PICK_DATE, tz: TZ, op: 'selectItem', payload: { itemId: 'past-recent', date: FUTURE_DATE } })
check('a reopened task can be picked again', r.parsed.snapshot.now.item.id, 'past-recent')
r = await post({ localDate: PICK_DATE, tz: TZ, op: 'removeItem', payload: { itemId: 'past-recent', fromDate: FUTURE_DATE } })
check('deleting the picked task clears the pick', r.parsed.snapshot.now, null)

// ---- order is the operator's
r = await get('/daily-progress-tab/state?localDate=' + PICK_DATE + '&tz=' + TZ)
const ordered = r.parsed.today.items.map((i) => i.text)
check('two tasks to order', ordered.length >= 2, true)
r = await post({ localDate: PICK_DATE, tz: TZ, op: 'reorderItem', payload: { itemId: r.parsed.today.items[1].id, direction: 'up' } })
check('reorder moves a task up', r.parsed.snapshot.today.items.map((i) => i.text)[0], ordered[1])
r = await post({ localDate: PICK_DATE, tz: TZ, op: 'reorderItem', payload: { itemId: r.parsed.snapshot.today.items[0].id, direction: 'up' } })
check('moving the first task up is a no-op, not an error', r.parsed.ok, true)
check('the no-op left the order alone', r.parsed.snapshot.today.items.map((i) => i.text)[0], ordered[1])
r = await post({ localDate: PICK_DATE, tz: TZ, op: 'reorderItem', payload: { itemId: r.parsed.snapshot.today.items[0].id, direction: 'down' } })
check('reorder moves a task down', r.parsed.snapshot.today.items.map((i) => i.text)[0], ordered[0])
check('an unknown direction is refused',
  (await post({ localDate: PICK_DATE, tz: TZ, op: 'reorderItem', payload: { itemId: r.parsed.snapshot.today.items[0].id, direction: 'sideways' } })).parsed.code, 'invalid_payload')

// a reordered day keeps its new order on the next read, not just in the response
r = await get('/daily-progress-tab/state?localDate=' + PICK_DATE + '&tz=' + TZ)
check('the new order is persisted', r.parsed.today.items.map((i) => i.text)[0], ordered[0])

// ---- deleting a project must take its backlog with it, like its check-ins
await post({ localDate: PICK_DATE, tz: TZ, op: 'addBacklogItem', payload: { projectId: pickProject.id, text: 'orphan candidate' } })
r = await post({ localDate: PICK_DATE, tz: TZ, op: 'removeProject', payload: { projectId: pickProject.id } })
check('removeProject drops its candidates from the board', r.parsed.snapshot.backlog, [])
const orphanBacklog = [...openDomain.table('backlog').entries()].filter(([, b]) => b.projectId === pickProject.id)
check('removeProject leaves no orphaned backlog rows', orphanBacklog.length, 0)

// ------------------------------------------- the plugin portfolio register
// The gate is the point of this feature: a plugin LIST contains other people's
// work, so publishing has to be impossible rather than merely discouraged.
r = await post({ localDate: PROJ_DATE, tz: TZ, op: 'addPlugin', payload: {
  name: 'dsh-cost-bubble', origin: 'ours', visibility: 'showcase', title: 'Cost bubble',
  licence: 'MIT', sourcePath: '~/projects/plugins/dsh-cost-bubble', installed: true,
  hasLicenseFile: true, hasReadme: true, sourceOutsideProfile: true, leakScanPassed: true,
  preflightPassed: true, preflightAt: PROJ_DATE,
  preflightNote: 'leak-scan clean over 6 tracked files; git tree clean at 33058be',
  gitReady: true, verifiedAt: PROJ_DATE,
} })
let folio2 = r.parsed.snapshot.portfolio
check('a plugin is registered', [folio2.counts.total, folio2.counts.authored], [1, 1])
check('nothing is published yet', folio2.counts.published, 0)
// Every fact is recorded except the screenshot, so exactly that one blocks it.
check('a missing screenshot is the one blocker left', folio2.entries[0].blockers.length, 1)
check('so it is not ready', folio2.counts.ready, 0)

r = await post({ localDate: PROJ_DATE, tz: TZ, op: 'updatePlugin', payload: { plugin: 'cost-bubble', hasScreenshot: true } })
folio2 = r.parsed.snapshot.portfolio
check('recording the last fact makes it ready', [folio2.counts.ready, folio2.entries[0].blockers], [1, []])

check('a duplicate name is refused, so the register cannot double-count',
  (await post({ localDate: PROJ_DATE, tz: TZ, op: 'addPlugin', payload: { name: 'dsh-cost-bubble', origin: 'ours' } })).parsed.code, 'invalid_payload')
check('an invented origin is refused',
  (await post({ localDate: PROJ_DATE, tz: TZ, op: 'addPlugin', payload: { name: 'dsh-x', origin: 'borrowed' } })).parsed.code, 'invalid_payload')

// The fail-safe default: nothing becomes publishable by omission.
r = await post({ localDate: PROJ_DATE, tz: TZ, op: 'addPlugin', payload: { name: 'dsh-default-test', origin: 'ours' } })
check('a plugin added without a visibility is INTERNAL',
  r.parsed.snapshot.portfolio.entries.find((e) => e.name === 'dsh-default-test').visibility, 'internal')
check('and therefore not publishable',
  r.parsed.snapshot.portfolio.entries.find((e) => e.name === 'dsh-default-test').publishable, false)

// Someone else's plugin, sitting in the same list.
r = await post({ localDate: PROJ_DATE, tz: TZ, op: 'addPlugin', payload: {
  name: 'dsh-better-sidebar', origin: 'third-party', visibility: 'showcase', licence: 'MIT', installed: true,
} })
folio2 = r.parsed.snapshot.portfolio
check('third-party work is refused by the gate even if marked showcase', 
  folio2.entries.find((e) => e.name === 'dsh-better-sidebar').publishable, false)
check('and the count still says two authored, not three', folio2.counts.authored, 2)
check('the third-party count is separate', folio2.counts.thirdParty, 1)

// A fork: publishable, but only with attribution recorded.
r = await post({ localDate: PROJ_DATE, tz: TZ, op: 'addPlugin', payload: {
  name: 'dsh-daily-progress-tab', origin: 'fork', visibility: 'showcase', licence: 'BSD-3-Clause',
  sourcePath: '~/projects/plugins/dsh-daily-progress-tab',
  hasLicenseFile: true, hasReadme: true, hasScreenshot: true, sourceOutsideProfile: true,
  leakScanPassed: true, preflightPassed: true, preflightAt: PROJ_DATE,
  gitReady: true, verifiedAt: PROJ_DATE,
} })
folio2 = r.parsed.snapshot.portfolio
check('a fork without an upstream is blocked', 
  folio2.entries.find((e) => e.name === 'dsh-daily-progress-tab').blockers.length, 1)
check('and the blocker names the attribution',
  /upstream/.test(folio2.entries.find((e) => e.name === 'dsh-daily-progress-tab').blockers[0]), true)
check('and a blocked plugin is offered NO commands, so the gate cannot be pasted past',
  folio2.entries.find((e) => e.name === 'dsh-daily-progress-tab').commands, '')
r = await post({ localDate: PROJ_DATE, tz: TZ, op: 'updatePlugin', payload: {
  plugin: 'daily-progress-tab', upstream: 'omdsh-dev/dsh-daily-progress@bedbd28',
} })
check('recording the upstream clears it',
  r.parsed.snapshot.portfolio.entries.find((e) => e.name === 'dsh-daily-progress-tab').blockers, [])
check('and only a GREEN gate is handed the commands',
  r.parsed.snapshot.portfolio.entries.find((e) => e.name === 'dsh-daily-progress-tab')
    .commands.includes('git push -u origin main'), true)
check('three authored now counts the fork', r.parsed.snapshot.portfolio.counts.authored, 3)

// Facts expire: a verification older than VERIFY_STALE_DAYS is a blocker, so a
// pass recorded months ago cannot carry a publish decision today.
r = await post({ localDate: PROJ_DATE, tz: TZ, op: 'updatePlugin', payload: { plugin: 'cost-bubble', verifiedAt: '2026-01-01' } })
const staleEntry = r.parsed.snapshot.portfolio.entries.find((e) => e.name === 'dsh-cost-bubble')
check('a stale verification blocks it again', staleEntry.blockers.length, 1)
check('and says to re-verify', /re-verify/.test(staleEntry.blockers[0]), true)
await post({ localDate: PROJ_DATE, tz: TZ, op: 'updatePlugin', payload: { plugin: 'cost-bubble', verifiedAt: PROJ_DATE } })

// Publishing is a recorded state, not a to-do list that never empties.
r = await post({ localDate: PROJ_DATE, tz: TZ, op: 'updatePlugin', payload: {
  plugin: 'cost-bubble', status: 'public', publicUrl: 'https://github.com/example/dsh-cost-bubble', publishedAt: PROJ_DATE,
} })
folio2 = r.parsed.snapshot.portfolio
check('a published plugin is counted as published', folio2.counts.published, 1)
check('and leaves the ready queue', folio2.counts.ready, 1)
check('and blocks on nothing any more',
  folio2.entries.find((e) => e.name === 'dsh-cost-bubble').blockers, [])

// Removal is a register edit and nothing else.
r = await post({ localDate: PROJ_DATE, tz: TZ, op: 'removePlugin', payload: { plugin: 'dsh-default-test' } })
check('removing a row drops the count', r.parsed.snapshot.portfolio.counts.total, 3)
check('an unknown plugin is refused',
  (await post({ localDate: PROJ_DATE, tz: TZ, op: 'removePlugin', payload: { plugin: 'never-heard-of-it' } })).parsed.code, 'plugin_not_found')
check('an ambiguous match is refused',
  (await post({ localDate: PROJ_DATE, tz: TZ, op: 'removePlugin', payload: { plugin: 'dsh-' } })).parsed.code, 'invalid_payload')

// ---------------------------------------------------------------- the public export (HTTP)
// The same export over the wire, in the HTTP store. The two harnesses have separate json
// backends BY DESIGN, so this half sets up its own public record rather than reusing the
// tools one — a lesson this probe learned the hard way.
await post({ localDate: PROJ_DATE, tz: TZ, op: 'updatePlugin', payload: {
  plugin: 'dsh-cost-bubble', status: 'public', publicUrl: 'https://github.com/' + PROBE_OWNER + '/dsh-cost-bubble',
} })
const md = await get('/daily-progress-tab/export/readme?localDate=' + PROJ_DATE + '&tz=' + TZ)
check('the export route serves markdown with the block', [md.status, md.raw.startsWith(EXPORT_BEGIN)], [200, true])
check('and lists the record that is public in THIS store',
  md.raw.includes('https://github.com/' + PROBE_OWNER + '/dsh-cost-bubble'), true)
const routeRegister = (await get('/daily-progress-tab/state?localDate=' + PROJ_DATE + '&tz=' + TZ)).parsed.portfolio.entries
check('and nothing that is not public in this store',
  routeRegister.filter((e) => e.name !== 'dsh-cost-bubble' && md.raw.includes(e.name)).map((e) => e.name), [])
const site = await get('/daily-progress-tab/export/site?localDate=' + PROJ_DATE + '&tz=' + TZ)
check('the site index is a document, not the markdown',
  [site.status, site.raw.startsWith('<!doctype html>'), site.raw.includes(EXPORT_BEGIN)], [200, true, false])
check('a foreign Host cannot read the export either',
  (await get('/daily-progress-tab/export/readme', 'evil.example')).status, 403)

// ---------------------------------------------------------------- durability
check('domain/changed emitted for durable writes', changes.length > 0, true)
const facility2 = new DomainFacility({
  storage: { backend: { get: (name) => (name === 'json' ? new JsonStorageBackend(root) : undefined) } },
  emit: () => {}, logger: { warn: () => {} },
}, { backend: 'json' })
const domain2 = await facility2.open(dailyProgressDomain)
const reopened = domain2.table('plans').get('default:' + RACE_DATE)
check('durability across reopen', reopened && reopened.items.length, N)
// The three pre-flight fields did NOT survive this, and nothing else noticed:
// they were declared on the record type but not in the domain schema, so zod
// stripped them on read while the write's own response looked perfect.
const reopenedPlugin = [...domain2.table('plugins').entries()]
  .map(([, value]) => value).find((value) => value.name === 'dsh-cost-bubble')
check('the plugin register reopens with the pre-flight facts INTACT',
  [reopenedPlugin.preflightPassed, typeof reopenedPlugin.preflightAt, reopenedPlugin.preflightNote.length > 0],
  [true, 'string', true])
await domain2.close()

rmSync(root, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PROBES PASSED' : '\n' + failures + ' PROBE(S) FAILED')
process.exit(failures === 0 ? 0 : 1)
