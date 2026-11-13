import { describe, expect, it } from 'vitest';
import { renderDiff, renderDiffMarkdown, STICKY_MARKER } from '../diff.js';
import type { RunDiff } from '../../diff/diff.js';

const ESC = String.fromCharCode(27);

const withRegression: RunDiff = {
  evals: [
    { id: 'reg', status: 'regression', baseline: 'passed', current: 'failed' },
    { id: 'imp', status: 'improvement', baseline: 'failed', current: 'passed' },
    { id: 'newf', status: 'new-fail', baseline: 'absent', current: 'failed' },
    { id: 'err', status: 'errored', baseline: 'passed', current: 'errored' },
    { id: 'ok', status: 'stable-pass', baseline: 'passed', current: 'passed' },
  ],
  summary: {
    regressions: 1,
    improvements: 1,
    preExistingFails: 0,
    newFails: 1,
    newPasses: 0,
    stablePasses: 1,
    errored: 1,
    removed: 0,
    unmeasured: 1,
    hasRegression: true,
  },
};

const clean: RunDiff = {
  evals: [{ id: 'ok', status: 'stable-pass', baseline: 'passed', current: 'passed' }],
  summary: {
    regressions: 0,
    improvements: 0,
    preExistingFails: 0,
    newFails: 0,
    newPasses: 0,
    stablePasses: 1,
    errored: 0,
    removed: 0,
    unmeasured: 0,
    hasRegression: false,
  },
};

// Nothing regressed, but one eval was never measured.
const unmeasured: RunDiff = {
  evals: [
    { id: 'err', status: 'errored', baseline: 'passed', current: 'errored' },
    { id: 'ok', status: 'stable-pass', baseline: 'passed', current: 'passed' },
  ],
  summary: { ...clean.summary, errored: 1, unmeasured: 1 },
};

describe('renderDiffMarkdown', () => {
  it('leads with the sticky marker so the Action updates one comment (AC-3.2)', () => {
    expect(renderDiffMarkdown(withRegression).startsWith(STICKY_MARKER)).toBe(true);
  });

  it('flags regressions and lists the regressed eval with its transition (AC-3.1)', () => {
    const md = renderDiffMarkdown(withRegression);
    expect(md).toMatch(/regression/i);
    expect(md).toContain('reg');
    expect(md).toContain('passed');
    expect(md).toContain('failed');
  });

  it('shows a green, no-regression summary when clean (AC-3.4)', () => {
    const md = renderDiffMarkdown(clean);
    expect(md).toMatch(/no regress/i);
    expect(md).toContain(STICKY_MARKER);
  });

  it('an unmeasured eval takes the green «no regressions» header away and is counted (#2414)', () => {
    const md = renderDiffMarkdown(unmeasured);
    expect(md).not.toMatch(/no regress/i);
    expect(md).not.toContain('✅ No');
    expect(md).toContain('### ⚠️ 1 eval(s) not measured');
    expect(md).toContain('1 not measured');
    expect(renderDiff(unmeasured, 'console')).toMatch(/^Plune eval diff: 1 eval\(s\) not measured/);
  });

  it('contains no ANSI escapes', () => {
    expect(renderDiffMarkdown(withRegression)).not.toContain(ESC);
  });
});

describe('renderDiff dispatch', () => {
  it('json format round-trips the RunDiff', () => {
    expect(JSON.parse(renderDiff(withRegression, 'json'))).toEqual(withRegression);
  });

  it('console format reports the regression count', () => {
    expect(renderDiff(withRegression, 'console')).toMatch(/1 regression/);
  });

  it('console format reports no regressions when clean', () => {
    expect(renderDiff(clean, 'console')).toMatch(/no regressions/i);
  });
});

// MCP-D5 — the «Gates» section.
const w = { gate: 'regression' as const, eval: 'reg', reason: 'known | flake\nfix soon', granted: '2026-11-10', expires: '2026-11-20' };
const gated: RunDiff = {
  ...withRegression,
  gates: {
    exitCode: 3,
    gates: [
      { gate: 'regression', state: 'waived', reason: 'passed → failed, waived: reg', value: 1, threshold: 0 },
      {
        gate: 'pass-rate',
        state: 'unmeasured',
        reason: 'the two runs did not measure the same population',
        threshold: 5,
        details: ['eval "x" added'],
      },
      { gate: 'cost', state: 'passed', reason: 'cost of the current run', value: 0.1234, threshold: 1 },
      { gate: 'cost-increase', state: 'failed', reason: 'cost against the baseline', value: 12.5, threshold: 10 },
      { gate: 'tokens', state: 'passed', reason: 'input + output tokens', value: 2000, threshold: 5000 },
    ],
    waivers: {
      applied: [w],
      expired: [{ ...w, eval: 'old', expires: '2026-11-12' }],
      unused: [{ gate: 'cost', reason: 'spare', granted: '2026-11-10', expires: '2026-11-20' }],
    },
  },
};

describe('CLI · diff · gates · report', () => {
  it('markdown: a Gates table with state, value, threshold and reason, and every waiver', () => {
    const md = renderDiffMarkdown(gated);
    expect(md).toContain('### Gates');
    expect(md).toContain('| regression | 🟡 waived | 1 | 0 | passed → failed, waived: reg |');
    expect(md).toContain('| pass-rate | ⚠️ not measured | — | 5 pp | the two runs did not measure the same population |');
    expect(md).toContain('| cost | ✅ passed | $0.1234 | $1 |');
    expect(md).toContain('| cost-increase | ❌ failed | 12.5% | 10% |');
    expect(md).toContain('| tokens | ✅ passed | 2000 | 5000 |');
    expect(md).toContain('- pass-rate: eval "x" added');
    expect(md).toContain('Waived: regression of `reg` until 2026-11-20: known | flake fix soon');
    expect(md).toContain('Expired: regression of `old` on 2026-11-12');
    expect(md).toContain('Unused: cost until 2026-11-20: spare');
  });

  it('the headline follows the gates: a waived regression is not red, a failed gate is', () => {
    expect(renderDiffMarkdown(gated)).toContain('### ❌ Gate failed: cost-increase');
    const notMeasured: RunDiff = {
      ...clean,
      gates: { exitCode: 3, gates: [gated.gates!.gates[1]!], waivers: { applied: [], expired: [], unused: [] } },
    };
    expect(renderDiffMarkdown(notMeasured)).toContain('### ⚠️ Not measured: pass-rate');
    const allWaived: RunDiff = {
      ...withRegression,
      summary: { ...withRegression.summary, unmeasured: 0 },
      gates: { exitCode: 0, gates: [gated.gates!.gates[0]!], waivers: { applied: [w], expired: [], unused: [] } },
    };
    expect(renderDiffMarkdown(allWaived)).toContain('### ✅ Gates passed (1 waived)');
    const allPassed: RunDiff = {
      ...clean,
      gates: { exitCode: 0, gates: [gated.gates!.gates[2]!], waivers: { applied: [], expired: [], unused: [] } },
    };
    expect(renderDiffMarkdown(allPassed)).toContain('### ✅ No regressions');
  });

  it('console: one line per gate and per waiver', () => {
    const text = renderDiff(gated, 'console');
    expect(text).toMatch(/^Plune eval diff: gate failed: cost-increase/);
    expect(text).toContain('Gates:');
    expect(text).toContain('  pass-rate: not measured, the two runs did not measure the same population (limit 5 pp)');
    expect(text).toContain('    eval "x" added');
    expect(text).toContain('  cost-increase: failed, cost against the baseline: 12.5% (limit 10%)');
    expect(text).toContain('  waived: regression of reg until 2026-11-20: known | flake fix soon');
    expect(text).toContain('  expired waiver: regression of old on 2026-11-12');
    expect(text).toContain('  unused waiver: cost until 2026-11-20');
  });

  it('json: the gates are an added field; without gates the RunDiff has only evals and summary', () => {
    expect(JSON.parse(renderDiff(gated, 'json'))).toEqual(gated);
    expect(Object.keys(JSON.parse(renderDiff(clean, 'json')) as object)).toEqual(['evals', 'summary']);
  });
});
