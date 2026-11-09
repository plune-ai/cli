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

// plune#2414 — nothing regressed, but one eval was never measured.
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
