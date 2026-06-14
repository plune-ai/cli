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
