import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock, RequestMessage } from '@deepseek-ai/dsh-llm'
import { apply, inject, name } from '../src/index.ts'

const AWS = 'AKIAIOSFODNN7EXAMPLE'

/** The listener surface is heterogeneous per event, so the fake stores them loosely. */
type AnyHandler = (...args: any[]) => any

interface LogRecord {
  level: string
  message: string
}

/**
 * The smallest Cordis surface the plugin touches: `ctx.on`, `ctx.provide`,
 * `ctx.emit` and `ctx.logger`. Keeping the fake this thin means a failure
 * points at the plugin, not here.
 */
function createHarness() {
  const handlers = new Map<string, AnyHandler>()
  const logs: LogRecord[] = []
  const provided = new Map<string, unknown>()
  const emitted = new Map<string, unknown[]>()
  const registeredTools: Array<{ name: string }> = []
  const registeredRoutes: Array<{ kind: string; path: string }> = []

  const ctx = {
    on(event: string, handler: AnyHandler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    provide(name: string, value: unknown) {
      provided.set(name, value)
      return () => provided.delete(name)
    },
    emit(event: string, payload: unknown) {
      const list = emitted.get(event) ?? []
      list.push(payload)
      emitted.set(event, list)
    },
    effect(fn: () => unknown, _label?: string) {
      return fn()
    },
    inject(_services: string[], cb: (serviceCtx: unknown) => void) {
      // The fake has every service the plugin asks for, so fire immediately.
      cb(ctx)
    },
    webServer: {
      register(route: { kind: string; path: string }) {
        registeredRoutes.push(route)
        return () => {}
      },
    },
    tools: {
      register(def: { name: string }) {
        registeredTools.push(def)
        return () => {
          const i = registeredTools.indexOf(def)
          if (i >= 0) registeredTools.splice(i, 1)
        }
      },
    },
    logger: {
      info: (message: string) => logs.push({ level: 'info', message }),
      debug: (message: string) => logs.push({ level: 'debug', message }),
      warn: (message: string) => logs.push({ level: 'warn', message }),
      error: (message: string) => logs.push({ level: 'error', message }),
    },
  }

  return { ctx: ctx as unknown as Context, handlers, logs, provided, emitted, registeredTools, registeredRoutes }
}

function text(value: string): ContentBlock {
  return { type: 'text', text: value }
}

function userMessage(content: ContentBlock[]): RequestMessage {
  return { id: 'm1' as never, role: 'user', source: { kind: 'user' }, content } as unknown as RequestMessage
}

function emptyStream() {
  return {
    [Symbol.asyncIterator]: () => ({
      next: async () => ({ done: true as const, value: undefined }),
    }),
  }
}

/** A pre-step payload shaped like the real `{ agent, messages, turn, step, signal }`. */
function preStepPayload(messages: RequestMessage[]) {
  return { agent: { id: 'agent-1' }, messages, turn: 1, step: 1, signal: new AbortController().signal }
}

/** A pre-step payload carrying a specific agent handle, like the real loop. */
function payloadFor(agent: object, messages: RequestMessage[]) {
  return { agent, messages, turn: 1, step: 1, signal: new AbortController().signal }
}

describe('plugin identity', () => {
  it('exposes a stable Cordis name', () => {
    expect(name).toBe('honey-guard')
  })

  it('injects the llm and tools services', () => {
    expect(inject).toContain('llm')
    expect(inject).toContain('tools')
  })
})

describe('registration', () => {
  it('hooks admission, tool results, and the dispatch observation point', () => {
    const { ctx, handlers } = createHarness()
    apply(ctx, {})
    expect(handlers.has('agent/pre-step')).toBe(true)
    expect(handlers.has('tools/post-execute')).toBe(true)
    expect(handlers.has('llm/stream')).toBe(true)
  })

  it('registers the honey tool group when enabled', () => {
    const { ctx, registeredTools } = createHarness()
    apply(ctx, {})
    const names = registeredTools.map((t) => t.name).sort()
    expect(names).toEqual(['honey_log', 'honey_mark', 'honey_restore', 'honey_stats'])
  })

  it('does not register the honey tools when disabled', () => {
    const { ctx, registeredTools } = createHarness()
    apply(ctx, { enabled: false })
    expect(registeredTools.some((t) => t.name.startsWith('honey_'))).toBe(false)
  })

  it('mounts the settings-card log route on the web server', () => {
    const { ctx, registeredRoutes } = createHarness()
    apply(ctx, {})
    expect(registeredRoutes.some((r) => r.kind === 'exact' && r.path === '/api/honey-guard/log')).toBe(true)
  })

  it('publishes a honeyGuard service with the restore surface', () => {
    const { ctx, provided } = createHarness()
    apply(ctx, {})
    const guard = provided.get('honeyGuard') as {
      restoreText?: unknown
      restoreBlocks?: unknown
      restoreMessages?: unknown
      createTextRestorer?: unknown
    }
    expect(guard).toBeDefined()
    expect(typeof guard.restoreText).toBe('function')
    expect(typeof guard.restoreBlocks).toBe('function')
    expect(typeof guard.restoreMessages).toBe('function')
    expect(typeof guard.createTextRestorer).toBe('function')
  })
})

describe('llm/stream observation', () => {
  it('returns exactly what next() returned, unwrapped', () => {
    const { ctx, handlers } = createHarness()
    apply(ctx, {})
    const stream = emptyStream()
    const next = vi.fn(() => stream)
    const result = handlers.get('llm/stream')?.({ provider: 'p', model: 'm', messages: [] }, next)
    expect(result).toBe(stream)
  })

  it('calls next() exactly once — the waterfall chain is not memoized', () => {
    // `cordis` builds `next` as `cbs.shift() ?? inner`, so a second call
    // silently consumes the next listener in the chain.
    const { ctx, handlers } = createHarness()
    apply(ctx, {})
    const next = vi.fn(() => emptyStream())
    handlers.get('llm/stream')?.({ provider: 'p', model: 'm', messages: [] }, next)
    expect(next).toHaveBeenCalledTimes(1)
  })
})

describe('agent/pre-step sanitization', () => {
  it('replaces secrets in the batch the decision admits', async () => {
    const { ctx, handlers } = createHarness()
    apply(ctx, {})
    const admitted = [userMessage([text(`my key is ${AWS}`)])]

    const decision = (await handlers.get('agent/pre-step')?.(preStepPayload(admitted), async () => ({
      kind: 'enter',
      messages: admitted,
    }))) as { kind: string; messages: RequestMessage[] }

    expect(decision.kind).toBe('enter')
    expect(JSON.stringify(decision.messages)).not.toContain(AWS)
  })

  it('returns the untouched decision when nothing matched', async () => {
    const { ctx, handlers } = createHarness()
    apply(ctx, {})
    const admitted = [userMessage([text('nothing sensitive')])]
    const base = { kind: 'enter', messages: admitted }

    const decision = await handlers.get('agent/pre-step')?.(preStepPayload(admitted), async () => base)
    expect(decision).toBe(base)
  })

  it('passes a rejecting decision straight through', async () => {
    const { ctx, handlers } = createHarness()
    apply(ctx, {})
    const base = { kind: 'reject' }
    const decision = await handlers.get('agent/pre-step')?.(preStepPayload([]), async () => base)
    expect(decision).toBe(base)
  })

  it('still delegates to next() when disabled', async () => {
    const { ctx, handlers } = createHarness()
    apply(ctx, { enabled: false })
    const admitted = [userMessage([text(`key ${AWS}`)])]
    const base = { kind: 'enter', messages: admitted }

    const decision = await handlers.get('agent/pre-step')?.(preStepPayload(admitted), async () => base)
    expect(decision).toBe(base)
  })

  it('gives each agent its own mapping scope', async () => {
    const { ctx, handlers } = createHarness()
    apply(ctx, {})
    const handler = handlers.get('agent/pre-step')!

    const run = async (agent: object) => {
      const admitted = [userMessage([text(AWS)])]
      const decision = (await handler(
        { agent, messages: admitted, turn: 1, step: 1, signal: new AbortController().signal },
        async () => ({ kind: 'enter', messages: admitted }),
      )) as { messages: RequestMessage[] }
      return JSON.stringify(decision.messages)
    }

    expect(await run({ id: 'a' })).not.toBe(await run({ id: 'b' }))
  })
})

describe('tools/post-execute sanitization', () => {
  it('replaces secrets in a tool result that would reach the model', async () => {
    const { ctx, handlers } = createHarness()
    apply(ctx, {})
    const result = { content: [text(`env dump: AWS_KEY=${AWS}`)] }

    const decision = (await handlers.get('tools/post-execute')?.(
      { name: 'read_file', agent: { id: 'agent-1' } },
      result,
      async () => ({ kind: 'accept' }),
    )) as { kind: string; content: ContentBlock[] }

    expect(decision.kind).toBe('accept')
    expect(JSON.stringify(decision.content)).not.toContain(AWS)
  })

  it('leaves a value-replacing decision alone', async () => {
    // Supplying `content` next to `value` throws in the registry, and rewriting
    // structured JSON is out of scope.
    const { ctx, handlers } = createHarness()
    apply(ctx, {})
    const base = { kind: 'accept', value: { ok: true } }

    const decision = await handlers.get('tools/post-execute')?.(
      { name: 'read_file', agent: {} },
      { content: [text(AWS)] },
      async () => base,
    )
    expect(decision).toBe(base)
  })

  it('leaves a blocking decision alone', async () => {
    const { ctx, handlers } = createHarness()
    apply(ctx, {})
    const base = { kind: 'block', feedback: [text('denied')] }

    const decision = await handlers.get('tools/post-execute')?.(
      { name: 'read_file', agent: {} },
      { content: [text(AWS)] },
      async () => base,
    )
    expect(decision).toBe(base)
  })
})

describe('logging', () => {
  it('announces activation at info level', () => {
    const { ctx, logs } = createHarness()
    apply(ctx, {})
    expect(logs.some((entry) => entry.message.includes('loaded'))).toBe(true)
  })

  it('stays completely quiet when silenced', () => {
    const { ctx, logs } = createHarness()
    apply(ctx, { logLevel: 'silent' })
    expect(logs).toHaveLength(0)
  })

  it('never logs a real value', async () => {
    const { ctx, handlers, logs } = createHarness()
    apply(ctx, { logLevel: 'debug' })
    const admitted = [userMessage([text(`key ${AWS}`)])]
    await handlers.get('agent/pre-step')?.(preStepPayload(admitted), async () => ({ kind: 'enter', messages: admitted }))

    expect(logs.length).toBeGreaterThan(0)
    expect(JSON.stringify(logs)).not.toContain(AWS)
  })
})

describe('canary trap', () => {

  it('arms a canary for a session on its first admitted batch', async () => {
    const { ctx, handlers, provided } = createHarness()
    apply(ctx, {})
    const admitted = [userMessage([text('hello')])]
    await handlers.get('agent/pre-step')?.(payloadFor({ id: 'agent-1' }, admitted), async () => ({ kind: 'enter', messages: admitted }))

    const guard = provided.get('honeyGuard') as { canaries: { canaryFor: (k: string) => string | undefined } }
    expect(guard.canaries.canaryFor('agent-1')).toMatch(/^AKIA[0-9A-Z]{16}$/)
  })

  it('warns when a foreign canary rides in through user input', async () => {
    const { ctx, handlers, provided, logs } = createHarness()
    apply(ctx, {})
    // First session arms its canary.
    const admitted = [userMessage([text('hello')])]
    await handlers.get('agent/pre-step')?.(payloadFor({ id: 'agent-1' }, admitted), async () => ({ kind: 'enter', messages: admitted }))

    const guard = provided.get('honeyGuard') as { canaries: { canaryFor: (k: string) => string | undefined } }
    const canary = guard.canaries.canaryFor('agent-1')!

    // Second session receives a batch carrying agent-1's canary (context bleed).
    const second = [userMessage([text(`echo: ${canary}`)])]
    await handlers.get('agent/pre-step')?.(payloadFor({ id: 'agent-2' }, second), async () => ({ kind: 'enter', messages: second }))

    expect(logs.some((entry) => entry.level === 'warn' && entry.message.includes('foreign canary') && entry.message.includes('agent-1'))).toBe(true)
  })

  it('warns when a tool result echoes a foreign canary', async () => {
    const { ctx, handlers, provided, logs } = createHarness()
    apply(ctx, {})
    const admitted = [userMessage([text('hello')])]
    await handlers.get('agent/pre-step')?.(payloadFor({ id: 'agent-1' }, admitted), async () => ({ kind: 'enter', messages: admitted }))

    const guard = provided.get('honeyGuard') as { canaries: { canaryFor: (k: string) => string | undefined } }
    const canary = guard.canaries.canaryFor('agent-1')!

    await handlers.get('tools/post-execute')?.(
      { name: 'read_file', agent: { id: 'agent-2' } },
      { content: [text(`config mentions ${canary}`)] },
      async () => ({ kind: 'accept' }),
    )

    expect(logs.some((entry) => entry.level === 'warn' && entry.message.includes('tool read_file') && entry.message.includes('agent-1'))).toBe(true)
  })

  it('does not warn when a session sees its own canary', async () => {
    const { ctx, handlers, provided, logs } = createHarness()
    apply(ctx, {})
    // The SAME agent object across turns, as the real loop reuses the handle.
    const agent = { id: 'agent-1' }
    const admitted = [userMessage([text('hello')])]
    await handlers.get('agent/pre-step')?.(payloadFor(agent, admitted), async () => ({ kind: 'enter', messages: admitted }))

    const guard = provided.get('honeyGuard') as { canaries: { canaryFor: (k: string) => string | undefined } }
    const canary = guard.canaries.canaryFor('agent-1')!

    // Same session, later turn, its own canary shows up in the batch.
    const later = [userMessage([text(`internal ${canary}`)])]
    await handlers.get('agent/pre-step')?.(payloadFor(agent, later), async () => ({ kind: 'enter', messages: later }))

    expect(logs.some((entry) => entry.level === 'warn')).toBe(false)
  })

  it('does not arm or scan when disabled', async () => {
    const { ctx, handlers, provided } = createHarness()
    apply(ctx, { enabled: false })
    const admitted = [userMessage([text('hello')])]
    await handlers.get('agent/pre-step')?.(payloadFor({ id: 'agent-1' }, admitted), async () => ({ kind: 'enter', messages: admitted }))

    const guard = provided.get('honeyGuard') as { canaries?: { canaryFor: (k: string) => string | undefined } }
    expect(guard.canaries?.canaryFor('agent-1')).toBeUndefined()
  })
})

describe('restoration audit event (F10)', () => {
  it('emits a value-safe honey/restored event on explicit restore', async () => {
    const { ctx, handlers, provided, emitted } = createHarness()
    apply(ctx, {})

    // Build a mapping by admitting a message that carries the secret.
    const admitted = [userMessage([text(`key ${AWS}`)])]
    const decision = (await handlers.get('agent/pre-step')?.(
      payloadFor({ id: 'agent-1' }, admitted),
      async () => ({ kind: 'enter', messages: admitted }),
    )) as { messages: RequestMessage[] }

    const guard = provided.get('honeyGuard') as {
      restoreText: (scopeKey: string | undefined, text: string) => string
    }
    // The sanitized text holds the honey token; restore it explicitly.
    const sanitizedText = JSON.stringify(decision.messages)
    const restored = guard.restoreText('agent-1', sanitizedText)

    expect(restored).toContain(AWS)
    const events = emitted.get('honey/restored') ?? []
    expect(events.length).toBeGreaterThan(0)
    // Value-safe: neither the real secret nor the honey token appears.
    const payload = events[0] as { scopeKey?: string; category?: string; restorations?: number }
    expect(payload.scopeKey).toBe('agent-1')
    expect(payload.category).toBe('aws_key')
    expect(payload.restorations).toBeGreaterThan(0)
    expect(JSON.stringify(events)).not.toContain(AWS)
    // The honey token is not literally AWS, so this mainly guards the real value.
    expect(JSON.stringify(events)).not.toContain(sanitizedText)
  })

  it('does not emit when nothing is restored', async () => {
    const { ctx, provided, emitted } = createHarness()
    apply(ctx, {})
    const guard = provided.get('honeyGuard') as { restoreText: (scopeKey: string | undefined, text: string) => string }
    const restored = guard.restoreText('agent-1', 'nothing honey here')
    expect(restored).toBe('nothing honey here')
    expect(emitted.has('honey/restored')).toBe(false)
  })
})