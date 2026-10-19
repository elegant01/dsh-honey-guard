/**
 * Canary Trap (F7): a "dead" honey token per session that must never appear on
 * the wire, plus a scan that flags it when it does.
 *
 * ## Why a canary is not a mapping entry
 *
 * Every entry in a scope's `byHoney` table is a *live* fake: it is what the
 * guard substitutes outbound, so it legitimately appears in the request. A
 * canary is the opposite — it is registered in memory but deliberately never
 * produced by {@link HoneyEngine.honeyFor}. Nothing normal writes it to a
 * request, so if the outbound scan ever sees it, something is off:
 *
 *   - the model remembered a honey token from an earlier turn and echoed it
 *     back, proving the transcript round-trips fakes (expected) but also that
 *     it may carry them into a context the guard no longer owns;
 *   - a different session's honey value leaked across the model context (the
 *     per-scope salt makes cross-session fakes distinct, so a foreign canary is
 *     detectable by construction);
 *   - another plugin injected text containing a value that collides with a
 *     canary (astronomically unlikely, but a cheap alarm).
 *
 * The canary is registered lazily on a scope's first outbound pass and lives
 * for the process lifetime, exactly like the mapping table.
 *
 * @module dsh-honey-guard/canary
 */

import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto'

/** Alphabet for AWS-style canary ids: uppercase plus digits. */
const UPPER_ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

/** Stretch a seed into `length` pseudo-random bytes (deterministic stream). */
function expand(seed: string, length: number): Buffer {
  const blocks: Buffer[] = []
  let produced = 0
  for (let counter = 0; produced < length; counter += 1) {
    blocks.push(createHash('sha256').update(`${seed}#${counter}`).digest())
    produced += 32
  }
  return Buffer.concat(blocks).subarray(0, length)
}

/** Map bytes onto an alphabet. */
function toAlphabet(bytes: Buffer, alphabet: string): string {
  let out = ''
  for (const byte of bytes) out += alphabet.charAt(byte % alphabet.length)
  return out
}

/** One foreign-canary hit found by a scan. */
export interface CanaryHit {
  /** The canary token that appeared. */
  canary: string
  /** The scope that registered it (its "home" session). */
  sourceScope: string
  /** The scope whose outbound text carried it. */
  currentScope: string | undefined
}

export interface CanaryTrackerOptions {
  /** Injected entropy source; deterministic tests override it. */
  randomBytes?: (size: number) => Buffer
}

/**
 * Owns the canary registry for the process lifetime.
 *
 * One instance is created per plugin activation and shared with the engine
 * instance. Registering is idempotent per scope; scanning is O(text × canaries)
 * and canaries are bounded by scope count, which is small.
 */
export class CanaryTracker {
  private readonly byScope = new Map<string, string>()
  private readonly byCanary = new Map<string, string>()
  private readonly randomBytes: (size: number) => Buffer
  private hits = 0

  constructor(options: CanaryTrackerOptions = {}) {
    this.randomBytes = options.randomBytes ?? nodeRandomBytes
  }

  /**
   * Return the scope's canary, registering it on first sight.
   *
   * The token is `AKIA` plus 16 uppercase-alphanumeric chars derived from the
   * scope key and fresh entropy — structurally indistinguishable from a real
   * AWS key, and unique per scope because the seed mixes the scope key.
   */
  register(scopeKey: string): string {
    const existing = this.byScope.get(scopeKey)
    if (existing !== undefined) return existing
    const seed = `${scopeKey}:canary:${this.randomBytes(24).toString('hex')}`
    const canary = `AKIA${toAlphabet(expand(seed, 16), UPPER_ALNUM)}`
    this.byScope.set(scopeKey, canary)
    this.byCanary.set(canary, scopeKey)
    return canary
  }

  /** The canary registered for a scope, if any. */
  canaryFor(scopeKey: string): string | undefined {
    return this.byScope.get(scopeKey)
  }

  /**
   * Scan text for any registered canary.
   *
   * The current scope's own canary is excluded from hits: seeing your own
   * canary in your own request is the expected trap being armed, not a leak.
   * A canary registered by *another* scope is always a hit — cross-session
   * fakes are distinct, so its presence here means context bleed.
   *
   * @returns one hit per distinct foreign canary found.
   */
  scan(text: string, currentScope: string | undefined): CanaryHit[] {
    if (text.length === 0 || this.byCanary.size === 0) return []
    const hits: CanaryHit[] = []
    for (const [canary, sourceScope] of this.byCanary) {
      if (sourceScope === currentScope) continue
      if (text.includes(canary)) {
        hits.push({ canary, sourceScope, currentScope })
        this.hits += 1
      }
    }
    return hits
  }

  /** Aggregate counter safe to log. */
  stats(): { canaries: number; hits: number } {
    return { canaries: this.byScope.size, hits: this.hits }
  }
}
