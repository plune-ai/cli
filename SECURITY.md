# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities **privately** — do not open a public issue.

Use GitHub's private vulnerability reporting on this repository: open the
[**Security**](https://github.com/plune-ai/cli/security/advisories/new) tab and choose
**Report a vulnerability**. We aim to acknowledge new reports within a few business days.

## Scope

- The `@plune-ai/cli` npm package and the `plune` binary
- `plune.yaml` configuration parsing and loading

## Out of scope

- Vulnerabilities in third-party dependencies — please report those to the upstream project
- Issues that require local access to a machine already running the CLI
- Costs incurred by calling a real model provider (configure `--dry-run` / the mock provider
  to evaluate without spending)

## Running the CLI on a project you did not write

`plune.yaml` is code, not data: treat a project's config the way you treat its build scripts.

- A stdio server in `mcp.servers.<name>` (`command`, `args`, `env`) is started as a process on your machine by the
  `plune mcp` commands that reach it. A `plune.yaml` from an untrusted source therefore means running its code as you.
  Read it before running `plune mcp` in that project.
- `plune automate` starts Cairn (from `PATH`, or the path given with `--cairn`) in the project directory (`--repo`,
  default the current one), where Cairn reads that project's `.env`, `knowledge/` and `.auth/`. On Windows a `.cmd`
  or `.bat` shim is started through `cmd.exe`, with every argument quoted.
- Before Cairn starts, its environment loses every `PLUNE_*` variable and every value that contains your Plune token,
  and it gets a filtered copy of the project's `.env` instead of the original. That filter works line by line: a line
  whose key starts with `PLUNE_`, or which contains the token, is dropped. A multi-line quoted value keeps its
  continuation lines, so keep the token on one line and out of multi-line values.
