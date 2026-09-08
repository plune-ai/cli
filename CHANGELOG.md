# Changelog

All notable changes to `@plune-ai/cli` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each section is dated from the release tag it names. `0.2.1`, `0.2.2` and `0.2.3` were published from
tags whose committed `package.json` still read `0.2.0` — the publish job takes the version from the
tag (see 0.2.2), so the tag is the authority for what shipped, not the committed file.

## [Unreleased]

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

[Unreleased]: https://github.com/plune-ai/cli/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/plune-ai/cli/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/plune-ai/cli/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/plune-ai/cli/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/plune-ai/cli/compare/v0.2.3...v0.3.0
[0.2.3]: https://github.com/plune-ai/cli/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/plune-ai/cli/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/plune-ai/cli/releases/tag/v0.2.1
[0.2.0]: https://github.com/plune-ai/cli/commit/ba43100599f4808b8426ddece0a9cc22ccf1e6c3
