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
| `--dry-run` | Estimate cost/tokens without calling the model or touching the cache. Always exits `0`. |
| `--concurrency <n>` | Override how many rows run in parallel (default: the config's `provider.concurrency`, or 4). |
| `--no-cache` | Ignore the cache for this run — always call the model, don't read or write cached completions. |
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
plune run start --key "$GITHUB_RUN_ID"     # opens (or joins) and prints the id
plune run finish <id>                      # closes it
plune run finish <id> --terminate --reason "CI cancelled"
plune run exec --key "$GITHUB_RUN_ID" -- npx playwright test
plune run report                           # sends what the reporter could not
```

`plune run` on its own still runs your assertion suite — these are subcommands, and it takes no
positional arguments of its own.

**`import` takes part in this.** Given `PLUNE_SHARED_RUN=1` (or `PLUNE_PROCEED`, which `exec`
sets), it leaves the run open for the next job instead of closing it — so two suites that cannot
produce one report still produce one run. Without either variable it closes the run it finished,
which is right for the single-job case and was wrong for every other one until 0.9.1.

**`exec`** is the whole thing in one line: it opens a run, gives the command `PLUNE_RUN` and
`PLUNE_PROCEED` so any reporter inside joins without closing it, waits, then closes the run and
exits with the **command's** code. The run is closed even when the command failed — a failed test
run is still a finished one, and leaving it open would say "we never found out".

**`report`** replays `.plune/pending-results.jsonl`, which the reporter writes when the platform
was unreachable, the token was refused, or the run was already closed. Without it "nothing is
lost" would only mean the results are on disk in a shape nothing reads. The file is **not deleted**
after a replay: a partly failed send must not be the reason the rest disappears.

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
