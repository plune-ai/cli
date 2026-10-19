// plune-ai/plune#1696: the completion cache keeps only usable answers, drops unusable ones, and has a
// strict mode. Uses a real SQLite store so the behaviour is the shipped one, not a fake's.
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { runRow, runOrchestration, RunConfigError, type RowParams } from '../run.js';
import { cacheMissRows, CACHE_STRICT_EXIT } from '../exit-code.js';
import { openCache, type Cache } from '../../cache/cache.js';
import { cacheKey } from '../../util/hash.js';
import { renderConsole } from '../../reporters/console.js';
import type { CompletionResponse, Provider } from '../../types/provider.js';
import type { AssertionConfig, Config } from '../../types/config.js';
import type { Embedder } from '../../types/embedder.js';

const opened: Cache[] = [];
function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'plune-cache-h-')), 'cache.db');
}
function open(file: string, opts?: Parameters<typeof openCache>[1]): Cache {
  const c = openCache(file, opts);
  opened.push(c);
  return c;
}
afterEach(() => {
  for (const c of opened.splice(0)) c.close();
});

const embedder: Embedder = { embed: async (t) => t.map(() => Float32Array.from([1])) };

function provider(res: Partial<CompletionResponse>) {
  const complete = vi.fn(async () => ({
    output: 'hi',
    usage: { input_tokens: 10, output_tokens: 5 },
    ...res,
  }));
  const p: Provider = {
    complete,
    estimateCost: (u) => ({ cost_usd: (u.input_tokens + u.output_tokens) / 1000 }),
  };
  return { p, complete };
}

const providerConfig = { type: 'anthropic', model: 'm', temperature: 0, max_tokens: 256 } as const;
const KEY_INPUTS = {
  provider: 'anthropic',
  model: 'm',
  temperature: 0,
  max_tokens: 256,
  prompt_resolved: 'Q: hi',
};
const usage = { input_tokens: 10, output_tokens: 5 };

function params(cache: Cache, p: Provider, over: Partial<RowParams> = {}): RowParams {
  return {
    template: 'Q: {{q}}',
    assertions: [{ type: 'exact-match', value: 'hi' }],
    row: { vars: { q: 'hi' } },
    providerConfig,
    provider: p,
    embedder,
    cache,
    now: () => 1000,
    dryRun: false,
    noCache: false,
    ...over,
  };
}

function configOf(assertions: unknown[] = []): Config {
  return {
    version: 1,
    provider: providerConfig,
    evals: [{ id: 'e1', prompt: 'Q: {{q}}', dataset: { inline: [] }, assertions }],
  } as unknown as Config;
}

describe('write only after the answer is usable', () => {
  const cases: Array<[string, Partial<CompletionResponse>]> = [
    ['an empty answer', { output: '   ' }],
    ['an answer cut off by the token limit', { finish_reason: 'length' }],
    ['an answer carrying a provider error', { finish_reason: 'error' }],
  ];
  for (const [name, res] of cases) {
    it(`does not cache ${name}`, async () => {
      const cache = open(tmpFile());
      await runRow(params(cache, provider(res).p));
      expect(cache.get(cacheKey(KEY_INPUTS))).toBeUndefined();
    });
  }

  it('caches a normal answer', async () => {
    const cache = open(tmpFile());
    await runRow(params(cache, provider({ finish_reason: 'stop' }).p));
    expect(cache.get(cacheKey(KEY_INPUTS))?.output).toBe('hi');
  });

  it('does not cache an answer that is not the expected format, so the next run asks the model', async () => {
    const cache = open(tmpFile());
    const assertions: AssertionConfig[] = [{ type: 'json-schema', schema: { type: 'object' } }];
    const fp = provider({ output: 'not json at all' });
    await runRow(params(cache, fp.p, { assertions }));
    await runRow(params(cache, fp.p, { assertions }));
    expect(fp.complete).toHaveBeenCalledTimes(2);
    expect(cache.get(cacheKey(KEY_INPUTS))).toBeUndefined();
  });

  it('keeps a well-formed answer whose content check fails', async () => {
    const cache = open(tmpFile());
    const assertions: AssertionConfig[] = [
      { type: 'json-schema', schema: { type: 'object', required: ['a'] } },
    ];
    const r = await runRow(params(cache, provider({ output: '{"b":1}' }).p, { assertions }));
    expect(r.assertions[0]?.passed).toBe(false);
    expect(cache.get(cacheKey(KEY_INPUTS))?.output).toBe('{"b":1}');
  });
});

describe('a stored answer that does not parse', () => {
  it('is deleted and the model is called once in the same run', async () => {
    const cache = open(tmpFile());
    const assertions: AssertionConfig[] = [{ type: 'json-schema', schema: { type: 'object' } }];
    cache.set(cacheKey(KEY_INPUTS), { output: 'garbage', usage });
    const fp = provider({ output: '{"ok":true}' });
    const r = await runRow(params(cache, fp.p, { assertions }));
    expect(fp.complete).toHaveBeenCalledTimes(1);
    expect(r.cached).toBe(false);
    expect(r.assertions[0]?.passed).toBe(true);
    expect(cache.get(cacheKey(KEY_INPUTS))?.output).toBe('{"ok":true}');
  });

  it('a provider failure removes no entries', async () => {
    const cache = open(tmpFile());
    cache.set(cacheKey(KEY_INPUTS), { output: '{}', usage });
    const failing: Provider = {
      complete: async () => {
        throw new Error('boom');
      },
      estimateCost: () => ({ cost_usd: 0 }),
    };
    const r = await runRow(params(cache, failing, { noCache: true }));
    expect(r.error).toBeDefined();
    expect(cache.get(cacheKey(KEY_INPUTS))).toBeDefined();
  });
});

describe('policy version', () => {
  it('a new version makes old entries unreachable without deleting the file, and reports them once', () => {
    const file = tmpFile();
    const v1 = openCache(file, { policyVersion: 1 });
    v1.set(cacheKey(KEY_INPUTS, 1), { output: 'old', usage });
    v1.close();

    const v2 = open(file, { policyVersion: 2 });
    expect(v2.staleEntries).toBe(1);
    expect(v2.get(cacheKey(KEY_INPUTS, 1))).toBeUndefined();
    expect(v2.get(cacheKey(KEY_INPUTS, 2))).toBeUndefined();
    expect(cacheKey(KEY_INPUTS, 1)).not.toBe(cacheKey(KEY_INPUTS, 2));
    v2.close();

    const again = open(file, { policyVersion: 2 });
    expect(again.staleEntries).toBe(0); // told once, not on every run
  });

  it('a row asks the model again after the version changes', async () => {
    const cache = open(tmpFile());
    const fp = provider({});
    await runRow(params(cache, fp.p, { policyVersion: 1 }));
    await runRow(params(cache, fp.p, { policyVersion: 1 }));
    await runRow(params(cache, fp.p, { policyVersion: 2 }));
    expect(fp.complete).toHaveBeenCalledTimes(2);
  });
});

describe('--cache-strict', () => {
  it('a full cache never calls the provider', async () => {
    const cache = open(tmpFile());
    cache.set(cacheKey(KEY_INPUTS), { output: 'hi', usage });
    const fp = provider({});
    const r = await runRow(params(cache, fp.p, { cacheStrict: true }));
    expect(fp.complete).not.toHaveBeenCalled();
    expect(r.cached).toBe(true);
  });

  it('a miss answers nothing, names the row, and has its own exit code', async () => {
    const fp = provider({});
    const result = await runOrchestration(
      configOf(),
      { cacheStrict: true },
      {
        resolveProvider: () => fp.p,
        embedder,
        cache: open(tmpFile()),
        now: () => 1,
        loadDataset: () => [{ vars: { q: 'a' } }],
        baseDir: '.',
      },
    );
    expect(fp.complete).not.toHaveBeenCalled();
    expect(cacheMissRows(result)).toEqual(['e1 {"q":"a"}']);
    expect(result.summary.cache?.missed).toBe(1);
    expect(CACHE_STRICT_EXIT).toBe(5);
  });

  it('is refused together with --no-cache', async () => {
    await expect(
      runOrchestration(configOf(), { cacheStrict: true, noCache: true }, {} as never),
    ).rejects.toThrow(RunConfigError);
  });
});

describe('--cache-max-age', () => {
  it('an old entry is a miss, a fresh one a hit', async () => {
    let t = 0;
    const cache = open(tmpFile(), { now: () => t });
    cache.set(cacheKey(KEY_INPUTS), { output: 'hi', usage });
    const fp = provider({});
    t = 500;
    expect((await runRow(params(cache, fp.p, { cacheMaxAgeMs: 1000 }))).cached).toBe(true);
    t = 5000;
    expect((await runRow(params(cache, fp.p, { cacheMaxAgeMs: 1000 }))).cached).toBe(false);
    expect(fp.complete).toHaveBeenCalledTimes(1);
  });
});

describe('damaged store', () => {
  it('a damaged row is a miss and a model call, not a crash or a made-up answer', async () => {
    const file = tmpFile();
    open(file).close();
    const raw = new Database(file);
    raw
      .prepare('INSERT INTO completions VALUES (?, ?, ?, ?, ?)')
      .run(cacheKey(KEY_INPUTS), 'bad', 'many', 'many', 0);
    raw.close();
    const fp = provider({});
    const r = await runRow(params(open(file), fp.p));
    expect(fp.complete).toHaveBeenCalledTimes(1);
    expect(r.cached).toBe(false);
  });

  it('a file that is not a database degrades to always-miss', async () => {
    const file = tmpFile();
    fs.writeFileSync(file, 'this is not sqlite '.repeat(200));
    const fp = provider({});
    const r = await runRow(params(open(file), fp.p));
    expect(r.output).toBe('hi');
    expect(fp.complete).toHaveBeenCalledTimes(1);
  });

  it('a store from an older schema is rebuilt, not fatal', () => {
    const file = tmpFile();
    const raw = new Database(file);
    raw.exec(
      "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta VALUES ('schema_version', '0');",
    );
    raw.exec('CREATE TABLE completions (cache_key TEXT PRIMARY KEY, blob TEXT);');
    raw.close();
    const cache = open(file);
    cache.set('k', { output: 'x', usage });
    expect(cache.get('k')?.output).toBe('x');
  });
});

describe('summary', () => {
  it('counts cache, model and saved totals that equal the sum over rows; console and json carry them', async () => {
    const cache = open(tmpFile());
    cache.set(cacheKey(KEY_INPUTS), { output: 'hi', usage });
    const fp = provider({});
    const result = await runOrchestration(
      configOf([{ type: 'exact-match', value: 'hi' }]),
      {},
      {
        resolveProvider: () => fp.p,
        embedder,
        cache,
        now: () => 1,
        loadDataset: () => [{ vars: { q: 'hi' } }, { vars: { q: 'other' } }],
        baseDir: '.',
      },
    );
    const rows = result.evals.flatMap((e) => e.rows);
    expect(result.summary.cache).toEqual({
      from_cache: 1,
      from_model: 1,
      missed: 0,
      saved: { input_tokens: 10, output_tokens: 5, cost_usd: 0.015 },
    });
    expect(rows.reduce((n, r) => n + (r.cache_saved?.input_tokens ?? 0), 0)).toBe(10);
    expect(renderConsole(result)).toContain('cache: 1 from cache');
    const json = JSON.parse(JSON.stringify(result)) as {
      summary: { cache: { from_cache: number } };
    };
    expect(json.summary.cache.from_cache).toBe(1);
  });
});
