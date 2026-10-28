import { defineConfig } from 'tsdown'

/**
 * Two bundles:
 *
 * 1. The host bundle (`lib/index.mjs`): server-side listeners on the LLM
 *    stream, the tool pipeline, and the `/api/honey-guard/log` route.
 * 2. The client bundle (`lib/client/index.cjs`, wrapped by
 *    `scripts/wrap-client.mjs`): the settings-card UI. It runs in the browser,
 *    so `process.env.NODE_ENV` must be replaced at build time (React branches
 *    on it) and the DSH UI packages stay external — the host shell provides
 *    them through `__ModuleLoader__`.
 */
const CLIENT_ENV_DEFINE = {
  'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
}

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    target: 'node22',
    dts: true,
    clean: true,
    outDir: 'lib',
  },
  {
    entry: ['src/client/index.tsx'],
    format: ['cjs'],
    target: 'es2022',
    outDir: 'lib/client',
    define: CLIENT_ENV_DEFINE,
    deps: {
      neverBundle: [
        '@deepseek-ai/dsh-client-ui-primitives',
        '@deepseek-ai/dsh-client-ui-renderer',
        '@deepseek-ai/dsh-client-ui-settings-plugins',
        '@deepseek-ai/dsh-client-ui-slots',
        '@deepseek-ai/dsh-client-locale',
        'react',
        'react/jsx-runtime',
        'react/jsx-dev-runtime',
      ],
    },
  },
])
