/**
 * Screenshot a page through the Chrome DevTools Protocol, optionally grading the
 * RENDERED DOM first.
 *
 * WHY A DRIVER IS SHIPPED, AND WHY IT IS RAW CDP. This repository's README shows
 * a screenshot and says it was rendered from sample data. That claim is only
 * worth anything if a reader can reproduce it, so the three pieces travel
 * together: `render-ui.mjs` serves the real page, `seed-demo-store.py` fills a
 * demo store through the plugin's own API, and this shoots it.
 *
 * There is no puppeteer or playwright here, so this speaks CDP over the
 * WebSocket global that Node 24 already provides.
 *
 * WHY IT WRITES THE FILE ITSELF. The PNG is written by THIS process from the
 * base64 CDP returns — never by a browser-side `--screenshot` path, which is one
 * sandbox away from reporting success while writing nothing. Take the image from
 * the process that can see the bytes.
 *
 *   node scripts/screenshot.mjs http://127.0.0.1:3098/daily-progress-tab/ui out.png \
 *     --theme dark --full --wait '.pfol-row' --grade scripts/grade-demo.js
 *
 * Both themes matter: the page declares `prefers-color-scheme: light dark`, so a
 * single render silently verifies half its surfaces. The scheme is FORCED with a
 * Blink setting (`--blink-settings=preferredColorScheme`), because a snap
 * Chromium cannot see the host theme and would otherwise follow the OS and differ
 * between two runs minutes apart. Run it twice, once per theme.
 *
 * The Chrome it launches is its own: it is killed on the way out, by process
 * group, so a leftover headless browser cannot keep holding the debugging port —
 * and so nobody has to reach for a `pkill -f` whose pattern matches the shell
 * that runs it.
 */

import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

// ------------------------------------------------------------------- arguments
const argv = process.argv.slice(2)
function flag(name, fallback) {
  const at = argv.indexOf('--' + name)
  return at === -1 ? fallback : (argv[at + 1] ?? fallback)
}
const positional = argv.filter((arg, i) => !arg.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')))
const [URL_TARGET, OUT] = positional
if (!URL_TARGET || !OUT) {
  console.error('usage: node scripts/screenshot.mjs <url> <out.png> [--theme dark|light] [--full]')
  console.error('       [--wait SELECTOR] [--grade FILE] [--scroll SELECTOR] [--settle MS]')
  console.error('       [--width N] [--height N] [--cdp-port N] [--chrome PATH]')
  process.exit(2)
}

const THEME = flag('theme', 'dark')
const FULL_PAGE = argv.includes('--full')
const WAIT_SELECTOR = flag('wait', '')
const GRADE_FILE = flag('grade', '')
const SCROLL_SELECTOR = flag('scroll', '')
const SETTLE = Number(flag('settle', 800))
const WIDTH = Number(flag('width', 1400))
const HEIGHT = Number(flag('height', 900))
const CDP_PORT = Number(flag('cdp-port', 9224))
const CHROME = flag('chrome', process.env.CHROME ?? '/usr/bin/google-chrome')
const GRADE_EXPR = GRADE_FILE ? readFileSync(GRADE_FILE, 'utf8') : ''

if (THEME !== 'dark' && THEME !== 'light') {
  console.error('screenshot: --theme must be dark or light, got ' + THEME)
  process.exit(2)
}

// 0 = dark, 1 = light. A Blink setting, not a GTK theme.
const COLOR_SCHEME = THEME === 'light' ? '1' : '0'
const log = (...parts) => console.log(...parts)

// ------------------------------------------------------------------------ CDP
async function launchChrome() {
  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=/tmp/chrome-cdp-' + CDP_PORT,
    '--window-size=' + WIDTH + ',' + HEIGHT,
    '--blink-settings=preferredColorScheme=' + COLOR_SCHEME,
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    URL_TARGET,
  ]
  const child = spawn(CHROME, args, {
    detached: true,
    stdio: 'ignore',
    // A writable HOME of its own: the snap-confined Chromium writes caches into
    // it and is denied the real one. Named for what it is — a scratch profile —
    // rather than carried over from wherever this driver was first written.
    env: { ...process.env, HOME: '/tmp/chrome-scratch-profile' },
  })
  child.unref()
  process.on('exit', () => { try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ } })
  log('chrome pid ' + child.pid + ' -> ' + URL_TARGET + '  (' + THEME + ')')

  for (let i = 0; i < 60; i++) {
    await sleep(250)
    try {
      const list = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json()
      const page = list.find((target) => target.type === 'page' && target.webSocketDebuggerUrl)
      if (page) return page
    } catch { /* not listening yet */ }
  }
  throw new Error('chrome never exposed a CDP page target')
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  const pending = new Map()
  let nextId = 1
  const ready = new Promise((ok, fail) => {
    ws.addEventListener('open', () => ok())
    ws.addEventListener('error', (event) => fail(new Error('cdp socket error: ' + event.message)))
  })
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) {
      const { ok, fail } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) fail(new Error(JSON.stringify(msg.error)))
      else ok(msg.result)
    }
  })
  const send = (method, params = {}) => new Promise((ok, fail) => {
    const id = nextId++
    pending.set(id, { ok, fail })
    ws.send(JSON.stringify({ id, method, params }))
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); fail(new Error('cdp timeout: ' + method)) }
    }, 20000)
  })
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) {
      throw new Error('evaluate threw: ' + JSON.stringify(result.exceptionDetails.exception?.description ?? result.exceptionDetails))
    }
    return result.result.value
  }
  return { send, evaluate, ready, close: () => ws.close() }
}

/** Wait until `expression` is truthy, or fail loudly with the last value seen. */
async function waitFor(evaluate, expression, ms, label) {
  let last
  for (let waited = 0; waited < ms; waited += 300) {
    last = await evaluate(expression)
    if (last) return last
    await sleep(300)
  }
  throw new Error('timed out waiting for ' + label + '; last value: ' + JSON.stringify(last))
}

async function shoot(send, name) {
  const out = resolve(name)
  mkdirSync(dirname(out), { recursive: true })
  const params = { format: 'png', captureBeyondViewport: FULL_PAGE }
  if (FULL_PAGE) {
    // The whole page at native resolution, rather than a window guessed tall
    // enough: a capture that stops short reports a feature as missing, and a
    // short window hides it below the fold.
    const metrics = await send('Page.getLayoutMetrics')
    const size = metrics.cssContentSize ?? metrics.contentSize
    params.clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 }
    log('  full page: ' + params.clip.width + 'x' + params.clip.height)
  }
  const { data } = await send('Page.captureScreenshot', params)
  writeFileSync(out, Buffer.from(data, 'base64'))
  log('  wrote ' + out)
  return out
}

// ----------------------------------------------------------------------- run
const page = await launchChrome()
const cdp = connect(page.webSocketDebuggerUrl)
await cdp.ready
await cdp.send('Page.enable')
await cdp.send('Runtime.enable')

await waitFor(cdp.evaluate, "document.readyState === 'complete'", 30000, 'the document to load')
if (WAIT_SELECTOR) {
  // The rows on a JS-rendered page arrive from a fetch AFTER the load event, so
  // "the HTML contains the string" proves nothing. Wait for the element.
  await waitFor(cdp.evaluate, 'document.querySelector(' + JSON.stringify(WAIT_SELECTOR) + ') !== null', 30000, WAIT_SELECTOR)
}
await sleep(SETTLE)

if (GRADE_EXPR) {
  const value = await cdp.evaluate(GRADE_EXPR)
  log('\n== grade ==')
  log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

if (SCROLL_SELECTOR) {
  // A #fragment does not survive a JS render, so scroll AFTER the content is in
  // the DOM rather than asking the browser to jump to it at parse time.
  const moved = await cdp.evaluate('(() => {' +
    'const el = document.querySelector(' + JSON.stringify(SCROLL_SELECTOR) + ');' +
    'if (el) el.scrollIntoView({ block: "start" });' +
    'return !!el; })()')
  if (!moved) log('  warning: nothing matched ' + SCROLL_SELECTOR + ' to scroll to')
  await sleep(600)
}

await shoot(cdp.send, OUT)
cdp.close()
process.exit(0)
