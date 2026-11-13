import { describe, expect, it, vi } from 'vitest';
import { neededPasses, runOrchestration, type RunDeps, type RunOptions } from '../run.js';
import { loadDataset } from '../dataset.js';
import { cacheMissRows, exitCodeFor } from '../exit-code.js';
import { diffRuns } from '../../diff/diff.js';
import { ProviderError } from '../../providers/errors.js';
import { renderConsole } from '../../reporters/console.js';
import type { Provider } from '../../types/provider.js';
import type { Cache } from '../../cache/cache.js';
import type { Config, EvalConfig } from '../../types/config.js';
import type { RunResult } from '../../types/results.js';

// A provider that answers from a fixed script, one entry per call: `P` passes the eval's
// exact-match, `F` fails it, `E` is a provider error. No randomness anywhere.
function scripted(script: string) {
  let i = 0;
  const complete = vi.fn(async () => {
    const step = script[i % script.length];
    i += 1;
    if (step === 'E') throw new ProviderError('UPSTREAM', 'scripted failure');
    return { output: step === 'P' ? 'yes' : 'no', usage: { input_tokens: 10, output_tokens: 5 } };
  });
  const provider: Provider = {
    complete,
    estimateCost: (u) => ({ cost_usd: (u.input_tokens + u.output_tokens) * 0.001 }),
  };
  return { provider, complete };
}

function mapCache(): Cache {
  const m = new Map<
    string,
    { output: string; usage: { input_tokens: number; output_tokens: number } }
  >();
  return {
    get: (k) => m.get(k),
    set: (k, v) => void m.set(k, v),
    delete: (k) => void m.delete(k),
    clear: () => m.clear(),
    close: () => {},
  };
}

function deps(provider: Provider, cache: Cache = mapCache()): RunDeps {
  return {
    resolveProvider: () => provider,
    embedder: { embed: async (t) => t.map(() => Float32Array.from([1, 0, 0])) },
    cache,
    now: () => 1000,
    loadDataset,
    baseDir: '/x',
  };
}

function config(ev: Partial<EvalConfig>, root: Partial<Config> = {}): Config {
  return {
    version: 1,
    provider: { type: 'anthropic', model: 'm', temperature: 0, max_tokens: 256 },
    ...root,
    evals: [
      {
        id: 'e1',
        prompt: 'Q: {{q}}',
        dataset: { examples: [{ vars: { q: 'a' } }] },
        assertions: [{ type: 'exact-match', value: 'yes' }],
        ...ev,
      },
    ],
  };
}

async function run(
  script: string,
  ev: Partial<EvalConfig>,
  options: RunOptions = {},
  root: Partial<Config> = {},
): Promise<RunResult> {
  // A fresh cache per run, so scripted answers are never replayed between scenarios.
  return runOrchestration(config(ev, root), options, deps(scripted(script).provider));
}

const row = (r: RunResult) => r.evals[0]!.rows[0]!;
const status = (r: RunResult) =>
  r.summary.passed ? 'passed' : r.summary.failed ? 'failed' : 'errored';

describe('CLI · run · repeats · the threshold verdict', () => {
  it('7 of 10 passes at pass_threshold 0.7, fails at 0.8', async () => {
    const at07 = await run('PPPPPPPFFF', { runs: 10, pass_threshold: 0.7 });
    expect(status(at07)).toBe('passed');
    expect(row(at07).attempts).toMatchObject({
      runs: 10,
      pass_threshold: 0.7,
      passed: 7,
      failed: 3,
      errored: 0,
    });
    expect(row(at07).attempts!.results).toHaveLength(10);

    const at08 = await run('PPPPPPPFFF', { runs: 10, pass_threshold: 0.8 });
    expect(status(at08)).toBe('failed');
    expect(at08.evals[0]!.passed).toBe(false);
  });

  it('an attempt that could not be measured makes the row errored, not failed', async () => {
    // 6 passed + 3 errored could still reach 8: the verdict depends on what was not measured.
    const open = await run('PPPPPPEEEF', { runs: 10, pass_threshold: 0.8 });
    expect(status(open)).toBe('errored');
    expect(row(open).attempts).toMatchObject({ passed: 6, failed: 1, errored: 3 });
    expect(row(open).error?.code).toBe('UPSTREAM');

    // 5 passed + 2 errored cannot reach 8 whatever the two would have said.
    const closed = await run('PPPPPEEFFF', { runs: 10, pass_threshold: 0.8 });
    expect(status(closed)).toBe('failed');
  });

  it('the row fields describe the first attempt whose state matches the verdict', async () => {
    const r = await run('FPPPPPPPPP', { runs: 10, pass_threshold: 0.9 });
    expect(status(r)).toBe('passed');
    expect(row(r).output).toBe('yes');
    expect(row(r).assertions.every((a) => a.passed)).toBe(true);

    const f = await run('PPPPPFPPFF', { runs: 10, pass_threshold: 0.9 });
    expect(status(f)).toBe('failed');
    expect(row(f).output).toBe('no');
  });

  it('pass_threshold defaults to 1 and the eval value wins over the root one', async () => {
    expect(status(await run('PPPPF', { runs: 5 }))).toBe('failed');
    expect(status(await run('PPPPF', { runs: 5 }, {}, { pass_threshold: 0.8 }))).toBe('passed');
    expect(
      status(await run('PPPPF', { runs: 5, pass_threshold: 1 }, {}, { pass_threshold: 0.8 })),
    ).toBe('failed');
    expect(row(await run('PPPPP', {}, {}, { runs: 5 })).attempts?.runs).toBe(5);
  });

  it('--runs overrides runs from the config for one run', async () => {
    const r = await run('P', { runs: 10 }, { runs: 3 });
    expect(row(r).attempts?.runs).toBe(3);
    await expect(run('P', {}, { runs: 0 })).rejects.toThrow(/--runs/);
    await expect(run('P', {}, { runs: 101 })).rejects.toThrow(/--runs/);
  });

  it('without runs the row carries no attempts, and runs: 1 is the same single attempt', async () => {
    expect(row(await run('P', {}))).not.toHaveProperty('attempts');
    expect(row(await run('P', { runs: 1, pass_threshold: 0.5 }))).not.toHaveProperty('attempts');
  });
});

describe('CLI · run · repeats · needed passes without floating-point drift', () => {
  it.each([
    [0.7, 7],
    [0.9, 9],
    [0.3, 3],
    [1, 10],
  ])('pass_threshold %s with runs 10 needs exactly %s', (threshold, needed) => {
    expect(neededPasses(threshold, 10)).toBe(needed);
  });

  it.each([
    // These products land just above the integer in binary floating point (0.07 × 100 is
    // 7.000000000000001), so a bare ceil would ask for one pass more than the threshold says.
    [0.07, 100, 7],
    [0.28, 25, 7],
    [0.55, 100, 55],
  ])('pass_threshold %s with runs %s needs exactly %s', (threshold, runs, needed) => {
    expect(neededPasses(threshold, runs)).toBe(needed);
  });

  it('never needs fewer than one pass', () => {
    expect(neededPasses(1e-12, 10)).toBe(1);
  });
});

describe('CLI · run · repeats · the cache', () => {
  it('ten runs call the model ten times, and a second run replays all ten from the cache', async () => {
    const { provider, complete } = scripted('P');
    const cache = mapCache();
    const cfg = config({ runs: 10 });

    const first = await runOrchestration(cfg, {}, deps(provider, cache));
    expect(complete).toHaveBeenCalledTimes(10);
    expect(row(first).attempts!.results.map((a) => a.cached)).toEqual(Array(10).fill(false));
    expect(row(first).cached).toBe(false);

    const second = await runOrchestration(cfg, {}, deps(provider, cache));
    expect(complete).toHaveBeenCalledTimes(10);
    expect(row(second).attempts!.results.map((a) => a.cached)).toEqual(Array(10).fill(true));
    expect(row(second).cached).toBe(true);
    // One row is one answer in the cache summary, whatever its attempt count.
    expect(second.summary.cache).toMatchObject({
      from_cache: 1,
      from_model: 0,
      missed: 0,
      errored: 0,
    });
    expect(second.summary.cache!.saved.cost_usd).toBeCloseTo(10 * 15 * 0.001, 10);
  });

  it('a row with some attempts from the cache counts as from the model', async () => {
    const { provider } = scripted('P');
    const cache = mapCache();
    await runOrchestration(config({ runs: 3 }), {}, deps(provider, cache));
    const r = await runOrchestration(config({ runs: 5 }), {}, deps(provider, cache));
    expect(row(r).attempts!.results.map((a) => a.cached)).toEqual([true, true, true, false, false]);
    expect(row(r).cached).toBe(false);
    expect(r.summary.cache).toMatchObject({ from_cache: 0, from_model: 1 });
    expect(r.summary.cache!.saved.cost_usd).toBeCloseTo(3 * 15 * 0.001, 10);
  });
});

describe('CLI · run · repeats · --cache-strict', () => {
  it('names a row whose verdict passed while one of its attempts had no cache entry', async () => {
    const { provider, complete } = scripted('P');
    const cache = mapCache();
    await runOrchestration(config({ runs: 9 }), {}, deps(provider, cache));
    const r = await runOrchestration(
      config({ runs: 10, pass_threshold: 0.9 }),
      { cacheStrict: true },
      deps(provider, cache),
    );
    expect(complete).toHaveBeenCalledTimes(9);
    expect(status(r)).toBe('passed');
    expect(cacheMissRows(r)).toEqual(['e1 {"q":"a"}']);
  });
});

describe('CLI · run · repeats · cost', () => {
  it('the row usage and the run cost are the sum over every attempt', async () => {
    const r = await run('PPFPP', { runs: 5, pass_threshold: 0.6 });
    const perAttempt = row(r).attempts!.results.map((a) => a.usage!.cost_usd);
    const sum = perAttempt.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(5 * 15 * 0.001, 10);
    expect(row(r).usage!.cost_usd).toBeCloseTo(sum, 10);
    expect(row(r).usage!.input_tokens).toBe(50);
    expect(r.summary.cost_usd).toBeCloseTo(sum, 10);
  });

  it('--dry-run prices runs times one attempt and shows the multiplier', async () => {
    const single = await runOrchestration(
      config({}),
      { dryRun: true },
      deps(scripted('P').provider),
    );
    const ten = await runOrchestration(
      config({ runs: 10 }),
      { dryRun: true },
      deps(scripted('P').provider),
    );
    expect(ten.summary.cost_usd).toBeCloseTo(10 * single.summary.cost_usd, 10);
    expect(ten.summary.cost_usd).toBeGreaterThan(0);
    expect(renderConsole(ten)).toContain('× 10 runs');
    expect(renderConsole(single)).not.toContain('runs');
  });

  // plune-ai/cli#244 — a dry run prices and measures nothing: no row, eval or summary gets a verdict.
  it('--dry-run gives a repeated row, its eval and the summary no verdict', async () => {
    const r = await runOrchestration(
      config({ runs: 10 }),
      { dryRun: true },
      deps(scripted('P').provider),
    );
    expect(r.dry_run).toBe(true);
    expect(r.summary).toMatchObject({ total: 1, passed: 0, failed: 0, errored: 0, skipped: 1 });
    expect(r.evals[0]!.passed).toBe(false);
    expect(row(r).attempts).toMatchObject({
      runs: 10,
      passed: 0,
      failed: 0,
      errored: 0,
      results: [],
    });
    expect(exitCodeFor(r)).toBe(0);
  });

  it('--dry-run --bail prices every eval: nothing failed, so nothing stops the run', async () => {
    const two = config({});
    two.evals.push({ ...two.evals[0]!, id: 'e2' });
    const r = await runOrchestration(
      two,
      { dryRun: true, bail: true },
      deps(scripted('P').provider),
    );
    expect(r.evals.map((ev) => ev.id)).toEqual(['e1', 'e2']);
    expect(r.summary.total).toBe(2);
  });

  it('a measured run carries no dry_run marker', async () => {
    expect('dry_run' in (await run('P', {}))).toBe(false);
  });
});

describe('CLI · run · repeats · plune diff reads the threshold verdict', () => {
  const at = (script: string) => run(script, { runs: 10, pass_threshold: 0.8 });

  it('9 of 10 in the baseline and 6 of 10 now is a regression', async () => {
    const d = diffRuns(await at('PPPPPPPPPF'), await at('PPPPPPFFFF'));
    expect(d.evals[0]).toMatchObject({
      baseline: 'passed',
      current: 'failed',
      status: 'regression',
    });
  });

  it('9 of 10 in the baseline and 8 of 10 now is a stable pass', async () => {
    const d = diffRuns(await at('PPPPPPPPPF'), await at('PPPPPPPPFF'));
    expect(d.evals[0]!.status).toBe('stable-pass');
  });
});
