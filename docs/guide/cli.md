# CLI reference

Plune is a single command, `plune`, with a few subcommands.

```bash
plune --version
plune <command> [options]
```

---

## `plune init`

Creates a `plune.yaml` interactively. It asks a few questions (provider, model, dataset, …) and
writes the file in the current directory.

```bash
plune init
```

- Requires an interactive terminal (TTY). In a non-interactive shell it exits with an error — write
  the `plune.yaml` by hand instead (see [Configuration](./configuration.md)).

---

## `plune run`

Runs the evals defined in your config and reports pass/fail + cost.

```bash
plune run [options]
```

### Options

| Option | Meaning |
|--------|---------|
| `--config <path>` | Use a specific config file (default: `plune.yaml` in the current directory). |
| `--only <selector>` | Run a subset. `<selector>` is an eval `id` or `tag:<name>`. **Repeatable**: `--only a --only tag:rag`. |
| `--dry-run` | Estimate cost/tokens without calling the model or touching the cache — so it needs no provider key. Always exits `0`. |
| `--concurrency <n>` | Override how many rows run in parallel (default: the config's `provider.concurrency`, or 4). |
| `--no-cache` | Ignore the cache for this run — always call the model, don't read or write cached completions. |
| `--cache-strict` | Every row must come from the cache; no model call for completions. A miss ends the run with exit `5` and lists the rows with no entry. Cannot be combined with `--no-cache`. |
| `--cache-max-age <duration>` | Treat cache entries older than this (`90s`, `15m`, `12h`, `7d`) as a miss. |
| `--bail` | Stop after the first eval that fails. |
| `--runs <n>` | Run every dataset row `n` times (`1` to `100`) for this run, over `runs` in the config; `pass_threshold` still comes from the config. A value outside the range exits `2`. See [Repeats](./configuration.md#repeats-runs-and-pass_threshold). |
| `--format <fmt>` | Output format: `console` (default), `json`, or `markdown`. |
| `-o, --output <path>` | Write the report to a file instead of stdout. |

### Examples

```bash
plune run                          # run everything in ./plune.yaml
plune run --config evals/ci.yaml   # a specific config
plune run --only faq-tone          # just one eval, by id
plune run --only tag:smoke         # all evals tagged "smoke"
plune run --dry-run                # how much would a full run cost?
plune run --no-cache --concurrency 8
plune run --bail                   # fail fast
plune run --runs 5 --no-cache      # five fresh runs of every row: how flaky is it?
```

### Output

By default Plune prints a **console report**: a summary line, each eval's pass/fail status, and
details for the **failed/errored** rows (passing rows are collapsed). The summary line looks like:

```
12/15 passed · 2 failed · 1 errored · $0.0431
```

Use `--format` to choose the shape and `-o` to write it to a file:

```bash
plune run --format json                    # the raw RunResult, for scripts
plune run --format markdown -o report.md   # a Markdown report (great for PR comments)
```

The full machine-readable result is always written to **`.plune/last-run.json`** (a `RunResult` — see
[How it works](./concepts.md#the-runresult)); `plune report` re-renders it without re-running.

If `--only` matches nothing, Plune prints `No evals matched the selector.` and exits `0`.

### Exit codes

`plune run` sets the process exit code so it slots into CI and shell scripts:

| Exit | Meaning |
|------|---------|
| `0` | All assertions passed (or `--dry-run`, or `--only` matched nothing). |
| `1` | At least one assertion **failed** — a quality regression. |
| `2` | A **config/execution error** (bad YAML, missing API key, unknown prompt variable, …), **or** one or more rows **errored** (provider outage) with no normal failures. |

The split between `1` and `2` is deliberate: a model outage (`errored`) is infrastructure, not a
regression in your prompt, so it doesn't masquerade as a `1`. See
[errored vs failed](./concepts.md#errored-vs-failed).

```bash
# In CI:
plune run || code=$?
case $code in
  0) echo "✅ all passed" ;;
  1) echo "❌ quality regression" ; exit 1 ;;
  2) echo "⚠️  infra/config problem" ; exit 1 ;;
esac
```

`plune diff <baseline> <current>` always prints the comparison. With `--fail-on-regression` it sets:

| Exit | Meaning |
|------|---------|
| `0` | No regression, and every eval of the current run was measured. Without the flag, always `0`. |
| `1` | At least one eval went from passed to failed — a regression. |
| `2` | An input file is missing or is not a `plune run --format json` result. |
| `3` | No regression, but at least one eval was **not measured**: it errored in the current run, none of its rows was judged, or it errored in the baseline and fails now, so there was nothing to compare. Re-run it. |

An eval new in the current run that fails is reported (`new-fail`) and does not gate. An eval that
errored in the baseline and fails now is reported as `unmeasured`, not as a pre-existing fail. The
summary's `unmeasured` field holds the count, and the report's headline names it instead of «No
regressions». An eval with at least one failed row counts as failed even if other rows errored.
An eval in which no row was judged — every row blocked or skipped, or an empty dataset — counts as
not measured too (exit `3`), never as a pass.

---

## `plune run start · finish · exec · report`

These drive a **platform** run — the thing the Plune reporter reports into. They exist for the
case a reporter cannot see: shards that are separate CI steps, a `merge-reports` stage, a suite
split across two runners. Something has to open the run before any of them start and close it
after all of them finish.

```bash
plune run start --key "$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"     # opens (or joins) and prints the id
plune run finish <id>                                          # closes it
plune run finish <id> --terminate --reason "CI cancelled"
plune run exec --key "$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" -- npx playwright test
plune run report                                               # sends what the reporter could not
```

> **Why the attempt number?** GitHub Actions re-runs ("Re-run failed jobs") reuse the same
> `GITHUB_RUN_ID` but increment `GITHUB_RUN_ATTEMPT`. Without it, a re-run joins a run that is
> already closed: the platform will not take new results into it, and they stay undelivered on the
> runner in `.plune/pending-results.jsonl`. The combined key gives each attempt its own run.

`plune run` on its own still runs your assertion suite — these are subcommands, and it takes no
positional arguments of its own.

**`import` takes part in this.** Given `PLUNE_SHARED_RUN=1` (or `PLUNE_PROCEED`, which `exec`
sets), it leaves the run open for the next job instead of closing it — so two suites that cannot
produce one report still produce one run. Without either variable it closes the run it finished,
which is right for the single-job case and was wrong for every other one until 0.9.1.

**`import` also sends the files a JUnit report announces.** A test that prints `[[ATTACHMENT|path]]` on a
line of its own (to `system-out` or `system-err`) has that file uploaded to its result, the path counted from
the folder of the report. A file that is not there is named in the output, always, and counted in the last
line (`Imported 120 results · 34 files uploaded · 2 files not found`); the import still succeeds. Pass
`--fail-on-missing-attachments` to exit 1 in that case, with the results already sent. A path outside the
folder of the report is refused the same way and never read. Examples for pytest and Java are in the README.

**`import` reads an Allure `allure-results` folder.** Give it the folder instead of a file
(`plune run import allure-results`; `--format allure` is the same). A folder is Allure when a `*-result.json` is
in it; any other folder is read as JUnit files (below), and `--format playwright-json` on a folder is refused. Tests
come from `*-result.json` with their status (`passed`, `failed`, `broken`, `skipped`), time, failure message
and trace, and steps; the suite name comes from `*-container.json`. The files are the `attachments[]` of the
test, of its steps and of its fixtures (`befores`, `afters`), sent with the `type` Allure wrote or, without
one, the file's extension. The same test run again (same `historyId`) counts as its attempts, the last one to
stop being the result. A file keeps the name Allure gave it with the file's extension added when the name has
none (`after add` becomes `after add.png`). A `source` is counted from the folder, which may be reached through
a link; a missing one, a `source` that leaves the folder and `--fail-on-missing-attachments` behave as for JUnit
above. At most 100 files of one test are read, as for JUnit, and the rest is said in one line. With
`--format allure`, a folder with no `*-result.json` is an error (exit 2), never an import of nothing; without the
flag such a folder is read as JUnit files (below). Examples for pytest (`allure-pytest --alluredir`) and Java
(`io.qameta.allure:allure-jupiter`; `allure-junit5` is only a relocation to it from 2.35.1, with no jar) are in the
README. pytest writes the folder `--alluredir` names; Allure for Java (allure-java) writes `allure-results` in the
working folder unless `allure.results.directory` names another.

**`import` reads a folder of JUnit files.** Maven Surefire (`target/surefire-reports`) and Gradle
(`build/test-results/test`) write a `TEST-<class>.xml` per class; `plune run import target/surefire-reports` reads
every `*.xml` of the folder that is a JUnit report, in the order of the file names, as one run (`--format junit`
says so outright). Subfolders (Gradle's `binary/`) and other files are not opened, links are not followed; an
`*.xml` that is not JUnit is skipped with a line in the output. A `[[ATTACHMENT|path]]` counts from the folder the
XML file is in; Gradle writes a test's output into its testcase only with `reports.junitXml.outputPerTestCase = true`.
A folder with neither a `*-result.json` nor a JUnit file is an error that names both and up to three of the files it
skipped as not JUnit (exit 2). Surefire writes no `timestamp` on a suite, so a Maven test's duration arrives as the span
that ends when the import reads the report (plune-ai/plune#2310).

**`exec`** is the whole thing in one line: it opens a run, gives the command `PLUNE_RUN` and
`PLUNE_PROCEED` so any reporter inside joins without closing it, waits, then closes the run and
exits with the **command's** code. The run is closed even when the command failed — a failed test
run is still a finished one, and leaving it open would say "we never found out".

**`report`** replays `.plune/pending-results.jsonl`, which the reporter writes when the platform
was unreachable, the token was refused, or the run was already closed. Without it "nothing is
lost" would only mean the results are on disk in a shape nothing reads.

The lines one reporter run wrote are **one run** when replayed. A hundred tests sent in batches of
thirty are four lines, and `report` opens one run for them, not four — with the commit and branch
the reporter recorded, not those of the job that replays them. A file an older reporter wrote,
whose lines carry no mark of the run they belong to, replays one run to a line, as it always did.

When every result has gone, the file is renamed to `pending-results.<time>.sent.jsonl` beside it,
so that a second `plune run report` does not send it all again. It is set aside, **not deleted**.
When anything did not go, the file stays exactly as it was: a partly failed send must not be the
reason the rest disappears.

`--json` on `start` prints one machine-readable line, for a CI step that needs the id.

Exit codes follow the rest of the CLI: **2** when you can fix it (no token), **1** when the
platform refused or could not be reached.

## `plune report`

Re-renders the **most recent run** (from `.plune/last-run.json`) without re-running the evals — handy
for viewing a CI run's result later, or re-formatting it for a PR comment.

```bash
plune report                          # the console report for the last run
plune report --format markdown        # as Markdown
plune report --format json -o run.json
```

### Options

| Option | Meaning |
|--------|---------|
| `--format <fmt>` | `console` (default), `json`, or `markdown`. |
| `-o, --output <path>` | Write to a file instead of stdout. |

### Exit codes

| Exit | Meaning |
|------|---------|
| `0` | Rendered the saved run. |
| `2` | No saved run yet (run `plune run` first), or the saved file is unreadable/malformed. |

## `plune automate`

Turns **one case from Plune** into Playwright code with [Cairn](https://github.com/plune-ai/cairn), and
prints that code as a diff of new files.

1. Reads the case with your token (`GET /v1/test-cases/:id`). It needs steps: an automated or eval case
   is refused.
2. Writes it in Cairn's ATC format into a temporary run folder (`report.json` and
   `testcases/ATC-PLUNE-001.md`) and runs `cairn automate --run <that folder>` in `--repo`.
3. Reads every file Cairn wrote under the run's `tests/`, prints them as a diff on stdout, and deletes the
   temporary folder.

Plune knows about Cairn; Cairn does not know about Plune. Cairn starts with **no `PLUNE_*` variable
and no variable whose value holds your token**. It loads `.env` from its working directory, so it is
pointed (`DOTENV_PATH`, `DOTENV_CONFIG_PATH`) at a copy of the repo's `.env` without those lines. Your
provider keys go through as they are.

The command writes nothing into your repo. The main copy of the code is the repo's: apply the diff, open
the branch or the PR yourself or in CI. Without `--send`, **nothing is sent to the review queue**, and the
command says so on stderr.

```bash
plune automate 0b6c…e1 --url https://staging.example.com > cart.diff
git apply cart.diff
plune automate 0b6c…e1 --repo ../shop -- --validate --session shop   # arguments after -- go to Cairn
plune automate 0b6c…e1 --send > cart.diff                            # and put it in the review queue
```

### `--send`: the code as a proposal in the review queue

With `--send`, the diff is still printed, and then the same files go to the platform as an **automation
proposal** (`POST /v1/review-items/automations`). A person reviews it in the queue; approving it writes the
case's code snapshot (for a manual case, it makes a new automated case beside it). Nothing is written to git.

- **What is sent:** every file of the diff, whole, at the same `tests/…` path; the first `test()` call of
  the first spec file (`*.spec.ts`, `*.test.ts`) as the case's code, with its `path:line`; the case's
  current code hash, when it has code, so approval can tell whether the case changed since; and which
  Cairn version (from `cairn --version`, started with the same clean environment) and which CLI wrote it.
- **Bounds, checked before anything is sent:** at most 10 files, each at most 16 384 bytes, 65 536 bytes
  in all, paths at most 400 characters. Over a bound, nothing is sent and each bound that failed is
  named; the diff above is complete.
- **The answer:** `Queued a new proposal for '<case>': review item <id>.`, or, when a proposal for the
  case was already waiting, `Replaced the proposal waiting for '<case>': review item <id>, now revision
  <n>.` Files the server did not keep are listed under it with their size and reason.
- **A refusal** prints the server's status, code and words, for example
  `The platform refused the proposal — HTTP 400: validation failed — …`.

It needs a `write` token and a Plune that serves `POST /v1/review-items/automations`.

The diff on stdout:

```diff
diff --git a/tests/cart.spec.ts b/tests/cart.spec.ts
new file mode 100644
--- /dev/null
+++ b/tests/cart.spec.ts
@@ -0,0 +1,12 @@
+import { test, expect } from '@playwright/test';
…
```

### Options

| Option | Meaning |
|--------|---------|
| `--repo <dir>` | Where Cairn runs: its `.env`, `knowledge/` and `.auth/` come from here. Default: the current directory. |
| `--cairn <path>` | Cairn's executable, or its `.js` entry point (run with this Node). Default: `cairn` on `PATH`. |
| `--url <url>` | The app's address, for Cairn. A case in Plune does not carry one. |
| `--send` | Also put the code in the review queue as an automation proposal (see above). |
| `-- <args>` | Passed to `cairn automate`. `--run` and `--into-project` are refused: the command owns the run folder and does not write into the repo. |

### Exit codes

| Exit | Meaning |
|------|---------|
| `0` | Cairn wrote code; the diff is on stdout (and, with `--send`, the proposal is in the queue). |
| `1` | Cairn exited with an error, or finished without writing a file; the platform could not be reached; with `--send`, no file has a `test()` call, or the platform refused the proposal. |
| `2` | Not logged in, or the token was refused; Cairn not found; the case not found; a case with no steps; a bad `--repo` or a refused Cairn argument; with `--send`, the proposal is over a bound. |

## `plune mcp check`

Checks that any MCP server starts and answers the basic requests, before you lint it, snapshot it or
point an agent at it. It needs no Plune account and never calls the platform. "The server is broken"
and "the server could not be checked" are different answers, and the second never looks like a pass.

```bash
plune mcp check -- node dist/server.js                        # a stdio server
plune mcp check --url http://127.0.0.1:3000/mcp --wait 20s     # a server CI starts beside this step
plune mcp check --smoke --out check.json -- node dist/server.js
```

### Checks

In this order, each with a stable id, a state and one sentence on what it saw:

| Check | What it asks |
|-------|--------------|
| `start` | The process started (stdio), or the server answered at `--url`. |
| `initialize` | The handshake finished; `serverInfo` (name, version) is recorded. |
| `protocol-version` | The protocol version the server chose. One older than the latest this client offers is shown as information, not a failure. |
| `capabilities` | What the server declares. |
| `tools-list`, `resources-list`, `resource-templates-list`, `prompts-list` | The list, read to its last page (at most 100), and how many entries it has. A list whose capability the server did not declare is `not-applicable`; so is `resource-templates-list` when a server that declares `resources` answers it with Method not found (any other error is `failed`). After a list times out, no further page is asked for. |
| `ping` | The server answers `ping`. |

### States

| State | Meaning |
|-------|---------|
| `passed` | The check got the answer it asked for. |
| `failed` | The server answered with a JSON-RPC error, the connection was lost after the handshake, the process exited before `initialize`, or a declared list did not answer as one. |
| `not-applicable` | The server did not declare the capability the check needs (or, with `--smoke`, the tool is not called; the reason says why). |
| `could-not-run` | Not measured. With `timedOut: true`: no answer within `--check-timeout`. Without it: skipped after two timeouts in a row, or something before it did not finish. A check that only reads what the handshake gave (`capabilities`) does not end a run of timeouts. If the declared capabilities cannot be read, `capabilities` is `failed` and the lists are `could-not-run`, never `not-applicable`. |
| `pending` | Reserved; `check` does not report it. |

### Options

The connection flags (`--url`, `--sse`, `--header`, `--header-env`, `--env`, `--cwd`, `--timeout`,
`--debug-out`) are those of every `plune mcp` command that tests a server; `--timeout` bounds the
connection and the handshake. The check's own:

| Option | Meaning |
|--------|---------|
| `--check-timeout <duration>` | How long one check may wait for an answer (default `15s`). |
| `--wait <duration>` | Keep trying to reach the server at `--url` for this long (default `0`): for a server that CI starts beside this step. Only for `--url`. |
| `--smoke` | After the checks, call each tool that says `readOnlyHint: true` (the boolean), does not say `destructiveHint: true` (a `destructiveHint` that is not a boolean counts as destructive) and has no required parameter, always with `{}`. A schema that could require something without a top-level `required` (`allOf`, `anyOf`, `oneOf`, `$ref`, `dependentRequired`, `minProperties` above 0) counts as `required-arguments`. A call is `passed` when it answers without `isError`, `failed` on a JSON-RPC error or `isError: true` (with its text), `could-not-run` with no answer. A tool not called is listed as `not-applicable` with the reason (`not-read-only`, `destructive`, `no-destructive-hint`, `required-arguments`, `smoke-limit`, `duplicate-name`, `invalid-name`); the human report gives one line per reason, the JSON every tool. Two timeouts in a row end the mode. |
| `--smoke-limit <n>` | Call at most this many tools (default `5`). |
| `--smoke-timeout <duration>` | How long to wait for one call (default `15s`). |
| `--budget <duration>` | How long `--smoke` may take in all (default `60s`); the calls it leaves no time for are `could-not-run`. |
| `--allow-write-calls` | With `--smoke`, also call tools that are not read-only but say `destructiveHint: false` explicitly, still only those without required parameters. A tool without that hint is not called (`no-destructive-hint`): the protocol's default for the hint is destructive. A warning goes to stderr before the first call, and the report says `writeCallsAllowed: true`. The hints are what the server says of itself, not a guarantee. A tool that says `destructiveHint: true` is never called; there is no flag for that. |
| `--out [<format>=]<path>` | Also write the report to this file, JSON unless a format is named (see [Report formats](#report-formats-of-plune-mcp-lint-check-and-diff)); repeatable. The JSON holds the `plune` version, the format version, the server's name and version, the transport (never the URL, the command, its environment or the headers), the protocol version, every check with its state and detail, the durations, the last lines of the server's stderr, the `--smoke` limits and calls, and `writeCallsAllowed`. Every value given for the connection is masked wherever the server repeats it: `--env` and header values, secrets in the URL, and each argument of the command after `--` of 8 characters or more. Masking matches a value as written; a server that prints a secret encoded (base64) or in pieces gets it past the mask. Text from the server is cut at 500 characters. The exit code is the `exitCode` the file records. |
| `--format <fmt>`, `--reporter junit-xml` | `human` (default), `json`, `github` or `markdown` on stdout; see [Report formats](#report-formats-of-plune-mcp-lint-check-and-diff). Durations are only in the `timing` field, so two runs on the same server give the same JSON but for it. The human report ends with a line of check counts, with `--smoke` a line of call counts, and the verdict. |

Every duration flag (`--timeout`, `--check-timeout`, `--wait`, `--smoke-timeout`, `--budget`) takes at most 2147483647 ms (about 24.8 days), the longest a timer can wait; a longer value is a flag error, exit `2`.

### Exit codes

| Exit | Meaning |
|------|---------|
| `0` | Every check that applies passed (`not-applicable` does not count against it). |
| `1` | At least one check or smoke call `failed`. A server process that started and exited before it answered `initialize` is a failed `initialize`, not exit `2`: the last lines of its stderr, secrets masked, are in the report (`stderrTail`) and the human output. |
| `2` | Nothing about the server's health is proven, and you can fix why: the command was not found or did not start, the server could not be reached (after `--wait`), it answered `401` or `403`, to the handshake or to any request after it (pass the credentials with `--header-env`; `check` does not discover or run OAuth), or a flag is wrong. |
| `3` | Nothing failed, but something could not be measured: a check `could-not-run`, no check passed, or `--smoke` found no tool to call. Not measured is not healthy. |

## `plune mcp lint`

Checks the tool list of any MCP server for what makes a model choose wrong: missing or vague
descriptions, look-alike tools, free strings where an `enum` belongs, a list that costs too much
context. It needs no Plune account and no model, and never calls the platform.

```bash
plune mcp lint -- node dist/server.js                       # a stdio server
plune mcp lint --url https://example.com/mcp --header-env "Authorization=MCP_AUTH"
plune mcp lint --format json -- node dist/server.js > lint.json
plune mcp lint --list-rules                                 # the rule catalog, no server
```

### Options

The connection flags (`--url`, `--sse`, `--header`, `--header-env`, `--env`, `--cwd`, `--timeout`,
`--debug-out`) are those of every `plune mcp` command that tests a server. The lint's own:

| Option | Meaning |
|--------|---------|
| `--fail-on <level>` | `error` (default), `warn`, `info` or `never`: exit `1` on a finding of this level or above. Heuristic rules report `warn` at most, so the default does not fail on advice. |
| `--show-info` | Print `info` findings too; without it they are only counted. |
| `--format <fmt>`, `--reporter junit-xml`, `--out [<format>=]<path>` | `human` (default), `json`, `github` or `markdown` on stdout, and files; see [Report formats](#report-formats-of-plune-mcp-lint-check-and-diff). `json` is one document on stdout and nothing else, with `kind` and `schemaVersion`. It has no time field, so two runs against the same server give the same bytes. |
| `--ignore-file <path>` | The exceptions file; by default `plune-mcp-ignore.yaml` in the current folder, if there is one. |
| `--list-rules` | Print every rule (id, class, level, description, fix, specification link) and exit `0` without connecting. |
| `--call` | Also call each tool that says it is read-only, does not say it is destructive and needs no argument, with `{}`, and check the answer (rules starting with `call-`). A name the list holds twice, or an entry without a name, is never called. Nor is a tool whose schema could require something without a top-level `required` (`allOf`, `anyOf`, `oneOf`, `$ref`, `dependentRequired`, `minProperties` above 0), or whose `destructiveHint` is not a boolean. An answer is checked against the tool's `outputSchema` without its `pattern`, `patternProperties` and `format` keywords: a server's regular expression is not run. Off by default. |
| `--call-limit <n>` | Call at most this many tools (default `10`). |
| `--call-timeout <duration>` | How long to wait for one call (default `15s`, at most 2147483647 ms). A call with no answer is `could-not-run`, never a pass. |

### Large tool lists

Two rules compare every pair of tools: `tools-similar` and `desc-no-when-not` (its warning names
a similar tool). Their work grows with the square of the tool count, so above 1000 tools they do
not run: each reports one finding with state `could-not-run`, its own level and the message
`too many tools to compare pairwise (N, limit 1000)`, and the run exits `3` (or `1` when a finding,
this one included, is at the `--fail-on` level). Every other rule runs on the whole list. At 1000 tools the
two rules take a few seconds at most, even with every description at the 1000-character mark.

Two rules read every node of an input schema, however deep: `required-unknown-property` and
`param-example-missing`. A property, or an array's items, is one level below the node it is in.
On a tool whose input schema nests deeper than 64 levels they do not run for that tool: each
reports one finding with state `could-not-run` for the tool, its own level and the message
`inputSchema nested deeper than 64 levels`. Every other tool, and every other rule on this one,
is checked as usual. `required-unknown-property` is an error, so at the default `--fail-on error`
such a run exits `1`; with `--fail-on never` it exits `3`. Real schemas nest to 10-20 levels.

Over stdio, one message from the server holds at most 10 MB (10 485 760 bytes), in every `plune mcp`
command: about 68 000 small tools (a name, an empty object schema, two annotations). Reading a larger one
costs time that grows with the square of its size (about 2 s at 38 MB, 29 s at 150 MB), so `plune`
stops there, ends the server process and says `The server sent a message larger than 10 MB, the
most plune reads in one stdio message; a long list belongs in pages (nextCursor).` `lint` then exits
`2`; in `check` the list that was asked for is `failed` with that text, as is every later request. A
server that returns its list in pages (`nextCursor`) is read to its last page, up to 100 pages.
Over `--url` there is no such limit.

### The exceptions file

```yaml
ignore:
  - rule: desc-no-when-not
    tool: some_tool           # without tool: the rule on every tool
    param: query              # optional: one parameter of the tool
    reason: "Why this is fine here."   # required
    expires: 2026-12-31       # optional: the last day it applies
```

An entry without a `reason` stops the run with exit `2` and its line number. An entry past its
`expires` no longer applies and is printed as a warning; an entry that matched no finding is printed
as stale. A suppressed finding is counted in the summary and listed, with its reason, under
`suppressed` in the JSON. An entry never hides a rule that could not run (`could-not-run`): that
finding stays in the report and the run is still not measured (exit `3`, or `1` at the `--fail-on`
level), and an entry left with nothing to cover is stale.

### Exit codes

| Exit | Meaning |
|------|---------|
| `0` | No finding at the `--fail-on` level, and everything was measured. |
| `1` | At least one finding that failed at the `--fail-on` level or above. A rule that could not run is exit `3`, at any level. |
| `2` | The server did not start or did not answer (the last lines of its stderr are printed, secrets masked), sent a stdio message over 10 MB (see [Large tool lists](#large-tool-lists)), or a flag or the exceptions file is wrong. |
| `3` | Nothing measured: the server lists no tools, `tools/list` did not end within 100 pages, a rule could not run (over 1000 tools, or an input schema nested deeper than 64 levels, see above), or with `--call` a call could not run or no tool was safe to call. Not measured is not clean. |

## `plune mcp snapshot`

Writes the contract of any MCP server as one JSON file: what the handshake says (server name,
version and title, capabilities, instructions) and every list the server declares — `tools/list`,
`resources/list`, `resources/templates/list`, `prompts/list` — each read to its last page. The file
is meant to be committed and compared with `plune mcp diff`.

```bash
plune mcp snapshot --out mcp-snapshot.json -- node dist/server.js
plune mcp snapshot --url https://example.com/mcp --header-env "Authorization=MCP_AUTH" > mcp-snapshot.json
```

The same server gives the same file byte for byte, on any OS:

- keys are sorted at every level; tools and prompts by `name`, resources by `uri`, resource
  templates by `uriTemplate`, in code-unit order (never by the machine's locale);
- lists that are sets (`required`, a list under `type`, prompt arguments) are sorted; an `enum`
  keeps the server's order, and `plune mcp diff` compares it as a set;
- LF line endings, a two-space indent and one LF at the end;
- no time, no command, no environment value, no URL, no header: of the connection only the
  transport (`stdio`, `http` or `sse`) is written;
- every value given for the connection (`--env`, `--header`, `--header-env`) of 8 characters or
  more, a value of any length whose name says it is a credential (`API_KEY`, `Authorization`, …),
  each part of the server command of 8 characters or more, and the server's address are masked
  wherever the server repeats them; your own home directory at the start of a path becomes `~`
  (another user's `/home/<name>` is left as the server wrote it).

A section of a capability the server did not declare is `null`, a declared one with nothing in it is
`[]`: not declared and empty are different facts. A server that declares resources and answers
`resources/templates/list` with Method not found gets `resourceTemplates: null`. A name a list holds
twice keeps both entries. An entity nested deeper than 64 levels is refused (exit `2`): the masking of
secrets reads no deeper, and a cut schema could not be compared.

| Option | Meaning |
|--------|---------|
| `--out <path>` | Write the snapshot to this file: to a temporary file beside it first, then renamed over it, so the file is whole or not there. Without it the snapshot goes to stdout. |

The connection flags are those of `plune mcp lint`.

### Exit codes

| Exit | Meaning |
|------|---------|
| `0` | The snapshot was written. |
| `2` | The server did not start or did not answer; a list the server declared failed, answered without its array or did not end within 100 pages (the message names the list); an entity is nested deeper than 64 levels (the message names it); `--out` cannot be written; or a flag is wrong. No file is written. |
| `3` | Nothing measured: the server lists no tool, resource, resource template or prompt. No file is written. |

## `plune mcp diff`

Compares a snapshot with a second snapshot file, or with a live server named by the connection
flags (a command after `--`, or `--url`), and classifies every change.

```bash
plune mcp diff mcp-snapshot.json current.json
plune mcp diff mcp-snapshot.json -- node dist/server.js
plune mcp diff mcp-snapshot.json --format markdown -- node dist/server.js > comment.md
```

| Option | Meaning |
|--------|---------|
| `--fail-on <class>` | `breaking` (default): exit `1` on a breaking change. `any`: on any change, a change that could not be classified included. `none`: never. |
| `--format <fmt>`, `--reporter junit-xml`, `--out [<format>=]<path>` | See [Report formats](#report-formats-of-plune-mcp-lint-check-and-diff): `human` (default), `github`, `json` (one document with `kind`, `schemaVersion`, the summary and every change; no time, so the same two snapshots give the same bytes) or `markdown`: a pull request comment that starts with the hidden marker `<!-- plune-mcp-diff -->`, apart from the `plune diff` comment. |

Every change has a class and a reason of one sentence:

| What changed | Class |
|--------------|-------|
| A tool, resource, resource template or prompt removed | `breaking` |
| One added | `non-breaking` |
| Tool input: a new required parameter, a narrowed `enum`, a changed `type`, a removed parameter, a tighter bound | `breaking` |
| Tool input: a new optional parameter, a widened `enum`, a looser bound | `non-breaking` |
| A resource's or a template's `mimeType` | `breaking` |
| A prompt argument: a new required one, one removed, one that became required | `breaking` |
| A prompt argument: a new optional one | `non-breaking` |
| A capability, or its `listChanged` or `subscribe`, removed / added | `breaking` / `non-breaking` |
| A tool's `execution.taskSupport` became `required` | `breaking` |
| A `uriTemplate` changed | the old template removed and a new one added |
| A name, title, description, the instructions, `server.version` | `informational` |
| `server.name` | `informational`, marked `server identity` |

A change no rule understands (a schema keyword such as `anyOf`, `$ref` or `format`, an unknown
field) is not called safe: it is listed as `not classified`, counted apart in the summary, and fails
the run only with `--fail-on any`. A name a list holds twice where it did not before is `breaking`;
a name held several times before and once now is compared with each former entry, and the worst of
those comparisons is shown. In `--format markdown` every text from the server is escaped (`<`, `>`,
`&`, backticks), so a server cannot add HTML, a comment or a marker to the pull request comment.

A `security` signal marks what a reviewer should read even when nothing breaks: a changed
description of a tool, resource, prompt or parameter; changed instructions; `readOnlyHint` that
stops being `true`; `destructiveHint` that becomes `true`; a new tool that does not say it is
read-only. It is `"signal": "security"` in the JSON and `[security]` in the human output, and it
does not change the class or the exit code.

### Exit codes

| Exit | Meaning |
|------|---------|
| `0` | No change at the `--fail-on` level. |
| `1` | At least one change at the `--fail-on` level. |
| `2` | A snapshot file cannot be read, is not JSON, is nested deeper than 256 levels, or has a `schemaVersion` this version does not read (the message names both); the server did not start or a declared list could not be read; or a flag is wrong. |
| `3` | Nothing to compare: neither snapshot holds a tool, resource, resource template or prompt. |

## `plune mcp conformance`

Checks any MCP server against the text of the specification, check by check, and scores the run. It needs no
Plune account. The protocol suite checks the handshake, the declared capabilities against the methods served,
ping, the JSON-RPC answers to invalid JSON, an unknown method and wrong parameters, the entries and schemas of the
tools, resources, templates and prompts lists, pagination, logging, completions, and on stdio what the server
writes to stdout and whether it exits when stdin closes.

```bash
plune mcp conformance --list-checks                       # the catalog, no server
plune mcp conformance --explain tools-list-shape          # one entry in full
plune mcp conformance --format json --out r.json -- node dist/server.js
plune mcp conformance --out json=conformance.json --out junit-xml=conformance.xml -- node dist/server.js
plune mcp conformance --fixture calls.json --url http://127.0.0.1:3000/mcp
```

The checks send their requests as plain JSON-RPC beside the connection (one line on stdio, one POST on Streamable
HTTP), not through an MCP client library, so an answer is judged as the server sent it. Lists are followed for at
most 64 pages. A check that times out is `could-not-run` (`timeout`); after two in a row the checks left are not
tried. When the handshake fails, every check that rests on it is `could-not-run` (`prerequisite-failed`), not
`failed`. Over HTTP+SSE (`--sse`) the checks that send their own requests are `could-not-run`
(`transport-error`).

No tool is called unless `--fixture` names it. The file is a JSON list:

```json
[{ "tool": "get_time", "arguments": {} }]
```

Name only tools that are safe to call: `readOnlyHint` is what the server says about a tool, not a guarantee. Without
`--fixture`, `tools-structured-conformant` and `tools-structured-has-text` are `could-not-run` (`needs-input`), which
keeps them out of the score. Besides the fixture, the only `tools/call` requests are two that cannot run a tool: one
without a name and one for a name no server has.

Schemas are judged in the dialect their `$schema` names, or 2020-12 without one; 2020-12, 2019-09 and draft-07 are
supported, another dialect is `could-not-run` (`unsupported-dialect`). No `$ref` is fetched.

### Options

The connection flags are those of every `plune mcp` command that tests a server. The command's own:

| Option | Meaning |
|--------|---------|
| `--suite <suite>` | `protocol` (default), `oauth`, `tasks` or `apps`; repeatable. |
| `--check <id>` | Run only this check; repeatable. An id the catalog does not have, or one outside the selected suites, is exit `2`. |
| `--protocol-version <revision>` | The revision to check against, or `auto` (default): the one the server answered the handshake with. A check for the other era (`legacy`: up to 2025-11-25, `modern`: 2026-07-28 on) is `not-applicable` (`era`). |
| `--format <fmt>` | `human` (default) or `json`. |
| `--reporter junit-xml` | A bare `--out <path>` is written as JUnit XML instead of JSON. It needs an `--out`. |
| `--out [<format>=]<path>` | Also write the result to a file, whole or not at all; repeatable. Without a format the file is JSON (JUnit with `--reporter junit-xml`); with one, `json` or `junit-xml`. As for the other commands (see [Report formats](#report-formats-of-plune-mcp-lint-check-and-diff)), the files come from one run and are written before anything is printed. |
| `--list-checks` | Print the catalog (table, or JSON with `--format json`) and exit `0` without connecting. |
| `--explain <id>` | Print one catalog entry in full and exit `0` without connecting. |
| `--fixture <file>` | A JSON list of `{ "tool", "arguments" }`: the only tools the run calls, for the checks of tool results. |

### The catalog

Every check has a stable kebab-case id that is never renamed, a suite, a title, a description, a kind (`check`: a
requirement of the specification; `control`: a probe other checks rest on; `advice`: outside the specification),
a level for a check (`MUST`, `SHOULD`, `MAY`), `derived` (the level is read from neighbouring provisions; the entry
says which), the specification sections it cites (revision, page, section), the eras and transports it applies to,
and whether it needs an input you give (`needsFixture`). `MUST` is used only where the cited section says MUST,
MUST NOT or REQUIRED about that behaviour of the server; without a keyword the level is `SHOULD` at most.

### States and the score

Each check is `passed`, `failed`, `not-applicable` (with a reason: `era`, `capability-not-declared`, `transport`,
`no-auth`, `not-offered`: the capability is declared but the server offers nothing the check reads, such as no
`outputSchema`), `could-not-run` (with a reason: `timeout`, `prerequisite-failed`, `needs-input`, `transport-error`,
`unsupported-dialect`) or `pending`. Each also lands in one bucket of the summary, so the buckets add up to the checks:

| Bucket | Holds |
|--------|-------|
| `passed`, `failed` | `MUST` checks of the profile with that state. |
| `couldNotRun` | `MUST` checks of the profile that could not run, but not for `needs-input`. |
| `needsInput` | `MUST` checks of the profile that need an input you did not give. |
| `notApplicable` | `MUST` checks of the profile that do not apply to this server. |
| `pending` | `MUST` checks outside the profile (their verdict is shown, not scored), or with no result yet. |
| `advisories` | `SHOULD`, `MAY` and advice: printed, never scored. |
| `controls` | Controls: printed, never scored. |

`score = floor(1000 × passed / applicable) / 10`, where `applicable = passed + failed + couldNotRun`, so 1999 of 2000
is `99.9`, never `100`. With `applicable = 0` the score is `null`: an empty run proves nothing. Each suite has its
own score; the summary of all suites adds their counts, it does not average their scores. The human report explains
every number in one line, for example:

```
protocol: Score 91.6 = 22 of 24 | failed: life-ping-empty-result | could-not-run: base-jsonrpc-parse-error (timeout) | outside the score: not-applicable 12, pending 6, needs-input 3
```

The verdict is `failed` when a scored check failed; else `incomplete` when one could not run or nothing was
measured; else `passed`.

### The profile

The score reads only the ids of a frozen profile, written out in the source and named in every result:
`profileId`, `profileVersion` (`2026-11.1`), `manifestDigest` (SHA-256 of the sorted ids, one per line). A check
added to the catalog later runs and shows its verdict, but stays in `pending` (and `pendingCheckIds`) until a new
profile version lists it, so it never changes the score or the exit code of a server measured before. The result
also records `checkerVersion` (this CLI's version), `protocolVersion`, `protocolVersionRequested`, `schemaVersion: 1`
and, per check, `class`, `level`, `state`, `reason`, `expected`, `actual`, `fix` and `specRef`.

### Exit codes

| Exit | Meaning |
|------|---------|
| `0` | Every scored check that applies passed. |
| `1` | A scored check failed. `SHOULD`, `MAY`, advice and checks outside the profile never give `1`. |
| `2` | The server did not start or could not be reached, or a flag is wrong. |
| `3` | Nothing failed, but conformance is not established: a scored check could not run, or nothing was measured. |

### JUnit XML

`--reporter junit-xml` (or `--out junit-xml=<path>`) writes one `<testcase>` per selected check: `classname`
`mcp.conformance.<suite>` (`mcp.conformance.protocol`), `name` the check id, so `classname#name` is the same on
every run. The text of a case gives the reason of its state, `expected`, `actual`, `fix` and `spec` (the
`specRef`), with secrets masked as in the JSON result.

| State | In JUnit |
|-------|----------|
| `passed` | `<testcase>` with nothing inside |
| `failed`, a `MUST` check of the profile | `<failure>` |
| `failed`, anything else (`SHOULD`, `MAY`, advice, a control) | `<skipped type="advisory">` |
| `could-not-run` | `<error type="could-not-run">`, the reason first (`could-not-run: timeout: …`) |
| `not-applicable` | `<skipped type="not-applicable">`, the reason first |
| `pending` | `<skipped type="pending">` |

So a `<failure>` is there exactly when the exit code is `1`. `could-not-run` is never a pass: it is an `<error>`
even when it leaves the exit code alone (`needs-input`, or a check that is not scored). A run with no check
selected is one case `run` that could not run.

## Report formats of `plune mcp lint`, `check` and `diff`

The three commands that test a server share one set of report flags and five formats, built from one
result of the run: what is printed and every file written come from the same connection to the
server, so a CI step gets JSON, JUnit and a pull request comment without starting the server or
calling its tools twice.

```bash
plune mcp lint --reporter junit-xml --out lint.xml -- node dist/server.js
plune mcp check --format github --smoke -- node dist/server.js
plune mcp diff mcp-snapshot.json --out json=diff.json --out junit-xml=diff.xml --out markdown=diff.md -- node dist/server.js
```

| Option | Meaning |
|--------|---------|
| `--format <fmt>` | What goes to stdout: `human` (default), `json`, `github` or `markdown`. |
| `--reporter junit-xml` | A bare `--out <path>` is written as JUnit XML instead of JSON. It needs an `--out`. |
| `--out [<format>=]<path>` | Also write the report to a file; repeatable. Without a format the file is JSON (JUnit with `--reporter junit-xml`); with one, `json`, `junit-xml` or `markdown`. The files are written before anything is printed, and the exit code is the one they record. |

Before the server is started, `--out` is refused (exit `2`) when two flags name one file (the same
full path; on Windows, whatever the case), when a path is a folder, or when its folder does not exist.
Every text is built before the first file is written: if one cannot be built, no file is written.
Each file is written to a temporary file in its own folder and renamed over the target, so a file is
there whole or not at all. The set of files is not one step: if a rename fails after others, the
files already renamed stay, and the error names them.

A value that is not in the list (`--format xml`, `--reporter xunit`, `--out html=r.html`, a word
before `=` that is not a format) is exit `2` with the values allowed, in the same words on every
command. The `--out` of `check` before these flags (one file, JSON) works as it did.

Every format gets the report after secrets are masked (see `--out` of `plune mcp check`) and with
every text from the server made printable: no control character, no new line of its own. Nothing a
command prints, to stdout or stderr, or writes to an `--out` file reads as a GitHub Actions workflow
command. The runner reads two forms: `::` at the start of a line once its leading white space is
trimmed, and the older `##[` anywhere in a line (`##[set-output …]`, `##[stop-commands]`). A line
that starts with `::` gets a `?` before it, unless the `github` format wrote it as an annotation;
every `##[` becomes `##?[`. In JSON it is written `##\u005b` and in JUnit XML `##&#91;`, both of
which read back as the same text.

| Format | What it is |
|--------|------------|
| `human` | The report for a person, as each command describes it above. |
| `json` | One document of the command, named by `kind` (`mcp-lint-report`, `mcp-check-report`, `mcp-diff-report`; the rule catalog is `mcp-lint-rules`) and an integer `schemaVersion`. |
| `github` | Annotations for a GitHub Actions step, one line each: `::error`, `::warning` or `::notice` by the finding's level (a check that could not run is a warning), `title=` the check id and its target, the message, then `expected`, `actual`, `fix`. No `file=`: the finding is about the server, so GitHub shows it on the run's page. Escaped as the Actions runner reads them: `%`, `\r` and `\n` in the message, `:` and `,` as well in the title. GitHub keeps 10 error and 10 warning annotations per step; past that the first ones are printed and one line counts the rest. A last line gives the counts and the exit code. |
| `markdown` | A pull request comment that starts with the command's hidden marker (`<!-- plune-mcp-lint -->`, `<!-- plune-mcp-check -->`, `<!-- plune-mcp-diff -->`): the counts and a table of what did not pass, at most 200 rows and then one line with how many more the JSON holds. `diff` keeps its own table of changes. Server text in a cell cannot add HTML, a code span, a new row, a mention (`@`), a link or an image (`[`, `]`, `!`) or an issue reference (`#`): those characters are written as character references. |
| `junit-xml` | One test suite of fixed cases, for `plune run import` and any CI that reads JUnit. |

### JSON versions

`schemaVersion` changes only when a field is renamed or removed, or its meaning changes; adding a
field keeps it. A reader that knows version 1 can read any later document of version 1 and ignore
the fields it does not know. The documents of version 1 are kept as reference files in the tests.

### JUnit cases and states

`classname` is `mcp.<command>` (`mcp.lint`, `mcp.check`, `mcp.diff`) and `name` the id of the check,
so `classname#name`, the key `plune run import` matches a case by, is the same on every run:

- `lint`: `tools-list` and one case per rule of `--list-rules`, not one per rule and tool: the tools
  a rule found are listed in the case's text;
- `check`: one case per check, and `smoke` (`not-applicable` without `--smoke`), with each call in
  its text;
- `diff`: `breaking-changes`, `contract-changes` (every change), `unclassified-changes` and
  `security-signals`;
- `plune mcp conformance` writes the same file, one case per check under `mcp.conformance.<suite>`
  (see [its JUnit XML](#junit-xml)).

A case's text spells out at most 200 findings, then one line with how many more the JSON holds.

No count, server name, version or time is in `name`, and the suite has no `timestamp`; `time` is set
on the cases of `check`, which times its checks. A case takes the worst state of its findings:

| State | In JUnit | What `plune run import` reads | What Plune shows with the default status map |
|-------|----------|-------------------------------|---------------------------------------------|
| `passed` | `<testcase>` with nothing inside | `pass` | `passed` |
| `failed` | `<failure message type>` | `failure` | `failed` |
| `could-not-run` | `<error type="could-not-run" message>` | `error` | `broken` |
| `not-applicable` | `<skipped type="not-applicable" message="not-applicable: …">` | `skipped` | `skipped` |
| `pending` | `<skipped type="pending" message="pending: …">` | `skipped` | `skipped` |
| `failed`, but not failing the run (see below) | `<skipped type="advisory" message>` | `skipped` | `skipped` |

The exit code and the file say the same: exit `1` exactly when a case is a `<failure>`; exit `3`
when none is and one is an `<error>`; exit `0` when there is neither. A finding is a `<failure>` only
when it fails the command's own gate: for `lint`, a finding that failed at `--fail-on` or above,
whatever its class (with `--fail-on warn` a heuristic warning fails too); for `diff`,
`breaking-changes` under `--fail-on breaking` or `any`, `contract-changes` only under `--fail-on any`,
while `unclassified-changes` and `security-signals` are always advice; for `check`, every check that
failed. Anything else that failed is advice.

`could-not-run` is never a pass and never skipped: `plune run import --fail-on-failures` counts
`failed` and `broken` as a failure, so a server that could not be measured does not pass the gate.
A run that measured nothing (exit `3`: no tool listed, nothing to compare) is not an empty file: it
holds one case `run` that could not run. The status words are mapped to Plune statuses by the
project's status map for the `junit` source; a project that changed that map reads these files by its
own map, and `could-not-run` may then not be `broken`.

Characters XML 1.0 does not allow (control characters but tab and line breaks, `U+FFFE`, `U+FFFF`,
a surrogate without its pair) are removed from the file; `&`, `<`, `>` and `"` are escaped.

## Next

- **[How it works](./concepts.md)** — caching, cost, errors, providers, and the run pipeline.
