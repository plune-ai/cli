#!/usr/bin/env node
// Runs `plune mcp conformance` and the official Model Context Protocol conformance package against the same reference
// server, by hand, to see where the two disagree. Not scheduled anywhere, never part of a pull request gate and never a
// dependency of this package: the third-party code is installed into an empty folder that you give, away from this
// repository, and runs with a minimal environment (no tokens or keys of yours reach it).
//
//   node scripts/conformance-crosscheck.mjs --out <empty folder outside the repository> [--cli "plune"]
//        [--conformance 0.1.16] [--everything 2.3.0] [--revision 2025-11-25] [--port 3001]
//
// <out> gets three parts: packages/ (the third-party packages, never a working directory), work/ (an empty folder,
// the working directory of every process this script starts) and the results: run-ours.json (our result), official/
// (the checks.json of every scenario of the official suite), official.txt (what it printed) and versions.json.
// Both sides check the same revision (--revision): the official suite knows only the legacy ones, and our command
// would otherwise pick the newest one the server answers. The exit code is that of our run, read without a pipe. It
// refuses (exit 2 for the arguments, 1 for the server) when the folder is not empty or lies in the repository, a
// version is not exact, the port is taken, or the server stops. Read both results by hand and write down each
// disagreement in docs/conformance-crosscheck.md: date, versions, both verdicts, who is right, the sentence of the
// specification. The arguments of the official suite are taken from its own `list` output, which this script prints.

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

/** A revision as the specification names it: a date. */
export const exactRevision = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v);

/**
 * Every process the run starts, with its working directory: always `<dir>/work`, never the folder of the packages.
 * `cli` is our command split into words, `node` the interpreter of the third-party scripts.
 */
export function plan(dir, { cli, node, url, revision, conformance, everything }) {
  const packages = join(dir, 'packages');
  const work = join(dir, 'work');
  const pkg = (name, ...rest) => join(packages, 'node_modules', '@modelcontextprotocol', name, ...rest);
  const official = pkg('conformance', 'dist', 'index.js');
  return {
    packages,
    work,
    // Exact versions, and the install scripts of the packages not run.
    install: {
      cmd: 'npm',
      args: [
        'install', '--prefix', packages, '--ignore-scripts', '--no-audit', '--no-fund',
        `@modelcontextprotocol/conformance@${conformance}`,
        `@modelcontextprotocol/server-everything@${everything}`,
      ],
      cwd: work,
    },
    server: { cmd: node, args: [pkg('server-everything', 'dist', 'index.js'), 'streamableHttp'], cwd: work },
    ours: {
      cmd: cli[0],
      args: [...cli.slice(1), 'mcp', 'conformance', '--suite', 'protocol', '--url', url, '--protocol-version', revision,
        '--format', 'json', '--out', join(dir, 'run-ours.json')],
      cwd: work,
    },
    list: { cmd: node, args: [official, 'list', '--server'], cwd: work },
    official: {
      cmd: node,
      args: [official, 'server', '--url', url, '--suite', 'all', '--spec-version', revision, '-o', join(dir, 'official')],
      cwd: work,
    },
  };
}

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
  const revision = opt('revision', '2025-11-25');
  const port = opt('port', '3001');
  if (![conformance, everything].every(exactVersion)) stop('--conformance and --everything take an exact version such as 1.2.3.', 2);
  if (!exactRevision(revision)) stop('--revision takes a revision of the specification such as 2025-11-25.', 2);
  if (!/^\d{1,5}$/.test(port)) stop('--port takes a port number.', 2);
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const problem = folderProblem(out, repo);
  if (problem !== undefined) stop(`--out must be an empty folder outside the repository: ${problem}.`, 2);
  const dir = realTarget(out);
  const url = `http://127.0.0.1:${port}/mcp`;
  const p = plan(dir, { cli: opt('cli', 'plune').split(' '), node: process.execPath, url, revision, conformance, everything });
  mkdirSync(p.work, { recursive: true });
  mkdirSync(p.packages, { recursive: true });

  const env = minimalEnv(process.env);
  // On Windows npm is a .cmd file and needs a shell, which joins the arguments as text: quote the ones with a space.
  const win = process.platform === 'win32';
  const quote = (a) => (win && /[\s&|<>^()]/.test(a) ? `"${a.replaceAll('"', '')}"` : a);
  const run = ({ cmd, args: argv, cwd }) => spawnSync(quote(cmd), argv.map(quote), { cwd, encoding: 'utf8', shell: win, env });

  const install = run(p.install);
  if (install.status !== 0) stop(install.stderr, 1);
  writeFileSync(join(dir, 'versions.json'), JSON.stringify({ conformance, everything, revision, node: process.version }, null, 2));

  if (await open(Number(port))) stop(`Port ${port} is already taken: nothing of ours may answer for the server under test.`, 1);
  const server = spawn(p.server.cmd, p.server.args, {
    cwd: p.server.cwd,
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
    const ours = run(p.ours);
    console.log(run(p.list).stdout);
    const official = run(p.official);
    writeFileSync(join(dir, 'official.txt'), `${official.stdout}\n${official.stderr}\nexit ${official.status}\n`);
    console.log(`Ours: exit ${ours.status}, ${join(dir, 'run-ours.json')}. Official: exit ${official.status}, ${join(dir, 'official')}.`);
    process.exitCode = ours.status ?? 1;
  } finally {
    server.kill();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
