# JUnit reports of `plune mcp`

Each `.xml` here is what `plune mcp lint`, `check`, `diff` or `conformance` wrote with `--reporter junit-xml --out
<file>`, run through the real command line (`src/cli.ts`) against the fixture servers of the folder above
(`lint-server.mjs`, `check-server.mjs`, `snapshot-server.mjs`, `conformance-server.mjs`). None is written by hand.
`generate.ts` lists every file, what it shows and the arguments that write it.

Write them again after a change to the report formats, the lint rules or the checks:

```bash
node node_modules/tsx/dist/cli.mjs src/mcp-testing/__tests__/fixtures/reports/generate.ts
```

It prints the exit code of each run to stderr. With no change to the code it writes the same bytes, and the test
`CLI · mcp report · the fixtures are what the commands write today` holds it to that: it generates them into a
temporary folder and compares.

What keeps them stable:

- `classname` is `mcp.<command>` and `name` the id of the check (a rule id for `lint`, a check id for `check`, one of
  `breaking-changes`, `contract-changes`, `unclassified-changes`, `security-signals` for `diff`): no count, server name, version or time;
  for `conformance` `classname` is `mcp.conformance.<suite>` and `name` the id of the check in the catalog;
- the suite has no `timestamp`;
- `time` (how long a check of `check` took) is the one field two runs differ in, and the script removes the attribute
  from every case. Nothing else is changed.

`golden-v1/` holds the JSON document of each command at `schemaVersion` 1 (the check's timing set to zero). The test
`CLI · mcp report · each command prints one document with kind …` compares a live run with it field by field; after a
deliberate addition of a field, write them again with `PLUNE_UPDATE_GOLDEN=1` set for that test, then format
them with prettier (the repository checks the formatting of JSON files).
