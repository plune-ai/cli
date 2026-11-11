import { describe, expect, it } from 'vitest';
import { renderConsole } from '../console.js';
import { renderMarkdown } from '../markdown.js';
import { parseRunResult } from '../../types/run-result-schema.js';
import type { AgentRecord, RunResult } from '../../types/results.js';

const REASON =
  'expected no call repeated right after itself; got step 1 echo {} then step 2 echo {}';

const run = {
  schemaVersion: 1,
  plune_version: '0.1.0',
  started_at: '2026-11-11T09:00:00.000Z',
  finished_at: '2026-11-11T09:00:01.000Z',
  config_hash: 'c'.repeat(64),
  summary: { total: 1, passed: 1, failed: 0, errored: 0, cost_usd: 0, duration_ms: 5 },
  evals: [
    {
      id: 'agentic',
      tags: [],
      passed: true,
      rows: [
        {
          vars: { q: 'a' },
          output: 'done',
          cached: false,
          assertions: [{ type: 'tool-called', passed: true }],
          agent: {
            server: 'fx',
            tools: [{ name: 'echo', offered: true }],
            steps: [],
            stop: { reason: 'complete' },
            collection: 'complete',
            advice: [{ type: 'no-repeated-call', reason: REASON }],
          },
        },
      ],
    },
  ],
} as RunResult;

describe('CLI · reporters · advice', () => {
  it('CLI · reporters · advice · the console names a passing row with advice and shows it, still as passed', () => {
    const text = renderConsole(run);
    expect(text).toContain('PASS agentic');
    expect(text).toContain(`  advice no-repeated-call: ${REASON}`);
    expect(text).toContain('1 row(s) passed');
    expect(text).not.toMatch(/\bx no-repeated-call/);
  });

  it('CLI · reporters · advice · Markdown lists it under Advice, not Failures', () => {
    const md = renderMarkdown(run);
    expect(md).toContain('## Advice');
    expect(md).toContain(`- agentic {"q":"a"}: no-repeated-call: ${REASON}`);
    expect(md).not.toContain('## Failures');
    expect(md).toContain('All evals passed.');
  });

  it('CLI · reporters · advice · a run without advice renders as before', () => {
    const plain = structuredClone(run);
    delete (plain.evals[0]!.rows[0]!.agent as AgentRecord).advice;
    expect(renderConsole(plain)).not.toContain('advice');
    expect(renderMarkdown(plain)).not.toContain('## Advice');
  });

  it('CLI · reporters · advice · the RunResult schema keeps advice', () => {
    expect(parseRunResult(run).evals[0]!.rows[0]!.agent!.advice).toEqual([
      { type: 'no-repeated-call', reason: REASON },
    ]);
  });
});
