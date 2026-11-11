// The MCP self-check step of CI (.github/workflows/ci.yml), run here the way the step runs it: scripts/mcp-self-check.mjs,
// which runs `plune mcp lint`, `plune mcp check` and `plune mcp conformance` from the built binary. Against the built
// `plune mcp serve` it is green and keeps a known token out of everything it writes; against a broken server, one that
// cannot start and one with no tools it is red, so the step cannot be green on nothing.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url)); // src/mcp/__tests__
const root = path.join(here, '..', '..', '..');
const cli = path.join(root, 'dist', 'cli.cjs');
const script = path.join(root, 'scripts', 'mcp-self-check.mjs');
const fixture = path.join(root, 'src', 'mcp-testing', '__tests__', 'fixtures', 'self-check-server.mjs');

/** Made up; it must never come back out of any command. */
const TOKEN = 'plt_selfcheck_never_printed_51c8e2';

let dir = '';

beforeAll(() => {
  if (!fs.existsSync(cli))
    throw new Error(
      'dist/cli.cjs not found — run `pnpm test:e2e` (it builds first), not plain vitest.',
    );
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-mcp-self-check-'));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** This environment without anything exported for Plune or a provider key, plus `extra`. */
function env(extra: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !k.startsWith('PLUNE_') && !/_API_KEY$/i.test(k)) out[k] = v;
  return { ...out, ...extra };
}

let runs = 0;

/** The step against `server` (connection flags, `--`, the command), its reports read back. */
function step(server: string[], processEnv: Record<string, string>) {
  const out = path.join(dir, `run-${++runs}`);
  const r = spawnSync(process.execPath, [script, out, ...server], {
    env: env(processEnv),
    encoding: 'utf8',
    timeout: 60_000,
  });
  const read = (name: string) => {
    const file = path.join(out, name);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  };
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    lint: read('lint.xml'),
    check: read('check.xml'),
    conformance: read('conformance.json'),
  };
}

const ourServer = (serverEnv: string[]) => [
  ...serverEnv.flatMap((e) => ['--env', e]),
  '--',
  process.execPath,
  cli,
  'mcp',
  'serve',
];
const fixtureServer = (mode: string) => ['--env', 'PLUNE_TOKEN', '--', process.execPath, fixture, mode];
const failedConformance = (json: string | null) =>
  (JSON.parse(json ?? '{}') as { summary?: { failed?: string[] } }).summary?.failed;

describe('CLI · mcp self-check step · lint, check and conformance against the built plune mcp serve', () => {
  it('CLI · mcp self-check step · green on our server, every report written, and the token in no stdout, stderr or report', () => {
    // An address that leads nowhere, as in CI: listing the tools needs no platform. No stored login either (the temp
    // folder holds none), so exit 0 also proves the token reached the server: without one it exits 2 before it answers.
    const r = step(ourServer(['PLUNE_TOKEN', 'PLUNE_API_URL', `XDG_CONFIG_HOME=${dir}`]), {
      PLUNE_TOKEN: TOKEN,
      PLUNE_API_URL: 'http://127.0.0.1:9',
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.lint).toContain('<testcase');
    expect(r.check).toContain('<testcase');
    expect(failedConformance(r.conformance)).toEqual([]);
    for (const text of [r.stdout, r.stderr, r.lint, r.check, r.conformance]) expect(text ?? '').not.toContain(TOKEN);
  });

  it('CLI · mcp self-check step · a broken server is red in each command: a failed case in both JUnit files and a failed conformance check', () => {
    const r = step(fixtureServer('broken'), { PLUNE_TOKEN: TOKEN });
    expect(r.status, r.stderr).toBe(1);
    for (const command of ['lint', 'check', 'conformance']) expect(r.stdout).toContain(`plune mcp ${command}: exit 1,`);
    expect(r.lint).toMatch(/<testcase[^>]*name="name-duplicate"[^>]*>\s*<failure/);
    expect(r.lint).toMatch(/<testcase[^>]*name="input-schema-not-object"[^>]*>\s*<failure/);
    expect(r.check).toMatch(/<testcase[^>]*name="ping"[^>]*>\s*<failure/);
    expect(failedConformance(r.conformance)).toContain('life-ping-empty-result');
  });

  it('CLI · mcp self-check step · a server that cannot start is exit 2, and the token it prints is masked', () => {
    const r = step(fixtureServer('crash'), { PLUNE_TOKEN: TOKEN });
    expect(r.status, r.stderr).toBe(2);
    expect(r.stdout).toContain('plune mcp lint: exit 2,');
    expect(r.check).toContain('<failure');
    for (const text of [r.stdout, r.stderr, r.lint, r.check, r.conformance]) expect(text ?? '').not.toContain(TOKEN);
  });

  it('CLI · mcp self-check step · our server without a token or a login cannot start: exit 2', () => {
    expect(step(ourServer([`XDG_CONFIG_HOME=${dir}`]), {}).status).toBe(2);
  });

  it('CLI · mcp self-check step · an empty tools/list is exit 3: nothing measured is not clean', () => {
    const r = step(fixtureServer('empty'), { PLUNE_TOKEN: TOKEN });
    expect(r.status, r.stderr).toBe(3);
    expect(r.lint).toContain('type="could-not-run"');
  });

  it('CLI · mcp self-check step · a provider key in the environment stops it before any server starts', () => {
    const r = step(fixtureServer('empty'), { PLUNE_TOKEN: TOKEN, OPENAI_API_KEY: 'sk-never-used' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('OPENAI_API_KEY');
    expect(r.stderr).not.toContain('sk-never-used');
    expect(r.lint).toBeNull();
  });
});
