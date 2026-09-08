import { defineConfig } from '@playwright/test';

/**
 * A foreign project, as far as the reporter is concerned: it enables `@plune-ai/playwright` the
 * way a README tells someone to, and nothing else about it knows Plune exists.
 *
 * The reporter is loaded from `dist`, not from source, because the thing being proved is that the
 * PUBLISHED artifact plugs into Playwright's reporter API — a source import would typecheck past
 * exactly the mistake this exists to catch.
 */
const apiUrl = process.env['PLUNE_STUB_URL'];
if (apiUrl === undefined || apiUrl === '') {
  // Without this the core would resolve its default base URL and the fixture would post a fake
  // run to the real beta deployment. A test must not be one missing variable away from that.
  throw new Error('PLUNE_STUB_URL must be set — this fixture must never reach a real deployment');
}

export default defineConfig({
  testDir: './tests',
  reporter: [
    [
      '../../dist/index.js',
      {
        apiUrl,
        token: 'stub-token',
        fallbackPath: process.env['PLUNE_FALLBACK'] ?? '.plune/pending-results.jsonl',
        externalKey: process.env['PLUNE_RUN'] ?? 'e2e-fixture',
      },
    ],
  ],
});
