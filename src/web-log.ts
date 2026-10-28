/**
 * `GET /api/honey-guard/log` — the value-safe log over the host's web server.
 *
 * The settings card (`src/client/`) renders the substitution log in-app; this
 * route is how the renderer reads it. It serves the same JSONL records the
 * `honey_log` tool reads, so the value-safety contract is inherited from
 * `sub-log.ts`: surfaces, category counts and canary ids only.
 *
 * The listener binds loopback, but a loopback bind alone is not a trust
 * boundary — a DNS-rebinding page can reach 127.0.0.1 too. So, like the other
 * local plugin surfaces, the handler additionally requires a loopback Host
 * header and (when present) a loopback Origin.
 *
 * The route is registered through `ctx.inject(['webServer'], …)` so profiles
 * without the web server (headless) simply never mount it.
 *
 * @module dsh-honey-guard/web-log
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
// Type-only import: this package declaration-merges `Context.webServer`.
import type {} from '@deepseek-ai/dsh-host-webserver'
import { HONEY_LOG_DEFAULT_LIMIT, HONEY_LOG_MAX_LIMIT, readSubLogTail } from './honey-log.ts'

/** Where the card fetches the log. */
export const HONEY_LOG_ROUTE = '/api/honey-guard/log'

/** Loopback hostnames a local plugin surface may be addressed by. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** Strip the optional :port from a Host header value, IPv6-bracket aware. */
function hostnameOfHost(host: string): string {
  let hostname = host.trim().toLowerCase()
  if (hostname.startsWith('[')) {
    const end = hostname.indexOf(']')
    return end === -1 ? hostname : hostname.slice(0, end + 1)
  }
  const colon = hostname.lastIndexOf(':')
  if (colon !== -1 && !hostname.slice(0, colon).includes(':') && /^\d+$/.test(hostname.slice(colon + 1))) {
    hostname = hostname.slice(0, colon)
  }
  return hostname
}

/** A DNS-rebinding page sends its own domain in Host; drop those here. */
function hostIsLoopback(host: string | undefined): boolean {
  if (host === undefined || host.trim() === '') return false
  return LOOPBACK_HOSTS.has(hostnameOfHost(host))
}

/** Browser-sent Origins must be loopback; non-browser clients send none. */
function originIsLoopback(origin: string | undefined): boolean {
  if (origin === undefined || origin.trim() === '') return true
  try {
    const { hostname } = new URL(origin)
    return LOOPBACK_HOSTS.has(hostname) || hostname === '::1'
  } catch {
    return false
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

/** What the route needs from the plugin activation. */
export interface HoneyLogRouteDeps {
  /** Where the sink writes; also reported so the card can show it. */
  path: string
  /** Whether the sink is currently on, so the card can explain an empty log. */
  logFileEnabled: boolean
}

/** The response body of `GET /api/honey-guard/log`. */
export interface HoneyLogRouteBody {
  ok: true
  path: string
  logFileEnabled: boolean
  /** Well-formed records in the whole file; 0 when there is no file. */
  total: number
  /** Newest-first records; empty when the file is missing or empty. */
  records: unknown[]
  /** False when the log file does not exist yet. */
  fileExists: boolean
}

function readLimit(req: IncomingMessage): number {
  try {
    const url = new URL(req.url ?? '', 'http://localhost')
    const n = Number(url.searchParams.get('limit'))
    if (!Number.isFinite(n) || n <= 0) return HONEY_LOG_DEFAULT_LIMIT
    return Math.min(HONEY_LOG_MAX_LIMIT, Math.trunc(n))
  } catch {
    return HONEY_LOG_DEFAULT_LIMIT
  }
}

function logHandler(deps: HoneyLogRouteDeps) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!hostIsLoopback(req.headers.host) || !originIsLoopback(req.headers.origin)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    const tail = readSubLogTail(deps.path, readLimit(req))
    const body: HoneyLogRouteBody = {
      ok: true,
      path: deps.path,
      logFileEnabled: deps.logFileEnabled,
      total: tail?.total ?? 0,
      // The file is oldest-first; the card shows a newest-first timeline.
      records: tail === undefined ? [] : [...tail.records].reverse(),
      fileExists: tail !== undefined,
    }
    json(res, 200, body)
  }
}

/**
 * Mount `GET /api/honey-guard/log`. Returns without registering when the
 * profile has no web server service.
 */
export function registerHoneyLogRoute(ctx: Context, deps: HoneyLogRouteDeps): void {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'exact', path: HONEY_LOG_ROUTE, handler: logHandler(deps) }),
      'honey-guard:log-route',
    )
  })
}
