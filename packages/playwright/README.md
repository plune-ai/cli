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
  externalKey: `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? '1'}`, // several processes → one run
  batchSize: 100,                          // results per request (max 500)
  fallbackPath: '.plune/pending-results.jsonl',
  apiUrl: 'https://beta-api.plune.ai',     // or PLUNE_API_URL
}]
```

Keep the token out of this list: it comes from `PLUNE_TOKEN` or what `plune login` saved. Playwright
writes every reporter's options into its JSON report, so a token set here travels with any such
report a CI job keeps as an artifact.

## From CI, without editing the config

A committed config cannot know the run key of a job that does not exist yet, so the environment
fills in what you left out. Anything set in the config file wins.

| Variable | What it does |
|---|---|
| `PLUNE_TOKEN` | the API token — so a CI job need not run `plune login` |
| `PLUNE_RUN` | the shared run key: every process with the same value lands in one run |
| `PLUNE_CONFIGURATION` | the combination this job runs, `Browser=Chrome;Operating system=Windows`: its results land under that combination of the run (see [A matrix](#a-matrix-one-run-a-combination-per-job)) |
| `PLUNE_API_URL` | the deployment to report to |
| `PLUNE_SHARED_RUN` | this process is one of several — do not close the run |
| `PLUNE_SHARD` | `k/N`: this process is shard k of N; it reports itself done and the run closes when all N have (implies `PLUNE_SHARED_RUN`) |
| `PLUNE_PROCEED` | the job closes the run itself, later |
| `PLUNE_BATCH_SIZE` | results per request (default 500, max 500) |
| `PLUNE_UPLOAD_CONCURRENCY` | files uploaded at once (1 to 32, default 4) |
| `PLUNE_UPLOAD_RETRIES` | retries of a file's request after a 429 with `Retry-After` (0 to 20, default 6) |
| `PLUNE_FALLBACK` | where unsent batches are written |
| `PLUNE_RUN_TITLE` | what to call the run in the list (default: `<directory> · 2026-09-15 15:26 · ci`) |
| `PLUNE_ENV` | where it ran — `staging`, `prod`, a preview name |
| `PLUNE_LABELS` | comma-separated marks: `smoke,nightly` |
| `PLUNE_CREATE` | offer tests Plune has no case for to the review queue |
| `PLUNE_FULL_RUN` | this run is the whole suite: a case it used to report and did not is marked detached |

Flags are read by value, not by presence: `PLUNE_PROCEED=0` in a matrix cell means off.

The first shard to set a title owns it; a shard arriving later fills a field the first one left
empty rather than overwriting it. Blank entries in `PLUNE_LABELS` are dropped — `a,,b` is a template
that had nothing for the middle slot, not a request for an empty label.

`PLUNE_CREATE=1` sends every test that resolved to no case to the review queue — the keys it was
looked up by, its title, its file and line, and how it went. Never steps and never an expected
result: a reporter sees a test's result, not its source, and a body nobody wrote is exactly what the
queue exists to keep out. A person decides whether the project tracks the test; approving attaches
the keys, so the next run resolves instead of offering it again.

`PLUNE_FULL_RUN=1` is the reporter's word that nothing was filtered out — not `-g`, not a file
argument, not `--only-changed`. When such a run finishes with every expected test reported, the
platform marks the active cases this reporter used to report and did not this time as **detached**
(kept, with their history; the run is named as the reason), and prints how many. A later result on
a detached case makes it active again on its own. Set it on the CI job that runs everything and
nowhere else; a run that lost a shard never detaches anything.

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

## A matrix: one run, a combination per job

The jobs of a matrix of browsers and systems report into one run, each under its own combination of
configuration values, when they share `PLUNE_RUN` and each names its cell in `PLUNE_CONFIGURATION`:

```yaml
strategy:
  matrix:
    browser: [Chrome, Firefox]
    os: [Windows, macOS]
env:
  PLUNE_RUN: ${{ github.run_id }}-${{ github.run_attempt }}
  PLUNE_SHARED_RUN: 1
  PLUNE_CONFIGURATION: "Browser=${{ matrix.browser }};Operating system=${{ matrix.os }}"
```

`PLUNE_SHARED_RUN` keeps each job from closing the run its siblings still report into; close it
once at the end with `plune run finish <id>`.

`PLUNE_CONFIGURATION` is `Group=Value` pairs split by `;`, with the names of the groups and values
as in Settings → Configurations. Case does not matter, spaces around a name or a value are dropped,
and so is an empty pair (`;;`, a `;` at the end); a value may hold `=`, since a pair splits at its
first one. Every results batch carries it, and Plune files the results under that combination of the
run: one the run already has (a run launched from the dashboard with configurations, joined by its
key), or one it adds. A value that is not in Settings is taken as sent, marked "not in the list".
Unset or blank, the batch is sent as before.

- A pair without `=`, without a group or without a value, or one group named twice, is a
  configuration error: the reporter sends nothing and says why.
- Every job of a run names the same groups. Plune refuses with 422 a batch that names other groups,
  or one that would take the run past its limits (25 combinations, 40 000 results to expect); the
  reporter prints the platform's message as it came, and the batch goes to the fallback file, which
  keeps the combination for `plune run report`.

## How a result finds its test case

In order, first match wins:

1. a `PluneId` annotation on the test — names the case outright;
2. a `@P<id>` token in the title — the same statement, where you can see it in the report. The id
   follows `@P` with **no space**: `@Ptc-1a2b`;
3. an `application/plune.metadata+json` attachment — for a fixture or helper that knows the id, or
   a key from another tool: `{"id": "tc-1a2b"}` or `{"keys": [{"kind": "qase", "value": "Q-9"}]}`;
4. an entry for the test's `path-title` in the mapfile `plune/ids.json` (what `plune ids --write`
   writes), so a case id survives renaming the test without editing the source. Looked up under the
   directory the run starts in; `PLUNE_IDS_FILE` or the `idsFile` option names another path. A missing
   file is skipped, an invalid one is warned about once and skipped;
5. the Playwright test id (`playwright-id`), stable across shards and merges;
6. the file and title path (`path-title`) — the spec file relative to your `testDir`, then each
   `describe` and the test title, e.g. `cart.spec.ts#cart#rejects a negative quantity`.

```ts
test('rejects a negative quantity', { annotation: { type: 'PluneId', description: 'tc-1a2b' } },
  async ({ page }) => { /* … */ });
```

A result whose test matches no case is **not** sent and **not** invented — a made-up id would
write into somebody else's history. The run summary says how many there were.

## What the browser reported: console errors, page errors, failed and slow requests

Import `test` from the fixture entry instead of `@playwright/test`, and each test that opens a browser
collects what its browser context reported:

```ts
import { test, expect } from '@plune-ai/playwright/fixture';
```

A project that already has its own `test` merges the fixtures in, either way:

```ts
import { mergeTests } from '@playwright/test';
import { test as findings } from '@plune-ai/playwright/fixture';
export const test = mergeTests(myTest, findings);        // Playwright 1.39 and later

import { findingsFixtures } from '@plune-ai/playwright/fixture';
export const test = myTest.extend(findingsFixtures);
```

What is collected:

| Kind | When | What is kept |
| --- | --- | --- |
| `console` | a `console.error` in a page | the text |
| `page_error` | an uncaught error in a page | the error's message |
| `request_failed` | an answer with status 400 or above, or no answer at all | method, path, the status and the duration when there was an answer |
| `request_slow` | an answer under 400 that took the threshold or longer | method, path, status, duration |

Two options, set as any Playwright option (`use` in the config, or `test.use` in a file):

| Option | Default | Meaning |
| --- | --- | --- |
| `pluneFindings` | `true` | `false` turns the collection off |
| `pluneSlowRequestMs` | `3000` | how long a request takes, in milliseconds, before it is slow |

What is never read from a request or a response: headers, bodies, cookies, post data. A request's own
address is cut to its path before it leaves the test process (`https://shop.example/api/cart?token=…`
is kept as `/api/cart`). Only `http:` and `https:` requests count. A test keeps its first 20 findings by time
and counts the rest.

**An address written into a text** (a console line, an error message) is cut too, by its shape. The text is
read word by word, a word being a run of characters with no space, quote (`"`, `'`, `` ` ``) or angle bracket
in it, and in each word:

1. a `?` followed by a name and `=` cuts the word there; a name is letters, digits, `_`, `-`, `.`, `[`, `]`
   and `%` (`?id=`, `?user-id=`, `?ids[]=`) (`api.example/y?id=5` is kept as `api.example/y`,
   `localhost:3000/a?x=1` as `localhost:3000/a`, `./api?x=1` as `./api`);
2. after `http://`, `https://`, `ws://` or `wss://` the word is cut at the first `?` or `#`, and a user and
   password before the host are removed (`GET https://api.example/y?email=… failed` is kept as
   `GET https://api.example/y failed`);
3. after a `/`, `./` or `../` that starts the word (or follows `(`, `[`, `{`, `=`, `:`, `,` or `;`) the word is
   cut at the first `?` or `#` (`/cb#access_token=…` is kept as `/cb`).

What is cut is removed, not masked. Two limits of a rule by shape: a value that holds a raw space, quote or
angle bracket ends the word there, and what follows it is kept (`/search?q=anna smith` is kept as
`/search smith`); and on an address with no scheme and no leading slash, a query with no `name=`
(`api.example/y?abc`) or a fragment (`api.example/y#token`) is not recognised and is kept. The cut runs to the
end of the word, so punctuation right after an address goes with it. Only the first 4000 characters of a text
are read, without the word that limit falls inside (a text of one word longer than that is not sent, only
counted), and the result is cut to 300.

Two things are told by Chromium's wording, and hold for Chromium only. A request the page itself aborted (a
navigation away) is not reported as failed when its error is `net::ERR_ABORTED`; another browser words a
cancelled request differently, and there it may be reported as failed. And the console line Chromium prints for
every failed request, «Failed to load resource: …», is dropped because the request is already there; another
browser's line of the same kind is kept as a console finding.

The fixture needs Playwright 1.38 or later for the events it listens to (`weberror` is the newest); this
package asks for 1.44 or later anyway.

**What is masked, and what is not.** A console text, an error message and a path go through the masking the
code snapshot uses, before they leave the test process; a text is masked with its line breaks still in it,
then its addresses are cut, then its lines are joined. It replaces with a `‹…›` marker:

- a value with a well-known form: a GitHub token (`ghp_…`, `github_pat_…`), a key starting `sk-`,
  `sk_live_…` or `rk_test_…`, an npm token (`npm_…`), a Google key (`AIza…`), a Plune token (`plune_…`), an AWS
  access key id (`AKIA…`), a Slack token (`xox…`), a JWT, a private key block;
- the value after `Bearer`, and after `Basic` or `Token` when it looks encoded;
- a quoted value given to a name that says credential (`password = '…'`, `apiKey: "…"`, `setToken('…')`);
- the value of a parameter whose name says credential (`?token=…`, `&api_key=…`, `&session=…`), where the
  address around it was not recognised and cut as above;
- the value of an `Authorization`, `Cookie` or `…session…` header written at the start of a line
  (`Cookie: sid=…` on a line of its own; not one in the middle of a sentence);
- the user and password of an address (`https://user:pass@host`), and the value of a `PLUNE_…=` variable.

Nothing else is. A password, a key of a form not listed, a personal detail or a customer's data that a page
writes to its console as plain words (`login failed for anna@example.com with hunter2`) is sent as written,
and so is an identifier in a path (`/reset/8f3a9c…`). A page that logs such things needs `pluneFindings: false`
for those tests, or a fix in the page.

A test that opens no browser context collects nothing, and no browser is opened for it. A context a test
makes itself with `browser.newContext()` is not listened to. The fixture never fails a test and does not wait
at its end for an answer still arriving: a response that had not finished when the test ended is not reported.

The findings travel as one attachment of the test, `plune-findings` (`application/plune.findings+json`).
It is an attachment like any other, so it is also in Playwright's own HTML, JSON and blob reports and in a
trace, **for a passing test too**. It holds what is described above and nothing more: for each finding its
kind, the cleaned text or the method, path, status and duration, and the time it happened; and the count of
what was left out.

The reporter reads it and sends the findings with the result of that attempt, each with the top-level
`test.step` it happened in, **only when the attempt did not pass**: Plune shows them under a failure. The
attachment itself is not uploaded as a file of the result and is not listed among the failure's artifacts.
A Plune that does not know the field yet (an older self-hosted one) refuses the batch once; the reporter
sends it again without the findings, says so in one line, and sends none for the rest of the run. No result
is lost to it.

## Screenshots

Every screenshot a test keeps as a file — Playwright's `screenshot` option, `testInfo.attach` with a
`path`, the images of a failed `toHaveScreenshot` — is uploaded to its result in Plune, for a test
that passed as well as one that failed. So a run in Plune shows each test with what it looked at,
under the name it was attached with: `testInfo.attach('checkout', { path })` arrives as
`checkout.png`.

Plune takes PNG, JPEG and WebP, up to 2 MB a file and 20 a result. An image outside those limits is
skipped: the run summary counts it and says why, once per reason. Traces, videos and other files
need a storage bucket (see below); an image attached as a `body` rather than a file is not uploaded
— attach it with `path`. A screenshot that does not arrive never costs its result or your run's exit
code.

## JSON and text files

What a test attaches as JSON or plain text — the answer of an API, a log — is uploaded to its result
as well, beside the screenshots and for a test that passed as much as one that failed. Attach it with
a `body` or with a `path`; both are read:

```ts
await testInfo.attach('api-response', { body: JSON.stringify(data), contentType: 'application/json' });
await testInfo.attach('server.log', { path: 'logs/server.log', contentType: 'text/plain' });
```

Name the type: `application/json` or `text/plain` (a log is `text/plain`, whatever its file is
called). An attachment that names none is not uploaded, and its extension is not guessed at;
Markdown, HTML and CSV are not uploaded as text either. Plune takes UTF-8 text without NUL
bytes, up to 512 KiB a file and 10 a result — apart from the screenshots' 20. A text outside those
limits, an empty one, or one whose name starts with an underscore is skipped: the run summary counts
it and says why, once per reason. The reporter sends a file as it is; Plune cleans the credentials it
recognises out of a text before it keeps it. A file that does not arrive never costs its result or
your run's exit code.

A text attached as a `body` exists only in memory: it is uploaded once Plune has stored the result,
and is never written to `.plune/pending-results.jsonl`, so a result sent again with `plune run report`
goes without it.

## Traces and videos: your own bucket

A trace or a video is too big for Plune's own storage. Once your project has a storage bucket
connected in Plune, the reporter uploads them, and every other file a test kept, straight into it.
Ask Playwright to keep them in `playwright.config.ts`:

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  retries: 1,
  reporter: [['list'], ['@plune-ai/playwright']],
  use: {
    trace: 'on-first-retry', // the trace of the first retry of a failed test
    video: 'retain-on-failure', // the video of a failed test, dropped when it passes
  },
});
```

A trace is kept only when the test is retried, so `retries` must be at least 1 for `on-first-retry`
to produce one; `trace: 'retain-on-failure'` keeps one for every failed attempt without retries.

Each file goes to its own short-lived link Plune hands out, from disk, up to four at a time; a file of
100 MB is never read into memory. The links are write keys to your bucket, so they are never
printed: not in the log, not in an error. The first time a run finds the bucket it says so in one
line, and the summary reads `N file(s) uploaded to your bucket`, with `, K skipped` and
`, M failed to upload` when there are any.

The limits in a bucket are larger than in Plune's storage: 10 MiB for an image, 5 MiB for a text,
50 MiB for any other file, 100 MiB for a trace or a video, and 30 files a result. A file over its
limit, or one the bucket refuses, is a warning that names the file and a code. It never costs the
result or your run's exit code. Without a bucket, a trace or a video is not stored: the log says so
once, naming the first one, and the summary counts them.

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
