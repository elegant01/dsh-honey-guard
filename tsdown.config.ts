import { defineConfig } from 'tsdown'

/**
 * The host bundle only: the plugin installs server-side listeners on the LLM
 * stream and the tool pipeline. There is no browser/client half.
 *
 * `dts: true` emits `lib/index.d.mts` so the published manifest keeps its
 * type entry, matching what `package.json` advertises.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  dts: true,
  clean: true,
  outDir: 'lib',
})