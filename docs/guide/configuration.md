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
| `mcp` | no | MCP servers for agentic evals and their default limits. See [MCP servers](#mcp-servers-mcp). |
| `evals` | yes | The list of evals to run (≥ 1). |

## `provider`

| Field | Required | Default | Meaning |
|-------|----------|---------|---------|
| `type` | yes | — | `anthropic`, `openai`, or `openrouter`. |
| `model` | yes | — | Model id (e.g. `claude-sonnet-4-5`, `gpt-4o`). |
| `temperature` | no | `0` | Sampling temperature. Keep at `0` for reproducible runs. |
| `max_tokens` | no | `1024` | Max output tokens per call. |
| `concurrency` | no | `4` | Rows run in parallel (per eval). Override per-run with `--concurrency`. |
| `reasoning_effort` | no | unset (not sent) | `none`, `minimal`, `low`, `medium`, `high` or `xhigh`, sent as is by `openai` on every call. `anthropic` does not send it and says so once per model on stderr; `openrouter` does not send it. It is not part of the cache key: run with `--no-cache` after changing it. |

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
| `mcp` | no | The MCP server this eval's model may use. See [An eval's `mcp`](#an-evals-mcp). |

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

## MCP servers (`mcp`)

An agentic eval gives the model the tools of an MCP server. The top-level `mcp` block names the
servers and the default limits; an eval's own `mcp` block picks one server, the tools the model may
use, and its own limits.

> **Requires `@plune-ai/cli` 0.35.0 or newer.** 0.34.6 and older stop on the top-level key with
> `Config validation failed in …` and `: Unrecognized key: "mcp"`, exit `2`, instead of ignoring it.
>
> `plune run` and `plune run --dry-run` refuse a wrong block with exit `2`, before any model call.
> A dry run starts no server and opens no connection. A real run gives the model the server's tools
> and records the loop in the row's `agent` field: see [The tool loop](#the-tool-loop).

```yaml
mcp:
  servers:
    everything:                          # a stdio server: plune starts this command
      command: npx
      args: ["-y", "@modelcontextprotocol/server-everything"]
      env:
        API_TOKEN: "${EVERYTHING_TOKEN}" # from the environment, never written here
        LOG_LEVEL: "${LOG_LEVEL:-info}"  # with a default
      cwd: ./servers                     # relative to the folder of plune.yaml
    tracker:                             # an HTTP server (Streamable HTTP)
      url: "https://${TRACKER_HOST}/mcp"
      headers:
        Authorization: "Bearer ${TRACKER_TOKEN}"
  limits:                                # defaults for every agentic eval
    max_steps: 8

evals:
  - id: find-the-issue
    prompt: "Find the open issue about {{topic}}"
    dataset:
      examples:
        - vars: { topic: login }
    assertions: []
    mcp:
      server: tracker                    # a name from mcp.servers
      allowed_tools: [search_issues, get_issue]
      limits:
        max_tool_calls: 5                # wins over mcp.limits and the default
```

### A server: `mcp.servers.<name>`

Exactly one of `command` and `url`. Both, or neither, is a config error that names the server.

| Field | For | Meaning |
|-------|-----|---------|
| `command` | stdio | The program that starts the server. |
| `args` | stdio | Its arguments, a list of strings. |
| `env` | stdio | Variables for the server process (strings: quote `"1"`). |
| `cwd` | stdio | Working directory of the server, relative to the folder of `plune.yaml`. |
| `url` | HTTP | The Streamable HTTP endpoint, `http://` or `https://`. |
| `headers` | HTTP | Headers sent with every request to `url`. |

`headers` on a `command` server, or `args`, `env`, `cwd` on a `url` server, is a config error. So is
a field this table does not name: a misspelt field is refused, not dropped.

**What the server process gets.** Only the variables named in `env`, plus a short list of safe ones
such as `PATH` and `HOME`. Nothing else of the environment `plune` runs in reaches the server, and
the model provider's API key never does. If the server needs a variable, name it in `env`
(`API_TOKEN: "${API_TOKEN}"` passes it on).

### An eval's `mcp`

| Field | Required | Meaning |
|-------|----------|---------|
| `server` | yes | A name from `mcp.servers`. A name that is not there is a config error that names the eval and the server. |
| `allowed_tools` | no | The tools the model may call, by name. Left out: every tool the server lists in `tools/list`. An empty list `[]` is a config error, not "every tool". |
| `limits` | no | Overrides `mcp.limits` and the defaults, limit by limit. |

`prompt` and `prompt_file` stay mutually exclusive, as on every eval.

### Limits

Every limit has a default, so an agentic eval always ends. A limit is a whole number above `0`;
`0`, a negative number, a fraction or `.inf` is a config error. There is no "no limit".

| Limit | Default | What it bounds |
|-------|---------|----------------|
| `max_steps` | `10` | Model turns for one dataset row. |
| `max_tool_calls` | `20` | Tool calls for one dataset row. |
| `max_total_tokens` | `100000` | Input plus output tokens for one dataset row. |
| `timeout_ms` | `120000` | Time for one dataset row (2 minutes; at most `2147483647`). |
| `tool_timeout_ms` | `30000` | Time for one tool call (30 seconds; at most `2147483647`). |

An eval's `limits` win over `mcp.limits`, which win over the defaults.

A limit is a safety brake, not a verdict: a row a limit stopped is judged by its assertions on the
last text the model gave, and its transcript says which limit stopped it. `max_total_tokens` is
checked after each step, so a row can pass it by one step at most. A tool that does not answer
within `tool_timeout_ms` stops the loop.

### The tool loop

For each dataset row, `plune run`:

1. starts or connects to the eval's server (one session per row, closed when the row ends) and reads
   `tools/list` to its last page;
2. offers the model the tools `allowed_tools` names (every tool when it is left out);
3. runs each call the model asks for on the server, one after another in the order asked, and gives
   the model every answer in its next step;
4. after a step with a call that succeeded, reads `tools/list` again and offers what it holds from
   the next step, still within `allowed_tools`: a server may switch tools on or off as a side effect
   of a call (and announce it with `notifications/tools/list_changed`); a fixed list reads the same;
5. repeats until the model answers without a call, or a limit stops it.

The row's `output` is the model's last text, and the assertions judge it. Rows of an agentic eval
run one at a time, since they may share the server's state; `--concurrency` or
`provider.concurrency` changes that. The provider must be `anthropic`, `openai` or `openrouter`.

**Tool names.** Providers accept only `a-z`, `A-Z`, `0-9`, `_` and `-`, at most 64 characters. A
server name outside that (`files/read`) is offered as a safe one (`files_read`, with `_2`, `_3` when
two names collide) and mapped back: the transcript always holds the server's name.

**What the model gets wrong is recorded, not run.** A call to a tool the model was not offered, or
with arguments that are not a JSON object, never reaches the server; the model gets an error back,
and the call is recorded as not executed, with `is_error: true`.

**The transcript** is the row's `agent` field in `last-run.json` and `--format json`:

| Field | Meaning |
|-------|---------|
| `server` | The name in `mcp.servers`. |
| `tools` | Every tool the server listed at any point of the row: `name`, `offered` (offered at any point), and `annotations` when it had them. |
| `steps[]` | One per model turn: `index` (from 1), `text`, `finish_reason`, `usage` (tokens and cost), `calls`, and `offered_changed` (`added`, `removed`) on the step whose request first offered a changed list. |
| `steps[].calls[]` | `id`, `name`, `args`, `executed`, `is_error`, `error_kind`, `duration_ms`, `result`. |
| `stop` | `reason`: `complete`, `limit` (with `limit`: the one that stopped it) or `error`. |
| `collection` | `partial` when a limit or an error stopped the loop, or an excerpt was cut; `complete` otherwise. |

`error_kind` is `content` (the tool answered `isError: true`), `protocol` (a JSON-RPC error),
`timeout`, `not-offered` or `bad-arguments`. A call's `result` holds `text`, an excerpt of at most
4 KiB, and `bytes`, the size of the whole answer measured before the cut, and `truncated`. The
excerpts of one row are at most 256 KiB together; past that an excerpt is empty and marked
`truncated`. The model is always given the whole answer. Every value of the server's `env` and
`headers` is masked as `***` in the transcript, in `output` and in error messages.

**Cost** is the sum of the steps, and a row is `priced: false` when any step was. The loop is never
cached: a stored answer about a call would not show that the server still answers so. An agentic
row neither reads nor writes the cache, and `--cache-strict` with an agentic eval is exit `2` before
any model call.

**A row ends `errored`**, its transcript kept, when the server cannot be started or reached
(`MCP_CONNECT`), `tools/list` fails (`MCP_LIST_TOOLS`), the server goes away during the loop
(`MCP_SERVER_LOST`), the provider fails after its retries (the provider's code), or a reply hits
`max_tokens` in the middle of a call (`AGENT_CUT_OFF`).

**`--dry-run`** connects nowhere. It prices `max_steps` model calls of the prompt and says on stderr
that tool schemas and tool results are not counted.

**Without a model.** `PLUNE_MOCK_PROVIDER=1` with `PLUNE_MOCK_SCRIPT=<file.json>` plays a script:
a list of steps, each `{ "tool_calls": [{ "name": "echo", "args": { "text": "hi" } }] }` (names as
the model is offered them) or `{ "text": "final answer" }`; step n of each row plays entry n, and
the last entry repeats. `PLUNE_MOCK_PROVIDER=1` without `PLUNE_MOCK_SCRIPT` is exit `2` for an
agentic eval: a mock that calls no tools would measure nothing.

**Network.** The loop opens no connection but the provider's API and the server the config names;
`headers` go only to its `url`.

### `${VAR}` in a server's values

`command`, `args`, `env`, `cwd`, `url` and `headers` values may hold:

- `${VAR}`: the value of the environment variable `VAR`;
- `${VAR:-default}`: the value of `VAR`, or `default` when it is unset or empty.

Nothing else is filled and no shell runs: `$VAR`, `$(...)`, backticks and `~` stay as written, and
keys (the names in `env` and `headers`) are never filled. Variables come from the environment, or
from a `.env` next to `plune.yaml` or in the current folder, as for every command; a variable already
set in the environment wins.

- An unset or empty `${VAR}` without a default is a config error, exit `2`, that names the field and
  the variable, never a value. An empty value is refused, so an empty credential never goes out.
- A `${` that is neither form (`${TOKEN`, `${1X}`) is a config error too.
- Every server is checked, also one that no eval selected with `--only` uses.
- `plune.yaml` is kept as written: `config_hash` in the run result covers `${VAR}`, not its value,
  so two machines with different tokens get the same hash, and the value is not in `last-run.json`
  or in `--format json`.

**A secret written into the file** is a warning, not an error. When a key in `env` or `headers`
contains `authorization`, `token`, `key`, `secret` or `password` (any case) and its value has no
`${`, `plune run` prints `warning: mcp.servers.<name>.headers.Authorization looks like a secret
written into plune.yaml; …` on stderr, naming the key and never the value. The exit code is the one
the run would have without it.

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
