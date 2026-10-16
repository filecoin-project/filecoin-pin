// Bundle the CLI entry into a single file so a published install runs the exact dependency
// tree this repo tests, pnpm patches included. Library exports (dist/core/*, index) stay unbundled.
import { build } from 'esbuild'

// Bundle from the compiled module (version already stamped) into the bin entry; `tsc` keeps
// emitting dist/cli.js as a plain module, so the two never overwrite each other.
const entry = new URL('../dist/cli.js', import.meta.url)
const out = new URL('../dist/filecoin-pin.js', import.meta.url)

const result = await build({
  entryPoints: [entry.pathname],
  outfile: out.pathname,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  // Native modules cannot be bundled; they stay regular dependencies.
  external: ['node-datachannel'],
  // Dependencies compiled from CommonJS call `require` at runtime.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  logLevel: 'warning',
})
if (result.warnings.length > 0) {
  process.exitCode = 1
}
