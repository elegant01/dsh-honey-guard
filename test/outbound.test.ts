import { describe, expect, it } from 'vitest'
import type { ContentBlock, RequestMessage } from '@deepseek-ai/dsh-llm'
import { HoneyEngine } from '../src/honey-engine.ts'
import { sanitizeBlocks, sanitizeMessages } from '../src/outbound.ts'

const AWS = 'AKIAIOSFODNN7EXAMPLE'

function text(value: string): ContentBlock {
  return { type: 'text', text: value }
}

function reasoning(value: string): ContentBlock {
  return { type: 'reasoning', text: value }
}

function toolCall(args: string): ContentBlock {
  return { type: 'tool-call', id: 'call-1' as never, name: 'read_file', arguments: args }
}

function image(): ContentBlock {
  return { type: 'image', attachment: {} as never }
}

function userMessage(content: ContentBlock[]): RequestMessage {
  return { id: 'm1' as never, role: 'user', source: { kind: 'user' }, content } as unknown as RequestMessage
}

/** The messages array is element-typed; the tests need the raw content list. */
function contentOf(messages: readonly RequestMessage[]): ContentBlock[] {
  return (messages[0] as unknown as { content: ContentBlock[] }).content
}

describe('sanitizeMessages', () => {
  it('replaces a secret in a text block and reports it', () => {
    const engine = new HoneyEngine()
    const { messages, report } = sanitizeMessages([userMessage([text(`key ${AWS}`)])], engine, 's1')

    expect(report.total).toBe(1)
    expect(report.hits.aws_key).toBe(1)
    expect(JSON.stringify(messages)).not.toContain(AWS)
    expect(JSON.stringify(messages)).toContain('AKIA')
  })

  it('replaces inside a reasoning block', () => {
    // Thinking blocks are sent back on later turns, so they leak just as well.
    const engine = new HoneyEngine()
    const { messages, report } = sanitizeMessages([userMessage([reasoning(`maybe ${AWS}?`)])], engine, 's1')

    expect(report.total).toBe(1)
    expect(JSON.stringify(messages)).not.toContain(AWS)
  })

  it('replaces inside tool-call arguments', () => {
    const engine = new HoneyEngine()
    const args = JSON.stringify({ apiKey: AWS })
    const { messages, report } = sanitizeMessages([userMessage([toolCall(args)])], engine, 's1')

    expect(report.total).toBe(1)
    expect(JSON.stringify(messages)).not.toContain(AWS)
    // The replacement is still valid JSON, so the tool call stays parseable.
    const rewritten = contentOf(messages)[0] as { arguments: string }
    expect(() => JSON.parse(rewritten.arguments)).not.toThrow()
  })

  it('leaves non-text blocks untouched', () => {
    const engine = new HoneyEngine()
    const block = image()
    const { messages } = sanitizeMessages([userMessage([block])], engine, 's1')
    expect(contentOf(messages)[0]).toBe(block)
  })

  it('returns the original array when nothing matched', () => {
    // Callers compare identity to decide whether the request changed.
    const engine = new HoneyEngine()
    const input = [userMessage([text('nothing sensitive here')])]
    const { messages, report } = sanitizeMessages(input, engine, 's1')
    expect(messages).toBe(input)
    expect(report.total).toBe(0)
  })

  it('maps the same secret to the same fake across calls in one scope', () => {
    const engine = new HoneyEngine()
    const first = sanitizeMessages([userMessage([text(AWS)])], engine, 's1')
    const second = sanitizeMessages([userMessage([text(AWS)])], engine, 's1')
    expect(JSON.stringify(second.messages)).toBe(JSON.stringify(first.messages))
  })

  it('maps the same secret differently in another scope', () => {
    const engine = new HoneyEngine()
    const first = sanitizeMessages([userMessage([text(AWS)])], engine, 's1')
    const second = sanitizeMessages([userMessage([text(AWS)])], engine, 's2')
    expect(JSON.stringify(second.messages)).not.toBe(JSON.stringify(first.messages))
  })

  it('rewrites several blocks in one pass and counts each', () => {
    const engine = new HoneyEngine()
    const { report } = sanitizeMessages([userMessage([text(AWS), reasoning(AWS), text(AWS)])], engine, 's1')
    expect(report.total).toBe(3)
    expect(report.hits.aws_key).toBe(3)
  })
})

describe('sanitizeBlocks', () => {
  it('replaces secrets and preserves identity when nothing matched', () => {
    const engine = new HoneyEngine()
    const clean = [text('plain')]
    expect(sanitizeBlocks(clean, engine, 's1').blocks).toBe(clean)

    const dirty = [text(`token ${AWS}`)]
    expect(JSON.stringify(sanitizeBlocks(dirty, engine, 's1').blocks)).not.toContain(AWS)
  })
})