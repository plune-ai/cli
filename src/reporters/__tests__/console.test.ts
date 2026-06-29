import { describe, expect, it } from 'vitest';
import { renderConsole } from '../console.js';
import { mixed, allPass, withLongOutput } from './fixtures.js';
import type { RunResult } from '../../types/results.js';

const ESC = String.fromCharCode(27); // the ANSI escape byte (unambiguous, no escape-sequence pitfalls)

describe('renderConsole', () => {
  it('shows the summary counts and cost (AC-1)', () => {
    const out = renderConsole(mixed, { color: false });
    expect(out).toMatch(/passed/i);
    expect(out).toMatch(/failed/i);
    expect(out).toMatch(/errored/i);
    expect(out).toContain('$0.0123');
  });

  it('lists each eval with its status', () => {
    const out = renderConsole(mixed, { color: false });
    expect(out).toContain('e-pass');
    expect(out).toContain('e-fail');
    expect(out).toContain('e-err');
  });

  it('details failed rows (failing assertion + reason), collapses passing (AC-1, AC-9)', () => {
    const out = renderConsole(mixed, { color: false });
    expect(out).toContain('llm-judge');
    expect(out).toContain('too terse');
    expect(out).not.toContain('good answer'); // passing row output is not detailed
  });

  it('shows the error message for errored rows (AC-9)', () => {
    expect(renderConsole(mixed, { color: false })).toContain('provider down');
  });

  it('emits no ANSI when color is off, ANSI when on (AC-2)', () => {
    expect(renderConsole(mixed, { color: false })).not.toContain(ESC);
    expect(renderConsole(mixed, { color: true })).toContain(ESC);
  });

  it('collapses an all-pass run (no per-row output)', () => {
    const out = renderConsole(allPass, { color: false });
    expect(out).toContain('e-ok');
    expect(out).toMatch(/2 .*passed/i);
    expect(out).not.toContain('one');
  });

  it('truncates long failure output', () => {
    const out = renderConsole(withLongOutput(50), { color: false, maxOutputChars: 50 });
    expect(out).toContain('truncated');
  });

  it('uses defaults when no options are given (color off, default max)', () => {
    const out = renderConsole(allPass); // no opts
    expect(out).toContain('e-ok');
    expect(out).not.toContain(ESC);
  });

  it('renders a failing assertion with neither reason nor score, and null output', () => {
    const fixture: RunResult = {
      schemaVersion: 1,
      plune_version: '0',
      started_at: 'a',
      finished_at: 'b',
      config_hash: 'z'.repeat(64),
      summary: { total: 1, passed: 0, failed: 1, errored: 0, cost_usd: 0, duration_ms: 1 },
      evals: [
        {
          id: 'e',
          tags: [],
          passed: false,
          rows: [{ vars: {}, output: null, cached: false, assertions: [{ type: 'contains', passed: false }] }],
        },
      ],
    };
    const out = renderConsole(fixture, { color: false });
    expect(out).toContain('contains');
  });
});
