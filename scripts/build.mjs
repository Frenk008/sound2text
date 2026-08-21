// Build preset for the two plugin halves, mirroring the official
// packages/client/tsdown.client.ts closure-factory contract:
//   - host half: plain ESM bundle for the dsh node process
//   - client half: window.__ModuleLoader__.load({ id, factory: (require) => {...} })
//     where every cross-module import must be either inlined or listed in the
//     browser platform's shared module table (react / @deepseek-ai preloaded).
import * as esbuild from 'esbuild'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const id = pkg.name

// react & friends are shared browser platform modules: leave them as require()
// calls for the module loader to satisfy. @deepseek-ai/* must never appear
// here as a value import (type-only imports are erased at compile time).
const clientExternals = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
]

const client = await esbuild.context({
  entryPoints: ['src/client/index.tsx'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: clientExternals,
  minify: false,
  sourcemap: 'linked',
  outfile: 'lib/client.js',
  banner: {
    js: `window.__ModuleLoader__.load({\n\tid: ${JSON.stringify(id)},\n\tfactory: (require) => {\n\t\tvar module = { exports: {} };\n\t\tvar exports = module.exports;\n`,
  },
  footer: { js: 'return module.exports;\n\t}\n});' },
  logLevel: 'info',
})

const host = await esbuild.context({
  entryPoints: ['src/host/index.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  external: ['@deepseek-ai/*'],
  minify: false,
  sourcemap: 'linked',
  outfile: 'lib/host/index.js',
  logLevel: 'info',
})

await client.rebuild()
await host.rebuild()

if (process.argv.includes('--watch')) {
  await Promise.all([client.watch(), host.watch()])
} else {
  await client.dispose()
  await host.dispose()

  // The purity gate from the official preset: no @deepseek-ai value import may
  // leak into the client bundle (only the platform table may satisfy those).
  const out = readFileSync('lib/client.js', 'utf8')
  const bad = out.match(/require\("(@deepseek-ai\/[^"]+)"\)/g)
  if (bad) {
    console.error(`[purity] client bundle requires @deepseek-ai modules not in the platform table: ${bad.join(', ')}`)
    process.exit(1)
  }
  console.log('build ok: lib/client.js, lib/host/index.js')
}
