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

The completion cache uses `better-sqlite3`, an optional dependency with prebuilt binaries for Node 20 to 26 on Windows (x64, arm64), macOS and Linux. If the binary cannot be downloaded (proxy, offline mirror) and there is no C++ toolchain with Python to build it, npm skips it: the install still succeeds and `plune run` prints `completion cache disabled` and runs without the cache. To turn the cache on, fix the download or install the build tools (Visual Studio Build Tools on Windows), then run `npm rebuild better-sqlite3 -g`.

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

Each run writes its full result to `.plune/last-run.json`; a `--dry-run` writes nothing there.

## Configuration

Plune reads a single `plune.yaml`, discovered by walking up from the working directory (or
passed with `-c <path>`). A minimal example:

```yaml
version: 1
provider:
  type: anthropic            # anthropic | openai | openrouter
  model: claude-sonnet-5-5
evals:
  - id: example
    prompt: "Answer concisely. {{question}}"   # {{vars}} come from each dataset row
    dataset: datasets/example.jsonl            # a file path, or an inline `examples:` list
    assertions:
      - type: contains
        value: "Paris"
```

Datasets are JSONL, one row per line, shaped `{ "vars": { ... }, "expected"?: "..." }`. A line that
is not valid JSON or not a row (no `vars`, or `vars` that is not an object) stops the run before
any model call with `<file>:<line>` and what is wrong, exit code `2`, like any other configuration
error. The provider API key is read from the environment based on `provider.type`:

| Provider   | `provider.type` | Environment variable |
| ---------- | --------------- | -------------------- |
| Anthropic  | `anthropic`     | `ANTHROPIC_API_KEY`  |
| OpenAI     | `openai`        | `OPENAI_API_KEY`     |
| OpenRouter | `openrouter`    | `OPENROUTER_API_KEY` |

`provider` may also be a list of models: every eval then runs on each, and `plune run` and `plune report` show a model × eval table (see the [configuration guide](docs/guide/configuration.md#several-models-a-model--eval-matrix)). `model` is any id the provider serves; `plune init` starts you on `claude-sonnet-5-5`. A run's cost
is priced from a built-in table of current models — a model it does not list costs `0`, with a
warning, until you add its rates under `pricing:` (`input_per_1k_usd`, `output_per_1k_usd`). Leave
`temperature` out for Claude models released after Opus 4.6: they take none, and the API answers 400
to any value but the default. Plune sends no `temperature` unless the config sets one.

### Where the CLI reads its settings

Every command reads them the same way: from the environment first — what your shell or CI job
exported — then from a `.env` beside the config you named with `-c`, then from a `.env` in the
current directory. The first place that sets a variable wins, so a `.env` never overrides what is
already exported. That covers the provider keys above and every `PLUNE_*` variable (`PLUNE_TOKEN`,
`PLUNE_API_URL`, `PLUNE_RUN`, …) for `run`, `report`, `sync`, `ingest`, `login` and `run import`,
`start` and `finish` alike — no `dotenv` wrapper in your scripts. The token `plune login` saved is
the last resort, used only when `PLUNE_TOKEN` is set nowhere else. Nothing writes a `.env` for you;
`plune init` writes `.env.example`.

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
| `plune run` | Run the suite. Flags: `--dry-run` (price the run from the model's rates — no provider key, no network; it prints the estimate with no verdict and does not replace the last run; with a [list of models](docs/guide/configuration.md#several-models-a-model--eval-matrix) each is priced at its own rates), `--only <id\|tag>` (repeatable; an eval id selects its cells on every model), `--bail`, `--no-cache`, `--cache-strict`, `--cache-max-age <duration>`, `--concurrency <n>`, `--format console\|json\|markdown`, `-o, --output <file>`. |
| `plune report` | Re-render the most recent run. Flags: `--format`, `-o`. |
| `plune diff <baseline> <current>` | Compare two `plune run --format json` outputs and report pass→fail regressions. Flags: `--fail-on-regression` (exit `1` on a regression, `3` when none but an eval was not measured), `--format`, `-o`. |
| `plune init` | Scaffold `plune.yaml`, a sample dataset, and `.env.example`. Flags: `--yes` (non-interactive), `--force`. |
| `plune login` | Save a [Plune platform](https://plune.ai/platform) API token so `sync` and `ingest` can reach it. The token is **checked against the API before it is saved**, so a wrong one fails here rather than two commands later. Get one at `https://beta.plune.ai` → Account → API tokens. Flags: `--token <token>` (omit to paste it or pipe it via stdin), `--skip-verify` (save without checking, for offline setup). In CI, skip this step: every platform command reads `PLUNE_TOKEN` from the environment first, and the saved login only when it is not set. |
| `plune logout` | Remove the saved token. |
| `plune mcp serve` | Serve the Plune tools to an AI agent (Claude Code, Codex, any MCP client) over **MCP stdio**. See [Plune tools for AI agents](#plune-tools-for-ai-agents-plune-mcp). Flags: `--project <id>` (default `PLUNE_PROJECT`), `--read-only` (offer only the read tools). |
| `plune mcp check` | Check that **any** MCP server starts and answers: handshake, protocol version, capabilities, the lists, `ping`. See [Is the server alive](#is-the-server-alive-plune-mcp-check). Flags: `--check-timeout <duration>`, `--wait <duration>`, `--smoke` (with `--smoke-limit`, `--smoke-timeout`, `--budget`, `--allow-write-calls`), `--out [<format>=]<path>` (repeatable), `--reporter junit-xml`, `--format human\|json\|github\|markdown`, and the connection flags. Exit `0` healthy, `1` a check failed, `2` the server did not start, could not be reached or wants credentials, or a flag is wrong, `3` something could not be measured. |
| `plune mcp lint` | Check the tool list of **any** MCP server for what confuses a model — no account, no model. See [Checking any MCP server](#checking-any-mcp-server-plune-mcp-lint). Flags: `--fail-on error\|warn\|info\|never`, `--show-info`, `--format human\|json\|github\|markdown`, `--reporter junit-xml`, `--out [<format>=]<path>`, `--ignore-file <path>`, `--list-rules`, `--call`, `--call-limit <n>`, `--call-timeout <duration>`, and the connection flags (`--url`, `--header-env`, `--env`, …). Exit `0` clean, `1` findings, `2` the server did not start or a flag is wrong, `3` nothing measured. |
| `plune mcp snapshot` | Write the contract of **any** MCP server — tools, resources, resource templates, prompts, capabilities, instructions — as one stable JSON file to commit. See [Contract snapshots](#contract-snapshots-plune-mcp-snapshot-and-plune-mcp-diff). Flags: `--out <path>` (default stdout), `--push` with `--server <id>` or `--server-name <name>` and optional `--environment <text>` (send it to the platform's MCP catalog; nothing is sent without `--push`), and the connection flags. Exit `0` written (or sent), `1` with `--push` the platform could not be reached (the snapshot is kept in a file), `2` the server did not start, a declared list could not be read, or the platform refused the push (login, body, quota), `3` the server lists nothing. |
| `plune mcp diff` | Compare a snapshot with another snapshot file or a live server: every change `breaking`, `non-breaking` or `informational`, with a reason. See [Contract snapshots](#contract-snapshots-plune-mcp-snapshot-and-plune-mcp-diff). Flags: `--fail-on breaking\|any\|none`, `--format human\|json\|github\|markdown`, `--reporter junit-xml`, `--out [<format>=]<path>`, and the connection flags. All three write [JSON, JUnit XML for `plune run import`, GitHub annotations and a pull request comment](docs/guide/cli.md#report-formats-of-plune-mcp-lint-check-and-diff) from one run. Exit `0` nothing at `--fail-on`, `1` a change at it, `2` a file cannot be read or the server did not start, `3` nothing to compare. |
| `plune mcp pin` | Pin the tools, prompts and resource templates of **any** MCP server in `plune-mcp.lock.json` after reading them in full, and check a live server against it in CI. See [Pinning approved tools](#pinning-approved-tools-plune-mcp-pin). Flags: `--check`, `--stability` (with `--times`, `--pause`, `--wait`), `--yes`, `--lock <path>`, `--name <label>`, `--format human\|json`, and the connection flags. `--check` exits `0` as pinned, `1` a difference, `2` a usage error, `3` nothing compared (the server could not be reached). |
| `plune mcp scan` | Scan what a model or a person cannot see in **any** MCP server, sending no probe unless `--active` asks for the declared ones (see the CLI guide): descriptions (hidden Unicode, override phrases), a pin file, client configuration (`.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`: secrets, plain http, shell launchers) and tool names across servers. See the [CLI guide](docs/guide/cli.md#plune-mcp-scan). Flags: `--snapshot [label=]file`, `--config <file>`, `--client claude-code\|cursor\|vscode`, `--pin-file`, `--only`/`--skip`, `--active` with `--probes`, `--confirm-host`, `--max-calls`, `--max-requests`, `--token-env`, `--other-token-env`, `--fail-on error\|warn\|never`, `--gate-heuristics`, `--allow-partial`, `--ignore-file`, `--allow-long-exceptions`, `--format human\|json\|github\|sarif`, `--reporter junit-xml`, `--out`, and the connection flags. Exit `0` nothing that gates, `1` a finding at `--fail-on`, `2` a usage error, `3` something could not be measured. |
| `plune mcp conformance` | Check **any** MCP server against the protocol: a catalog of checks with their requirement level and spec section, a score from the `MUST` checks only, a frozen profile so a score means the same thing next month. `--list-checks` prints the catalog without connecting; `--fixture <file>` names the only tools a run may call; `--format human|json`, `--reporter junit-xml` and `--out [<format>=]<path>` (repeatable) write JSON and JUnit XML for `plune run import` from one run. See the [CLI guide](docs/guide/cli.md#plune-mcp-conformance). |
| `plune sync` | Upload the latest local run to the platform. Flags: `--file <path>` to send a specific run JSON, `--fail-on-failures` to read the run's summary back once after the upload and exit with [the gate](#a-release-gate---fail-on-failures)'s code. Each upload carries an `Idempotency-Key` (SHA-256 of the body), so sending the same run again returns the same run rather than creating a second one. Against a platform with `POST /v1/jobs` the upload is also reported as a job (kind `sync`, counting the run's rows) that ends completed, or failed with the error text if the sync fails; an older platform without the route is not told, and a job report never fails the sync: when the sync goes through, one the platform did not take is said in one line on stderr. |
| `plune run import <file \| folder>` | Turn a **JUnit XML** or **Playwright JSON** report, a **k6 summary** or **Lighthouse JSON** report, a **folder of JUnit XML files** (Maven Surefire's `target/surefire-reports`, Gradle's `build/test-results/test`), or an **Allure `allure-results` folder**, into a run in Plune. Needs no provider key — nothing is generated. Flags: `--format junit\|playwright-json\|allure\|k6\|lighthouse` (detected when omitted: a folder with a `*-result.json` is Allure, any other folder is read as the JUnit `*.xml` files in it), `--name <text>` to call the run something other than the [folder-based default](#what-the-run-is-called), `--min-score <category>=<0-100>` (repeatable) for the score a [Lighthouse](#a-k6-summary-or-a-lighthouse-report) category needs to pass, `--key <externalKey>` to land several reports in one run (with `PLUNE_SHARED_RUN=1` — see below), `--create` to offer unmatched tests to the review queue, `--fail-on-missing-attachments` to exit 1 when a file a JUnit report names with `[[ATTACHMENT\|path]]`, or an Allure result names as a `source`, is not there (the results are sent either way), `--upload-concurrency <n>` for files uploaded at once ([1 to 32, default 16](#many-screenshots-upload-concurrency-and-retries)), `--fail-on-failures` to exit with [the gate](#a-release-gate---fail-on-failures)'s code on the summary the platform froze when this import finished the run. |
| `plune run start` | Open a platform run — or join the one already carrying `--key` — and print its id. Flags: `--key <externalKey>` (generated when absent), `--name <text>` to call the run something other than the [default](#what-the-run-is-called), `--json` for one machine-readable line. |
| `plune run finish <id>` | Close a platform run. This is what the reporter tells you to do for a run it had to leave open. Flags: `--terminate` to record it as cut short, `--reason <text>`, `--fail-on-failures` to exit with [the gate](#a-release-gate---fail-on-failures)'s code on the summary the platform froze. |
| `plune run exec -- <command>` | Open a run, run the command inside it, close the run — and exit with whatever the command returned. Sets `PLUNE_SHARED_RUN` for you, so anything reporting inside joins that run. Flags: `--key <externalKey>`, `--name <text>` (as on `run start`), `--fail-on-failures` to exit with [the gate](#a-release-gate---fail-on-failures)'s code instead — or with the command's own when no result reached the run. |
| `plune run delete <id>` | Delete a run and everything it produced — its results and the review-queue entries it raised. Approved test cases and the audit log stay. **Recoverable for 30 days** (an owner of the project can put it back from Settings → Bin), then gone for good. No prompt: it is your data, and this command belongs in scripts. |
| `plune run report` | Replay `.plune/pending-results.jsonl` — send what the reporter could not. The lines of one reporter run go back as one run, with the commit and branch the reporter recorded. Once every result has gone the file is renamed to `pending-results.<time>.sent.jsonl`; if anything did not go, it stays as it was. Flags: `--file <path>`. |
| `plune ingest [dir]` | Record a [Cairn](https://github.com/plune-ai/cairn) run in Plune. Omit `[dir]` for the newest run under `./runs`, or name the directory holding `report.json`. Generated cases arrive as **review proposals** — nothing is created until a person approves it. Against a platform with `POST /v1/jobs` the ingest is also reported as a job (kind `ingest`, counting the cases sent, linked to the run it landed in) that ends completed, or failed with the error text if the ingest fails; as with `sync`, an older platform is not told and a job report never fails the ingest or changes its exit code. |
| `plune pull [file]` | Write the project's test cases as **one Markdown document** — Testomat's classical format, plus Plune's own columns — to `plune/cases.md` (or `[file]`). Refuses to overwrite a file git sees as modified; `--force` overrides, `--suite <id>` takes one suite or folder and what is under it. |
| `plune push [file] [--dry-run]` | Send the document back. Cases are matched by `id`; a block without one becomes a draft; an unknown id is refused by line; **nothing is deleted**. Prints the report — created, updated, unchanged, refused, warnings — and with `--dry-run` writes nothing. Exit `4` when anything was refused. |
| `plune requirements import <file.md>` | Import requirements from a **Markdown file** (an SRS, a PRD, a page exported from a wiki). With no mapping flags it lists the tables and sections the file has and exits `0`; with `--table` or `--sections` it is a **dry run** that writes nothing until you add `--yes`. See [Requirements from a Markdown file](#requirements-from-a-markdown-file). Needs a Plune platform that serves `POST /v1/projects/:id/requirements/import` (plune-ai/plune#1621). |
| `plune requirements links <file.md>` | Import a **traceability matrix** (a Markdown table of requirement key to test) as links between requirements and cases. With no flags it lists the tables the file has and exits `0`; with `--table`, `--requirement-column` and `--test-column` it is a **dry run** that writes nothing until you add `--yes`. See [Links from a traceability matrix](#links-from-a-traceability-matrix). Needs a platform that serves `POST /v1/projects/:id/requirements/import/links` (plune-ai/plune#1608). |
| `plune verify` | Compare the project's **automated cases** with the Playwright tests in the code, **read-only** (plune-ai/plune#1291). Prints both sides: cases in Plune that the code no longer has (already `detached`, or one a full run would detach) and tests in the code that Plune has no case for. A test is matched by the id it names (`PluneId` annotation or `@P<id>` in its title), else by its `path-title` key. Nothing is written to Plune and no id is added to your source. Playwright only. Flags: `--from <file>` (a saved `playwright test --list --reporter=json`, instead of running Playwright), `--playwright-config <path>`, `--json`, `--fail-on-drift` (exit `1` when either side has something the other lacks). |
| `plune ids [--write]` | Write the Plune **case id of each Playwright test that names none** into a mapfile, `plune/ids.json` (`{ "<path-title>": "<case id>" }`), instead of editing your test files (plune-ai/plune#1291). A **dry run** unless `--write`: it prints what it would add. Only tests whose case Plune already holds get an entry (matched by the `path-title` key); a test with no case yet is listed and skipped. Idempotent: entries are only added, never overwritten or removed (an entry for a test no longer in the code is kept and listed), the file is sorted so diffs stay small, and nothing is written when nothing changes. A mapfile that is not a JSON object of strings is refused (exit `2`) and left as it is. Playwright only. The Playwright reporter reads the mapfile: an entry names the case after the `PluneId` annotation, `@P<id>` and a metadata attachment, and before the `playwright-id` and `path-title` keys, so a renamed test keeps its case when the entry is updated with `plune ids --write` (override the path with `PLUNE_IDS_FILE` or the reporter option `idsFile`). Flags: `--write`, `--file <path>` (default `plune/ids.json`), `--from <file>`, `--playwright-config <path>`, `--json`. Exit codes as `plune verify`. |
| `plune automate <caseId>` | Run [Cairn](https://github.com/plune-ai/cairn)'s `automate` on **one case from Plune** and print the code it wrote as a diff of new files (#148). Cairn runs in `--repo <dir>` (default: the current directory) with an environment that holds **no `PLUNE_*` variable and no token**, and reads a copy of that directory's `.env` without them. Nothing is written into the repo. With `--send`, the same files go to the **review queue** as an automation proposal (`POST /v1/review-items/automations`), the spec file's `test()` call named as the case's code; the bounds (10 files, 16 KB each, 64 KiB in all) are checked first, and the queue entry's id is printed, new or replacing the one waiting for the case. Flags: `--repo`, `--cairn <path>`, `--url <url>`, `--send`; arguments after `--` go to Cairn. See [the CLI reference](./docs/guide/cli.md#plune-automate). |
| `plune plan grep <id>` | Print a [test plan](https://docs.plune.ai/platform/plans/) as **one `--grep` pattern** — `npx playwright test --grep "$(plune plan grep <id>)"` or `npx vitest run -t "$(plune plan grep <id>)"` runs exactly what the plan collects. Each case contributes its title path from the `path-title` key the reporter wrote (the file left out, `[ >#]+` between the segments — a space for Playwright, jest, mocha and vitest ≤ 4, ` > ` for vitest 5), escaped, joined with `\|`; a case without one goes in by title. The pattern is all that reaches stdout; the summary — how many cases, how many keyed — goes to stderr. An empty plan prints `(?!)`, which matches nothing, because an empty `--grep` would run everything. |
| `plune run grep <run> [--failed]` | Print a run's **automated** cases as one `--grep` pattern, built the way `plan grep` builds a plan's — so the commands Plune shows for a run work as they are: `npx playwright test --grep "$(plune run grep <run-id> --failed)"` re-runs an automated run's failures where your tests run (Plune starts no CI), and `PLUNE_RUN=<key> npx playwright test --grep "$(plune run grep <key>)"` runs the automated half of a mixed run launched without a plan. `<run>` is the run's id (a UUID) or its key (`rk_` and ten hex); anything else is refused with exit `2` before anything is sent, and a key no run carries exits `1`. The cases are the ones the run expected — cases added on its page among them, run or not — or holds a result of; manual cases are left out. `--failed` keeps the cases whose latest result the platform counts as failed or broken, so a muted case's failure stays out, as from **Re-run N failed**. Only the pattern reaches stdout; how many cases were taken and how many left out goes to stderr; nothing taken prints `(?!)`. Needs a Plune that serves `GET /v1/runs/:id/cases` (plune-ai/plune#1333). |

Global flags: `-c, --config <path>` · `-v, --verbose` · `--no-color`.

**Exit codes:** `0` everything passed · `1` an assertion failed · `2` configuration or execution error · `3` `pull` refused to overwrite uncommitted changes · `4` `push` had refusals · `5` `plune run --cache-strict` found rows with no cache entry (it wins over `1` and `2`: the run is incomplete).

### Completion cache

`plune run` keeps model answers in `.plune/cache.db`, keyed by provider, model, temperature, `max_tokens`, the resolved prompt and the cache policy version. Never by time or run id.

- **What is stored.** An answer is cached only when it has text, was not cut off by the token limit (`finish_reason` `length`), carries no provider error, and has the format the eval expects (a `json-schema` eval needs JSON in the answer). An answer that is well formed but wrong (the schema or a `contains` check fails) *is* cached: the model would say the same thing again.
- **What is dropped.** A stored answer that no longer has the expected format is deleted and the model is asked once in the same run. A provider failure deletes nothing. A damaged entry or file is a miss, never a crash.
- **Policy version.** `CACHE_POLICY_VERSION` is part of the key. When it is raised, older entries stop answering, are dropped, and the run says `cache policy changed, N entries are stale` once on stderr.
- **`--cache-strict`.** Every row must be in the cache; the model is not called for completions (judge assertions such as `llm-judge` still call it). A miss ends the run with exit code `5` and lists the rows with no entry. Not combinable with `--no-cache` (exit `2`), and neither is `--cache-max-age`. An entry with the wrong format is left in place in this mode (there is no retry).
- **`--cache-max-age <duration>`.** `90s`, `15m`, `12h`, `7d` or milliseconds. An older entry is a miss; a fresh one is a hit.
- **Summary.** The console report and the JSON (`summary.cache`) show rows `from_cache`, `from_model`, `missed` and `errored` (the provider failed; the four add up to the rows run), and the tokens and cost the cache saved (`saved`, the sum of each row's `cache_saved`).

Design: `docs/features/C7-completion-cache/adr/0001-completion-cache-hardening.md`.

### Requirements from a Markdown file

`plune requirements import <file.md>` reads a requirements document (UTF-8, at most 1 MiB, at most 2000 requirements) and brings it into the project in two steps. It sends the file as it is and changes nothing by itself: you say which table or section holds the requirements and which column is which, and the platform tells you what it would do before it does it.

**1. See what the file holds.** With no mapping flags:

```bash
plune requirements import srs.md
```

It lists every table (number, nearest heading, header cells, row count, and `<- looks like requirements` where the first column holds ids and a header names a requirement) and every section (number, heading, bullets and sub-headings under it), then the commands to try next. Exit `0`.

**2a. A table.** Name the table and its columns by their header text (any case):

```bash
plune requirements import srs.md --table 0 --key-column ID --text-column Requirement   --priority-column Priority --map-priority "Critical=Must-have,High=Should-have"
```

`--key-column`, `--title-column` or `--text-column` (one of the two: the title is the first line of the text and the whole text is kept as the description), `--description-column`, `--priority-column`, `--category-column`, `--type-column`, `--status-column` (`draft`, `active` or `done`), `--criteria-column`; `--map-priority` and `--map-category` (`"Quality=non-functional"`) rename values; `--type user_story|feature|epic` is the type of a row that has none.

**2b. A section.** One requirement per bullet or per sub-heading:

```bash
plune requirements import prd.md --sections Requirements --unit bullets --key-prefix REQ-
```

`--sections` takes the heading or its number; `--unit bullets|subheadings` (default: sub-headings when the section has any); `--key-prefix` is text a bullet starts with that carries its key (`REQ-12: The system shall ...`; no pattern is accepted); `--priority-from subheading` makes the bullets under a sub-heading take its text as their priority.

**2c. Several tables in one run.** A PRD keeps its functional and non-functional requirements in different tables. Repeat `--table` and put each table's columns inside it, after the number and a colon:

```bash
plune requirements import prd.md \
  --table "1:key=ID,text=Requirement,priority=Priority,fixed-category=functional" \
  --table "2:key=ID,text=Requirement,fixed-category=non-functional" \
  --map-priority "Must=Must-have"
```

Inside a `--table` the names are `key`, `title` or `text` (one of the two), `description`, `priority`, `category`, `type`, `status`, `criteria`, plus `fixed-category=functional|non-functional|other` and `fixed-type=user_story|feature|epic` — one meaning for the whole table, used where a row has none of its own. Names are separated by commas, so a header that contains a comma cannot be named in this form. `--map-priority`, `--type` and `--map-category` are shared by all tables. A table number may be given once. The single-table form (`--table 0 --key-column ...`) keeps working, but the two forms are not mixed: `--key-column` and the other column flags are refused together with `--table "<n>:..."`. The plan shows `table #N "heading"` in front of each row.

**3. Read the plan, then write it.** Without `--yes` nothing is written. The report is the summary line (`create 3 · update 0 · unchanged 12 · skip 1`), the rows grouped by action with their line in the file, key, title and reason (a skipped row says why), the priority and category values seen and what they map to, and what was **not imported** (other tables, other sections, frontmatter keys). It ends with `dry run — nothing was written; add --yes to apply`. Add `--yes` to apply the same plan in one transaction. A row with a key matches the requirement of that key; one without matches by exact title; running the same file again changes nothing (every row is `unchanged`). A skipped row does not fail the command. Rows that are only placeholders (`[Behavior]`) are skipped with the reason `template placeholder`; a key that appears twice in the file is skipped with `first on line N, again on line M`. When every row is a placeholder the plan says `this file is an empty template` (`--json` has `"emptyTemplate": true`) and the exit code is `0`, like any plan whose rows are skipped: nothing is written, and nothing is an error.

`--json` prints the platform's answer instead. The project is the only one of the account, or `--project <id>` / `PLUNE_PROJECT` (a token only works in the project it was minted in). Exit `0` on success, `2` for a flag combination that cannot work (`--table` with `--sections`, `--title-column` with `--text-column`, a `--table "<n>:..."` spec with the single-table column flags), an unreadable or over-limit file, or a rejected token, `1` when the platform refuses (400, 403, 409 a key taken meanwhile, 413) or does not have the routes yet.

### Links from a traceability matrix

Requirements documents often end with a table of requirement id to test. `plune requirements links <file.md>` imports it as links between requirements and cases, in the same two steps as `requirements import`: it sends the file as it is, and you say which table and which two columns.

```bash
plune requirements links matrix.md                     # lists the tables, exit 0
plune requirements links matrix.md --table 0 --requirement-column "Requirement" --test-column "Test"   # dry run
plune requirements links matrix.md --table 0 --requirement-column "Requirement" --test-column "Test" --yes
```

A requirement is matched by its key (import the requirements first, with `--key-column`). A test is matched by the exact title of a case, or for an automated case by its source path (`e2e/login.spec.ts` or `e2e/login.spec.ts#title`); put several tests in one cell on separate lines (`<br>`). A requirement cell with several keys is split by `--separator` (1 to 3 characters, default `,`; nothing else is guessed). The report lists what it would link, what is already linked, and every row that matched nothing, with the reason (unknown key, archived requirement, no such case, a title that names several cases). A second import changes nothing. Links never change a requirement's coverage, which still comes from each case's last result.

Exit `0` after a dry run or a write, even when rows are unmatched; `--fail-on-unmatched` makes any unmatched row exit `1`. A wrong flag or file is `2`; a read-only member, a rejected mapping or a matrix over 2000 rows (after splitting) is `1` with the platform's reason. `--json` prints the platform's answer; `--project <id>` / `PLUNE_PROJECT` picks the project.

### A release gate: `--fail-on-failures`

`plune run finish`, `plune run exec`, `plune run import` and `plune sync` take `--fail-on-failures`. The exit
code is then the platform's verdict on the run, not the runner's: the summary the platform froze at `finish`
(for `sync`, one `GET /v1/runs/:id/summary` after the upload). The platform counts a muted case's failure under
`muted`, so a mute set in Plune is honoured without the CLI knowing about it.

| The run | Exit |
| ------- | ---- |
| a `failed` or `broken` result that is not muted | `1` |
| an expected case that never reported (`notRun`): a dead shard is not green | `1` |
| only `passed`, `blocked`, `skipped` and muted failures | `0` |
| no verdict: the platform could not be reached, the finish was refused, the run was left open or terminated | `1` |
| no result reached the run and nothing was expected of it: `run import` of a report whose cases the project does not have yet, `run finish` or `sync` of an empty run | `1` |
| `run exec` where no result reached the run and nothing was expected of it | the command's own code |

Without the flag every command exits as it always did. `plune run` (local evals) is not affected: it stays the
raw local signal and works offline.

## Already running tests? Bring the results in

Everything above generates checks, which is why it needs a provider key. If you already have a
suite, there is nothing to generate — the results exist and only have to arrive, and that route
costs nothing beyond a Plune token.

```bash
plune login                           # once, on your machine; in CI export PLUNE_TOKEN instead
plune run import ./junit.xml          # Jest, Vitest, pytest, PHPUnit, Surefire, Cypress, …
plune run import target/surefire-reports   # or a folder of JUnit files: Maven, Gradle — see Java below
plune run import ./playwright.json    # or Playwright's own JSON report
plune run import ./allure-results     # or the folder an Allure adapter wrote — see below
plune run import ./summary.json       # or a k6 summary, thresholds as pass or fail — see below
plune run import ./lighthouse.json    # or a Lighthouse report, a category per result — see below
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

Either way a Playwright suite brings its screenshots: every image an attempt kept as a file — PNG,
JPEG or WebP, up to 2 MB each, 20 per result — is uploaded to that result, a passed test's too, so a
run in Plune shows each test with what it looked at. `plune run import` finds them where the report
says they are, so run it where the report was written; the summary counts any it could not find.

JSON and plain text come the same way — the answer of an API, a log — whether a test attached them
with a `path` or as a `body` (a report holds a body itself, so `plune run import` needs no file for
it). Only `application/json` and `text/plain`, as the attachment names them; UTF-8 without NUL
bytes, up to 512 KiB each and 10 per result. The summary counts them apart from the screenshots.

A project that has connected its own storage bucket in Plune takes more. Every file an attempt kept
— screenshots, text, a Playwright trace, a video — goes straight from this machine into that bucket
over short-lived links Plune hands out per file, so a trace of up to 100 MB is streamed from disk,
never read into memory. Up to 16 files go at once (`PLUNE_UPLOAD_CONCURRENCY`). The limits there are larger: 10 MiB for an
image, 5 MiB for a text, 50 MiB for any other file and 100 MiB for a video or a trace, 30 files a
result. The links are write keys to your bucket, so they are never printed — not in the log, not with
`--verbose`, not in an error; a line names the file and a code. The first time a run finds the
bucket it says so, and the summary reads `N file(s) uploaded to your bucket`, with the number
skipped or failed when there are any. A file that does not arrive is a warning, never a failed
import. Without a bucket, screenshots and text go as before, and a trace or a video is not stored —
the log says so once and the summary counts them.

### Files from a JUnit report

JUnit has no field for a file, so the runners that keep one print a line of their own in the test's
output, as Jenkins and GitLab read it: `[[ATTACHMENT|path]]` on a line by itself, in `system-out` or
`system-err` of the test. `plune run import` reads that line in every test case and sends the file the
way the Playwright reporter sends one: into your bucket if the project has one, to the result if it is a
PNG, JPEG, WebP, JSON or plain text; any other file (a trace, a video) needs the bucket and is counted as
not stored without one. Any extension is read. A relative path
counts from the folder of the report, so run the import where the report and its files were written.

pytest (`junit_logging=system-out` is what puts the output into the report):

```python
def test_checkout(page):
    page.screenshot(path="artifacts/checkout.png")
    print("[[ATTACHMENT|artifacts/checkout.png]]")
```

```bash
pytest --junitxml=report.xml -o junit_logging=system-out
plune run import report.xml
```

Java, JUnit 5 (Maven Surefire writes the test's output into its testcase; Gradle only with
`reports.junitXml.outputPerTestCase = true`). The path counts from the folder the XML file is in
(`target/surefire-reports`, `build/test-results/test`), so the file has to be below it:

```java
@Test
void checkout() {
    // ... save the screenshot as target/surefire-reports/artifacts/checkout.png
    System.out.println("[[ATTACHMENT|artifacts/checkout.png]]");
}
```

A file that is not there (a cleaned-up workspace, a typo, a screenshot that was never taken) does not
fail the import: every result still goes to Plune. Each one gets a line, always, not only with
`--verbose`, and the end of the output counts them:

```
plune: attachment not found — "shop.Cart › rejects a negative quantity": artifacts/missing-trace.zip
Imported 120 results · 34 files uploaded · 2 files not found
```

A CI step that should go red for it passes `--fail-on-missing-attachments`: exit code 1, with the
results already sent. A path that leaves the folder of the report (`../../etc/passwd`, an absolute path
elsewhere, a link that points outside) is refused with the same line, and the file is never read.
Console output kept per suite rather than per test (`jest-junit`) names no test, so nothing is read from it.
For Jest, use Allure below.

### An `allure-results` folder

Every Allure adapter (pytest, JUnit 5, TestNG, Playwright, Cypress, Jest, Vitest, WebdriverIO, .NET) writes
the same folder: a `*-result.json` per test, a `*-container.json` per suite, and the files the tests attached.
Point `plune run import` at the folder (a folder with a `*-result.json` in it is read as Allure, no flag needed). Each test arrives with its
name, its status as Allure shows it (`passed`, `failed`, `broken`, `skipped`), its time, the failure message and
trace, and its steps; a test run again (same `historyId`) is one test with attempts, the last one counting.
The files come from the test, from its steps and from its fixtures (`befores`, `afters`), each with the
`type` Allure wrote, and go the way a JUnit file goes: your bucket, or the result for a picture or a text. A
`source` counts from the folder, and one that leaves it is refused. A missing file, `--fail-on-missing-attachments`
and the summary line work as for JUnit above.

pytest (`allure-pytest`):

```bash
pip install allure-pytest
pytest --alluredir=allure-results
plune run import allure-results
```

```python
import allure

def test_checkout(page):
    with allure.step("pay"):
        allure.attach.file("artifacts/checkout.png", name="checkout", attachment_type=allure.attachment_type.PNG)
```

Java. Maven Surefire and Gradle write JUnit XML on their own, a `TEST-<class>.xml` per class, so a Java suite
needs no Allure: point the import at the folder.

```bash
mvn test
plune run import target/surefire-reports

./gradlew test
plune run import build/test-results/test
```

Every `*.xml` in the folder that is a JUnit report is read, in the order of the file names, and together they make
one run. The folder's other files and its subfolders (Gradle's `binary/`) are not opened; an `*.xml` that is not a
JUnit report is skipped with a line in the output. Each test arrives with its class and name as the key
(`cart.CartTest#addsAnItem` from Surefire; Gradle keeps the brackets, `cart.CartTest#addsAnItem()`), its status
(`pass`, `failure`, `error`, `skipped`), the failure's message, type and stack trace, and its duration. Gradle writes
a `timestamp` on the suite, and a test's span starts there; Surefire writes none, so a Maven test's span ends when the
import reads the report (plune-ai/plune#2310). A file reaches a test only
through a `[[ATTACHMENT|path]]` line in its own output, [as above](#files-from-a-junit-report), the path counted from
the folder the XML file is in. Gradle puts that output in the test's testcase only with
`reports.junitXml.outputPerTestCase = true` (by default it writes it once per suite).

Allure adds the steps, and files attached without printing a line. The JUnit 5 adapter is
`io.qameta.allure:allure-jupiter` (from 2.35.1, `allure-junit5` is only a relocation to it, with no jar), with the
AspectJ agent from Allure's setup. It writes `allure-results` in the working folder; to have it in the build's
output, set `allure.results.directory` (in `src/test/resources/allure.properties`, or as a system property) to
`target/allure-results` for Maven or `build/allure-results` for Gradle:

```bash
mvn test                                  # with allure.results.directory=target/allure-results
plune run import target/allure-results
```

```java
@Test
void checkout() {
    Allure.addAttachment("checkout", "image/png", new FileInputStream("target/artifacts/checkout.png"), ".png");
}
```

Jest has no per-test output in JUnit; `allure-jest` gives it one (`allure.attachment(...)` in a test or a step).
Tests are matched to Plune cases by the same key as a JUnit report's, `classname#name`, where the adapter's
names allow it (pytest, JUnit 5, Playwright); for Vitest, Jest and Cypress the key is the runner, the file and the
test's full name (`vt:test/cart.test.js#cart adds an item`, `jest:…`, `cy:…`). For JUnit 5 the name carries the
method's parentheses in Allure and in Gradle's JUnit XML (`shop.CartTest#coupon()`) but not in Surefire's
(`shop.CartTest#coupon`), so a project that moves between Allure and Surefire meets its cases under other keys. A file whose name starts with `_`
is not sent: the core hides it as Playwright's own reports do, and Allure has no such convention, so name
attachments without a leading underscore.

For a JUnit report, check that the output reaches the report: Gradle writes it only with `reports.junitXml.outputPerTestCase = true`,
and Maven Surefire moves it out of the XML when `redirectTestOutputToFile` is `true`. As in the Playwright
reporter, a file whose name starts with an underscore is skipped, and a file several tests name is uploaded once per test.

### A k6 summary or a Lighthouse report

Plune runs no load or page-speed tests of its own: it takes the results of the tools that do, as a run.

**k6.** Import the end-of-test summary, written with `k6 run --summary-export=summary.json script.js` or
from `handleSummary` (`return { 'summary.json': JSON.stringify(data) }`; both have the same `metrics`).
Each threshold of each metric is one result, named after the metric and the expression
(`http_req_duration p(95)<500`): passed when k6 says the threshold held, failed when it was crossed. The
metric's measured values (`avg`, `p(95)`, `rate`, …) are the result's message. A summary with no
thresholds is refused (exit 2) and nothing is imported: k6 judged nothing, so there is nothing to pass or fail.
A threshold is known by the file's name as well as the metric and the expression, so `smoke.json` and
`load.json` imported under one `--key` stay two results each; renaming the summary file starts a new test.

Only the file's base name counts, not its folder: `a/summary.json` and `b/summary.json` give the same keys.
So when the jobs of a matrix import into one run under one `--key`, each job names its summary file
apart, or every job's thresholds land on one result (the same key twice is a duplicate, not a second
result) and all but one job's verdict is lost:

```yaml
- run: k6 run --summary-export=summary-${{ matrix.scenario }}.json script.js
```

What a verdict does: a crossed k6 threshold, or a Lighthouse category under its bar, is a **failed** result,
and only that. The run takes it like any other failed test and is finished as usual — neither the run nor
the import is stopped or refused for it — and `plune run import` exits 0. To have the job fail, add
[`--fail-on-failures`](#a-release-gate---fail-on-failures): the command then exits 1 when the summary the
platform froze has a failed (or broken) result, 0 when every threshold held and every category reached its
bar. The results are sent either way. A shard that leaves a shared run open has no verdict yet; gate on the
step that finishes it.

**Lighthouse.** Import the JSON report, `lighthouse <url> --output=json --output-path=lighthouse.json`. Each
category in it (`performance`, `accessibility`, `best-practices`, `seo`, …) is one result, named after the
category, the page and the form factor Lighthouse ran as (`performance (https://example.com/, mobile)`), so a
mobile and a desktop report of one page imported under one `--key` are two sets of results, with the score as Lighthouse shows it, 0–100. It passes at or above the bar:
`--min-score performance=80` sets it per category (repeat the flag), and a category you do not name needs 90,
where Lighthouse's own "good" band starts. A category Lighthouse could not score (`null`) fails and says so;
a report that stopped on a runtime error (`NO_FCP`, …) fails every category with that error's message
(`NO_ERROR`, which older Lighthouse writes into a clean report, is no error). A `--min-score` for a category
the report does not have (`perf=95` for `performance`) is refused with exit 2 and the categories it does have,
and so is `--min-score` for any report that is not Lighthouse, a folder included; no run is opened either way.

```bash
plune run import summary.json
plune run import lighthouse.json --min-score performance=80 --min-score seo=95
```

Both are recognised by their own keys (`metrics` for k6, `lighthouseVersion` and `categories` for
Lighthouse), never by the file name; `--format k6` or `--format lighthouse` says it outright. A report file
that starts with a UTF-8 byte order mark is read as if it did not, in every format.

### Several jobs, one run

Two suites, or a sharded matrix, report into a single run when every job shares a key **and** knows
it is not the last one:

```bash
PLUNE_SHARED_RUN=1 plune run import ./junit.xml     --key "$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
PLUNE_SHARED_RUN=1 plune run import ./app/junit.xml --key "$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
plune run finish "$RUN_ID"                          # once, when they are all done
```

`PLUNE_SHARED_RUN=1` is what stops a job closing a run its siblings are still reporting into; the
key alone says where the results go, not who ends the run. Leave it unset in the last job and that
job closes the run instead of the explicit `finish`.

`plune run exec` sets it for you — anything reporting inside it, this command included, joins
without closing.

#### Closing a sharded run by itself: `PLUNE_SHARD`

When you know how many shards there are, let them close the run instead of a final `finish` step:

```bash
PLUNE_SHARD=2/4 plune run import ./junit.xml --key "$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
```

`PLUNE_SHARD=k/N` says "this job is shard k of N" (k counts from 1, `1 <= k <= N <= 1000`; a Playwright
`--shard=2/4` user passes the same string). It implies `PLUNE_SHARED_RUN`: the job uploads its results, then tells
Plune that shard k is done. The run closes once, when N different shards have said so, in whatever order and however
often a shard is retried (a repeat counts once; a red shard counts too). The job's exit code does not depend on the counts.

```
plune: shard 2 of 4 done — 2 of 4 shards reported
```

The shard that is the Nth also prints `plune: run closed` just above that line, so the `shard ... done` line is always the last one.

- A value that is not `k/N` (`0/4`, `5/4`, `2`, `a/b`) is a configuration error: nothing is sent and the command fails.
  Every shard of a run must use the same N; a different one fails with a message naming both numbers, and the run is left as it was.
- The index is not guessed from CI variables (matrix indexes are 0-based on some runners and 1-based on others); set it.
- On a platform that does not support it yet, the job warns once (`the platform does not support shard auto-close yet`)
  and leaves the run open, as `PLUNE_SHARED_RUN` does: close it with `plune run finish`.
- With `--fail-on-failures`, the shard that closes the run gates on its summary; the others have no verdict yet.

#### A combination per job of a matrix: `PLUNE_CONFIGURATION`

The jobs of a matrix of browsers and systems report into one run, each under its own combination of
configuration values (plune-ai/plune#1251):

```yaml
strategy:
  matrix:
    browser: [Chrome, Firefox]
    os: [Windows, macOS]
env:
  PLUNE_RUN: ${{ github.run_id }}-${{ github.run_attempt }}
  PLUNE_SHARED_RUN: 1
  PLUNE_CONFIGURATION: "Browser=${{ matrix.browser }};Operating system=${{ matrix.os }}"
```

`PLUNE_CONFIGURATION` is `Group=Value` pairs split by `;`, with the names of the groups and values as in
Settings → Configurations. Case does not matter, spaces around a name or a value are dropped, and so is an
empty pair (`;;`, a `;` at the end); a value may hold `=`, since a pair splits at its first one. Every results
batch of `plune run import` and of the Playwright reporter carries it, and Plune files the results under that
combination of the run: one the run already has (a run launched from the dashboard with configurations, joined
by its key), or one it adds. A value that is not in Settings is taken as sent, marked "not in the list". Unset
or blank, the batch is sent as before. The run is closed once at the end, as above.

- A pair without `=`, without a group or without a value, or one group named twice, is a configuration error:
  nothing is sent and the command fails.
- Every job of a run names the same groups. Plune refuses with 422 a batch that names other groups, or one that
  would take the run past its limits (25 combinations, 40 000 results to expect); its message is printed as it
  came, and the batch goes to the fallback file like any other refused batch.
- The fallback file keeps the combination, and `plune run report` sends the batch back into it.

### A time limit for the import

The whole `plune run import` stops after 600 seconds by default, so a platform that stops answering cannot hold a CI job until its own timeout kills it. Raise it for a very large report, or turn it off with `0`:

```bash
PLUNE_IMPORT_TIMEOUT=1200 plune run import ./playwright.json     # seconds, 0 to 86400; 0 is no limit
plune run import ./playwright.json --timeout 1200                # the same, as a flag (it wins)
```

At the limit the command sends `terminate` for the run it opened (not for a run other jobs share), says in one line that the platform may have received part of the results, and exits 1. Import the report again afterwards.

### Many screenshots: upload concurrency and retries

Files go to Plune up to 100 to a request: `uploads-batch` announces them (with the SHA-256 of each, read as a stream,
so a file the platform already has is answered `exists` and is not sent again), the bytes go straight to your bucket
(or, for a project without one, 100 files or 6 MiB at a time through `direct-batch`), and `complete-batch` confirms
them. Every file has its own verdict: one that is refused is reported and the rest of its request goes through. A
report of 2760 screenshots is about 56 requests to Plune instead of 5500. The bytes themselves still go one request each,
so the PUTs to a bucket are bound by the round trip, not by bandwidth: 16 at a time by default, lower it on a runner
with a fragile link or a bucket that throttles:

```bash
PLUNE_UPLOAD_CONCURRENCY=4 plune run import ./playwright.json      # 1 to 32, default 16
plune run import ./playwright.json --upload-concurrency 4          # the same, as a flag (it wins)
```

When the platform answers 429 with a `Retry-After` (seconds or an HTTP date, never waited longer than 60 s),
the request is tried again after that time plus up to half as much, and every other request of the import
waits through the same pause. `PLUNE_UPLOAD_RETRIES` (0 to 20, default 6) says how many times; a 429 that
carries a `quota` object in its body is the quota and is not retried, with or without `Retry-After` (the message names the
limit and when it resets); one with neither the object nor a `Retry-After` is read the same way. A platform that is down (a 5xx or no answer) is still tried
twice (three times for a bucket). A 429 on a whole request waits the same way; a file that the bucket did not
answer for at `complete` is confirmed again, on its own. A file that stays refused is reported without it, never fails
the import, and is counted in the line printed before the summary:
`plune: files — 2758 uploaded, 0 skipped, 0 already there (skipped), 14 retried, 0 dropped, in 41.2 s (16 at once, 56 request(s) to Plune)`.
`already there` are the files Plune had from an earlier import of the same report (same result, name, type and bytes):
none of them is sent again. Against a platform older than the bulk routes (it answers 404 to `uploads-batch`) the CLI
sends one request per file, as before; it decides by that answer, not by a version. A value outside the range is
ignored with a warning, and the default is used. The Playwright reporter reads the same variables.

### When a test is deleted

A test that vanishes from the code stays in Plune as an active case until something says otherwise.
The run that covers the whole suite is what says it:

```bash
PLUNE_FULL_RUN=1 plune run import ./junit.xml      # or the same variable on the Playwright reporter's job
```

When that run finishes having reported everything it expected, every case its source used to
report and did not this time is marked **detached** — not deleted, not retired: it keeps its history
and its place, and the dashboard shows it with the run as the reason. The next result on it brings
it back by itself. Set the variable only on the job that runs everything: a run of one file or a
`--grep` also reports everything it expected, and with the flag it would detach the rest. A run that
lost a shard (`notRun` is not empty) never detaches anything. `plune run start` has no list of
tests to compare against, so the flag means nothing there.

### What the run is called

A run nobody named is called after the directory, the minute it started and where it ran —
`plune · 2026-09-15 15:26 · ci` — so a row in the list reads without being opened. The clock is the
reporting machine's own; `ci` comes from the `CI` variable every hosted runner sets. To call it
something else, set `PLUNE_RUN_TITLE` (`--name <text>` on `plune run import`, `run start` and `run exec` does the same and wins); `PLUNE_ENV` and `PLUNE_LABELS` mark where it ran and how, and
those stay marks rather than becoming part of the name.

## Optional: keep a history

Everything above works with no account, no network, and no token — that does not change. `run`,
`report`, `diff` and `init` never open a socket, and that is the half this promise is about. If you
also want run history, trends, and a shared dashboard, the commands below push your local runs to
the [Plune platform](https://plune.ai/platform):

```bash
plune login          # paste the API token from your platform settings page
plune run            # exactly as before — the run is saved locally
plune sync           # upload .plune/last-run.json, print the read-back URL
plune pull           # the test cases as plune/cases.md — edit them anywhere
plune push --dry-run # what a push would change, before it changes anything
```

The token is stored at `~/.config/plune/credentials.json` (mode `0600`, honours `XDG_CONFIG_HOME`)
and is never printed or logged. `PLUNE_API_URL` points `sync`, `pull` and `push` at a different server —
useful for a self-hosted backend. The Markdown format `pull` writes and `push` reads is documented at
[docs.plune.ai/platform/cases/markdown](https://docs.plune.ai/platform/cases/markdown/).

### Plune tools for AI agents: `plune mcp`

`plune mcp serve` gives an agent the same Plune your token reaches — the review queue, cases,
missions, questions, strategy, reports — as MCP tools over stdio. The agent is shown 17 tools, 8 with a
read token or `--read-only`; five more write tools it finds with `plune_discover_tools`. Every write
tool takes `dry_run`, batches stop at 100 items, and the agent is held to the platform's agent rules: a proposed case lands in the review
queue, a bulk decision needs a confirm, and nothing is deleted through MCP.

The full guide is [Plune tools for AI agents](https://docs.plune.ai/cli/guides/mcp/): a project
`.mcp.json` and the Cursor file, the two protocol revisions the server speaks, how to keep the tool list
small, and what the contract tests check (snapshot, lint, token budget) and what they do not.

`plune_cases_generate` asks the project's AI for case proposals from pasted text (a requirement, a
story, a ticket's text; 20 words to 12 000 characters, up to 12 proposals, 8 by default). It spends the
project's AI budget, and its proposals wait in the review queue like any other until a person approves
them. The run is queued: the tool answers with its id, and `plune_cases_generation_get` reads where it
stands, what it produced and what it cost. A Jira ticket by its key is not taken over MCP: paste its
text. The platform's refusals (409 `duplicate_source` until `confirmDuplicates: true`, 422 for text
too short or too long, 429 limits, 503 / 409 when the project's AI is not set up) come back with
their `code` as the platform sent them. Both tools work in the server's `--project` unless the call
names a `projectId`.

Claude Code:

```bash
claude mcp add plune -- npx -y @plune-ai/cli mcp serve
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.plune]
command = "npx"
args = ["-y", "@plune-ai/cli", "mcp", "serve"]
```

The server reads the token the way every platform command does: `PLUNE_TOKEN` from the environment
(set it in the client's `env` block), else the login `plune login` saved. A read token, or
`--read-only`, offers only the read tools.

`plune_project_context`, the call an agent starts with, also answers `memoryRules`: the rules of the
project's memory that a person accepted in the review queue and has not retired, each as its `id` and
`text`, for the agent to follow without asking again. A rule that is only proposed, or was rejected, is
never among them. A platform that keeps no project memory answers no rules, and the rest of the
context stands.

To run a whole testing mission with these tools, give the agent the [`qa-mission` skill](docs/guide/qa-mission.md)
(it ships in the package under `skills/qa-mission`): it reads the product's docs, asks 3 to 5 questions,
writes a test strategy file and proposes 20 or more cases to the review queue.

The server speaks both MCP protocol eras: a client that opens with `initialize` (revision
`2025-11-25` and earlier) and a client on revision `2026-07-28` that sends `server/discover` and
per-request `_meta`. In the newer revision a client learns that `plune_discover_tools` changed the
list through `subscriptions/listen`; `tools/list` is sent with `ttlMs: 0`, so a client that does not
listen reads the current list every time.

#### Dependencies

| Package | Version | License | Why |
|---|---|---|---|
| `@modelcontextprotocol/server` | 2.4.0 | Apache-2.0 | The MCP server and its stdio transport for `plune mcp serve`; it serves revision `2026-07-28` and the `initialize`-based revisions from one process. |

The version is pinned exactly, not with a range, on purpose: the 2.x line moves fast, and each update is taken
deliberately with the protocol tests run against it.

## Test an MCP server

Four commands test **any** MCP server, yours or someone else's, started over stdio or reached over
HTTP. They need no Plune account and no model, and they do not talk to the Plune platform: each one
starts the server you name after `--`, or connects to the address you give with `--url`, and nothing
else. Everything after `--` runs as your user, so point them only at a server you would run yourself.

```bash
npx -y @plune-ai/cli mcp check -- node dist/server.js                            # does it start and answer
npx -y @plune-ai/cli mcp lint -- node dist/server.js                             # what in its tools confuses a model
npx -y @plune-ai/cli mcp snapshot --out mcp-snapshot.json -- node dist/server.js # its contract, to commit
npx -y @plune-ai/cli mcp diff mcp-snapshot.json -- node dist/server.js           # what changed, and what breaks
```

| Exit | Meaning |
|------|---------|
| `0` | Nothing at the `--fail-on` level, and everything was measured. For `snapshot`: the file was written. |
| `1` | A finding (`lint`), a failed check or smoke call (`check`), or a change (`diff`) at the `--fail-on` level. `snapshot` has no `1`. |
| `2` | Nothing about the server is proven, and you can fix why: the command was not found or did not start, the server could not be reached or answered `401` or `403`, a file cannot be read, or a flag is wrong. |
| `3` | Nothing was measured: the server lists no tools, there is nothing to compare, or a check could not run. Not measured is not a pass. |

Each command's own table is in [the CLI reference](docs/guide/cli.md#plune-mcp-check). The guides on
docs.plune.ai walk through a sample server with three defects, every lint rule with an example, the
exceptions file, snapshots in a pull request, and the run in Plune through JUnit:

- [Test an MCP server](https://docs.plune.ai/cli/guides/mcp-test-a-server/): the four commands, the exit codes and states, stdio and HTTP, `plune run import`;
- [Lint an MCP server](https://docs.plune.ai/cli/guides/mcp-lint/): the rules, `--fail-on`, `plune-mcp-ignore.yaml`, `--call`;
- [Snapshot and diff an MCP server](https://docs.plune.ai/cli/guides/mcp-snapshot-diff/): what a change costs a client, and the security signal;
- [MCP server checks in CI](https://docs.plune.ai/eval-action/recipes/mcp-in-ci/): `plune-ai/eval-action/mcp@v1` for a stdio or an HTTP server.

### Is the server alive: `plune mcp check`

`plune mcp check` answers the question before any other: does the server start, finish the
handshake and answer the basic requests? It runs the checks in order (`start`, `initialize`,
`protocol-version`, `capabilities`, `tools-list`, `resources-list`, `resource-templates-list`,
`prompts-list`, `ping`), each with a state and one sentence on what it saw. A list the server did not
declare is `not-applicable`; a check with no answer within `--check-timeout` is `could-not-run`,
never a pass.

```bash
plune mcp check -- node dist/server.js
plune mcp check --url http://127.0.0.1:3000/mcp --wait 20s
plune mcp check --smoke --out check.json -- node dist/server.js
```

`--smoke` also calls the tools that say they are read-only, do not say they are destructive and need
no argument, with `{}`; `--allow-write-calls` adds only tools that say `destructiveHint: false`. It exits `0` when everything that applies passed, `1` on a failure, `2` when
the server did not start, could not be reached or wants credentials, and `3` when something could not
be measured. `--out` writes a report you can attach to a ticket: no URL, command, environment or
header in it, the server's stderr masked. The states, the options and the exit codes are in
[the CLI reference](docs/guide/cli.md#plune-mcp-check).

### Checking any MCP server: `plune mcp lint`

`plune mcp lint` reads the whole tool list of a server you name, stdio or HTTP, and reports what
makes a model choose the wrong tool: missing descriptions, look-alike tools, a string where an `enum`
belongs, a list that costs too much context, schemas that break the specification. Every finding
has a stable rule id, a level and a line on how to fix it; `--list-rules` prints the catalog.

```bash
plune mcp lint -- node dist/server.js
plune mcp lint --url https://example.com/mcp --header-env "Authorization=MCP_AUTH"
plune mcp lint --call --format json -- node dist/server.js > lint.json
```

It exits `1` on a finding at `--fail-on` (`error` by default; heuristic advice is `warn` at most),
`2` when the server does not start, and `3` when nothing was measured — a server with no tools is not
a clean one. Accepted findings go in `plune-mcp-ignore.yaml`, each with a reason. The options, the
file's format and the exit codes are in [the CLI reference](docs/guide/cli.md#plune-mcp-lint).

### Contract snapshots: `plune mcp snapshot` and `plune mcp diff`

A server's author rarely notices a contract change — a removed tool, a parameter that became
required, a rewritten description — and clients break later, quietly. `plune mcp snapshot` writes
the contract as JSON that is the same byte for byte for the same server (sorted keys and entities,
LF line endings, no time, no command, no URL, no header, secrets masked), so it can live in the
repository; `plune mcp diff` compares it with a pull request's build and classifies every change.

```bash
plune mcp snapshot --out mcp-snapshot.json -- node dist/server.js
plune mcp diff mcp-snapshot.json -- node dist/server.js
plune mcp diff mcp-snapshot.json current.json --format markdown > comment.md
```

A changed description, changed instructions, a tool that stops being read-only or becomes
destructive, and a new tool that does not say it is read-only carry a `security` signal: a reason
for a reviewer to look, not a failure by itself. The format, the rules and the exit codes are in
[the CLI reference](docs/guide/cli.md#plune-mcp-snapshot).

### Pinning approved tools: `plune mcp pin`

A server can change a tool's description after a person approved it, and tell the model something
new. `plune mcp pin` shows every tool, prompt and resource template in full (escaped: nothing that
does not print reaches the terminal), asks for an approval, and writes `plune-mcp.lock.json` with
each entry and the SHA-256 of its canonical JSON. Commit the file: the commit is the approval.
`plune mcp pin --check` in CI compares the live server with it and shows any change field by field,
the old and the new description side by side; `--stability` asks for the list several times and in a
new session.

```bash
plune mcp pin -- node dist/server.js
plune mcp pin --check -- node dist/server.js
```

It sees only what the server answers this connection: a server can answer a scanner differently from
a model's client. The format, the exit codes and a GitHub Actions example are in
[the CLI reference](docs/guide/cli.md#plune-mcp-pin).

### Checking a server against the spec: `plune mcp conformance`

`plune mcp conformance` runs the checks of the MCP specification against a server you name, stdio or
HTTP. Every check has a level (`MUST`, `SHOULD`, ...) and the section it cites; the score counts only
the `MUST` checks of a frozen profile, so it means the same thing next month. `--list-checks` prints
the catalog without a server. `--suite oauth --config <file>` (JSON or YAML) checks the authorization
side of an HTTP server.

```bash
plune mcp conformance -- node dist/server.js
plune mcp conformance --url http://127.0.0.1:3000/mcp --out junit-xml=conformance.xml
```

It exits `1` when a counted check failed, `2` when the server did not start or a flag is wrong, and
`3` when conformance is not established (a counted check could not run, or nothing was measured; the
oauth suite always ends in `3`). A pass says the server answered these requests as the text asks, no
more. The flags and the checks are in [the CLI reference](docs/guide/cli.md#plune-mcp-conformance); the
guide is at [docs.plune.ai/cli/guides/mcp-conformance](https://docs.plune.ai/cli/guides/mcp-conformance/).

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
