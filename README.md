# @plune-ai/cli

> AI-powered assertion testing for LLM apps — a test runner for model behaviour.

[![npm](https://img.shields.io/npm/v/@plune-ai/cli)](https://www.npmjs.com/package/@plune-ai/cli)
[![CI](https://github.com/plune-ai/cli/actions/workflows/ci.yml/badge.svg)](https://github.com/plune-ai/cli/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@plune-ai/cli)](./LICENSE)

Plune runs an assertion suite against an LLM provider and gives you a pass/fail report —
locally, in CI, or as a regression diff between two runs. You describe the checks in one
`plune.yaml`; Plune calls the model, evaluates each assertion, caches results, and reports
token cost. Ten built-in assertion types cover plain text, JSON-schema, LLM-as-judge, and
RAG metrics (faithfulness, answer-relevance, context-precision).

## Install

```bash
npm install -g @plune-ai/cli      # or: pnpm add -g @plune-ai/cli
plune --version
```

Or run it without installing:

```bash
npx -y @plune-ai/cli run
```

Requires **Node.js ≥ 20**.

## Quickstart

```bash
# 1. Scaffold plune.yaml, an example dataset, and .env.example
plune init

# 2. Add your provider key (read from the environment / .env — never written to disk)
echo 'ANTHROPIC_API_KEY=sk-ant-...' >> .env

# 3. Run the assertions
plune run
# → 1/1 passed · 0 failed · 0 errored · $0.0008

# 4. Re-render the last run, or diff two runs to catch regressions
plune report --format markdown
plune diff baseline.json current.json --fail-on-regression
```

Each run writes its full result to `.plune/last-run.json`.

## Configuration

Plune reads a single `plune.yaml`, discovered by walking up from the working directory (or
passed with `-c <path>`). This is what `plune init` scaffolds:

```yaml
version: 1
provider:
  type: anthropic            # anthropic | openai | openrouter
  model: claude-3-5-sonnet-latest
evals:
  - id: example
    prompt: "Answer concisely. {{question}}"   # {{vars}} come from each dataset row
    dataset: datasets/example.jsonl            # a file path, or an inline `examples:` list
    assertions:
      - type: contains
        value: "Paris"
```

Datasets are JSONL, one row per line, shaped `{ "vars": { ... }, "expected"?: "..." }`. The
provider API key is read from the environment based on `provider.type`:

| Provider   | `provider.type` | Environment variable |
| ---------- | --------------- | -------------------- |
| Anthropic  | `anthropic`     | `ANTHROPIC_API_KEY`  |
| OpenAI     | `openai`        | `OPENAI_API_KEY`     |
| OpenRouter | `openrouter`    | `OPENROUTER_API_KEY` |

### Assertion types

| Type                  | Passes when…                                                     |
| --------------------- | ---------------------------------------------------------------- |
| `exact-match`         | output equals `value` (optional `trim`, `ignore_case`)           |
| `contains`            | output contains `value`                                          |
| `contains-any`        | output contains at least one of `values`                         |
| `contains-all`        | output contains every one of `values`                            |
| `json-schema`         | output validates against the JSON `schema`                       |
| `llm-judge`           | an LLM grades the output against `criteria` (≥ `pass_threshold`) |
| `semantic-similarity` | embedding similarity to `reference` ≥ `threshold`                |
| `faithfulness`        | output is grounded in `context` (RAG)                            |
| `answer-relevance`    | output actually answers the `question` (RAG)                     |
| `context-precision`   | `context` is relevant to the `question` (RAG)                    |

## Commands

| Command | Summary |
| ------- | ------- |
| `plune run` | Run the suite. Flags: `--dry-run`, `--only <id\|tag>` (repeatable), `--bail`, `--no-cache`, `--concurrency <n>`, `--format console\|json\|markdown`, `-o, --output <file>`. |
| `plune report` | Re-render the most recent run. Flags: `--format`, `-o`. |
| `plune diff <baseline> <current>` | Compare two `plune run --format json` outputs and report pass→fail regressions. Flags: `--fail-on-regression`, `--format`, `-o`. |
| `plune init` | Scaffold `plune.yaml`, a sample dataset, and `.env.example`. Flags: `--yes` (non-interactive), `--force`. |

Global flags: `-c, --config <path>` · `-v, --verbose` · `--no-color`.

**Exit codes:** `0` everything passed · `1` an assertion failed · `2` configuration or execution error.

## Programmatic API

The same engine that powers `plune run` is exported for use from your own code. Unlike the
CLI, the library does **not** parse argv or auto-load `.env` — set the provider key in
`process.env` yourself.

```ts
import { run } from '@plune-ai/cli';
import type { RunResult } from '@plune-ai/cli';

const result: RunResult = await run({ dryRun: false, configPath: 'plune.yaml' });
console.log(result.summary); // { total, passed, failed, errored, ... }
```

## Use in CI

Run Plune on every pull request and post a regression diff as a sticky comment with the
companion GitHub Action, [**plune-ai/eval-action**](https://github.com/plune-ai/eval-action):

```yaml
- uses: plune-ai/eval-action@v1
  with:
    config: plune.yaml
    fail-on-regression: true
```

## Contributing

Bug reports and pull requests are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md). For
security issues, see [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE) © Plune Contributors
