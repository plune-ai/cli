// A saved run that holds an eval answered from stubs: `plune report` and `plune diff` say so in one line, and
// `plune sync` does not upload it. The commands are the real ones; only the environment file is left out.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../env.js', () => ({ loadEnv: () => undefined }));

import { createProgram } from '../../cli.js';
import { handleSync, reportSyncFailure, SyncFileError } from '../commands/sync.js';
import type { EvalResult, RowResult, RunResult } from '../../types/results.js';

const row = (extra: Partial<RowResult> = {}): RowResult => ({
  vars: { order: 1042 },
  output: 'Refund approved',
  cached: false,
  assertions: [{ type: 'contains', passed: true }],
  ...extra,
});
const ev = (id: string, extra: Partial<EvalResult> = {}): EvalResult => ({ id, tags: [], rows: [row()], passed: true, ...extra });
const stubbedEval = (id: string): EvalResult =>
  ev(id, { rows: [row({ stubbed: true })], stubs: { never_called: [], unmatched: [] } });

function runOf(evals: EvalResult[]): RunResult {
  return {
    schemaVersion: 1,
    plune_version: 'test',
    started_at: '2026-01-01T00:00:00.000Z',
    finished_at: '2026-01-01T00:00:01.000Z',
    config_hash: 'abc',
    summary: { total: evals.length, passed: evals.length, failed: 0, errored: 0, cost_usd: 0, duration_ms: 1 },
    evals,
  };
}

let dir: string;
let stderr: string;
let exits: unknown[];
const save = (name: string, run: RunResult): string => {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(run));
  return file;
};
const plune = (...argv: string[]) => createProgram().parseAsync(['node', 'plune', ...argv]);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-stubbed-run-'));
  stderr = '';
  exits = [];
  process.exitCode = undefined;
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exits.push(code);
  }) as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('CLI · report · a run with stubbed evals', () => {
  it('names the evals answered from stubs in one line on stderr, in every format', async () => {
    save('.plune/last-run.json', runOf([stubbedEval('refund'), ev('plain'), stubbedEval('retry')]));
    for (const format of ['console', 'json', 'markdown', 'junit']) {
      stderr = '';
      await plune('-c', path.join(dir, 'plune.yaml'), 'report', '--format', format);
      expect(stderr).toBe('note: answered from stubs, not by a model: refund, retry\n');
    }
    expect(exits).toEqual([]);
  });

  it('says nothing about a run without them', async () => {
    save('.plune/last-run.json', runOf([ev('plain')]));
    await plune('-c', path.join(dir, 'plune.yaml'), 'report');
    expect(stderr).toBe('');
  });
});

describe('CLI · diff · runs with stubbed evals', () => {
  it('names them for each side that has any', async () => {
    const baseline = save('base.json', runOf([ev('refund'), ev('plain')]));
    const current = save('head.json', runOf([stubbedEval('refund'), ev('plain')]));
    await plune('diff', baseline, current);
    expect(stderr).toBe('note: current: answered from stubs, not by a model: refund\n');

    stderr = '';
    await plune('diff', current, current, '--format', 'json');
    expect(stderr).toBe(
      'note: baseline: answered from stubs, not by a model: refund\n' +
        'note: current: answered from stubs, not by a model: refund\n',
    );

    stderr = '';
    await plune('diff', baseline, baseline);
    expect(stderr).toBe('');
    expect(exits).toEqual([]);
  });
});

describe('CLI · sync · a run with stubbed evals is not uploaded', () => {
  const fetchImpl = vi.fn();
  const sync = (file: string) =>
    handleSync({ cwd: dir, file, loadToken: () => 'plune_test_token', fetchImpl: fetchImpl as unknown as typeof fetch }).then(
      () => undefined,
      (e: unknown) => e,
    );

  it('refuses with exit 2 and the names of the evals, before any request', async () => {
    const err = await sync(save('run.json', runOf([stubbedEval('refund'), ev('plain'), stubbedEval('retry')])));
    expect(err).toBeInstanceOf(SyncFileError);
    let line = '';
    expect(reportSyncFailure(err, (s) => (line += s))).toBe(2);
    expect(line).toBe(
      'This run is not uploaded: its evals refund, retry were answered from stubs, not by a model. Run them without stubs, or sync a run of the other evals (plune run --only).\n',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a row marked stubbed is enough, also when the eval lost its mark', async () => {
    const err = await sync(save('run.json', runOf([ev('refund', { rows: [row({ stubbed: true })] })])));
    expect((err as Error).message).toContain('its evals refund were answered from stubs');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a run without them goes on to the upload', async () => {
    fetchImpl.mockRejectedValueOnce(new Error('offline'));
    const err = await sync(save('run.json', runOf([ev('plain')])));
    expect(err).not.toBeInstanceOf(SyncFileError);
    expect(fetchImpl).toHaveBeenCalled();
  });
});
