# Changelog

All notable changes to `@plune-ai/cli` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
