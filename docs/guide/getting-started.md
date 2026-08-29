# Getting started

This walks you from zero to your first passing eval. It assumes no prior knowledge of Plune.

## 1. Prerequisites

- **Node.js ≥ 20** (`node --version` to check).
- **An LLM provider API key** — Anthropic, OpenAI, or OpenRouter. You'll set it as an environment
  variable (Plune never stores keys in files or logs).

## 2. Install

```bash
# Target (once published to npm):
npm install -g @plune/cli
plune --version
```

> **Pre-release note.** Until the npm package is published, build from source:
> ```bash
> git clone https://github.com/plune-ai/plune.git
> cd plune
> pnpm install        # pnpm ≥ 8
> pnpm build
> npm link            # makes `plune` available globally
> plune --version
> ```

## 3. Set your API key

Plune reads the key from the environment — it is never written to disk. Set the one matching your
provider:

```bash
# macOS / Linux
export ANTHROPIC_API_KEY="sk-ant-..."     # for provider type: anthropic
export OPENAI_API_KEY="sk-..."            # for provider type: openai
export OPENROUTER_API_KEY="sk-or-..."     # for provider type: openrouter
```

```powershell
# Windows (PowerShell)
$env:ANTHROPIC_API_KEY = "sk-ant-..."
```

If the key is missing or wrong, Plune stops with a clear message naming the variable, and exits `2`
(a configuration error).

## 4. Create a config

The easiest way is the interactive wizard:

```bash
plune init
```

It asks a few questions (provider, model, dataset, …) and writes a `plune.yaml` for you.

Prefer to write it by hand? Create `plune.yaml`:

```yaml
version: 1

provider:
  type: anthropic
  model: claude-sonnet-4-5

evals:
  - id: capital-of-france
    prompt: "What is the capital of {{country}}? Answer with just the city name."
    dataset:
      examples:
        - vars: { country: France }
          expected: Paris
    assertions:
      - type: contains
        value: "{{expected}}"
        ignore_case: true
```

What this says, in plain words:

- Use Anthropic's `claude-sonnet-4-5`.
- One eval named `capital-of-france`.
- For each dataset row, fill `{{country}}` into the prompt and send it to the model.
- Check that the model's answer **contains** the row's `expected` value (`Paris`), case-insensitively.

(`dataset` can also be a path to a `.jsonl` file — see [Configuration](./configuration.md).)

## 5. Run it

```bash
plune run
```

You'll see a **console report** — a summary line plus details for anything that failed. The summary
line looks like:

```
1/1 passed · 0 failed · 0 errored · $0.0008
```

- **passed** — the row's output met every assertion.
- **failed** — an assertion didn't pass (a quality problem).
- **errored** — the provider call itself failed, e.g. an outage (an infrastructure problem, *not* a
  quality problem — see [How it works](./concepts.md)).

The full machine-readable result is saved to **`.plune/last-run.json`**. Prefer another shape? Add
`--format json` or `--format markdown` (optionally with `-o <file>`), or re-render the last run any
time with `plune report`.

## 6. Understand the exit code

`plune run` sets the process exit code so it works in CI and scripts:

| Exit | Meaning |
|------|---------|
| `0` | All assertions passed. |
| `1` | At least one assertion **failed** (a quality regression). |
| `2` | A **config/execution error**, or rows **errored** with no normal failures (infra problem). |

```bash
plune run && echo "all good" || echo "something failed (exit $?)"
```

## 7. Iterate cheaply

Change an assertion and run again — Plune reuses the cached model output (same prompt + model →
cache hit), so you pay nothing for the model call the second time:

```
1/1 passed · 0 failed · 0 errored · $0.0000   # cached
```

Changed the prompt or model? That's a new cache key, so Plune calls the model again. Want to force a
fresh call? Add `--no-cache`.

## Next steps

- **[Configuration](./configuration.md)** — datasets, multiple evals, tags, per-eval models, pricing.
- **[Assertions](./assertions.md)** — go beyond `contains`: JSON schema, semantic similarity, LLM judge, RAG.
- **[CLI reference](./cli.md)** — `--only`, `--dry-run`, `--concurrency`, `--bail`.
