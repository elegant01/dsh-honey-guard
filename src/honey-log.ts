/**
 * The `honey_log` tool: an in-session viewer for the substitution log.
 *
 * The JSONL sink (`sub-log.ts`) is value-safe by construction, so its records
 * can be rendered verbatim into the transcript — surfaces, category counts and
 * canary ids only, never real or honey values. What was missing was a way to
 * *read* it without leaving the chat; this tool is that way.
 *
 * ## Rendering
 *
 * The output mimics a GitHub-style audit timeline: records grouped by local
 * day (newest first), one line per event with an icon. Icons stay outside any
 * table — several markdown renderers drop emoji inside table cells.
 *
 * @module dsh-honey-guard/honey-log
 */

import { readFileSync } from 'node:fs'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { defaultSubLogPath, type SubLogRecord } from './sub-log.ts'

/** Tool name registered with the tool registry. */
export const HONEY_LOG_NAME = 'honey_log'

/** How many records a bare `honey_log` call shows. */
export const HONEY_LOG_DEFAULT_LIMIT = 20

/** Hard cap so a huge log cannot flood the transcript. */
export const HONEY_LOG_MAX_LIMIT = 100

/**
 * Read the newest `limit` records from a JSONL sink.
 *
 * Returns `undefined` when the file is missing or unreadable. Malformed lines
 * are skipped; `total` counts the well-formed records in the whole file so the
 * header can say "showing 20 of 132". One generation is at most `logFileMaxMb`,
 * so reading the whole file to tail it is cheap.
 */
export function readSubLogTail(
  path: string,
  limit: number,
): { records: SubLogRecord[]; total: number } | undefined {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  const records: SubLogRecord[] = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    try {
      const record = JSON.parse(line) as SubLogRecord
      if (typeof record === 'object' && record !== null && typeof record.surface === 'string') {
        records.push(record)
      }
    } catch {
      // A torn final line (crash mid-append) must not hide the rest of the log.
    }
  }
  return { records: records.slice(-limit), total: records.length }
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** `2026-10-28` in local time, for the day-group heading. */
function dayLabel(time: string): string {
  const d = new Date(time)
  if (Number.isNaN(d.getTime())) return '未知时间'
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** `14:32:01` in local time, for the row prefix. */
function timeLabel(time: string): string {
  const d = new Date(time)
  if (Number.isNaN(d.getTime())) return time
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** One timeline row for a record, icons deliberately outside of any table. */
function formatRecord(record: SubLogRecord): string {
  const at = `\`${timeLabel(record.time)}\``
  if (record.canary !== undefined) {
    const from = record.sourceScope ?? '未知来源'
    const to = record.currentScope ?? '未分组的扫描'
    return `- ${at} 🚨 **金丝雀告警** · ${record.surface} · \`${record.canary}\` ${from} → ${to}`
  }
  if (record.surface === 'activate') {
    return `- ${at} ✅ **插件装配**`
  }
  const hits = Object.entries(record.hits ?? {})
    .map(([category, count]) => `${category} ×${count}`)
    .join('，')
  const total = record.total ?? 0
  const honeys = (record.honeys ?? []).map((h) => `\`${h}\``).join(' ')
  return (
    `- ${at} 🔁 **替换 ×${total}** · ${record.surface}${hits === '' ? '' : ` · ${hits}`}` +
    (honeys === '' ? '' : `\n  - 🔑 ${honeys}`)
  )
}

/**
 * Collapse runs of consecutive `activate` records into one row. Every app
 * launch writes one, and a log that only ever activated would otherwise be a
 * wall of identical lines; the newest timestamp is kept, the run length shown
 * as `×N`.
 */
function collapseActivates(records: SubLogRecord[]): Array<SubLogRecord & { run?: number }> {
  const out: Array<SubLogRecord & { run?: number }> = []
  for (const record of records) {
    const last = out[out.length - 1]
    if (record.surface === 'activate' && last !== undefined && last.surface === 'activate') {
      last.run = (last.run ?? 1) + 1
      // Input is newest-first: keep the newest (first-seen) timestamp.
      continue
    }
    out.push({ ...record })
  }
  return out
}

export interface SubLogView {
  /** Records to display, newest first. */
  records: SubLogRecord[]
  /** Well-formed records in the whole file. */
  total: number
}

/**
 * Render the tail of the log as a day-grouped markdown timeline.
 *
 * The empty states double as documentation: when no file exists they say why
 * (sink disabled, or nothing recorded yet) and how to turn it on.
 */
export function formatSubLog(view: SubLogView | undefined, path: string, logFileEnabled: boolean): string {
  const heading = '### 🍯 honey-guard 脱敏日志'
  if (view === undefined) {
    if (!logFileEnabled) {
      return [
        heading,
        '',
        '还没有日志文件——落盘日志默认是关闭的。在 `cordis.patch.yml` 里开启：',
        '',
        '```yaml',
        'config:',
        '  logFile: true',
        '```',
        '',
        `开启后每次替换会记录到 \`${path}\`（只含类别与计数，不含真实值）。`,
      ].join('\n')
    }
    return [heading, '', `日志已开启，但 \`${path}\` 还不可读——可能还没有发生替换，或目录不可写。`].join('\n')
  }
  if (view.records.length === 0) {
    return [heading, '', '日志文件存在，但里面还没有记录。'].join('\n')
  }

  const lines = [heading, '', `共 **${view.total}** 条记录，显示最近 **${view.records.length}** 条 · \`${path}\``, '']
  let day = ''
  for (const record of collapseActivates(view.records)) {
    const label = dayLabel(record.time)
    if (label !== day) {
      if (day !== '') lines.push('')
      day = label
      lines.push(`**${label}**`, '')
    }
    const row = formatRecord(record)
    lines.push(record.run === undefined ? row : `${row}（本轮共装配 ${record.run} 次）`)
  }
  if (!logFileEnabled) {
    lines.push('', '> ℹ️ 当前 `logFile` 未开启——这些是历史记录，新的替换不会再写入。')
  }
  return lines.join('\n')
}

/** JSON Schema for the arguments of `honey_log` (range checked in execute). */
const LOG_ARGUMENTS_SCHEMA = {
  type: 'object',
  properties: {
    limit: {
      type: 'integer',
      description: `How many recent records to show (1-${HONEY_LOG_MAX_LIMIT}, default ${HONEY_LOG_DEFAULT_LIMIT})`,
    },
  },
  additionalProperties: false,
} as const

/** Canonical output of `honey_log`: counts for the model, markdown for the user. */
const LOG_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    shown: { type: 'integer' },
    total: { type: 'integer' },
    markdown: { type: 'string' },
  },
  required: ['shown', 'total', 'markdown'],
} as const

/** What `honey_log` needs from the plugin activation. */
export interface HoneyLogDeps {
  /** Where the sink writes; defaults to the per-app state directory. */
  subLogPath?: string
  /** Whether the sink is currently on, so empty states can say why. */
  logFileEnabled?: boolean
}

function normalizeLimit(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : HONEY_LOG_DEFAULT_LIMIT
  return Math.min(HONEY_LOG_MAX_LIMIT, Math.max(1, n <= 0 ? HONEY_LOG_DEFAULT_LIMIT : n))
}

/** Build the `honey_log` tool definition bound to one plugin activation. */
export function createHoneyLogTool(deps: HoneyLogDeps = {}): ToolDefinition {
  return {
    name: HONEY_LOG_NAME,
    description:
      'Show the most recent honey-guard substitution log records as a timeline. ' +
      'The log is value-safe: it contains event kinds, category counts and ' +
      'canary ids only, never real or honey values. Returns the rendered ' +
      'markdown along with how many records were shown.',
    parameters: LOG_ARGUMENTS_SCHEMA as unknown as Record<string, unknown>,
    output: {
      schema: LOG_OUTPUT_SCHEMA as never,
      render: (_args, value) => {
        const markdown = typeof value === 'object' && value !== null && 'markdown' in value
          ? String((value as { markdown: unknown }).markdown)
          : ''
        return [{ type: 'text', text: markdown }] as ContentBlock[]
      },
    },
    async execute(args: unknown): Promise<{ shown: number; total: number; markdown: string }> {
      const limit = normalizeLimit((args as { limit?: unknown } | undefined)?.limit)
      const path = deps.subLogPath ?? defaultSubLogPath()
      const tail = readSubLogTail(path, limit)
      // Newest first, like an audit-log timeline; the file itself is oldest first.
      const view = tail === undefined ? undefined : { records: [...tail.records].reverse(), total: tail.total }
      const markdown = formatSubLog(view, path, deps.logFileEnabled === true)
      return { shown: view?.records.length ?? 0, total: view?.total ?? 0, markdown }
    },
  }
}
