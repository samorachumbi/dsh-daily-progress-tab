/**
 * Render harness: serve the REAL planner page on a bare node http server, so a
 * UI change can be verified by rendering it when no DSH instance is running.
 *
 * Why this exists: verifying a visual change means rendering the page and
 * measuring the pixels (see `build-loop` rule 1 and [[screenshotting-a-js-rendered-page]]).
 * That normally means a scratch DSH instance — but a scratch instance is a whole
 * profile composition, and it does not survive a reboot. For a change that is
 * purely presentational nothing about the DSH host matters: what has to be real
 * is the PAGE and the DATA.
 *
 * So this mounts the same three real pieces the plugin itself uses —
 * `createHandlers` (routes.ts) over `createPlanner` (planner.ts) over the real
 * json store — and stubs only the host's route registration. The page, the API
 * shape, the snapshot and the CSS are all the shipped ones.
 *
 * It is a VERIFICATION TOOL, not a way to run the planner: it has no session, no
 * agent tools and no harness. Installed use still belongs in a real profile.
 *
 *   node scripts/render-ui.mjs                 # port 3099, store /tmp/dpt-boot/storages
 *   PORT=3100 STORE_DIR=~/.dsh/storages node scripts/render-ui.mjs
 *
 * Then screenshot it — in BOTH themes, because the page declares
 * `prefers-color-scheme: light dark` and a single render silently verifies half
 * its surfaces (bug D11).
 * @module dsh-daily-progress-tab/scripts/render-ui
 */

import { createServer } from 'node:http'
import { homedir } from 'node:os'

const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json')
const { DomainFacility } = await import('@deepseek-ai/dsh-storage-domain')
const { dailyProgressDomain } = await import('../lib/domain.js')
const { createPlanner } = await import('../lib/planner.js')
const { createHandlers } = await import('../lib/routes.js')

const storeDir = (process.env.STORE_DIR ?? '/tmp/dpt-boot/storages').replace(/^~/, homedir())
const port = Number(process.env.PORT ?? 3099)
const tzLabel = process.env.TZ_LABEL ?? 'Africa/Nairobi'

/** The harness has no browser, so it resolves "today" from one configured zone. */
const dateKey = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: tzLabel, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date())

const facility = new DomainFacility({
  storage: { backend: { get: (name) => (name === 'json' ? new JsonStorageBackend(storeDir) : undefined) } },
  emit: () => {},
  logger: { warn: (message) => console.warn('[domain]', message) },
}, { backend: 'json' })

const domain = await facility.open(dailyProgressDomain)
const handlers = createHandlers(createPlanner(Promise.resolve(domain)), dateKey)

const server = createServer((req, res) => {
  Promise.resolve(handlers.handle(req, res)).catch((error) => {
    // A route failure must be visible in the response, never a silent hang.
    console.error('[render-ui] handler failed:', error)
    try {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('harness error')
    } catch { /* headers already sent */ }
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log('render harness  http://127.0.0.1:' + port + '/daily-progress-tab/ui')
  console.log('store           ' + storeDir)
  console.log('today (' + tzLabel + ')  ' + dateKey())
})
