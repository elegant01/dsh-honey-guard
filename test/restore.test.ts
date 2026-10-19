import { describe, expect, it } from 'vitest'
import type { ContentBlock, RequestMessage } from '@deepseek-ai/dsh-llm'
import { HoneyEngine } from '../src/honey-engine.ts'
import { sanitizeMessages } from '../src/outbound.ts'
import { createTextRestorer, restoreBlocks, restoreMessages, restoreText } from '../src/restore.ts'

const AWS = 'AKIAIOSFODNN7EXAMPLE'

function text(value: string): ContentBlock {
  return { type: 'text', text: value }
}

function userMessage(content: ContentBlock[]): RequestMessage {
  return { id: 'm1' as never, role: 'user', source: { kind: 'user' }, content } as unknown as RequestMessage
}

/** Sanitize one string so the test holds a real Honey-Token to restore. */
function hone(engine: HoneyEngine, scopeKey: string, value: string, category: 'aws_key' | 'custom'): string {
  const scope = engine.scope(scopeKey)
  return engine.honeyFor(scope, value, category).honey
}

describe('restoreText', () => {
  it('round-trips a single token back to the real value', () => {
    const engine = new HoneyEngine()
    const fake = hone(engine, 's1', AWS, 'aws_key')
    expect(restoreText(engine, 's1', fake)).toBe(AWS)
    expect(restoreText(engine, 's1', `prefix ${fake} suffix`)).toBe(`prefix ${AWS} suffix`)
  })

  it('restores every token in a mixed text', () => {
    const engine = new HoneyEngine()
    const a = hone(engine, 's1', 'value-a', 'custom')
    const b = hone(engine, 's1', 'value-b', 'custom')
    expect(restoreText(engine, 's1', `${a} then ${b}`)).toBe('value-a then value-b')
  })

  it('replaces a longer token before a shorter one so short cannot match inside long', () => {
    // `value-x` and `value` both exist as tokens; a naive shorter-first pass
    // would replace `value` inside `value-x` and leave a stale `-x`.
    const engine = new HoneyEngine()
    const long = hone(engine, 's1', 'value-x', 'custom')
    const short = hone(engine, 's1', 'value', 'custom')
    const restored = restoreText(engine, 's1', `${long} ${short}`)
    expect(restored).toBe('value-x value')
  })

  it('does not restore a token that belongs to another scope', () => {
    const engine = new HoneyEngine()
    const fake = hone(engine, 's1', AWS, 'aws_key')
    // Same engine, different scope: the token is unknown and stays as-is.
    expect(restoreText(engine, 's2', fake)).toBe(fake)
  })

  it('leaves plain text untouched', () => {
    const engine = new HoneyEngine()
    expect(restoreText(engine, 's1', 'nothing to see here')).toBe('nothing to see here')
  })

  it('returns the identical string when nothing changed', () => {
    const engine = new HoneyEngine()
    const input = 'plain text'
    expect(restoreText(engine, 's1', input)).toBe(input)
  })

  it('counts restorations through a bound restorer', () => {
    const engine = new HoneyEngine()
    const fake = hone(engine, 's1', AWS, 'aws_key')
    const report = { restorations: 0 }
    const restorer = createTextRestorer(engine, 's1', report)
    const out = restorer(`${fake} ${fake}`)
    expect(out).toBe(`${AWS} ${AWS}`)
    expect(report.restorations).toBe(2)
    expect(engine.stats().restored).toBe(2)
  })

  it('fires the value-safe restoration callback (F10) per token', () => {
    const events: Array<{ scopeKey: string | undefined; category: string; restorations: number }> = []
    const engine = new HoneyEngine({
      onRestoration: (payload) => events.push(payload as never),
    })
    const fake = hone(engine, 's1', AWS, 'aws_key')
    restoreText(engine, 's1', `${fake} ${fake}`)

    expect(events).toHaveLength(2)
    for (const event of events) {
      expect(event.scopeKey).toBe('s1')
      expect(event.category).toBe('aws_key')
      expect(event.restorations).toBe(1)
    }
  })

  it('callback payload never carries the real or honey value', () => {
    const seen: unknown[] = []
    const engine = new HoneyEngine({
      onRestoration: (payload) => seen.push(payload),
    })
    const fake = hone(engine, 's1', AWS, 'aws_key')
    restoreText(engine, 's1', fake)
    expect(JSON.stringify(seen)).not.toContain(AWS)
    expect(JSON.stringify(seen)).not.toContain(fake)
  })
})

describe('restoreMessages / restoreBlocks', () => {
  it('round-trips a message batch through sanitize then restore', () => {
    const engine = new HoneyEngine()
    const original = [userMessage([text(`key ${AWS}`)])]

    const sanitized = sanitizeMessages(original, engine, 's1').messages
    expect(JSON.stringify(sanitized)).not.toContain(AWS)

    const { messages, report } = restoreMessages(sanitized, engine, 's1')
    expect(report.restorations).toBe(1)
    expect(JSON.stringify(messages)).toContain(AWS)
  })

  it('restores reasoning and tool-call argument text too', () => {
    const engine = new HoneyEngine()
    const fake = hone(engine, 's1', AWS, 'aws_key')
    const blocks: ContentBlock[] = [
      { type: 'reasoning', text: `maybe ${fake}` },
      { type: 'tool-call', id: 'c' as never, name: 'n', arguments: JSON.stringify({ token: fake }) },
    ]
    const { blocks: out } = restoreBlocks(blocks, engine, 's1')
    const serialized = JSON.stringify(out)
    expect(serialized).toContain(AWS)
    expect(serialized).not.toContain(fake)
  })

  it('preserves identity when nothing changed', () => {
    const engine = new HoneyEngine()
    const input = [text('clean')]
    expect(restoreBlocks(input, engine, 's1').blocks).toBe(input)
  })
})