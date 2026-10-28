/**
 * The honey-guard settings card: an in-app view of the substitution log.
 *
 * Mounted on the `plugins.bundle.config` slot (设置 → 插件 → dsh-honey-guard).
 * Data comes from `GET /api/honey-guard/log`, which serves the same value-safe
 * JSONL records the `honey_log` tool reads — surfaces, category counts and
 * canary ids only, so rendering them here leaks nothing.
 *
 * The layout mirrors the in-chat timeline: day groups, one row per event,
 * newest first. Inline styles keep the client bundle dependency-free (the
 * host's __ModuleLoader__ has no CSS channel of its own).
 */

import { useCallback, useEffect, useState } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'

/** One record of `GET /api/honey-guard/log`; mirrors SubLogRecord server-side. */
interface LogRecord {
  time: string
  surface: string
  total?: number
  hits?: Record<string, number>
  /** Fake values the pass emitted; present only under the logHoneys opt-in. */
  honeys?: string[]
  canary?: string
  sourceScope?: string
  currentScope?: string
}

interface LogResponse {
  ok?: boolean
  path?: string
  logFileEnabled?: boolean
  total?: number
  records?: LogRecord[]
  fileExists?: boolean
}

const pad = (n: number): string => String(n).padStart(2, '0')

function dayLabel(time: string): string {
  const d = new Date(time)
  if (Number.isNaN(d.getTime())) return '未知时间'
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function timeLabel(time: string): string {
  const d = new Date(time)
  if (Number.isNaN(d.getTime())) return time
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function hitsText(hits: Record<string, number> | undefined): string {
  return Object.entries(hits ?? {})
    .map(([category, count]) => `${category} ×${count}`)
    .join('，')
}

const styles = {
  card: {
    border: '1px solid rgba(127, 127, 127, 0.25)',
    borderRadius: 8,
    padding: '12px 14px',
    background: 'rgba(127, 127, 127, 0.06)',
    fontSize: 13,
    lineHeight: 1.6,
  },
  header: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 },
  title: { fontWeight: 600, flex: 1 },
  dim: { opacity: 0.65 },
  timeline: { maxHeight: 260, overflowY: 'auto' as const },
  day: { fontWeight: 600, margin: '10px 0 4px', fontSize: 12, opacity: 0.8 },
  row: { display: 'flex', gap: 8, alignItems: 'baseline', padding: '2px 0' },
  time: { fontFamily: 'monospace', opacity: 0.6, flexShrink: 0, fontSize: 12 },
  canary: { color: '#d97706' },
  code: {
    fontFamily: 'monospace',
    fontSize: 12,
    background: 'rgba(127, 127, 127, 0.12)',
    borderRadius: 4,
    padding: '1px 4px',
  },
  notice: {
    marginTop: 8,
    padding: '6px 8px',
    borderRadius: 6,
    background: 'rgba(217, 119, 6, 0.12)',
    fontSize: 12,
  },
}

/** One timeline row for a log record. */
function RecordRow({ record }: { record: LogRecord & { run?: number } }) {
  if (record.canary !== undefined) {
    return (
      <div style={styles.row}>
        <span style={styles.time}>{timeLabel(record.time)}</span>
        <span>🚨</span>
        <span style={styles.canary}>
          <strong>金丝雀告警</strong>
          <span style={styles.dim}> · {record.surface} · </span>
          <span style={styles.code}>{record.canary}</span>
          <span style={styles.dim}>
            {' '}
            {record.sourceScope ?? '未知来源'} → {record.currentScope ?? '未分组的扫描'}
          </span>
        </span>
      </div>
    )
  }
  if (record.surface === 'activate') {
    return (
      <div style={styles.row}>
        <span style={styles.time}>{timeLabel(record.time)}</span>
        <span>✅</span>
        <span>
          <strong>插件装配</strong>
          {record.run !== undefined && <span style={styles.dim}>（本轮共装配 {record.run} 次）</span>}
        </span>
      </div>
    )
  }
  const hits = hitsText(record.hits)
  return (
    <div style={styles.row}>
      <span style={styles.time}>{timeLabel(record.time)}</span>
      <span>🔁</span>
      <span>
        <strong>替换 ×{record.total ?? 0}</strong>
        <span style={styles.dim}>
          {' '}
          · {record.surface}
          {hits === '' ? '' : ` · ${hits}`}
        </span>
        {(record.honeys ?? []).map((honey) => (
          <span key={honey} style={{ ...styles.code, marginLeft: 6 }}>
            🔑 {honey}
          </span>
        ))}
      </span>
    </div>
  )
}

/**
 * Collapse runs of consecutive `activate` records into one row — every app
 * launch writes one, and they flood the timeline otherwise. Input is
 * newest-first; the newest timestamp is kept and the run length shown.
 */
function collapseActivates(records: LogRecord[]): Array<LogRecord & { run?: number }> {
  const out: Array<LogRecord & { run?: number }> = []
  for (const record of records) {
    const last = out[out.length - 1]
    if (record.surface === 'activate' && last !== undefined && last.surface === 'activate') {
      last.run = (last.run ?? 1) + 1
      continue
    }
    out.push({ ...record })
  }
  return out
}

/** Group records by local day; input is already newest-first. */
function DayGroups({ records }: { records: LogRecord[] }) {
  const groups: Array<{ day: string; items: Array<LogRecord & { run?: number }> }> = []
  for (const record of collapseActivates(records)) {
    const day = dayLabel(record.time)
    const last = groups[groups.length - 1]
    if (last !== undefined && last.day === day) {
      last.items.push(record)
    } else {
      groups.push({ day, items: [record] })
    }
  }
  return (
    <div style={styles.timeline}>
      {groups.map((group) => (
        <div key={group.day}>
          <div style={styles.day}>{group.day}</div>
          {group.items.map((record, i) => (
            <RecordRow key={`${record.time}-${i}`} record={record} />
          ))}
        </div>
      ))}
    </div>
  )
}

/** The settings card body: header + timeline + empty-state hints. */
export function HoneyGuardCard() {
  const [state, setState] = useState<{ status: 'loading' | 'ok' | 'error'; body?: LogResponse }>({
    status: 'loading',
  })

  const refresh = useCallback(async () => {
    setState((prev) => ({ ...prev, status: 'loading' }))
    try {
      const res = await fetch('/api/honey-guard/log?limit=50')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = (await res.json()) as LogResponse
      setState({ status: 'ok', body })
    } catch {
      setState({ status: 'error' })
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const body = state.body
  const records = body?.records ?? []
  const enabled = body?.logFileEnabled === true

  return (
    <div style={styles.card}>
      <div style={styles.header}>
        <StateDot
          state={state.status === 'error' ? 'error' : state.status === 'loading' ? 'ongoing' : enabled ? 'done' : 'idle'}
        />
        <span style={styles.title}>🍯 脱敏日志</span>
        {body !== undefined && (
          <span style={styles.dim}>
            共 {body.total ?? 0} 条{records.length < (body.total ?? 0) ? `，显示最近 ${records.length} 条` : ''}
          </span>
        )}
        <Button variant="ghost" size="sm" onClick={() => void refresh()}>
          刷新
        </Button>
      </div>

      {state.status === 'error' && (
        <div style={styles.dim}>日志接口不可达——当前 profile 可能没有 web 服务，或插件未装配。</div>
      )}

      {state.status !== 'error' && body !== undefined && !body.fileExists && !enabled && (
        <div>
          <div style={styles.dim}>还没有日志文件——落盘日志默认关闭。在 cordis.patch.yml 里开启：</div>
          <pre style={{ ...styles.code, display: 'block', padding: 8, margin: '6px 0 0' }}>
            {'config:\n  logFile: true'}
          </pre>
        </div>
      )}

      {state.status !== 'error' && body !== undefined && !body.fileExists && enabled && (
        <div style={styles.dim}>日志已开启，还没有记录——发生替换后会出现在这里。</div>
      )}

      {records.length > 0 && <DayGroups records={records} />}

      {records.length > 0 && !enabled && <div style={styles.notice}>当前 logFile 未开启——以上是历史记录，新的替换不会再写入。</div>}

      {body?.path !== undefined && body.path !== '' && (
        <div style={{ ...styles.dim, marginTop: 8, fontSize: 12 }}>
          日志文件：<span style={styles.code}>{body.path}</span>（只含类别与计数，不含真实值）
        </div>
      )}
    </div>
  )
}
