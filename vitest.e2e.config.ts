import { defineConfig } from 'vitest/config';

// E2E suite: runs ONLY src/**/*.e2e.test.ts, which spawn the real built binary (dist/cli.cjs). Not `**`: that
// would also pick up packages/playwright/e2e, which loads packages/playwright/dist, a folder only the
// adapter's own CI step builds, so on a clean runner this step would fail before that step runs.
// Invoke via `pnpm test:e2e` (it runs `tsup` first so dist/ is fresh). No coverage — these are
// black-box process tests, not line-coverage drivers.
export default defineConfig({
  test: {
    include: ['src/**/*.e2e.test.ts'],
    // The binary spawns can take longer than the default 5s under cold Node starts.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
