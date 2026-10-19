/**
 * Shared vocabulary for the honey-token guard.
 *
 * Nothing in here touches DSH runtime types: the guard reasons about plain
 * text spans and values, so the engine stays unit-testable without a harness.
 *
 * @module dsh-honey-guard/types
 */

/** The kinds of secret the guard knows how to fake plausibly. */
export type HoneyCategory =
  | 'aws_key'
  | 'openai_key'
  | 'github_token'
  | 'github_pat'
  | 'bearer'
  | 'pem'
  | 'custom'

/**
 * One accepted span of real secret text inside a larger string.
 *
 * `start`/`end` are UTF-16 code-unit offsets into the source string, matching
 * `String.prototype.slice`, so callers can splice without re-searching.
 */
export interface Detection {
  category: HoneyCategory
  /** The exact real text that must never leave the machine. */
  value: string
  start: number
  end: number
}

/** A single real↔honey pairing. Lives in memory for the session's lifetime. */
export interface HoneyEntry {
  /** The structurally valid fake that goes on the wire. */
  honey: string
  /** The original value. Never logged, never serialized. */
  real: string
  category: HoneyCategory
  createdAt: number
  /** How many times the fake has been substituted outbound. */
  count: number
}

/** Per-scope bidirectional index, kept as two maps for O(1) lookups both ways. */
export interface SessionHoneyMap {
  /** real → entry, for outbound de-duplication. */
  byReal: Map<string, HoneyEntry>
  /** honey → entry, for inbound restoration. */
  byHoney: Map<string, HoneyEntry>
}

/** Aggregate counters safe to log — they never contain real values. */
export interface GuardStats {
  /** Distinct real values mapped during the process lifetime. */
  mapped: number
  /** Outbound substitutions performed. */
  substituted: number
  /** Inbound honey occurrences restored to real values. */
  restored: number
  /** Number of active scope buckets. */
  scopes: number
}