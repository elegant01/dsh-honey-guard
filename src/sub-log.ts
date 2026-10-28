/**
 * Opt-in JSONL sink for guard activity.
 *
 * dsh-desktop has no surface for plugin `info` logs — only `warn` reaches the
 * user as a notification — so a guard that logs substitutions through
 * `ctx.logger` alone cannot be audited from the operator's side. This writes
 * one machine-readable line per event under `~/.dsh/honey-guard/`.
 *
 * Same value-safety contract as the logger: categories, counts and canary ids
 * only. The canary is a fake AWS key that no live mapping ever produces, so
 * naming it leaks nothing real.
 *
 * @module dsh-honey-guard/sub-log
 */

import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** One line of the substitution log. */
export interface SubLogRecord {
  /** ISO-8601 wall-clock time. */
  time: string
  /** Where the pass happened: `activate`, `pre-step`, `tool <name>`, ... */
  surface: string
  /** Substitutions performed; absent on canary records. */
  total?: number
  /** Per-category counts; absent on canary records. */
  hits?: Partial<Record<string, number>>
  /**
   * The fake values the pass emitted, present only when the operator opted in
   * with `logHoneys`. Honey tokens are fake by construction — but they make
   * log↔transcript correlation possible, which is exactly why the default
   * keeps them out.
   */
  honeys?: string[]
  /** Foreign canary id, present only on leak records. */
  canary?: string
  /** Scope that armed the canary. */
  sourceScope?: string
  /** Scope whose text contained it. */
  currentScope?: string
}

export interface SubLog {
  /** Append one record; a failing filesystem disables the sink silently. */
  write: (record: SubLogRecord) => void
  /** Where records go, for the startup log line. */
  readonly path: string
}

/** Default sink location, alongside the other plugins' per-app state. */
export function defaultSubLogPath(): string {
  return join(homedir(), '.dsh', 'honey-guard', 'substitutions.jsonl')
}

/** Build a rolling JSONL sink. `maxBytes` bounds one generation of the file. */
export function createSubLog(options: { path?: string; maxBytes?: number } = {}): SubLog {
  const path = options.path ?? defaultSubLogPath()
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024
  let disabled = false

  return {
    path,
    write(record: SubLogRecord): void {
      if (disabled) return
      try {
        mkdirSync(dirname(path), { recursive: true })
        try {
          if (statSync(path).size >= maxBytes) {
            // Windows rename cannot overwrite, so drop the previous generation first.
            try {
              unlinkSync(`${path}.1`)
            } catch {
              /* nothing rolled yet */
            }
            renameSync(path, `${path}.1`)
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        appendFileSync(path, `${JSON.stringify(record)}\n`)
      } catch {
        // A read-only or missing directory must never break a sanitize pass.
        disabled = true
      }
    },
  }
}
