// T005/T006 — program-level (global) flags and unknown-command handling.
// Global flags (`-c/--config`, `-v/--verbose`, `--no-color`) live on the root program and must
// reach every subcommand via optsWithGlobals() (ADR-S10-01).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunResult } from '../../types/results.js';

// A clean all-pass RunResult so exitCodeFor() yields 0 and the run action completes normally.
const OK_RESULT: RunResult = {
  schema: 1,
  plune_version: 'test',
  started_at: '2026-01-01T00:00:00.000Z',
  finished_at: '2026-01-01T00:00:00.000Z',
  config_hash: 'abc',
  summary: { total: 0, passed: 0, failed: 0, errored: 0, cost_usd: 0, duration_ms: 0 },
  evals: [],
};

// Rest-typed so `typecheck:gates` (tsconfig.check.json, includes tests) accepts the spread-through
// `(...args) => mock(...args)` wiring and `.mock.calls[0]![i]` indexing.
const handleRunMock = vi.fn(async (..._args: unknown[]) => OK_RESULT);
vi.mock('../commands/run.js', () => ({
  handleRun: (...args: unknown[]) => handleRunMock(...args),
}));

const renderReportMock = vi.fn((..._args: unknown[]) => 'RENDERED');
vi.mock('../../reporters/index.js', () => ({
  renderReport: (...args: unknown[]) => renderReportMock(...args),
}));

// loadEnv is a real fs side-effect — stub it so program tests never touch a real .env, and so we
// can assert WHEN/WITH-WHAT it is invoked (T007).
const loadEnvMock = vi.fn((..._args: unknown[]) => undefined);
vi.mock('../env.js', () => ({
  loadEnv: (...args: unknown[]) => loadEnvMock(...args),
}));

import * as path from 'node:path';
import { createProgram } from '../../cli.js';

beforeEach(() => {
  handleRunMock.mockClear();
  renderReportMock.mockClear();
  loadEnvMock.mockClear();
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('global flags (AC-T01)', () => {
  it('parses -v/--verbose, --no-color and -c at the program level', async () => {
    const program = createProgram();
    await program.parseAsync(['node', 'plune', '-v', '--no-color', '-c', 'x.yaml', 'run']);
    expect(program.opts()).toMatchObject({ verbose: true, color: false, config: 'x.yaml' });
  });

  it('propagates a global -c <path> down to handleRun (AC-T01.3)', async () => {
    await createProgram().parseAsync(['node', 'plune', '-c', 'global.yaml', 'run']);
    expect(handleRunMock).toHaveBeenCalledTimes(1);
    const opts = handleRunMock.mock.calls[0]![0] as { configPath?: string };
    expect(opts.configPath).toBe('global.yaml');
  });

  it('--no-color forces renderReport color:false (AC-T01.5)', async () => {
    await createProgram().parseAsync(['node', 'plune', '--no-color', 'run']);
    expect(renderReportMock).toHaveBeenCalledTimes(1);
    const renderOpts = renderReportMock.mock.calls[0]![2] as { color: boolean };
    expect(renderOpts.color).toBe(false);
  });
});

describe('.env auto-load (AC-T02.1)', () => {
  it('loads .env from the resolved config directory before handleRun', async () => {
    const cfg = path.join('some', 'nested', 'plune.yaml');
    await createProgram().parseAsync(['node', 'plune', '-c', cfg, 'run']);
    expect(loadEnvMock).toHaveBeenCalledWith(path.resolve('some', 'nested'));
    // loadEnv must run BEFORE handleRun (provider reads keys from process.env).
    expect(loadEnvMock.mock.invocationCallOrder[0]!).toBeLessThan(
      handleRunMock.mock.invocationCallOrder[0]!,
    );
  });

  it('loads .env from cwd when no -c is given', async () => {
    await createProgram().parseAsync(['node', 'plune', 'run']);
    expect(loadEnvMock).toHaveBeenCalledWith(process.cwd());
  });
});

describe('--verbose error output (AC-T01.4, constitution §5)', () => {
  function captureStderr(): string[] {
    const out: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array): boolean => {
      out.push(typeof c === 'string' ? c : Buffer.from(c).toString());
      return true;
    });
    return out;
  }

  it('prints a stack trace on an unexpected error WITH --verbose', async () => {
    handleRunMock.mockRejectedValueOnce(new Error('boom-unexpected'));
    const stderr = captureStderr();
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(
        (() => undefined) as (code?: string | number | null | undefined) => never,
      );

    await createProgram().parseAsync(['node', 'plune', '--verbose', 'run']);

    expect(exitSpy).toHaveBeenCalledWith(1);
    const out = stderr.join('');
    expect(out).toContain('boom-unexpected');
    expect(out).toMatch(/\n\s+at /); // stack frames present
  });

  it('prints only the message (no stack) WITHOUT --verbose', async () => {
    handleRunMock.mockRejectedValueOnce(new Error('boom-unexpected'));
    const stderr = captureStderr();
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(
        (() => undefined) as (code?: string | number | null | undefined) => never,
      );

    await createProgram().parseAsync(['node', 'plune', 'run']);

    expect(exitSpy).toHaveBeenCalledWith(1);
    const out = stderr.join('');
    expect(out).toContain('boom-unexpected');
    expect(out).not.toMatch(/\n\s+at /); // no stack frames
  });
});

describe('unknown command (AC-T01.6)', () => {
  it('writes the offending command to stderr and exits 2 (not 1)', async () => {
    const stderr: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array): boolean => {
      stderr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    });
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(
        (() => undefined) as (code?: string | number | null | undefined) => never,
      );

    await createProgram().parseAsync(['node', 'plune', 'definitely-not-a-command']);

    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(stderr.join('')).toContain('definitely-not-a-command');
  });
});
