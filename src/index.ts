/**
 * Zero-Leak Honey-Token Guard for DeepSeek Harness.
 *
 * A reversible honey-mapping layer that keeps real credentials out of every
 * model request while keeping the transcript internally consistent.
 *
 * ## Where it hooks, and why
 *
 * The intuitive place to redact a request is the `llm/stream` waterfall, right
 * before the adapter sees it. That point does not work in DSH:
 * `dsh-agent-loop`'s `buildRequest()` deep-freezes the header, every message,
 * every content block, and the `messages` array itself, then freezes the
 * options object and hands that exact reference to `next()`. Nothing there is
 * writable, and the reference cannot be swapped.
 *
 * So the guard sanitizes *upstream*, where the loop still accepts a new batch:
 *
 *   - `agent/pre-step` — the loop hands over the claimed messages and takes a
 *     fresh array back; those returned messages are what get appended to the
 *     session (`session.append('user/message', ...)`). Replacing them means the
 *     session holds Honey-Tokens, and the frozen request built from it is honey
 *     by construction. User input and pasted secrets enter here.
 *   - `tools/post-execute` — tool output is the other way secrets reach the
 *     model (a `.env` dump, a config read, an API response). This waterfall may
 *     replace a result's content, so it is sanitized here.
 *
 * ## What it deliberately does NOT do
 *
 * It does not auto-restore Honey-Tokens on the inbound stream, even though the
 * chunks are writable. Restoring there would write the *real* value into
 * `assistant/message` (`live.push(chunk)` accumulates exactly the chunks the
 * guard yields, and the settled message is appended verbatim). That message is
 * session history: the next turn sends it to the model through
 * `deriveMessages()`, where it bypasses `agent/pre-step` and is frozen before
 * `llm/stream`. The real secret would leak on the very next turn.
 *
 * Restoration is therefore explicit, matching `dsh-mask`'s `/mask restore`
 * design: `restore()` is exposed for a command or tool to call deliberately.
 *
 * @module dsh-honey-guard
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only imports: these packages declaration-merge their events into Context.
import type {} from '@deepseek-ai/dsh-agent-loop'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-tools'
import { HoneyEngine } from './honey-engine.ts'
import { CanaryTracker, type CanaryHit } from './canary.ts'
import { sanitizeBlocks, sanitizeMessages, type SanitizeReport } from './outbound.ts'
import { createTextRestorer, restoreBlocks, restoreMessages, restoreText } from './restore.ts'
import { registerHoneyTools } from './honey-tools.ts'
import { createSubLog, defaultSubLogPath } from './sub-log.ts'
import { registerHoneyLogRoute } from './web-log.ts'
import type { HoneyCategory } from './types.ts'
import type { RestorationEvent } from './honey-engine.ts'

// F10: publish the restoration audit event on the cordis event bus so other
// plugins, commands, or renderers can observe it without receiving secrets.
declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One or more Honey-Tokens were turned back into real values by an explicit
     * restore call. The payload is value-safe: it never contains the real or
     * honey strings.
     * @param payload.scopeKey - the scope whose tokens were restored, if any.
     * @param payload.category - category of the restored value.
     * @param payload.restorations - how many occurrences were restored.
     * @mode emit
     */
    'honey/restored'(payload: RestorationEvent): void
  }
}

/** Stable Cordis plugin name. */
export const name = 'honey-guard'

/** The LLM and tools services must exist before their surfaces can be used. */
export const inject = ['llm', 'tools']

/** Plugin configuration. */
export interface Config {
  /** Master switch; when false the guard registers but rewrites nothing. */
  enabled?: boolean
  /** `silent` never logs, `info` reports substitutions, `debug` adds detail. */
  logLevel?: 'silent' | 'info' | 'debug'
  /** `stable` derives fakes from the value; `random` draws fresh entropy. */
  honeyFormat?: 'stable' | 'random'
  /** Hard cap on pairings per scope, bounding memory on long sessions. */
  maxEntriesPerScope?: number
  /** Persist value-safe substitution records to `~/.dsh/honey-guard/`. */
  logFile?: boolean
  /** Roll the substitution log once it exceeds this size, in megabytes. */
  logFileMaxMb?: number
  /**
   * Also write the emitted honey tokens into the log. These are fake values,
   * never real ones — but they let anyone holding both the log and a
   * transcript correlate the two, so this stays opt-in.
   */
  logHoneys?: boolean
}

const LOG_LEVELS = ['silent', 'info', 'debug'] as const

type LogLevel = (typeof LOG_LEVELS)[number]

function normalizeLogLevel(value: unknown): LogLevel {
  return LOG_LEVELS.includes(value as LogLevel) ? (value as LogLevel) : 'info'
}

function normalizeFormat(value: unknown): 'stable' | 'random' {
  return value === 'random' ? 'random' : 'stable'
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true).description('Enable the honey-token guard'),
  logLevel: z.string().default('info').description('Log verbosity: silent | info | debug'),
  honeyFormat: z.string().default('stable').description('Honey derivation: stable | random'),
  maxEntriesPerScope: z.number().default(500).description('Pairings retained per session'),
  logFile: z
    .boolean()
    .default(false)
    .description('Persist value-safe substitution records to ~/.dsh/honey-guard/substitutions.jsonl'),
  logFileMaxMb: z.number().default(5).description('Roll the substitution log past this size (MB)'),
  logHoneys: z
    .boolean()
    .default(false)
    .description('Also log the emitted honey tokens (fake values; enables log↔transcript correlation)'),
}) as unknown as z<Config>

/** A settings value that resolves lazily; DSH config fields may be volatile. */
interface VolatileValue<T> {
  get: () => T
}

function unwrapVolatileValue<T>(value: unknown): T {
  if (typeof value === 'object' && value !== null && typeof (value as { get?: unknown }).get === 'function') {
    return (value as VolatileValue<T>).get()
  }
  return value as T
}

function unwrapConfig(value: unknown): Config {
  if (typeof value !== 'object' || value === null) return {}
  const out: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(value)) out[key] = unwrapVolatileValue(field)
  return out as Config
}

/** Render counters for a log line — categories and counts, never values. */
export function formatHits(hits: Partial<Record<HoneyCategory, number>>): string {
  return Object.entries(hits)
    .map(([category, count]) => `${category}=${count}`)
    .join(', ')
}

/**
 * The service handle `ctx.provide('honeyGuard', ...)` publishes.
 *
 * It deliberately exposes no real values: consumers ask for restoration and
 * receive the result; the guard never hands out its mapping tables wholesale.
 */
export interface GuardHandle {
  /** The underlying mapping engine (read-only use for stats/counts). */
  readonly engine: HoneyEngine
  /** Resolve the scope key for an agent object. */
  readonly scopeKeyFor: (agent: unknown) => string | undefined
  /** Restore every Honey-Token in one string. */
  readonly restoreText: (scopeKey: string | undefined, text: string) => string
  /** Restore every Honey-Token in one standalone block list. */
  readonly restoreBlocks: typeof restoreBlocks
  /** Restore every Honey-Token in a message batch. */
  readonly restoreMessages: typeof restoreMessages
  /** Build a reusable restorer bound to one scope. */
  readonly createTextRestorer: typeof createTextRestorer
  /** The Canary Trap tracker backing the leak alarm. */
  readonly canaries: CanaryTracker
}

// Re-export the restore surface so `import { restoreText } from 'dsh-honey-guard'`
// works without the service handle.
export { restoreBlocks, restoreMessages, restoreText, createTextRestorer } from './restore.ts'

export function apply(ctx: Context, rawConfig: Config): void {
  const config = unwrapConfig(rawConfig)
  const enabled = config.enabled !== false
  const logLevel = normalizeLogLevel(config.logLevel)
  const engine = new HoneyEngine({
    format: normalizeFormat(config.honeyFormat),
    ...(typeof config.maxEntriesPerScope === 'number' ? { maxEntriesPerScope: config.maxEntriesPerScope } : {}),
    onRestoration: (payload) => {
      // F10: fire a value-safe audit event so commands/renderers/other plugins
      // can observe restoration without ever receiving secret material.
      ctx.emit('honey/restored', payload)
    },
  })
  const canaries = new CanaryTracker()
  const subLog =
    config.logFile === true
      ? createSubLog({
          maxBytes: Math.max(1, Number(config.logFileMaxMb) || 5) * 1024 * 1024,
        })
      : undefined

  /**
   * One mapping scope per agent.
   *
   * `agent/pre-step` hands over the `Agent`, and `tools/post-execute` hands over
   * `exec.agent` — a stable object per conversation. Keying this WeakMap on it
   * gives every conversation its own bucket without needing a session id, and
   * the entry disappears when the agent is collected. Sharing one global bucket
   * would instead derive the same fake for the same secret in every
   * conversation, letting anyone comparing two transcripts tell that both used
   * one credential.
   */
  const scopeKeys = new WeakMap<object, string>()
  let scopeCounter = 0
  const scopeKeyFor = (agent: unknown): string | undefined => {
    if (typeof agent !== 'object' || agent === null) return undefined
    let key = scopeKeys.get(agent)
    if (key === undefined) {
      scopeCounter += 1
      key = `agent-${scopeCounter}`
      scopeKeys.set(agent, key)
    }
    return key
  }

  const info = (message: string): void => {
    if (logLevel !== 'silent') ctx.logger.info(message)
  }
  const debug = (message: string): void => {
    if (logLevel === 'debug') ctx.logger.debug(message)
  }
  const reportSubstitutions = (surface: string, report: SanitizeReport): void => {
    if (report.total === 0) return
    info(`[honey-guard] ${surface}: ${report.total} secret(s) replaced [${formatHits(report.hits)}]`)
    // Honey tokens leave the process only under the explicit logHoneys opt-in;
    // the default record stays correlation-free.
    const honeys = config.logHoneys === true && report.honeys !== undefined && report.honeys.length > 0
      ? { honeys: report.honeys }
      : {}
    subLog?.write({ time: new Date().toISOString(), surface, total: report.total, hits: report.hits, ...honeys })
  }
  const warnCanary = (surface: string, hits: CanaryHit[]): void => {
    for (const hit of hits) {
      // The canary itself is harmless by construction — it is a fake AWS key
      // that no live mapping ever produces — so logging it leaks nothing real.
      ctx.logger.warn(
        `[honey-guard] ${surface}: foreign canary ${hit.canary} (registered in ${hit.sourceScope}) ` +
          `appeared in ${hit.currentScope === undefined ? 'an unscoped pass' : hit.currentScope}`,
      )
      subLog?.write({
        time: new Date().toISOString(),
        surface,
        canary: hit.canary,
        sourceScope: hit.sourceScope,
        currentScope: hit.currentScope,
      })
    }
  }

  // --- Outbound: user input and tool results, at admission ------------------

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (!enabled || decision.kind !== 'enter') return decision

    // The payload carries `agent`, `messages`, `turn`, `step` and `signal`; the
    // agent is the conversation handle, so it keys the mapping scope.
    const scopeKey = scopeKeyFor(payload.agent)
    // Arm this session's trap on its first outbound pass, then look for any
    // *foreign* canary already riding in the claimed batch. This catches a
    // canary that bled into the transcript on a previous turn before the
    // guard was watching. An unscoped call (no agent handle) has no canary of
    // its own, so only foreign ones are scanned for.
    if (scopeKey !== undefined) canaries.register(scopeKey)
    const claimed = decision.messages
    for (const message of claimed) {
      const content = (message as { content?: readonly ContentBlock[] }).content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (block.type === 'text' || block.type === 'reasoning') warnCanary('pre-step', canaries.scan(block.text, scopeKey))
      }
    }

    const { messages, report } = sanitizeMessages(claimed, engine, scopeKey)
    reportSubstitutions('pre-step', report)
    if (messages === claimed) return decision
    // `PreStepDecision.messages` is a mutable `UserMessage[]`, and the loop
    // appends exactly this array, so hand back a fresh mutable one.
    return { ...decision, messages: [...messages] }
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (!enabled || decision.kind !== 'accept') return decision

    // A `value` decision is re-rendered by the registry from structured data;
    // supplying `content` alongside it throws, and rewriting the value itself
    // would mean walking arbitrary JSON. Tool text travels in `content`, which
    // is the path handled here.
    if (Object.hasOwn(decision, 'value')) {
      debug('[honey-guard] post-execute: skipped a value-replacing decision')
      return decision
    }

    const source = decision.content ?? result.content
    if (!Array.isArray(source)) return decision

    // Tool output is the other place a foreign canary can ride in (a tool that
    // echoes prior context, an API that returns our own fakes back).
    const scopeKey = scopeKeyFor(exec.agent)
    for (const block of source) {
      if (block.type === 'text' || block.type === 'reasoning') warnCanary(`tool ${String(exec.name)}`, canaries.scan(block.text, scopeKey))
    }

    const { blocks, report } = sanitizeBlocks(source, engine, scopeKey)
    reportSubstitutions(`tool ${String(exec.name)}`, report)
    if (blocks === source) return decision
    // Built explicitly rather than spread: `PostToolDecision` is a union whose
    // members disagree on `content` vs `value`, and spreading would merge a
    // `value` back into an `accept`-with-content decision, which the registry
    // rejects at runtime.
    return {
      kind: 'accept',
      content: [...blocks],
      ...(decision.additionalContexts === undefined ? {} : { additionalContexts: decision.additionalContexts }),
    }
  })

  // --- Observation only ----------------------------------------------------
  //
  // The request is already frozen here, so this listener exists to report what
  // actually goes on the wire, not to change it. If a tag ever shows up in this
  // line, redaction missed something upstream.
  ctx.on('llm/stream', (options, next) => {
    if (enabled && logLevel === 'debug') {
      const messages = Array.isArray(options?.messages) ? options.messages : []
      debug(
        `[honey-guard] dispatch: ${messages.length} message(s), ` +
          `session=${options?.sessionId === undefined ? 'none' : String(options.sessionId)}, ` +
          `purpose=${options?.purpose ?? 'chat'}`,
      )
    }
    return next()
  })

  // --- F11: the honey tool group ------------------------------------------
  //
  // Lets the user (or a policy caller) hand the guard literal values to treat
  // as sensitive (honey_mark), restore real values on demand (honey_restore),
  // read aggregate value-safe statistics (honey_stats), and browse the
  // substitution log in-session (honey_log). Registered with the tool registry
  // and cleaned up with the plugin fiber.
  if (enabled) {
    ctx.effect(
      () =>
        registerHoneyTools(ctx, {
          engine,
          scopeKeyFor,
          canaries,
          subLogPath: subLog?.path ?? defaultSubLogPath(),
          logFileEnabled: subLog !== undefined,
        }),
      'honey-guard:tools',
    )
  }

  // --- F12: the settings card backend --------------------------------------
  //
  // The client bundle (`src/client/`) renders the substitution log on the
  // plugin's settings card; this route is its data source. No-ops on profiles
  // without the web server (headless).
  registerHoneyLogRoute(ctx, {
    path: subLog?.path ?? defaultSubLogPath(),
    logFileEnabled: subLog !== undefined,
  })

  // --- Explicit restore surface -------------------------------------------
  //
  // Auto-restore on the inbound stream is deliberately absent (see the module
  // docstring). Consumers that own the output — a slash command, a transcript
  // renderer, a diff tool — call these to get the user's real values back.
  // `ctx.provide` makes the handle available to other plugins and commands.
  ctx.provide('honeyGuard', {
    engine,
    scopeKeyFor,
    restoreText: (scopeKey: string | undefined, text: string): string => restoreText(engine, scopeKey, text),
    restoreBlocks,
    restoreMessages,
    createTextRestorer,
    canaries,
  })

  info(`[honey-guard] loaded (enabled=${enabled}, logLevel=${logLevel})`)
  if (subLog !== undefined) {
    info(`[honey-guard] substitution log: ${subLog.path}`)
    subLog.write({ time: new Date().toISOString(), surface: 'activate', total: 0, hits: {} })
  }
}