import { defineConfig } from 'vitest/config';

// Spawns `playwright test` over the fixture project. Slow by nature — a real runner starting up.
export default defineConfig({
  test: {
    include: ['**/*.e2e.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
