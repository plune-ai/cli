# Description corpus

Fixtures and a measure for the `scan/desc/*` rules of `plune mcp scan`, which read the texts of one server's tool,
prompt and resource lists. The client configuration rules have their own corpus in `config/`, the cross-server rules
in `cross/`.

- `malicious/` holds, per fixture, a snapshot and an expectation file (`{ rule, pointer }` pairs, where the fixture
  came from, and its `concealment`: `hidden`, `explicit`, `reworded` or `other-language`). `benign/` holds ordinary
  tool lists, each `origin: real` (published servers, listed in `SOURCES.json` and `THIRD_PARTY_NOTICES`) or
  `origin: synthetic` (written here).
- The share of fixtures found is **fixture recall**: the fixtures are written by the authors of the rules, so it says
  the rules still find what they were written to find, not what share of real attacks they would find.
- The false findings on real descriptions are the honest number. They are counted on the fields called `description`
  alone; the Wilson upper 95 % bound is read on those, and a rule needs 385 real description fields to be eligible for
  the gate.
- Hidden characters are stored as JSON unicode escapes, never raw.
- `report.json` is the full measure, `baseline.json` the thresholds a later measure may not make worse.

Update after a deliberate change (refused in CI):

```
PLUNE_CORPUS_UPDATE=1 CORPUS_COMMIT=<sha> CORPUS_DATE=<yyyy-mm-dd> node node_modules/vitest/vitest.mjs run src/mcp-testing/scan/__tests__/corpus.test.ts
```

## Measured

<!-- desc-table:start -->
| rule | fixture recall (found / fixtures) | false findings, real (description fields) | Wilson upper 95 %, real | false findings, synthetic (description fields) | gate |
| --- | --- | --- | --- | --- | --- |
| scan/desc/ansi-escape | 5 / 5 | 0 (1507) | 0.002543 | 0 (117) | eligible |
| scan/desc/bidi-control | 5 / 5 | 0 (1507) | 0.002543 | 0 (117) | eligible |
| scan/desc/call-other-tool-first | 4 / 5 | 0 (1507) | 0.002543 | 1 (117) | not eligible: class heuristic; missed fixtures |
| scan/desc/conceal-from-user | 4 / 5 | 0 (1507) | 0.002543 | 0 (117) | not eligible: class heuristic; missed fixtures |
| scan/desc/control-character | 4 / 4 | 0 (1507) | 0.002543 | 0 (117) | eligible |
| scan/desc/encoded-blob | 4 / 4 | 0 (1507) | 0.002543 | 1 (117) | not eligible: class measured |
| scan/desc/html-comment | 5 / 5 | 0 (1507) | 0.002543 | 1 (117) | eligible |
| scan/desc/joiner-or-direction-mark | 3 / 4 | 0 (1507) | 0.002543 | 0 (117) | not eligible: class heuristic; missed fixtures |
| scan/desc/override-instruction | 4 / 6 | 0 (1507) | 0.002543 | 0 (117) | not eligible: class heuristic; missed fixtures |
| scan/desc/oversized-text | 4 / 4 | 0 (1507) | 0.002543 | 0 (117) | not eligible: class measured |
| scan/desc/param-asks-for-context | 4 / 5 | 1 (828) | 0.006809 | 1 (57) | not eligible: class heuristic; missed fixtures |
| scan/desc/sensitive-path | 4 / 5 | 0 (1507) | 0.002543 | 3 (117) | not eligible: class heuristic; missed fixtures |
| scan/desc/tag-character | 5 / 5 | 0 (1507) | 0.002543 | 0 (117) | eligible |
| scan/desc/zero-width | 4 / 4 | 0 (1507) | 0.002543 | 0 (117) | eligible |
<!-- desc-table:end -->
