#!/usr/bin/env node
// The MCP self-check step of CI (ci.yml and mcp-self-check-report.yml): `plune mcp lint`, `plune mcp check` (static,
// no tool is called) and `plune mcp conformance` from the built binary, against the server the arguments name.
//
//   node scripts/mcp-self-check.mjs <report-dir> [connection flags] -- <server command>
//
// lint and check write JUnit (lint.xml, check.xml), conformance its JSON result and JUnit (conformance.json,
// conformance.xml), so the nightly import reads all three. All three run even
// when one is red, so every report is written; the exit code is the first non-zero one, in that order (1 a finding or
// a failed check, 2 the server did not start, 3 nothing measured, such as an empty tool list). No model is called: the
// step refuses to run while a provider key is set.

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../dist/cli.cjs', import.meta.url));
// The one tool conformance calls, for the checks of a tool's result: plune_discover_tools answers locally, with no
// platform and no write. A server that does not list it (the test fixtures) is simply not called.
const fixture = fileURLToPath(new URL('./mcp-self-check.fixture.json', import.meta.url));
const [dir, ...server] = process.argv.slice(2);
if (!dir || server.length === 0) {
  console.error('usage: node scripts/mcp-self-check.mjs <report-dir> [connection flags] -- <server command>');
  process.exit(2);
}

const keys = Object.keys(process.env).filter((name) => /_API_KEY$/i.test(name));
if (keys.length > 0) {
  console.error(`A model provider key is set in this step: these checks must not reach a model (${keys.join(', ')}).`);
  process.exit(1);
}

mkdirSync(dir, { recursive: true });
const commands = [
  ['lint', '--reporter', 'junit-xml', '--out', join(dir, 'lint.xml')],
  ['check', '--reporter', 'junit-xml', '--out', join(dir, 'check.xml')],
  ['conformance', '--fixture', fixture, '--out', join(dir, 'conformance.json'), '--out', `junit-xml=${join(dir, 'conformance.xml')}`],
];

let status = 0;
const started = Date.now();
for (const [command, ...flags] of commands) {
  const t = Date.now();
  const r = spawnSync(process.execPath, [cli, 'mcp', command, ...flags, ...server], { stdio: 'inherit' });
  const code = r.status ?? 1;
  console.log(`plune mcp ${command}: exit ${code}, ${Date.now() - t} ms`);
  if (status === 0) status = code;
}
console.log(`MCP self-checks: exit ${status}, ${Date.now() - started} ms`);
process.exit(status);
