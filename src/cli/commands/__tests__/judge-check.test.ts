import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleJudgeCheck } from '../judge-check.js';
import { createProgram } from '../../../cli.js';
import { JudgeCheckError } from '../../../judge/labels.js';
import type { RunResult } from '../../../types/results.js';

let tmp: string;
let out: string[];
const write = (t: string): void => {
  out.push(t);
};
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-judge-'));
  out = [];
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A saved run of eval `faq`: 40 rows, the judge passes the even ones. */
function saveRun(): RunResult {
  const rows = Array.from({ length: 40 }, (_, i) => ({
    vars: { q: `q${i}` },
    output: `a${i}`,
    cached: false,
    assertions: [{ type: 'llm-judge', passed: i % 2 === 0, score: i % 2 === 0 ? 0.9 : 0.1 }],
  }));
  const run: RunResult = {
    schemaVersion: 1,
    plune_version: '0',
    started_at: '',
    finished_at: '',
    config_hash: '',
    summary: { total: 1, passed: 0, failed: 1, errored: 0, cost_usd: 0, duration_ms: 0 },
    evals: [{ id: 'faq', tags: [], rows, passed: false }],
  };
  fs.mkdirSync(path.join(tmp, '.plune'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.plune', 'last-run.json'), JSON.stringify(run));
  return run;
}

/** Fills the template the way a person would: agree with the judge on the first `agree` rows. */
function fill(file: string, agree: number): void {
  const p = path.join(tmp, file);
  const lines = fs.readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const filled = lines.map((l, i) => {
    const judgePass = i % 2 === 0;
    return { ...l, human: (i < agree ? judgePass : !judgePass) ? 'pass' : 'fail', by: 'John Doe', at: '2026-11-23' };
  });
  fs.writeFileSync(p, filled.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

describe('plune judge-check', () => {
  it('--init writes the rows to label; filled in, the check prints the agreement, offline', async () => {
    saveRun();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(await handleJudgeCheck('labels/faq.jsonl', { init: true }, tmp, write)).toBe(0);
    expect(out.join('')).toContain('Wrote labels/faq.jsonl: 40 rows to label.');
    fill('labels/faq.jsonl', 36);
    out = [];
    expect(await handleJudgeCheck('labels/faq.jsonl', { minKappa: '0.6' }, tmp, write)).toBe(0);
    const text = out.join('');
    expect(text).toContain('Judge check: faq, check 1 (llm-judge)');
    expect(text).toContain('kappa 0.80');
    expect(text).toContain('--min-kappa 0.6: met');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('exit 1 below --min-kappa; --check, --eval, --max-interval-width and --run are read', async () => {
    saveRun();
    await handleJudgeCheck('l.jsonl', { init: true }, tmp, write);
    fill('l.jsonl', 24);
    fs.renameSync(path.join(tmp, '.plune', 'last-run.json'), path.join(tmp, 'saved.json'));
    out = [];
    const code = await handleJudgeCheck(
      'l.jsonl',
      { run: 'saved.json', check: '1', eval: 'faq', minKappa: '0.5', maxIntervalWidth: '0.1' },
      tmp,
      write,
    );
    expect(code).toBe(1);
    expect(out.join('')).toContain('--min-kappa 0.5: not met');
    expect(out.join('')).toContain('more than 0.1');
  });

  it('names the judge as the answering model', async () => {
    saveRun();
    await handleJudgeCheck('l.jsonl', { init: true }, tmp, write);
    fill('l.jsonl', 40);
    const run = JSON.parse(fs.readFileSync(path.join(tmp, '.plune', 'last-run.json'), 'utf8')) as RunResult;
    run.evals[0]!.measured = { runs: 1, rows: 40, rows_hash: '', assertions_hash: '', model: 'openai/model-a' };
    fs.writeFileSync(path.join(tmp, '.plune', 'last-run.json'), JSON.stringify(run));
    out = [];
    await handleJudgeCheck('l.jsonl', {}, tmp, write);
    expect(out.join('')).toContain('warning: the judge is model-a, the model that wrote the answers');
  });

  it.each([
    [{ run: 'nope.json' }, 'cannot read the run nope.json'],
    [{ check: '0' }, '--check is a number from 1 to'],
    [{ check: '1.5' }, '--check is a whole number, not 1.5'],
    [{ minKappa: '2' }, '--min-kappa is a number from -1 to 1, not "2"'],
    [{ maxIntervalWidth: ' ' }, '--max-interval-width is a number from 0 to 2'],
  ])('refuses %o', async (flags, message) => {
    saveRun();
    await handleJudgeCheck('l.jsonl', { init: true }, tmp, write);
    fill('l.jsonl', 40);
    await expect(handleJudgeCheck('l.jsonl', flags, tmp, write)).rejects.toThrow(message);
  });

  it('refuses a run that is not one, missing labels, and --init over labels without --force', async () => {
    fs.writeFileSync(path.join(tmp, 'bad.json'), '{"evals": 1}');
    await expect(handleJudgeCheck('l.jsonl', { run: 'bad.json' }, tmp, write)).rejects.toThrow(
      'bad.json is not a run that plune run writes',
    );
    saveRun();
    await expect(handleJudgeCheck('none.jsonl', {}, tmp, write)).rejects.toThrow('cannot read the labels none.jsonl');
    fs.writeFileSync(path.join(tmp, 'mine.jsonl'), 'kept\n');
    await expect(handleJudgeCheck('mine.jsonl', { init: true }, tmp, write)).rejects.toThrow(JudgeCheckError);
    expect(fs.readFileSync(path.join(tmp, 'mine.jsonl'), 'utf8')).toBe('kept\n');
    expect(await handleJudgeCheck('mine.jsonl', { init: true, force: true }, tmp, write)).toBe(0);
    const empty = saveRun();
    empty.evals[0]!.rows.forEach((r) => (r.output = null));
    fs.writeFileSync(path.join(tmp, '.plune', 'last-run.json'), JSON.stringify(empty));
    out = [];
    await handleJudgeCheck('e.jsonl', { init: true }, tmp, write);
    expect(out.join('')).toContain('Wrote e.jsonl: 0 rows to label.');
  });

  it('from the command line: exit 2 with the message for what the person can fix', async () => {
    const stderr: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
      stderr.push(String(c));
      return true;
    });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as (code?: string | number | null) => never);
    vi.spyOn(process, 'cwd').mockReturnValue(tmp);
    await createProgram().parseAsync(['node', 'plune', 'judge-check', 'l.jsonl']);
    expect(exit).toHaveBeenCalledWith(2);
    expect(stderr.join('')).toContain('cannot read the run .plune');
    saveRun();
    await createProgram().parseAsync(['node', 'plune', 'judge-check', 'l.jsonl', '--init']);
    expect(fs.existsSync(path.join(tmp, 'l.jsonl'))).toBe(true);
    expect(exit).toHaveBeenCalledTimes(1);
    // A mistyped flag or a missing argument is exit 2, not the 1 of a kappa below --min-kappa.
    exit.mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as (code?: string | number | null) => never);
    await expect(createProgram().parseAsync(['node', 'plune', 'judge-check', 'l.jsonl', '--min-kapa', '1'])).rejects.toThrow('exit 2');
    await expect(createProgram().parseAsync(['node', 'plune', 'judge-check'])).rejects.toThrow('exit 2');
    await expect(createProgram().parseAsync(['node', 'plune', 'judge-check', '--help'])).rejects.toThrow('exit 0');
  });
});
