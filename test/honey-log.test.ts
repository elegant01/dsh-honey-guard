import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  createHoneyLogTool,
  formatSubLog,
  readSubLogTail,
  HONEY_LOG_DEFAULT_LIMIT,
  HONEY_LOG_MAX_LIMIT,
  HONEY_LOG_NAME,
} from '../src/honey-log.ts'
import type { SubLogRecord } from '../src/sub-log.ts'

const dir = join(tmpdir(), `honey-log-${process.pid}`)
const target = join(dir, 'substitutions.jsonl')

const sub = (time: string, total: number, hits: Record<string, number> = {}, surface = 'pre-step'): SubLogRecord => ({
  time,
  surface,
  total,
  hits,
})

const canary: SubLogRecord = {
  time: '2026-10-28T12:35:10.000Z',
  surface: 'tool ops_bash',
  canary: 'AKIACANARY0000000000',
  sourceScope: 'agent-1',
  currentScope: 'agent-2',
}

function writeLog(records: SubLogRecord[]): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(target, records.map((r) => JSON.stringify(r)).join('\n') + '\n')
}

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('readSubLogTail', () => {
  it('returns undefined when the file does not exist', () => {
    expect(readSubLogTail(join(dir, 'missing.jsonl'), 10)).toBeUndefined()
  })

  it('returns the newest records in file order with the file-wide total', () => {
    writeLog([
      sub('2026-10-27T01:00:00.000Z', 1, { openai_key: 1 }),
      sub('2026-10-27T01:00:01.000Z', 2, { aws_key: 2 }),
      sub('2026-10-27T01:00:02.000Z', 3, { pem: 3 }),
    ])
    const tail = readSubLogTail(target, 2)
    expect(tail?.total).toBe(3)
    expect(tail?.records.map((r) => r.total)).toEqual([2, 3])
  })

  it('skips malformed lines instead of failing', () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(target, '{"time":"t","surface":"pre-step","total":1}\nnot json\n{"broken"\n')
    const tail = readSubLogTail(target, 10)
    expect(tail?.total).toBe(1)
  })
})

describe('formatSubLog', () => {
  it('explains how to enable the sink when no file exists and logging is off', () => {
    const md = formatSubLog(undefined, '/x/substitutions.jsonl', false)
    expect(md).toContain('logFile: true')
    expect(md).toContain('/x/substitutions.jsonl')
  })

  it('distinguishes a missing file from a disabled sink', () => {
    const md = formatSubLog(undefined, '/x/substitutions.jsonl', true)
    expect(md).not.toContain('logFile: true')
    expect(md).toContain('还不可读')
  })

  it('renders a day-grouped timeline with icons outside tables', () => {
    const md = formatSubLog(
      {
        records: [
          canary,
          sub('2026-10-28T12:32:01.000Z', 2, { openai_key: 1, custom: 1 }),
          { time: '2026-10-27T12:37:15.000Z', surface: 'activate' },
        ],
        total: 3,
      },
      '/x/substitutions.jsonl',
      true,
    )
    expect(md).toContain('共 **3** 条记录，显示最近 **3** 条')
    expect(md).toContain('🚨 **金丝雀告警** · tool ops_bash · `AKIACANARY0000000000` agent-1 → agent-2')
    expect(md).toContain('🔁 **替换 ×2** · pre-step · openai_key ×1，custom ×1')
    expect(md).toContain('✅ **插件装配**')
    // Two distinct day groups.
    expect(md.match(/\*\*\d{4}-\d{2}-\d{2}\*\*/g)?.length).toBe(2)
    // No markdown table: icons must survive every renderer.
    expect(md).not.toContain('|')
  })

  it('notes when the shown records are history from a disabled sink', () => {
    const md = formatSubLog({ records: [sub('2026-10-27T01:00:00.000Z', 1, { pem: 1 })], total: 1 }, '/x', false)
    expect(md).toContain('logFile` 未开启')
  })

  it('collapses consecutive activate records into one counted row', () => {
    const md = formatSubLog(
      {
        records: [
          { time: '2026-10-28T12:00:03.000Z', surface: 'activate' },
          { time: '2026-10-28T12:00:02.000Z', surface: 'activate' },
          { time: '2026-10-28T12:00:01.000Z', surface: 'activate' },
          sub('2026-10-27T12:00:00.000Z', 1, { pem: 1 }),
        ],
        total: 4,
      },
      '/x',
      true,
    )
    // One row for the whole run, keeping the newest timestamp.
    expect(md.match(/✅ \*\*插件装配\*\*/g)).toHaveLength(1)
    expect(md).toContain('本轮共装配 3 次')
    // Non-consecutive activates are not merged.
    const md2 = formatSubLog(
      {
        records: [
          { time: '2026-10-28T12:00:03.000Z', surface: 'activate' },
          sub('2026-10-28T12:00:02.000Z', 1, { pem: 1 }),
          { time: '2026-10-28T12:00:01.000Z', surface: 'activate' },
        ],
        total: 3,
      },
      '/x',
      true,
    )
    expect(md2.match(/✅ \*\*插件装配\*\*/g)).toHaveLength(2)
  })

  it('renders emitted honey tokens as a value-safe sub-line', () => {
    const record: SubLogRecord = {
      time: '2026-10-28T12:00:00.000Z',
      surface: 'pre-step',
      total: 1,
      hits: { openai_key: 1 },
      honeys: ['sk-honey0000000000000000000000000000000000000000abcd'],
    }
    const md = formatSubLog({ records: [record], total: 1 }, '/x', true)
    expect(md).toContain('🔑 `sk-honey0000000000000000000000000000000000000000abcd`')
  })

  it('collects the emitted honey tokens into the sanitize report, deduped', async () => {
    const { HoneyEngine } = await import('../src/honey-engine.ts')
    const { createTextRewriter } = await import('../src/outbound.ts')
    const engine = new HoneyEngine()
    const report: { hits: Record<string, number>; total: number; honeys?: string[] } = { hits: {}, total: 0 }
    const rewrite = createTextRewriter(engine, 'agent-1', report as never)
    const AWS = 'AKIA6ZIZMAQ1THGODZNQ'
    const out = rewrite(`${AWS} and again ${AWS}`)
    expect(report.total).toBe(2)
    expect(report.honeys).toHaveLength(1)
    expect(out).not.toContain(AWS)
    expect(out).toContain(report.honeys![0]!)
  })
})

describe('honey_log tool', () => {
  it('exposes the stable tool name', () => {
    expect(HONEY_LOG_NAME).toBe('honey_log')
  })

  it('shows the newest records first and reports shown/total', async () => {
    writeLog([
      sub('2026-10-27T01:00:00.000Z', 1, { openai_key: 1 }),
      sub('2026-10-28T01:00:01.000Z', 2, { aws_key: 2 }),
    ])
    const tool = createHoneyLogTool({ subLogPath: target, logFileEnabled: true })
    const result = (await tool.execute({}, undefined as never)) as { shown: number; total: number; markdown: string }
    expect(result.shown).toBe(2)
    expect(result.total).toBe(2)
    // File order is oldest first; the timeline must show the newest on top.
    expect(result.markdown.indexOf('替换 ×2')).toBeLessThan(result.markdown.indexOf('替换 ×1'))
  })

  it('honors and clamps the limit argument', async () => {
    writeLog(Array.from({ length: 5 }, (_, i) => sub(`2026-10-27T01:00:0${i}.000Z`, i + 1)))
    const tool = createHoneyLogTool({ subLogPath: target, logFileEnabled: true })
    const one = (await tool.execute({ limit: 2 }, undefined as never)) as { shown: number }
    expect(one.shown).toBe(2)
    const clamped = (await tool.execute({ limit: 10_000 }, undefined as never)) as { shown: number }
    expect(clamped.shown).toBe(5)
    expect(HONEY_LOG_MAX_LIMIT).toBe(100)
    expect(HONEY_LOG_DEFAULT_LIMIT).toBe(20)
  })

  it('renders the markdown through the output renderer', async () => {
    writeLog([sub('2026-10-27T01:00:00.000Z', 1, { pem: 1 })])
    const tool = createHoneyLogTool({ subLogPath: target, logFileEnabled: true })
    const value = (await tool.execute({}, undefined as never)) as { markdown: string }
    const blocks = tool.output?.render({}, value) as Array<{ type: string; text: string }>
    expect(blocks[0]?.text).toBe(value.markdown)
    expect(blocks[0]?.text).toContain('honey-guard 脱敏日志')
  })
})
