import { describe, expect, it } from 'vitest'
import { HoneyEngine } from '../src/honey-engine.ts'
import { createHoneyMarkTool, HONEY_MARK_NAME } from '../src/honey-mark.ts'
import { createTextRewriter } from '../src/outbound.ts'

/** A minimal ToolRunContext shaped like the real `{ agent, signal, ... }`. */
function runContext(agent: unknown) {
  return { agent, signal: new AbortController().signal } as never
}

/** Sanitize one string through the outbound rewriter for a scope. */
function outbound(engine: HoneyEngine, scopeKey: string, text: string): string {
  const report = { hits: {}, total: 0 }
  return createTextRewriter(engine, scopeKey, report)(text)
}

describe('honey_mark tool (F11)', () => {
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

  it('after marking, outbound text carries the HNY honey token instead', async () => {
    const engine = new HoneyEngine()
    const agent = { id: 'agent-1' }
    const tool = createHoneyMarkTool({ engine, scopeKeyFor: (a) => (a === agent ? 'agent-1' : undefined) })

    await tool.execute({ values: ['confidential-internal-token'] }, runContext(agent))

    const rewritten = outbound(engine, 'agent-1', 'leak confidential-internal-token now')
    expect(rewritten).not.toContain('confidential-internal-token')
    expect(rewritten).toMatch(/HNY[0-9A-Z]{29}/)
    expect(rewritten).toContain('leak')
    expect(rewritten).toContain('now')
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
    // Two identical entries collapse to one mapping.
    expect(first.marked).toBe(1)

    const second = (await tool.execute({ values: ['dup-value'] }, runContext(agent))) as { marked: number }
    // Already mapped: a second explicit mark reports 0, not 1.
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

    // Agent A's outbound text is rewritten…
    expect(outbound(engine, 'agent-a', 'shared-secret')).toMatch(/HNY[0-9A-Z]{29}/)
    // …agent B's is untouched (different scope, no mapping there).
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
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('')
    expect(text).toBe('Marked 2 values as sensitive.')
  })
})
