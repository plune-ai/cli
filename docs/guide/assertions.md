# Assertions

An **assertion** is one check on a model's output. Each has a `type` and its own parameters, and
returns pass/fail (some also return a `score` from 0 to 1 and a human-readable `reason`). An eval
runs **all** its assertions on every dataset row.

There are 25 types, in four families:

- **Deterministic** — fast, free, no network. Exact text / substring / JSON-shape checks.
- **Semantic** — meaning-based, using a small **local** embedding model (no external API).
- **LLM-judged** — an LLM evaluates the output (uses your provider; costs tokens).
- **Tool calls** — in an eval with an `mcp` server: which tools the model called, with what arguments, in what
  order, and at what cost ([below](#tool-call-checks-agentic-evals)).

> **String parameters support `{{ }}`.** In any assertion, `{{expected}}` is replaced with the
> row's `expected` value and `{{vars.X}}` with a row variable — so you can compare against the
> dataset's expected answer (e.g. `value: "{{expected}}"`). An unknown placeholder is left as-is. A check that uses `{{expected}}` fails on a row with no `expected` (missing or empty), saying so, rather than comparing against an empty string.

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

### `json-verify`
The JSON in the output matches an **expected JSON value**: all of it, or only the part you care about. Made for
answers of a model, which are never the same twice: say which fields must be there, which string must match a
pattern, which number must be over zero, and leave the rest free.

| Param | Required | Default | Meaning |
|-------|----------|---------|---------|
| `expected` | yes | — | Any JSON value: what the answer is compared with. Its strings are not templates: `{{ }}` is not replaced in it. |
| `mode` | no | `exact` | `exact`: the same keys and values, arrays in order. `unordered`: as `exact`, but the elements of an array may come in any order. `contains`: an object has the expected keys and may have more; an array has a match for every expected element and may have more, in any order. |
| `extract` | no | `auto` | `strict`: the **whole** output is the JSON. `auto`: the first ```` ``` ```` block if what it holds is JSON; otherwise the first balanced `{…}` or `[…]` in the text that parses as JSON. That is the first one, not the largest: in `As noted in [1], the result is {"a": 1}` it is `[1]`. `auto` never finds a bare number or string. |

A key the type does not have (`modee:`) is a config error, so a mistyped option cannot leave the check on its
default. When the prompt asks for JSON only, use `extract: strict`: prose around the JSON then fails the check
instead of being searched. `auto` is for answers that wrap the JSON in a sentence or a fenced block; it reads
text with tens of thousands of unclosed brackets slowly (seconds), as `json-schema` does.

An answer with these fields, whatever else it holds:

```yaml
- type: json-verify
  mode: contains
  expected:
    name: John Doe
    email: '@matchesRegex("^[^@ ]+@plune\.ai$")'
    roles: [admin]
```

A classification with exactly these three keys, where only the list is free in its order:

```yaml
- type: json-verify
  extract: strict
  expected:
    label: '@oneOf("bug", "question", "feature")'
    confidence: '@isNumber() @gt(0.5)'
    tags: { $mode: unordered, $value: [billing, urgent] }
```

A list that holds at least these two items, each with a positive quantity:

```yaml
- type: json-verify
  mode: contains
  expected:
    items:
      - { sku: A-100, qty: '@gt(0)' }
      - { sku: B-200, qty: '@gt(0)' }
```

**Checks inside `expected`.** A string that starts with `@name(` is not compared as text: it is a list of
checks on the actual value, separated by spaces, and all must hold.

| Check | Holds when the value… |
|-------|------------------------|
| `@isNotNull()` | is not `null` (the key must still be there) |
| `@isString()`, `@isNumber()`, `@isBoolean()`, `@isArray()`, `@isObject()` | is of that type |
| `@matchesRegex("pattern")`, `@matchesRegex("pattern", "i")` | is a string the pattern finds a match in (anchor it with `^` and `$` for the whole string); the flags are `i`, `m`, `s` |
| `@minLength(n)`, `@maxLength(n)` | is a string or an array of at least, at most, `n` in length |
| `@gt(n)`, `@lt(n)` | is a number over, under, `n` |
| `@oneOf(a, b, …)` | is one of the listed numbers, strings, `true`, `false` or `null` |

Arguments are numbers, `true`, `false`, `null` and strings in double or single quotes. Inside the quotes only
the quote itself is escaped (`\"`); every other backslash stays, so a pattern is written as it is: `"^\d+$"`.
In YAML, put the whole check in single quotes.

Every other string is a text to equal: `user@plune.ai`, `@john_doe`, `@ home`. For a text that itself starts
like a check, double the first `@`: `'@@isString()'` expects the text `@isString()`. An unknown check, wrong
arguments or a forgotten `()` after a check's name stops the run as a config error (exit `2`) before any model
call, with the place: `evals.0.assertions.0.expected: $.email: @matchesRegexp is not a check function`.

**A pattern cannot run long.** A pattern in a config meets text a model wrote, and the regular expressions of
JavaScript can take minutes on a short text (`(a+)+$`, `^(a|a)*b`). So `@matchesRegex` has a matcher of its
own, which reads each character of the value once and takes the same time whatever the pattern is. It reads:
literals, `.`, `\d \w \s \D \W \S`, `\n \r \t \f \v \0`, a backslash before a character that is not a letter
or a digit, classes `[a-z]` and `[^…]`, groups `( )` and `(?: )`, `|`, `* + ? {n} {n,} {n,m}`, and the anchors
`^ $ \b \B`. It does **not** read backreferences (`\1`), lookahead and lookbehind, named groups, `\p{…}`,
`\x41` or `\u0041`: a pattern with one of these is a config error that names the place in the pattern. Limits:
a pattern is at most 500 characters and at most 2,000 parts once its counted repeats are written out (`a{50}`
is 50 parts, and each alternative of `|` is a part), and it is not run on a value over 10,000 characters: the
check fails and says so. `i` folds case exactly as a JavaScript pattern without the `u` flag does: `k` matches
`K` but not the Kelvin sign, `σ` matches `ς`. Characters outside the Basic Multilingual Plane are two units.
A flag is given at most once; `\0` before a digit, and a repeat with nothing to repeat (`{3}`, `a{2}{3}`), are
config errors.

**Another mode for one part.** `{ $mode: <mode>, $value: <value> }` in place of a value compares that value,
and everything under it, in that mode. The keys `$mode` and `$literal` are reserved in `expected`: for data
that really has one, or for a part where nothing should be read as a check or a marker, wrap it:
`{ $literal: { $mode: dark } }` expects the object `{ "$mode": "dark" }`. A key named `__proto__` cannot be
checked: it is a config error anywhere in `expected`, as is a value JSON does not have (`.inf`, `.nan`).

**What a failure says.** The reason lists each difference with its JSON path, the expected and the actual
fragment, in a fixed order, so the same answer gives the same text:

```text
2 mismatches
    $.email: function not satisfied: @matchesRegex("^[^@ ]+@plune\.ai$")
      expected: "@matchesRegex(\"^[^@ ]+@plune\\.ai$\")"
      actual:   "user at plune.ai"
    $.roles[0]: no match for an array element
      expected: "admin"
```

A fragment is cut at 120 characters and at six levels of nesting (`...`), and after ten differences the rest
are counted (`and 7 more`). An answer may be nested as deep as it likes: the comparison goes only as deep as
`expected` does, and `expected` itself may be nested at most 100 levels (deeper is a config error). For an
element with no match, the index is its place in `expected`. An output with no JSON in it **fails** with a
reason, as in `json-schema`.

**Arrays in any order.** In `unordered` and `contains`, each expected element needs an element of its own in
the answer, and the pairing is the best there is: `{ sku: A }` does not take the only element that
`{ sku: A, qty: 2 }` could match. Numbers, strings, booleans and `null` are paired at any size. Objects,
arrays and checks are paired by comparing an expected element with an element of the answer, and one check
may compare 2,000,000 such pairs over all its arrays, nested ones included (a pair is counted once). An
expected object with a plain value under a key (`id: 7`, `sku: A-100`) is compared only with the objects of
the answer that have that value under that key, wherever the key is written, so thousands of rows with an id
cost one comparison each; arrays already in the expected order cost one per element too. The limit is reached
by large arrays of objects that differ only in nested values or are told apart only by checks: about 2,000
such rows in the reverse order. Past it the check fails with the single reason `too large`, and lists no other
difference. `exact` has no such limit.

**Numbers.** A number is compared as JavaScript reads it, a 64-bit float: integers past 2^53 that differ only
in their last digits are equal (`9007199254740993` and `9007199254740992`), and so are `1` and `1.0`. Compare
such an id as a string. An argument of a check is a number as JSON writes it (`0.5`, not `.5` or `01`), and a
number too large to be finite (`1e999`) is a config error.

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

These ask an LLM to evaluate the output. They use the eval's provider as the "judge" (with its
`temperature`, `max_tokens` and other settings), unless an `llm-judge` names a `provider` of its own, so
they cost tokens — and that cost, priced at the judge's model, is included in the run total. All four
report a `score` and a `reason`, and the run result names the model that judged each of them in
`judge_model`, as `<type>/<model>`.

### `llm-judge`
An LLM scores how well the output meets a free-text `criteria`.

| Param | Required | Default | Meaning |
|-------|----------|---------|---------|
| `criteria` | yes | — | What "good" means, in plain language. |
| `pass_threshold` | no | `0.5` | Minimum score (0–1) to pass. Not the eval's `pass_threshold`, which is the share of [repeated runs](./configuration.md#repeats-runs-and-pass_threshold) that must pass. |
| `provider` | no | (eval's provider) | The judge: the eval's provider with these fields over it (or the experimental [`jev`](#an-experimental-judge-jev) judge). Every field you leave out (`type`, `model`, `temperature`, `max_tokens`, `timeout`, ...) is the eval's, so `{ model: ... }` alone changes only the model and keeps the eval's `type`; with several models of different types, set `type` too. Settings the judge model may refuse are inherited as well (`temperature`, `reasoning_effort`); set them on the check when they differ. A `type` other than the eval's is another provider, and the run needs that provider's API key. |

```yaml
- type: llm-judge
  criteria: "The answer is correct, concise, and polite."
  pass_threshold: 0.7
  provider: { type: openai, model: gpt-4.1 }   # another provider: the run needs its API key
```

The judge is sent three things: the `criteria`, the input (the eval's `prompt` or `prompt_file` with the
row's variables filled in), and the model's output. It is told that the criteria are about the output given
that input, so a criterion such as "the answer is correct" can be judged against the question. In an eval
with `mcp`, the input is that prompt alone: the judge is not sent the tool calls or their results, only the
final answer. The prompt's tokens are part of each judge call, and `--dry-run` does not price judge calls.

`{{expected}}` and `{{vars.X}}` work in `criteria`, as in any string parameter. Use them to give the judge
what the prompt does not hold, such as a reference answer:

```yaml
- type: llm-judge
  criteria: "The answer means the same as: {{expected}}"
```

#### Choosing the judge model

Without a `provider` on the check, the judge is the model that wrote the answer. A judge of its own is usually
both cheaper and fairer (a model grading its own answer favours it):

```yaml
- type: llm-judge
  criteria: "The answer is factually correct."
  provider: { type: anthropic, model: claude-haiku-5-5 }
```

For an Anthropic judge, start with `claude-haiku-5-5`. In our own measurements in November 2026 it agreed with
labels as well as `claude-sonnet-5-5` did, at about a twentieth of the list price:

| Set | Rows (fail) | Labels | `claude-haiku-5-5` kappa | `claude-sonnet-5-5` kappa |
|---|---|---|---|---|
| Arithmetic, simple facts, false premises, questions on a document | 271 (39) | one person, blind | 0.94 (0.87–0.99) | 0.91 (0.82–0.97) |
| False premises, unanswerable questions, open explanations | 279 (34) | three models, unanimous | 0.86 (0.76–0.94) | 0.83 (0.73–0.92) |

These are our measurements on our own test sets, short English answers, one criterion about facts; they are not
the vendor's figures, and your criteria may behave differently. Measure the judge you pick on your own rows with
[`plune judge-check`](./cli.md#plune-judge-check).

#### An experimental judge: `jev`

`provider: { type: jev, model: jev-1.14.0 }` has the check judged by Jev, a decision model of TypeSafe, instead of
a text model. It is **experimental**: the option may change or go away, and `plune run` says so once per run.

```yaml
- type: llm-judge
  criteria: "The answer is factually correct."
  provider: { type: jev, model: jev-1.14.0 }
```

| Field | Required | Meaning |
|-------|----------|---------|
| `type` | yes | `jev`. |
| `model` | yes | The Jev version, named in full. None is picked for you. |
| `timeout` | no | Milliseconds for one request (default `30000`). |

How it differs from a text judge:

- **A probability, not a reason.** Jev is asked one yes-or-no question (does the answer meet the criterion?) and
  answers with a probability. That probability is the check's `score`, `pass_threshold` (default `0.5`) applies
  to it, and the `reason` says that this judge gives none. The probability is not a calibrated confidence: in our
  runs Jev's wrong verdicts were as sure as its right ones, so raising the threshold does not filter them out.
- **Where the text goes.** The request, the answer and the criterion are sent to `api.typesafe.ai`, and to no
  other address. The key is read from `TYPESAFE_API_KEY`; without it the row errors and nothing is sent.
- **A size limit.** Request, answer and criterion together may be 16,000 characters. A longer check errors the
  row; nothing is cut and nothing is sent.
- **A judge only.** `jev` cannot be the `provider` of a config or of an eval, takes none of a text model's
  settings (`temperature`, `max_tokens`), and judges `llm-judge` alone: `faithfulness`, `answer-relevance` and
  `context-precision` keep the eval's model.
- **Cost.** Priced from the tokens Jev reports at USD 0.042 per million input tokens (indicative, read on
  2026-11-24) and added to the row like any judge call. One retry on `429` and `5xx`.

When it fits, by our measurements of `jev-1.14.0` in November 2026 (kappa against labels, 95% interval):

| Kind of check | Rows (fail) | Labels | `jev-1.14.0` | `claude-haiku-5-5` | `claude-sonnet-5-5` |
|---|---|---|---|---|---|
| Arithmetic, simple facts, false premises, questions on a document | 271 (39) | one person, blind | 0.92 (0.84–0.98) | 0.94 (0.87–0.99) | 0.91 (0.82–0.97) |
| False premises, unanswerable questions, open explanations | 279 (34) | three models, unanimous | 0.92 (0.84–0.98) | 0.86 (0.76–0.94) | 0.83 (0.73–0.92) |
| Open and ambiguous questions with a mixed criterion (facts and length) | 99 (9) | one person, 59 of them confirmed suggestions | 0.35 (−0.03–0.65) | not run | 0.86 (0.64–1.00) |

- **Use it** where an answer is clearly right or wrong: a fact, a calculation, a false premise the answer must
  catch, a question that has no answer.
- **Do not use it** for a criterion that needs judgment (tone, completeness, "is this a good explanation"), for
  one that mixes several demands, or where you need the reason for a verdict. Of 34 explanations with one
  planted factual error it passed 3; the two Claude judges passed none.
- These are our measurements on our own test sets, with small numbers of failing rows; they are not the vendor's
  figures. Check it on your rows with [`plune judge-check`](./cli.md#plune-judge-check) before you rely on it.

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
| `tool-args` | deterministic | `tool`, `args` (an object, or a list of them as alternatives), `match` (`partial` default, `exact`, `ignore`), `min_count` (default `1`) | at least `min_count` calls of `tool` have arguments that match `args` (with a list, any one of its objects) |
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
| `ASSERTION_UNMEASURED` | a negative check (`tool-not-called`, `only-tools`, `no-tool-errors`, `no-destructive-tool`) found nothing on a loop that a limit stopped, so the violation may be in a call that was not made or not seen. These four read only the calls and the tool list, never an answer's text, so a stored excerpt that was cut leaves them measured when the loop ended on its own: every call is kept, only texts are cut. A violation that **was** found still fails: it is there. Also: `token-budget` with no step, `tool-latency` or `tool-result-size` with no call that ran or a call without its time or size, `tool-result-schema` with no answer or an answer cut to its excerpt, `no-destructive-tool` without a tools list |
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
| The JSON has these fields and values, or values that pass a check | `json-verify` |
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
