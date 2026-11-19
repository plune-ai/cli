# Client configuration corpus

Fixtures and a measure for the `scan/cfg/*` rules of `plune mcp scan`, which read the MCP configuration files of
clients.

- `malicious/` holds client files as text (`<id>.config.txt`) with an expectation file (`{ rule, path }` pairs, where
  the fixture came from, and what the scanner must say it did not check). `benign/` holds ordinary client files, some
  of which set rules off legitimately.
- Tokens are never stored: a placeholder is expanded at run time to a fake value of the right format.
- The share of fixtures found is **fixture recall**: the fixtures are written by the authors of the rules, so it says
  the rules still find what they were written to find, not what share of real configurations at risk they would find.
- A unit is a server entry. Everything is `synthetic` so far: there are no real client files, so no rule is eligible
  for the gate.
- `report.json` is the full measure, `baseline.json` the thresholds a later measure may not make worse.

Update after a deliberate change (refused in CI):

```
PLUNE_CORPUS_UPDATE=1 CORPUS_COMMIT=<sha> CORPUS_DATE=<yyyy-mm-dd> node node_modules/vitest/vitest.mjs run src/mcp-testing/scan/__tests__/corpus-config.test.ts
```

## Measured

<!-- cfg-table:start -->
| rule | fixture recall (found / fixtures) | false findings, real (server entries) | false findings, synthetic (server entries) | gate |
| --- | --- | --- | --- | --- |
| scan/cfg/auto-confirm | 3 / 3 | 0 (0) | 10 (39) | not eligible: not enough real units (0 of 385) |
| scan/cfg/broad-filesystem-root | 5 / 6 | 0 (0) | 0 (39) | not eligible: class heuristic; not enough real units (0 of 385); missed fixtures |
| scan/cfg/download-to-shell | 5 / 6 | 0 (0) | 0 (39) | not eligible: class heuristic; not enough real units (0 of 385); missed fixtures |
| scan/cfg/env-file-not-read | 3 / 3 | 0 (0) | 1 (39) | not eligible: not enough real units (0 of 385) |
| scan/cfg/foreign-host | 4 / 4 | 0 (0) | 0 (5) | not eligible: not enough real units (0 of 385) |
| scan/cfg/http-plaintext | 4 / 4 | 0 (0) | 0 (39) | not eligible: not enough real units (0 of 385) |
| scan/cfg/invalid-entry | 6 / 6 | 0 (0) | 0 (39) | not eligible: not enough real units (0 of 385) |
| scan/cfg/package-not-allowed | 4 / 4 | 0 (0) | 0 (3) | not eligible: not enough real units (0 of 385) |
| scan/cfg/secret-by-name | 4 / 5 | 0 (0) | 2 (39) | not eligible: class heuristic; not enough real units (0 of 385); missed fixtures |
| scan/cfg/secret-in-url | 5 / 5 | 0 (0) | 0 (39) | not eligible: not enough real units (0 of 385) |
| scan/cfg/secret-known-format | 12 / 12 | 0 (0) | 0 (39) | not eligible: not enough real units (0 of 385) |
| scan/cfg/shell-command | 6 / 6 | 0 (0) | 3 (39) | not eligible: not enough real units (0 of 385) |
| scan/cfg/unpinned-package | 6 / 6 | 0 (0) | 0 (39) | not eligible: not enough real units (0 of 385) |

What the scanner must say it did not check: reported 8 of 8.
<!-- cfg-table:end -->
