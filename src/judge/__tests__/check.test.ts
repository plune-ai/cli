import { describe, expect, it } from 'vitest';
import { judgeCheck, formatJudgeCheck, JUDGE_TYPES } from '../check.js';
import { JudgeCheckError, labelTemplate, matchLabels, outputHashOf, parseLabels, varsHashOf, type Label } from '../labels.js';
import type { EvalResult, RowResult, RunResult } from '../../types/results.js';

const row = (q: string, output: string | null, judge: boolean, extra: Partial<RowResult> = {}): RowResult => ({
  vars: { q },
  output,
  cached: false,
  assertions: [
    { type: 'contains', passed: true },
    { type: 'llm-judge', passed: judge, score: judge ? 0.9 : 0.1 },
  ],
  ...extra,
});
const ev = (id: string, rows: RowResult[], more: Partial<EvalResult> = {}): EvalResult => ({
  id,
  tags: [],
  rows,
  passed: true,
  ...more,
});
const run = (...evals: EvalResult[]): RunResult => ({
  schemaVersion: 1,
  plune_version: '0',
  started_at: '',
  finished_at: '',
  config_hash: '',
  summary: { total: evals.length, passed: 0, failed: 0, errored: 0, cost_usd: 0, duration_ms: 0 },
  evals,
});
const label = (evalId: string, r: RowResult, human: Label['human'], over: Partial<Label> = {}): Label => ({
  eval: evalId,
  vars_hash: varsHashOf(r.vars),
  output_hash: outputHashOf(r.output ?? ''),
  human,
  by: 'John Doe',
  at: '2026-11-23',
  ...over,
});

/** `n` rows where the person and the judge agree on the first `agree` and disagree on the rest. */
function agreeing(evalId: string, n: number, agree: number): { e: EvalResult; labels: Label[] } {
  const rows = Array.from({ length: n }, (_, i) => row(`q${i}`, `a${i}`, i % 2 === 0));
  const labels = rows.map((r, i) => label(evalId, r, (i < agree ? r.assertions[1]!.passed : !r.assertions[1]!.passed) ? 'pass' : 'fail'));
  return { e: ev(evalId, rows), labels };
}

describe('labels', () => {
  it('parses a labels file, a byte order mark and blank lines included', () => {
    const r = row('q', 'a', true);
    const text = '﻿' + JSON.stringify(label('e', r, 'pass', { note: 'fine' })) + '\n\n' + JSON.stringify(label('e', r, null, { by: '', at: '' })) + '\n';
    const ls = parseLabels(text);
    expect(ls).toHaveLength(2);
    expect(ls[0]).toMatchObject({ human: 'pass', note: 'fine' });
    expect(ls[1]).toMatchObject({ human: null, by: '', at: '' });
    // An unlabelled line from another tool may carry `by` and `at` of another type: read as empty.
    const odd = JSON.stringify({ ...label('e', r, null), by: 7, at: false });
    expect(parseLabels(odd)[0]).toMatchObject({ by: '', at: '' });
  });

  it.each([
    ['not json', 'labels line 1 is not JSON'],
    ['[1]', 'labels line 1 is not an object'],
    ['{"vars_hash":"x"}', 'eval is missing'],
    [JSON.stringify({ eval: 'e', vars_hash: 'x', output_hash: 'y' }), 'vars_hash is not a sha256 in hex'],
    [JSON.stringify({ eval: 'e', vars_hash: 'a'.repeat(64), output_hash: 'y' }), 'output_hash is not a sha256 in hex'],
    [JSON.stringify({ eval: 'e', vars_hash: 'a'.repeat(64), output_hash: 'b'.repeat(64), human: 'yes' }), 'human is "pass", "fail" or null'],
    [JSON.stringify({ eval: 'e', vars_hash: 'a'.repeat(64), output_hash: 'b'.repeat(64), human: 'pass', by: 'JD' }), 'who gave it and when'],
  ])('refuses %s', (line, message) => {
    expect(() => parseLabels(line)).toThrow(JudgeCheckError);
    expect(() => parseLabels(line)).toThrow(message);
  });

  it('a template lists every row with an answer, without the judge verdict', () => {
    const r = run(ev('e', [row('q1', 'a1', true), row('q2', null, false)]), ev('f@model-a', [row('q3', 'a3', false)], { provider: { type: 'openai', model: 'model-a' } }));
    const all = labelTemplate(r).trim().split('\n').map((l) => JSON.parse(l));
    expect(all.map((l) => l.eval)).toEqual(['e', 'f@model-a']);
    expect(all[0]).toEqual({
      eval: 'e',
      vars_hash: varsHashOf({ q: 'q1' }),
      output_hash: outputHashOf('a1'),
      human: null,
      by: '',
      at: '',
      vars: { q: 'q1' },
      output: 'a1',
    });
    expect(JSON.stringify(all)).not.toContain('score');
    expect(labelTemplate(r, 'f').trim().split('\n')).toHaveLength(1);
    expect(labelTemplate(run(ev('e', [row('q', null, true)])))).toBe('');
    // Rows whose vars repeat cannot be told apart by a label: they are not offered.
    expect(labelTemplate(run(ev('e', [row('d', 'a', true), row('d', 'b', true), row('u', 'c', true)]))).trim().split('\n')).toHaveLength(1);
    expect(() => labelTemplate(r, 'nope')).toThrow('the run has no eval "nope"');
  });

  it('names what it left out: unlabelled, stale, missing, not judged, conflicting', () => {
    const ok = row('ok', 'a', true);
    const changed = row('changed', 'new answer', true);
    const err = { error: { code: 'ERROR', message: 'x' } as RowResult['error'] };
    // The judge errored: the run stopped the row's checks there, so it has no verdict of the judge.
    const errored = row('errored', 'a', true, { ...err, assertions: [{ type: 'contains', passed: true }] });
    // A later check errored: the judge's verdict before it stands.
    const erredLater = row('later', 'a', false, err);
    const blocked = row('blocked', 'a', true, { inconclusive: 'blocked' });
    const short = row('short', 'a', true, { assertions: [{ type: 'contains', passed: true }] });
    const shifted = row('shifted', 'a', true, { assertions: [{ type: 'contains', passed: true }, { type: 'contains', passed: true }] });
    const twice = row('twice', 'a', true);
    const noAnswer = row('none', null, true);
    const dup = row('dup', 'a', true);
    const e = ev('e', [ok, changed, errored, erredLater, blocked, short, shifted, twice, noAnswer, dup, row('dup', 'b', false)]);
    const m = matchLabels(e, 1, 'llm-judge', [
      label('e', ok, 'pass'),
      label('e', ok, 'pass', { by: 'Jane Roe' }),
      label('e', ok, null),
      label('e', changed, 'fail', { output_hash: outputHashOf('old answer') }),
      label('e', row('gone', 'a', true), 'pass'),
      label('e', errored, 'pass'),
      label('e', erredLater, 'pass'),
      label('e', blocked, 'pass'),
      label('e', short, 'pass'),
      label('e', shifted, 'pass'),
      label('e', twice, 'pass'),
      label('e', twice, 'fail', { by: 'Jane Roe' }),
      label('e', noAnswer, 'pass'),
      label('e', dup, 'pass'),
      label('other', ok, 'pass'),
    ]);
    expect(m).toEqual({
      pairs: [
        { human: true, judge: true },
        { human: true, judge: false },
      ],
      unlabelled: 1,
      stale: 1,
      missing: 1,
      notJudged: 5,
      conflicting: 1,
      repeated: 1,
    });
    // A hash in capitals is the same hash.
    const upper = label('e', ok, 'fail', { vars_hash: varsHashOf(ok.vars).toUpperCase(), output_hash: outputHashOf('a').toUpperCase() });
    expect(matchLabels(e, 1, 'llm-judge', parseLabels(JSON.stringify(upper))).pairs).toEqual([{ human: false, judge: true }]);
    // The check before the one that errored keeps its verdict.
    expect(matchLabels(e, 0, 'contains', [label('e', errored, 'fail')]).pairs).toEqual([{ human: false, judge: true }]);
  });
});

describe('judge-check', () => {
  it('the figures, the table and no warning on 40 rows that agree on 36', () => {
    const { e, labels } = agreeing('faq', 40, 36);
    const report = judgeCheck(run(e), labels);
    expect(report.exitCode).toBe(0);
    const [c] = report.evals;
    expect(c).toMatchObject({ evalId: 'faq', check: 1, checkType: 'llm-judge' });
    expect(c!.agreement.n).toBe(40);
    expect(c!.agreement.agreement).toBeCloseTo(0.9, 10);
    expect(c!.warnings).toEqual([]);
    const text = formatJudgeCheck(report, 0.5);
    expect(text).toContain('Judge check: faq, check 2 (llm-judge)');
    expect(text).toContain('  labelled rows: 40\n');
    expect(text).toContain('    judge pass');
    expect(text).toMatch(/agreement 0\.90 · TPR \d\.\d\d · TNR \d\.\d\d · kappa 0\.80 \(95% 0\.\d\d to 0\.\d\d\)/);
    expect(text).toContain('--min-kappa 0.5: met');
  });

  it('warns below 30 rows, on a wide interval and on a judge that is the answering model', () => {
    const { e, labels } = agreeing('faq', 12, 9);
    const measured = { runs: 1, rows: 12, rows_hash: '', assertions_hash: '', model: 'openai/model-a' };
    const [c] = judgeCheck(run({ ...e, measured }), labels).evals;
    expect(c!.warnings).toEqual([
      '12 labelled rows, fewer than 30: these figures are not reliable yet',
      expect.stringMatching(/^the 95% interval of kappa is \d\.\d\d wide, more than 0\.4: label more rows before trusting the number$/),
      'the judge is model-a, the model that wrote the answers: a model tends to favour its own text',
    ]);
    // A check no model judges is not warned about.
    expect(judgeCheck(run({ ...e, measured }), labels, { check: 1 }).evals[0]!.warnings.join()).not.toContain('the judge is');
  });

  it('the model of a cell, and a run without a model', () => {
    const { e, labels } = agreeing('faq', 40, 36);
    const cell = { ...e, id: 'faq@model-b', provider: { type: 'openai', model: 'model-b' } };
    const cellLabels = labels.map((l) => ({ ...l, eval: 'faq@model-b' }));
    expect(judgeCheck(run(cell), cellLabels).evals[0]!.warnings).toEqual([
      'the judge is model-b, the model that wrote the answers: a model tends to favour its own text',
    ]);
    expect(judgeCheck(run(e), labels).evals[0]!.warnings).toEqual([]);
  });

  it('--min-kappa met at the printed value: 0.40 meets 0.4', () => {
    // TP 20, FN 5, FP 10, TN 15: kappa sums to 0.3999999999999999, printed 0.40.
    const pairs = [[true, true, 20], [true, false, 5], [false, true, 10], [false, false, 15]] as const;
    const rows: RowResult[] = [];
    const labels: Label[] = [];
    for (const [human, judge, n] of pairs) {
      for (let i = 0; i < n; i++) {
        const r = row(`${human}-${judge}-${i}`, 'a', judge);
        rows.push(r);
        labels.push(label('k', r, human ? 'pass' : 'fail'));
      }
    }
    const report = judgeCheck(run(ev('k', rows)), labels, { minKappa: 0.4 });
    expect(report.exitCode).toBe(0);
    expect(formatJudgeCheck(report, 0.4)).toContain('kappa 0.40');
    expect(formatJudgeCheck(report, 0.4)).toContain('--min-kappa 0.4: met');
  });

  it('kappa with no value is said, fails --min-kappa, and the interval warning is not given', () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(`q${i}`, `a${i}`, true));
    const report = judgeCheck(run(ev('e', rows)), rows.map((r) => label('e', r, 'pass')), { minKappa: 0.2 });
    expect(report.evals[0]!.agreement.kappa).toBeNull();
    expect(report.evals[0]!.warnings).toEqual(['kappa has no value: the person and the judge each gave one answer only']);
    expect(report.exitCode).toBe(1);
    expect(formatJudgeCheck(report, 0.2)).toContain('kappa n/a\n');
    expect(formatJudgeCheck(report, 0.2)).toContain('--min-kappa 0.2: not met');
  });

  it('an interval that cannot be estimated is said', () => {
    // Two rows, one pass and one fail, both agreed on: kappa is 1, yet about half the resamples draw one
    // row twice and hold one answer only; with the fixed seed more than half do.
    const rows = [row('q0', 'a0', true), row('q1', 'a1', false)];
    const labels = [label('e', rows[0]!, 'pass'), label('e', rows[1]!, 'fail')];
    const c = judgeCheck(run(ev('e', rows)), labels).evals[0]!;
    expect(c.agreement.kappa).toBe(1);
    expect(c.warnings).toEqual([
      '2 labelled rows, fewer than 30: these figures are not reliable yet',
      'the 95% interval of kappa could not be estimated: most resamples had one answer only',
    ]);
  });

  it('exit 1 below --min-kappa; one eval with --eval; labels of evals not in the run are named', () => {
    const a = agreeing('a', 40, 20);
    const b = agreeing('b', 40, 40);
    const all = [...a.labels, ...b.labels, label('gone', row('q', 'a', true), 'pass')];
    const report = judgeCheck(run(a.e, b.e), all, { minKappa: 0.5 });
    expect(report.evals.map((e) => e.evalId)).toEqual(['a', 'b']);
    expect(report.exitCode).toBe(1);
    expect(report.otherEvals).toEqual(['gone']);
    expect(formatJudgeCheck(report)).toContain('Labels of evals not in this run: gone');
    expect(judgeCheck(run(a.e, b.e), all, { evalId: 'b', minKappa: 0.5 })).toMatchObject({ exitCode: 0, evals: [{ evalId: 'b' }] });
  });

  it('the left-out rows are listed beside the count', () => {
    const { e, labels } = agreeing('e', 30, 30);
    const text = formatJudgeCheck(judgeCheck(run(e), [...labels, label('e', row('gone', 'a', true), 'pass'), label('e', e.rows[0]!, null)]));
    expect(text).toContain('labelled rows: 30 (left out: 1 not labelled yet, 1 not in this run)');
  });

  it('refuses: no eval with labels, an unknown --eval, a --check past the row, no judged check, two judged checks', () => {
    const { e, labels } = agreeing('e', 4, 4);
    expect(() => judgeCheck(run(e), [])).toThrow('no eval of the run has a label in the file');
    expect(() => judgeCheck(run(e), labels, { evalId: 'x' })).toThrow('the run has no eval "x"');
    expect(() => judgeCheck(run(e), labels, { check: 3 })).toThrow('eval e has 2 checks in a row; --check 3 is not one');
    const plain = ev('p', [row('q', 'a', true, { assertions: [{ type: 'contains', passed: true }] })]);
    expect(() => judgeCheck(run(plain), [label('p', plain.rows[0]!, 'pass')])).toThrow(
      'eval p has no check a model judges; name the one to compare with --check <n> (1 contains)',
    );
    // The judge errored on every row: the message says why the run holds no verdict of it.
    const failed = ev('j', [row('q', 'a', true, { error: { code: 'ERROR', message: 'x' } as RowResult['error'], assertions: [{ type: 'contains', passed: true }] })]);
    const failedLabel = [label('j', failed.rows[0]!, 'pass')];
    expect(() => judgeCheck(run(failed), failedLabel)).toThrow('(1 contains); every row stopped at an error, so later checks have no verdict');
    expect(() => judgeCheck(run(failed), failedLabel, { check: 2 })).toThrow('eval j has 1 check in a row; --check 2 is not one; every row');
    const empty = ev('z', [row('q', null, true, { assertions: [] })]);
    expect(() => judgeCheck(run(empty), [label('z', empty.rows[0]!, 'pass')])).toThrow('(no checks)');
    const two = ev('t', [row('q', 'a', true, { assertions: JUDGE_TYPES.slice(0, 2).map((type) => ({ type, passed: true })) })]);
    expect(() => judgeCheck(run(two), [label('t', two.rows[0]!, 'pass')])).toThrow(
      'eval t has 2 checks a model judges; name one with --check <n> (1 llm-judge, 2 faithfulness)',
    );
  });
});
