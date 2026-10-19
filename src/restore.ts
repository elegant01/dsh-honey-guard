/**
 * Explicit restoration of Honey-Tokens back to real values.
 *
 * ## Why explicit, and not on the inbound stream
 *
 * The inbound `llm/stream` chunks are writable, but auto-restoring there leaks.
 * `dsh-agent-loop` settles an `assistant/message` from exactly the chunks the
 * guard yields, and appends that message to the session verbatim. On the next
 * turn the session history is frozen into the request (`deriveMessages()` →
 * `buildRequest()` deep-freezes everything) *before* any `llm/stream` listener
 * runs, so the restored real value would go straight to the model.
 *
 * Restoration therefore happens only when the caller asks for it: a command, a
 * post-processing pass, or a UI render that wants the user's own secrets back
 * on screen. The functions here mirror the outbound side — same block kinds,
 * same scope, same referential-identity contract.
 *
 * @module dsh-honey-guard/restore
 */

import type { ContentBlock, RequestMessage } from '@deepseek-ai/dsh-llm'
import type { HoneyEngine } from './honey-engine.ts'
import type { HoneyCategory, HoneyEntry, SessionHoneyMap } from './types.ts'
import { rewriteContent } from './outbound.ts'

/** Value-free counters describing one restoration pass. */
export interface RestoreReport {
  /** Number of Honey-Tokens turned back into real values. */
  restorations: number
}

/** Turns Honey-Tokens in a string back into the tracked real values. */
export type TextRestorer = (text: string) => string

/**
 * Build a restorer bound to one scope.
 *
 * Matching is exact substring lookup, longest token first: Honey-Tokens are
 * generated to be structurally distinct, so no regex is needed, and exact
 * matching cannot misfire the way a pattern scanner could. A short token is
 * tried after a longer one so it can never match inside a longer token's text.
 *
 * @param engine - the mapping engine (the same instance that sanitized).
 * @param scopeKey - session identity, or `undefined` for the shared bucket.
 * @param report - mutable counter sink, filled as restorations happen.
 */
export function createTextRestorer(
  engine: HoneyEngine,
  scopeKey: string | undefined,
  report: RestoreReport,
): TextRestorer {
  const scope = engine.scope(scopeKey)
  const tokens = [...scope.byHoney.keys()]
  if (tokens.length === 0) return (text) => text

  tokens.sort((a, b) => b.length - a.length)

  return (text: string): string => {
    if (text.length === 0) return text
    let out = text
    let changed = false
    for (const token of tokens) {
      const real = engine.realFor(scope, token)
      if (real === undefined) continue
      let at = out.indexOf(token)
      while (at !== -1) {
        out = out.slice(0, at) + real + out.slice(at + token.length)
        changed = true
        report.restorations += 1
        engine.emitRestoration(scopeKey, scopeEntryCategory(engine, scope, token), 1)
        // Continue past the replacement; `real` cannot itself be a token.
        at = out.indexOf(token, at + real.length)
      }
    }
    return changed ? out : text
  }
}

/** Category of the entry behind a token, for the audit event. */
function scopeEntryCategory(engine: HoneyEngine, scope: SessionHoneyMap, token: string): HoneyCategory {
  const entry = (scope.byHoney.get(token) as HoneyEntry | undefined)
  return entry?.category ?? 'custom'
}

/** Restore every Honey-Token in one string. */
export function restoreText(engine: HoneyEngine, scopeKey: string | undefined, text: string): string {
  const report: RestoreReport = { restorations: 0 }
  return createTextRestorer(engine, scopeKey, report)(text)
}

/**
 * Restore every Honey-Token in a message batch.
 *
 * The `messages` parameter is `readonly` for input; pass a fresh array to a
 * consumer that owns it. As on the outbound side, identity is preserved when
 * nothing changed.
 */
export function restoreMessages<M extends RequestMessage>(
  messages: readonly M[],
  engine: HoneyEngine,
  scopeKey: string | undefined,
): { messages: readonly M[]; report: RestoreReport } {
  const report: RestoreReport = { restorations: 0 }
  const restorer = createTextRestorer(engine, scopeKey, report)

  let changed = false
  const next = messages.map((message) => {
    const content = (message as { content?: readonly ContentBlock[] }).content
    if (!Array.isArray(content)) return message
    const rewritten = rewriteContent(content, restorer)
    if (rewritten === content) return message
    changed = true
    return { ...message, content: rewritten } as M
  })

  return { messages: changed ? next : messages, report }
}

/**
 * Restore every Honey-Token in one standalone block list.
 */
export function restoreBlocks<B extends ContentBlock>(
  blocks: readonly B[],
  engine: HoneyEngine,
  scopeKey: string | undefined,
): { blocks: readonly B[]; report: RestoreReport } {
  const report: RestoreReport = { restorations: 0 }
  const restorer = createTextRestorer(engine, scopeKey, report)
  return { blocks: rewriteContent(blocks, restorer), report }
}