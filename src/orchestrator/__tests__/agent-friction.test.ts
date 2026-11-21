// Friction signals and `--tool-description` through the real tool loop, with a scripted model and an in-memory server.

import { describe, expect, it } from 'vitest';
import { runOrchestration, RunConfigError, type RunDeps } from '../run.js';
import type { AgentServer } from '../agent.js';
import { loadDataset } from '../dataset.js';
import { createRedactor } from '../../mcp-testing/connect/redact.js';
import { sha256 } from '../../util/hash.js';
import { parseRunResult } from '../../types/run-result-schema.js';
import type { Config } from '../../types/config.js';
import type { Provider, StepRequest, StepResponse } from '../../types/provider.js';
import type { AgentRecord, RowResult } from '../../types/results.js';

const SECRET_ID = 'ISSUE-8841-secret';
const answer = (value: unknown) => ({
  kind: 'result' as const,
  result: {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
  },
});

const LISTED = [
  { name: 'search', description: 'Search things', inputSchema: { type: 'object' } },
  { name: 'list', description: 'List things', inputSchema: { type: 'object' } },
];

function server(reply: (name: string, args: Record<string, unknown>) => unknown) {
  const s: AgentServer & { lists: number; calls: string[] } = {
    lists: 0,
    calls: [],
    redact: createRedactor([]),
    listTools: () => {
      s.lists++;
      return Promise.resolve(structuredClone(LISTED));
    },
    callTool: (name, args) => {
      s.calls.push(name);
      return Promise.resolve(answer(reply(name, args)));
    },
    close: () => Promise.resolve(),
  };
  return s;
}

type Step = { name: string; args: unknown }[];
function model(steps: Step[]): Provider & { requests: StepRequest[] } {
  const requests: StepRequest[] = [];
  return {
    requests,
    complete: () => Promise.reject(new Error('no')),
    respond: async (req) => {
      requests.push(structuredClone(req));
      const i = req.messages.filter((m) => m.role === 'assistant').length;
      const calls = (steps[i] ?? []).map((c, k) => ({
        id: `c${i}-${k}`,
        name: c.name,
        args: c.args,
      }));
      return {
        text: '',
        usage: { input_tokens: 1, output_tokens: 1 },
        finish_reason: calls.length > 0 ? 'tool_calls' : 'stop',
        tool_calls: calls,
      } as StepResponse;
    },
    estimateCost: () => ({ cost_usd: 0 }),
  };
}

const config = (): Config => ({
  version: 1,
  provider: { type: 'anthropic', model: 'm' },
  mcp: { servers: { fx: { command: 'node' } } },
  evals: [
    {
      id: 'agentic',
      prompt: 'Do {{q}}',
      dataset: { examples: [{ vars: { q: 'x' } }] },
      assertions: [],
      mcp: { server: 'fx' },
    },
  ],
});

function deps(provider: Provider, s: AgentServer): RunDeps {
  return {
    resolveProvider: () => provider,
    embedder: { embed: async (t) => t.map(() => Float32Array.from([1])) },
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
    connectMcp: () => Promise.resolve(s),
  };
}

async function run(
  steps: Step[],
  reply: Parameters<typeof server>[0],
  options = {},
  assertions: Config['evals'][number]['assertions'] = [],
) {
  const s = server(reply);
  const m = model(steps);
  const cfg = config();
  cfg.evals[0]!.assertions = assertions;
  const result = await runOrchestration(cfg, options, deps(m, s));
  return { s, m, result, row: result.evals[0]!.rows[0]! as RowResult };
}

const advice = (row: RowResult) => (row.agent as AgentRecord).advice ?? [];

describe('CLI · run · friction · in the loop', () => {
  it('CLI · run · friction · signals are computed while the whole answers are at hand and keep no identifier values (AC-9)', async () => {
    const { row, result } = await run(
      [
        [{ name: 'search', args: { q: 'a' } }],
        [{ name: 'search', args: { q: 'b' } }],
        [{ name: 'search', args: { q: 'b' } }],
      ],
      () => ({ items: [{ id: SECRET_ID }] }),
    );
    expect(
      advice(row)
        .map((a) => a.type)
        .sort(),
    ).toEqual(['identical-retry', 'search-after-id']);
    expect(advice(row).find((a) => a.type === 'search-after-id')).toMatchObject({
      tool: 'search',
      paths: ['items[].id'],
    });
    // The advice itself holds no value; the transcript's own excerpts of the results are a separate record.
    expect(JSON.stringify(advice(row))).not.toContain(SECRET_ID);
    // It is still a valid RunResult, and a passing row.
    expect(parseRunResult(result).evals[0]!.rows[0]!.agent!.advice).toHaveLength(2);
    expect(row.error).toBeUndefined();
  });

  it('CLI · run · friction · a row whose answers are not JSON says "not measured" (AC-9)', async () => {
    const { row } = await run(
      [[{ name: 'search', args: { q: 'a' } }], [{ name: 'search', args: { q: 'b' } }]],
      () => `plain text with ${SECRET_ID}`,
    );
    expect(advice(row)).toMatchObject([
      { type: 'friction-unmeasured', tool: 'search' },
      { type: 'ids-not-redacted', tool: 'search', steps: [1, 2], count: 2 },
    ]);
    expect(JSON.stringify(advice(row))).not.toContain(SECRET_ID);
  });

  it('CLI · run · friction · two searches inside one step are not search-after-id (AC-8)', async () => {
    const { row } = await run(
      [
        [
          { name: 'search', args: { q: 'a' } },
          { name: 'search', args: { q: 'b' } },
        ],
      ],
      () => ({ items: [{ id: SECRET_ID }] }),
    );
    expect(advice(row)).toEqual([]);
  });
});

describe('CLI · run · transcript · identifier values are not stored', () => {
  const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';
  const ISSUE = 'ISS-480021';
  const record = { items: [{ id: ISSUE, uuid: UUID, title: 'Login page times out' }] };
  const fixtureSteps: Step[] = [
    [{ name: 'search', args: { q: 'login timeout' } }],
    [{ name: 'list', args: { issue_id: ISSUE, ref: UUID } }],
    [{ name: 'search', args: { q: 'login page' } }],
  ];
  const fixtureChecks: Config['evals'][number]['assertions'] = [
    // Passes only on the real values: proves the checks read the transcript before the swap.
    { type: 'tool-args', tool: 'list', args: { issue_id: ISSUE, ref: UUID }, match: 'exact' },
  ];

  it('CLI · run · transcript · an identifier in args and in result.text is replaced, and checks and friction read the real values first', async () => {
    // The fixture really carries the identifiers, so "not found" below is not trivial.
    expect(JSON.stringify(record)).toContain(ISSUE);
    expect(JSON.stringify(record)).toContain(UUID);
    const { s, row, result } = await run(fixtureSteps, () => record, {}, fixtureChecks);
    expect(s.calls).toEqual(['search', 'list', 'search']);

    // The whole RunResult, as last-run.json and --format json write it, holds neither value.
    const stored = JSON.stringify(result, null, 2);
    expect(stored).not.toContain(ISSUE);
    expect(stored).not.toContain(UUID);

    const calls = row.agent!.steps.flatMap((st) => st.calls);
    // Keys and structure stay; only the values are marked.
    expect(calls[1]!.args).toEqual({ issue_id: '<id>', ref: '<id>' });
    expect(calls[0]!.args).toEqual({ q: 'login timeout' });
    expect(JSON.parse(calls[0]!.result!.text)).toEqual({
      items: [{ id: '<id>', uuid: '<id>', title: 'Login page times out' }],
    });
    // `bytes` is still the size of the real answer.
    expect(calls[0]!.result!.bytes).toBe(Buffer.byteLength(JSON.stringify(record)));

    // The check passed on the real values, and the friction signal found the shared record.
    expect(row.assertions.map((a) => a.passed)).toEqual([true]);
    expect(advice(row).find((a) => a.type === 'search-after-id')).toMatchObject({
      tool: 'search',
      steps: [1, 3],
    });
    expect(advice(row).some((a) => a.type === 'ids-not-redacted')).toBe(false);
    expect(row.error).toBeUndefined();
    expect(parseRunResult(result).evals[0]!.rows[0]!.agent!.steps).toHaveLength(4);
  });

  it('CLI · run · transcript · the reason of a failed tool-args check quotes no identifier value, and the check still fails on the real values', async () => {
    // Expected and actual args both hold the identifiers; `state` makes the exact match fail.
    const checks: Config['evals'][number]['assertions'] = [
      {
        type: 'tool-args',
        tool: 'list',
        // In this order the reason cuts the expected args inside the UUID: a part of it must not stay either.
        args: { state: 'open', issue_id: ISSUE, ref: UUID },
        match: 'exact',
      },
    ];
    const { row, result } = await run(fixtureSteps, () => record, {}, checks);
    expect(row.assertions).toHaveLength(1);
    const [check] = row.assertions;
    expect(check!.passed).toBe(false);
    expect(check!.reason).toContain('"list"');
    expect(check!.reason).toContain('"issue_id":"<id>"');
    expect(check!.reason).toContain('"state":"open"');

    const stored = JSON.stringify(result, null, 2);
    expect(stored).not.toContain(ISSUE);
    expect(stored).not.toContain(UUID);
    expect(stored).not.toContain(UUID.slice(0, 8));
  });

  it('CLI · run · transcript · a short answer the model saw whole stays whole and not truncated when its id is shorter than the mark', async () => {
    // `1` is shorter than `"<id>"`: the cleaned answer is longer than the bytes the excerpt kept.
    const note = { id: 1, title: 'Release checklist', status: 'open' };
    const { row, result } = await run([[{ name: 'search', args: { id: 1 } }]], () => note);
    const call = row.agent!.steps[0]!.calls[0]!;
    expect(call.result).toEqual({
      text: JSON.stringify({ ...note, id: '<id>' }),
      bytes: Buffer.byteLength(JSON.stringify(note)),
      truncated: false,
    });
    expect(call.args).toEqual({ id: '<id>' });
    expect(row.agent!.collection).toBe('complete');
    expect(JSON.stringify(result)).not.toMatch(/"id":1\b/);
  });

  it('CLI · run · transcript · a text answer that is not JSON has its UUIDs replaced and is marked as not fully cleaned', async () => {
    const { row, result } = await run(
      [[{ name: 'search', args: { q: 'a' } }]],
      () => `Found ${ISSUE} (${UUID})`,
    );
    const call = row.agent!.steps[0]!.calls[0]!;
    expect(call.result!.text).toBe(`Found ${ISSUE} (<id>)`);
    expect(JSON.stringify(result)).not.toContain(UUID);
    expect(advice(row)).toMatchObject([
      { type: 'ids-not-redacted', tool: 'search', steps: [1], count: 1 },
    ]);
    expect(advice(row)[0]!.reason).toContain('the answer is not JSON');
    expect(row.error).toBeUndefined();
  });
});

describe('CLI · run · tool-description · in the loop', () => {
  const NEW_TEXT = 'Find an issue by words; use this first';

  it('CLI · run · tool-description · the model is shown the new text, the server is asked as before, and the swap is recorded with its hash (AC-10)', async () => {
    const { s, m, row, result } = await run([[{ name: 'search', args: { q: 'a' } }]], () => ({}), {
      toolDescriptions: { search: NEW_TEXT },
    });
    const offered = m.requests[0]!.tools!;
    expect(offered.find((t) => t.name === 'search')!.description).toBe(NEW_TEXT);
    expect(offered.find((t) => t.name === 'list')!.description).toBe('List things');
    // The server only listed and was called; its own list is untouched and is what the transcript keeps.
    expect(s.calls).toEqual(['search']);
    expect(LISTED[0]!.description).toBe('Search things');
    expect((row.agent as AgentRecord).description_overrides).toEqual([
      { tool: 'search', sha256: sha256(NEW_TEXT) },
    ]);
    expect(JSON.stringify(row.agent)).not.toContain(NEW_TEXT);
    expect(
      (parseRunResult(result).evals[0]!.rows[0]!.agent as AgentRecord).description_overrides,
    ).toHaveLength(1);
  });

  it("CLI · run · tool-description · without the flag the description is the server's and nothing is recorded", async () => {
    const { m, row } = await run([[{ name: 'search', args: { q: 'a' } }]], () => ({}));
    expect(m.requests[0]!.tools!.find((t) => t.name === 'search')!.description).toBe(
      'Search things',
    );
    expect((row.agent as AgentRecord).description_overrides).toBeUndefined();
  });

  it('CLI · run · tool-description · a name the server does not list changes nothing and is not recorded as applied', async () => {
    const { m, row } = await run([[]], () => ({}), { toolDescriptions: { nope: 'x' } });
    expect(m.requests[0]!.tools!.map((t) => t.description)).toEqual([
      'Search things',
      'List things',
    ]);
    expect((row.agent as AgentRecord).description_overrides).toBeUndefined();
  });

  it('CLI · run · tool-description · a run with no mcp eval refuses it', async () => {
    const cfg = config();
    delete cfg.evals[0]!.mcp;
    await expect(
      runOrchestration(
        cfg,
        { toolDescriptions: { search: 'x' } },
        deps(
          model([]),
          server(() => ({})),
        ),
      ),
    ).rejects.toBeInstanceOf(RunConfigError);
  });
});
