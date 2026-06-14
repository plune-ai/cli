import { defineConfig } from 'vitest/config';

// E2E suite: runs ONLY *.e2e.test.ts, which spawn the real built binary (dist/cli.js).
// Invoke via `pnpm test:e2e` (it runs `tsup` first so dist/ is fresh). No coverage — these are
// black-box process tests, not line-coverage drivers.
export default defineConfig({
  test: {
    include: ['**/*.e2e.test.ts'],
    // The binary spawns can take longer than the default 5s under cold Node starts.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
