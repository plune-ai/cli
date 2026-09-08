import { defineConfig } from 'tsup';

/**
 * The published `@plune-ai/playwright` has **no runtime dependencies**, and this file is why.
 *
 * `@plune-ai/cli/reporter-core` is a devDependency linked from the workspace and compiled INTO
 * the bundle. Depending on it at runtime instead would drag the whole CLI — a native SQLite build,
 * two provider SDKs, an argument parser — into the tree of every Playwright project that wanted
 * to report results (feature ADR C1/0001).
 *
 * `@playwright/test` never lands here either: the adapter imports only its types.
 */
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm', 'cjs'],
  target: 'node20',
  dts: true,
  clean: true,
  splitting: false,
  shims: true,
  // A regex, not the bare name: the import is `@plune-ai/cli/reporter-core`, and tsup matches
  // these against the whole specifier — so the plain string silently matched nothing. It only
  // looked like it worked because tsup bundles devDependencies by default, which is a fact
  // about a default rather than a promise anyone made.
  noExternal: [/^@plune-ai\/cli/],
  external: ['@playwright/test'],
});
