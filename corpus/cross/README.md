# Cross-server corpus

Fixtures and a measure for the `scan/cross/*` rules of `plune mcp scan`, which look at several servers of one client
configuration together. Same honesty rules as the other two corpora.

- A unit is a **group** of two or more server snapshots (`<id>.group.json`, `{"servers": {label: {tools, prompts,
  resources, instructions}}}`; the loader builds the snapshots and keeps the order and indexes of the tools).
- `malicious/` holds groups where a rule should fire (`<id>.expected.json`: origin, provenance, and the findings
  expected as rule, server label and pointer). `benign/` holds ordinary groups (`<id>.meta.json`), some of which
  legitimately share or resemble names.
- This measures **recall on fixtures written here**, and the false findings on ordinary groups written here. It is not
  the share of real attacks the rules find, and not the false-alarm rate on real configurations.
- In "found / expected", "expected" counts the designed misses too, so a rule that finds every fixture that is not a
  designed miss still reads below `n / n`.
- A false finding sits on one tool, but the rate in `report.json` is divided by tool pairs (a tool of one server with
  a tool of another): it is findings per pair, not the share of tools that are wrongly flagged. Per group is the
  clearer number; the table shows the counts.
- Everything is `synthetic`: written for this corpus, `source: not verified`, no text copied from a real server. There
  are no real units, so no rule is gate eligible.
- A **designed miss** is an expectation a rule is known not to meet (case, hidden-character, homoglyph, separator,
  paraphrase and encoding variants). It carries its reason, counts as missed in the table, and the control test fails
  if a rule starts finding it, so an improvement is a decision to record in the baseline.
- False findings are counted per group and per tool pair (a tool of one server with a tool of another), `real` and
  `synthetic` apart. The false findings in the table are measured, not fixed: they show where the rules are noisy.
- Hidden characters are stored as JSON unicode escapes, never raw.
- `report.json` is the full measure, `baseline.json` the thresholds a later measure may not make worse.

Update after a deliberate change (refused in CI):

```
PLUNE_CORPUS_UPDATE=1 CORPUS_COMMIT=<sha> CORPUS_DATE=<yyyy-mm-dd> node node_modules/vitest/vitest.mjs run src/mcp-testing/scan/__tests__/corpus-cross.test.ts
```

## Measured

<!-- cross-table:start -->
| rule | found / expected (designed misses included) | designed misses | false findings (synthetic) | groups | tool pairs (denominator of the rate in report.json) | gate |
| --- | --- | --- | --- | --- | --- | --- |
| scan/cross/duplicate-tool-name | 5 / 9 | 4 | 7 (in 4 groups) | 12 | 48 | not eligible |
| scan/cross/foreign-tool-reference | 7 / 13 | 6 | 1 (in 1 group) | 12 | 48 | not eligible |
<!-- cross-table:end -->
