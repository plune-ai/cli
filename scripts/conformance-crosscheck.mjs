#!/usr/bin/env node
// Runs `plune mcp conformance` and the official Model Context Protocol conformance package against the same reference
// server, by hand, to see where the two disagree. Not scheduled anywhere, never part of a pull request gate and never a
// dependency of this package: the third-party code is installed into an empty folder that you give, away from this
// repository, and runs with a minimal environment (no tokens or keys of yours reach it).
//
//   node scripts/conformance-crosscheck.mjs --out <empty folder outside the repository> [--cli "plune"]
//        [--conformance 0.1.16] [--everything 2.3.0] [--port 3001]
//
// It writes into <out>: run-ours.json (our result), official.txt (what the official suite printed), versions.json.
// The exit code is that of our run, read without a pipe. It refuses (exit 2 for the arguments, 1 for the server) when
// the folder is not empty or lies in the repository, a version is not exact, the port is taken, or the server stops.
// Read both results by hand and write down each disagreement: date, versions, both verdicts, who is right, the
// sentence of the specification. The arguments of the official suite are taken from its own `list` output, which this
// script prints first.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ENV_KEYS = ['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT'];

/** The environment of a child: only what a package manager and a server need, names matched without regard to case. */
export function minimalEnv(env, extra = {}) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (ENV_KEYS.includes(k.toUpperCase()) && v !== undefined) out[k] = v;
  return { ...out, ...extra };
}

/** Only an exact version: no range, tag or path that would fetch something else. */
export const exactVersion = (v) => /^\d+\.\d+\.\d+$/.test(v);

/** The real path of a place that may not exist yet: its nearest existing ancestor resolved (a junction too), the rest appended. */
export function realTarget(p) {
  let head = resolve(p);
  const rest = [];
  while (!existsSync(head) && dirname(head) !== head) {
    rest.unshift(head.slice(dirname(head).length + 1));
    head = dirname(head);
  }
  return join(realpathSync(head), ...rest);
}

/** Why `dir` cannot be the working folder, or undefined when it can: it is in the repository, or it is not empty. */
export function folderProblem(dir, repo) {
  const target = realTarget(dir);
  const inside = relative(realTarget(repo), target);
  if (inside === '' || !(inside.startsWith('..') || isAbsolute(inside))) return `${target} is in the repository ${repo}`;
  if (existsSync(target) && readdirSync(target).length > 0) return `${target} is not empty`;
  return undefined;
}

const open = (port) =>
  new Promise((done) => {
    const s = connect({ port, host: '127.0.0.1' });
    s.once('connect', () => (s.destroy(), done(true)));
    s.once('error', () => done(false));
  });

async function main() {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
  };
  const stop = (message, code) => {
    console.error(message);
    process.exit(code);
  };
  const out = opt('out');
  if (out === undefined) stop('Usage: node scripts/conformance-crosscheck.mjs --out <empty folder outside the repository>', 2);
  const conformance = opt('conformance', '0.1.16');
  const everything = opt('everything', '2.3.0');
  const port = opt('port', '3001');
  if (![conformance, everything].every(exactVersion)) stop('--conformance and --everything take an exact version such as 1.2.3.', 2);
  if (!/^\d{1,5}$/.test(port)) stop('--port takes a port number.', 2);
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const problem = folderProblem(out, repo);
  if (problem !== undefined) stop(`--out must be an empty folder outside the repository: ${problem}.`, 2);
  const dir = realTarget(out);
  mkdirSync(dir, { recursive: true });

  const cli = opt('cli', 'plune').split(' ');
  const env = minimalEnv(process.env);
  // On Windows npm is a .cmd file and needs a shell, which joins the arguments as text: quote the ones with a space.
  const win = process.platform === 'win32';
  const quote = (a) => (win && /[\s&|<>^()]/.test(a) ? `"${a.replaceAll('"', '')}"` : a);
  const run = (cmd, argv) => spawnSync(quote(cmd), argv.map(quote), { cwd: dir, encoding: 'utf8', shell: win, env });

  // Exact versions into <out>, and the install scripts of the packages not run.
  const install = run('npm', [
    'install', '--prefix', dir, '--ignore-scripts', '--no-audit', '--no-fund',
    `@modelcontextprotocol/conformance@${conformance}`,
    `@modelcontextprotocol/server-everything@${everything}`,
  ]);
  if (install.status !== 0) stop(install.stderr, 1);
  writeFileSync(join(dir, 'versions.json'), JSON.stringify({ conformance, everything, node: process.version }, null, 2));

  if (await open(Number(port))) stop(`Port ${port} is already taken: nothing of ours may answer for the server under test.`, 1);
  const script = join(dir, 'node_modules', '@modelcontextprotocol', 'server-everything', 'dist', 'index.js');
  const server = spawn(process.execPath, [script, 'streamableHttp'], {
    cwd: dir,
    env: minimalEnv(process.env, { PORT: port, HOST: '127.0.0.1' }),
    stdio: 'ignore',
  });
  let ended = false;
  server.once('exit', () => (ended = true));
  try {
    const until = Date.now() + 30_000;
    while (!ended && Date.now() < until && !(await open(Number(port)))) await new Promise((r) => setTimeout(r, 250));
    if (ended || !(await open(Number(port)))) {
      server.kill();
      stop('The reference server stopped or did not listen within 30 s; nothing was run.', 1);
    }
    const url = `http://127.0.0.1:${port}/mcp`;
    const ours = run(cli[0], [...cli.slice(1), 'mcp', 'conformance', '--suite', 'protocol', '--url', url, '--format', 'json', '--out', join(dir, 'run-ours.json')]);
    const bin = join(dir, 'node_modules', '.bin', 'conformance');
    console.log(run(bin, ['list', '--server']).stdout);
    const official = run(bin, ['server', '--url', url]);
    writeFileSync(join(dir, 'official.txt'), `${official.stdout}\n${official.stderr}\nexit ${official.status}\n`);
    console.log(`Ours: exit ${ours.status}, ${join(dir, 'run-ours.json')}. Official: exit ${official.status}, ${join(dir, 'official.txt')}.`);
    process.exitCode = ours.status ?? 1;
  } finally {
    server.kill();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
