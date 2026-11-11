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
    assertions:                  # required — `[]` when defaults.assertions cover it
      - type: faithfulness
        context: "{{context}}"
        threshold: 0.7
```

## Top-level fields

| Field | Required | Meaning |
|-------|----------|---------|
| `version` | yes | Schema version. Always `1`. |
| `provider` | yes | Default model for all evals (see below). |
| `defaults.assertions` | no | Assertions run on every eval (shared checks), ahead of the eval's own. A check listed both here and in an eval runs twice (an `llm-judge` one is also paid twice). An eval that relies on these alone still writes `assertions: []`. |
| `pricing` | no | Per-model USD price overrides used for cost reporting. |
| `runs` | no | How many times each dataset row runs, for every eval (default `1`). See [Repeats](#repeats-runs-and-pass_threshold). |
| `pass_threshold` | no | Share of a row's runs that must pass, for every eval (default `1`). See [Repeats](#repeats-runs-and-pass_threshold). |
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
| `assertions` | yes | The checks to run on each row's output, after `defaults.assertions`. `[]` is allowed when the shared checks cover the eval. |
| `runs` | no | Overrides the top-level `runs` for this eval. |
| `pass_threshold` | no | Overrides the top-level `pass_threshold` for this eval. |

\* Provide **either** `prompt` **or** `prompt_file`.

### Prompt variables

The prompt uses `{{var}}` placeholders, filled from each row's `vars`:

```yaml
prompt: "Translate to {{lang}}: {{text}}"
```

If a prompt references a variable that a row doesn't have, that's a **configuration error** — Plune
stops before calling the model and exits `2`. (This is different from assertion placeholders; see below.)

## Repeats (`runs` and `pass_threshold`)

A model is not deterministic: one run cannot tell a flaky case from a broken one. `runs` makes every
row of an eval run that many times, and `pass_threshold` says what share of those runs must pass for
the row to pass.

```yaml
runs: 1                 # top level: the default for every eval
evals:
  - id: support-tone
    runs: 10            # each row runs 10 times, one run after another
    pass_threshold: 0.8 # at least 8 of the 10 must pass
    # ...
```

| Field | Values | Default | Meaning |
|-------|--------|---------|---------|
| `runs` | whole number, `1` to `100` | `1` | Runs per row. `--runs <n>` overrides it for one run. |
| `pass_threshold` | above `0`, at most `1` | `1` | Share of a row's runs that must pass. `0` is rejected: it would pass with no passing run at all. |

- An eval value wins over the top-level one.
- The cap of `100` keeps one typo in a config from costing hundreds of model calls per row.
- The runs of one row go **one after another**; rows still run in parallel, as before. A run does not
  compete with its siblings for the provider's rate limit, or for the state of a server under test.
  A run with repeats takes longer and costs `runs` times as much.
- A row needs `ceil(pass_threshold × runs)` passing runs. The threshold is coarse on few runs:
  `pass_threshold: 0.8` with `runs: 2` means both, and `runs: 1` with any threshold below `1` is
  the same as `1`. For a threshold below `1`, use at least `runs: 5`.
- Every run is played to the end, even once the verdict is settled: the count of passing runs is the
  measure of how flaky the case is.
- **The cache keeps every run apart.** Run 1 has the cache key a row always had, and each further run
  has one of its own, so `runs: 10` calls the model ten times. The next run of the same config
  replays the same ten answers from the cache. To measure flakiness afresh, pass `--no-cache`.

Not the same as the `pass_threshold` of an [`llm-judge`](./assertions.md#llm-judge) assertion: that
one is the lowest judge score (0–1) one answer needs, and it sits inside the assertion. The eval's
`pass_threshold` sits beside `runs` and counts runs. A config error names which of the two it is about.

How a row's runs become one verdict, and why a run that could not be measured does not count as a
fail, is in [How it works](./concepts.md#repeats).

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
