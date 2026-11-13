// The pairs of "what the advice says" and "what each format shows and which code the command exits with": the words
// differ, the exit code never does.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createProgram } from '../../../cli.js';
import type { EvalResult, RunResult } from '../../../types/results.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-diff-advice-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exitCode = 0;
});

// One row that passes (so the eval is "passed" on both sides) whose repeats passed `passed` of `runs`.
function ev(passed: number, runs: number): EvalResult {
  const results = Array.from({ length: runs }, () => ({
    output: 'x',
    cached: false,
    assertions: [],
  }));
  return {
    id: 'e',
    tags: [],
    passed: true,
    measured: { runs, rows: 1, rows_hash: 'r', assertions_hash: 'a', model: 'p/m' },
    rows: [
      {
        vars: {},
        output: 'x',
        cached: false,
        assertions: [{ type: 'exact-match', passed: true }],
        attempts: { runs, pass_threshold: 0.1, passed, failed: runs - passed, errored: 0, results },
      },
    ],
  };
}
const run = (e: EvalResult): RunResult => ({
  schemaVersion: 1,
  plune_version: '0',
  started_at: '',
  finished_at: '',
  config_hash: '',
  summary: { total: 1, passed: 1, failed: 0, errored: 0, cost_usd: 0, duration_ms: 0 },
  evals: [e],
});
function write(name: string, r: RunResult): string {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, JSON.stringify(r));
  return p;
}

async function diff(
  base: RunResult,
  cur: RunResult,
  ...flags: string[]
): Promise<{ text: string; code: number }> {
  const out: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array): boolean => {
    out.push(String(c));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  process.exitCode = 0;
  await createProgram().parseAsync([
    'node',
    'plune',
    'diff',
    write('b.json', base),
    write('c.json', cur),
    ...flags,
  ]);
  return { text: out.join(''), code: Number(process.exitCode ?? 0) };
}

const STATES = [
  { word: 'worse', phrase: 'probably worse', base: ev(9, 10), cur: ev(4, 10) },
  { word: 'better', phrase: 'probably better', base: ev(4, 10), cur: ev(9, 10) },
  { word: 'no-difference', phrase: 'no difference visible', base: ev(9, 10), cur: ev(8, 10) },
  { word: 'too-few', phrase: 'too few attempts', base: ev(2, 2), cur: ev(0, 2) },
] as const;

describe('CLI · diff · advice · state, format and exit code', () => {
  for (const s of STATES) {
    it(`CLI · diff · advice · ${s.word}: named in console, markdown and json, and the exit code is 0 with or without a gate`, async () => {
      for (const flags of [[], ['--fail-on-regression']]) {
        const consoleOut = await diff(run(s.base), run(s.cur), ...flags);
        expect(consoleOut.text, `console ${flags}`).toContain(
          'Advice (does not change the exit code):',
        );
        expect(consoleOut.text).toContain(s.phrase);
        expect(consoleOut.code, `exit ${flags}`).toBe(0);

        const md = await diff(run(s.base), run(s.cur), ...flags, '--format', 'markdown');
        expect(md.text).toContain('### Advice (does not affect the exit code)');
        expect(md.text).toContain(s.phrase);
        // The headline is the verdict of the gates, and the advice does not touch it.
        expect(md.text).toContain('No regressions');
        expect(md.code).toBe(0);

        const json = await diff(run(s.base), run(s.cur), ...flags, '--format', 'json');
        const d = JSON.parse(json.text) as {
          summary: { unmeasured: number };
          advice: { evals: { comparison: { word: string } }[] };
        };
        expect(d.advice.evals[0]!.comparison.word).toBe(s.word);
        expect(d.summary.unmeasured).toBe(0);
        expect(json.code).toBe(0);
      }
    });
  }

  it('CLI · diff · advice · the same runs without repeats exit the same and say nothing of advice', async () => {
    const plain = (): EvalResult => ({
      ...ev(1, 1),
      rows: [
        {
          vars: {},
          output: 'x',
          cached: false,
          assertions: [{ type: 'exact-match', passed: true }],
        },
      ],
      measured: { runs: 1, rows: 1, rows_hash: 'r', assertions_hash: 'a', model: 'p/m' },
    });
    const got = await diff(run(plain()), run(plain()), '--fail-on-regression');
    expect(got.text).not.toContain('Advice');
    expect(got.code).toBe(0);
  });

  it('CLI · diff · advice · the overall rate of runs that measured different things is "not compared", and the exit code is still 0', async () => {
    const other = ev(4, 10);
    other.measured!.rows_hash = 'other';
    const got = await diff(run(ev(9, 10)), run(other), '--fail-on-regression');
    expect(got.text).toContain('not compared');
    expect(got.text).toContain('dataset rows differ');
    expect(got.code).toBe(0);
  });

  it('CLI · diff · advice · an experiment between two different populations says how they differ and compares nothing', async () => {
    const swapped = ev(9, 10);
    swapped.measured!.rows_hash = 'other';
    swapped.rows[0]!.agent = {
      server: 'fx',
      tools: [],
      steps: [],
      stop: { reason: 'complete' },
      collection: 'complete',
      description_overrides: [{ tool: 'search', sha256: 'b'.repeat(64) }],
    };
    const got = await diff(run(ev(9, 10)), run(swapped), '--format', 'markdown');
    expect(got.text).toContain('Experiment with descriptions');
    expect(got.text).toContain('differ in more than the descriptions');
    expect(got.code).toBe(0);
  });
});
