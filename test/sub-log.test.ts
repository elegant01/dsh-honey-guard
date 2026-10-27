import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createSubLog, defaultSubLogPath } from '../src/sub-log.ts'

const dir = join(tmpdir(), `honey-sublog-${process.pid}`)
const target = join(dir, 'substitutions.jsonl')

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('createSubLog', () => {
  it('appends one JSON object per line and creates the directory', () => {
    const log = createSubLog({ path: target })
    log.write({ time: '2026-10-27T01:00:00.000Z', surface: 'pre-step', total: 2, hits: { openai_key: 1, custom: 1 } })
    log.write({ time: '2026-10-27T01:00:01.000Z', surface: 'tool ops_bash', total: 1, hits: { aws_key: 1 } })

    const lines = readFileSync(target, 'utf8').trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(String(lines[0]))).toEqual({
      time: '2026-10-27T01:00:00.000Z',
      surface: 'pre-step',
      total: 2,
      hits: { openai_key: 1, custom: 1 },
    })
    expect(JSON.parse(String(lines[1])).surface).toBe('tool ops_bash')
  })

  it('records a leak with the canary id and no secret material', () => {
    const path = join(dir, 'canary.jsonl')
    const log = createSubLog({ path })
    log.write({ time: 't', surface: 'pre-step', canary: 'AKIACANARY0000000000', sourceScope: 'agent-1', currentScope: 'agent-2' })

    const record = JSON.parse(readFileSync(path, 'utf8').trim())
    expect(record).toEqual({
      time: 't',
      surface: 'pre-step',
      canary: 'AKIACANARY0000000000',
      sourceScope: 'agent-1',
      currentScope: 'agent-2',
    })
    expect(record.total).toBeUndefined()
  })

  it('rolls the previous generation once the file passes maxBytes', () => {
    const path = join(dir, 'rolled.jsonl')
    const log = createSubLog({ path, maxBytes: 64 })
    const payload = { time: 'x'.repeat(40), surface: 'pre-step', total: 1, hits: { pem: 1 } }
    log.write(payload)
    log.write(payload)
    log.write(payload)

    const rolled = `${path}.1`
    expect(statSync(rolled).size).toBeGreaterThanOrEqual(64)
    expect(readFileSync(path, 'utf8').trimEnd().split('\n').length).toBeLessThan(3)
  })

  it('re-rolling replaces the old generation instead of failing', () => {
    const path = join(dir, 'reroll.jsonl')
    const log = createSubLog({ path, maxBytes: 32 })
    for (let i = 0; i < 12; i++) log.write({ time: `yyyy${i}`, surface: 'pre-step', total: 1, hits: {} })
    expect(statSync(`${path}.1`).size).toBeGreaterThanOrEqual(32)
    expect(statSync(path).size).toBeLessThan(64)
  })

  it('disables itself instead of throwing when the path cannot be written', () => {
    const blockedDir = join(dir, 'blocked')
    mkdirSync(blockedDir)
    writeFileSync(join(blockedDir, 'not-a-dir'), '')
    const log = createSubLog({ path: join(blockedDir, 'not-a-dir', 'sub.jsonl') })
    expect(() => log.write({ time: 't', surface: 'pre-step', total: 1, hits: {} })).not.toThrow()
    expect(() => log.write({ time: 't', surface: 'pre-step', total: 1, hits: {} })).not.toThrow()
  })

  it('defaults to the per-app state directory', () => {
    expect(defaultSubLogPath()).toBe(join(homedir(), '.dsh', 'honey-guard', 'substitutions.jsonl'))
  })
})
