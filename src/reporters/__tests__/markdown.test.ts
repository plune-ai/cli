import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../markdown.js';
import { mixed, allPass, inconclusive, dryRun } from './fixtures.js';
import type { RunResult } from '../../types/results.js';

const ESC = String.fromCharCode(27);
const TICK = String.fromCharCode(96); // backtick

describe('renderMarkdown (AC-4, AC-9)', () => {
  it('renders a heading and a summary table', () => {
    const out = renderMarkdown(mixed, {});
    expect(out).toContain('#');
    expect(out).toContain('|');
    expect(out).toMatch(/passed/i);
    expect(out).toContain('0.0123');
  });

  it('has a Failures section with assertion, reason, and the error message', () => {
    const out = renderMarkdown(mixed, {});
    expect(out).toMatch(/failures/i);
    expect(out).toContain('e-fail');
    expect(out).toContain('llm-judge');
    expect(out).toContain('too terse');
    expect(out).toContain('provider down');
  });

  it('fences failure output and survives backticks inside it', () => {
    const fixture: RunResult = {
      schemaVersion: 1,
      plune_version: '0',
      started_at: 'a',
      finished_at: 'b',
      config_hash: 'x'.repeat(64),
      summary: { total: 1, passed: 0, failed: 1, errored: 0, cost_usd: 0, duration_ms: 1 },
      evals: [
        {
          id: 'e',
          tags: [],
          passed: false,
          rows: [
            {
              vars: {},
              output: `code ${TICK.repeat(3)}js block`,
              cached: false,
              assertions: [{ type: 'contains', passed: false }],
            },
          ],
        },
      ],
    };
    const out = renderMarkdown(fixture, {});
    expect(out).toContain('code'); // output is included
    expect(out).toContain(TICK.repeat(4)); // fence is longer than the 3-backtick run inside
  });

  it('notes when all evals passed', () => {
    expect(renderMarkdown(allPass, {})).toMatch(/passed/i);
  });

  it('contains no ANSI', () => {
    expect(renderMarkdown(mixed, {})).not.toContain(ESC);
  });

  // The breakdown, with the new rows only when they are not zero.
  it('adds Blocked and Skipped rows to the table when they are not zero', () => {
    const out = renderMarkdown(inconclusive, {});
    expect(out).toContain('| Errored | 0 |\n| Blocked | 1 |\n| Skipped | 1 |\n| Cost (USD)');
  });

  it('an all-pass report reads as it did before blocked and skipped existed', () => {
    const out = renderMarkdown(allPass, {});
    expect(out).toContain('| Errored | 0 |\n| Cost (USD)');
    expect(out).not.toMatch(/blocked|skipped|undefined/i);
    expect(out).toContain('All evals passed.');
  });

  it('lists a blocked row as neither a failure nor a pass', () => {
    const out = renderMarkdown(inconclusive, {});
    expect(out).not.toContain('— failed');
    expect(out).not.toContain('All evals passed.');
  });

  // plune-ai/cli#244 — a dry run priced the rows and ran none: a price, and no word of a verdict.
  it('CLI · run --dry-run · markdown · says the rows were priced, with no verdict', () => {
    expect(renderMarkdown(dryRun, {})).toBe(
      [
        '# Plune dry run',
        '',
        'Nothing was measured: the rows were priced, not run.',
        '',
        '| Metric | Value |',
        '| --- | --- |',
        '| Rows priced | 3 |',
        '| Estimated cost (USD) | 0.0492 |',
        '',
        '- repeated {"q":"3"}: dry run: estimate × 10 runs',
      ].join('\n'),
    );
  });

  it('CLI · run --dry-run · markdown · never says "All evals passed.", with rows or without', () => {
    const none: RunResult = {
      ...dryRun,
      summary: { ...dryRun.summary, total: 0, skipped: 0 },
      evals: [],
    };
    for (const out of [renderMarkdown(dryRun, {}), renderMarkdown(none, {})]) {
      expect(out).not.toMatch(/All evals passed|Passed|Failed|Errored|skipped/);
    }
  });
});
