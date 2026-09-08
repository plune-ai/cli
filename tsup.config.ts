import { defineConfig } from 'tsup';

// Two build targets (ADR-S10-03):
//   1. CLI binary  — dist/cli.cjs, executable (#! shebang), no .d.ts.
//   2. Public API  — dist/index.{js,cjs} + dist/index.d.ts, NO shebang (it is required(), not run).
// `skipNodeModulesBundle` keeps dependencies external (required from node_modules at runtime) —
// essential for native modules like better-sqlite3 that esbuild cannot bundle, and it keeps the
// public bundle free of CLI-only deps (commander is never imported by src/index.ts → NFR-3).
//
// COLD-START (NFR-1): the CLI is CJS-only ON PURPOSE. esbuild leaves CJS `require()` of the heavy
// deps (transformers, better-sqlite3, provider SDKs) INSIDE lazy init functions, so the dynamic
// import() in each command action stays lazy → `plune --version` is ~100ms. An ESM bundle hoists
// those imports to the top (eager), blowing the 300ms budget (~630ms measured). See cli.ts.
export default defineConfig([
  {
    entry: { cli: 'src/cli.ts' },
    format: ['cjs'],
    target: 'node20',
    banner: { js: '#!/usr/bin/env node' },
    clean: true,
    dts: false,
    outDir: 'dist',
    splitting: false,
    shims: true,
    skipNodeModulesBundle: true,
  },
  {
    // Two library entries, and `reporter-core` is separate from `index` for the reason `exports`
    // lists it separately: an adapter bundles what it imports, and importing the package root
    // would pull the CLI's dependency graph into a project that only wanted to report results
    // (feature ADR C1/0001). Nothing in `src/index.ts` re-exports it, so the two never merge.
    entry: { index: 'src/index.ts', 'reporter-core': 'src/reporter-core/index.ts' },
    format: ['esm', 'cjs'],
    target: 'node20',
    // No banner: this is a library entry, imported/required — not an executable.
    clean: false, // the cli target already cleaned dist/
    dts: true,
    outDir: 'dist',
    splitting: false,
    shims: true,
    skipNodeModulesBundle: true,
  },
]);
