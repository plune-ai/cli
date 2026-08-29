# Assertions

An **assertion** is one check on a model's output. Each has a `type` and its own parameters, and
returns pass/fail (some also return a `score` from 0 to 1 and a human-readable `reason`). An eval
runs **all** its assertions on every dataset row.

There are ten types, in three families:

- **Deterministic** — fast, free, no network. Exact text / substring / JSON-shape checks.
- **Semantic** — meaning-based, using a small **local** embedding model (no external API).
- **LLM-judged** — an LLM evaluates the output (uses your provider; costs tokens).

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
| `pass_threshold` | no | `0.5` | Minimum score (0–1) to pass. |
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

Deterministic checks are essentially free; semantic checks cost only local CPU; LLM-judged checks
cost provider tokens. Mix freely — a single eval often combines a cheap structural check with a
judged quality check.

## Next

- **[CLI reference](./cli.md)** — run a subset, dry-run cost estimates, exit codes.
- **[How it works](./concepts.md)** — what "errored vs failed" means for a judged/RAG row.
