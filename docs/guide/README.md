# Plune User Guide

Beginner-friendly documentation for **using** Plune (a linter for LLM outputs). Read top to bottom
the first time, or jump to what you need.

1. **[Introduction](./introduction.md)** — what Plune is, why you'd use it, the mental model.
2. **[Getting started](./getting-started.md)** — install, set your key, write a config, first run.
3. **[Configuration](./configuration.md)** — every field of `plune.yaml`, with examples.
4. **[Assertions](./assertions.md)** — all ten check types, what each is for.
5. **[CLI reference](./cli.md)** — commands, flags, and what the exit codes mean.
6. **[How it works](./concepts.md)** — caching, cost, errored-vs-failed, providers, the run pipeline.

> **Looking for *contributor* / internal docs?** See the platform repository — its `.claude/docs/` holds the SDLC-Kit docs, and
> the ADRs under `docs/adr/`. The normative specs live in `AiDocs/`. This guide is for
> people *using* the `plune` CLI.

> **Status (v0.1):** `plune init`, `plune run`, and `plune report` all work. `plune run` prints a
> console report and supports `--format console|json|markdown` and `-o`; the full result is saved to
> `.plune/last-run.json`.

*(This folder is ready to become a Docusaurus site later — each page is a standalone Markdown doc.)*
