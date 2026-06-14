import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    // E2E specs drive the built binary and need `pnpm test:e2e` (build-then-run); keep them out
    // of the default unit run so `pnpm test` stays fast and dist-independent.
    exclude: [...configDefaults.exclude, '**/*.e2e.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/**/__tests__/**', 'src/**/*.test.ts'],
      thresholds: {
        // Per-file gating (ADR-P04 / ADR-0005): a single uncovered file fails CI,
        // not just the directory aggregate.
        perFile: true,
        // Existing pure-logic layers (Sprint 00).
        'src/core/**': { branches: 100 },
        'src/config/**': { branches: 100 },
        // Future must-modules (FR-F04). These globs match zero files today, so they
        // are no-ops now and fail CLOSED the moment a file lands in them — Sprint 01+
        // cannot ship an uncovered assertions/cache/retry module by accident.
        'src/assertions/**': { branches: 100 },
        'src/cache/**': { branches: 90 },
        'src/retry/**': { branches: 90 },
        // Providers feature (ADR-PRV03/PRV04): the constitution's cost+retry ≥90% gate.
        // The legacy src/retry/** glob above matches no files — these pure modules live
        // under src/providers/, so gate them explicitly where they actually are.
        'src/providers/cost.ts': { branches: 90 },
        'src/providers/retry.ts': { branches: 90 },
        // Embeddings feature (ADR-EMB02): cosine is pure math → 100%. The XenovaEmbedder
        // wrapper is a dirty edge (live-only), so it is not gated here.
        'src/embeddings/cosine.ts': { branches: 100 },
        // Orchestrator (S8): the integration module — ≥85% branches (§2). Tested via injected
        // fake deps (no real API); the CLI composition root is covered by handleRun + live.
        'src/orchestrator/**': { branches: 85 },
        // Reporters (S9): pure RunResult -> string renderers — ≥90% branches (§2).
        'src/reporters/**': { branches: 90 },
      },
    },
  },
});
