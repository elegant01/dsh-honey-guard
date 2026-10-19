/**
 * Secret detectors: the outbound half of the guard.
 *
 * Each detector is a global regex plus the category it proves. A detector may
 * point at a capture group so the surrounding syntax (a `Bearer ` prefix, for
 * instance) survives substitution while only the secret itself is replaced.
 *
 * Detection is deliberately conservative: a false negative leaks a key, but a
 * false positive mangles ordinary prose, so every pattern is anchored to a
 * real credential shape rather than to "looks random".
 *
 * @module dsh-honey-guard/detectors
 */

import type { Detection, HoneyCategory } from '../types.ts'

/** One credential shape the guard can recognize. */
export interface Detector {
  category: HoneyCategory
  /** Must be a `g` regex; `d` is optional and enables precise capture spans. */
  pattern: RegExp
  /** Capture group holding the secret; `0` (default) means the whole match. */
  group?: number
}

const AWS_KEY = /(?<![A-Z0-9])AKIA[0-9A-Z]{16}(?![A-Z0-9])/g
const OPENAI_KEY = /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}/g
const GITHUB_TOKEN = /(?<![A-Za-z0-9_])ghp_[A-Za-z0-9]{36}(?![A-Za-z0-9])/g
const GITHUB_PAT = /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{60,}/g
const BEARER = /[Bb]earer\s+([A-Za-z0-9\-._~+/]{20,}=*)/gd
/** A complete PEM private key block. */
const PEM_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
/**
 * A PEM header with no closing fence — a truncated paste still leaks key
 * material, so it is matched on its own. `dedupe` keeps the longer block when
 * both patterns hit the same region.
 */
const PEM_HEADER = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g

/**
 * Order matters only for readability: `dedupe` resolves overlaps by length, so
 * a detector listed later can still win a contested span.
 */
export const DETECTORS: readonly Detector[] = [
  { category: 'aws_key', pattern: AWS_KEY },
  { category: 'openai_key', pattern: OPENAI_KEY },
  { category: 'github_token', pattern: GITHUB_TOKEN },
  { category: 'github_pat', pattern: GITHUB_PAT },
  { category: 'pem', pattern: PEM_BLOCK },
  { category: 'pem', pattern: PEM_HEADER },
  { category: 'bearer', pattern: BEARER, group: 1 },
]

function asGlobal(pattern: RegExp): RegExp {
  // `matchAll` requires `g`. Rebuilding also guarantees no shared `lastIndex`
  // state leaks between calls, which is the classic stateful-regex bug.
  return pattern.global ? new RegExp(pattern.source, pattern.flags) : new RegExp(pattern.source, `${pattern.flags}g`)
}

/**
 * Collapse overlapping detections, preferring the longest span so a complete
 * PEM block wins over its own header and never gets split mid-replacement.
 * Input is expected to be start-sorted; ties break toward the longer span.
 */
function dedupe(found: readonly Detection[]): Detection[] {
  const sorted = [...found].sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start))
  const out: Detection[] = []
  for (const detection of sorted) {
    const previous = out[out.length - 1]
    if (previous !== undefined && detection.start < previous.end) {
      if (detection.end - detection.start > previous.end - previous.start) out[out.length - 1] = detection
      continue
    }
    out.push(detection)
  }
  return out
}

/**
 * Find every secret span in one string.
 *
 * @param text - the text to scan.
 * @param detectors - override for tests; defaults to {@link DETECTORS}.
 * @returns non-overlapping detections ordered by position.
 */
export function scanText(text: string, detectors: readonly Detector[] = DETECTORS): Detection[] {
  if (text.length === 0) return []

  const found: Detection[] = []
  for (const detector of detectors) {
    const group = detector.group ?? 0
    for (const match of text.matchAll(asGlobal(detector.pattern))) {
      const value = match[group]
      if (value === undefined || value.length === 0) continue

      const span = group > 0 ? match.indices?.[group] : undefined
      const start = span?.[0] ?? match.index
      const end = span?.[1] ?? match.index + match[0].length

      found.push({ category: detector.category, value, start, end })
    }
  }
  return dedupe(found)
}

/** True when the text contains at least one recognizable secret. */
export function containsSecret(text: string, detectors: readonly Detector[] = DETECTORS): boolean {
  return scanText(text, detectors).length > 0
}

/**
 * Replace detected spans using a caller-supplied mapping.
 *
 * Splicing walks the original offsets forward and rebuilds the string, so no
 * index shifting occurs regardless of how much the replacements differ in
 * length from their originals.
 *
 * @param text - source text.
 * @param detections - spans from {@link scanText}, position-sorted.
 * @param replace - returns the substitute for one detection.
 * @returns the rewritten string and how many spans were substituted.
 */
export function replaceDetections(
  text: string,
  detections: readonly Detection[],
  replace: (detection: Detection) => string,
): { text: string; replaced: number } {
  if (detections.length === 0) return { text, replaced: 0 }

  const parts: string[] = []
  let cursor = 0
  let replaced = 0
  for (const detection of detections) {
    if (detection.start < cursor) continue
    parts.push(text.slice(cursor, detection.start), replace(detection))
    cursor = detection.end
    replaced += 1
  }
  parts.push(text.slice(cursor))
  return { text: parts.join(''), replaced }
}