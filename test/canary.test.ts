import { describe, expect, it } from 'vitest'
import { CanaryTracker } from '../src/canary.ts'

/** A deterministic fake entropy source so tests are reproducible. */
function fakeRandom(bytes: number): Buffer {
  const out = Buffer.alloc(bytes)
  for (let i = 0; i < bytes; i += 1) out[i] = (i * 7 + 3) % 256
  return out
}

describe('registration', () => {
  it('produces an AWS-shaped canary', () => {
    const tracker = new CanaryTracker({ randomBytes: fakeRandom })
    const canary = tracker.register('agent-1')
    expect(canary).toMatch(/^AKIA[0-9A-Z]{16}$/)
  })

  it('is idempotent per scope', () => {
    const tracker = new CanaryTracker({ randomBytes: fakeRandom })
    expect(tracker.register('agent-1')).toBe(tracker.register('agent-1'))
  })

  it('derives distinct canaries for distinct scopes', () => {
    const tracker = new CanaryTracker({ randomBytes: fakeRandom })
    expect(tracker.register('agent-1')).not.toBe(tracker.register('agent-2'))
  })

  it('resolves the canary registered for a scope', () => {
    const tracker = new CanaryTracker({ randomBytes: fakeRandom })
    const canary = tracker.register('agent-1')
    expect(tracker.canaryFor('agent-1')).toBe(canary)
    expect(tracker.canaryFor('agent-unknown')).toBeUndefined()
  })
})

describe('scanning', () => {
  it('reports nothing on text with no canaries', () => {
    const tracker = new CanaryTracker({ randomBytes: fakeRandom })
    tracker.register('agent-1')
    expect(tracker.scan('just a normal sentence', 'agent-1')).toEqual([])
  })

  it('reports nothing before any scope registers', () => {
    const tracker = new CanaryTracker({ randomBytes: fakeRandom })
    expect(tracker.scan('AKIA anything', 'agent-1')).toEqual([])
  })

  it('flags a foreign canary and names its home scope', () => {
    const tracker = new CanaryTracker({ randomBytes: fakeRandom })
    const canary = tracker.register('agent-1')
    tracker.register('agent-2')
    const hits = tracker.scan(`prefix ${canary} suffix`, 'agent-2')
    expect(hits).toHaveLength(1)
    expect(hits[0]!).toMatchObject({ canary, sourceScope: 'agent-1', currentScope: 'agent-2' })
  })

  it('does not treat the current scope own canary as a leak', () => {
    const tracker = new CanaryTracker({ randomBytes: fakeRandom })
    const canary = tracker.register('agent-1')
    expect(tracker.scan(`own ${canary} text`, 'agent-1')).toEqual([])
  })

  it('flags an unscoped pass carrying a foreign canary', () => {
    const tracker = new CanaryTracker({ randomBytes: fakeRandom })
    const canary = tracker.register('agent-1')
    const hits = tracker.scan(canary, undefined)
    expect(hits).toHaveLength(1)
    const hit = hits[0]!
    expect(hit.sourceScope).toBe('agent-1')
    expect(hit.currentScope).toBeUndefined()
  })

  it('reports one hit per distinct foreign canary', () => {
    const tracker = new CanaryTracker({ randomBytes: fakeRandom })
    const first = tracker.register('agent-1')
    const second = tracker.register('agent-2')
    const hits = tracker.scan(`${first} and ${second}`, 'agent-3')
    expect(hits).toHaveLength(2)
    expect(new Set(hits.map((hit) => hit.canary))).toEqual(new Set([first, second]))
  })

  it('counts repeated occurrences of one canary as a single hit', () => {
    const tracker = new CanaryTracker({ randomBytes: fakeRandom })
    const canary = tracker.register('agent-1')
    const hits = tracker.scan(`${canary} ${canary} ${canary}`, 'agent-2')
    expect(hits).toHaveLength(1)
  })
})

describe('stats', () => {
  it('tracks registered canaries and hits', () => {
    const tracker = new CanaryTracker({ randomBytes: fakeRandom })
    tracker.register('agent-1')
    tracker.register('agent-2')
    const canary = tracker.canaryFor('agent-1')!
    tracker.scan(`leak ${canary}`, 'agent-2')
    expect(tracker.stats()).toEqual({ canaries: 2, hits: 1 })
  })
})
