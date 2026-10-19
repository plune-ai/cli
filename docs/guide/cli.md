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
(`plune run import allure-results`; `--format allure` is the same, and a folder is never anything else). Tests
come from `*-result.json` with their status (`passed`, `failed`, `broken`, `skipped`), time, failure message
and trace, and steps; the suite name comes from `*-container.json`. The files are the `attachments[]` of the
test, of its steps and of its fixtures (`befores`, `afters`), sent with the `type` Allure wrote or, without
one, the file's extension. The same test run again (same `historyId`) counts as its attempts, the last one to
stop being the result. A file keeps the name Allure gave it with the file's extension added when the name has
none (`after add` becomes `after add.png`). A `source` is counted from the folder, which may be reached through
a link; a missing one, a `source` that leaves the folder and `--fail-on-missing-attachments` behave as for JUnit
above. At most 100 files of one test are read, as for JUnit, and the rest is said in one line. A folder with no `*-result.json` is an error
(exit 2), never an import of nothing. Examples for pytest (`allure-pytest --alluredir`) and Java
(`allure-junit5`) are in the README.

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

## Next

- **[How it works](./concepts.md)** — caching, cost, errors, providers, and the run pipeline.
