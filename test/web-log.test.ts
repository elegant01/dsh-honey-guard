import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { HONEY_LOG_ROUTE, registerHoneyLogRoute } from '../src/web-log.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'

const dir = join(tmpdir(), `honey-weblog-${process.pid}`)
const target = join(dir, 'substitutions.jsonl')

interface CapturedResponse {
  status: number
  body: unknown
}

/** The smallest cordis surface registerHoneyLogRoute touches. */
function createHarness() {
  const routes: Array<{ kind: string; path: string; handler: (req: unknown, res: unknown) => unknown }> = []
  const ctx = {
    inject(_services: string[], cb: (webCtx: unknown) => void) {
      cb(ctx)
    },
    effect(fn: () => unknown) {
      return fn()
    },
    webServer: {
      register(route: (typeof routes)[number]) {
        routes.push(route)
        return () => {}
      },
    },
  }
  return { ctx: ctx as unknown as Context, routes }
}

function invoke(
  route: { handler: (req: unknown, res: unknown) => unknown },
  request: { method?: string; url?: string; headers?: Record<string, string> },
): CapturedResponse {
  const res: CapturedResponse = { status: 0, body: undefined }
  route.handler(
    { method: 'GET', url: HONEY_LOG_ROUTE, headers: { host: '127.0.0.1:8080' }, ...request } as IncomingMessage,
    {
      writeHead(status: number) {
        res.status = status
      },
      end(payload: string) {
        res.body = JSON.parse(payload)
      },
    } as unknown as ServerResponse,
  )
  return res
}

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('GET /api/honey-guard/log', () => {
  it('registers one exact route via the webServer service', () => {
    const { ctx, routes } = createHarness()
    registerHoneyLogRoute(ctx, { path: target, logFileEnabled: true })
    expect(routes).toHaveLength(1)
    expect(routes[0]?.kind).toBe('exact')
    expect(routes[0]?.path).toBe(HONEY_LOG_ROUTE)
  })

  it('rejects non-GET and non-loopback requests', () => {
    const { ctx, routes } = createHarness()
    registerHoneyLogRoute(ctx, { path: target, logFileEnabled: true })
    const route = routes[0]!

    expect(invoke(route, { method: 'POST' }).status).toBe(405)
    expect(invoke(route, { headers: { host: 'evil.example.com' } }).status).toBe(403)
    expect(invoke(route, { headers: { host: '127.0.0.1:8080', origin: 'https://evil.example.com' } }).status).toBe(403)
    expect(invoke(route, { headers: { host: 'localhost:3000', origin: 'http://localhost:3000' } }).status).toBe(200)
  })

  it('serves newest-first records with file-wide total', () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      target,
      [
        { time: '2026-10-27T01:00:00.000Z', surface: 'activate' },
        { time: '2026-10-28T01:00:00.000Z', surface: 'pre-step', total: 2, hits: { openai_key: 1, custom: 1 } },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
    )
    const { ctx, routes } = createHarness()
    registerHoneyLogRoute(ctx, { path: target, logFileEnabled: true })

    const res = invoke(routes[0]!, {})
    expect(res.status).toBe(200)
    const body = res.body as { total: number; records: Array<{ surface: string }>; fileExists: boolean }
    expect(body.fileExists).toBe(true)
    expect(body.total).toBe(2)
    expect(body.records.map((r) => r.surface)).toEqual(['pre-step', 'activate'])
  })

  it('reports a missing file instead of failing', () => {
    const { ctx, routes } = createHarness()
    registerHoneyLogRoute(ctx, { path: join(dir, 'missing.jsonl'), logFileEnabled: false })
    const res = invoke(routes[0]!, {})
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, fileExists: false, total: 0, records: [], logFileEnabled: false })
  })

  it('honors the limit query parameter', () => {
    const { ctx, routes } = createHarness()
    registerHoneyLogRoute(ctx, { path: target, logFileEnabled: true })
    const res = invoke(routes[0]!, { url: `${HONEY_LOG_ROUTE}?limit=1` })
    const body = res.body as { total: number; records: unknown[] }
    expect(body.records).toHaveLength(1)
    expect(body.total).toBe(2)
  })
})
