import { describe, expect, it } from 'vitest';
import type { RunResult } from '../results.js';
import {
  RUN_RESULT_SCHEMA_VERSION,
  parseRunResult,
  runResultSchema,
} from '../run-result-schema.js';

// Shape emitted by `@plune-ai/cli run --format json` (mock provider), with the version field
// renamed `schema` → `schemaVersion`. Source of truth the RunResult contract must accept (DoD d).
const realCliOutput = {
  schemaVersion: 1,
  plune_version: '0.1.0',
  started_at: '2026-06-29T18:45:16.571Z',
  finished_at: '2026-06-29T18:45:17.106Z',
  config_hash: 'e45467f92e9296f7bc0e468176eabe5cbde2d7fb8ddc69ed322903b0e5216ddc',
  summary: { total: 2, passed: 2, failed: 0, errored: 0, cost_usd: 0, duration_ms: 535 },
  evals: [
    {
      id: 'smoke-exact',
      tags: ['offline'],
      rows: [
        {
          vars: { q: 'ping' },
          output: 'mock response',
          cached: true,
          usage: { input_tokens: 10, output_tokens: 5, cost_usd: 0 },
          latency_ms: 1,
          assertions: [{ type: 'exact-match', passed: true }],
        },
      ],
      passed: true,
    },
    {
      id: 'smoke-similarity',
      tags: ['offline'],
      rows: [
        {
          vars: { q: 'ping' },
          output: 'mock response',
          cached: true,
          usage: { input_tokens: 10, output_tokens: 5, cost_usd: 0 },
          latency_ms: 533,
          assertions: [{ type: 'semantic-similarity', passed: true, score: 1 }],
        },
      ],
      passed: true,
    },
  ],
};

describe('runResultSchema — accepts real CLI output (DoD d)', () => {
  it('RUN_RESULT_SCHEMA_VERSION marks the version and matches the wire `schemaVersion` field', () => {
    expect(RUN_RESULT_SCHEMA_VERSION).toBe(1);
    expect(realCliOutput.schemaVersion).toBe(RUN_RESULT_SCHEMA_VERSION);
  });

  it('parses verbatim @plune-ai/cli@0.2.3 JSON', () => {
    expect(runResultSchema.safeParse(realCliOutput).success).toBe(true);
  });

  it('accepts the canonical frozen RunResult shape', () => {
    // Typed against the golden contract in src/types/results.ts — proves the zod mirror
    // stays compatible with the frozen TypeScript type at both compile time and runtime.
    const canonical: RunResult = {
      schemaVersion: 1,
      plune_version: '0.1.0',
      started_at: '2026-06-29T00:00:00.000Z',
      finished_at: '2026-06-29T00:00:01.000Z',
      config_hash: 'abc',
      summary: { total: 1, passed: 0, failed: 1, errored: 0, cost_usd: 0, duration_ms: 1 },
      evals: [
        {
          id: 'e1',
          tags: [],
          rows: [
            {
              vars: {},
              output: null,
              cached: false,
              error: { code: 'provider_error', message: 'boom' },
              assertions: [{ type: 'exact-match', passed: false, reason: 'no output' }],
            },
          ],
          passed: false,
        },
      ],
    };
    expect(runResultSchema.safeParse(canonical).success).toBe(true);
  });
});

describe('runResultSchema — binaryVerdicts superset (DoD e)', () => {
  it('accepts an assertion record with binaryVerdicts[]{question,passed}', () => {
    const withVerdicts = structuredClone(realCliOutput);
    withVerdicts.evals[0]!.rows[0]!.assertions = [
      {
        type: 'llm-judge',
        passed: true,
        binaryVerdicts: [
          { question: 'Is the answer polite?', passed: true },
          { question: 'Is it 3 sentences or fewer?', passed: true },
        ],
      },
    ] as unknown as (typeof withVerdicts.evals)[0]['rows'][0]['assertions'];
    const parsed = parseRunResult(withVerdicts);
    const record = parsed.evals[0]!.rows[0]!.assertions[0]!;
    expect(record.binaryVerdicts?.[0]).toEqual({ question: 'Is the answer polite?', passed: true });
  });

  it('still accepts output WITHOUT binaryVerdicts (optional, additive)', () => {
    expect(runResultSchema.safeParse(realCliOutput).success).toBe(true);
  });

  it('rejects a malformed binaryVerdict (missing passed)', () => {
    const bad = structuredClone(realCliOutput);
    bad.evals[0]!.rows[0]!.assertions = [
      { type: 'llm-judge', passed: true, binaryVerdicts: [{ question: 'q' }] },
    ] as unknown as (typeof bad.evals)[0]['rows'][0]['assertions'];
    expect(runResultSchema.safeParse(bad).success).toBe(false);
  });
});

describe('runResultSchema — invalid cases are rejected', () => {
  it('rejects schema other than 1', () => {
    expect(runResultSchema.safeParse({ ...realCliOutput, schemaVersion: 2 }).success).toBe(false);
  });

  it('rejects a missing top-level field (config_hash)', () => {
    const { config_hash: _omit, ...bad } = realCliOutput;
    expect(runResultSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a summary missing a counter', () => {
    const bad = {
      ...realCliOutput,
      summary: { total: 1, passed: 1, failed: 0, errored: 0, cost_usd: 0 },
    };
    expect(runResultSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a row with a non-nullable wrong-typed output', () => {
    const bad = structuredClone(realCliOutput);
    (bad.evals[0]!.rows[0] as { output: unknown }).output = 42;
    expect(runResultSchema.safeParse(bad).success).toBe(false);
  });

  it('parseRunResult throws on an invalid value', () => {
    expect(() => parseRunResult({ ...realCliOutput, schemaVersion: 2 })).toThrow();
  });
});
