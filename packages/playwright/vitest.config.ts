import { defineConfig, configDefaults } from 'vitest/config';

// The e2e spec spawns the real Playwright runner against `dist`, which takes seconds rather than
// milliseconds. `pnpm test` stays fast; `pnpm test:e2e` runs it.
export default defineConfig({
  test: {
    // The fixture holds Playwright specs, which vitest will happily collect and then fail to
    // run — `test.describe` is not its `describe`. They belong to the runner the e2e spawns.
    exclude: [...configDefaults.exclude, '**/*.e2e.test.ts', 'e2e/fixture/**'],
  },
});
