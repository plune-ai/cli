# Changelog

All notable changes to `@plune-ai/cli` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each section is dated from the release tag it names. `0.2.1`, `0.2.2` and `0.2.3` were published from
tags whose committed `package.json` still read `0.2.0` — the publish job takes the version from the
tag (see 0.2.2), so the tag is the authority for what shipped, not the committed file.

## [Unreleased]

## [0.28.0] - 2026-10-22

### Added

- **`plune run start --name` and `plune run exec --name` (plune-ai/plune#1715).** Same as `plune run import --name`: the text is the run's title and wins over `PLUNE_RUN_TITLE`; without it the name is what it was. For `exec`, the reporter inside the command joins the run and keeps that title.
- **`plune verify` (plune-ai/plune#1291).** Compares the project's automated cases with the Playwright tests in the code and prints both sides of the drift: cases the code no longer has (already `detached`, or one a full run would detach) and tests with no case yet. A test is matched by the id it names (`PluneId` annotation or `@P<id>`), else by its `path-title` key. Read-only: nothing is written to the platform or to your source. `--from <file>` takes a saved `playwright test --list --reporter=json`, `--fail-on-drift` exits 1 on any difference. Playwright only; writing ids back into the source is not part of this.
- **`plune run import --name <text>` (plune-ai/plune#1715).** Names the run in the list; before, every import was called after the current folder and two imports from one folder could not be told apart. Without the flag the name is what it was (`PLUNE_RUN_TITLE`, then folder, time and where it ran). Renaming runs already created is not part of this.
- **`plune run --cache-strict` and `--cache-max-age` (plune-ai/plune#1696).** `--cache-strict` answers every row from the cache and never calls the model for a completion (judge assertions still do); a row with no entry ends the run with exit code `5` and a list of those rows (`--no-cache` with it, or with `--cache-max-age`, is exit `2`). `--cache-max-age 12h` (also `90s`, `15m`, `7d`) opens the existing expiry. The console report and `summary.cache` in the JSON now say how many rows came from the cache, from the model, or had no entry, and the tokens and cost the cache saved.

### Changed

- **`better-sqlite3` is an optional dependency (plune-ai/plune#1716).** When its prebuilt binary cannot be fetched and the machine has no compiler, `npm i -g @plune-ai/cli` used to stop on the node-gyp build; now npm skips the module, the install succeeds, and `plune run` prints `completion cache disabled` and runs with the cache off. README lists the install requirements and the rebuild step.
- **The completion cache keeps only usable answers (plune-ai/plune#1696).** An empty answer, one cut off by the token limit, one carrying a provider error, or one without the format the eval expects (JSON for `json-schema`) is no longer stored; a stored answer that no longer has that format is deleted and the model is asked once in the same run. `CACHE_POLICY_VERSION` is now part of the cache key, so raising it makes older entries unreachable (the run reports `cache policy changed, N entries are stale` once). Entries written by 0.27.0 and earlier are dropped on the first run.

## [0.27.0] - 2026-10-18

### Added

- **`plune run import` has a time limit of its own (plune-ai/plune#1473).** The whole import gives up after 600 s by default (`--timeout <seconds>` or `PLUNE_IMPORT_TIMEOUT`, the flag wins; `0` turns the limit off). Before, a platform that stopped answering kept the command waiting until CI killed the job, and the run it had opened stayed in progress. On a timeout the command tries to send `terminate` for the run it opened (waiting up to 15 s for it), prints one line that says the platform may have received part of the results and whether the run was terminated, and exits 1. A run shared with other jobs (`--key` with `PLUNE_SHARD`, `PLUNE_PROCEED` or `PLUNE_SHARED_RUN`) is left open and named; if the run was never started the line says its id is not known. Not run against a real platform.

## [0.26.0] - 2026-10-18

### Added

- **`plune requirements import` maps several tables in one run (plune-ai/plune#1624).** Repeat `--table "<n>:key=ID,text=Requirement,fixed-category=functional"`, each with its own columns (`key`, `title`/`text`, `description`, `priority`, `category`, `type`, `status`, `criteria`, `fixed-category`, `fixed-type`); the request carries them as `tables`, and `--map-priority`, `--type` and `--map-category` are shared. `--table 0 --key-column ...` works as before; the two forms are not mixed (exit 2). The plan names the table of each row, shows the new skip reasons (`template placeholder`, `first on line N, again on line M`), and says `this file is an empty template` when the platform reports one (exit 0, like any skipped row). Not run against a real platform.

### Changed

- **Faster result upload (plune-ai/plune#1393).** Result batches of one run go four at a time (the first alone, so a refused token or a closed run is met by one request), over reused connections; the default batch is still 500, so 7 000 results are 14 requests, not 70. Ordering is kept: the run starts before the first result and closes after the last is answered; a failed batch still goes to the fallback file. Gain estimated from measured round trips, not measured on a real platform.

## [0.25.0] - 2026-10-17

### Added

- **`plune requirements import <file.md>` (#113, plune-ai/plune#1594).** Requirements from a Markdown file, in the two steps of the
  platform's import (plune-ai/plune#1621). With no mapping flags it lists the tables and sections the file has (and which look like
  requirements) and exits 0; `--table <n>` with `--key-column`, `--title-column` or `--text-column`, `--description-column`,
  `--priority-column`, `--category-column`, `--type-column`, `--status-column`, `--criteria-column`, `--map-priority`, `--map-category`,
  or `--sections <heading|n>` with `--unit`, `--key-prefix`, `--priority-from`, runs a **dry run** (`create 3 · update 0 · unchanged 12 ·
  skip 1`, the rows by action with line and reason, the value tables, what was not imported); `--yes` writes it, `--json` prints the raw
  answer. Impossible flag combinations and a file over 1 MiB are refused before any request (exit 2); a platform without the routes gets
  one message ("This platform does not support requirements import yet") instead of a stack trace. `--project <id>` / `PLUNE_PROJECT`
  names the project when the account has several. Not run against a platform that has the routes (not deployed yet).
- **`PLUNE_SHARD=k/N` closes a sharded run by itself (#110).** A shard that sets it uploads as before, then sends
  `{"event":"finish","shardIndex":k,"shardsExpected":N}`; the platform (plune-ai/plune#1601) closes the run when N distinct shards have
  reported. It implies `PLUNE_SHARED_RUN`. The job prints `plune: shard k of N done — R of N shards reported` as its last line and
  `plune: run closed` when it was the Nth; exit codes do not depend on the counts, and `--fail-on-failures` gates on the summary the closing
  shard receives. A value that is not `k/N` with `1 <= k <= N <= 1000`, or a different N than the run already holds (409
  `shards_mismatch`), is a configuration error and fails. A platform without the feature (400, or an answer without counts) gets one
  warning and the run is left open as before. Unset: nothing changes. The Playwright reporter honours it too. Not run against a
  platform that has the feature (not deployed yet).

### Changed

- **A trusted source's first import records the results of the cases it creates (plune-ai/plune#1581).** `plune run import --create`
  (and the reporters, with offering on) created the cases of a trusted source but sent nothing for them, so the run showed zeros and
  the new cases had empty histories until a second import. When the platform answers `created` with the new case's `id`, the result of
  that test now goes to the same run, files included, and the summary reads `3 added as cases (trusted source) and their results
  recorded`. A result that cannot be delivered goes to the fallback file like any other. A platform that returns no `id` behaves and
  reads as before. `queued`, `duplicate`, `refused` and `known` tests are never resent. Needs the platform half of the same issue.
- **Files are uploaded 16 at once by default, not 4 (#81).** The bulk routes of 0.23.0 took the announce and confirm steps off the
  per-file path, but the PUTs of the bytes to the bucket (and every call of the one-by-one fallback) still waited in a pool of 4,
  so 1 280 screenshots stayed bound by the round trip. The platform limits do not bind there: the bulk routes allow 120 requests
  and 6 000 files a minute per user, and the bytes go to the customer's bucket. `PLUNE_UPLOAD_CONCURRENCY` and
  `--upload-concurrency` still set 1 to 32 (the flag wins); a 429 still waits out its `Retry-After` for every request of the
  import, so a platform that pushes back is not hammered harder. The files line now reads `(16 at once, ...)`. Not measured
  against the real platform.

### Fixed

- **A quota 429 is told by the `quota` object in the body, not by a missing `Retry-After` (#111).** plune-ai/plune#1599 adds
  `Retry-After` to the quota 429 that has a reset time (the daily runs quota); the CLI would have read it as a throttle, waited
  and retried for nothing. A 429 whose JSON body has a `quota` object now stops at once, with the exit code as before, and the
  message names the limit: `quota exceeded (runs: 50 of 50 used, resets 2026-10-18T00:00:00.000Z) — <server words>`. A 429
  with `Retry-After` and no `quota` is still a throttle (waited, capped at 60 s, retried); a 429 with neither is still read as a
  quota, so an older platform behaves as before. A 429 whose body is not JSON does not crash. Release this before or together
  with the platform change.

## [0.24.0] - 2026-10-16

### Added

- **`plune sync` sends `Idempotency-Key` on `POST /v1/runs`.** The key is the SHA-256 (hex) of the exact request body, so
  repeating an upload whose answer was lost gives the same run instead of a second one, and other content gets another
  key. A repeat answered `200` is a success with the same result as a fresh upload; `422` (the key was used with another
  body) and `409` (its run is in the Bin) are reported as errors. A server that does not know the header ignores it.

### Changed

- **`plune run import` says why tests wait and how to skip it.** After `--create` on a source the project does not trust,
  the line "N unknown test(s) offered to the review queue" now adds that they wait there for a decision and do not count
  on the run until approved, and names the source to add under Settings → Trusted sources (`junit`, `allure` or
  `playwright`). Before, the run showed zeros with no explanation and the field there gives no hint of the name.

## [0.23.0] - 2026-10-15

### Changed

- **`plune run import` (and the Playwright reporter) upload a report's files through the bulk routes of the platform.** Up to
  100 files go in one `uploads-batch` request with the SHA-256 of each (read as a stream), the bytes go to the bucket as before
  (or through `direct-batch` for a project without one), and `complete-batch` confirms them. Each file has its own verdict: a
  refused one is reported and retried alone, the rest of its request is not affected, and a file the platform already has is
  `exists` and is not sent again. A 429 on a request waits out its `Retry-After`. Against a platform without the bulk routes
  (404) the CLI falls back to one request per file, decided by the answer. The files line gains `N already there (skipped)` and
  the number of requests made to Plune. On a local fake server with 20 ms per request, 2760 files of 70 KB took 5522 requests
  and 65 s one by one, and 56 requests and 24 s in batches; the real server has not been measured.

## [0.22.0] - 2026-10-15

### Added

- **`PLUNE_UPLOAD_CONCURRENCY` and `--upload-concurrency` for `plune run import`.** Files in flight at once were fixed at 4;
  with a round trip above ~160 ms a report of thousands of screenshots is bound by that, not by bandwidth. The variable (and
  the flag, which wins) takes 1 to 32, default 4; anything else is ignored with a warning. The Playwright reporter reads
  the variable too.
- **`PLUNE_UPLOAD_RETRIES`** (0 to 20, default 6, was 2): how often a file's request is retried after a 429 with a `Retry-After`.
  The header is read as seconds or an HTTP date and capped at 60 s; the wait gets up to 50 % jitter, and every other request
  of the process waits through the same pause instead of finding the limit for itself. A 429 with no `Retry-After` is still
  the quota and is not retried; a platform that is down is still tried twice (three times for a bucket).
- **A line about the files before the summary**: `plune: files — N uploaded, N skipped, N retried, N dropped, in 41.2 s (16 at once)`.
  A dropped file is still reported without its file and still does not change the exit code; it is now counted.

### Changed

- **Results go in batches of 500, not 100 (plune-ai/plune#1393).** The platform's ceiling per request is 500 and the 8 MiB
  byte packing of a call is unchanged, so a run of 7 000 results is 14 requests instead of 70 (about 2.3 times faster per
  result against a local platform; the time on a real network is not measured). `PLUNE_BATCH_SIZE` still sets it, up to 500.
  The "N of M results sent" line only appears for a run larger than one batch, so it now starts at 501 results (it did at
  101); `PLUNE_BATCH_SIZE=100` keeps the old cadence.

## [0.21.0] - 2026-10-13

### Added

- **`plune run grep <run>`: a run's automated cases as one `--grep` (#85).** The command Plune shows for an
  automated run's «Re-run N failed» — `npx playwright test --grep "$(plune run grep <run-id> --failed)"` — and the
  one for a mixed run launched without a plan — `PLUNE_RUN=<key> npx playwright test --grep "$(plune run grep <key>)"`
  — now work as they are. The pattern is built as `plune plan grep` builds a plan's (the same `grepFragment`, joined
  with `|`, `(?!)` when nothing is taken), from `GET /v1/runs/:id/cases`: what the run expected or holds a result of,
  manual cases left out. `<run>` is the run's id or its key (`rk_` and ten hex, found with `GET /v1/runs?key=`);
  anything else is refused with exit 2 before a request is sent, and a key no run carries exits 1. `--failed` asks
  the platform for the cases whose latest result it counts as failed or broken (`?status=failed,broken`), so a muted
  case's failure is left out by the platform's rule, not by a copy of it in the CLI. stderr says how many cases were
  taken and how many left out. Needs a Plune with plune-ai/plune#1333; an older one answers 404.

## [0.20.0] - 2026-10-13

### Changed

- **`plune ingest`: a Cairn case whose request got no answer arrives as `blocked` (plune-ai/plune#1327).** Cairn's
  API evidence records a transport error when a request gets no response after the retries; the case used to be
  sent as `failed`, blaming the product for an unreachable target. It now carries the verdict `blocked`, so the
  platform records a `blocked` result. Needs a Plune that accepts the verdict (plune-ai/plune#1330); an older one
  refuses the whole ingest with a validation error.

## [0.19.0] - 2026-10-12

### Added

- **`--fail-on-failures`: a release gate that honours mute (plune-ai/plune#1247).** `plune run finish`,
  `plune run exec`, `plune run import` and `plune sync` take the flag, and the exit code is then the
  platform's verdict on the run rather than the runner's. The run commands read the summary the platform
  freezes at `finish`, which the `finish` event already answers with (the CLI used to throw it away); `sync`
  reads it with one `GET /v1/runs/:id/summary` after the upload. The platform counts a muted case's
  `failed` or `broken` under `muted`, so a mute set in Plune keeps the gate green without the CLI holding a
  muted flag of its own. Exit 1 on `failed + broken > 0` and on any expected case that never reported
  (`notRun`); `blocked` and `skipped` do not fail it; exit 1 when there is no verdict at all (the platform
  could not be reached, the finish was refused, the run was left open or terminated). `run exec` keeps the
  command's own exit code when no result reached the run and nothing was expected of it. A second
  `plune run finish` on a finished run is not refused by the platform: it answers with the summary frozen
  the first time, so the gate reads the same verdict. Without the flag every command exits as before, and
  `plune run` (local evals) does not change. `RunSession.finish()` in `@plune-ai/cli/reporter-core` now
  resolves to that frozen summary (`FrozenSummary`), or `undefined` when the platform answered with none.

## [0.18.0] - 2026-10-12

### Fixed

- **The run key in the docs and the reporter examples carries the attempt (cli#78).** GitHub Actions'
  "Re-run failed jobs" reuses `GITHUB_RUN_ID` and increments `GITHUB_RUN_ATTEMPT`. A key built from the
  run id alone sent the second attempt at a run that is already closed, so the platform took none of its
  results and they stayed on the runner in `.plune/pending-results.jsonl`. `README.md`,
  `packages/playwright/README.md` and the `plune run` examples now use
  `"$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"` (the Playwright option reads
  `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? '1'}`), and the note in
  `docs/guide/cli.md` says what actually happens without it, instead of claiming the re-run would
  overwrite the original run's results.
- **The quota detail no longer carries the raw token (cli#79).** A 429 without `Retry-After` is
  classified as `invalid` and reported as `quota exceeded (no Retry-After)` with the server's own words
  appended — but they were appended raw, while the same response's text one line above went through
  `scrub()`. A proxy or a gateway that echoes the bearer token back in an error page put it into a CI
  log anyone with read access can scroll. The appended text is scrubbed now, and a test holds it there.
- **A deleted run is recoverable for 30 days, and only an owner of the project can bring it back
  (cli#80).** The server keeps it for 30 days, not six months, and the way back is Settings → Bin
  rather than a request to Plune. `plune run delete` prints the sentence the platform's own dialogs
  use, its `--help` description and the `README.md` command table say 30 days, and the command's
  comment no longer speaks of six months.

### Changed

- **The run summary counts `blocked` and `skipped` apart from `failed` (plune-ai/plune#1245).** A row
  that reports `inconclusive` (ADR 0045) now counts by that word, not by its assertions or its error:
  a blocked row whose assertions failed is `blocked`, not `failed`, and a skipped row with an error is
  `skipped`, not `errored`. This is the order the platform already uses when it stores the row. **The
  numbers change** for any run with such rows: `failed` and `errored` go down, `blocked` and `skipped`
  go up, and `passed + failed + errored + blocked + skipped` is `total`. Runs without `inconclusive`
  rows count exactly as before. `Summary.blocked` and `Summary.skipped` are optional in the contract, so
  a RunResult written before them still validates and `schemaVersion` stays 1; `plune run` always
  writes both. The console line and the markdown table show them only when they are not zero, so an
  all-pass report reads as it did. The summary, both reporters and `plune diff` now share one
  classifier instead of three copies, so a blocked row cannot become a regression in the diff either.
  Exit codes are unchanged: only `failed` (1) and `errored` (2) move them. `invalid` is not added; it
  is Plune's `broken`, which the CLI calls `errored`.

## [0.17.1] - 2026-10-12

### Added

- **is_flaky / is_muted flags for TestCase contract (plune#1246, PR #88).** Adds two optional fields to the `TestCase` schema:
  - `is_flaky` — assertion about a case: "this test is unstable by nature" (diagnostics).
  - `is_muted` — human decision: "we execute and record it, but it does not count toward the run summary" (policy).
  Both are purely additive: a producer that does not send them validates exactly as before, so `schemaVersion` stays at 2.
  The platform already validates these fields on `POST /v1/test-cases` (plune#1246, ADR 0045).
- **A result row can say the product was never judged (`inconclusive`) (plune-ai/plune#1244, ADR 0045).**
  `RowResult.inconclusive?: 'blocked' | 'skipped'` — optional and purely additive, so a runner that
  does not send it validates exactly as before and `schemaVersion` stays 1. Until now a row stopped
  by a dependency or an environment had exactly one word available to it, `failed`, and the word was
  wrong: a red build because something fell over reads identically to a red build because the code
  is broken, and those are two different pieces of work. The Plune platform already validates the
  field on `POST /v1/runs`; this is the producer's half of the same contract. `invalid` is
  deliberately not accepted — Qase's `invalid` is Plune's `broken`, and a second word for one idea
  would fork the contract at both ends.
- **`plune run import <folder>` reads an Allure `allure-results` folder (plune-ai/plune#1221).** One reader for
  every Allure adapter (pytest, JUnit 5, TestNG, Playwright, Cypress, Jest, Vitest, WebdriverIO, .NET): each
  `*-result.json` is a test with its status (`passed`, `failed`, `broken`, `skipped`, sent as written), time,
  failure message and trace, and steps; `*-container.json` names the suite. The files in `attachments[]` of the
  test, of its steps and of its fixtures go the path a JUnit file does, with the `type` from the JSON or the
  extension; a `source` is checked and read by the same code as a JUnit `[[ATTACHMENT|path]]`, so a missing one
  is listed and counted and `--fail-on-missing-attachments` applies, and one outside the folder is refused. The
  same test run again (same `historyId`) is one test with attempts, the last to stop counting. A folder with no
  `*-result.json` exits 2 with a message. A file keeps the name the adapter gave it (`after add`) with the
  extension of the real file when the name has none (`after add.png`); a results folder reached through a link
  works as a JUnit report's does. Only regular files named `*-result.json` and `*-container.json` are read, none over
  64 MB; a file in a shape nobody wrote ends the import with exit 2 and its name, never a stack trace; at most 100
  files of one test are read, as for JUnit. This is how Jest gets files per test, which `jest-junit` cannot give.
- **Trace, video, screenshots and text go to the project's bucket (plune-ai/plune#946).** When the project has
  a storage bucket connected, every file an attempt kept is uploaded straight to it over short-lived links
  Plune hands out per file: streamed from disk, four at a time, retried on network failures, 5xx and 429, with one
  new link on a 403. The links are never printed; a warning names the file and a code, and never fails the import.
  The run says once that the bucket was found, and the summary reads `N file(s) uploaded to your bucket`.
  Without a bucket nothing changes for screenshots and text; a trace or a video is counted as not stored.
- **`plune run import` of a JUnit report sends the files its tests announce (plune-ai/plune#1220).** A test that
  prints `[[ATTACHMENT|path]]` on a line of its own to `system-out` or `system-err` (pytest, Maven Surefire, Vitest,
  PHPUnit, .NET's JunitXml.TestLogger and Cypress's `mocha-junit-reporter` all carry it into the report) has that
  file uploaded to its result by the path the Playwright reporter's files take: the project's bucket, the
  platform's own route for a picture or a text, a skip otherwise. Any extension; a relative path counts from the
  folder of the report. A file that is not there never fails the import: each gets a line with the test and the
  path from the report, always, and the output ends with `Imported N results · M files uploaded · K files not found`.
  `--fail-on-missing-attachments` turns K > 0 into exit code 1, after every result is sent. A path that leaves the
  folder of the report, by `..`, an absolute path or a link, is refused with the same line and never read (a report
  reached through a link may name its files by the folder's real path). Test names and paths from the report are
  printed without control characters. Output
  `jest-junit` writes once per suite names no test, so nothing is read from it.

### Changed

- `plune run import` no longer prints its own screenshot and text-file count lines; the session's summary line
  carries them.

## [0.17.0] - 2026-09-30

Also `@plune-ai/playwright` **0.5.0** - the adapter embeds `reporter-core`, where the upload of a result's
text files lives, and it now hands the core the bytes of an attachment kept as a `body`. Plune's dashboard
opens what is uploaded in the result's panel (plune-ai/plune#981); a platform that does not keep text files
refuses them, and the results arrive as before.

### Added

- **A test's JSON and text files reach Plune with their results (plune-ai/plune#928).** When
  `@plune-ai/playwright` reports a run, or `plune run import` reads a Playwright JSON report, what each
  attempt attached as `application/json` or `text/plain` — a log is `text/plain` — is uploaded to its
  result once the platform has stored it, as the screenshots are: a passed test's as well as a failed
  one's, every upload answered before the run is closed. Both ways of attaching are read: by `path`
  (`testInfo.attach('server.log', { path })`) and as a `body`
  (`testInfo.attach('api-response', { body: JSON.stringify(data), contentType: 'application/json' })`),
  which leaves no file — the reporter hands the core the bytes Playwright gives it, and the import
  decodes the report's base64. Up to 512 KiB a file and 10 a result, apart from the screenshots' 20.
  The type is the attachment's, in any case and with any parameters (`Text/Plain; charset=UTF-8`); it is
  not guessed from a file's extension, so an attachment that names none is not sent. A charset goes to
  the platform only when it is UTF-8, the one it takes, and the bytes are checked as UTF-8 before
  they leave. Markdown, HTML, CSV, XML, traces and videos are not uploaded, nor is an image attached as
  a `body`. The name is the attachment's, cut to the 200 characters the platform takes, and the
  extension of its file follows a name that has none of its own — `testInfo.attach('api-response', { path })`
  arrives as `api-response.json`; a body goes by its name as it is. Nothing is cleaned or cut on this
  side: the platform cleans a text before it keeps it. Needs a platform that keeps text files
  (plune-ai/plune#928); with an older one each is refused, counted, and said once.
- **What stays behind is counted, and costs nothing else.** A text over 512 KiB, one that is not UTF-8 or
  holds a NUL byte, an empty one, one past the 10th of its result, one named with a leading `_` (hidden in
  Playwright's own reports too) or not on this machine is skipped, with one line for each reason —
  `plune: text file "…" not uploaded — …`; one the platform refuses is counted, with one line for the
  first. Neither costs a result or changes an exit code. The summary says it:
  `plune: 12 accepted · 10 screenshot(s) uploaded · 3 text file(s) uploaded, 1 skipped`, and
  `plune run import` prints `3 text file(s) uploaded to their results, 1 skipped.` after the
  screenshots' line, which is unchanged, and nothing for a report with no text files.
  `RunStats.textFiles` and the import's result carry the three numbers, apart from `screenshots`.
- **A text attached as a `body` is never written to the fallback file.** It exists only in memory, and
  JSON would write it as one number for every byte: `.plune/pending-results.jsonl` keeps what it kept
  before and no bytes of a body, so a result sent again with `plune run report` goes without it. The files
  it names by path are uploaded then if they are still on disk, as before.
- **`filesOf` in `@plune-ai/cli/reporter-core` also hands over a JSON or a text kept as a `body`.**
  `ResultFile.path` is optional now and `ResultFile.body` holds the bytes; an image, a trace or a page
  kept as a body is not handed over.

## [0.16.0] - 2026-09-30

Also `@plune-ai/playwright` **0.4.0** - the adapter embeds `reporter-core`, where the commit and the branch,
the reason an offer was refused and the marker that ties a replayed run together live. A run panel shows
the commit and the branch only on a platform that hands them out (plune-ai/plune#964); on an older one
the results arrive as before and the panel shows none.

### Added

- **`plune run import` reads a `@P<id>` in a JUnit test's name as the case the test is (#38).** The
  token ADR 0023 fixed — read by `@plune-ai/playwright` and by the Playwright JSON import — was ignored
  on the JUnit road, so a renamed or moved test was offered as new while the case it used to be kept
  the history. Now the same `@P<id>` in a test's name is that result's case. The key stays as the name
  gives it: the token is not stripped, as the adapter does not strip it. In Playwright's own JUnit
  report the token is read from the test's own title, not from the `describe` titles around it, as the
  reporter reads it; from any other runner's report it is read from the whole name, which is all that
  report holds.

- **A run says where it ran: the commit and the branch (plune-ai/plune#927).** `@plune-ai/playwright` and
  `plune run import` open the run with `meta.sha` and `meta.branch` beside the `runner` and `ciUrl` they
  already sent, so the platform's run panel has something to show; until now no client sent either.
  - The reporter takes the commit from `metadata.ci.commitHash`, which Playwright writes itself, and the
    branch from `metadata.ci.branch` (GitLab, Jenkins). Playwright gives no branch on GitHub Actions, so
    there it is `GITHUB_HEAD_REF` — the pull request's own branch — and, when that is empty, as on a
    push, `GITHUB_REF_NAME`.
  - `plune run import` reads the same from the job's variables: `GITHUB_SHA`; `CI_COMMIT_SHA` and
    `CI_COMMIT_REF_NAME`; `GIT_COMMIT` and `GIT_BRANCH` — each set only where its CI is recognised
    (`GITHUB_ACTIONS`, `GITLAB_CI`, `JENKINS_URL`), so a stray `GIT_COMMIT` on a laptop is no commit. A
    Playwright JSON report that names a commit gives that one, as it gives the CI run: whoever imports
    may be another job, and its branch is not that commit's — so such a report gets its own commit and
    no branch of the importing job's.
  - Outside a CI both are absent: nothing is guessed. On GitHub a pull request's commit is the one
    GitHub merged for the checks (`GITHUB_SHA`), which is what the tests ran on.
  - A batch the platform did not take now records the run's `meta` on its line of
    `.plune/pending-results.jsonl`, and `plune run report` opens the run it has to make with it — the
    replayed run keeps its commit, branch, CI link and runner, and takes nothing from the machine that
    replays. A line written before this has none, and gets none.
  - `ciCommit(reported?, env?)` is exported from `@plune-ai/cli/reporter-core` for an adapter that reads
    its runner's record of the CI.

### Changed

- **Every command reads `.env`, not only `run` and `report` (#46).** `plune run import`, `run start`,
  `run finish`, `run exec`, `run delete`, `run report`, `sync`, `ingest`, `pull`, `push`, `plan grep`
  and `login` never looked at a `.env`, so a `PLUNE_TOKEN` or `PLUNE_API_URL` written in one did not
  exist for them — the demo project wrapped every script in `NODE_OPTIONS=--require=dotenv/config` to
  get what `run` already had. There is one rule now, in the program and not in each command: the
  `.env` beside the config named with `-c`, then the one in the current directory, are read before
  the command looks at the environment. What is already exported wins over both files, and the
  config's file wins over the directory's. With `-c`, `run` and `report` read the current directory's
  file as well, where they read only the config's. The README says it in one paragraph.

- **`plune init` starts a project on a current model, and the run prices it (#48).** The template and
  the wizard offered `claude-3-5-sonnet-latest` and `claude-3-opus` — an alias for a model Anthropic
  has retired, and an id the API never had — and the price table stopped at those and `gpt-4o`, so a
  project on any current model read `cost_usd = 0` and a warning per call. `plune init` now writes
  `claude-sonnet-5-5` (the wizard offers OpenAI users `gpt-4o-mini`), and the table prices
  `claude-fable-5-1`, `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-4-5` (and its dated id)
  and OpenAI's `gpt-6-astra`, `gpt-6.1-sol` and `gpt-6-luna`, with the source and the date beside
  them. The older ids keep their rows. The README example is on a current model, and the README says
  to leave `temperature` out for Claude models released after Opus 4.6.

### Fixed

- **`plune run --dry-run` needs no provider key (#49).** A dry run only prices the run and never
  touches the network, but it built its provider the way a real run does, and the provider's
  constructor asks for a key: `Missing ANTHROPIC_API_KEY`, exit 2, from the command that is meant to
  cost nothing. It now runs on a provider that can only estimate, and prices each row for the model
  the config names — `pricing` in `plune.yaml` first, the built-in table second — exactly as a real
  run would. With `PLUNE_MOCK_PROVIDER=1` the mock still answers, at zero, as before.

- **A Playwright suite's own JUnit report is keyed the way the reporter keys it (#47).** Playwright's
  `junit` reporter writes the spec file's path in `classname`, in the OS's separators, and the
  `describe` titles and the test's, joined by ` › `, in `name`. Imported as `classname#name`, a test's key —
  `tests\cart.spec.ts#cart › adds an item` — never equalled the reporter's or the JSON import's
  `tests/cart.spec.ts#cart#adds an item`, so `--create` offered every test of the suite to the review
  queue a second time. A `classname` that ends in a spec file's name (`.spec` or `.test`, then a js or
  ts extension, as Playwright matches by default) now gives the key `file#describe#…#title`, the file
  with forward slashes on every OS. A suite that matches other file names, and any report whose
  `classname` is not a spec file's name, keeps `classname#name` as before. A case an earlier import
  created from such a report carries the old key, so its test is offered to the review queue once more;
  the reporter and the JSON import are not affected.

- **`plune run import --create` no longer says the review queue is full when something else refused
  the offer (plune-ai/cli#71).** The last line about tests that could not be offered was the same for
  every refusal, so under the platform's own line saying the project had reached its case limit it told
  people to approve or reject what was waiting — which frees nothing, since approving makes a case and
  the platform refuses that the same way. The core now records why an offer was refused, told apart by
  the platform's own words on a 429 (`RunStats.unofferedWhy`: `queue`, `cases` or `other`), and the line
  follows it: a full queue keeps its advice; the case limit says the project is at its test case limit,
  to delete cases or ask an operator to raise it; anything else — a throttle, an outage, a run that is
  not there — points at the `could not offer` line above and advises nothing.

- **`plune run report` opens one run for the batches of one reporter run, and sets the file aside once
  everything has been sent (plune-ai/cli#45).** It opened a run for every line of
  `.plune/pending-results.jsonl` whose results never reached one, and a run sent in batches is several
  lines — 24 tests at a batch of 10 came back as three runs, each holding a part of the results and none
  of them the run. Every line the reporter writes now carries a marker made once per reporter session,
  and the replay opens one run, and leaves it open, for the lines that share a marker. A file written
  before this has no markers and replays one run to a line, as it did. When every result has been sent
  the file is renamed to `pending-results.<time>.sent.jsonl` beside it, so that a second
  `plune run report` does not send them all again; it is not deleted. When anything did not go, the file
  stays exactly as it was.

## [0.15.0] - 2026-09-29

Also `@plune-ai/playwright` **0.3.0** - the adapter embeds `reporter-core`, where the upload below lives, and it
hands the core every attempt's files. Needs a platform that stores a result's files
(plune-ai/plune#915); with an older one the results arrive as before and the screenshots do not.

### Added

- **A Playwright run's screenshots reach Plune with their results (plune-ai/plune#913).** When
  `@plune-ai/playwright` reports a run, or `plune run import` reads a Playwright JSON report, the images
  each attempt kept as files are uploaded to its result once the platform has stored it — a passed
  test's as well as a failed one's — so a run in Plune shows every test with what it looked at. PNG,
  JPEG and WebP, up to 2 MB a file and 20 a result; the type is the attachment's, or the extension's
  when the attachment names none. Traces, videos and text files are not uploaded, nor is an image
  attached as a `body` rather than a file. A file goes by its attachment's name, with the file's
  extension when the name has no image extension of its own — `screenshot.png` for Playwright's
  `screenshot` option, `03-results.png` for `testInfo.attach('03-results', { path })` — never by the
  copy Playwright saves as `03-results-<sha1>.png`, never by a path (a name that is one keeps its last
  segment), and cut to the 200 characters the platform takes, the extension kept. The files never ride
  in a results batch, and a result the platform already had (`duplicate`) is not sent its files again.
  Every upload is answered before the run is closed — the platform takes no file on a closed run —
  four at a time, and a 429 waits out its `Retry-After` as every other call does.
- **What stays behind is counted, and costs nothing else.** A screenshot over 2 MB, of another image
  type, past the 20th, named with a leading `_` (hidden in Playwright's own reports too) or not on this
  machine — a report copied from the job that wrote it — is skipped, with one line per reason; one the
  platform refuses is counted, with one line for the first. Neither costs a result or changes an exit
  code. The summary says it: `plune: 12 accepted · 10 screenshot(s) uploaded, 2 skipped`, and
  `plune run import` prints `10 screenshot(s) uploaded to their results, 2 skipped.` after its `Read …`
  line, which is unchanged, and nothing for a report with no screenshots. `RunStats.screenshots` and
  the import's result carry the three numbers.
- **`filesOf` in `@plune-ai/cli/reporter-core`**, beside `failureOf`: the files one attempt kept, for
  `PendingResult.files` — how both roads hand them to the core. The core never sends that field; it
  reads the files from disk as it uploads them. The client `createClient` returns gains
  `upload(path, bytes, contentType)`: the bytes as the body, through the same retries as `post`.

## [0.14.3] - 2026-09-28

The adapter `@plune-ai/playwright` stays at **0.2.8**: nothing below is in the part it embeds.

### Changed

- **Where to get a token says Account → API tokens (plune-ai/plune#868).** The dashboard moved API
  tokens out of a project's Settings into the person's account, where a token is minted for the
  project picked beside Generate. `plune login`'s description, the messages for a missing or rejected
  token and the README name the new place.

## [0.14.2] - 2026-09-24

Also `@plune-ai/playwright` **0.2.8** - the adapter embeds `reporter-core`, so every fix below reaches
it too.

### Fixed

- **An address whose host is named as the repository or the home folder is left alone
  (plune-ai/plune#790).** A posix root's leading slash matched as many slashes as there were, so it
  also took the `//` after a scheme: with the root `/app`, `http://app/login` — a compose service named
  after the image's `WORKDIR` — became `http:login`, and with the home `/root`, `http://root/x` became
  `http:~/x`. A posix path now starts with exactly one slash, escaped or not; a UNC path keeps both.
- **A path written with escaped slashes, as PHP's JSON writes them, reads like the plain one.** With no
  repository root — a report from another machine — `\/home\/bob\/…` kept the account's name; it is
  now `~\/…`. A file URL written that way lost the root but kept its `file:` (`file:e2e\/a.ts`); it now
  loses both.
- **A path in a webpack source map reads like a file URL's.** With the root known, `webpack:///…` lost
  the root but kept its `webpack:` (`webpack:src/Foo.tsx`); it now loses both. With no root, the home
  folder in such a path — `webpack:///home/bob/…`, `webpack-internal:///Users/carol/…` — kept the
  account's name; it is now `~`. Other schemes keep their `///`: `sqlite:///app/db.sqlite` is left alone.
- **An answer without the fields the core reads no longer throws.** A 2xx whose JSON lacks what the
  core reads threw out of it: the adapter said "reporting stopped" and `plune run import` ended
  non-zero. Now the lookup, the start, a batch and the offer read such an answer as that call failing,
  and a close answering `null` is taken as done:
  - the lookup without `results`, or a row without its key: it threw at the start or inside a flush,
    where the batch had already left the buffer, so its results were neither delivered nor deferred;
    they are now deferred;
  - the start without `run`: it threw in `startRun`; the results are now deferred;
  - a batch without `counts`, or with counts that hold no number: `null` threw inside the flush, and
    `{}` counted the batch as delivered with nothing accepted; the batch is now deferred;
  - the offer to the review queue (`--create`) without `results`: it threw from `finish`, and the run
    stayed open; the tests are now counted as not offered, and the run closes;
  - a close answering `null`: it threw from `finish`; the run is now taken as closed.

## [0.14.1] - 2026-09-24

Also `@plune-ai/playwright` **0.2.7** - the adapter embeds `reporter-core`, so every fix below reaches
it too, and it now closes the run only after every batch is answered.

### Fixed

- **`@plune-ai/playwright` closes the run only after every batch is answered (plune-ai/plune#790).**
  The adapter handed each result to the core without waiting for it, and the core sends a batch from
  inside that hand-over once enough results are buffered. So the run could be closed while batches were
  still in flight: the platform froze the run's never-run tests without them, refused the batches
  behind the close, and the summary counted only what had come back — in the AC-15 run, 60 of 100 were
  stored. A result the core refuses is now the one "reporting stopped" line instead of an unhandled
  rejection that ended the run with exit code 1.
- **A success the client cannot read is a batch not delivered.** A 2xx that is not JSON — a proxy's
  page — or one without counts threw out of the reporter and out of `plune run import`; the batch now
  goes to the fallback file and is named in the summary like any other refusal.
- **No path of the machine in the headline or in an attachment's name.** The headline was the error's
  first line as the runner wrote it, so a missing snapshot or a missing browser put the account's home
  folder on a page the whole project reads; it now goes through the same rewriting as the text. A first
  line over 8 KB is not sent as the headline at all (never cut): the platform keeps 300 characters of a
  headline, the line still travels in the text (unless the text is over 512 KB and the line over half
  of that, when the cut leaves it out), and the dashboard shows the text's first line instead.
  An attachment named by its path (`testInfo.attach(file, { path: file })`) is named by the file alone,
  and one with an empty content type goes without it — the platform refused the whole batch for it.
- **The repository and the home folder are rewritten only where a path starts.** A root of one segment
  such as `/app` also turned `http://localhost:3000/app/login` into `http://localhost:3000login`, and
  a home of `/root` did the same to an address ending in it. A Windows path printed with doubled
  backslashes — a string in a diff — is now rewritten too.
- **A CI link the platform would refuse is not sent.** `https:/host` and `https:host` passed as links
  because `new URL` mends them, and the platform refused the run's start for them — every result then
  went to the fallback file. A link now needs `http://` or `https://` as written.
- **The worst run arrives in at most ten calls whatever its texts hold.** The 512 KB limit on one
  failure text counted the text's raw bytes, while a batch is packed by the bytes of its JSON, where a
  quote, a backslash and a CR weigh two: a `toEqual` diff of a Windows path weighed a quarter more in
  the batch, and a hundred such failures took 12 calls instead of 10. The limit, and the 8 KB one on a
  headline, now count what the text weighs in the batch — a 40 KB first line also sent as the headline
  made a hundred results take 11.
- **A stack line cannot stall the runner or end the import.** A line over 8 192 characters is no longer
  read as a stack frame, where the pattern took time quadratic in its length on the runner's own thread,
  and a frame whose file URL has a broken escape is read as written instead of ending the report on a
  `URIError`.

## [0.14.0] - 2026-09-24

Also `@plune-ai/playwright` **0.2.6** - the adapter embeds `reporter-core`, where the failure detail
and the batches packed by bytes below live, and it sends the detail from the reporter API itself.
Needs a platform that stores the detail (plune-ai/plune#806, on the beta since 2026-09-24): an older
one drops the unknown field without a word.

### Added

- **The failure detail of a failed attempt — what failed, the declared steps down to it, where, what
  the runner kept, and the CI run (plune-ai/plune#790).** `failureOf` in `@plune-ai/cli/reporter-core`
  derives it from one normalized attempt, so `plune run import` and the reporter cannot disagree: the
  first non-empty line of the error (on a test timeout, the line of the action that was still waiting,
  not "Test timeout of N ms exceeded"), the chain of failed declared steps, the first stack frame in
  the test's own file as a posix path from the repository root (`repoRootOf` finds the root once per
  run; a file outside it, line 0 or a path the platform would refuse drops the place, not the batch),
  the names of the attachments kept as files, and the build link when it is http(s). Nothing is cut or
  searched for credentials here — the platform does both after its own cleaning. `errorContextOf`
  builds the text beside it: every error of the attempt in order, colour codes gone, the repository as
  relative paths and the home folder as `~` (any `/home/<u>`, `/Users/<u>` or `C:\Users\<u>` when the
  root is unknown, as for a report from another machine), and at most 512 KB — the CLI's transport
  limit, not a copy of the platform's 256 KB — cut by whole lines from the head and the tail around one
  `…[omitted N lines]…`, so a line longer than the limit never shows in part.

- **`plune run import` sends it for a Playwright JSON report, and opens the run with its CI run.**
  Each attempt of the report is reduced to the attempt the core reads — `errors[i]` as Playwright
  wrote them (the message, the code frame and the stack in one text, with where it was thrown), the
  declared steps, the attachments, `config.metadata.ci.buildHref` — so a failed attempt carries its
  `failure` and the text above; one that passed or was skipped carries none. The root comes from the
  report's `rootDir`, and only when that folder is on this machine: a report from somewhere else keeps
  its detail but names no place. The run opens with `meta.ciUrl` from the same `buildHref` — the CI
  run the report names, never this machine's `GITHUB_*` — and without a link at all when it is not an
  http(s) address, rather than being refused.

- **`@plune-ai/playwright` sends the same detail, from the reporter API.** Each attempt becomes the same
  normalized attempt: every error written as Playwright's own JSON report writes it (`formatError` with
  colours off — the stack's head, the code frame, the `at` lines, a cause), the declared steps kept by
  the report's own filter (`test.step` under `test.step` from the test body, so a step in a hook or a
  fixture and every action stay out of the chain), the attachments. The repository root is looked up
  once from `rootDir`; `metadata.ci` is read when the run opens, on the first result, because
  Playwright's git plugin writes it after `onConfigure`. A report of the same run imported with
  `plune run import` gives the same text and the same `failure`. Where an error carries no place, both
  roads take the first stack frame outside `node_modules`, as Playwright does.

### Changed

- **What was not delivered is said in the same words on both roads, every time.** `plune run import`'s
  summary line gains a fourth number, zero included: `Read 100 result(s) from a playwright-json
  report: 90 accepted, 0 already there, 2 unmatched, 8 not delivered.` — the results a refused batch or an
  unanswered lookup kept out of Plune. The `[0-9]+ unmatched` workflows read stays whole, and the line
  about the fallback file is unchanged. The reporter's own line says `… · 8 not delivered — written to
  .plune/pending-results.jsonl` where it said `8 written to …`. In GitHub Actions a count above zero
  also prints, once and on either road,
  `::warning::8 result(s) were not delivered to Plune — see the reporting step's log.`; no exit code
  changes.

### Fixed

- **A run whose failures carry long texts no longer loses them to one refused batch
  (plune-ai/plune#790).** Results went in batches by count alone, so fifty failures with 10 KB of text
  each were already over the route's ceiling: the batch was refused and written to the fallback file,
  which in CI goes with the runner. A batch is now at most `batchSize` results **and** at most 8 MiB of
  serialized JSON — under the 10 MiB the platform admits for it, the CLI's own number and not a copy of
  the platform's. An ordinary run still takes one call; 100 results of 256 KB take four. A result
  heavier than a batch goes alone. A refused batch costs only itself: the rest are still sent, and each
  batch left after a refused token goes to the fallback file on a line of its own, so
  `plune run report` sends it again in one call the route accepts.

- **`plune run import` reads a real Playwright JSON report without being told its format.** Detection
  looked for `"suites"` in the first 4 KB only, but Playwright writes `config` first — argv, every
  project, each reporter's options, the CI metadata — and a report of a pinned 1.63 run put it past
  7 KB: the import refused a report it reads fine. The whole file is searched now.

- **`plune run import <file> --format <fmt>` uses the format it is given.** `plune run` has a
  `--format` of its own (console | json | markdown), and the parser gave it every `--format` on the
  line, so the import never saw one: the flag was ignored, an unknown value was not refused, and the
  advice «Say which with --format» could not be followed.

- **A green Playwright run on Windows ends 0 with the reporter in it, not 0xC0000409 (#58).** The
  reporter core spoke to the platform through `fetch`, whose first request compiles undici's WASM
  parser, and V8 re-optimizes it on a background thread. Playwright calls `process.exit` as a run
  ends; landing during that compile, it tripped a libuv assertion on Windows, and a run whose tests all
  passed exited 0xC0000409 with its results delivered. The core now speaks `node:http(s)`, whose
  parser is native — the reporter, `plune run import`, `plune run report` and the run lifecycle
  commands alike; `fetchImpl` still replaces it. A platform silent for 300 s is given up on, as
  `fetch` did. Redirects are not followed: `fetch` followed them, and no platform route redirects.

## [0.13.0] - 2026-09-18

`@plune-ai/playwright` stays at **0.2.5** - nothing below touches `reporter-core`, so the adapter
has nothing to re-embed.

### Added

- **`plune plan grep <id>` — a test plan as the `--grep` a runner takes.** The platform decides which
  tests run (a plan is a collection of case filters, resolved when asked) and CI runs only those:
  `npx playwright test --grep "$(plune plan grep <id>)"`, `npx vitest run -t "$(plune plan grep <id>)"`.
  Each case of the plan contributes its title path from the `path-title` key the reporter wrote — the
  file left out, each segment escaped, `[ >#]+` between them — and the fragments are joined with
  `|`; a case with no such key goes in by title. The boundary class is what makes one pattern fit
  every runner: Playwright, jest, mocha and vitest ≤ 4 filter on the space-joined title path, vitest
  5 on `describe > title`, and a `#` a title had of its own (`… (#742)`) is a `#` in the key too. The
  ` > ` of a vitest junit name and the ` › ` of a Playwright one are boundaries as well. Only the
  pattern reaches stdout; the count of cases and of keyed cases goes to stderr. An empty plan prints
  `(?!)`, a pattern that matches nothing, because an empty `--grep` would run everything. Same
  refusals as `pull`: not logged in or a rejected token → 2, network or HTTP (a plan that does not
  exist included) → 1. Testomat's `--filter 'testomatio:plan=<id>'` is the reference; theirs greps
  `@T123` ids in titles, ours the title path.

### Fixed

- **`PLUNE_TOKEN` is read by every platform command, not only by the reporter and `run`.** `sync`,
  `ingest`, `pull` and `push` looked at the saved login alone, so a CI job with the variable set —
  the same token `run import` and `run start` were already using — was told "not logged in" and had
  to `plune login` first (#44). One ladder now, in one place: the variable, then the saved login;
  blank is absent, as the reporter reads it. The refusal names both roads.

## [0.12.0] - 2026-09-17

Also `@plune-ai/playwright` **0.2.5** - the adapter embeds `reporter-core`, and `PLUNE_FULL_RUN`
below lives there, so it moves with the same rebuild.

### Added

- **`PLUNE_FULL_RUN=1` — a run that is the whole suite says so, and the platform detaches what it
  stopped reporting.** The reporter and `plune run import` send it as `configuration.full` beside the
  list of expected tests; when the run finishes with every expected test reported, the platform moves
  the active cases this source used to report and did not this time to `detached` and the finish line
  says how many. Off by default: only whoever typed the command knows a run was not `-g smoke` or one
  file. `plune run start` sends no list to compare against, so the flag has no effect there.

- **`plune pull` and `plune push` — the project's test cases as one Markdown document, and back.**
  `plune pull [file]` writes the tree (or one suite with `--suite <id>`) as a Markdown document in
  Testomat's classical format (`GET /v1/test-cases/markdown`); `plune push [file] [--dry-run]` sends
  it back (`POST /v1/test-cases/markdown`) and prints the platform's report - created, updated,
  unchanged, refused by line, warnings. `pull` refuses to overwrite a file git sees as modified or
  untracked unless `--force`, so a pull can't quietly erase a working copy; exit 3 for that refusal,
  exit 4 when a push carried refusals (they arrive inside the 200 report, not as a failed call). The
  token is never printed.

## [0.11.1] - 2026-09-15

Also `@plune-ai/playwright` **0.2.4** - the reporter fixes below live in the adapter.

### Fixed

- **Evals on a current Claude model no longer fail with a 400 before the first row.** `plune run`
  sent `temperature: 0` on every request unless the config said otherwise, and the judge sent it
  always; models released after Claude Opus 4.6 refuse the parameter (only `1.0` is still
  accepted). The parameter now goes only when the config sets it — for the rows and for the judge
  alike — so a config without one works on any model, and a config with one keeps what it asked
  for. Cache keys are unchanged: a cache written before this still answers.

- **The reporter opens a run only once a test has reported a result.** It opened one in
  `onBegin`, which Playwright also fires for `--list`, for a `--grep` that matches nothing and for
  a suite of zero tests — so listing tests with a token set left an empty run on the platform
  every time, and with a rejected token the one request left pending at exit tripped a libuv
  assertion on Windows (`!(handle->flags & UV_HANDLE_CLOSING)`). The declared test list is still
  taken at the start and handed over whole; the run itself waits for the first result.

- **The reporter's `path-title` key spells the file with forward slashes on Windows too.** Playwright
  titles the file suite with `path.relative` (backslashes on Windows) and writes its JSON report
  posix-style, so the key the reporter wrote on a Windows machine never equalled the one
  `plune run import` derived from the report of the same run — the two met only through
  `playwright-id`. One spelling now, the one a person would type into a case. `specRef` follows.

## [0.11.0] - 2026-09-15

Also `@plune-ai/playwright` **0.2.3** - the same core, rebuilt. The adapter embeds `reporter-core`
rather than depending on it, so the default name below reaches Playwright projects only through its
own release.

### Changed

- **A run nobody named is called after when and where it ran.** `<directory> · 2026-09-15 15:26 · ci`
  instead of no title at all — the reporter, `plune run import` and `plune run start` alike. A row
  in the list now says whose, when and from where without being opened; `PLUNE_RUN_TITLE` replaces
  the whole name as before. `plune run start` also honours `PLUNE_RUN_TITLE` now — it sent no title
  under any circumstances.

## [0.10.0] - 2026-09-14

Also `@plune-ai/playwright` **0.2.2** - the same core, rebuilt. The adapter embeds `reporter-core`
rather than depending on it, so the fix below reaches Playwright projects only through its own release.

### Added

- **The reporter counts what a trusted source created.** A project can now tell the platform that a
  runner's discovered tests become cases without waiting in the review queue. When it does, the
  offer comes back `created` instead of `queued` — and this client counted only `queued`, so a run
  that filled a project with two thousand cases printed `0 offered for review` and read as a run
  where nothing happened.

  `plune run import` now says how many became cases and where to change that setting, and it stops
  pointing at the review queue in that case: those tests never entered one, so the old line sent a
  reader to an empty screen to look for work that was already done.

  Nothing changes for a project that trusts no source, which is every project by default.

- **`plune run delete <id>`** — undo an import from the surface the import happened on. Deletes the
  run and everything it produced (its results, and the review-queue entries it raised); approved test
  cases and the audit log stay. Recoverable for six months, then gone for good.

  It exists because the CLI is where the mistake is made: onboarding a suite is a loop of `plune run
  import`, and the first time somebody does it they will point it at the wrong file, the wrong `--key`
  or the wrong directory. Until now nothing could take that back, in any tool — a run was the one
  thing Plune could create and could not remove.

  No confirmation prompt, for two reasons rather than one: it is your own data, and this command's
  natural home is a script or a loop over ids, where a prompt is not caution but a hang.

  Needs a platform that serves `DELETE /v1/runs/{id}` — beta since 09.09.2026.

### Fixed

- **One over-long test name no longer loses the whole run.** A test name is a key to the platform,
  and the platform accepts a key of at most 1024 characters. A runner will happily print a
  16 384-character parameter into a title, and until now the reporter sent it as it was: the platform
  refused the run before it started, every result went to the fallback file — and in CI that file is
  deleted with the job. Four such titles cost a project every run for two days, with a green build.

  A name longer than a key is now shortened before it becomes one — the head of the name plus a
  digest of the whole, so two long names still get two keys and the same name gets the same key on
  every run. A queue entry's title is cut to what the platform shows. The reporter says so once,
  naming the first such test, and counts them in the summary: give the test a shorter name; until
  then, this is its identity.

## [0.9.1] - 2026-09-09

### Fixed

- **`--key` now actually gives several jobs one run.** The option has always said it does — *"the key
  several jobs share so their reports land in one run"* — and `run import` closed the run the moment
  it finished its own file. The second job was answered `409 run is closed to new results`, wrote
  everything to the fallback file and exited zero. Green step, green CI, a quarter of a suite
  missing.

  It never worked. It only looked as though it did during onboarding: while a project has no cases
  yet, the second report has nothing to submit, so an empty result is indistinguishable from a
  successful one. The loss appears the day the project is set up — the state it lives in from then on.

  The mechanism to prevent this was already here. `PLUNE_SHARED_RUN` and `PLUNE_PROCEED` have been
  read into `keepOpen` since the Playwright reporter needed it, and the reporter honours it; import
  parsed the same variables and ignored the answer. Now import chooses the same way the reporter
  does, and the run is closed by whoever knows the jobs are done — `plune run finish <id>`, as the
  message says.

- **A report bigger than the review queue says what is left, and what to do about it.** The queue
  holds a bounded number of waiting items, so the first import of a mature suite stops partway.
  Two things were wrong at that moment: the refusal named the batch it was carrying rather than
  everything still unoffered — every batch behind it was abandoned without a word — and the summary
  then said the unmatched tests were *"already in the review queue"*, which was untrue of every one
  of them. Both are now one line that names the real number and says the rest need a second import
  after the queue is emptied.

- **An import that landed nothing no longer opens by saying it imported.** The summary read
  `Imported 555 result(s) from a junit report: 0 accepted, 0 already there, 0 unmatched` — a
  sentence whose halves disagree, and readers stop at the verb. It now says `Read 555 result(s)`,
  which describes the file and is true of every outcome; the counts after it say what became of them.

### Added

- **Progress while a long import runs.** A report larger than one batch now reports as it goes
  (`plune: 400 of 2029 results sent`). A mature suite is a dozen or more silent round trips, and
  nothing distinguished a slow import from a hung one until the summary arrived at the end. Reports
  that fit in a single batch stay silent — there is nothing to watch.

### Documentation

- **The README said "the three cloud commands", and listed one that opens no socket.** The count
  was true at 0.2.0 and has been wrong since 0.7.0; the line sat next to the privacy promise, which
  is the sentence a reader is deciding whether to believe. It now names the four commands that never
  touch a network — `run`, `report`, `diff`, `init` — which is the half the promise is about and the
  half that does not grow with every release. The same claim was retracted from `docs.plune.ai` on
  09.09; it had a second home here, on the page npm renders.

- **How several jobs report into one run is now written down.** `--key` was documented as enough on
  its own. It never was, and since this release it is half of the answer: the key says where results
  go, `PLUNE_SHARED_RUN=1` says who does not end the run.

## [0.9.0] - 2026-09-09

### Added

- **`plune run import <file>` reads a report this CLI did not write.** JUnit XML and Playwright's own
  JSON, detected from the file rather than from its name. This is the door into Plune that costs
  nothing: an LLM provider key is what GENERATING checks needs, and a suite that already runs has
  nothing to generate — the results exist and only have to arrive.

  Until now that door was one runner wide. `@plune-ai/playwright` was the only way to hand results
  over, so a team on Jest, Vitest, pytest, PHPUnit, Surefire or Cypress had to write their own
  request against the API — for a product whose entire subject is somebody else's tests. JUnit XML is
  the format nearly all of them already print.

  Everything after parsing is the reporter core, unchanged: the same run lifecycle, the same
  identification ladder, the same fallback file when the platform is down, the same review-queue
  offer under `--create`. An importer with a connection of its own would be a second reporter to keep
  correct, and the two would drift the day one of them was fixed.

  Statuses are carried, not decided. JUnit's four words go over as `pass` / `failure` / `error` /
  `skipped` — the vocabulary the platform's own default map already spells for this format — so a
  team that reads `error` differently changes their map instead of waiting for a release here.

  Time is read from the report or left out. A case carries its duration and a suite carries a
  timestamp; there is no per-case start anywhere in the format, so a report without a suite timestamp
  records no execution at all. The file's mtime would have looked exactly like a fact.

  A Playwright JSON import derives the SAME identity as the reporter, to the character: `playwright-id`
  plus the `#`-joined path. Two derivations that disagreed would give one test two cases in Plune,
  quietly and forever, so the fixture in each suite describes the same test and both pin the literal.

  Verified against beta with the built binary before release: four cases in, four offered to the
  queue, one approved, the same file re-imported — one accepted, `unmapped: 0`.

### Changed

- The README describes the second route. It presented Plune as an eval runner and never mentioned
  that a suite you already have can be accounted for without a provider key, which is the half of
  the product most readers arrive for.


## [0.8.0] - 2026-09-08

### Added

- **`PLUNE_CREATE=1` offers the tests Plune has no case for.** The last rung of the identification
  ladder, blocked since C2 and unblocked by the platform's third kind of review-queue entry: one that
  testifies a case is MISSING rather than describing one. A reporter sees a `TestResult`, never the
  test's source, so what it offers is what it saw — the keys it was looked up by, the test's title,
  the file and line, and the runner's own word for how it went. There are no steps and no expected
  result in this shape at all, which is the point: the alternative was to invent them.

  Off unless asked for. A reporter that filled a stranger's review queue on first run would teach the
  team to stop reading the queue.

  One offer per test, not per attempt — a flaky test that ran three times is one missing case. A test
  whose adapter cannot name it or say where it lives is skipped in silence rather than sent with a
  guessed path. A failed offer is reported and dropped rather than written to the fallback file: that
  file replays results, and an offer is a question the next run asks again on its own.

- **`@plune-ai/playwright` 0.2.0 — the adapter names the test and says where it lives.** The two
  fields the core needs to offer an unresolved test, and the only two it cannot derive: the full
  `describe › title` path, because two suites in one file routinely share a title, and `file:line`,
  because a reviewer's first move on an unknown test is to open it. Read only on that path — a test
  that found its case has a case with a title of its own.

  The adapter bundles the core, so its version moves with any core behaviour it carries.

- **A run can be named, placed and marked.** `PLUNE_RUN_TITLE`, `PLUNE_ENV` and `PLUNE_LABELS` were
  recognised and refused in 0.7.0 because a Plune run had nowhere to put them; the platform has the
  fields now, so they work. Labels are comma-separated, and a blank entry is dropped — `a,,b` is a
  CI template that had nothing for the middle slot, not a request for an empty label.

  Lengths are not trimmed here. The platform states its limits and names the one you exceeded, and
  its refusal costs no results: the run fails to open, the reporter says why, and everything lands
  in the fallback file. A second copy of the caps in this package would only be a second place for
  them to drift.

  The reporter also says when a deployment kept none of it — an older one validates the body,
  stores what it knows and answers 201, which is indistinguishable from success. That was the whole
  reason these variables were refused out loud rather than sent and forgotten.

  `PLUNE_GROUP` is still refused: a group of runs is a feature that does not exist, and a group of
  one run means nothing.

## [0.7.0] - 2026-09-08

### Changed

- **zod 3 → 4.** The platform this CLI reports to has been on zod 4 since its own contract work
  landed, so anything depending on both pulled two copies of zod into one tree — 3.25.76 beside
  4.5.4 — for schemas that describe the same wire. The migration itself is four `z.record()` calls,
  which v4 requires to name their key type explicitly; nothing else here used an API v4 removed.
  Done now rather than later because the reporter core lands next, and every schema it adds would
  otherwise be written once on 3 and again on 4.

### Added

- **`@plune-ai/cli/reporter-core` — a new entry point that speaks the platform's run lifecycle.**
  Joins or creates a run by shared key, looks every test up once, sends results in batches, and
  closes the run explicitly. It has no runtime dependencies at all: the platform owns and validates
  the contract, so a client-side copy of the schema would only be a second place to drift. A
  framework adapter builds on this; the first, `@plune-ai/playwright`, follows.

  Two behaviours are deliberate and worth knowing. Nothing it fails to send is lost — an
  unreachable platform, a refused token and a closed run all append the batch to
  `.plune/pending-results.jsonl` while the test run carries on. And it never closes a run it did
  not finish watching: a crashed process leaves the run open, because a run that is silently marked
  finished reads as green when a third of it never ran.

- **A test can say which case it is, three ways.** A `PluneId` annotation, a `@P<id>` token in the
  title, or an `application/plune.metadata+json` attachment — in that order, because the deliberate
  thing an author typed should not be overruled by something a fixture generated. The attachment can
  also carry keys from another tool (`{"keys": [{"kind": "qase", "value": "Q-9"}]}`), and those come
  before the identifiers derived from the file path: a key from another system is a statement, a
  path is a guess. An attachment that cannot be parsed says nothing rather than failing the run.

- **`plune run start · finish · exec · report` — drive a platform run from a shell.** For the case
  a reporter cannot see: shards that are separate CI steps, a `merge-reports` stage, a suite split
  across two runners. `exec` does the whole thing in one line — opens the run, hands the command
  `PLUNE_RUN` and `PLUNE_PROCEED` so a reporter inside joins without closing it, then closes the run
  and exits with the command's own code.

  `plune run finish` was owed: the reporter already tells people to run it when a run is left open,
  and a message pointing at a command that does not exist is worse than no message.

  `plune run report` replays the fallback file. Until now "nothing is lost" meant the results were
  on disk in a shape nothing read, which is not the same thing. The file survives the replay — a
  partly failed send must not be the reason the rest disappears.

  These are subcommands of `run`, which takes no positional arguments; `plune run` on its own still
  runs your assertion suite exactly as before.

- **The reporter reads its settings from the environment.** `PLUNE_TOKEN`, `PLUNE_RUN`,
  `PLUNE_API_URL`, `PLUNE_SHARED_RUN`, `PLUNE_PROCEED`, `PLUNE_BATCH_SIZE` and `PLUNE_FALLBACK` fill
  in whatever a committed config left out — a config file cannot know the run key of a job that does
  not exist yet. Anything passed explicitly still wins.

  `PLUNE_RUN_TITLE`, `PLUNE_ENV`, `PLUNE_LABELS` and `PLUNE_GROUP` are recognised and **refused out
  loud**: a run has nowhere to store them yet, and a run's `meta` silently strips keys it does not
  know — so accepting them would look exactly like saving them.

- **`@plune-ai/playwright` — report an existing Playwright suite to Plune.** One line in
  `playwright.config.ts` and runs, results and failures appear in the platform, with no change
  to any test. Shards sharing a key land in one run, and `merge-reports` does not duplicate
  anything — a result's key is derived from the test id and its retry, so sending it twice is
  recognised rather than recorded twice.

  The published package has **no runtime dependencies**: the reporter core is compiled into it
  rather than depended on, so installing it does not drag a native SQLite build and two
  provider SDKs into a project that only wanted to report results.

- The user guide (`docs/guide/`) and a runnable `examples/quickstart/` project — an end-to-end
  `plune.yaml`, two datasets and a GitHub Actions workflow — now ship in this repo instead of the
  private platform repo, so the documentation sits beside the code it documents.

## [0.6.0] - 2026-08-01

### Added

- **`plune ingest <dir>` — record a Cairn run in Plune.** Reads a Cairn run directory (Cairn 0.7.0 or
  newer, which stamps its artifact format) and uploads what Plune records. Nothing uploaded becomes a
  test case: generated cases arrive in Plune's review queue as proposals for a person to accept or
  refuse, so a run cannot fill a project with cases nobody authored. The command prints three counters
  — results attached, cases proposed, cases skipped — which always account for every case sent.

  Cairn is not a dependency and does not learn about Plune. We parse its published artifact and depend
  on its `schemaVersion`, nothing else; a version this CLI does not know is refused by name rather than
  parsed on a guess. An unfinished run and evidence that cannot be joined to its cases unambiguously
  are refused the same way, and a refusal uploads nothing at all.

  `plune run` still works with no account, no token and no network (ADR 0006) — `ingest` is opt-in,
  like `sync`.

### Changed

- **Local embeddings ship separately now.** `@huggingface/transformers` moved from a hard dependency
  to an **optional peer**, so installing `@plune-ai/cli` no longer drags in the native embedding stack
  (`onnxruntime` → `sharp`, `adm-zip`, `protobufjs`) unless you actually want it.

  It powers exactly two things — the `semantic-similarity` assertion and the RAG suite. Everything else
  works untouched, and the import was already lazy, so nothing about the happy path changes. What
  changes is the failure: without the package those assertions now say which package to install instead
  of throwing `MODULE_NOT_FOUND`.

  **To keep them:** `npm i @huggingface/transformers` (or `pnpm add`) alongside the CLI.

  The reason is not tidiness. That tree carried **four HIGH advisories**, and it was being installed
  into every consumer — including a server that depends on this package purely for its zod contracts
  and never executes a line of it.

- `ajv` bumped to `^8.17.1`, which clears the `fast-uri` advisories.

## [0.5.0] - 2026-07-27

### Added

- **`sync()` is callable from code, not only from a shell.** `run()` has been the programmatic half of
  `plune run` for a while; `sync()` is now the same thing for the upload, for the same callers — CI
  code driving Plune directly instead of shelling out.

  Its failures ship as classes, because a caller has to tell "log in" (exit code 2) apart from "the
  network is down" (exit code 1): `NotLoggedInError`, `TokenRejectedError`, `SyncFileError`,
  `SyncNetworkError`, `SyncHttpError` — plus `reportSyncFailure` and the `SyncDeps` / `SyncResult`
  types.

  This is also what lets the platform test itself against the real client instead of against a
  hand-rolled POST of its own.

## [0.4.0] - 2026-07-27

### Added

- **`plune login`, `plune logout` and `plune sync` — this CLI can now reach the Plune platform.**
  The three commands used to live in the unpublished platform repo, so the copy anyone could install
  was unable to connect, and the copy that could connect was unavailable. They live here now.

  Local behaviour is unchanged and stays that way: `run`, `report`, `diff` and `init` need no account,
  no token and no network. The cloud commands load nothing until you invoke one, and they fail with a
  single actionable line instead of a stack trace — **exit 2** when you have to act (log in, fix the
  file), **exit 1** when the environment is at fault (network, server). The token is stored `0600`
  under your config directory and is never printed, returned or logged.

- **`assertionConfigSchema` is exported from the public API.** Anything that stores assertions of its
  own can now validate them with the runner's own schema instead of keeping a copy that drifts.

- **The RunResult validator is exported too**, for consumers that ingest a run rather than produce
  one: `parseRunResult`, `runResultSchema`, `RUN_RESULT_SCHEMA_VERSION`, `assertionResultRecordSchema`,
  `binaryVerdictSchema`, and the `ParsedRunResult` / `BinaryVerdict` types. `plune sync` validates the
  file with it before uploading and the platform validates the same body on receipt — one schema on
  both ends, so the two cannot disagree quietly.

## [0.3.0] - 2026-06-30

### Changed

- **BREAKING (wire format):** `plune run --format json` renames the RunResult version field
  `schema` → `schemaVersion`. The value is unchanged (`1`); only the key moved. **Anything reading the
  top-level `schema` key must switch to `schemaVersion`** — a reader that does not will see the field
  as absent rather than fail loudly, which is the dangerous half of this change.

  It aligns the CLI's output with the frozen TMS data contracts (plune-ai/plune#75). The rename also
  reaches the exported types (`RunResult`), so a TypeScript consumer is told at compile time; a
  consumer parsing the JSON by hand is not, which is why it is spelled out here.

  Version bumped `0.2.x` → `0.3.0` per the pre-1.0 policy.

## [0.2.3] - 2026-06-29

### Fixed

- **The CLI no longer exits silently when installed on Linux or macOS.** `plune <anything>` printed
  nothing, wrote no `-o` file and exited 0. npm and npx install the binary as a symlink on those
  platforms, and the entry-point guard compared the invoked path with the module path as plain strings
  — `.bin/plune` never matched `dist/cli.cjs`, so the program simply never executed. The two paths are
  now compared after resolving symlinks. Windows shims pass the real path, which is why it never
  reproduced there.

### Changed

- README: cross-links to plune.ai and the Marketplace listing, and a stale claim about what
  `plune init` scaffolds removed.

## [0.2.2] - 2026-06-14

### Fixed

- **Releasing works from the tag alone.** The publish job refused to run unless `package.json` already
  carried the tag's version, so pushing a `vX.Y.Z` tag without a preceding manual `npm version` stopped
  the release; it now sets the version from the tag. The release job also stopped passing a flag to
  `gh release edit` that only `gh release create` accepts, so re-running a release no longer fails.

## [0.2.1] - 2026-06-14

### Changed

- Release plumbing only — tag-triggered publishing to npm and GitHub Packages, and CI runners moved to
  Node 24. No change to the CLI itself: the source is identical to 0.2.0.

## [0.2.0] - 2026-06-14

First public release. Released from commit `ba43100`; no `v0.2.0` tag exists.

### Added

- `plune run` — run an assertion suite from `plune.yaml` against a provider, with result
  caching, cost reporting, and `--dry-run`, `--only <id|tag>`, `--bail`, `--no-cache`,
  `--concurrency <n>`, `--format console|json|markdown`, `-o <file>`.
- `plune report` — re-render the most recent run in any supported format.
- `plune diff <baseline> <current>` — compare two `plune run --format json` outputs and
  report pass→fail regressions, with `--fail-on-regression` for CI gating.
- `plune init` — scaffold `plune.yaml`, an example dataset, and `.env.example`
  (interactive wizard, or `--yes` for CI).
- Providers: Anthropic, OpenAI, OpenRouter.
- Ten assertion types: `exact-match`, `contains`, `contains-any`, `contains-all`,
  `json-schema`, `llm-judge`, `semantic-similarity`, `faithfulness`, `answer-relevance`,
  `context-precision`.

[Unreleased]: https://github.com/plune-ai/cli/compare/v0.17.0...HEAD
[0.17.0]: https://github.com/plune-ai/cli/compare/v0.16.0...v0.17.0
[0.16.0]: https://github.com/plune-ai/cli/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/plune-ai/cli/compare/v0.14.3...v0.15.0
[0.14.3]: https://github.com/plune-ai/cli/compare/v0.14.2...v0.14.3
[0.14.2]: https://github.com/plune-ai/cli/compare/v0.14.1...v0.14.2
[0.14.1]: https://github.com/plune-ai/cli/compare/v0.14.0...v0.14.1
[0.14.0]: https://github.com/plune-ai/cli/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/plune-ai/cli/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/plune-ai/cli/compare/v0.11.1...v0.12.0
[0.11.1]: https://github.com/plune-ai/cli/compare/v0.11.0...v0.11.1
[0.11.0]: https://github.com/plune-ai/cli/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/plune-ai/cli/compare/v0.9.1...v0.10.0
[0.9.1]: https://github.com/plune-ai/cli/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/plune-ai/cli/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/plune-ai/cli/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/plune-ai/cli/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/plune-ai/cli/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/plune-ai/cli/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/plune-ai/cli/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/plune-ai/cli/compare/v0.2.3...v0.3.0
[0.2.3]: https://github.com/plune-ai/cli/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/plune-ai/cli/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/plune-ai/cli/releases/tag/v0.2.1
[0.2.0]: https://github.com/plune-ai/cli/commit/ba43100599f4808b8426ddece0a9cc22ccf1e6c3
