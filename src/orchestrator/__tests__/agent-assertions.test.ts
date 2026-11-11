// Tool-call assertions in the agent loop: they get the row's transcript, a heuristic goes to the advice and never to
// the row's verdict, and a check that measured nothing makes the row errored with a code of its own.

import { describe, expect, it } from 'vitest';
import { runOrchestration, toRunError, type RunDeps } from '../run.js';
import { exitCodeFor } from '../exit-code.js';
import { loadDataset } from '../dataset.js';
import { createRedactor } from '../../mcp-testing/connect/redact.js';
import { AssertionRunError } from '../../assertions/tool-calls/transcript.js';
import type { AgentServer } from '../agent.js';
import type { AssertionConfig, Config, McpLimits } from '../../types/config.js';
import type { Provider } from '../../types/provider.js';
import { adviceOf, type AgentRecord, type RunResult } from '../../types/results.js';

const server: AgentServer = {
  redact: createRedactor([]),
  listTools: () =>
    Promise.resolve([
      { name: 'echo', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
      { name: 'read', inputSchema: { type: 'object' } },
    ]),
  callTool: (_name, args) =>
    Promise.resolve({
      kind: 'result',
      result: { content: [{ type: 'text', text: JSON.stringify(args) }] },
    }),
  close: () => Promise.resolve(),
};

/** Plays `turns` by step: names of the calls to ask for, then a final answer. */
function model(turns: { name: string; args?: Record<string, unknown> }[][]): Provider {
  return {
    complete: () => Promise.reject(new Error('not used')),
    respond: (req) => {
      const step = req.messages.filter((m) => m.role === 'assistant').length;
      const calls = (turns[step] ?? []).map((c, i) => ({
        id: `${step}-${i}`,
        name: c.name,
        args: c.args ?? {},
      }));
      return Promise.resolve({
        text: calls.length === 0 ? 'done' : '',
        tool_calls: calls,
        usage: { input_tokens: 10, output_tokens: 5 },
        finish_reason: calls.length > 0 ? 'tool_calls' : 'stop',
      });
    },
    estimateCost: () => ({ cost_usd: 0 }),
  };
}

async function runWith(
  assertions: AssertionConfig[],
  turns: { name: string; args?: Record<string, unknown> }[][],
  limits: McpLimits = {},
): Promise<RunResult> {
  const config: Config = {
    version: 1,
    provider: { type: 'anthropic', model: 'm' },
    mcp: { servers: { fx: { command: 'node' } } },
    evals: [
      {
        id: 'agentic',
        prompt: 'go',
        dataset: { examples: [{ vars: {} }] },
        assertions,
        mcp: { server: 'fx', limits },
      },
    ],
  };
  const deps: RunDeps = {
    resolveProvider: () => model(turns),
    embedder: { embed: () => Promise.resolve([]) },
    cache: {
      get: () => undefined,
      set: () => {},
      delete: () => {},
      clear: () => {},
      close: () => {},
    },
    now: Date.now,
    loadDataset,
    baseDir: '/x',
    connectMcp: () => Promise.resolve(server),
  };
  return runOrchestration(config, {}, deps);
}

const REPEAT = [[{ name: 'echo', args: { q: 'a' } }], [{ name: 'echo', args: { q: 'a' } }], []];

describe('CLI · run · agent loop · tool-call assertions', () => {
  it('CLI · run · agent loop · tool-call assertions · judge the row from its transcript', async () => {
    const r = await runWith(
      [
        { type: 'tool-called', tool: 'echo' },
        { type: 'tool-not-called', tool: 'read' },
      ],
      [[{ name: 'echo' }], []],
    );
    const row = r.evals[0]!.rows[0]!;
    expect(row.error).toBeUndefined();
    expect(row.assertions).toEqual([
      { type: 'tool-called', passed: true },
      { type: 'tool-not-called', passed: true },
    ]);
    expect((row.agent as AgentRecord).advice).toBeUndefined();
  });

  it('CLI · run · agent loop · tool-call assertions · a heuristic finding is advice: not in assertions[], status unchanged (AC-7)', async () => {
    const r = await runWith(
      [{ type: 'no-repeated-call' }, { type: 'tool-called', tool: 'echo' }],
      REPEAT,
    );
    const row = r.evals[0]!.rows[0]!;
    expect(row.assertions).toEqual([{ type: 'tool-called', passed: true }]);
    expect(r.summary).toMatchObject({ passed: 1, failed: 0, errored: 0 });
    expect(exitCodeFor(r)).toBe(0);
    expect(adviceOf(row)).toEqual([
      {
        type: 'no-repeated-call',
        reason: expect.stringMatching(/step 1 echo \{"q":"a"\} then step 2 echo/) as unknown,
      },
    ]);
  });

  it('CLI · run · agent loop · tool-call assertions · a heuristic that cannot run is advice too, never an error (AC-7)', async () => {
    const r = await runWith([{ type: 'no-repeated-call', tool: 'nope' }], REPEAT);
    const row = r.evals[0]!.rows[0]!;
    expect(row.error).toBeUndefined();
    expect(adviceOf(row)).toEqual([
      { type: 'no-repeated-call', reason: expect.stringMatching(/"nope"/) as unknown },
    ]);
  });

  it('CLI · run · agent loop · tool-call assertions · max_steps: 1 and tool-not-called: errored ASSERTION_UNMEASURED, exit 2 (AC-3)', async () => {
    const r = await runWith(
      [
        { type: 'tool-not-called', tool: 'read' },
        { type: 'tool-called', tool: 'echo' },
      ],
      [[{ name: 'echo' }], []],
      { max_steps: 1 },
    );
    const row = r.evals[0]!.rows[0]!;
    expect(row.agent!.stop).toEqual({ reason: 'limit', limit: 'max_steps' });
    expect(row.error).toEqual({
      code: 'ASSERTION_UNMEASURED',
      message: expect.stringMatching(
        /^tool-not-called: not measured .*max_steps.*after it in this row were not run/,
      ) as unknown,
    });
    expect(row.assertions).toEqual([]);
    expect(exitCodeFor(r)).toBe(2);
  });

  it('CLI · run · agent loop · tool-call assertions · an unknown tool name is errored with its own code (AC-4)', async () => {
    const r = await runWith([{ type: 'tool-not-called', tool: 'delte' }], [[]]);
    expect(r.evals[0]!.rows[0]!.error).toEqual({
      code: 'ASSERTION_UNKNOWN_TOOL',
      message: expect.stringMatching(/"delte".*offered: echo, read/) as unknown,
    });
  });

  it('CLI · run · agent loop · tool-call assertions · toRunError keeps the code of an assertion error', () => {
    expect(toRunError(new AssertionRunError('ASSERTION_UNMEASURED', 'x'))).toEqual({
      code: 'ASSERTION_UNMEASURED',
      message: 'x',
    });
  });
});
