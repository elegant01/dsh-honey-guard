/**
 * Backward-compatible entry for the `honey_mark` tool.
 *
 * The full tool group (`honey_mark` / `honey_restore` / `honey_stats`) lives in
 * `honey-tools.ts`; this module re-exports the mark tool under its original
 * name so earlier imports and tests keep working.
 *
 * @module dsh-honey-guard/honey-mark
 */

export {
  HONEY_MARK_NAME,
  createHoneyMarkTool,
  registerHoneyTools,
  createHoneyRestoreTool,
  createHoneyStatsTool,
  HONEY_RESTORE_NAME,
  HONEY_STATS_NAME,
} from './honey-tools.ts'
export type { HoneyToolsDeps, ToolsRegistry } from './honey-tools.ts'
