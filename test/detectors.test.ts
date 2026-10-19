import { describe, expect, it } from 'vitest'
import { replaceDetections, scanText } from '../src/detectors/index.ts'

const AWS = 'AKIAIOSFODNN7EXAMPLE'
const GITHUB = `ghp_${'a'.repeat(36)}`
const OPENAI = `sk-${'b'.repeat(48)}`
const BEARER_TOKEN = 'A'.repeat(40)

describe('scanText categories', () => {
  it('detects an AWS access key id', () => {
    const found = scanText(`aws_key = ${AWS}`)
    expect(found.map((entry) => entry.category)).toEqual(['aws_key'])
    expect(found[0]?.value).toBe(AWS)
  })

  it('detects an OpenAI key', () => {
    expect(scanText(OPENAI)[0]?.category).toBe('openai_key')
  })

  it('detects a classic GitHub token', () => {
    expect(scanText(GITHUB)[0]?.category).toBe('github_token')
  })

  it('detects a bearer token as the credential only, not the scheme', () => {
    const prefix = 'Authorization: Bearer '
    const found = scanText(`${prefix}${BEARER_TOKEN}`)
    expect(found).toHaveLength(1)
    expect(found[0]?.category).toBe('bearer')
    expect(found[0]?.value).toBe(BEARER_TOKEN)
    // The span starts after "Bearer " so the scheme survives substitution.
    expect(found[0]?.start).toBe(prefix.length)
    expect(found[0]?.end).toBe(prefix.length + BEARER_TOKEN.length)
  })

  it('detects a complete PEM block as a single span', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADAN\n-----END PRIVATE KEY-----'
    const found = scanText(pem)
    expect(found).toHaveLength(1)
    expect(found[0]?.category).toBe('pem')
    expect(found[0]?.value).toBe(pem)
  })

  it('detects a truncated PEM header on its own', () => {
    const found = scanText('-----BEGIN RSA PRIVATE KEY-----\nMIIEvQIBADAN')
    expect(found).toHaveLength(1)
    expect(found[0]?.category).toBe('pem')
  })
})

describe('scanText boundaries', () => {
  it('ignores a key with a glued alphanumeric suffix', () => {
    expect(scanText(`${AWS}X`)).toHaveLength(0)
  })

  it('ignores a key with a glued alphanumeric prefix', () => {
    expect(scanText(`X${AWS}`)).toHaveLength(0)
  })

  it('finds nothing in ordinary prose', () => {
    expect(scanText('the quick brown fox jumps over the lazy dog')).toHaveLength(0)
  })

  it('does not start a token in the middle of a longer token', () => {
    // Glued to the previous token's tail, the `ghp_` run is not a separate
    // credential — the boundary lookbehind correctly rejects it.
    expect(scanText(`${AWS}${GITHUB}`).map((entry) => entry.category)).toEqual(['aws_key'])
  })

  it('returns multiple spans in positional order', () => {
    const found = scanText(`${AWS} then ${GITHUB}`)
    expect(found).toHaveLength(2)
    expect(found[0]!.start).toBeLessThan(found[1]!.start)
  })

  it('handles an empty string', () => {
    expect(scanText('')).toHaveLength(0)
  })
})

describe('replaceDetections', () => {
  it('replaces every span and preserves surrounding text', () => {
    const source = `a ${AWS} b ${GITHUB} c`
    const { text, replaced } = replaceDetections(source, scanText(source), () => '<X>')
    expect(replaced).toBe(2)
    expect(text).toBe('a <X> b <X> c')
  })

  it('replaces a bearer token without eating the scheme', () => {
    const source = `Authorization: Bearer ${BEARER_TOKEN}`
    const { text } = replaceDetections(source, scanText(source), () => 'FAKE')
    expect(text).toBe('Authorization: Bearer FAKE')
  })

  it('does not let a shorter replacement shift later spans', () => {
    // The first fake is shorter than the value it replaces, so an
    // offset-accumulating implementation would corrupt the second span.
    const source = `${AWS} ${GITHUB}`
    const { text } = replaceDetections(source, scanText(source), (d) => `<${d.category}>`)
    expect(text).toBe('<aws_key> <github_token>')
  })

  it('is a no-op for an empty detection list', () => {
    const { text, replaced } = replaceDetections('untouched', [], () => 'X')
    expect(text).toBe('untouched')
    expect(replaced).toBe(0)
  })
})