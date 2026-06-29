import { describe, expect, it } from 'vitest';
import { renderJson } from '../json.js';
import type { RunResult } from '../../types/results.js';

const fixture: RunResult = {
  schemaVersion: 1,
  plune_version: '0.1.0',
  started_at: '2026-06-11T09:00:00.000Z',
  finished_at: '2026-06-11T09:00:05.000Z',
  config_hash: 'c'.repeat(64),
  summary: { total: 1, passed: 1, failed: 0, errored: 0, cost_usd: 0.01, duration_ms: 5000 },
  evals: [
    { id: 'e1', tags: ['smoke'], passed: true, rows: [{ vars: { q: 'hi' }, output: 'hi', cached: false, assertions: [{ type: 'exact-match', passed: true }] }] },
  ],
};

describe('renderJson (AC-3, AC-8)', () => {
  it('round-trips the RunResult exactly', () => {
    expect(JSON.parse(renderJson(fixture))).toEqual(fixture);
  });
});
