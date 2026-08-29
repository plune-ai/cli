# Introduction

**Plune is a linter for LLM outputs.** You write a list of checks (called *assertions*), point them
at a dataset of inputs, and run `plune run`. Plune calls your model for each input and tells you, per
row, whether the output passed your checks — plus what it cost.

If you've used **ESLint** for code or **Jest** for unit tests, the mental model is the same:

| Tool | Checks… | You write… | You run… | You get… |
|------|---------|------------|----------|----------|
| ESLint | source code | rules | `eslint .` | pass/fail per file |
| Jest | functions | test cases | `jest` | pass/fail per test |
| **Plune** | **LLM outputs** | **assertions** | **`plune run`** | **pass/fail per row + cost** |

## Why would I use this?

LLM outputs are non-deterministic and easy to break silently. You tweak a prompt, switch a model,
or upgrade an SDK — and three weeks later you notice the tone changed or the JSON stopped parsing.
Plune turns "looks fine to me" into a repeatable, automatable check you can run locally or in CI.

A few things it's good at:

- **Catch regressions** — run the same assertions after every prompt/model change.
- **Compare models** — point the same eval at `gpt-4o` vs `claude-…` and see which passes more.
- **Check structure** — assert the output is valid JSON matching a schema.
- **Check meaning, not just words** — "is this answer faithful to the provided context?" (RAG),
  "is it semantically close to the expected answer?", "does an LLM judge think it meets the bar?".

## What makes it pleasant

- **Local-first.** Runs on your machine. The only network calls are to your LLM provider (and a
  one-time download of a small local model for semantic checks). No telemetry.
- **Cheap to iterate.** Completions are cached — re-running after you only changed an assertion (not
  the prompt/model) costs nothing.
- **Honest about failure.** A failed *assertion* (a quality regression) and an *errored* row (the
  provider was down) are counted and exit-coded **differently** — an outage never looks like a bug
  in your prompt.

## The 30-second example

A `plune.yaml`:

```yaml
version: 1
provider:
  type: anthropic
  model: claude-sonnet-4-5
evals:
  - id: greeting-is-polite
    prompt: "Greet a new user named {{name}}."
    dataset:
      examples:
        - vars: { name: Ada }
    assertions:
      - type: contains-any
        values: ["hello", "hi", "welcome"]
        ignore_case: true
      - type: llm-judge
        criteria: "The greeting is warm and professional."
```

```bash
plune run
# → 1/1 passed · 0 failed · 0 errored · $0.0013
```

## Where to next

1. **[Getting started](./getting-started.md)** — install, create your first config, run it.
2. **[Configuration](./configuration.md)** — every field of `plune.yaml`, explained.
3. **[Assertions](./assertions.md)** — all ten check types, with examples.
4. **[CLI reference](./cli.md)** — every command and flag, and what the exit codes mean.
5. **[How it works](./concepts.md)** — caching, cost, errors, providers, the run pipeline.

> **Status (v0.1):** `plune init`, `plune run`, and `plune report` all work. `plune run` prints a
> console report and supports `--format console|json|markdown` and `-o <file>`; the full result is
> always saved to `.plune/last-run.json`.
