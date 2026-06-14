import { describe, it, expect } from 'vitest';
import { sha256, cacheKey, configHash } from '../hash.js';
import type { CacheKeyInputs } from '../hash.js';
import type { Config } from '../../types/config.js';

// Known SHA-256 hex values (standard test vectors)
const SHA256_EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const SHA256_ABC   = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

describe('sha256 (AC-02, AC-04)', () => {
  it('returns known hex for empty string', () => {
    expect(sha256('')).toBe(SHA256_EMPTY);
  });

  it('returns known hex for "abc"', () => {
    expect(sha256('abc')).toBe(SHA256_ABC);
  });

  it('output is lowercase hex of length 64', () => {
    const h = sha256('test');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    expect(sha256('hello world')).toBe(sha256('hello world'));
  });
});

describe('cacheKey (AC-04, AC-05, AC-06)', () => {
  const base = {
    provider: 'anthropic',
    model: 'claude-3-5-sonnet-20241022',
    temperature: 0,
    max_tokens: 1024,
    prompt_resolved: 'What is 2+2?',
  };

  it('returns a 64-char lowercase hex', () => {
    expect(cacheKey(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is identical for reordered-equal inputs (AC-04)', () => {
    const reordered = {
      model: base.model,
      prompt_resolved: base.prompt_resolved,
      max_tokens: base.max_tokens,
      provider: base.provider,
      temperature: base.temperature,
    };
    expect(cacheKey(base)).toBe(cacheKey(reordered));
  });

  it('excludes attached assertions from the identity (AC-05)', () => {
    // Two requests with identical completion inputs but DIFFERENT assertions attached.
    // cacheKey must hash ONLY the five inputs — the differing assertions must not move the digest.
    // (Fails if cacheKey ever serializes the whole input object instead of the five named fields.)
    const withJudge = { ...base, assertions: [{ type: 'llm-judge', criteria: 'helpful?' }] };
    const withExact = { ...base, assertions: [{ type: 'exact-match', value: '4' }] };
    expect(cacheKey(withJudge)).toBe(cacheKey(withExact));
    // …and both equal the bare-five-inputs digest — assertions add nothing to the identity.
    expect(cacheKey(withJudge)).toBe(cacheKey(base));
  });

  it('changes when any identity component changes (AC-06)', () => {
    expect(cacheKey({ ...base, model: 'gpt-4o' })).not.toBe(cacheKey(base));
    expect(cacheKey({ ...base, temperature: 0.5 })).not.toBe(cacheKey(base));
    expect(cacheKey({ ...base, max_tokens: 512 })).not.toBe(cacheKey(base));
    expect(cacheKey({ ...base, prompt_resolved: 'Different' })).not.toBe(cacheKey(base));
    expect(cacheKey({ ...base, provider: 'openai' })).not.toBe(cacheKey(base));
  });
});

describe('configHash (AC-02)', () => {
  it('returns a 64-char lowercase hex', () => {
    const cfg: Config = {
      version: 1,
      provider: { type: 'anthropic', model: 'claude-3-5-sonnet-20241022' },
      evals: [
        {
          id: 'e1',
          dataset: 'data/test.jsonl',
          assertions: [{ type: 'exact-match', value: 'yes' }],
          prompt: 'Prompt text',
        },
      ],
    };
    expect(configHash(cfg)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    const cfg: Config = {
      version: 1,
      provider: { type: 'openai', model: 'gpt-4o' },
      evals: [{ id: 'e1', dataset: 'data.jsonl', assertions: [{ type: 'contains', value: 'x' }], prompt: 'p' }],
    };
    expect(configHash(cfg)).toBe(configHash(cfg));
  });

  it('differs when any config field changes', () => {
    const base: Config = {
      version: 1,
      provider: { type: 'anthropic', model: 'claude-3-5-sonnet-20241022' },
      evals: [{ id: 'e1', dataset: 'd.jsonl', assertions: [{ type: 'contains', value: 'x' }], prompt: 'p' }],
    };
    const changed: Config = { ...base, provider: { type: 'openai', model: 'gpt-4o' } };
    expect(configHash(base)).not.toBe(configHash(changed));
  });
});

// ----------------------------------------------------------------------------
// T9 — property-based tests (AC-04, AC-06) + latency smoke (≤ 1 ms p95)
// ----------------------------------------------------------------------------

const BASE_INPUTS = {
  provider: 'anthropic',
  model: 'claude-3-5-sonnet-20241022',
  temperature: 0,
  max_tokens: 1024,
  prompt_resolved: 'Evaluate the following: {{input}}',
};

describe('cacheKey property-based (T9 — AC-04, AC-06)', () => {
  it('produces identical digests across ≥1000 key-order permutations (AC-04)', () => {
    // Several distinct-value bases × 5! = 120 orderings each → ≥1000 permutation checks,
    // satisfying spec §6 NFR QG-1 ("0 mismatches across ≥1000 generated permutations").
    const BASES: CacheKeyInputs[] = [
      BASE_INPUTS,
      { provider: 'openai', model: 'gpt-4o', temperature: 0.7, max_tokens: 512, prompt_resolved: 'Summarize: {{doc}}' },
      { provider: 'anthropic', model: 'claude-3-haiku', temperature: 1, max_tokens: 64, prompt_resolved: 'Classify {{x}}' },
      { provider: 'openai', model: 'o1-mini', temperature: 0, max_tokens: 4096, prompt_resolved: 'Solve {{problem}}' },
      { provider: 'anthropic', model: 'claude-3-opus', temperature: 0.3, max_tokens: 2048, prompt_resolved: 'Translate {{text}}' },
      { provider: 'openai', model: 'gpt-4o-mini', temperature: 0.5, max_tokens: 128, prompt_resolved: 'Rank {{items}}' },
      { provider: 'anthropic', model: 'claude-3-5-sonnet', temperature: 0.9, max_tokens: 256, prompt_resolved: 'Extract {{fields}}' },
      { provider: 'openai', model: 'gpt-3.5-turbo', temperature: 0.2, max_tokens: 1024, prompt_resolved: 'Answer {{q}}' },
      { provider: 'anthropic', model: 'claude-instant', temperature: 0.6, max_tokens: 768, prompt_resolved: 'Rewrite {{passage}}' },
    ];
    const keys = Object.keys(BASE_INPUTS) as (keyof CacheKeyInputs)[];

    function permute(arr: (keyof CacheKeyInputs)[]): (keyof CacheKeyInputs)[][] {
      if (arr.length <= 1) return [arr.slice()];
      const result: (keyof CacheKeyInputs)[][] = [];
      for (let i = 0; i < arr.length; i++) {
        const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
        for (const p of permute(rest)) result.push([arr[i]!, ...p]);
      }
      return result;
    }

    function buildOrdered(obj: CacheKeyInputs, orderedKeys: (keyof CacheKeyInputs)[]): CacheKeyInputs {
      const src = obj as unknown as Record<string, unknown>;
      const r: Record<string, unknown> = {};
      for (const k of orderedKeys) r[k] = src[k];
      return r as unknown as CacheKeyInputs;
    }

    let totalPermutations = 0;
    let mismatches = 0;
    for (const b of BASES) {
      const canonical = cacheKey(b);
      for (const perm of permute(keys)) {
        if (cacheKey(buildOrdered(b, perm)) !== canonical) mismatches++;
        totalPermutations++;
      }
    }

    expect(mismatches).toBe(0);
    // 9 bases × 5! = 1080 permutation checks.
    expect(totalPermutations).toBeGreaterThanOrEqual(1000);
  });

  it('≥1000 distinct requests produce 0 collisions (AC-06)', () => {
    const SAMPLE_COUNT = 1001;
    const digests = new Set<string>();

    for (let i = 0; i < SAMPLE_COUNT; i++) {
      const key = cacheKey({
        provider: i % 2 === 0 ? 'anthropic' : 'openai',
        model: `model-variant-${i}`,
        temperature: (i % 11) / 10,
        max_tokens: 256 + i,
        prompt_resolved: `Prompt text for request ${i}`.padEnd(100, '.'),
      });
      digests.add(key);
    }

    expect(digests.size).toBe(SAMPLE_COUNT);
  });
});

describe('cacheKey latency smoke (T9 — p95 ≤ 1 ms)', () => {
  it('canonicalize + fingerprint ≤ 1 ms p95 on a typical request', () => {
    const ITERATIONS = 1000;
    const longPrompt = 'x'.repeat(4096);  // 4 KB prompt (typical, well within 8 KB limit)
    const inputs = {
      ...BASE_INPUTS,
      prompt_resolved: longPrompt,
    };

    const timingsNs: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const t0 = process.hrtime.bigint();
      cacheKey(inputs);
      const t1 = process.hrtime.bigint();
      timingsNs.push(Number(t1 - t0));
    }

    timingsNs.sort((a, b) => a - b);
    const p95ns = timingsNs[Math.ceil(ITERATIONS * 0.95) - 1]!;
    const p95ms = p95ns / 1_000_000;

    expect(p95ms).toBeLessThan(1);
  });
});
