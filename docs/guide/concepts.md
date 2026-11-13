# How it works

This page explains what happens under the hood when you run `plune run`. You don't need it to use
Plune, but it makes the behavior (especially caching and error handling) predictable.

## The run pipeline

For each selected eval, and each row of its dataset, Plune does this:

```
row.vars ─▶ resolve prompt ({{var}})
              │
              ▼
          cache key = hash(provider, model, temperature, max_tokens, resolved-prompt)
              │
        ┌─────┴───────────── cache hit? ──────────────┐
        │ yes                                          │ no
        ▼                                              ▼
  use cached output (cached: true, cost 0)      call the provider ──▶ store in cache
        │                                              │
        └──────────────────┬───────────────────────────┘
                           ▼
              run every assertion on the output
              (injecting a local embedder + an LLM judge as needed)
                           ▼
                   RowResult { output, cached, usage, assertions[] }
```

All rows of an eval run concurrently (up to `provider.concurrency`). Results are collected in dataset
order, then rolled up into a `RunResult`.

Before any of this, Plune does a **pre-flight pass**: it resolves every prompt against every row. If
a prompt references a variable a row doesn't have, that's a config error and Plune exits `2` *before*
making a single model call.

## Caching

The expensive part of a run is the model call. Plune caches completions in a local SQLite database at
**`.plune/cache.db`**.

- **The cache key** is a hash of exactly five things: provider, model, temperature, max_tokens, and
  the *resolved* prompt. **Assertions are not part of the key.** With [repeats](#repeats), every run
  of a row after the first adds its number to the key, so the runs are real calls, not one call
  replayed; the first run keys as it always did.
- **Why that matters:** changing an assertion (or adding one) does **not** invalidate the cached
  output — Plune re-runs the cheap assertions over the cached completion for free. Changing the
  prompt, model, or sampling settings *does* produce a new key, so you get a fresh call.
- Entries are kept permanently (there's no expiry in v0.1). Use **`--no-cache`** to ignore the cache
  for a run, or delete `.plune/cache.db` to clear it.
- The cache is an *optimization, not a source of truth*: if the database is missing or corrupt, Plune
  silently treats it as a miss and carries on — a broken cache never fails your run.

## Cost

Plune reports an estimated USD cost from token usage:

- Each provider call's tokens are priced (using built-in rates, overridable via the `pricing` block).
- **Cache hits cost `0`** — no new call was made.
- **LLM-judged assertions** (`llm-judge`, `faithfulness`, …) make their own model calls; that cost is
  attributed to the row that triggered them, so the run total includes it.
- **`--dry-run`** estimates cost from the prompt length and `max_tokens` without calling anything.
  With `runs` above `1` the estimate is multiplied by `runs`, and the report shows the multiplier.
  A dry run gives a price and no verdict: no row counts as passed, failed or errored, and the
  result is not saved as the last run.
- **With repeats** a row's `usage` is the sum over its runs, so the run total is what every run cost.

## errored vs failed

This is the most important distinction in Plune. A row ends in exactly one of three states:

| State | What happened | Counts toward |
|-------|---------------|---------------|
| **passed** | The output came back and **every** assertion passed. | `passed` |
| **failed** | The output came back but **an assertion didn't pass**. A quality problem. | `failed` → exit `1` |
| **errored** | The model call itself failed (e.g. provider outage after retries), or a judge/embedder couldn't run. No output. | `errored` → exit `2` (if no `failed`) |

The point: **a model being down is not the same as your prompt being wrong.** Plune counts and
exit-codes them separately so an outage in CI doesn't look like a quality regression. `--bail` stops
the run after the first failing eval.

An errored row is not a pass either. When `plune diff` compares two runs, an eval whose rows errored in
the current run, or one that errored in the baseline and fails now, has no verdict: it is counted as
`unmeasured`. With `--fail-on-regression`, a run with no regression but with unmeasured evals exits `3`
rather than `0` (a regression still exits `1`). See [`plune diff` exit codes](./cli.md#exit-codes).

The same rule holds for the other gates of `plune diff` (pass rate, cost, tokens): a value that is
missing never gives green. A cost gate on a run whose model has no known price, an overall pass rate
compared between runs that measured different evals, rows, repeats, models or checks, or one with fewer
than 10 attempts on a side, is `unmeasured` (exit `3`), and a waiver never lifts that. To make the pass
rate comparable, `plune run` records per eval what it measured (`measured`: repeats, rows, a hash of the
rows' `vars`, a hash of the checks, the model), without the prompt text, since changing the prompt is
what a pull request is checked for.

A row in a RunResult may also say it was never judged: `"inconclusive": "blocked"` or `"skipped"`.
That word comes first: such a row counts as `blocked` or `skipped` in the summary, whatever its
assertions or its error say, and it moves no exit code. `plune run` always writes both counters, and
`passed + failed + errored + blocked + skipped` is `total`.

## Repeats

With `runs` above `1` ([configuration](./configuration.md#repeats-runs-and-pass_threshold)) each row
runs several times and still ends in one of the three states. Of its runs, `P` passed, `F` failed
and `E` errored; the row needs `needed = ceil(pass_threshold × runs)` passes:

| Condition | Row |
|-----------|-----|
| `P ≥ needed` | **passed** |
| otherwise, `P + E ≥ needed` | **errored** |
| otherwise | **failed** |

**Why `errored` is not `failed`.** When the runs that could not be measured might still have
reached the threshold, the verdict rests on what was never measured. With `runs: 10` and
`pass_threshold: 0.8`, 6 passes, 1 fail and 3 provider errors could have been 9 passes: that row is
`errored`, as an outage is. A run that was not measured is never a pass and never a quality fail.

The row's `output`, `assertions` and `error` are those of its first run in the row's own state
(the first passing run of a passed row, the first errored run of an errored one), so `plune diff`,
the exit code and the summary read a repeated row as any other. Every run is in the row's
`attempts`: `runs`, `pass_threshold`, the `passed`, `failed` and `errored` counts, and
`results`, one entry per run (`output`, `cached`, `usage`, `latency_ms`, `error`,
`assertions`). `usage`, `cache_saved` and `latency_ms` of the row are sums over its runs, and
`cached` is true only when every run came from the cache. `summary.cache` still counts rows: a
row with some runs from the cache counts as `from_model`. Under `--cache-strict` a row is listed as
missed when any of its runs had no cache entry, whatever its verdict. On a dry run `results` is
empty. Without `runs` a row has no `attempts`, and the reports read exactly as before; with them
the console and Markdown reports show `7/10` and the row's state.

## Friction signals

For a row with an `mcp` server, `plune run` looks at the order of the calls the model made and files what it finds as
advice on the row (`agent.advice`, shown in the console and Markdown reports): a hint where the model may have spent steps
it did not need. It never changes a row's state, the summary or the exit code, and each hint says when it may be fine.

| Signal | What it means |
|--------|---------------|
| `identical-retry` | A call with the same tool and the same arguments (key order aside) as the call right before it, in the same step or the next one. |
| `pagination-continuation` | A call that differs from the one before it only in pagination arguments (`cursor`, `page`, `offset`, `limit`, `after`, `before`, `start`, `pageToken`, `nextCursor`, and the snake_case forms `page_token`, `next_cursor`). Not a repeat. |
| `search-after-id` | The same tool called again with other arguments in a **later step**, after an earlier answer of that tool already held an identifier. Calls of one step run from one model turn, so none could read another's answer: inside a step this signal is never given. |
| `friction-unmeasured` | The earlier answer could not be read as JSON, so identifiers were not looked for. This is not the same as finding none. |

An identifier is a value under a key named `id`, `ids`, `key`, `uuid`, `slug`, `number`, `ref` or `identifier` (the whole
name, after an underscore as in `user_id`, or after a capital as in `userId`), or a string in the form of a UUID anywhere.
The walk goes 6 levels deep and looks at the first 50 items of each array. This is a simple rule, so false hits are
expected, which is why it only advises. A signal carries the tool, the steps, a count and the key paths where an
identifier was found (`items[].id`), never the identifiers themselves. The signals are computed while the full answers of
the tools are in memory; the stored transcript keeps only excerpts of them.

## Providers

Plune talks to three providers: **`anthropic`**, **`openai`**, and **`openrouter`**.

- The API key comes from the environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  `OPENROUTER_API_KEY`) — never from a file, never logged.
- Transient failures (rate limits, 5xx) are retried with backoff; if they still fail, the row is
  `errored` (not `failed`).
- A missing/invalid key is a config error → exit `2`, with a message naming the variable.

## Embeddings (for semantic checks)

`semantic-similarity` compares meaning, which needs *embeddings*. Plune computes these **locally**
with a small model via `@huggingface/transformers` — no external API, no per-call cost. The model is
downloaded once on first use and cached on disk; the first semantic run is therefore a little slower.

## The LLM judge

The LLM-judged assertions (`llm-judge`, `faithfulness`, `answer-relevance`, `context-precision`) need
a model to *evaluate* the output. Plune builds a "judge" from your configured provider, always at
**temperature 0** (for stable verdicts). Each judge asks for a small JSON verdict, which Plune parses
into a score. `llm-judge` can point at a different model via its own `provider:` field.

## The RunResult

Every run produces a `RunResult`. A measured run saves it to `.plune/last-run.json`; a dry run
only prints it (`--format json`) and leaves the saved one as it was. Its shape:

```jsonc
{
  "schema": 1,
  "plune_version": "0.1.0",
  "started_at": "2026-06-11T09:00:00.000Z",
  "finished_at": "2026-06-11T09:00:04.210Z",
  "config_hash": "…64 hex chars…",      // identifies the exact config that ran
  // "dry_run": true,                    // only on --dry-run: rows priced, none run; every row is
  //                                     // "inconclusive": "skipped" and no eval is "passed"
  "summary": {
    "total": 15, "passed": 12, "failed": 2, "errored": 1, "blocked": 0, "skipped": 0,
    "cost_usd": 0.0431, "duration_ms": 4210
  },
  "evals": [
    {
      "id": "faq-tone",
      "tags": ["smoke"],
      "passed": false,                   // true only if all rows passed
      "rows": [
        {
          "vars": { "question": "…" },
          "output": "…",                 // null when errored / dry-run
          "cached": false,
          "usage": { "input_tokens": 120, "output_tokens": 48, "cost_usd": 0.0012 },
          "latency_ms": 380,
          "assertions": [
            { "type": "contains", "passed": true },
            { "type": "llm-judge", "passed": false, "score": 0.4, "reason": "too terse" }
          ]
          // "error": { "code": "...", "message": "..." }  // present only when errored
          // "attempts": { "runs": 10, "pass_threshold": 0.8, "passed": 7, ... }  // only with runs > 1, see Repeats
        }
      ],
      "measured": { "runs": 1, "rows": 1, "rows_hash": "…", "assertions_hash": "…", "model": "openai/gpt-4o-mini" }
      // what the eval measured, for the pass-rate gate of `plune diff`; absent in results of older versions
    }
  ]
}
```

This is stable (`schema: 1`) and meant to be machine-read — pipe it into your own tooling today, and
`plune report` will render it nicely soon.

## See also

- **[Configuration](./configuration.md)** · **[Assertions](./assertions.md)** · **[CLI reference](./cli.md)**
