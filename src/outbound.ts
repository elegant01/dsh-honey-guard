/**
 * Outbound sanitization: swap real secrets for their Honey-Tokens on the way
 * to the model.
 *
 * ## Why this does not live on `llm/stream`
 *
 * The obvious interception point is the `llm/stream` waterfall, and it does not
 * work. `dsh-agent-loop` assembles the request in `buildRequest()` and freezes
 * it before dispatch:
 *
 * ```js
 * deepFreeze(header)
 * for (const message of boundaryMessages) { deepFreeze(message); ... }
 * Object.freeze(boundaryMessages)
 * return markAgentLoopRequest(Object.freeze({ ...header.config, messages: boundaryMessages, ... }))
 * ```
 *
 * `options`, the `messages` array, every message, and every content block are
 * all non-writable by the time a stream listener runs, and the waterfall's
 * `next` closes over that same object, so it cannot be swapped either.
 *
 * `agent/pre-step` runs *before* the request is derived (`README`: "neither
 * async phase sees the pending system prompt or accepted users committed to
 * history"), hands the listener the claimed messages, and takes a brand-new
 * array back:
 *
 * ```js
 * const decision = await this.dispatch.waterfall('agent/pre-step',
 *   { agent, messages: claimed, ...position, signal },
 *   () => Promise.resolve({ kind: 'enter', messages: ... }))
 * ```
 *
 * Those returned messages are what get appended to the session
 * (`session.append('user/message', message, ...)`), so replacing them means the
 * session itself holds Honey-Tokens — and the frozen request downstream is then
 * honey by construction. That is the whole trick: sanitize once, at admission.
 *
 * The functions here are generic over the incoming element type so the caller
 * can hand back a `UserMessage[]` to `agent/pre-step` and a `ContentBlock[]` to
 * `tools/post-execute` without a cast.
 *
 * @module dsh-honey-guard/outbound
 */

import type { ContentBlock, RequestMessage } from '@deepseek-ai/dsh-llm'
import { scanText } from './detectors/index.ts'
import type { HoneyEngine } from './honey-engine.ts'
import type { HoneyCategory, HoneyEntry } from './types.ts'

/** Value-free counters describing one sanitization pass. */
export interface SanitizeReport {
  /** Substitutions per category; never carries the matched text. */
  hits: Partial<Record<HoneyCategory, number>>
  /** Total substitutions. */
  total: number
}

/** Rewrites one string, replacing every recognized secret with a fake. */
export type TextRewriter = (text: string) => string

/**
 * Build a rewriter bound to one scope.
 *
 * The returned function is pure with respect to the model's view: same input,
 * same output, because {@link HoneyEngine.honeyFor} is deterministic per scope.
 *
 * @param engine - the mapping engine.
 * @param scopeKey - session identity, or `undefined` for the shared bucket.
 * @param report - mutable counter sink, filled as substitutions happen.
 */
export function createTextRewriter(
  engine: HoneyEngine,
  scopeKey: string | undefined,
  report: SanitizeReport,
): TextRewriter {
  const scope = engine.scope(scopeKey)

  return (text: string): string => {
    if (text.length === 0) return text

    // Collect every replacement interval against the ORIGINAL text first:
    // pass 1 from the pattern detectors, pass 2 from manual marks (F11). Both
    // are resolved before any substitution, so a value marked after a detector
    // hit can never match inside the fake that pass 1 would otherwise have
    // produced — the fakes are never part of the scanned text.
    interface Interval {
      start: number
      end: number
      honey: string
      category: HoneyCategory
      entry: HoneyEntry
    }
    const intervals: Interval[] = []

    const detections = scanText(text)
    for (const detection of detections) {
      const entry = engine.honeyFor(scope, detection.value, detection.category)
      intervals.push({
        start: detection.start,
        end: detection.end,
        honey: entry.honey,
        category: detection.category,
        entry,
      })
    }

    // Manual marks: longest real first so a short marked value cannot match
    // inside a longer one. Skip any occurrence that overlaps an already-collected
    // interval (a detector hit), so the detector's classification wins.
    const entries = [...engine.entriesIn(scope)].sort((a, b) => b.real.length - a.real.length)
    for (const entry of entries) {
      let at = text.indexOf(entry.real)
      while (at !== -1) {
        const end = at + entry.real.length
        const overlaps = intervals.some(
          (interval) => at < interval.end && interval.start < end,
        )
        if (!overlaps) {
          intervals.push({ start: at, end, honey: entry.honey, category: entry.category, entry })
        }
        at = text.indexOf(entry.real, at + 1)
      }
    }

    if (intervals.length === 0) return text

    // The cursor pass needs global position order. Detector intervals arrive
    // sorted (scanText), manual-mark intervals are appended in text order, but
    // the two groups interleave arbitrarily — sort once, stable, so ties keep
    // the detector (earlier-collected) first.
    intervals.sort((a, b) => a.start - b.start)

    // One cursor pass over the ORIGINAL text. Intervals never overlap, so the
    // output is simply the original with each interval's span replaced. Count
    // only the intervals that were actually emitted (a later interval wholly
    // inside an earlier replacement is skipped by the cursor guard).
    let out = ''
    let cursor = 0
    let replaced = 0
    for (const interval of intervals) {
      if (interval.start < cursor) continue
      out += text.slice(cursor, interval.start)
      out += interval.honey
      cursor = interval.end
      replaced += 1
      report.total += 1
      report.hits[interval.category] = (report.hits[interval.category] ?? 0) + 1
      interval.entry.count += 1
    }
    out += text.slice(cursor)
    engine.recordSubstitutions(replaced)
    return out
  }
}

/**
 * Rewrite one content block.
 *
 * Only the three text-bearing block kinds carry secrets: `text`, `reasoning`
 * (the model's own thinking is sent back on later turns, so it leaks just as
 * readily), and `tool-call.arguments` (a JSON string that routinely embeds
 * credentials). `image` and `file` hold references, and `tool-addition` /
 * `tool-removal` hold only tool names.
 *
 * The `B` cast is sound: only the text-bearing field is replaced, never the
 * discriminant, so the block keeps its concrete kind.
 */
export function rewriteBlock<B extends ContentBlock>(block: B, rewrite: TextRewriter): B {
  switch (block.type) {
    case 'text':
    case 'reasoning': {
      const next = rewrite(block.text)
      return (next === block.text ? block : { ...block, text: next }) as B
    }
    case 'tool-call': {
      const next = rewrite(block.arguments)
      return (next === block.arguments ? block : { ...block, arguments: next }) as B
    }
    default:
      return block
  }
}

/**
 * Rewrite a block list, preserving referential identity when nothing matched.
 *
 * Identity matters: callers compare `next !== previous` to decide whether the
 * request changed, and callers that own the array may be relying on a stable
 * reference for caching.
 */
export function rewriteContent<B extends ContentBlock>(blocks: readonly B[], rewrite: TextRewriter): readonly B[] {
  let changed = false
  const next = blocks.map((block) => {
    const rewritten = rewriteBlock(block, rewrite)
    if (rewritten !== block) changed = true
    return rewritten
  })
  return changed ? next : blocks
}

/**
 * Sanitize a message batch on its way into the session.
 *
 * Every message is rebuilt rather than mutated. That is not stylistic: the
 * input may be frozen, and the output must carry a fresh array so the loop's
 * "did this change?" comparisons see the substitution.
 *
 * @param messages - the claimed batch from `agent/pre-step`.
 * @param engine - the mapping engine.
 * @param scopeKey - session identity, or `undefined` for the shared bucket.
 * @returns the possibly-rewritten batch plus a value-free report.
 */
export function sanitizeMessages<M extends RequestMessage>(
  messages: readonly M[],
  engine: HoneyEngine,
  scopeKey: string | undefined,
): { messages: readonly M[]; report: SanitizeReport } {
  const report: SanitizeReport = { hits: {}, total: 0 }
  const rewrite = createTextRewriter(engine, scopeKey, report)

  let changed = false
  const next = messages.map((message) => {
    // `RequestUserInput` carries `content` but no `id`/`source`; both shapes are
    // accepted here, and a message without an array content is passed through.
    const content = (message as { content?: readonly ContentBlock[] }).content
    if (!Array.isArray(content)) return message

    const rewritten = rewriteContent(content, rewrite)
    if (rewritten === content) return message
    changed = true
    return { ...message, content: rewritten } as M
  })

  return { messages: changed ? next : messages, report }
}

/**
 * Sanitize one standalone block list — the shape `tools/post-execute` carries.
 *
 * @param blocks - content blocks from a tool result.
 * @param engine - the mapping engine.
 * @param scopeKey - session identity, or `undefined` for the shared bucket.
 * @returns the possibly-rewritten blocks plus a value-free report.
 */
export function sanitizeBlocks<B extends ContentBlock>(
  blocks: readonly B[],
  engine: HoneyEngine,
  scopeKey: string | undefined,
): { blocks: readonly B[]; report: SanitizeReport } {
  const report: SanitizeReport = { hits: {}, total: 0 }
  const rewrite = createTextRewriter(engine, scopeKey, report)
  return { blocks: rewriteContent(blocks, rewrite), report }
}