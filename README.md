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

**Links:** [plune.ai](https://plune.ai) | [npm](https://www.npmjs.com/package/@plune-ai/cli) | [GitHub Action on Marketplace](https://github.com/marketplace/actions/plune-eval-diff)

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
passed with `-c <path>`). A minimal example:

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
| `plune login` | Save a [Plune platform](https://plune.ai/platform) API token so `sync` and `ingest` can reach it. The token is **checked against the API before it is saved**, so a wrong one fails here rather than two commands later. Get one at `https://beta.plune.ai` → Settings → API tokens. Flags: `--token <token>` (omit to paste it or pipe it via stdin), `--skip-verify` (save without checking, for offline setup). |
| `plune logout` | Remove the saved token. |
| `plune sync` | Upload the latest local run to the platform. Flags: `--file <path>` to send a specific run JSON. |
| `plune run import <file>` | Turn a **JUnit XML** or **Playwright JSON** report into a run in Plune. Needs no provider key — nothing is generated. Flags: `--format junit\|playwright-json` (detected from the file when omitted), `--key <externalKey>` to land several reports in one run (with `PLUNE_SHARED_RUN=1` — see below), `--create` to offer unmatched tests to the review queue. |
| `plune run start` | Open a platform run — or join the one already carrying `--key` — and print its id. Flags: `--key <externalKey>` (generated when absent), `--json` for one machine-readable line. |
| `plune run finish <id>` | Close a platform run. This is what the reporter tells you to do for a run it had to leave open. Flags: `--terminate` to record it as cut short, `--reason <text>`. |
| `plune run exec -- <command>` | Open a run, run the command inside it, close the run — and exit with whatever the command returned. Sets `PLUNE_SHARED_RUN` for you, so anything reporting inside joins that run. Flags: `--key <externalKey>`. |
| `plune run delete <id>` | Delete a run and everything it produced — its results and the review-queue entries it raised. Approved test cases and the audit log stay. **Recoverable for six months** (ask Plune to put it back), then gone for good. No prompt: it is your data, and this command belongs in scripts. |
| `plune run report` | Replay `.plune/pending-results.jsonl` — send what the reporter could not. Flags: `--file <path>`. |
| `plune ingest [dir]` | Record a [Cairn](https://github.com/plune-ai/cairn) run in Plune. Omit `[dir]` for the newest run under `./runs`, or name the directory holding `report.json`. Generated cases arrive as **review proposals** — nothing is created until a person approves it. |

Global flags: `-c, --config <path>` · `-v, --verbose` · `--no-color`.

**Exit codes:** `0` everything passed · `1` an assertion failed · `2` configuration or execution error.

## Already running tests? Bring the results in

Everything above generates checks, which is why it needs a provider key. If you already have a
suite, there is nothing to generate — the results exist and only have to arrive, and that route
costs nothing beyond a Plune token.

```bash
plune login
plune run import ./junit.xml          # Jest, Vitest, pytest, PHPUnit, Surefire, Cypress, …
plune run import ./playwright.json    # or Playwright's own JSON report
```

The format is read from the file, not from its name. Statuses go over as the report wrote them and
Plune maps them per project, so `error` can mean something different to your team than to ours.
A test Plune has no case for is counted, and `--create` offers it to the review queue instead —
nothing becomes a test case until a person approves it.

For a Playwright suite there is also [`@plune-ai/playwright`](https://www.npmjs.com/package/@plune-ai/playwright),
which reports as the run happens and needs no second step:

```js
// playwright.config.ts
reporter: [['list'], ['@plune-ai/playwright']],
```

### Several jobs, one run

Two suites, or a sharded matrix, report into a single run when every job shares a key **and** knows
it is not the last one:

```bash
PLUNE_SHARED_RUN=1 plune run import ./junit.xml     --key "$GITHUB_RUN_ID"
PLUNE_SHARED_RUN=1 plune run import ./app/junit.xml --key "$GITHUB_RUN_ID"
plune run finish "$RUN_ID"                          # once, when they are all done
```

`PLUNE_SHARED_RUN=1` is what stops a job closing a run its siblings are still reporting into; the
key alone says where the results go, not who ends the run. Leave it unset in the last job and that
job closes the run instead of the explicit `finish`.

`plune run exec` sets it for you — anything reporting inside it, this command included, joins
without closing.

## Optional: keep a history

Everything above works with no account, no network, and no token — that does not change. `run`,
`report`, `diff` and `init` never open a socket, and that is the half this promise is about. If you
also want run history, trends, and a shared dashboard, the commands below push your local runs to
the [Plune platform](https://plune.ai/platform):

```bash
plune login          # paste the API token from your platform settings page
plune run            # exactly as before — the run is saved locally
plune sync           # upload .plune/last-run.json, print the read-back URL
```

The token is stored at `~/.config/plune/credentials.json` (mode `0600`, honours `XDG_CONFIG_HOME`)
and is never printed or logged. `PLUNE_API_URL` points `sync` at a different server — useful for a
self-hosted backend.

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
