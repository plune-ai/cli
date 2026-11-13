# Cairn `mcp-test` run fixtures

Two real runs of `cairn mcp-test`. Only the two files `plune ingest` reads are kept (`report.json` and
`mcp-evidence.json`), copied byte for byte. Nothing was edited by hand: the runs wrote no secret, and the
absolute paths and token-like values were checked for (none) rather than removed.

- Cairn: commit `e9e40cb` (package version 0.10.0), run from source with its own `tsx`, no build.
- Date: 13 November 2026.
- Server: a small stdio MCP server written for Cairn's own tests, which answers `tools/call` as the test
  chooses (`echo`, `typed`, `plain`, `hang`, `crash`, `shifty`). It runs on the machine only.

## `judged/`: passed, failed, needs-review, not-sent

```
cairn mcp-test --out runs/f7 \
  --env FIXTURE_ECHO=iserror --env FIXTURE_TYPED=bad \
  --allow-tools echo,typed,plain --adversarial -- node ./my-server.mjs
```

54 cases: 2 passed, 3 failed, 1 needs review, 48 not sent (the tools that were not named in `--allow-tools`).
`echo` answers every call with an `isError` result, `typed` answers with a value its `outputSchema` forbids.

## `stopped/`: passed, could-not-run, not-sent

```
cairn mcp-test --out runs/f6 --timeout 2 --allow-tools echo,hang -- node ./my-server.mjs
```

15 cases: 3 passed, 9 could not run, 3 not sent. `hang` never answers, so 3 calls in a row got no answer and the
run stopped; the other 6 `could-not-run` cases were never sent.

`--timeout 2` bounds only the handshake and list requests, so those 3 calls waited the default 30 s `--call-timeout`; the command that bounds the calls is `--call-timeout 2`. The fixture was not re-captured.
