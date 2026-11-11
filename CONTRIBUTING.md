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

## Testing the MCP server

`plune mcp serve` serves the tool contract in `src/mcp-tools/contract.ts`, and the platform's built-in
agent imports the same contract from `@plune-ai/cli/mcp-tools`, so a change to it reaches both. Three
tests guard what a client is shown. They run in `pnpm test`, and each checks every list a client can
see: both protocol eras, a write and a read token, before and after `plune_discover_tools`.

| Test | File in `src/mcp-testing/__tests__/` | Fails when |
| --- | --- | --- |
| Lint | `plune-tools-contract.test.ts` | a list has a deterministic error or warning of the `plune mcp lint` rules. Heuristic findings are printed, not failed. An accepted finding goes into `plune-tools.lint-exceptions.ts` with a reason; an exception that matches nothing fails too. |
| Snapshot | `plune-tools-snapshot.test.ts` | the live `tools/list` differs in anything from `contracts/plune-mcp-tools.snapshot.json`: a name, a description, a parameter, an `enum`, an annotation. |
| Budget | `plune-tools-budget.test.ts` | a list, the biggest tool or the answer of a main read tool is over its limit in `src/mcp-testing/lint/thresholds.ts`, or so far under it that the limit is loose. |

Run the three:

```bash
pnpm exec vitest run src/mcp-testing/__tests__/plune-tools-contract.test.ts src/mcp-testing/__tests__/plune-tools-snapshot.test.ts src/mcp-testing/__tests__/plune-tools-budget.test.ts
```

**A contract change is meant.** Rewrite the snapshot, read the changes it prints (each one breaking,
non-breaking or informational, with a reason), and commit the file with the change:

```bash
UPDATE_MCP_SNAPSHOT=1 pnpm exec vitest run src/mcp-testing/__tests__/plune-tools-snapshot.test.ts
```

Nothing else writes the file. On a pull request CI writes the same classified changes into the run
summary. A breaking change (a tool removed or renamed, a new required parameter, a narrower `enum`)
breaks the clients and the platform's agent alike: say so in `CHANGELOG.md`.

**The server itself, end to end.** This builds `dist/` and talks to the binary over stdio, as a client
of each protocol era does:

```bash
pnpm build && pnpm exec vitest run -c vitest.e2e.config.ts src/mcp/__tests__/serve-stdio.e2e.test.ts
```

`pnpm test:e2e` runs it with the rest of the end-to-end suite.

**CI checks the server with our own MCP commands.** Right after `Build`, the step «MCP — self-checks
against the built server» runs `scripts/mcp-self-check.mjs`: `plune mcp lint`, `plune mcp check` (static:
no tool is called) and `plune mcp conformance` against the built `plune mcp serve`, with a made-up
`PLUNE_TOKEN` and a platform address that leads nowhere, so it needs no secret and no network. The two
JUnit files and the conformance JSON are kept as the `mcp-self-check-junit` artifact. The same script runs
nightly in `mcp-self-check-report.yml`, which imports the JUnit into Plune. The script stops at once when a
`*_API_KEY` variable is set, because no model may be reached; unset it for the local run. After `pnpm build`
(Git Bash on Windows):

```bash
PLUNE_TOKEN=local-placeholder PLUNE_API_URL=http://127.0.0.1:9 node scripts/mcp-self-check.mjs .plune/mcp-reports \
  --env PLUNE_TOKEN --env PLUNE_API_URL -- node dist/cli.cjs mcp serve
```

`src/mcp/__tests__/self-check.e2e.test.ts` (part of `pnpm test:e2e`) runs the same script against a
broken server, one that cannot start and one with no tools, and expects it red each time.

When the step is red, read the exit code first: the script ends with the first non-zero one and prints
each command's code. `1`: a finding at the error level (the lint prints the rule, the tool and the fix),
a failed health check or a failed `MUST` conformance check; fix the tool in `src/mcp-tools/contract.ts`,
the same change the lint test above asks for, or the server in `src/mcp/`. `2`: the server did not start
or answer; its stderr tail is in the step log. `3`: nothing was measured, for example an empty tool list;
that is never a pass. Do not add an exception to make the step green unless the finding is wrong, and
then with its reason.

**The budget test is red.** Its message names the list and its biggest tools. Make the tool smaller
first: a description that repeats its schema, a nested schema that could be flatter. Raise a limit only
when the growth is meant, such as a new tool, and by the rule written in `thresholds.ts` (the measure
plus 10%, rounded up, with the date of the measure). A limit far above the measure fails as well: when a
list shrinks, lower its limit by the same rule.

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
- The tool table and the numbers on the [MCP page](https://docs.plune.ai/cli/guides/mcp/), when the
  tool contract or its budget changed since the last tag. No test compares them with the contract:
  `git diff "$(git describe --tags --abbrev=0)" --stat -- contracts/ src/mcp-testing/lint/thresholds.ts`
  shows whether they need a look.

## Security

Please report vulnerabilities privately — see [SECURITY.md](./SECURITY.md). Do not open a
public issue for a security problem.
