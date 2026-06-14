// T013 — END-TO-END against the REAL built binary (dist/cli.cjs), driven via child_process.
// Run with `pnpm test:e2e` (which builds first); excluded from the default unit run because it
// needs dist/ and is slower. Verifies the whole user journey + cold-start budget + bundle shape.

import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url)); // src/cli/__tests__
const root = path.resolve(here, '..', '..', '..'); // repo root
const dist = path.join(root, 'dist');
const cli = path.join(dist, 'cli.cjs'); // the bin (CJS — lazy heavy deps, see tsup.config.ts)

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): CliResult {
  const res = spawnSync(process.execPath, [cli, ...args], {
    cwd: opts.cwd ?? root,
    env: { ...process.env, ...opts.env },
    encoding: 'utf8',
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

beforeAll(() => {
  if (!fs.existsSync(cli)) {
    throw new Error(
      `dist/cli.cjs not found — run \`pnpm test:e2e\` (it builds first), not plain vitest.`,
    );
  }
});

describe('plune binary — basics', () => {
  it('--version prints the version and exits 0', () => {
    const r = runCli(['--version']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('--help lists the commands and exits 0', () => {
    const r = runCli(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('run');
    expect(r.stdout).toContain('report');
    expect(r.stdout).toContain('init');
  });

  it('an unknown command exits 2 (AC-T01.6)', () => {
    const r = runCli(['definitely-not-a-command']);
    expect(r.status).toBe(2);
  });

  it('cold-start (`--version`) is under 300ms (warn >200ms) (NFR-1)', () => {
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      const r = runCli(['--version']);
      const elapsed = performance.now() - start;
      expect(r.status).toBe(0);
      if (elapsed < best) best = elapsed;
    }
    if (best > 200) {
      console.warn(`[cold-start] ${best.toFixed(0)}ms (>200ms warn threshold)`);
    }
    expect(best).toBeLessThan(300);
  });
});

describe('plune binary — full journey init --yes → run → report (AC-T07.1)', () => {
  let tmp: string;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-e2e-'));
  });

  it('init --yes scaffolds the three files (exit 0)', () => {
    const r = runCli(['init', '--yes'], { cwd: tmp });
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(tmp, 'plune.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'datasets', 'example.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, '.env.example'))).toBe(true);
    // Never a populated .env (constitution §4 / NFR-5).
    expect(fs.existsSync(path.join(tmp, '.env'))).toBe(false);
  });

  it('run --dry-run estimates without calling a provider (exit 0)', () => {
    // Dry-run still resolves the provider for cost estimation; the mock provider lets it run
    // without a real API key (AC-T04.5 + AC-T07.3).
    const r = runCli(['run', '--dry-run'], { cwd: tmp, env: { PLUNE_MOCK_PROVIDER: '1' } });
    expect(r.status).toBe(0);
  });

  it('run with PLUNE_MOCK_PROVIDER=1 completes without network (exit 0 or 1, never 2)', () => {
    const r = runCli(['run'], { cwd: tmp, env: { PLUNE_MOCK_PROVIDER: '1' } });
    expect([0, 1]).toContain(r.status);
    expect(fs.existsSync(path.join(tmp, '.plune', 'last-run.json'))).toBe(true);
  });

  it('report re-renders the saved run (exit 0)', () => {
    const r = runCli(['report'], { cwd: tmp });
    expect(r.status).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(0);
  });
});

describe('bundle shape (AC-T06.3 / NFR-3)', () => {
  it('dist/index.js (public API) does not bundle commander', () => {
    const idx = fs.readFileSync(path.join(dist, 'index.js'), 'utf8');
    expect(idx).not.toContain('commander');
  });

  it('dist/cli.cjs is an executable with a node shebang', () => {
    const bin = fs.readFileSync(cli, 'utf8');
    expect(bin.startsWith('#!/usr/bin/env node')).toBe(true);
  });

  it('dist/index.d.ts exists for type consumers', () => {
    expect(fs.existsSync(path.join(dist, 'index.d.ts'))).toBe(true);
  });
});
