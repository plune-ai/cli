#!/usr/bin/env node
// Runs `plune mcp conformance` and the official Model Context Protocol conformance package against the same reference
// server, by hand or at night, to see where the two disagree. Never part of a pull request gate and never a dependency
// of this package: the third-party code is installed into an empty folder that you give, away from this repository.
//
//   node scripts/conformance-crosscheck.mjs --out <empty folder outside the repository> [--cli "plune"]
//        [--conformance 0.1.16] [--everything 2.3.0] [--port 3001]
//
// It writes into <out>: run-ours.json (our result), official.txt (what the official suite printed), versions.json.
// The exit code is that of our run, read without a pipe. Read both results by hand and record each disagreement in
// docs/conformance-crosscheck.md (date, versions, both verdicts, who is right, the sentence of the specification).
// Not run in the repository's own checks; the arguments of the official suite are taken from its own `list` output,
// which this script prints first.

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const out = opt('out');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (out === undefined) {
  console.error('Usage: node scripts/conformance-crosscheck.mjs --out <empty folder outside the repository>');
  process.exit(2);
}
const dir = resolve(out);
mkdirSync(dir, { recursive: true });
const inside = relative(repo, dir);
if (readdirSync(dir).length > 0 || inside === '' || !(inside.startsWith('..') || isAbsolute(inside))) {
  console.error(`${dir} must be an empty folder outside ${repo}.`);
  process.exit(2);
}
const conformance = opt('conformance', '0.1.16');
const everything = opt('everything', '2.3.0');
const port = opt('port', '3001');
const cli = opt('cli', 'plune').split(' ');
const sh = process.platform === 'win32';
const run = (cmd, argv, o = {}) => spawnSync(cmd, argv, { cwd: dir, encoding: 'utf8', shell: sh, ...o });

// Exact versions, scripts of the packages not run at install.
const install = run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', `@modelcontextprotocol/conformance@${conformance}`, `@modelcontextprotocol/server-everything@${everything}`]);
if (install.status !== 0) {
  console.error(install.stderr);
  process.exit(1);
}
writeFileSync(join(dir, 'versions.json'), JSON.stringify({ conformance, everything, node: process.version }, null, 2));

const server = spawn(process.execPath, [join(dir, 'node_modules', '@modelcontextprotocol', 'server-everything', 'dist', 'index.js'), 'streamableHttp'], {
  cwd: dir,
  env: { ...process.env, PORT: port, HOST: '127.0.0.1' },
  stdio: 'ignore',
});
try {
  await new Promise((r) => setTimeout(r, 3000));
  const url = `http://127.0.0.1:${port}/mcp`;
  const ours = run(cli[0], [...cli.slice(1), 'mcp', 'conformance', '--suite', 'protocol', '--url', url, '--format', 'json', '--out', join(dir, 'run-ours.json')]);
  const bin = join(dir, 'node_modules', '.bin', 'conformance');
  const list = run(bin, ['list', '--server']);
  console.log(list.stdout);
  const official = run(bin, ['server', '--url', url]);
  writeFileSync(join(dir, 'official.txt'), `${official.stdout}\n${official.stderr}\nexit ${official.status}\n`);
  console.log(`Ours: exit ${ours.status}, ${join(dir, 'run-ours.json')}. Official: exit ${official.status}, ${join(dir, 'official.txt')}.`);
  process.exitCode = ours.status ?? 1;
} finally {
  server.kill();
}
