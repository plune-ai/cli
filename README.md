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

Each run writes its full result to `.plune/last-run.json`.

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

Datasets are JSONL, one row per line, shaped `{ "vars": { ... }, "expected"?: "..." }`. The
provider API key is read from the environment based on `provider.type`:

| Provider   | `provider.type` | Environment variable |
| ---------- | --------------- | -------------------- |
| Anthropic  | `anthropic`     | `ANTHROPIC_API_KEY`  |
| OpenAI     | `openai`        | `OPENAI_API_KEY`     |
| OpenRouter | `openrouter`    | `OPENROUTER_API_KEY` |

`model` is any id the provider serves; `plune init` starts you on `claude-sonnet-5-5`. A run's cost
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
| `plune run` | Run the suite. Flags: `--dry-run` (price the run from the model's rates — no provider key, no network), `--only <id\|tag>` (repeatable), `--bail`, `--no-cache`, `--cache-strict`, `--cache-max-age <duration>`, `--concurrency <n>`, `--format console\|json\|markdown`, `-o, --output <file>`. |
| `plune report` | Re-render the most recent run. Flags: `--format`, `-o`. |
| `plune diff <baseline> <current>` | Compare two `plune run --format json` outputs and report pass→fail regressions. Flags: `--fail-on-regression`, `--format`, `-o`. |
| `plune init` | Scaffold `plune.yaml`, a sample dataset, and `.env.example`. Flags: `--yes` (non-interactive), `--force`. |
| `plune login` | Save a [Plune platform](https://plune.ai/platform) API token so `sync` and `ingest` can reach it. The token is **checked against the API before it is saved**, so a wrong one fails here rather than two commands later. Get one at `https://beta.plune.ai` → Account → API tokens. Flags: `--token <token>` (omit to paste it or pipe it via stdin), `--skip-verify` (save without checking, for offline setup). In CI, skip this step: every platform command reads `PLUNE_TOKEN` from the environment first, and the saved login only when it is not set. |
| `plune logout` | Remove the saved token. |
| `plune sync` | Upload the latest local run to the platform. Flags: `--file <path>` to send a specific run JSON, `--fail-on-failures` to read the run's summary back once after the upload and exit with [the gate](#a-release-gate---fail-on-failures)'s code. Each upload carries an `Idempotency-Key` (SHA-256 of the body), so sending the same run again returns the same run rather than creating a second one. Against a platform with `POST /v1/jobs` the upload is also reported as a job (kind `sync`, counting the run's rows) that ends completed, or failed with the error text if the sync fails; an older platform without the route is not told, and a job report never fails the sync: when the sync goes through, one the platform did not take is said in one line on stderr. |
| `plune run import <file>` | Turn a **JUnit XML** or **Playwright JSON** report, or an **Allure `allure-results` folder**, into a run in Plune. Needs no provider key — nothing is generated. Flags: `--format junit\|playwright-json\|allure` (detected from the file when omitted; a folder is Allure), `--name <text>` to call the run something other than the [folder-based default](#what-the-run-is-called), `--key <externalKey>` to land several reports in one run (with `PLUNE_SHARED_RUN=1` — see below), `--create` to offer unmatched tests to the review queue, `--fail-on-missing-attachments` to exit 1 when a file a JUnit report names with `[[ATTACHMENT\|path]]`, or an Allure result names as a `source`, is not there (the results are sent either way), `--upload-concurrency <n>` for files uploaded at once ([1 to 32, default 16](#many-screenshots-upload-concurrency-and-retries)), `--fail-on-failures` to exit with [the gate](#a-release-gate---fail-on-failures)'s code on the summary the platform froze when this import finished the run. |
| `plune run start` | Open a platform run — or join the one already carrying `--key` — and print its id. Flags: `--key <externalKey>` (generated when absent), `--name <text>` to call the run something other than the [default](#what-the-run-is-called), `--json` for one machine-readable line. |
| `plune run finish <id>` | Close a platform run. This is what the reporter tells you to do for a run it had to leave open. Flags: `--terminate` to record it as cut short, `--reason <text>`, `--fail-on-failures` to exit with [the gate](#a-release-gate---fail-on-failures)'s code on the summary the platform froze. |
| `plune run exec -- <command>` | Open a run, run the command inside it, close the run — and exit with whatever the command returned. Sets `PLUNE_SHARED_RUN` for you, so anything reporting inside joins that run. Flags: `--key <externalKey>`, `--name <text>` (as on `run start`), `--fail-on-failures` to exit with [the gate](#a-release-gate---fail-on-failures)'s code instead — or with the command's own when no result reached the run. |
| `plune run delete <id>` | Delete a run and everything it produced — its results and the review-queue entries it raised. Approved test cases and the audit log stay. **Recoverable for 30 days** (an owner of the project can put it back from Settings → Bin), then gone for good. No prompt: it is your data, and this command belongs in scripts. |
| `plune run report` | Replay `.plune/pending-results.jsonl` — send what the reporter could not. The lines of one reporter run go back as one run, with the commit and branch the reporter recorded. Once every result has gone the file is renamed to `pending-results.<time>.sent.jsonl`; if anything did not go, it stays as it was. Flags: `--file <path>`. |
| `plune ingest [dir]` | Record a [Cairn](https://github.com/plune-ai/cairn) run in Plune. Omit `[dir]` for the newest run under `./runs`, or name the directory holding `report.json`. Generated cases arrive as **review proposals** — nothing is created until a person approves it. Against a platform with `POST /v1/jobs` the ingest is also reported as a job (kind `ingest`, counting the cases sent, named by the run it landed in) that ends completed, or failed with the error text if the ingest fails; as with `sync`, an older platform is not told and a job report never fails the ingest or changes its exit code. |
| `plune pull [file]` | Write the project's test cases as **one Markdown document** — Testomat's classical format, plus Plune's own columns — to `plune/cases.md` (or `[file]`). Refuses to overwrite a file git sees as modified; `--force` overrides, `--suite <id>` takes one suite or folder and what is under it. |
| `plune push [file] [--dry-run]` | Send the document back. Cases are matched by `id`; a block without one becomes a draft; an unknown id is refused by line; **nothing is deleted**. Prints the report — created, updated, unchanged, refused, warnings — and with `--dry-run` writes nothing. Exit `4` when anything was refused. |
| `plune requirements import <file.md>` | Import requirements from a **Markdown file** (an SRS, a PRD, a page exported from a wiki). With no mapping flags it lists the tables and sections the file has and exits `0`; with `--table` or `--sections` it is a **dry run** that writes nothing until you add `--yes`. See [Requirements from a Markdown file](#requirements-from-a-markdown-file). Needs a Plune platform that serves `POST /v1/projects/:id/requirements/import` (plune-ai/plune#1621). |
| `plune requirements links <file.md>` | Import a **traceability matrix** (a Markdown table of requirement key to test) as links between requirements and cases. With no flags it lists the tables the file has and exits `0`; with `--table`, `--requirement-column` and `--test-column` it is a **dry run** that writes nothing until you add `--yes`. See [Links from a traceability matrix](#links-from-a-traceability-matrix). Needs a platform that serves `POST /v1/projects/:id/requirements/import/links` (plune-ai/plune#1608). |
| `plune verify` | Compare the project's **automated cases** with the Playwright tests in the code, **read-only** (plune-ai/plune#1291). Prints both sides: cases in Plune that the code no longer has (already `detached`, or one a full run would detach) and tests in the code that Plune has no case for. A test is matched by the id it names (`PluneId` annotation or `@P<id>` in its title), else by its `path-title` key. Nothing is written to Plune and no id is added to your source. Playwright only. Flags: `--from <file>` (a saved `playwright test --list --reporter=json`, instead of running Playwright), `--playwright-config <path>`, `--json`, `--fail-on-drift` (exit `1` when either side has something the other lacks). |
| `plune ids [--write]` | Write the Plune **case id of each Playwright test that names none** into a mapfile, `plune/ids.json` (`{ "<path-title>": "<case id>" }`), instead of editing your test files (plune-ai/plune#1291). A **dry run** unless `--write`: it prints what it would add. Only tests whose case Plune already holds get an entry (matched by the `path-title` key); a test with no case yet is listed and skipped. Idempotent: entries are only added, never overwritten or removed (an entry for a test no longer in the code is kept and listed), the file is sorted so diffs stay small, and nothing is written when nothing changes. A mapfile that is not a JSON object of strings is refused (exit `2`) and left as it is. Playwright only. The Playwright reporter reads the mapfile: an entry names the case after the `PluneId` annotation, `@P<id>` and a metadata attachment, and before the `playwright-id` and `path-title` keys, so a renamed test keeps its case when the entry is updated with `plune ids --write` (override the path with `PLUNE_IDS_FILE` or the reporter option `idsFile`). Flags: `--write`, `--file <path>` (default `plune/ids.json`), `--from <file>`, `--playwright-config <path>`, `--json`. Exit codes as `plune verify`. |
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
plune run import ./playwright.json    # or Playwright's own JSON report
plune run import ./allure-results     # or the folder an Allure adapter wrote — see below
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

Java, JUnit 5 (Maven Surefire writes the test's output into its testcase):

```java
@Test
void checkout() {
    // ...
    System.out.println("[[ATTACHMENT|target/artifacts/checkout.png]]");
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
Point `plune run import` at the folder (a folder is read as Allure, no flag needed). Each test arrives with its
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

Java, JUnit 5 (`allure-junit5`, with the AspectJ agent from Allure's setup; the results folder is
`target/allure-results` unless `allure.results.directory` says otherwise):

```bash
mvn test
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
test's full name (`vt:test/cart.test.js#cart adds an item`, `jest:…`, `cy:…`). A file whose name starts with `_`
is not sent: the core hides it as Playwright's own reports do, and Allure has no such convention, so name
attachments without a leading underscore.

Check that the output reaches the report: Gradle writes it only with `reports.junitXml.outputPerTestCase = true`,
and Maven Surefire moves it out of the XML when `redirectTestOutputToFile` is `true`. As in the Playwright
reporter, a file whose name starts with an underscore is skipped, and a file several tests name is uploaded once per test.

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
