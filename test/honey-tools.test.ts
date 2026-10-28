import { describe, expect, it } from 'vitest'
import { HoneyEngine } from '../src/honey-engine.ts'
import { CanaryTracker } from '../src/canary.ts'
import {
  createHoneyMarkTool,
  createHoneyRestoreTool,
  createHoneyStatsTool,
  registerHoneyTools,
  HONEY_MARK_NAME,
  HONEY_RESTORE_NAME,
  HONEY_STATS_NAME,
} from '../src/honey-tools.ts'
import { createTextRewriter } from '../src/outbound.ts'
import type { ContentBlock, RequestMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'

const AWS = 'AKIA6ZIZMAQ1THGODZNQ'

/** A minimal ToolRunContext shaped like the real `{ agent, signal, deferContext }`. */
function runContext(agent: unknown, deferred: UserMessage[] = []) {
  return {
    agent,
    signal: new AbortController().signal,
    deferContext: (context: UserMessage) => deferred.push(context),
  } as never
}

/** Sanitize one string through the outbound rewriter for a scope. */
function outbound(engine: HoneyEngine, scopeKey: string, text: string): string {
  const report = { hits: {}, total: 0 }
  return createTextRewriter(engine, scopeKey, report)(text)
}

function text(value: string): ContentBlock {
  return { type: 'text', text: value }
}

function userMessage(content: ContentBlock[]): RequestMessage {
  return { id: 'm1' as never, role: 'user', source: { kind: 'user' }, content } as unknown as RequestMessage
}

describe('honey_mark (F11)', () => {
  it('exposes the stable tool name', () => {
    expect(HONEY_MARK_NAME).toBe('honey_mark')
  })

  it('marks a value so later outbound passes swap it for a custom honey token', async () => {
    const engine = new HoneyEngine()
    const agent = { id: 'agent-1' }
    const tool = createHoneyMarkTool({ engine, scopeKeyFor: (a) => (a === agent ? 'agent-1' : undefined) })

    // Before marking, the raw value passes through untouched (no detector matches).
    expect(outbound(engine, 'agent-1', 'leak confidential-internal-token now')).toContain(
      'confidential-internal-token',
    )

    const result = (await tool.execute({ values: ['confidential-internal-token'] }, runContext(agent))) as {
      marked: number
    }
    expect(result.marked).toBe(1)

    // After marking, outbound text carries the honey token.
    expect(outbound(engine, 'agent-1', 'leak confidential-internal-token now')).not.toContain(
      'confidential-internal-token',
    )
  })

  it('marks several values and reports the count', async () => {
    const engine = new HoneyEngine()
    const agent = { id: 'agent-1' }
    const tool = createHoneyMarkTool({ engine, scopeKeyFor: (a) => (a === agent ? 'agent-1' : undefined) })

    const result = (await tool.execute(
      { values: ['token-a', 'token-b', 'token-c'] },
      runContext(agent),
    )) as { marked: number }
    expect(result.marked).toBe(3)

    const rewritten = outbound(engine, 'agent-1', 'token-a token-b token-c')
    expect(rewritten).not.toContain('token-')
  })

  it('does not double-count a repeated value', async () => {
    const engine = new HoneyEngine()
    const agent = { id: 'agent-1' }
    const tool = createHoneyMarkTool({ engine, scopeKeyFor: (a) => (a === agent ? 'agent-1' : undefined) })

    const first = (await tool.execute({ values: ['dup-value', 'dup-value'] }, runContext(agent))) as {
      marked: number
    }
    expect(first.marked).toBe(1)

    const second = (await tool.execute({ values: ['dup-value'] }, runContext(agent))) as { marked: number }
    expect(second.marked).toBe(0)
  })

  it('is per-scope: marking in one agent does not affect another', async () => {
    const engine = new HoneyEngine()
    const agentA = { id: 'agent-a' }
    const agentB = { id: 'agent-b' }
    const tool = createHoneyMarkTool({
      engine,
      scopeKeyFor: (a) => (a === agentA ? 'agent-a' : a === agentB ? 'agent-b' : undefined),
    })

    await tool.execute({ values: ['shared-secret'] }, runContext(agentA))

    expect(outbound(engine, 'agent-a', 'shared-secret')).toMatch(/HNY[0-9A-Z]{29}/)
    expect(outbound(engine, 'agent-b', 'shared-secret')).toBe('shared-secret')
  })

  it('tolerates missing or malformed arguments', async () => {
    const engine = new HoneyEngine()
    const agent = { id: 'agent-1' }
    const tool = createHoneyMarkTool({ engine, scopeKeyFor: () => 'agent-1' })

    expect((await tool.execute(undefined, runContext(agent))) as { marked: number }).toEqual({ marked: 0 })
    expect((await tool.execute({ values: 'not-an-array' }, runContext(agent))) as { marked: number }).toEqual({
      marked: 0,
    })
    expect((await tool.execute({ values: ['ok', 42, '', 0] }, runContext(agent))) as { marked: number }).toEqual({
      marked: 1,
    })
  })

  it('renders a value-free report for the model', () => {
    const engine = new HoneyEngine()
    const tool = createHoneyMarkTool({ engine, scopeKeyFor: () => undefined })
    const blocks = tool.output.render({}, { marked: 2 })
    const rendered = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('')
    expect(rendered).toBe('Marked 2 values as sensitive.')
  })
})

describe('honey_restore', () => {
  function hone(engine: HoneyEngine, scopeKey: string, value: string): string {
    const scope = engine.scope(scopeKey)
    return engine.honeyFor(scope, value, 'custom').honey
  }

  it('exposes the stable tool name', () => {
    expect(HONEY_RESTORE_NAME).toBe('honey_restore')
  })

  it('restores real values and defers them to the transcript, not the model', async () => {
    const engine = new HoneyEngine()
    const agent = { id: 'agent-1' }
    const deferred: UserMessage[] = []
    const tool = createHoneyRestoreTool({ engine, scopeKeyFor: (a) => (a === agent ? 'agent-1' : undefined) })

    const fake = hone(engine, 'agent-1', AWS)
    const result = (await tool.execute({ values: [fake] }, runContext(agent, deferred))) as { restored: number }
    expect(result.restored).toBe(1)

    // The real value is delivered as deferred user context — visible to the user…
    expect(deferred.length).toBe(1)
    const deferredMsg = deferred[0]!
    const content = deferredMsg.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
    expect(content).toContain(AWS)
    expect(deferredMsg.source.kind).toBe('ptc-mode')
  })

  it('does not restore a token that belongs to another scope', async () => {
    const engine = new HoneyEngine()
    const agent = { id: 'agent-1' }
    const deferred: UserMessage[] = []
    const tool = createHoneyRestoreTool({ engine, scopeKeyFor: (a) => (a === agent ? 'agent-1' : undefined) })

    const fake = hone(engine, 'agent-2', AWS)
    const result = (await tool.execute({ values: [fake] }, runContext(agent, deferred))) as { restored: number }
    expect(result.restored).toBe(0)
    expect(deferred.length).toBe(0)
  })

  it('leaves the restored values out of the tool result', async () => {
    const engine = new HoneyEngine()
    const agent = { id: 'agent-1' }
    const tool = createHoneyRestoreTool({ engine, scopeKeyFor: () => 'agent-1' })

    const fake = hone(engine, 'agent-1', AWS)
    const result = (await tool.execute({ values: [fake] }, runContext(agent))) as { restored: number }
    expect(JSON.stringify(result)).not.toContain(AWS)
  })

  it('fires the F10 restoration event with a value-safe payload', async () => {
    const events: unknown[] = []
    const engine = new HoneyEngine({ onRestoration: (p) => events.push(p) })
    const agent = { id: 'agent-1' }
    const tool = createHoneyRestoreTool({ engine, scopeKeyFor: () => 'agent-1' })

    const fake = hone(engine, 'agent-1', AWS)
    await tool.execute({ values: [fake, fake] }, runContext(agent))
    expect(events).toHaveLength(2)
    for (const event of events) {
      expect(JSON.stringify(event)).not.toContain(AWS)
      expect(JSON.stringify(event)).not.toContain(fake)
    }
  })

  it('restores every token in a mixed batch and defers one transcript message', async () => {
    const engine = new HoneyEngine()
    const agent = { id: 'agent-1' }
    const deferred: UserMessage[] = []
    const tool = createHoneyRestoreTool({ engine, scopeKeyFor: () => 'agent-1' })

    const a = hone(engine, 'agent-1', 'value-a')
    const b = hone(engine, 'agent-1', 'value-b')
    const result = (await tool.execute({ values: [a, b, 'not-ours'] }, runContext(agent, deferred))) as {
      restored: number
    }
    expect(result.restored).toBe(2)
    expect(deferred).toHaveLength(1)
    const content = deferred[0]!.content.map((x) => (x.type === 'text' ? x.text : '')).join('')
    expect(content).toContain('value-a')
    expect(content).toContain('value-b')
    expect(content).not.toContain('not-ours')
  })
})

describe('honey_stats', () => {
  it('exposes the stable tool name', () => {
    expect(HONEY_STATS_NAME).toBe('honey_stats')
  })

  it('reports value-free aggregate counters', async () => {
    const engine = new HoneyEngine()
    const canaries = new CanaryTracker()
    const agent = { id: 'agent-1' }
    const mark = createHoneyMarkTool({ engine, scopeKeyFor: () => 'agent-1', canaries })
    const stats = createHoneyStatsTool({ engine, scopeKeyFor: () => 'agent-1', canaries })

    await mark.execute({ values: ['secret-one', 'secret-two'] }, runContext(agent))
    outbound(engine, 'agent-1', 'secret-one appears')

    const result = (await stats.execute({}, runContext(agent))) as {
      mapped: number
      substituted: number
      restored: number
      canaries: number
      canaryHits: number
    }
    expect(result.mapped).toBe(2)
    expect(result.substituted).toBeGreaterThan(0)
    expect(result.restored).toBe(0)
    expect(result.canaries).toBe(0)
    expect(result.canaryHits).toBe(0)
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  it('renders a value-free report for the model', () => {
    const engine = new HoneyEngine()
    const tool = createHoneyStatsTool({ engine, scopeKeyFor: () => undefined })
    const blocks = tool.output.render({}, { mapped: 1, substituted: 2, restored: 3, canaries: 4, canaryHits: 5 })
    const rendered = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('')
    expect(rendered).toContain('Mapped: 1')
    expect(rendered).toContain('Substituted: 2')
    expect(rendered).toContain('Restored: 3')
    expect(rendered).toContain('Canaries armed: 4')
    expect(rendered).toContain('Canary hits: 5')
  })
})

describe('registerHoneyTools', () => {
  it('registers all four tools and disposes them together', () => {
    const registered: Array<{ name: string }> = []
    const ctx = {
      tools: {
        register: (def: { name: string }) => {
          registered.push(def)
          return () => {
            const i = registered.indexOf(def)
            if (i >= 0) registered.splice(i, 1)
          }
        },
      },
    }
    const dispose = registerHoneyTools(ctx as never, {
      engine: new HoneyEngine(),
      scopeKeyFor: () => undefined,
    })
    expect(registered.map((t) => t.name).sort()).toEqual(['honey_log', 'honey_mark', 'honey_restore', 'honey_stats'])

    dispose()
    expect(registered).toHaveLength(0)
  })
})

describe('restore round-trip through the guard pipeline', () => {
  it('re-sanitizes the restored text at the next outbound pass', async () => {
    const engine = new HoneyEngine()
    const agent = { id: 'agent-1' }
    const mark = createHoneyMarkTool({ engine, scopeKeyFor: () => 'agent-1' })
    const restore = createHoneyRestoreTool({ engine, scopeKeyFor: () => 'agent-1' })

    // A value no detector pattern recognizes, so the custom category applies.
    const SECRET = 'confidential-internal-token'
    await mark.execute({ values: [SECRET] }, runContext(agent))
    const fake = outbound(engine, 'agent-1', SECRET)
    expect(fake).toMatch(/HNY[0-9A-Z]{29}/)

    const deferred: UserMessage[] = []
    const result = (await restore.execute({ values: [fake] }, runContext(agent, deferred))) as { restored: number }
    expect(result.restored).toBe(1)
    expect(JSON.stringify(deferred)).toContain(SECRET)

    // The next outbound pass over the deferred transcript text re-sanitizes.
    const deferredText = deferred.map((m) => m.content.map((b) => (b.type === 'text' ? b.text : '')).join('')).join(' ')
    const again = outbound(engine, 'agent-1', deferredText)
    expect(again).not.toContain(SECRET)
    expect(again).toContain(fake)
  })
})

describe('host JSON Schema subset', () => {
  // Mirrors the host registry verbatim (CONSTRAINT_KEYWORDS + ANNOTATION_KEYWORDS
  // in dsh-desktop): anything outside this makes the whole plugin fail to activate.
  const SUPPORTED = new Set([
    'type',
    'oneOf',
    'properties',
    'required',
    'additionalProperties',
    'items',
    'enum',
    'const',
    'description',
    'title',
    'default',
    'examples',
  ])

  function keywordsOf(schema: unknown, into: string[] = []): string[] {
    if (Array.isArray(schema)) {
      for (const entry of schema) keywordsOf(entry, into)
      return into
    }
    if (!schema || typeof schema !== 'object') return into
    for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
      into.push(key)
      if (key === 'properties') {
        // The keys here are property names, not keywords, so walk only the values.
        for (const child of Object.values((value ?? {}) as Record<string, unknown>)) keywordsOf(child, into)
      } else if (key === 'items') {
        keywordsOf(value, into)
      }
      // enum/const carry data, not subschemas.
    }
    return into
  }

  it('uses only supported keywords in every tool parameters/output schema', () => {
    const engine = new HoneyEngine({ seed: 's' } as never)
    const tools = [
      createHoneyMarkTool({ engine, scopeKeyFor: () => 'agent-1' }),
      createHoneyRestoreTool({ engine, scopeKeyFor: () => 'agent-1' }),
      createHoneyStatsTool({ engine, scopeKeyFor: () => 'agent-1' }),
    ]
    for (const tool of tools) {
      const used = [...keywordsOf(tool.parameters), ...keywordsOf((tool.output as { schema: unknown }).schema)]
      expect(used.filter((k) => !SUPPORTED.has(k))).toEqual([])
    }
  })

  it('flags a numeric or array bound as unsupported', () => {
    const offending = {
      type: 'object',
      properties: {
        values: { type: 'array', items: { type: 'string' }, minItems: 1 },
        marked: { type: 'integer', minimum: 0 },
      },
    }
    expect(keywordsOf(offending).filter((k) => !SUPPORTED.has(k))).toEqual(['minItems', 'minimum'])
  })
})
