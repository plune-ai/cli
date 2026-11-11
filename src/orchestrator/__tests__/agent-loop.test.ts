// The tool loop with its deps replaced: a scripted model and an in-memory server session. What is checked: each
// limit stops the loop and is named, every call is in the transcript as it went, sizes are measured before the cut,
// cost is the sum of the steps, and the cache is never touched.

import { describe, expect, it, vi } from 'vitest';
import { runOrchestration, RunConfigError, type RunDeps } from '../run.js';
import {
  EXCERPT_BYTES,
  TRANSCRIPT_BYTES,
  resultText,
  runAgentRow,
  type AgentServer,
} from '../agent.js';
import { wireNames } from '../tool-names.js';
import { loadDataset } from '../dataset.js';
import { ProviderError } from '../../providers/errors.js';
import { createRedactor } from '../../mcp-testing/connect/redact.js';
import type { CallAnswer } from '../../mcp-testing/connect/tools.js';
import type { Cache } from '../../cache/cache.js';
import type { Config, McpLimits } from '../../types/config.js';
import type { CostEstimate, Provider, StepRequest, StepResponse } from '../../types/provider.js';
import type { RowResult } from '../../types/results.js';

const ok = (text: string): CallAnswer => ({
  kind: 'result',
  result: { content: [{ type: 'text', text }] },
});

interface Fake extends AgentServer {
  called: { name: string; args: Record<string, unknown> }[];
  closed: number;
}

function fakeServer(
  answers: Record<string, (args: Record<string, unknown>) => CallAnswer | Promise<CallAnswer>>,
  listed: unknown[] = Object.keys(answers).map((name) => ({
    name,
    inputSchema: { type: 'object' },
  })),
  secrets: string[] = [],
): Fake {
  const fake: Fake = {
    called: [],
    closed: 0,
    redact: createRedactor(secrets),
    listTools: () => Promise.resolve(listed),
    callTool: (name, args) => {
      fake.called.push({ name, args });
      return Promise.resolve(answers[name]!(args));
    },
    close: () => {
      fake.closed++;
      return Promise.resolve();
    },
  };
  return fake;
}

type Turn = Partial<StepResponse>;

/** A model that plays `turns` by step (the last one repeats) and records every request. */
function scripted(
  turns: Turn[] | ((req: StepRequest, step: number) => Turn | Promise<Turn>),
  cost: (
    u: { input_tokens: number; output_tokens: number },
    step: number,
  ) => CostEstimate = () => ({
    cost_usd: 0,
  }),
): Provider & { requests: StepRequest[] } {
  const requests: StepRequest[] = [];
  let costed = 0;
  return {
    requests,
    complete: () => Promise.reject(new Error('an agentic row never calls complete()')),
    respond: async (req) => {
      requests.push(structuredClone(req));
      const step = req.messages.filter((m) => m.role === 'assistant').length;
      const turn =
        typeof turns === 'function'
          ? await turns(req, step)
          : turns[Math.min(step, turns.length - 1)]!;
      const calls = turn.tool_calls ?? [];
      return {
        text: '',
        usage: { input_tokens: 10, output_tokens: 5 },
        finish_reason: calls.length > 0 ? 'tool_calls' : 'stop',
        ...turn,
        tool_calls: calls,
      };
    },
    estimateCost: (u) => cost(u, costed++),
  };
}

const call = (name: string, args: unknown = {}, id = `${name}-${Math.random()}`) => ({
  id,
  name,
  args,
});

function spyCache(): Cache & { touched: () => number } {
  const get = vi.fn(() => undefined);
  const set = vi.fn();
  const del = vi.fn();
  return {
    get,
    set,
    delete: del,
    clear: () => {},
    close: () => {},
    touched: () => get.mock.calls.length + set.mock.calls.length + del.mock.calls.length,
  };
}

function config(
  mcp: { allowed_tools?: string[]; limits?: McpLimits } = {},
  rows = 1,
  extra: Partial<Config['evals'][number]> = {},
): Config {
  return {
    version: 1,
    provider: { type: 'anthropic', model: 'm' },
    mcp: { servers: { fx: { command: 'node' } } },
    evals: [
      {
        id: 'agentic',
        prompt: 'Do {{q}}',
        dataset: {
          examples: Array.from({ length: rows }, (_, i) => ({ vars: { q: `task ${i}` } })),
        },
        assertions: [],
        mcp: { server: 'fx', ...mcp },
        ...extra,
      },
    ],
  };
}

function deps(
  provider: Provider,
  server: AgentServer | (() => Promise<AgentServer>),
  cache: Cache = spyCache(),
): RunDeps {
  return {
    resolveProvider: () => provider,
    embedder: { embed: async (t) => t.map(() => Float32Array.from([1])) },
    cache,
    now: Date.now,
    loadDataset,
    baseDir: '/x',
    connectMcp: typeof server === 'function' ? server : () => Promise.resolve(server),
  };
}

async function row(cfg: Config, d: RunDeps, options = {}): Promise<RowResult> {
  return (await runOrchestration(cfg, options, d)).evals[0]!.rows[0]!;
}

describe('CLI · run · agent loop · limits', () => {
  it('CLI · run · agent loop · a model that never stops is stopped by max_steps, named, partial (AC-2)', async () => {
    const server = fakeServer({ echo: () => ok('again') });
    const r = await row(
      config({ limits: { max_steps: 3 } }),
      deps(scripted([{ tool_calls: [call('echo')] }]), server),
    );
    expect(r.agent!.steps).toHaveLength(3);
    expect(r.agent!.stop).toEqual({ reason: 'limit', limit: 'max_steps' });
    expect(r.agent!.collection).toBe('partial');
    // The calls of the last step would reach the model in a step it may not take: they are not run.
    expect(server.called).toHaveLength(2);
    expect(r.agent!.steps[2]!.calls[0]).toMatchObject({ executed: false, is_error: false });
    expect(r.error).toBeUndefined();
  });

  it('CLI · run · agent loop · max_tool_calls stops the loop at the call past it (AC-3)', async () => {
    const server = fakeServer({ echo: () => ok('x') });
    const r = await row(
      config({ limits: { max_tool_calls: 3 } }),
      deps(scripted([{ tool_calls: [call('echo'), call('echo')] }]), server),
    );
    expect(server.called).toHaveLength(3);
    expect(r.agent!.stop).toEqual({ reason: 'limit', limit: 'max_tool_calls' });
    expect(r.agent!.steps[1]!.calls.map((c) => c.executed)).toEqual([true, false]);
    expect(r.agent!.collection).toBe('partial');
  });

  it('CLI · run · agent loop · max_total_tokens is checked after a step, so it is passed by one step at most (AC-3)', async () => {
    const server = fakeServer({ echo: () => ok('x') });
    const model = scripted([
      { tool_calls: [call('echo')], usage: { input_tokens: 50, output_tokens: 10 } },
    ]);
    const r = await row(config({ limits: { max_total_tokens: 100 } }), deps(model, server));
    expect(r.agent!.steps).toHaveLength(2);
    expect(r.usage).toMatchObject({ input_tokens: 100, output_tokens: 20 });
    expect(r.agent!.stop).toEqual({ reason: 'limit', limit: 'max_total_tokens' });
    expect(server.called).toHaveLength(1);
  });

  it('CLI · run · agent loop · timeout_ms stops a row whose model never answers (AC-3)', async () => {
    const server = fakeServer({ echo: () => ok('x') });
    const model = scripted((_req, step) =>
      step === 0 ? { tool_calls: [call('echo')] } : new Promise<Turn>(() => {}),
    );
    const r = await row(config({ limits: { timeout_ms: 50 } }), deps(model, server));
    expect(r.agent!.stop).toEqual({ reason: 'limit', limit: 'timeout_ms' });
    expect(r.agent!.steps).toHaveLength(1);
    expect(server.closed).toBe(1);
  });

  it('CLI · run · agent loop · timeout_ms also bounds a server that never connects, and closes it if it does later (AC-3)', async () => {
    const server = fakeServer({});
    let open!: (s: AgentServer) => void;
    const late = new Promise<AgentServer>((resolve) => (open = resolve));
    const r = await row(
      config({ limits: { timeout_ms: 30 } }),
      deps(scripted([{ text: 'x' }]), () => late),
    );
    expect(r.agent!.stop).toEqual({ reason: 'limit', limit: 'timeout_ms' });
    open(server);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(server.closed).toBe(1);
  });

  it('CLI · run · agent loop · a tool past tool_timeout_ms stops the loop and is recorded as a timeout (AC-3)', async () => {
    const server = fakeServer({ slow: () => ({ kind: 'timeout' }) });
    const r = await row(
      config({ limits: { tool_timeout_ms: 20 } }),
      deps(scripted([{ tool_calls: [call('slow')] }]), server),
    );
    expect(r.agent!.stop).toEqual({ reason: 'limit', limit: 'tool_timeout_ms' });
    expect(r.agent!.steps[0]!.calls[0]).toMatchObject({
      executed: true,
      is_error: true,
      error_kind: 'timeout',
    });
  });
});

describe('CLI · run · agent loop · calls', () => {
  it('CLI · run · agent loop · isError goes back to the model and the loop goes on (AC-4)', async () => {
    const server = fakeServer({
      fail: () => ({
        kind: 'result',
        result: { content: [{ type: 'text', text: 'no' }], isError: true },
      }),
    });
    const model = scripted([{ tool_calls: [call('fail', {}, 'c1')] }, { text: 'gave up' }]);
    const r = await row(config(), deps(model, server));
    expect(r.agent!.steps[0]!.calls[0]).toMatchObject({
      executed: true,
      is_error: true,
      error_kind: 'content',
    });
    expect(model.requests[1]!.messages[2]).toEqual({
      role: 'tool',
      results: [{ id: 'c1', content: 'no', is_error: true }],
    });
    expect(r.agent!.stop).toEqual({ reason: 'complete' });
    expect(r.output).toBe('gave up');
  });

  it('CLI · run · agent loop · a JSON-RPC error is a protocol error, and the loop goes on', async () => {
    const server = fakeServer({
      bad: () => ({ kind: 'error', message: 'MCP error -32602: nope' }),
    });
    const r = await row(
      config(),
      deps(scripted([{ tool_calls: [call('bad')] }, { text: 'ok' }]), server),
    );
    expect(r.agent!.steps[0]!.calls[0]).toMatchObject({
      is_error: true,
      error_kind: 'protocol',
      result: { text: 'MCP error -32602: nope' },
    });
    expect(r.agent!.stop.reason).toBe('complete');
  });

  it('CLI · run · agent loop · a server lost mid-run errors the row and keeps the transcript (AC-4)', async () => {
    const server = fakeServer({
      echo: () => ok('x'),
      crash: () => ({ kind: 'lost', message: 'The server process exited.' }),
    });
    const r = await row(
      config(),
      deps(scripted([{ tool_calls: [call('echo')] }, { tool_calls: [call('crash')] }]), server),
    );
    expect(r.error).toEqual({ code: 'MCP_SERVER_LOST', message: 'The server process exited.' });
    expect(r.output).toBeNull();
    expect(r.agent!.steps).toHaveLength(2);
    expect(r.agent!.stop).toEqual({ reason: 'error' });
    expect(r.agent!.collection).toBe('partial');
    expect(r.usage).toMatchObject({ input_tokens: 20 });
  });

  it('CLI · run · agent loop · a tool the model was not offered is not run, and is a tool error (AC-5)', async () => {
    const server = fakeServer({ echo: () => ok('x'), drop: () => ok('dropped') });
    const model = scripted([
      { tool_calls: [call('drop', {}, 'c1'), call('invented', {}, 'c2')] },
      { text: 'done' },
    ]);
    const r = await row(config({ allowed_tools: ['echo'] }), deps(model, server));
    expect(model.requests[0]!.tools.map((t) => t.name)).toEqual(['echo']);
    expect(r.agent!.tools).toEqual([
      { name: 'echo', offered: true },
      { name: 'drop', offered: false },
    ]);
    expect(r.agent!.steps[0]!.calls).toMatchObject([
      { name: 'drop', executed: false, is_error: true, error_kind: 'not-offered' },
      { name: 'invented', executed: false, is_error: true, error_kind: 'not-offered' },
    ]);
    expect(server.called).toEqual([]);
    expect(model.requests[1]!.messages[2]).toMatchObject({
      results: [
        { id: 'c1', is_error: true },
        { id: 'c2', is_error: true },
      ],
    });
  });

  it('CLI · run · agent loop · arguments that are not a JSON object are not run', async () => {
    const server = fakeServer({ echo: () => ok('x') });
    const model = scripted([
      {
        tool_calls: [
          { id: 'a', name: 'echo', args: '{"text":', args_invalid: true },
          call('echo', [1]),
        ],
      },
      { text: 'done' },
    ]);
    const r = await row(config(), deps(model, server));
    expect(r.agent!.steps[0]!.calls.map((c) => c.error_kind)).toEqual([
      'bad-arguments',
      'bad-arguments',
    ]);
    expect(server.called).toEqual([]);
  });

  it('CLI · run · agent loop · files/read reaches the model as a safe name and stays files/read in the transcript (AC-6)', async () => {
    const server = fakeServer({ 'files/read': () => ok('contents') });
    const model = scripted((req, step) =>
      step === 0 ? { tool_calls: [call(req.tools[0]!.name, { path: 'a' })] } : { text: 'read it' },
    );
    const r = await row(config(), deps(model, server));
    expect(model.requests[0]!.tools[0]!.name).toBe('files_read');
    expect(r.agent!.steps[0]!.calls[0]!.name).toBe('files/read');
    expect(server.called).toEqual([{ name: 'files/read', args: { path: 'a' } }]);
  });

  it('CLI · run · agent loop · a 1 MiB result is measured before the cut, and the model gets all of it (AC-7)', async () => {
    const big = 'é'.repeat(512 * 1024); // 1 MiB in UTF-8, two bytes a character
    const server = fakeServer({ big: () => ok(big) });
    const model = scripted([{ tool_calls: [call('big')] }, { text: 'done' }]);
    const r = await row(config(), deps(model, server));
    const result = r.agent!.steps[0]!.calls[0]!.result!;
    expect(result.bytes).toBeGreaterThanOrEqual(1048576);
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(EXCERPT_BYTES);
    expect(result.text).not.toContain('�');
    expect(result.truncated).toBe(true);
    expect(r.agent!.collection).toBe('partial');
    const sent = model.requests[1]!.messages[2] as { results: { content: string }[] };
    expect(sent.results[0]!.content).toHaveLength(big.length);
  });

  it('CLI · run · agent loop · past the transcript budget an excerpt is empty and marked cut', async () => {
    const chunk = 'y'.repeat(EXCERPT_BYTES);
    const server = fakeServer({ echo: () => ok(chunk) });
    const n = TRANSCRIPT_BYTES / EXCERPT_BYTES + 1;
    const r = await row(
      config({ limits: { max_steps: n + 2, max_tool_calls: n + 2 } }),
      deps(
        scripted((_q, step) => (step < n ? { tool_calls: [call('echo')] } : { text: 'end' })),
        server,
      ),
    );
    const last = r.agent!.steps[n - 1]!.calls[0]!.result!;
    expect(last).toEqual({ text: '', bytes: EXCERPT_BYTES, truncated: true });
    expect(r.agent!.stop.reason).toBe('complete');
    expect(r.agent!.collection).toBe('partial');
  });

  it('CLI · run · agent loop · every call is recorded in order with its step, args, time and result (AC-1)', async () => {
    const server = fakeServer({ echo: (a) => ok(String(a.text)), 'files/read': () => ok('file') });
    const model = scripted([
      {
        text: 'looking',
        tool_calls: [call('echo', { text: 'hi' }, 'e1'), call('files_read', { path: 'p' }, 'f1')],
      },
      { text: 'all done' },
    ]);
    const r = await row(config(), deps(model, server));
    expect(r.output).toBe('all done');
    expect(r.agent!.steps.map((s) => [s.index, s.text])).toEqual([
      [1, 'looking'],
      [2, 'all done'],
    ]);
    expect(r.agent!.steps[0]!.calls).toMatchObject([
      {
        id: 'e1',
        name: 'echo',
        args: { text: 'hi' },
        executed: true,
        is_error: false,
        result: { text: 'hi', bytes: 2, truncated: false },
      },
      { id: 'f1', name: 'files/read', args: { path: 'p' }, executed: true, is_error: false },
    ]);
    for (const c of r.agent!.steps[0]!.calls) expect(typeof c.duration_ms).toBe('number');
    expect(r.agent!.collection).toBe('complete');
    expect(server.closed).toBe(1);
  });
});

describe('CLI · run · agent loop · cost, cache and errors', () => {
  it('CLI · run · agent loop · the row costs the sum of its steps, and one unpriced step makes it unpriced (AC-8)', async () => {
    const server = fakeServer({ echo: () => ok('x') });
    const turns = [
      { tool_calls: [call('echo')] },
      { tool_calls: [call('echo')] },
      { text: 'done' },
    ];
    const priced = await row(
      config(),
      deps(
        scripted(turns, (_u, i) => ({ cost_usd: [0.1, 0.2, 0.4][i]!, priced: true })),
        server,
      ),
    );
    expect(priced.usage!.cost_usd).toBeCloseTo(0.7);
    expect(priced.usage!.priced).toBe(true);
    expect(priced.agent!.steps.map((s) => s.usage.cost_usd)).toEqual([0.1, 0.2, 0.4]);

    const oneUnpriced = await row(
      config(),
      deps(
        scripted(turns, (_u, i) =>
          i === 1 ? { cost_usd: 0, priced: false } : { cost_usd: 0.1, priced: true },
        ),
        server,
      ),
    );
    expect(oneUnpriced.usage!.cost_usd).toBeCloseTo(0.2);
    expect(oneUnpriced.usage!.priced).toBe(false);
  });

  it('CLI · run · agent loop · the provider-reported cost of a step is passed to the price', async () => {
    const server = fakeServer({});
    const model = scripted([{ text: 'x', cost_usd: 0.05 }]);
    const seen: (number | undefined)[] = [];
    model.estimateCost = (_u, reported) => {
      seen.push(reported);
      return { cost_usd: reported ?? 0, priced: true };
    };
    const r = await row(config(), deps(model, server));
    expect(seen).toEqual([0.05]);
    expect(r.usage!.cost_usd).toBe(0.05);
  });

  it('CLI · run · agent loop · an agentic row neither reads nor writes the cache (AC-9)', async () => {
    const cache = spyCache();
    const server = fakeServer({ echo: () => ok('x') });
    const r = await row(
      config(),
      deps(scripted([{ tool_calls: [call('echo')] }, { text: 'done' }]), server, cache),
    );
    expect(r.cached).toBe(false);
    expect(cache.touched()).toBe(0);
  });

  it('CLI · run · agent loop · --cache-strict with an agentic eval is a config error before any model call (AC-9)', async () => {
    const model = scripted([{ text: 'x' }]);
    await expect(
      runOrchestration(config(), { cacheStrict: true }, deps(model, fakeServer({}))),
    ).rejects.toThrow(RunConfigError);
    expect(model.requests).toEqual([]);
  });

  it('CLI · run · agent loop · a provider that cannot call tools is a config error: nothing would be measured (AC-10)', async () => {
    const plain: Provider = { complete: vi.fn(), estimateCost: () => ({ cost_usd: 0 }) };
    const run = runOrchestration(config(), {}, deps(plain, fakeServer({})));
    await expect(run).rejects.toThrow(RunConfigError);
    await expect(run).rejects.toThrow(/nothing would be measured/);
    expect(plain.complete).not.toHaveBeenCalled();
  });

  it('CLI · run · agent loop · a run without a way to connect is a config error', async () => {
    const d = { ...deps(scripted([{ text: 'x' }]), fakeServer({})) };
    delete d.connectMcp;
    await expect(runOrchestration(config(), {}, d)).rejects.toThrow(/cannot connect/);
  });

  it('CLI · run · agent loop · the checks run before the first eval runs', async () => {
    const plain: Provider = {
      complete: vi.fn(async () => ({ output: 'hi', usage: { input_tokens: 1, output_tokens: 1 } })),
      estimateCost: () => ({ cost_usd: 0 }),
    };
    const cfg = config();
    cfg.evals.unshift({
      id: 'plain',
      prompt: 'hi',
      dataset: { examples: [{ vars: {} }] },
      assertions: [],
    });
    await expect(runOrchestration(cfg, {}, deps(plain, fakeServer({})))).rejects.toThrow(
      RunConfigError,
    );
    expect(plain.complete).not.toHaveBeenCalled();
  });

  it('CLI · run · agent loop · a provider failure errors the row with its code and keeps the steps so far', async () => {
    const server = fakeServer({ echo: () => ok('x') });
    const model = scripted((_q, step) => {
      if (step === 0) return { tool_calls: [call('echo')] };
      throw new ProviderError('PROVIDER_TRANSIENT_EXHAUSTED', 'down');
    });
    const r = await row(config(), deps(model, server));
    expect(r.error).toEqual({ code: 'PROVIDER_TRANSIENT_EXHAUSTED', message: 'down' });
    expect(r.agent!.steps).toHaveLength(1);
    expect(r.agent!.stop.reason).toBe('error');
  });

  it('CLI · run · agent loop · a reply cut off by max_tokens in a call errors the row, not "no more calls"', async () => {
    const server = fakeServer({ echo: () => ok('x') });
    const r = await row(
      config(),
      deps(scripted([{ tool_calls: [call('echo')], finish_reason: 'length' }]), server),
    );
    expect(r.error?.code).toBe('AGENT_CUT_OFF');
    expect(server.called).toEqual([]);
  });

  it('CLI · run · agent loop · a provider error inside a 200 errors the row', async () => {
    const r = await row(
      config(),
      deps(scripted([{ text: '', finish_reason: 'error' }]), fakeServer({})),
    );
    expect(r.error?.code).toBe('PROVIDER_ERROR');
  });

  it('CLI · run · agent loop · a server that cannot be reached or listed errors the row', async () => {
    const unreachable = await row(
      config(),
      deps(scripted([{ text: 'x' }]), () => Promise.reject(new Error('Could not start'))),
    );
    expect(unreachable.error).toEqual({ code: 'MCP_CONNECT', message: 'Could not start' });
    expect(unreachable.usage).toBeUndefined();

    const server = fakeServer({});
    server.listTools = () => Promise.reject(new Error('MCP error -32601: no tools'));
    const unlisted = await row(config(), deps(scripted([{ text: 'x' }]), server));
    expect(unlisted.error?.code).toBe('MCP_LIST_TOOLS');
    expect(server.closed).toBe(1);
  });

  it('CLI · run · agent loop · a listing keeps one entry per name, skips nameless ones, keeps annotations', async () => {
    const listed = [
      {
        name: 'echo',
        annotations: { readOnlyHint: true },
        description: 'Echo',
        inputSchema: { type: 'object', properties: { t: {} } },
      },
      { name: 'echo' },
      { name: '' },
      'not a tool',
      { name: 'raw' },
    ];
    const model = scripted([{ text: 'x' }]);
    const r = await row(config(), deps(model, fakeServer({}, listed)));
    expect(r.agent!.tools).toEqual([
      { name: 'echo', offered: true, annotations: { readOnlyHint: true } },
      { name: 'raw', offered: true },
    ]);
    expect(model.requests[0]!.tools).toEqual([
      {
        name: 'echo',
        description: 'Echo',
        input_schema: { type: 'object', properties: { t: {} } },
      },
      { name: 'raw', input_schema: { type: 'object' } },
    ]);
  });

  it('CLI · run · agent loop · values of the server are masked in the output, the transcript and errors', async () => {
    const secret = 'sk-live-0123456789';
    const server = fakeServer(
      {
        echo: () => ok(`token ${secret}`),
        crash: () => ({ kind: 'lost', message: `lost ${secret}` }),
      },
      undefined,
      [secret],
    );
    const said = await row(
      config(),
      deps(
        scripted([{ tool_calls: [call('echo', { k: secret })] }, { text: `it was ${secret}` }]),
        server,
      ),
    );
    expect(JSON.stringify(said)).not.toContain(secret);
    expect(said.output).toBe('it was ***');
    const lost = await row(config(), deps(scripted([{ tool_calls: [call('crash')] }]), server));
    expect(lost.error?.message).toBe('lost ***');
  });

  it('CLI · run · agent loop · assertions judge the final text, and a temperature is passed on when set', async () => {
    const model = scripted([{ text: 'the answer' }]);
    const cfg = config({}, 1, {
      assertions: [{ type: 'contains', value: 'answer' }],
      provider: { temperature: 0.5 },
    });
    const r = await row(cfg, deps(model, fakeServer({})));
    expect(r.assertions).toEqual([{ type: 'contains', passed: true }]);
    expect(model.requests[0]!.temperature).toBe(0.5);
  });
});

describe('CLI · run · agent loop · run shape', () => {
  it('CLI · run · agent loop · rows run one at a time by default, each with its own session', async () => {
    let open = 0;
    let most = 0;
    const connect = async () => {
      open++;
      most = Math.max(most, open);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const s = fakeServer({});
      const close = s.close;
      s.close = () => {
        open--;
        return close();
      };
      return s;
    };
    const one = await runOrchestration(config({}, 3), {}, deps(scripted([{ text: 'x' }]), connect));
    expect(one.evals[0]!.rows).toHaveLength(3);
    expect(most).toBe(1);
    most = 0;
    await runOrchestration(
      config({}, 3),
      { concurrency: 3 },
      deps(scripted([{ text: 'x' }]), connect),
    );
    expect(most).toBe(3);
  });

  it('CLI · run · agent loop · a dry run connects nowhere and prices max_steps calls', async () => {
    const connect = vi.fn();
    const model = scripted([{ text: 'x' }], (u) => ({
      cost_usd: u.output_tokens / 1000,
      priced: true,
    }));
    const cfg = config({ limits: { max_steps: 4 } });
    cfg.provider.max_tokens = 100;
    const r = await row(
      cfg,
      { ...deps(model, fakeServer({})), connectMcp: connect },
      { dryRun: true },
    );
    expect(connect).not.toHaveBeenCalled();
    expect(r.usage).toMatchObject({ output_tokens: 400, cost_usd: 0.4, priced: true });
    expect(r.agent).toBeUndefined();
  });

  it('CLI · run · agent loop · with runs above 1 the row carries the loop of the attempt it shows', async () => {
    const r = await row(
      config({}, 1, { runs: 2 }),
      deps(scripted([{ text: 'x' }]), () => Promise.resolve(fakeServer({}))),
    );
    expect(r.attempts?.runs).toBe(2);
    expect(r.agent?.stop.reason).toBe('complete');
  });

  it('CLI · run · agent loop · runAgentRow never uses the connect of a dry run', async () => {
    const r = await runAgentRow({
      template: 'x',
      assertions: [],
      row: { vars: {} },
      providerConfig: { type: 'anthropic', model: 'm' },
      provider: scripted([{ text: 'x' }]),
      embedder: { embed: async () => [] },
      cache: spyCache(),
      now: Date.now,
      dryRun: true,
      noCache: false,
      server: 'fx',
      limits: {
        max_steps: 1,
        max_tool_calls: 1,
        max_total_tokens: 1,
        timeout_ms: 1,
        tool_timeout_ms: 1,
      },
      connect: () => Promise.reject(new Error('never')),
    });
    expect(r.usage?.output_tokens).toBe(1024);
  });
});

describe('CLI · run · agent loop · helpers', () => {
  it('CLI · run · agent loop · resultText reads text blocks, other blocks as JSON, structuredContent alone', () => {
    expect(
      resultText({
        content: [
          { type: 'text', text: 'a' },
          { type: 'image', data: 'x' },
        ],
      }),
    ).toBe('a\n{"type":"image","data":"x"}');
    expect(resultText({ content: [], structuredContent: { n: 1 } })).toBe('{"n":1}');
    expect(resultText({})).toBe('');
    expect(resultText('plain')).toBe('"plain"');
    expect(resultText(undefined)).toBe('');
  });

  it('CLI · run · agent loop · wire names: safe kept, unsafe replaced, collisions get a stable suffix, 64 at most', () => {
    const long = 'a'.repeat(70);
    const { toWire, toServer } = wireNames(['a/b', 'a_b', 'a.b', '', long, `${long}!`, 'a_b']);
    expect(toWire.get('a_b')).toBe('a_b');
    expect(toWire.get('a/b')).toBe('a_b_2');
    expect(toWire.get('a.b')).toBe('a_b_3');
    expect(toWire.get('')).toBe('tool');
    expect(toWire.get(long)).toBe('a'.repeat(64));
    expect(toWire.get(`${long}!`)).toBe(`${'a'.repeat(62)}_2`);
    for (const [wire, server] of toServer) expect(toWire.get(server)).toBe(wire);
    expect(wireNames(['a/b', 'a_b'])).toEqual(wireNames(['a/b', 'a_b']));
  });
});
