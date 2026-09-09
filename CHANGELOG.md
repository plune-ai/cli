# Changelog

All notable changes to `@plune-ai/cli` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each section is dated from the release tag it names. `0.2.1`, `0.2.2` and `0.2.3` were published from
tags whose committed `package.json` still read `0.2.0` — the publish job takes the version from the
tag (see 0.2.2), so the tag is the authority for what shipped, not the committed file.

## [Unreleased]

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

[Unreleased]: https://github.com/plune-ai/cli/compare/v0.9.1...HEAD
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
