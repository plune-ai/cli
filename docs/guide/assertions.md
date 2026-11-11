# Assertions

An **assertion** is one check on a model's output. Each has a `type` and its own parameters, and
returns pass/fail (some also return a `score` from 0 to 1 and a human-readable `reason`). An eval
runs **all** its assertions on every dataset row.

There are 24 types, in four families:

- **Deterministic** — fast, free, no network. Exact text / substring / JSON-shape checks.
- **Semantic** — meaning-based, using a small **local** embedding model (no external API).
- **LLM-judged** — an LLM evaluates the output (uses your provider; costs tokens).
- **Tool calls** — in an eval with an `mcp` server: which tools the model called, with what arguments, in what
  order, and at what cost ([below](#tool-call-checks-agentic-evals)).

> **String parameters support `{{ }}`.** In any assertion, `{{expected}}` is replaced with the
> row's `expected` value and `{{vars.X}}` with a row variable — so you can compare against the
> dataset's expected answer (e.g. `value: "{{expected}}"`). An unknown placeholder is left as-is.

---

## Deterministic checks

### `exact-match`
The output equals `value` exactly.

| Param | Required | Default | Meaning |
|-------|----------|---------|---------|
| `value` | yes | — | The string to match (supports `{{expected}}`). |
| `trim` | no | `false` | Trim surrounding whitespace on both sides before comparing. |
| `ignore_case` | no | `false` | Case-insensitive comparison. |

```yaml
- type: exact-match
  value: "{{expected}}"
  trim: true
  ignore_case: true
```

### `contains`
The output contains `value` as a substring.

| Param | Required | Default | Meaning |
|-------|----------|---------|---------|
| `value` | yes | — | Substring to look for. |
| `ignore_case` | no | `false` | Case-insensitive. |

```yaml
- type: contains
  value: "Paris"
  ignore_case: true
```

### `contains-any`
Passes if the output contains **at least one** of `values`.

```yaml
- type: contains-any
  values: ["hello", "hi", "welcome"]
  ignore_case: true
```

### `contains-all`
Passes only if the output contains **every** entry in `values`. (On failure, the `reason` lists what
was missing.)

```yaml
- type: contains-all
  values: ["name", "email", "phone"]
```

### `json-schema`
The output is valid JSON that conforms to a [JSON Schema](https://json-schema.org/).

| Param | Required | Default | Meaning |
|-------|----------|---------|---------|
| `schema` | yes | — | A JSON Schema object. |
| `extract` | no | `auto` | `auto`: pull JSON out of the output (a ```` ```json ```` block or the first balanced `{…}`/`[…]`), then validate. `strict`: the **whole** output must be valid JSON. |

```yaml
- type: json-schema
  extract: auto
  schema:
    type: object
    required: [score, reason]
    properties:
      score: { type: number }
      reason: { type: string }
```

Use `auto` when the model tends to wrap JSON in prose or markdown fences; `strict` when you demand a
pure-JSON response. A non-JSON output (or one that doesn't match) **fails** with a reason — it never
crashes the run.

---

## Semantic check

### `semantic-similarity`
Passes if the output is **semantically close** to a reference text — i.e. the cosine similarity of
their embeddings is at least `threshold`. Great when the wording can vary but the meaning shouldn't.

| Param | Required | Default | Meaning |
|-------|----------|---------|---------|
| `reference` | yes | — | The text to compare against (supports `{{expected}}`). |
| `threshold` | no | `0.8` | Minimum cosine similarity (0–1) to pass. |

```yaml
- type: semantic-similarity
  reference: "{{expected}}"
  threshold: 0.82
```

Embeddings are computed **locally** with a small model (via `@huggingface/transformers`) — no
external API. The model is downloaded once on first use and cached. This assertion reports a `score`
(the similarity).

---

## LLM-judged checks

These ask an LLM to evaluate the output. They use your configured provider as the "judge" (at
temperature 0), so they cost tokens — and that cost is included in the run total. All four report a
`score` and a `reason`.

### `llm-judge`
An LLM scores how well the output meets a free-text `criteria`.

| Param | Required | Default | Meaning |
|-------|----------|---------|---------|
| `criteria` | yes | — | What "good" means, in plain language. |
| `pass_threshold` | no | `0.5` | Minimum score (0–1) to pass. Not the eval's `pass_threshold`, which is the share of [repeated runs](./configuration.md#repeats-runs-and-pass_threshold) that must pass. |
| `provider` | no | (eval's provider) | Use a different model as the judge. |

```yaml
- type: llm-judge
  criteria: "The answer is correct, concise, and polite."
  pass_threshold: 0.7
```

### `faithfulness` (RAG)
Of the factual claims in the output, what fraction is supported by the provided `context`? Catches
hallucinations in retrieval-augmented answers.

| Param | Required | Default | Meaning |
|-------|----------|---------|---------|
| `context` | yes | — | The source of truth the answer must stick to (supports `{{vars.X}}`). |
| `threshold` | no | `0.7` | Minimum fraction of supported claims to pass. |

```yaml
- type: faithfulness
  context: "{{vars.retrieved_doc}}"
  threshold: 0.7
```

### `answer-relevance` (RAG)
Is the output actually relevant to the `question`? (An LLM generates the questions the answer would
address; their similarity to the real question becomes the score.)

```yaml
- type: answer-relevance
  question: "{{vars.user_question}}"
  threshold: 0.7
```

### `context-precision` (RAG)
Does the provided `context` actually contain what's needed to answer the `question`? Measures
retrieval quality, not the answer.

```yaml
- type: context-precision
  context: "{{vars.retrieved_doc}}"
  question: "{{vars.user_question}}"
  threshold: 0.7
```

---

## Tool-call checks (agentic evals)

An eval with an [`mcp` server](./configuration.md#mcp-servers-mcp) keeps a transcript of its tool loop on each
row: every tool the server listed, every model step, every call with its arguments, its time, its error and the
size of its answer. These checks read that transcript: did the model pick the right tool, did it call one it
should not have, did it stay within budget. They work only in an eval with `mcp`; anywhere else (including
`defaults.assertions` reaching an eval without `mcp`) `plune run` stops with exit `2` before any model call.
The checks on the output above still work in an agentic eval, on the model's final answer.

Each check has a class:

- **measure** — a number against a threshold you set;
- **deterministic** — yes or no by a rule;
- **heuristic** — advice. It never changes a row's status or the exit code, is not in the row's `assertions`,
  and no setting makes it a gate. What it finds goes to the row's `agent.advice` and is shown in the console
  and Markdown reports.

| Type | Class | Params | Checks |
|------|-------|--------|--------|
| `tool-called` | deterministic | `tool`, `min_count` (default `1`) | `tool` was called at least `min_count` times, whatever the arguments |
| `tool-not-called` | deterministic, negative | `tool` | `tool` was never called |
| `tool-args` | deterministic | `tool`, `args`, `match` (`partial` default, `exact`, `ignore`), `min_count` (default `1`) | at least `min_count` calls of `tool` have arguments that match `args` |
| `tool-order` | deterministic | `tools`, `strict` (default `false`) | the calls come in this order; other calls may come between, unless `strict`, where the calls are exactly `tools` |
| `only-tools` | deterministic, negative | `tools` (may be `[]`) | no tool off the list was called; `[]` means no call at all |
| `first-tool` | deterministic | `tool` | the first call is `tool`; no call at all fails, and says so |
| `no-tool-errors` | deterministic, negative | `tool` (optional) | no call had an error: `isError`, a JSON-RPC error, a timeout, a tool that was not offered, arguments that are not an object |
| `tool-call-count` | measure | `tool` (optional), `min`, `max` (inclusive, at least one) | the number of calls is within the bounds |
| `no-repeated-call` | **heuristic** | `tool` (optional) | no call repeats the one right before it (same name, same arguments) |
| `token-budget` | measure | `max` | input + output tokens over every step are at most `max` |
| `tool-latency` | measure | `max_ms`, `tool` (optional) | every call that ran took at most `max_ms` |
| `tool-result-size` | measure | `max_bytes`, `tool` (optional) | every answer is at most `max_bytes`, measured before the transcript cut it to its excerpt |
| `tool-result-schema` | deterministic | `schema`, `tool` (optional) | every answer that is not an error parses as JSON that fits the JSON Schema |
| `no-destructive-tool` | deterministic, negative | — | no called tool may be destructive by its annotations |

A call counts once the model asked for it, whether or not it ran. A tool name in a check must be one the model
was offered at some point of the row (the server listed it and `allowed_tools` kept it): a misspelt
`tool-not-called` would otherwise pass forever. A tool the server lists only after a call (one a discovery tool
switches on) counts from then.

```yaml
evals:
  - id: weather-agent
    prompt: "What is the weather in {{city}}?"
    dataset:
      examples:
        - vars: { city: Kyiv }
    mcp: { server: weather }
    assertions:
      - type: first-tool
        tool: geocode
      - type: tool-args
        tool: forecast
        args: { city: "{{vars.city}}" }
      - type: tool-not-called
        tool: delete_alerts
      - type: no-tool-errors
      - type: token-budget
        max: 20000
      - type: no-repeated-call     # advice only
      - type: contains             # the final answer, as in any eval
        value: "{{vars.city}}"
```

### Not measured

A check that has nothing to measure does not pass. The row is `errored` with a code of its own, and the
assertions after that one in the row are not run (the message says which check stopped):

| Code | When |
|------|------|
| `ASSERTION_UNMEASURED` | a negative check (`tool-not-called`, `only-tools`, `no-tool-errors`, `no-destructive-tool`) found nothing on a partial transcript: a limit stopped the loop, or a stored excerpt was cut, so the violation may be in what was not seen. A violation that **was** found still fails: it is there. Also: `token-budget` with no step, `tool-latency` or `tool-result-size` with no call that ran or a call without its time or size, `tool-result-schema` with no answer or an answer cut to its excerpt, `no-destructive-tool` without a tools list |
| `ASSERTION_UNKNOWN_TOOL` | the check names a tool the model was not offered; the message lists the ones it was |

A run with an errored row and no failed one exits `2`, like any other errored row. When the model called nothing
and the loop ended on its own, a negative check passes: that is a real pass, not this case.

### Arguments: `partial`, `exact`, `ignore`

String values of `args` take `{{vars.X}}` and `{{expected}}`, at any depth. On a call with
`{ "path": "a.txt", "mode": "r" }`:

| `args` | `partial` | `exact` | `ignore` |
|--------|-----------|---------|----------|
| `{ path: a.txt }` | pass | fail | pass |
| `{ path: b.txt }` | fail | fail | pass |
| `{ mode: r, path: a.txt }` | pass | pass | pass |

`partial`: every key of `args` is in the call with an equal value; objects inside match the same way, arrays
must be equal whole. Strings are compared exactly, case included, and `5` is not `"5"`. `exact`: the same
arguments, key order aside. `ignore`: any call of the tool. Placeholders such as "any string" and patterns over
arguments are not supported yet.

### Results, sizes, annotations

- `tool-result-size` reads the size the server's answer had before the transcript kept its excerpt (4 KiB),
  so a 1 MiB answer is measured as 1 MiB.
- `tool-result-schema` parses the answer's text: the text blocks, or `structuredContent` when the tool sent no
  content blocks. An answer with `isError` is left to `no-tool-errors`.
- `no-destructive-tool` follows MCP: a tool counts as safe only with `readOnlyHint: true` or
  `destructiveHint: false`, and a tool without annotations may be destructive. The hints are the server's own
  claim about its tools, so a pass here is what the server declares, not proof that a tool is safe.
- A failure says what was expected, what was seen (up to five calls, each with its step and its arguments,
  masked and cut) and where to look. It never quotes a tool's answer, only its size.

---

## Which should I use?

| You want to check… | Use |
|--------------------|-----|
| Exact string / canned answer | `exact-match` |
| A keyword is present / one of many / all of several | `contains` / `contains-any` / `contains-all` |
| The output is well-formed JSON | `json-schema` |
| Same meaning, different words | `semantic-similarity` |
| A subjective quality bar ("is it polite/correct/concise?") | `llm-judge` |
| RAG answer doesn't hallucinate | `faithfulness` |
| RAG answer is on-topic | `answer-relevance` |
| RAG retrieval pulled the right context | `context-precision` |
| An agent picked the right tool, with the right arguments, within budget | the [tool-call checks](#tool-call-checks-agentic-evals) |

Deterministic checks are essentially free; semantic checks cost only local CPU; LLM-judged checks
cost provider tokens. Mix freely — a single eval often combines a cheap structural check with a
judged quality check.

## Next

- **[CLI reference](./cli.md)** — run a subset, dry-run cost estimates, exit codes.
- **[How it works](./concepts.md)** — what "errored vs failed" means for a judged/RAG row.
