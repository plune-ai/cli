// Stubs through a whole run: the config and the stub files are read from disk, the eval's own model call goes
// through the real provider client to the real stub server on 127.0.0.1, and the provider a run would call
// without stubs is a fake, so no test here can reach a network. The retries are the client's own and take
// real time: half a second before the second attempt, a second before the third.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleRun } from '../run.js';
import { run as publicRun } from '../../../index.js';
import { exitCodeFor, loadDataset, RunConfigError, type RunDeps } from '../../../orchestrator/index.js';
import { getProvider } from '../../../providers/index.js';
import { start, type MockScope, type MockServer } from '../../../mock/server.js';
import type { CompletionResponse } from '../../../types/provider.js';
import type { Config } from '../../../types/config.js';

const KEY = 'sk-test-john-doe-0001';
const usage = { input_tokens: 1, output_tokens: 1 };

/** What the provider says when no stub stands in for it: the answer of the fake, or a judge's verdict. */
const live = vi.fn(async (req: { prompt_resolved: string }): Promise<CompletionResponse> => ({
  output: req.prompt_resolved.includes('Respond ONLY with JSON')
    ? '{"score": 1, "reason": "fine"}'
    : 'the live provider answered',
  usage,
}));

const store = new Map<string, CompletionResponse>();
const cache = {
  get: vi.fn((key: string) => store.get(key)),
  set: vi.fn((key: string, value: CompletionResponse) => void store.set(key, value)),
  delete: vi.fn(),
  clear: () => {},
  close: () => {},
};

/** The scopes the run opened on a server this file started, in the order they were opened. */
let scopes: MockScope[];
let servers: number;
/** The origins the run asked a stubbed provider for. */
let origins: string[];

const stubServer = async (): Promise<MockServer> => {
  servers += 1;
  const server = await start();
  return {
    ...server,
    scope: (name, stubs) => {
      const scope = server.scope(name, stubs);
      scopes.push(scope);
      return scope;
    },
  };
};

const deps =
  (extra: Partial<RunDeps> = { stubServer }) =>
  (_config: Config, baseDir: string): RunDeps => ({
    resolveProvider: (cfg, stubOrigin) => {
      if (stubOrigin === undefined) return { complete: live, estimateCost: () => ({ cost_usd: 0 }) };
      origins.push(stubOrigin);
      return getProvider(cfg, { ANTHROPIC_API_KEY: KEY, OPENAI_API_KEY: KEY, OPENROUTER_API_KEY: KEY }, undefined, stubOrigin);
    },
    embedder: { embed: async (t) => t.map(() => Float32Array.from([1, 0, 0])) },
    cache,
    now: () => 1000,
    loadDataset,
    baseDir,
    ...extra,
  });

const message = (text: string) => ({
  type: 'message',
  role: 'assistant',
  content: [{ type: 'text', text }],
  stop_reason: 'end_turn',
  usage,
});
const chat = (text: string) => ({
  choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
});
const answers = (text: string) => ({ path: '/v1/messages', response: { json: message(text) } });

interface EvalSpec {
  id: string;
  stubs?: unknown[] | string;
  contains?: string;
  rows?: number;
  [key: string]: unknown;
}

let tmpDir: string;
let stderr: string;

/** Writes plune.yaml (as JSON, which YAML reads) and one stub file per eval that has stubs; returns the config path. */
function write(evals: EvalSpec[], provider: Record<string, unknown> = {}): string {
  const config = {
    version: 1,
    provider: { type: 'anthropic', model: 'm', ...provider },
    evals: evals.map(({ id, stubs, contains = 'Refund approved', rows = 1, ...rest }) => {
      if (Array.isArray(stubs))
        fs.writeFileSync(path.join(tmpDir, `${id}.stubs.json`), JSON.stringify({ version: 1, stubs }));
      return {
        id,
        ...(stubs === undefined ? {} : { stubs: Array.isArray(stubs) ? `${id}.stubs.json` : stubs }),
        prompt: 'Can order {{order}} be refunded?',
        dataset: { examples: Array.from({ length: rows }, (_, i) => ({ vars: { order: 1042 + i } })) },
        assertions: [{ type: 'contains', value: contains }],
        ...rest,
      };
    }),
  };
  const configPath = path.join(tmpDir, 'plune.yaml');
  fs.writeFileSync(configPath, JSON.stringify(config));
  return configPath;
}

const run = (configPath: string, options: Record<string, unknown> = {}, factory = deps()) =>
  handleRun({ dryRun: false, configPath, ...options }, factory);
const rejection = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );
/** The lines the run wrote about stubs; a line about a model without a price is not one of them. */
const warnings = () => stderr.split('\n').filter((line) => line.startsWith('warning: eval '));
const journalOf = (name: string) => scopes.find((s) => s.name === name)!.journal;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-run-stubs-'));
  scopes = [];
  origins = [];
  servers = 0;
  stderr = '';
  store.clear();
  vi.clearAllMocks();
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('CLI · run · stubs · the example of the configuration guide', () => {
  // The two files as the guide prints them, so the documented example is the one that is run.
  const guide = fs.readFileSync(
    fileURLToPath(new URL('../../../../docs/guide/configuration.md', import.meta.url)),
    'utf8',
  );
  const block = (firstLine: string): string => {
    const found = [...guide.matchAll(/```yaml\n([^]*?)```/g)].map((m) => m[1]!).filter((b) => b.startsWith(firstLine));
    expect(found).toHaveLength(1);
    return found[0]!;
  };
  const example = (edit: (yaml: string) => string = (y) => y): string => {
    fs.mkdirSync(path.join(tmpDir, 'stubs'));
    fs.writeFileSync(path.join(tmpDir, 'stubs', 'refund.stubs.yaml'), block('# stubs/refund.stubs.yaml\n'));
    const configPath = path.join(tmpDir, 'plune.yaml');
    fs.writeFileSync(configPath, edit(block('# plune.yaml\n')));
    return configPath;
  };

  it('with the stub the row passes: two 500s, then the answer on the third call, counted in the journal', async () => {
    const result = await run(example());
    expect(result.summary).toMatchObject({ total: 1, passed: 1, failed: 0, errored: 0 });
    expect(exitCodeFor(result)).toBe(0);
    expect(result.evals[0]!.rows[0]!.output).toBe('Refund approved for order 1042.');
    expect(result.evals[0]!.stubs).toEqual({ never_called: [], unmatched: [] });
    expect(live).not.toHaveBeenCalled();

    const journal = journalOf('refund-survives-500.row1');
    expect(journal.map((e) => [e.method, e.path, e.matched])).toEqual([
      ['POST', '/v1/messages', true],
      ['POST', '/v1/messages', true],
      ['POST', '/v1/messages', true],
    ]);
    expect(journal[0]!.headers['x-api-key']).toBe('[masked]');
    expect(JSON.stringify(journal)).not.toContain(KEY);
    expect(warnings()).toEqual([]);
  });

  it('without the stub the same eval asks the provider and fails', async () => {
    const result = await run(example((yaml) => yaml.replace(/^\s*stubs: .*\n/m, '')));
    expect(live).toHaveBeenCalledTimes(1);
    expect(servers).toBe(0);
    expect(result.summary).toMatchObject({ total: 1, passed: 0, failed: 1 });
    expect(result.evals[0]!.stubs).toBeUndefined();
    expect(exitCodeFor(result)).toBe(1);
  });

  it('with the stub and no retries the first 500 ends the row as errored, after one call', async () => {
    const result = await run(example((yaml) => yaml.replace('  model: claude-sonnet-5-5\n', '$&  max_retries: 0\n')));
    expect(result.summary).toMatchObject({ total: 1, passed: 0, errored: 1 });
    expect(result.evals[0]!.rows[0]!.error).toMatchObject({ code: 'PROVIDER_TRANSIENT_EXHAUSTED' });
    expect(exitCodeFor(result)).toBe(2);
    expect(journalOf('refund-survives-500.row1')).toHaveLength(1);
  });
});

describe('CLI · run · stubs · the stub file', () => {
  it('a wrong field stops the run as a config error that names its place, before a server or a model call', async () => {
    // The eval ahead of it has nothing wrong, and is not run either.
    const configPath = write([
      { id: 'plain' },
      { id: 'refund', stubs: [{ path: '/v1/messages', failure: { type: 'http_503' } }] },
    ]);
    const err = await rejection(run(configPath));
    expect(err).toBeInstanceOf(RunConfigError);
    expect((err as Error).message).toMatch(/^Eval "refund": Invalid refund\.stubs\.json\n {2}stubs\.0\.failure\.type: /);
    expect([servers, origins.length, live.mock.calls.length]).toEqual([0, 0, 0]);
  });

  it('a file that is not there is a config error too, on a dry run as well', async () => {
    const configPath = write([{ id: 'refund', stubs: 'nowhere/refund.stubs.yaml' }]);
    for (const dryRun of [false, true]) {
      const err = await rejection(run(configPath, { dryRun }));
      expect(err).toBeInstanceOf(RunConfigError);
      expect((err as Error).message).toBe('Eval "refund": stubs file not found: nowhere/refund.stubs.yaml');
    }
    expect([servers, live.mock.calls.length]).toEqual([0, 0]);
  });

  it('the file of an eval --only leaves out is not read, and no server starts for the rest', async () => {
    const configPath = write([{ id: 'plain', contains: 'live provider' }, { id: 'refund', stubs: 'nowhere.yaml' }]);
    const result = await run(configPath, { only: ['plain'] });
    expect(result.summary).toMatchObject({ total: 1, passed: 1 });
    expect(servers).toBe(0);
  });

  it('--cache-strict with an eval that has stubs is a config error', async () => {
    const configPath = write([{ id: 'refund', stubs: [answers('Refund approved')] }]);
    const err = await rejection(run(configPath, { cacheStrict: true }));
    expect(err).toBeInstanceOf(RunConfigError);
    expect((err as Error).message).toMatch(/Eval "refund" has stubs.*--cache-strict/);
    expect(servers).toBe(0);
  });
});

describe('CLI · run · stubs · the server of a run', () => {
  it('--dry-run starts no server and calls nothing', async () => {
    const configPath = write([{ id: 'refund', stubs: [answers('Refund approved')] }]);
    const result = await run(configPath, { dryRun: true });
    expect(result.dry_run).toBe(true);
    expect(result.evals[0]!.stubs).toBeUndefined();
    expect([servers, origins.length, live.mock.calls.length]).toEqual([0, 0, 0]);
  });

  it('an error thrown in the middle of the run still closes the server: its port can be bound at once', async () => {
    const configPath = write([{ id: 'refund', stubs: [answers('Refund approved')] }]);
    let origin = '';
    // The run's own server, not one of this file's.
    const factory = deps({
      resolveProvider: (_cfg, stubOrigin) => {
        if (stubOrigin === undefined) return { complete: live, estimateCost: () => ({ cost_usd: 0 }) };
        origin = stubOrigin;
        throw new Error('thrown in the middle of the run');
      },
    });
    const err = await rejection(run(configPath, {}, factory));
    expect((err as Error).message).toBe('thrown in the middle of the run');
    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/refund\.row1$/);

    const again = await start({ port: Number(new URL(origin).port) });
    await again.close();
  });

  it('a run that ends well closes the server too', async () => {
    const configPath = write([{ id: 'refund', stubs: [answers('Refund approved')] }]);
    const result = await run(configPath, {}, deps({}));
    expect(result.summary).toMatchObject({ total: 1, passed: 1 });
    const again = await start({ port: Number(new URL(origins[0]!).port) });
    await again.close();
  });

  it('two evals with a stub for the same path each get their own answer, one server for both', async () => {
    const configPath = write([
      { id: 'alpha', stubs: [answers('alpha says yes')], contains: 'alpha says yes', rows: 2 },
      { id: 'beta', stubs: [answers('beta says no')], contains: 'beta says no', rows: 2 },
    ]);
    const result = await run(configPath);
    expect(result.summary).toMatchObject({ total: 4, passed: 4 });
    expect(servers).toBe(1);
    expect(scopes.map((s) => s.name).sort()).toEqual(['alpha.row1', 'alpha.row2', 'beta.row1', 'beta.row2']);
    for (const scope of scopes) expect(scope.journal.map((e) => e.scope)).toEqual([scope.name]);
  });

  it('rows that run in parallel, and the repeats of a row, each count failure.first from zero', async () => {
    const stub = { ...answers('Refund approved'), failure: { type: 'http_500', first: 1 } };
    const configPath = write([{ id: 'refund', stubs: [stub], rows: 2, runs: 2 }], { max_retries: 1 });
    const result = await run(configPath);
    expect(result.summary).toMatchObject({ total: 2, passed: 2 });
    expect(Object.fromEntries(scopes.map((s) => [s.name, s.journal.length]))).toEqual({
      'refund.row1.run1': 2,
      'refund.row1.run2': 2,
      'refund.row2.run1': 2,
      'refund.row2.run2': 2,
    });
  });

  it('each provider type is sent to the path of its own API', async () => {
    const reply = { response: { json: chat('Refund approved') } };
    const configPath = write([
      { id: 'a', stubs: [answers('Refund approved')] },
      { id: 'b', provider: { type: 'openai' }, stubs: [{ path: '/v1/chat/completions', ...reply }] },
      { id: 'c', provider: { type: 'openrouter' }, stubs: [{ path: '/api/v1/chat/completions', ...reply }] },
    ]);
    const result = await run(configPath);
    expect(result.summary).toMatchObject({ total: 3, passed: 3 });
    expect(scopes.map((s) => s.journal.map((e) => e.path))).toEqual([
      ['/v1/messages'],
      ['/v1/chat/completions'],
      ['/api/v1/chat/completions'],
    ]);
  });
});

describe('CLI · run · stubs · what is not stubbed', () => {
  it('a judge call goes to the provider, not to the stub server, also when the judge is the eval own model', async () => {
    const configPath = write([
      {
        id: 'refund',
        stubs: [answers('Refund approved')],
        assertions: [{ type: 'llm-judge', criteria: 'The answer approves the refund.' }],
      },
    ]);
    const result = await run(configPath);
    expect(result.summary).toMatchObject({ total: 1, passed: 1 });
    expect(result.evals[0]!.rows[0]!.assertions).toMatchObject([{ type: 'llm-judge', passed: true, judge_model: 'anthropic/m' }]);
    expect(live).toHaveBeenCalledTimes(1);
    expect(live.mock.calls[0]![0].prompt_resolved).toContain('The answer approves the refund.');
    expect(journalOf('refund.row1')).toHaveLength(1);
  });

  it('the cache is neither read nor written: a second run calls the stub again', async () => {
    const configPath = write([{ id: 'refund', stubs: [answers('Refund approved')] }]);
    for (const nth of [1, 2]) {
      const result = await run(configPath);
      expect(result.summary).toMatchObject({ total: 1, passed: 1 });
      expect(result.evals[0]!.rows[0]!.cached).toBe(false);
      expect(scopes).toHaveLength(nth);
      expect(scopes[nth - 1]!.journal).toHaveLength(1);
    }
    expect(cache.get).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
  });
});

describe('CLI · run · stubs · what the run reports', () => {
  it('a stub no request reached is a warning and is in the result, by its place in the file', async () => {
    const twin = answers('Refund approved');
    const configPath = write([
      { id: 'refund', stubs: [{ ...twin, body: { model: 'other' } }, twin, twin, { ...twin, method: 'GET' }], rows: 2 },
    ]);
    const result = await run(configPath);
    expect(result.summary).toMatchObject({ total: 2, passed: 2 });
    // Of the two stubs written alike the first answers, so it is the second that was never called.
    expect(result.evals[0]!.stubs).toEqual({ never_called: [0, 2, 3], unmatched: [] });
    expect(warnings()).toEqual([
      'warning: eval "refund": stubs.0, stubs.2, stubs.3 of refund.stubs.json were never called',
    ]);
  });

  it('a request no stub answered errors its row and is a warning with its scope and method, never its path', async () => {
    const configPath = write([{ id: 'refund', stubs: [{ path: '/v1/elsewhere', response: { text: 'x' } }], rows: 2 }]);
    const result = await run(configPath, { concurrency: 1 });
    expect(result.summary).toMatchObject({ total: 2, errored: 2 });
    expect(exitCodeFor(result)).toBe(2);
    expect(result.evals[0]!.rows[0]!.error!.message).toContain('mock_no_stub');
    expect(result.evals[0]!.stubs).toEqual({
      never_called: [0],
      unmatched: [
        { scope: 'refund.row1', method: 'POST' },
        { scope: 'refund.row2', method: 'POST' },
      ],
    });
    expect(warnings()).toEqual([
      'warning: eval "refund": stubs.0 of refund.stubs.json was never called',
      'warning: eval "refund": 2 requests matched no stub: POST in refund.row1, POST in refund.row2',
    ]);
    expect(warnings().join('\n') + JSON.stringify(result.evals[0]!.stubs)).not.toContain('/v1/messages');
  });
});

describe('CLI · run · stubs · an answer that is not the stub server own', () => {
  it('through the public run(): a resolver that ignores the stub address errors the row, keeps no output and asks no judge', async () => {
    const configPath = write([
      {
        id: 'refund',
        stubs: [answers('Refund approved')],
        assertions: [{ type: 'llm-judge', criteria: 'The answer approves the refund.' }],
      },
    ]);
    const ignores = deps({
      stubServer,
      resolveProvider: () => ({ complete: live, estimateCost: () => ({ cost_usd: 0.5 }) }),
    });
    const result = await publicRun({ dryRun: false, configPath }, ignores);
    const row = result.evals[0]!.rows[0]!;
    expect(row.output).toBeNull();
    expect(row.assertions).toEqual([]);
    expect(row.error).toEqual({
      code: 'STUB_NOT_CALLED',
      message:
        'the answer did not come from the stub server: the provider of this run was not pointed at it, so the answer is dropped',
    });
    expect(row.usage).toBeUndefined();
    expect(result.summary).toMatchObject({ total: 1, errored: 1, cost_usd: 0 });
    expect(exitCodeFor(result)).toBe(2);
    // The one call is the answer that was dropped; the judge was not asked about it.
    expect(live).toHaveBeenCalledTimes(1);
    expect(journalOf('refund.row1')).toHaveLength(0);
  });

  it('under the mock provider an eval with stubs is a config error before any call', async () => {
    const configPath = write([{ id: 'plain' }, { id: 'refund', stubs: [answers('Refund approved')] }]);
    const saved = process.env['PLUNE_MOCK_PROVIDER'];
    process.env['PLUNE_MOCK_PROVIDER'] = '1';
    try {
      const err = await rejection(handleRun({ dryRun: false, configPath, noCache: true }));
      expect(err).toBeInstanceOf(RunConfigError);
      expect((err as Error).message).toBe(
        'Eval "refund" has stubs, and this run cannot start a stub server (PLUNE_MOCK_PROVIDER=1 answers every call itself and takes no stubs)',
      );
      expect(fs.existsSync(path.join(tmpDir, '.plune', 'last-run.json'))).toBe(false);
      // Without that eval the mock provider runs as before.
      const result = await handleRun({ dryRun: false, configPath, noCache: true, only: ['plain'] });
      expect(result.summary.total).toBe(1);
    } finally {
      if (saved === undefined) delete process.env['PLUNE_MOCK_PROVIDER'];
      else process.env['PLUNE_MOCK_PROVIDER'] = saved;
    }
  });
});

describe('CLI · run · stubs · a stubbed row is marked and costs nothing', () => {
  const paid = { ...message('Refund approved'), usage: { input_tokens: 1000, output_tokens: 1000 } };
  const stub = { path: '/v1/messages', response: { json: paid } };
  // A model with a price in the built-in table, so the same usage from the provider would cost money.
  const priced = { model: 'claude-sonnet-5-5' };

  it('the usage a stub returns is kept and priced 0; the row and the summary say it was stubbed', async () => {
    const result = await run(write([{ id: 'refund', stubs: [stub] }, { id: 'plain', contains: 'live provider' }], priced));
    const [stubbed, plain] = result.evals.map((ev) => ev.rows[0]!);
    expect(stubbed).toMatchObject({
      stubbed: true,
      cached: false,
      usage: { input_tokens: 1000, output_tokens: 1000, cost_usd: 0, priced: true },
    });
    expect(plain!.stubbed).toBeUndefined();
    expect(result.summary.cost_usd).toBe(0);
    expect(result.summary.cache).toMatchObject({ from_cache: 0, from_model: 1, missed: 0, errored: 0, stubbed: 1 });
  });

  it('a run with no stubs has no stubbed count', async () => {
    const result = await run(write([{ id: 'plain', contains: 'live provider' }]));
    expect(result.summary.cache).not.toHaveProperty('stubbed');
  });

  it('the judge call of a stubbed row is a real call and keeps its price', async () => {
    const judged = { assertions: [{ type: 'llm-judge', criteria: 'The answer approves the refund.' }] };
    const factory = deps({
      stubServer,
      resolveProvider: (cfg, stubOrigin) =>
        stubOrigin === undefined
          ? { complete: live, estimateCost: () => ({ cost_usd: 0.5, priced: true }) }
          : getProvider(cfg, { ANTHROPIC_API_KEY: KEY }, undefined, stubOrigin),
    });
    const result = await run(write([{ id: 'refund', stubs: [stub], runs: 2, ...judged }], priced), {}, factory);
    expect(result.summary).toMatchObject({ total: 1, passed: 1, cost_usd: 1 });
    expect(result.evals[0]!.rows[0]).toMatchObject({ stubbed: true, usage: { cost_usd: 1 } });
    expect(result.summary.cache).toMatchObject({ from_model: 0, stubbed: 1 });
  });
});

describe('CLI · run · stubs · a timeout stub needs a provider timeout', () => {
  const hangs = [{ path: '/v1/messages', failure: { type: 'timeout' } }];

  it('without provider.timeout the run stops as a config error that names both and the fix', async () => {
    const err = await rejection(run(write([{ id: 'plain' }, { id: 'refund', stubs: hangs }])));
    expect(err).toBeInstanceOf(RunConfigError);
    expect((err as Error).message).toBe(
      'Eval "refund": stubs.0 of refund.stubs.json is a timeout failure and the provider of the eval sets no timeout, ' +
        'so each attempt would wait as long as the provider SDK does by default (minutes): set provider.timeout, in milliseconds, at the root or on the eval',
    );
    expect([servers, live.mock.calls.length]).toEqual([0, 0]);
  });

  it('with a timeout on the eval the call gives up and the row is errored', async () => {
    const configPath = write([{ id: 'refund', stubs: hangs, provider: { timeout: 200, max_retries: 0 } }]);
    const result = await run(configPath);
    expect(result.summary).toMatchObject({ total: 1, errored: 1 });
    expect(journalOf('refund.row1')).toHaveLength(1);
  });
});

describe('CLI · run · stubs · where the stub file may be and what it may be', () => {
  const refused = async (stubs: string): Promise<string> => {
    const err = await rejection(run(write([{ id: 'refund', stubs }])));
    expect(err).toBeInstanceOf(RunConfigError);
    expect([servers, live.mock.calls.length]).toEqual([0, 0]);
    return (err as Error).message;
  };

  it('a path that leaves the folder of the config is refused, relative or absolute, and the file is not read', async () => {
    const outside = path.join(path.dirname(tmpDir), `${path.basename(tmpDir)}-outside.stubs.json`);
    fs.writeFileSync(outside, JSON.stringify({ version: 1, stubs: [answers('Refund approved')] }));
    try {
      for (const stubs of [`../${path.basename(outside)}`, `sub/../../${path.basename(outside)}`, outside, '.'])
        expect(await refused(stubs)).toBe(
          `Eval "refund": stubs must name a file inside the folder of the config: ${stubs}`,
        );
    } finally {
      fs.rmSync(outside);
    }
  });

  it('a path with ".." that stays inside the folder is taken', async () => {
    fs.mkdirSync(path.join(tmpDir, 'sub'));
    fs.writeFileSync(path.join(tmpDir, 'ok.stubs.json'), JSON.stringify({ version: 1, stubs: [answers('Refund approved')] }));
    const result = await run(write([{ id: 'refund', stubs: 'sub/../ok.stubs.json' }]));
    expect(result.summary).toMatchObject({ total: 1, passed: 1 });
  });

  it('a folder has a message of its own', async () => {
    fs.mkdirSync(path.join(tmpDir, 'stubs'));
    expect(await refused('stubs')).toBe('Eval "refund": stubs is a folder, not a file: stubs');
  });

  it('a file over 1 MiB is refused before it is read', async () => {
    fs.writeFileSync(path.join(tmpDir, 'big.stubs.yaml'), `version: 1\nstubs: []\n#${'x'.repeat(1024 * 1024)}`);
    expect(await refused('big.stubs.yaml')).toBe('Eval "refund": stubs file is over 1 MiB: big.stubs.yaml');
  });

  it('a YAML file of another kind is called not a stub file, and none of its keys is printed', async () => {
    fs.writeFileSync(path.join(tmpDir, 'other.yaml'), 'deploy_token: s3cr3t-john-doe\nservices:\n  db: {}\n');
    const message = await refused('other.yaml');
    expect(message).toBe('Eval "refund": other.yaml is not a stub file: a stub file has version: 1 at its top');
    for (const leaked of ['deploy_token', 's3cr3t', 'services']) expect(message).not.toContain(leaked);
  });
});
