# Configuration (`plune.yaml`)

Everything Plune runs is described in one YAML file. By default Plune looks for `plune.yaml` in the
current directory (override with `--config <path>`). This page documents every field.

## A complete, annotated example

```yaml
version: 1                       # required — config schema version (always 1 for now)

provider:                        # required — the default model for every eval
  type: anthropic                # anthropic | openai | openrouter
  model: claude-sonnet-4-5       # any model id the provider supports
  temperature: 0                 # optional — default 0 (deterministic-ish, reproducible)
  max_tokens: 1024               # optional — max output tokens (default 1024)
  concurrency: 4                 # optional — how many rows run in parallel (default 4)

defaults:                        # optional — assertions added to every eval
  assertions:
    - type: contains-any
      values: ["", " "]          # (toy example) shared checks live here

pricing:                         # optional — per-model price overrides for cost reporting
  claude-sonnet-4-5:
    input_per_1k_usd: 0.003
    output_per_1k_usd: 0.015

evals:                           # required — one or more evals
  - id: faq-tone                 # required — unique, [a-z0-9-_]
    description: "FAQ answers stay on-brand"   # optional
    tags: [smoke, rag]           # optional — filter with `--only tag:smoke`
    provider:                    # optional — override the top-level provider for THIS eval
      model: claude-haiku-4-5
    prompt: |                    # required (or prompt_file) — {{var}} is filled from each row
      You are a friendly FAQ bot.
      Question: {{question}}
    dataset: ./data/faq.jsonl    # a JSONL path — OR inline examples (see below)
    assertions:                  # required — at least one
      - type: faithfulness
        context: "{{context}}"
        threshold: 0.7
```

## Top-level fields

| Field | Required | Meaning |
|-------|----------|---------|
| `version` | yes | Schema version. Always `1`. |
| `provider` | yes | Default model for all evals (see below). |
| `defaults.assertions` | no | Assertions merged into every eval (shared checks). |
| `pricing` | no | Per-model USD price overrides used for cost reporting. |
| `evals` | yes | The list of evals to run (≥ 1). |

## `provider`

| Field | Required | Default | Meaning |
|-------|----------|---------|---------|
| `type` | yes | — | `anthropic`, `openai`, or `openrouter`. |
| `model` | yes | — | Model id (e.g. `claude-sonnet-4-5`, `gpt-4o`). |
| `temperature` | no | `0` | Sampling temperature. Keep at `0` for reproducible runs. |
| `max_tokens` | no | `1024` | Max output tokens per call. |
| `concurrency` | no | `4` | Rows run in parallel (per eval). Override per-run with `--concurrency`. |

The **API key is never in this file** — it comes from an environment variable
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `OPENROUTER_API_KEY`).

An eval can override any of these via its own `provider:` block (a partial override — unspecified
fields fall back to the top-level provider).

## `evals[]`

| Field | Required | Meaning |
|-------|----------|---------|
| `id` | yes | Unique identifier, `[a-z0-9-_]`. Used by `--only <id>` and in the report. |
| `description` | no | Free text. |
| `tags` | no | Labels for selection: `--only tag:<name>`. |
| `provider` | no | Partial override of the top-level provider for this eval. |
| `prompt` | yes\* | The prompt template. `{{var}}` is replaced from each dataset row's `vars`. |
| `prompt_file` | yes\* | Path to a file holding the prompt (alternative to `prompt`). |
| `dataset` | yes | Where the rows come from — a JSONL path or inline `examples`. |
| `assertions` | yes | The checks to run on each row's output (≥ 1). |

\* Provide **either** `prompt` **or** `prompt_file`.

### Prompt variables

The prompt uses `{{var}}` placeholders, filled from each row's `vars`:

```yaml
prompt: "Translate to {{lang}}: {{text}}"
```

If a prompt references a variable that a row doesn't have, that's a **configuration error** — Plune
stops before calling the model and exits `2`. (This is different from assertion placeholders; see below.)

## Datasets

A dataset is a list of **rows**. Each row has `vars` (values for the prompt) and an optional
`expected` answer. Two ways to provide it:

**Inline** — good for small/example sets:

```yaml
dataset:
  examples:
    - vars: { country: France }
      expected: Paris
    - vars: { country: Japan }
      expected: Tokyo
```

**JSONL file** — one JSON object per line, good for real datasets. Path is relative to the config file:

```yaml
dataset: ./data/capitals.jsonl
```

```jsonl
{"vars": {"country": "France"}, "expected": "Paris"}
{"vars": {"country": "Japan"}, "expected": "Tokyo"}
```

- `vars` — an object of `string | number | boolean` values used to fill the prompt's `{{placeholders}}`.
- `expected` — optional. It's the "right answer" for the row, and it's available **inside assertions**
  as `{{expected}}` (e.g. `value: "{{expected}}"`).

> **Two kinds of `{{ }}`, on purpose:**
> - In the **prompt**, `{{var}}` pulls from the row's `vars`. An unknown variable is a config error (exit 2).
> - In an **assertion parameter**, `{{expected}}` and `{{vars.X}}` are substituted; an unknown one is
>   left as-is (assertions are meant to be forgiving). See [Assertions](./assertions.md).

## `pricing` (cost reporting)

Plune estimates the USD cost of each run from token usage. It ships with indicative prices for common
models; override or add models here:

```yaml
pricing:
  my-self-hosted-model:
    input_per_1k_usd: 0.0
    output_per_1k_usd: 0.0
```

Cost is reported per row and summed for the run. Cache hits cost `0` (no new call).

## Concurrency

Within an eval, rows are processed in parallel up to `provider.concurrency` (default `4`). Raise it
to go faster, lower it to be gentle on rate limits. Override for a single run with `--concurrency <n>`.

## Next

- **[Assertions](./assertions.md)** — the ten check types in detail.
- **[CLI reference](./cli.md)** — running subsets, dry runs, and exit codes.
