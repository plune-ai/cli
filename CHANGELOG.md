# Changelog

All notable changes to `@plune-ai/cli` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

  `plune run` still works with no account, no token and no network (ADR 0006) — this is opt-in like
  `sync`.

### Changed

- **BREAKING (wire format):** `run --format json` output renames the RunResult version field
  `schema` → `schemaVersion` (value unchanged, `1`), aligning the CLI with the frozen TMS data
  contracts (plune-ai/plune#75). Consumers reading the top-level `schema` key must switch to
  `schemaVersion`.

## [0.2.0] - 2026-06-14

First public release.

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

[Unreleased]: https://github.com/plune-ai/cli/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/plune-ai/cli/releases/tag/v0.2.0
