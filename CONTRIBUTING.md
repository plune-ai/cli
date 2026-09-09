# Contributing to @plune-ai/cli

Thanks for your interest in contributing!

## Prerequisites

- Node.js ≥ 20 (`nvm use` reads `.nvmrc`)
- pnpm ≥ 8 (`npm install -g pnpm`)

## Setup

```bash
git clone https://github.com/plune-ai/cli.git
cd cli
pnpm install
pnpm test
```

## Development

```bash
pnpm dev          # run the CLI from source (tsx)
pnpm test:watch   # unit tests in watch mode
pnpm test         # unit tests + coverage
pnpm test:e2e     # build, then run the end-to-end suite against the binary
pnpm lint         # ESLint
pnpm typecheck    # tsc --noEmit
pnpm build        # build dist/ with tsup
```

## Tests first

New features and bug fixes come with tests. We follow Red → Green → Refactor: write a
failing test that captures the behaviour, make it pass, then refactor. Coverage is gated
per file in CI, so a new module ships with its tests or it does not ship.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(run): add --only selector
fix(diff): correct exit code when the baseline is missing
docs(readme): document the json-schema assertion
```

## Pull requests

1. Fork and branch from `main`.
2. Keep the change focused; add an entry to `CHANGELOG.md` under `## [Unreleased]`.
3. Make sure `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass.
4. Open the PR with a clear description of **what** changed and **why**.

## Releasing

A release is a pushed tag; CI does the rest.

```bash
npm version 0.9.2 && git push --follow-tags
```

The tag is the authority for the version - `publish.yml` sets `package.json` from it, runs the
same checks as CI, and publishes to npm and GitHub Packages. Nothing is published from a laptop.

**Before the tag, answer one question: what does this release make untrue?** A release moves the
product; public text does not move with it. Four separate paragraphs went stale that way, and no
gate caught any of them, because a sentence that *was* true does not look broken:

- `README.md` - it is also the npm package page, so it is public the moment you publish.
- The pages under `docs.plune.ai` - the guides, and the commands table in *Getting started*.
- A brand-new command needs a page, not just a `--help` line.

## Security

Please report vulnerabilities privately — see [SECURITY.md](./SECURITY.md). Do not open a
public issue for a security problem.
