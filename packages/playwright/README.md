# @plune-ai/playwright

Report Playwright results to [Plune](https://plune.ai).

Add one line to your Playwright config and your runs, results and failures show up in Plune —
without touching a single test.

## Install

```bash
npm install --save-dev @plune-ai/playwright
npx plune login          # from @plune-ai/cli — saves your API token
```

The package has **no runtime dependencies**. It asks only for the `@playwright/test` you already
have.

## Use

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  reporter: [['list'], ['@plune-ai/playwright']],
});
```

That is the whole setup. Options, if you want them:

```ts
['@plune-ai/playwright', {
  externalKey: process.env.GITHUB_RUN_ID,  // several processes → one run
  batchSize: 100,                          // results per request (max 500)
  fallbackPath: '.plune/pending-results.jsonl',
  apiUrl: 'https://beta-api.plune.ai',     // or PLUNE_API_URL
  token: process.env.PLUNE_TOKEN,          // or whatever `plune login` saved
}]
```

## Sharding

Give every shard the same `externalKey` (or set `PLUNE_RUN`) and they land in one Plune run
instead of four:

```yaml
env:
  PLUNE_RUN: ${{ github.run_id }}-${{ github.run_attempt }}
```

A shard **never closes the run** — it cannot know the others have finished. Whoever does know
closes it: your `merge-reports` step, or `plune run finish <id>`. Until then the run reads as
still running, which is the truth.

## How a result finds its test case

In order, first match wins:

1. a `PluneId` annotation on the test — names the case outright;
2. the Playwright test id (`playwright-id`), stable across shards and merges;
3. the file and title path (`path-title`), e.g. `tests/cart.spec.ts#cart#rejects a negative quantity`.

```ts
test('rejects a negative quantity', { annotation: { type: 'PluneId', description: 'tc-1a2b' } },
  async ({ page }) => { /* … */ });
```

A result whose test matches no case is **not** sent and **not** invented — a made-up id would
write into somebody else's history. The run summary says how many there were.

## When Plune is unreachable

Nothing is lost and nothing fails. An unreachable platform, a refused token or an already-closed
run all append the batch to `.plune/pending-results.jsonl` and let your test run finish with its
own exit code. The reporter prints one line saying what happened.

## What it does not decide

The status. Playwright's own word — `passed`, `failed`, `timedOut`, `interrupted`, `skipped` —
goes to Plune as-is, and Plune maps it per project. So your team can decide that a timeout counts
as `broken` (the default) or as something else, and change its mind, without waiting for a release
of this package.

## Licence

MIT
