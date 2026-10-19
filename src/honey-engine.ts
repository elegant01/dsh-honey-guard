/**
 * The honey engine: deterministic, structurally valid fakes plus the
 * per-scope bidirectional map that makes them reversible.
 *
 * Two properties matter, and they pull in opposite directions:
 *
 *   - **Determinism** — the same real value must always produce the same fake
 *     within a scope, or the mapping table would grow without bound and the
 *     model would see two names for one key.
 *   - **Unlinkability** — two different scopes must NOT derive the same fake
 *     from the same real value, or an observer comparing two transcripts could
 *     tell that both used one credential.
 *
 * The seed therefore mixes the scope key with the real value:
 * `scope:category:real:attempt`. Deriving from the real value alone would
 * satisfy determinism while leaking cross-scope equality.
 *
 * @module dsh-honey-guard/honey-engine
 */

import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto'
import type { HoneyCategory, HoneyEntry, SessionHoneyMap } from './types.ts'

/** Alphabet used by AWS access key ids: uppercase plus digits. */
const UPPER_ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
/** Alphabet used by OpenAI and GitHub secrets: mixed case plus digits. */
const MIXED_ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
/** Alphabet used by opaque bearer tokens. */
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/** Bucket used when a call carries no session id (title generation, compaction). */
export const NO_SESSION = '__no_session__'

/**
 * Index key for a scope's `byReal` map.
 *
 * The category participates because the same literal text can be classified two
 * ways — a manually marked value that also matches a detector pattern — and the
 * two classifications want differently shaped fakes. NUL cannot appear in a
 * detected value, since every detector matches credential characters only.
 */
function realIndexKey(category: HoneyCategory, real: string): string {
  return `${category}\u0000${real}`
}

/**
 * Stretch a seed into `length` pseudo-random bytes.
 *
 * SHA-256 is used as a deterministic stream: hashing `seed#counter` for
 * successive counters and concatenating. This is a derivation function for
 * *plausible-looking* fakes, not a key-derivation function for secrets — the
 * output is not secret and never needs to resist an attacker who knows the
 * seed. It is deterministic, which is the only property required here.
 */
function expand(seed: string, length: number): Buffer {
  const blocks: Buffer[] = []
  let produced = 0
  for (let counter = 0; produced < length; counter += 1) {
    blocks.push(createHash('sha256').update(`${seed}#${counter}`).digest())
    produced += 32
  }
  return Buffer.concat(blocks).subarray(0, length)
}

/**
 * Map bytes onto an alphabet.
 *
 * The modulo bias (36 or 64 does not divide 256) is irrelevant: these strings
 * only need to look like credentials and be collision-free within a scope.
 */
function toAlphabet(bytes: Buffer, alphabet: string): string {
  let out = ''
  for (const byte of bytes) out += alphabet.charAt(byte % alphabet.length)
  return out
}

/** A plausible PEM body; the base64 is derived, the framing is real. */
function fakePem(seed: string): string {
  const body = expand(seed, 96).toString('base64')
  const lines = body.match(/.{1,64}/g) ?? [body]
  return ['-----BEGIN PRIVATE KEY-----', ...lines, '-----END PRIVATE KEY-----'].join('\n')
}

/**
 * One generator per category. Each reproduces the real credential's shape so
 * the model reads it as an ordinary key and does not start second-guessing the
 * format (which is what produces "syntax hallucination").
 */
const GENERATORS: Record<HoneyCategory, (seed: string) => string> = {
  aws_key: (seed) => `AKIA${toAlphabet(expand(seed, 16), UPPER_ALNUM)}`,
  openai_key: (seed) => `sk-${toAlphabet(expand(seed, 48), MIXED_ALNUM)}`,
  github_token: (seed) => `ghp_${toAlphabet(expand(seed, 36), MIXED_ALNUM)}`,
  github_pat: (seed) => `github_pat_${toAlphabet(expand(seed, 82), `${MIXED_ALNUM}_`)}`,
  bearer: (seed) => toAlphabet(expand(seed, 40), BASE64URL),
  pem: (seed) => fakePem(seed),
  custom: (seed) => `HNY${toAlphabet(expand(seed, 29), UPPER_ALNUM)}`,
}

/** A scope bucket remembers which key it was created under. */
interface ScopeBucket extends SessionHoneyMap {
  readonly key: string
}

export interface HoneyEngineOptions {
  /**
   * `stable` (default) derives the fake from the real value, so a re-scan of
   * the same scope is idempotent. `random` draws fresh entropy per mapping.
   */
  format?: 'stable' | 'random'
  /** Hard cap on entries per scope, bounding memory on long sessions. */
  maxEntriesPerScope?: number
  /** Injected clock; deterministic tests override it. */
  now?: () => number
  /** Injected entropy source for `format: 'random'`. */
  randomBytes?: (size: number) => Buffer
  /**
   * Called every time a Honey-Token is turned back into its real value.
   *
   * The payload deliberately carries **no real or honey values** — only the
   * scope, the category, and a count — so an audit subscriber can count and
   * attribute restorations without ever receiving secret material. This is
   * the F10 "inbound restoration event" surface, wired by the plugin to a
   * cordis event.
   */
  onRestoration?: (payload: RestorationEvent) => void
}

/** Value-safe payload for the F10 restoration event. */
export interface RestorationEvent {
  /** The scope whose Honey-Tokens were restored, if any. */
  scopeKey: string | undefined
  /** Category of the restored value. */
  category: HoneyCategory
  /** How many occurrences were restored in this pass. */
  restorations: number
}

/**
 * Owns every scope's mapping table for the process lifetime.
 *
 * One instance is created per plugin activation. It never writes real values
 * anywhere but memory, and exposes only aggregate counters to callers.
 */
export class HoneyEngine {
  private readonly scopes = new Map<string, ScopeBucket>()
  private readonly format: 'stable' | 'random'
  private readonly maxEntriesPerScope: number
  private readonly now: () => number
  private readonly randomBytes: (size: number) => Buffer
  private readonly onRestoration: ((payload: RestorationEvent) => void) | undefined

  private substituted = 0
  private restored = 0

  constructor(options: HoneyEngineOptions = {}) {
    this.format = options.format ?? 'stable'
    this.maxEntriesPerScope = options.maxEntriesPerScope ?? 500
    this.now = options.now ?? Date.now
    this.randomBytes = options.randomBytes ?? ((size) => nodeRandomBytes(size))
    this.onRestoration = options.onRestoration
  }

  /** Resolve (and lazily create) the bucket for one session. */
  scope(sessionId: string | undefined): SessionHoneyMap {
    const key = sessionId === undefined || sessionId.length === 0 ? NO_SESSION : sessionId
    let bucket = this.scopes.get(key)
    if (bucket === undefined) {
      bucket = { key, byReal: new Map(), byHoney: new Map() }
      this.scopes.set(key, bucket)
    }
    return bucket
  }

  private seedFor(bucket: ScopeBucket, real: string, category: HoneyCategory, attempt: number): string {
    if (this.format === 'random') return this.randomBytes(32).toString('hex')
    return `${bucket.key}:${category}:${real}:${attempt}`
  }

  /**
   * Return the entry for a real value, creating one on first sight.
   *
   * Repeated calls with the same value in the same scope return the identical
   * entry, which is what keeps the mapping stable across turns.
   */
  honeyFor(map: SessionHoneyMap, real: string, category: HoneyCategory): HoneyEntry {
    const indexKey = realIndexKey(category, real)
    const existing = map.byReal.get(indexKey)
    if (existing !== undefined) return existing

    const bucket = map as ScopeBucket
    const generate = GENERATORS[category]
    let entry: HoneyEntry | undefined
    // A collision means two distinct real values derived one fake. Vanishingly
    // unlikely, but the loop makes it impossible rather than merely improbable.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const honey = generate(this.seedFor(bucket, real, category, attempt))
      if (map.byHoney.has(honey)) continue
      entry = { honey, real, category, createdAt: this.now(), count: 0 }
      break
    }
    // Eight collisions in a row on a >=20-character space: fall back to the
    // deterministic first candidate rather than failing the request.
    entry ??= {
      honey: generate(this.seedFor(bucket, real, category, 0)),
      real,
      category,
      createdAt: this.now(),
      count: 0,
    }

    map.byReal.set(indexKey, entry)
    map.byHoney.set(entry.honey, entry)
    this.evictIfNeeded(map)
    return entry
  }

  /** Look up the real value behind a fake; `undefined` when it is not ours. */
  realFor(map: SessionHoneyMap, honey: string): string | undefined {
    return map.byHoney.get(honey)?.real
  }

  /** Every fake currently known to a scope, for inbound scanning. */
  honeysIn(map: SessionHoneyMap): Iterable<string> {
    return map.byHoney.keys()
  }

  /** Every real→honey pairing currently known to a scope. */
  entriesIn(map: SessionHoneyMap): Iterable<HoneyEntry> {
    return map.byReal.values()
  }

  /** Record outbound substitutions for the stats line. */
  recordSubstitutions(count: number): void {
    this.substituted += count
  }

  /** Record inbound restorations for the stats line. */
  recordRestorations(count: number): void {
    this.restored += count
  }

  /**
   * Record one restoration and fire the value-safe audit callback (F10).
   *
   * Called by the restore path for every Honey-Token turned back into a real
   * value. The callback never receives the real or honey string.
   */
  emitRestoration(scopeKey: string | undefined, category: HoneyCategory, restorations: number): void {
    this.restored += restorations
    this.onRestoration?.({ scopeKey, category, restorations })
  }

  /** Drop the oldest pairings once a scope exceeds its cap. */
  private evictIfNeeded(map: SessionHoneyMap): void {
    while (map.byReal.size > this.maxEntriesPerScope) {
      const oldest = map.byReal.keys().next()
      if (oldest.done === true) return
      const entry = map.byReal.get(oldest.value)
      map.byReal.delete(oldest.value)
      if (entry !== undefined) map.byHoney.delete(entry.honey)
    }
  }

  /** Aggregate, value-free counters. */
  stats(): { mapped: number; substituted: number; restored: number; scopes: number } {
    let mapped = 0
    for (const bucket of this.scopes.values()) mapped += bucket.byReal.size
    return { mapped, substituted: this.substituted, restored: this.restored, scopes: this.scopes.size }
  }
}