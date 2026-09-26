/**
 * HTTP surface. A thin adapter over {@link createPlanner}: it owns transport
 * concerns (routing, body limits, the loopback guard, content types) and
 * delegates every semantic decision to the planner, which the agent tools share.
 *
 *   GET  /daily-progress-tab/ui     → the planner page
 *   GET  /daily-progress-tab/state  → Snapshot
 *   POST /daily-progress-tab/mutate → MutateResult
 *
 * The page is served by this plugin, so it is same-origin with the API and can
 * live in its own browser tab (movable to a second screen) with no harness
 * client bundle anywhere.
 *
 * All routes are loopback-guarded — the same posture as the connection
 * carrier's `/api` fence, cheap for a plugin.
 * @module dsh-daily-progress-tab/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { isValidDateKey } from './calendar.ts'
import { normalizeTz, type Planner } from './planner.ts'
import type { MutateOp } from './types.ts'
import { UI_HTML } from './ui.ts'

/** Mount prefix owned by this plugin (distinct from upstream's `/daily-progress`). */
export const ROUTE_PREFIX = '/daily-progress-tab'

const MAX_BODY_BYTES = 64 * 1024

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, {
    'content-type': type,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}
const sendJson = (res: ServerResponse, status: number, value: unknown): void =>
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(value))
const fail = (res: ServerResponse, status: number, code: string, message: string): void =>
  sendJson(res, status, { ok: false, code, message })

/**
 * Accept only loopback Host authorities.
 *
 * Handles every shape a browser sends: `host:port`, `[v6]:port`, and bare
 * bracketed or unbracketed v6. Upstream stripped brackets before splitting on
 * `:`, which collapsed `[::1]:3080` to the empty string and silently rejected
 * IPv6 loopback — its `'::1'` branch was dead code.
 */
function isLoopbackHost(req: IncomingMessage): boolean {
  const raw = req.headers.host
  if (raw === undefined) return false
  let host: string
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']')
    if (end === -1) return false
    host = raw.slice(1, end)
  } else {
    const first = raw.indexOf(':')
    const last = raw.lastIndexOf(':')
    // Exactly one colon means host:port; several mean a bare v6 literal.
    host = first === -1 || first !== last ? raw : raw.slice(0, first)
  }
  host = host.toLowerCase()
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    total += buf.length
    if (total > MAX_BODY_BYTES) throw new Error('body too large')
    chunks.push(buf)
  }
  if (chunks.length === 0) return undefined
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export interface DailyProgressHandlers {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>
}

/**
 * @param planner - shared domain logic.
 * @param defaultDate - resolves "today" when a request omits `localDate` (agent-originated or curl).
 */
export function createHandlers(planner: Planner, defaultDate: () => string): DailyProgressHandlers {
  return {
    async handle(req, res) {
      if (!isLoopbackHost(req)) return fail(res, 403, 'internal', 'loopback only')
      const url = new URL(req.url ?? '/', 'http://localhost')
      const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname
      try {
        if (req.method === 'GET' && (path === ROUTE_PREFIX || path === ROUTE_PREFIX + '/ui')) {
          return send(res, 200, 'text/html; charset=utf-8', UI_HTML)
        }
        if (req.method === 'GET' && path === ROUTE_PREFIX + '/state') {
          const raw = url.searchParams.get('localDate')
          const date = raw ?? defaultDate()
          if (!isValidDateKey(date)) {
            return fail(res, 400, 'invalid_local_date', 'localDate must be a valid YYYY-MM-DD')
          }
          return sendJson(res, 200, await planner.snapshot(date, normalizeTz(url.searchParams.get('tz'))))
        }
        if (req.method === 'POST' && path === ROUTE_PREFIX + '/mutate') {
          let body: unknown
          try {
            body = await readBody(req)
          } catch {
            return fail(res, 400, 'invalid_payload', 'body must be valid JSON under 64KiB')
          }
          const request = body as { localDate?: unknown; tz?: unknown; op?: unknown; payload?: unknown }
          if (typeof request !== 'object' || request === null) {
            return fail(res, 400, 'invalid_payload', 'body must be a JSON object')
          }
          const date = typeof request.localDate === 'string' ? request.localDate : defaultDate()
          if (!isValidDateKey(date)) {
            return fail(res, 400, 'invalid_local_date', 'localDate must be a valid YYYY-MM-DD')
          }
          const payload = (request.payload ?? {}) as Record<string, unknown>
          const result = await planner.apply(
            request.op as MutateOp,
            date,
            normalizeTz(request.tz),
            payload,
          )
          return result.ok
            ? sendJson(res, 200, result)
            : sendJson(res, result.code === 'item_not_found' || result.code === 'suggestion_not_found' ? 404 : 400, result)
        }
        return fail(res, 404, 'unknown_op', 'no route ' + req.method + ' ' + url.pathname)
      } catch (error) {
        // Log host-side; return a generic message so internal paths and backend
        // text are never handed to the browser.
        console.error('[daily-progress-tab]', error)
        return fail(res, 500, 'internal', 'internal error')
      }
    },
  }
}
