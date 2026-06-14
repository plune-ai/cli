// END-TO-END for the GitHub Action's core invocation (`plune diff`) against the REAL built binary
// (dist/cli.cjs), driven via child_process. Run with `pnpm test:e2e` (builds first); excluded from
// the default unit run. Proves the chain the composite Action relies on (ADR-GA01/GA03): a real
// `plune run --format json` output is diff-consumable, and `plune diff` emits the sticky-marked
// markdown + the right exit codes — all offline on the mock provider (AC-1/2/4/5).

import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunResult, EvalResult } from '../../types/results.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');
const cli = path.join(root, 'dist', 'cli.cjs');

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): CliResult {
  const res = spawnSync(process.execPath, [cli, ...args], {
    cwd: opts.cwd ?? root,
    env: { ...process.env, ...opts.env },
    encoding: 'utf8',
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

// Rewrite an eval's outcome so we can manufacture a deterministic pass→fail regression.
function forcePassed(ev: EvalResult, passed: boolean): void {
  ev.passed = passed;
  ev.rows = ev.rows.map((r) => ({ ...r, error: undefined, assertions: [{ type: 'exact-match', passed }] }));
}

describe('plune diff binary (GitHub Action core) — e2e on mock', () => {
  let tmp: string;
  let baseline: string;
  let current: string;

  beforeAll(() => {
    if (!fs.existsSync(cli)) {
      throw new Error('dist/cli.cjs not found — run `pnpm test:e2e` (it builds first), not plain vitest.');
    }
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-ga-e2e-'));
    runCli(['init', '--yes'], { cwd: tmp });
    // A real mock run proves `plune run --format json` produces diff-consumable output.
    const run = runCli(['run', '--format', 'json', '-o', 'run.json'], {
      cwd: tmp,
      env: { PLUNE_MOCK_PROVIDER: '1' },
    });
    expect([0, 1]).toContain(run.status);
    const real = JSON.parse(fs.readFileSync(path.join(tmp, 'run.json'), 'utf8')) as RunResult;
    expect(real.evals.length).toBeGreaterThan(0);
    // Derive a green baseline and a regressed current for the SAME eval id (deterministic regression).
    const green = JSON.parse(JSON.stringify(real)) as RunResult;
    const red = JSON.parse(JSON.stringify(real)) as RunResult;
    forcePassed(green.evals[0]!, true);
    forcePassed(red.evals[0]!, false);
    baseline = path.join(tmp, 'baseline.json');
    current = path.join(tmp, 'current.json');
    fs.writeFileSync(baseline, JSON.stringify(green));
    fs.writeFileSync(current, JSON.stringify(red));
  });

  it('prints markdown with the sticky marker and exits 0 without --fail-on-regression (AC-3, AC-4.1)', () => {
    const r = runCli(['diff', baseline, current, '--format', 'markdown']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('<!-- plune-eval-diff -->');
    expect(r.stdout.toLowerCase()).toContain('regression');
  });

  it('exits 1 with --fail-on-regression when a regression exists (AC-4.2)', () => {
    const r = runCli(['diff', baseline, current, '--fail-on-regression']);
    expect(r.status).toBe(1);
  });

  it('exits 2 when an input file is missing (AC-6.2)', () => {
    const r = runCli(['diff', path.join(tmp, 'nope.json'), current]);
    expect(r.status).toBe(2);
  });

  it('detects the regression offline via --format json (AC-5.4 / NFR-1)', () => {
    const r = runCli(['diff', baseline, current, '--format', 'json']);
    expect(r.status).toBe(0);
    const d = JSON.parse(r.stdout) as { summary: { hasRegression: boolean } };
    expect(d.summary.hasRegression).toBe(true);
  });
});
