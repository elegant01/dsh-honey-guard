import { describe, expect, it } from 'vitest'
import { HoneyEngine } from '../src/honey-engine.ts'

const AWS = 'AKIAIOSFODNN7EXAMPLE'

describe('determinism and isolation', () => {
  it('returns the identical entry for a repeated value in one scope', () => {
    const engine = new HoneyEngine()
    const scope = engine.scope('s1')
    const first = engine.honeyFor(scope, AWS, 'aws_key')
    const second = engine.honeyFor(scope, AWS, 'aws_key')
    expect(second).toBe(first)
  })

  it('is stable across separate lookups on the same scope key', () => {
    const engine = new HoneyEngine()
    const first = engine.honeyFor(engine.scope('s1'), 'secret', 'custom')
    const second = engine.honeyFor(engine.scope('s1'), 'secret', 'custom')
    expect(second.honey).toBe(first.honey)
  })

  it('derives a different fake in a different scope', () => {
    // Without this, an observer comparing two transcripts could tell that both
    // conversations used one credential.
    const engine = new HoneyEngine()
    const first = engine.honeyFor(engine.scope('s1'), 'same', 'custom')
    const second = engine.honeyFor(engine.scope('s2'), 'same', 'custom')
    expect(second.honey).not.toBe(first.honey)
  })

  it('derives different fakes for different values in one scope', () => {
    const engine = new HoneyEngine()
    const scope = engine.scope('s1')
    expect(engine.honeyFor(scope, 'value-a', 'custom').honey).not.toBe(
      engine.honeyFor(scope, 'value-b', 'custom').honey,
    )
  })

  it('keeps the same value distinct across categories', () => {
    // The same text classified two ways wants two different shapes, so the
    // category participates in the byReal index key.
    const engine = new HoneyEngine()
    const scope = engine.scope('s1')
    const aws = engine.honeyFor(scope, 'ambiguous', 'aws_key')
    const custom = engine.honeyFor(scope, 'ambiguous', 'custom')
    expect(custom.honey).not.toBe(aws.honey)
    expect(aws.honey).toMatch(/^AKIA[0-9A-Z]{16}$/)
    expect(custom.honey).toMatch(/^HNY[0-9A-Z]{29}$/)
  })
})

describe('structural validity', () => {
  const engine = new HoneyEngine()
  const scope = engine.scope('s1')

  it('produces an AWS-shaped fake', () => {
    expect(engine.honeyFor(scope, 'r1', 'aws_key').honey).toMatch(/^AKIA[0-9A-Z]{16}$/)
  })

  it('produces an OpenAI-shaped fake', () => {
    expect(engine.honeyFor(scope, 'r2', 'openai_key').honey).toMatch(/^sk-[A-Za-z0-9]{48}$/)
  })

  it('produces a GitHub-token-shaped fake', () => {
    expect(engine.honeyFor(scope, 'r3', 'github_token').honey).toMatch(/^ghp_[A-Za-z0-9]{36}$/)
  })

  it('produces a fine-grained-pat-shaped fake', () => {
    expect(engine.honeyFor(scope, 'r4', 'github_pat').honey).toMatch(/^github_pat_[A-Za-z0-9_]{82}$/)
  })

  it('produces a PEM-shaped fake', () => {
    const honey = engine.honeyFor(scope, 'r5', 'pem').honey
    expect(honey.startsWith('-----BEGIN PRIVATE KEY-----')).toBe(true)
    expect(honey.endsWith('-----END PRIVATE KEY-----')).toBe(true)
    expect(honey.split('\n').length).toBeGreaterThan(2)
  })
})

describe('reverse lookup', () => {
  it('resolves the real value from its fake', () => {
    const engine = new HoneyEngine()
    const scope = engine.scope('s1')
    const entry = engine.honeyFor(scope, AWS, 'aws_key')
    expect(engine.realFor(scope, entry.honey)).toBe(AWS)
  })

  it('returns undefined for a fake that is not ours', () => {
    const engine = new HoneyEngine()
    expect(engine.realFor(engine.scope('s1'), 'AKIANOTOURS000000000')).toBeUndefined()
  })
})

describe('memory bounds', () => {
  it('evicts the oldest pairing past the cap', () => {
    const engine = new HoneyEngine({ maxEntriesPerScope: 2 })
    const scope = engine.scope('s1')
    const first = engine.honeyFor(scope, 'one', 'custom')
    engine.honeyFor(scope, 'two', 'custom')
    engine.honeyFor(scope, 'three', 'custom')

    expect(scope.byReal.size).toBe(2)
    expect(scope.byHoney.size).toBe(2)
    // The evicted pairing must be gone from both directions, or a stale fake
    // could still be restored to a value the guard no longer tracks.
    expect(engine.realFor(scope, first.honey)).toBeUndefined()
  })
})

describe('random format', () => {
  it('still resolves back to the real value', () => {
    const engine = new HoneyEngine({ format: 'random' })
    const scope = engine.scope('s1')
    const entry = engine.honeyFor(scope, AWS, 'aws_key')
    expect(entry.honey).toMatch(/^AKIA[0-9A-Z]{16}$/)
    expect(engine.realFor(scope, entry.honey)).toBe(AWS)
  })
})

describe('stats', () => {
  it('counts activity without exposing values', () => {
    const engine = new HoneyEngine()
    engine.honeyFor(engine.scope('s1'), 'v', 'custom')
    engine.recordSubstitutions(3)
    engine.recordRestorations(1)
    expect(engine.stats()).toEqual({ mapped: 1, substituted: 3, restored: 1, scopes: 1 })
  })
})