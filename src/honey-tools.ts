/**
 * The honey-guard tool group: `honey_mark`, `honey_restore`, `honey_stats`.
 *
 * DSH has no slash-command registry, so the guard's operator surface is a set
 * of model-callable tools. The user asks in natural language ("把 X 标记为敏
 * 感", "把刚才的蜜罐还原回来", "看看脱敏统计"), and the model routes the
 * request to the right tool. This keeps every interaction value-safe and gives
 * the guard a self-contained control plane inside the agent loop.
 *
 * ## Value safety
 *
 * - `honey_mark` returns only a count; the marked value lives only in the
 *   engine's in-memory mapping table.
 * - `honey_restore` returns only a count. The restored real text is delivered
 *   through `exec.deferContext()` as a user-role message, so the **user** sees
 *   the real values in the transcript while the model's next request re-sanitizes
 *   them at `agent/pre-step` — the same "explicit restore" contract as
 *   `ctx.provide('honeyGuard')`.
 * - `honey_stats` returns aggregate counters only.
 *
 * @module dsh-honey-guard/honey-tools
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { HoneyEngine } from './honey-engine.ts'
import type { CanaryTracker } from './canary.ts'
import type { HoneyCategory } from './types.ts'

/** Dependency surface the tools need from the plugin activation. */
export interface HoneyToolsDeps {
  /** The mapping engine (the same instance that sanitizes outbound). */
  engine: HoneyEngine
  /** Resolve the mapping scope for an agent handle. */
  scopeKeyFor: (agent: unknown) => string | undefined
  /** The canary tracker, only needed by `honey_stats`. */
  canaries?: CanaryTracker
}

/** Tool names registered with the tool registry. */
export const HONEY_MARK_NAME = 'honey_mark'
export const HONEY_RESTORE_NAME = 'honey_restore'
export const HONEY_STATS_NAME = 'honey_stats'

/** Shared JSON Schema for the `values` argument used by mark/restore. */
const VALUES_ARGUMENT = {
  type: 'array',
  items: { type: 'string' },
  minItems: 1,
  description: 'One or more literal values',
} as const

/** JSON Schema for the arguments of `honey_mark`. */
const MARK_ARGUMENTS_SCHEMA = {
  type: 'object',
  properties: { values: VALUES_ARGUMENT },
  required: ['values'],
  additionalProperties: false,
} as const

/** JSON Schema for the arguments of `honey_restore`. */
const RESTORE_ARGUMENTS_SCHEMA = {
  type: 'object',
  properties: { values: VALUES_ARGUMENT },
  required: ['values'],
  additionalProperties: false,
} as const

/** Canonical output of `honey_mark`: a value-free count. */
const MARK_OUTPUT_SCHEMA = {
  type: 'object',
  properties: { marked: { type: 'integer', minimum: 0 } },
  required: ['marked'],
} as const

/** Canonical output of `honey_restore`: a value-free count. */
const RESTORE_OUTPUT_SCHEMA = {
  type: 'object',
  properties: { restored: { type: 'integer', minimum: 0 } },
  required: ['restored'],
} as const

/** Canonical output of `honey_stats`: aggregate counters only. */
const STATS_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    mapped: { type: 'integer', minimum: 0 },
    substituted: { type: 'integer', minimum: 0 },
    restored: { type: 'integer', minimum: 0 },
    canaries: { type: 'integer', minimum: 0 },
    canaryHits: { type: 'integer', minimum: 0 },
  },
  required: ['mapped', 'substituted', 'restored', 'canaries', 'canaryHits'],
} as const

/** Read `values` from lossless-snapshotted tool arguments, leniently. */
function readValues(args: unknown): string[] {
  const raw = (args as { values?: unknown } | undefined)?.values
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []
}

/** Build the `honey_mark` tool definition bound to one plugin activation. */
export function createHoneyMarkTool(deps: HoneyToolsDeps): ToolDefinition {
  return {
    name: HONEY_MARK_NAME,
    description:
      'Mark one or more literal values as sensitive. From now on, every occurrence ' +
      'of these values in messages or tool output is replaced with a fake honey ' +
      'token before it reaches the model. Returns how many values were marked.',
    parameters: MARK_ARGUMENTS_SCHEMA as unknown as Record<string, unknown>,
    output: {
      schema: MARK_OUTPUT_SCHEMA as never,
      render: (_args, value) => {
        const marked = typeof value === 'object' && value !== null && 'marked' in value
          ? Number((value as { marked: unknown }).marked)
          : 0
        const noun = marked === 1 ? 'value' : 'values'
        return [{ type: 'text', text: `Marked ${marked} ${noun} as sensitive.` }] as ContentBlock[]
      },
    },
    async execute(args: unknown, exec: ToolRunContext): Promise<{ marked: number }> {
      const scopeKey = deps.scopeKeyFor(exec.agent)
      const scope = deps.engine.scope(scopeKey)
      let marked = 0
      for (const value of readValues(args)) {
        if (value.length === 0) continue
        // Dedup: honeyFor returns the identical entry for a repeated value, and
        // count is the outbound-reference tally, so this also refuses to double-count.
        const entry = deps.engine.honeyFor(scope, value, 'custom')
        if (entry.count === 0) {
          entry.count += 1
          marked += 1
        }
      }
      return { marked }
    },
  }
}

/**
 * Build the `honey_restore` tool definition.
 *
 * The model passes the Honey-Tokens it currently sees; the tool turns them back
 * into the real values and delivers those values to the **user** via
 * `deferContext`, not to the model. The count goes to the model; the restored
 * transcript text goes to the session, where the next `agent/pre-step` pass
 * re-sanitizes it before the model ever sees it again.
 */
export function createHoneyRestoreTool(deps: HoneyToolsDeps): ToolDefinition {
  return {
    name: HONEY_RESTORE_NAME,
    description:
      'Restore the real values behind the given honey tokens for the current ' +
      'session. The restored values are written into the transcript for the ' +
      'user; the model keeps seeing sanitized honey tokens. Returns how many ' +
      'tokens were restored.',
    parameters: RESTORE_ARGUMENTS_SCHEMA as unknown as Record<string, unknown>,
    output: {
      schema: RESTORE_OUTPUT_SCHEMA as never,
      render: (_args, value) => {
        const restored = typeof value === 'object' && value !== null && 'restored' in value
          ? Number((value as { restored: unknown }).restored)
          : 0
        const noun = restored === 1 ? 'token' : 'tokens'
        return [{ type: 'text', text: `Restored ${restored} ${noun}.` }] as ContentBlock[]
      },
    },
    async execute(args: unknown, exec: ToolRunContext): Promise<{ restored: number }> {
      const scopeKey = deps.scopeKeyFor(exec.agent)
      const scope = deps.engine.scope(scopeKey)
      const honeys = readValues(args)
      const restoredText: string[] = []
      let restored = 0
      for (const honey of honeys) {
        if (honey.length === 0) continue
        const real = deps.engine.realFor(scope, honey)
        if (real === undefined) continue
        restoredText.push(real)
        deps.engine.emitRestoration(scopeKey, scopeCategory(scope, honey), 1)
        restored += 1
      }
      if (restoredText.length > 0) {
        // Deliver the real values to the user's transcript, not to the model.
        exec.deferContext(
          createUserMessage({
            content: [{ type: 'text', text: `[honey-guard] 已还原的敏感值：\n${restoredText.join('\n')}` }],
            // `ptc-mode` is the source kind DSH itself uses for deferred,
            // tool-produced user context; the kind union is closed, so we ride
            // the existing value rather than minting a new one.
            source: { kind: 'ptc-mode' },
          }),
        )
      }
      return { restored }
    },
  }
}

/** The category a honey token belongs to, or `custom` when unknown. */
function scopeCategory(scope: SessionHoneyMapLike, honey: string): HoneyCategory {
  const entry = scope.byHoney.get(honey)
  return entry?.category ?? 'custom'
}

/** Minimal shape of a scope bucket, enough for the restore category lookup. */
interface SessionHoneyMapLike {
  byHoney: Map<string, { category: HoneyCategory }>
}

/** Build the `honey_stats` tool definition. */
export function createHoneyStatsTool(deps: HoneyToolsDeps): ToolDefinition {
  return {
    name: HONEY_STATS_NAME,
    description:
      'Report aggregate, value-free statistics of the honey guard: how many ' +
      'values are mapped, how many substitutions and restorations happened ' +
      'process-wide, and canary status. Never returns actual values.',
    parameters: { type: 'object', properties: {}, additionalProperties: false } as unknown as Record<string, unknown>,
    output: {
      schema: STATS_OUTPUT_SCHEMA as never,
      render: (_args, value) => {
        const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
        const text = [
          `Mapped: ${String(v.mapped ?? 0)}`,
          `Substituted: ${String(v.substituted ?? 0)}`,
          `Restored: ${String(v.restored ?? 0)}`,
          `Canaries armed: ${String(v.canaries ?? 0)}`,
          `Canary hits: ${String(v.canaryHits ?? 0)}`,
        ].join(', ')
        return [{ type: 'text', text: `[honey-guard] ${text}` }] as ContentBlock[]
      },
    },
    async execute(): Promise<{
      mapped: number
      substituted: number
      restored: number
      canaries: number
      canaryHits: number
    }> {
      const s = deps.engine.stats()
      const c = deps.canaries?.stats()
      return {
        mapped: s.mapped,
        substituted: s.substituted,
        restored: s.restored,
        canaries: c?.canaries ?? 0,
        canaryHits: c?.hits ?? 0,
      }
    },
  }
}

/** Register the full tool group with the registry; returns the disposer. */
export function registerHoneyTools(ctx: ToolsRegistry, deps: HoneyToolsDeps): () => void {
  const disposers = [
    ctx.tools.register(createHoneyMarkTool(deps)),
    ctx.tools.register(createHoneyRestoreTool(deps)),
    ctx.tools.register(createHoneyStatsTool(deps)),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}

/** The minimal tool-registry surface the plugin touches. */
export interface ToolsRegistry {
  tools: { register(def: ToolDefinition): () => void }
}
