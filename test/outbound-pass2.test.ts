import { describe, expect, it } from 'vitest'
import { HoneyEngine } from '../src/honey-engine.ts'
import { createTextRewriter } from '../src/outbound.ts'

/** Build the outbound rewriter for one scope with a fresh report. */
function rewriter(engine: HoneyEngine, scopeKey: string) {
  const report = { hits: {} as Record<string, number>, total: 0 }
  const rewrite = createTextRewriter(engine, scopeKey, report)
  return { rewrite, report }
}

/** Mark a value manually (like `honey_mark`) and return its honey token. */
function mark(engine: HoneyEngine, scopeKey: string, value: string): string {
  const scope = engine.scope(scopeKey)
  return engine.honeyFor(scope, value, 'custom').honey
}

describe('outbound pass 2 (byReal sweep for manual marks)', () => {
  it('replaces a manually marked value that no detector pattern matches', () => {
    const engine = new HoneyEngine()
    const { rewrite, report } = rewriter(engine, 's1')
    mark(engine, 's1', 'confidential-internal-token')

    const out = rewrite('leak confidential-internal-token now')
    expect(out).not.toContain('confidential-internal-token')
    expect(out).toMatch(/HNY[0-9A-Z]{29}/)
    expect(report.total).toBe(1)
    expect(report.hits.custom).toBe(1)
  })

  it('replaces every occurrence of a marked value, not just the first', () => {
    const engine = new HoneyEngine()
    const { rewrite, report } = rewriter(engine, 's1')
    mark(engine, 's1', 'token-x')

    const out = rewrite('token-x and again token-x and token-x')
    expect(out).not.toContain('token-x')
    expect(report.total).toBe(3)
  })

  it('keeps surrounding text intact', () => {
    const engine = new HoneyEngine()
    const { rewrite } = rewriter(engine, 's1')
    mark(engine, 's1', 'secret')

    const out = rewrite('before [secret] after')
    expect(out).toContain('before [')
    expect(out).toContain('] after')
    expect(out).not.toContain('secret')
  })

  it('prefers the longer marked value when a shorter one is its prefix', () => {
    // Marking both `value` and `value-x`: the longer real must win inside
    // `value-x`; the shorter must still match standalone occurrences.
    const engine = new HoneyEngine()
    const { rewrite } = rewriter(engine, 's1')
    const longHoney = mark(engine, 's1', 'value-x')
    const shortHoney = mark(engine, 's1', 'value')

    const out = rewrite('value-x value')
    // The long occurrence is replaced whole (no stale `-x`), the short one
    // separately — exactly like the detector long-first rule.
    expect(out).toContain(longHoney)
    expect(out).toContain(shortHoney)
    expect(out).not.toContain('value')
    expect(out).not.toContain('-x')
  })

  it('does not double-replace a value the detector already handled', () => {
    // `AKIA...` is detector-recognized (aws_key) AND manually marked (custom).
    // Pass 1 rewrites it via the detector; pass 2 must not re-count it.
    const engine = new HoneyEngine()
    const { rewrite, report } = rewriter(engine, 's1')
    const aws = 'AKIA6ZIZMAQ1THGODZNQ'
    const scope = engine.scope('s1')
    engine.honeyFor(scope, aws, 'custom') // manual mark, custom category

    const out = rewrite(`key ${aws}`)
    expect(out).not.toContain(aws)
    expect(report.hits.aws_key).toBe(1)
    expect(report.hits.custom).toBeUndefined() // pass 2 must not re-hit
    expect(report.total).toBe(1)
  })

  it('leaves a value untouched when it is marked in another scope only', () => {
    const engine = new HoneyEngine()
    const { rewrite } = rewriter(engine, 's1')
    mark(engine, 's2', 'other-scope-secret')

    expect(rewrite('other-scope-secret')).toBe('other-scope-secret')
  })

  it('replaces a marked value inside JSON tool-call arguments', () => {
    const engine = new HoneyEngine()
    const { rewrite, report } = rewriter(engine, 's1')
    mark(engine, 's1', 'internal-secret')
    const args = JSON.stringify({ token: 'internal-secret', extra: 1 })

    const out = rewrite(args)
    expect(out).not.toContain('internal-secret')
    expect(() => JSON.parse(out)).not.toThrow()
    expect(report.total).toBe(1)
  })

  it('handles a marked value equal to the whole text', () => {
    const engine = new HoneyEngine()
    const { rewrite } = rewriter(engine, 's1')
    const honey = mark(engine, 's1', 'only-this')

    const out = rewrite('only-this')
    expect(out).toBe(honey)
  })

  it('returns the identical string when no entry and no detection match', () => {
    const engine = new HoneyEngine()
    const { rewrite } = rewriter(engine, 's1')
    const input = 'plain text'
    expect(rewrite(input)).toBe(input)
  })

  it('handles empty and whitespace-only input', () => {
    const engine = new HoneyEngine()
    const { rewrite } = rewriter(engine, 's1')
    mark(engine, 's1', 'x')
    expect(rewrite('')).toBe('')
    expect(rewrite('   ')).toBe('   ')
  })

  it('replaces a marked value that appears at string boundaries', () => {
    const engine = new HoneyEngine()
    const { rewrite } = rewriter(engine, 's1')
    mark(engine, 's1', 'boundary-secret')

    expect(rewrite('boundary-secret')).not.toContain('boundary-secret')
    expect(rewrite(' start boundary-secret')).not.toContain('boundary-secret')
    expect(rewrite('boundary-secret end ')).not.toContain('boundary-secret')
    expect(rewrite('a boundary-secret b')).not.toContain('boundary-secret')
  })

  it('replaces overlapping occurrences left-to-right without index drift', () => {
    // Three copies with no separator: each replacement must advance past the
    // honey token just inserted so the next copy is found, not re-scanned inside.
    const engine = new HoneyEngine()
    const { rewrite } = rewriter(engine, 's1')
    mark(engine, 's1', 'dup')

    const out = rewrite('dupdupdup')
    expect(out).not.toContain('dup')
    // Three replacements → the string grows by 3×(honey.length − 3).
    const honey = mark(engine, 's1', 'dup')
    expect(out.length).toBe(honey.length * 3)
  })

  it('falls back to pass 2 even when the text is detector-clean', () => {
    // Detector-clean text with no marked entries returns identity (covered
    // above); here the text is detector-clean but a marked value is present —
    // pass 2 must still run.
    const engine = new HoneyEngine()
    const { rewrite, report } = rewriter(engine, 's1')
    mark(engine, 's1', 'clean-but-marked')

    const out = rewrite('clean-but-marked here')
    expect(out).not.toContain('clean-but-marked')
    expect(report.total).toBe(1)
  })

  it('does not corrupt when a marked value contains regex metacharacters', () => {
    // `$`, `.`, `*` are literal in the sweep (indexOf, not regex), so they must
    // match exactly.
    const engine = new HoneyEngine()
    const { rewrite } = rewriter(engine, 's1')
    mark(engine, 's1', 'a.b*c$')

    const out = rewrite('x a.b*c$ y')
    expect(out).not.toContain('a.b*c$')
    expect(out).toContain('x ')
    expect(out).toContain(' y')
  })

  it('does not let a short marked value match inside a pass-1 honey token', () => {
    // Real corruption case: pass 1 substitutes the detector value X with its
    // honey token H. A user then marks a value that is a PREFIX of H. Pass 2
    // sweeps byReal and would rewrite that prefix INSIDE H, corrupting the
    // mapping. The sweep must skip text that pass 1 just produced.
    const engine = new HoneyEngine()
    const { rewrite } = rewriter(engine, 's1')

    // X is a custom value whose honey token H we capture…
    const X = 'confidential-internal-token'
    const H = mark(engine, 's1', X)
    expect(H).toMatch(/^HNY[0-9A-Z]{29}$/)

    // …and the user then marks H's 6-char prefix as sensitive too.
    const prefix = H.slice(0, 6)
    mark(engine, 's1', prefix)

    // Pass 1 turns X into H. Pass 2 must not rewrite `prefix` inside H.
    const out = rewrite(`secret is ${X}`)
    expect(out).not.toContain(X)
    expect(out).toContain(`secret is ${H}`)
  })

  it('replaces interleaved detector hits and manual marks in position order', () => {
    // The detector hit sits AFTER the manual mark in the text. The interval
    // list therefore mixes both groups; the cursor pass must emit in text order
    // regardless of collection order.
    const engine = new HoneyEngine()
    const { rewrite, report } = rewriter(engine, 's1')
    mark(engine, 's1', 'manual-secret')

    const aws = 'AKIA6ZIZMAQ1THGODZNQ'
    const out = rewrite(`manual-secret then ${aws} then manual-secret`)

    expect(out).not.toContain('manual-secret')
    expect(out).not.toContain(aws)
    expect(report.total).toBe(3)
    // Order preserved: the fake for the manual mark comes first, then AKIA.
    const firstFake = out.slice(0, out.indexOf(' then '))
    expect(firstFake).toMatch(/^HNY[0-9A-Z]{29}$/)
    expect(out).toContain('then ')
  })
})
