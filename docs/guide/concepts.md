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
  the *resolved* prompt. **Assertions are not part of the key.**
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

Every run produces a `RunResult`, saved to `.plune/last-run.json`. Its shape:

```jsonc
{
  "schema": 1,
  "plune_version": "0.1.0",
  "started_at": "2026-06-11T09:00:00.000Z",
  "finished_at": "2026-06-11T09:00:04.210Z",
  "config_hash": "…64 hex chars…",      // identifies the exact config that ran
  "summary": {
    "total": 15, "passed": 12, "failed": 2, "errored": 1,
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
        }
      ]
    }
  ]
}
```

This is stable (`schema: 1`) and meant to be machine-read — pipe it into your own tooling today, and
`plune report` will render it nicely soon.

## See also

- **[Configuration](./configuration.md)** · **[Assertions](./assertions.md)** · **[CLI reference](./cli.md)**
