import type { RunResult } from '../../types/results.js';

// Shared RunResult fixtures for the reporter tests (no API — pure render input).

export const mixed: RunResult = {
  schema: 1,
  plune_version: '0.1.0',
  started_at: '2026-06-11T09:00:00.000Z',
  finished_at: '2026-06-11T09:00:05.000Z',
  config_hash: 'c'.repeat(64),
  summary: { total: 3, passed: 1, failed: 1, errored: 1, cost_usd: 0.0123, duration_ms: 5000 },
  evals: [
    {
      id: 'e-pass',
      tags: [],
      passed: true,
      rows: [
        {
          vars: { q: 'a' },
          output: 'good answer',
          cached: false,
          usage: { input_tokens: 5, output_tokens: 3, cost_usd: 0.001 },
          assertions: [{ type: 'exact-match', passed: true }],
        },
      ],
    },
    {
      id: 'e-fail',
      tags: ['quality'],
      passed: false,
      rows: [
        {
          vars: { q: 'b' },
          output: 'bad answer',
          cached: false,
          usage: { input_tokens: 5, output_tokens: 3, cost_usd: 0.001 },
          assertions: [{ type: 'llm-judge', passed: false, score: 0.3, reason: 'too terse' }],
        },
      ],
    },
    {
      id: 'e-err',
      tags: [],
      passed: false,
      rows: [
        {
          vars: { q: 'c' },
          output: null,
          cached: false,
          error: { code: 'PROVIDER_TRANSIENT_EXHAUSTED', message: 'provider down' },
          assertions: [],
        },
      ],
    },
  ],
};

export const allPass: RunResult = {
  schema: 1,
  plune_version: '0.1.0',
  started_at: '2026-06-11T09:00:00.000Z',
  finished_at: '2026-06-11T09:00:01.000Z',
  config_hash: 'a'.repeat(64),
  summary: { total: 2, passed: 2, failed: 0, errored: 0, cost_usd: 0.002, duration_ms: 1000 },
  evals: [
    {
      id: 'e-ok',
      tags: [],
      passed: true,
      rows: [
        { vars: { q: '1' }, output: 'one', cached: false, assertions: [{ type: 'contains', passed: true }] },
        { vars: { q: '2' }, output: 'two', cached: true, assertions: [{ type: 'contains', passed: true }] },
      ],
    },
  ],
};

export function withLongOutput(maxLen: number): RunResult {
  return {
    schema: 1,
    plune_version: '0.1.0',
    started_at: 'a',
    finished_at: 'b',
    config_hash: 'd'.repeat(64),
    summary: { total: 1, passed: 0, failed: 1, errored: 0, cost_usd: 0, duration_ms: 1 },
    evals: [
      {
        id: 'e-long',
        tags: [],
        passed: false,
        rows: [
          {
            vars: {},
            output: 'x'.repeat(maxLen * 4),
            cached: false,
            assertions: [{ type: 'contains', passed: false, reason: 'missing' }],
          },
        ],
      },
    ],
  };
}
