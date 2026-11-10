// The MCP self-check step of CI (.github/workflows/ci.yml), run here the way the step runs it: `plune mcp lint` and
// `plune mcp check` from the built binary against the built `plune mcp serve`, a JUnit file each. What the commands
// make of a broken server is proven on the fixture servers (src/mcp-testing/__tests__/); this file proves the step's
// own command line: it is green on this server, it keeps a known token out of everything it writes, and it is red when
// the server cannot start.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url)); // src/mcp/__tests__
const cli = path.join(here, '..', '..', '..', 'dist', 'cli.cjs');

/** Made up; it must never come back out of either command. */
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

/** This environment without anything exported for Plune, plus `extra`. */
function env(extra: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !k.startsWith('PLUNE_')) out[k] = v;
  return { ...out, ...extra };
}

/** `plune mcp <command>` with a JUnit file, against `plune mcp serve` given `serverEnv` (each `--env` entry). */
function selfCheck(
  command: 'lint' | 'check',
  serverEnv: string[],
  processEnv: Record<string, string>,
) {
  const report = path.join(dir, `${command}-${serverEnv.length}.xml`);
  const r = spawnSync(
    process.execPath,
    [
      cli,
      'mcp',
      command,
      '--reporter',
      'junit-xml',
      '--out',
      report,
      ...serverEnv.flatMap((e) => ['--env', e]),
      '--',
      process.execPath,
      cli,
      'mcp',
      'serve',
    ],
    { env: env(processEnv), encoding: 'utf8', timeout: 30_000 },
  );
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    report: fs.existsSync(report) ? fs.readFileSync(report, 'utf8') : null,
  };
}

describe('CLI · mcp lint, mcp check · the CI self-check step against the built plune mcp serve', () => {
  it('CLI · mcp lint, mcp check · green on our server, a JUnit file each, and the token in no stdout, stderr or report', () => {
    // An address that leads nowhere, as in CI: listing the tools needs no platform.
    const processEnv = { PLUNE_TOKEN: TOKEN, PLUNE_API_URL: 'http://127.0.0.1:9' };
    for (const command of ['lint', 'check'] as const) {
      // No stored login either (the temp folder holds none), so exit 0 also proves the token reached the server:
      // without one `plune mcp serve` exits 2 before it answers.
      const r = selfCheck(
        command,
        ['PLUNE_TOKEN', 'PLUNE_API_URL', `XDG_CONFIG_HOME=${dir}`],
        processEnv,
      );
      expect(r.status, `${command}: ${r.stderr}`).toBe(0);
      expect(r.report).toContain('<testcase');
      for (const text of [r.stdout, r.stderr, r.report ?? '']) expect(text).not.toContain(TOKEN);
    }
  });

  it('CLI · mcp lint, mcp check · a server that cannot start (no token, no stored login) makes both red', () => {
    const lint = selfCheck('lint', [`XDG_CONFIG_HOME=${dir}`], {});
    expect(lint.status, lint.stderr).toBe(2);
    const check = selfCheck('check', [`XDG_CONFIG_HOME=${dir}`], {});
    expect(check.status, check.stderr).toBe(1);
    expect(check.report).toContain('<failure');
  });
});
