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

## From CI, without editing the config

A committed config cannot know the run key of a job that does not exist yet, so the environment
fills in what you left out. Anything set in the config file wins.

| Variable | What it does |
|---|---|
| `PLUNE_TOKEN` | the API token — so a CI job need not run `plune login` |
| `PLUNE_RUN` | the shared run key: every process with the same value lands in one run |
| `PLUNE_API_URL` | the deployment to report to |
| `PLUNE_SHARED_RUN` | this process is one of several — do not close the run |
| `PLUNE_PROCEED` | the job closes the run itself, later |
| `PLUNE_BATCH_SIZE` | results per request (default 100, max 500) |
| `PLUNE_FALLBACK` | where unsent batches are written |
| `PLUNE_RUN_TITLE` | what to call the run in the list |
| `PLUNE_ENV` | where it ran — `staging`, `prod`, a preview name |
| `PLUNE_LABELS` | comma-separated marks: `smoke,nightly` |
| `PLUNE_CREATE` | offer tests Plune has no case for to the review queue |

Flags are read by value, not by presence: `PLUNE_PROCEED=0` in a matrix cell means off.

The first shard to set a title owns it; a shard arriving later fills a field the first one left
empty rather than overwriting it. Blank entries in `PLUNE_LABELS` are dropped — `a,,b` is a template
that had nothing for the middle slot, not a request for an empty label.

`PLUNE_CREATE=1` sends every test that resolved to no case to the review queue — the keys it was
looked up by, its title, its file and line, and how it went. Never steps and never an expected
result: a reporter sees a test's result, not its source, and a body nobody wrote is exactly what the
queue exists to keep out. A person decides whether the project tracks the test; approving attaches
the keys, so the next run resolves instead of offering it again.

`PLUNE_GROUP` is **not supported yet** — a group of runs is a Plune feature that does not exist, and
a group of one run means nothing. Setting it prints a line saying it was ignored, rather than
accepting it and quietly dropping it. If you report to a deployment older than run titles, the
reporter says that too: the run is recorded in full, the description is not.

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
2. a `@P<id>` token in the title — the same statement, where you can see it in the report. The id
   follows `@P` with **no space**: `@Ptc-1a2b`;
3. an `application/plune.metadata+json` attachment — for a fixture or helper that knows the id, or
   a key from another tool: `{"id": "tc-1a2b"}` or `{"keys": [{"kind": "qase", "value": "Q-9"}]}`;
4. the Playwright test id (`playwright-id`), stable across shards and merges;
5. the file and title path (`path-title`) — the spec file relative to your `testDir`, then each
   `describe` and the test title, e.g. `cart.spec.ts#cart#rejects a negative quantity`.

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
