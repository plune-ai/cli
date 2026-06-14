import { describe, expect, it, vi } from 'vitest';
import { withRetry } from '../retry.js';
import { ProviderError } from '../errors.js';

function transientErr(status = 503, headers?: Record<string, string>) {
  return { status, headers };
}

describe('withRetry (ADR-PRV03)', () => {
  it('returns the result after transient failures, then success (AC-9)', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(transientErr(503))
      .mockRejectedValueOnce(transientErr(503))
      .mockResolvedValue('ok');
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await withRetry(fn, { max_retries: 3, sleep, random: () => 0 });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('uses increasing (exponential) backoff', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(transientErr(503))
      .mockRejectedValueOnce(transientErr(503))
      .mockResolvedValue('ok');
    const delays: number[] = [];
    const sleep = vi.fn().mockImplementation((ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    });

    await withRetry(fn, { max_retries: 3, base_delay_ms: 100, sleep, random: () => 0 });

    expect(delays).toHaveLength(2);
    expect(delays[1]!).toBeGreaterThan(delays[0]!);
  });

  it('honors Retry-After — waits at least the header duration (AC-9)', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(transientErr(429, { 'retry-after': '2' }))
      .mockResolvedValue('ok');
    let waited = 0;
    const sleep = vi.fn().mockImplementation((ms: number) => {
      waited = ms;
      return Promise.resolve();
    });

    await withRetry(fn, { max_retries: 3, base_delay_ms: 100, sleep, random: () => 0 });

    expect(waited).toBeGreaterThanOrEqual(2000);
  });

  it('throws ProviderError after exhausting max_retries (AC-10)', async () => {
    const fn = vi.fn().mockRejectedValue(transientErr(503));
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      withRetry(fn, { max_retries: 2, sleep, random: () => 0 }),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it('does NOT retry auth errors (401) — propagates immediately (FR-7)', async () => {
    const fn = vi.fn().mockRejectedValue({ status: 401 });
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(withRetry(fn, { max_retries: 3, sleep })).rejects.toBeDefined();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('does NOT retry fatal errors (400) — throws ProviderError, one attempt', async () => {
    const fn = vi.fn().mockRejectedValue({ status: 400 });
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      withRetry(fn, { max_retries: 3, sleep }),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('clamps a negative max_retries to zero — one attempt, no retry', async () => {
    const fn = vi.fn().mockRejectedValue({ status: 503 });
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      withRetry(fn, { max_retries: -5, sleep }),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('withRetry — Retry-After header parsing branches', () => {
  // Capture the first backoff delay for a single transient failure shaped by `err`.
  async function firstDelay(err: unknown): Promise<number> {
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');
    let delay = -1;
    const sleep = vi.fn().mockImplementation((ms: number) => {
      if (delay < 0) delay = ms;
      return Promise.resolve();
    });
    await withRetry(fn, { max_retries: 2, base_delay_ms: 1000, sleep, random: () => 0 });
    return delay;
  }

  it('uses a numeric retry-after (seconds → ms)', async () => {
    expect(await firstDelay({ status: 503, headers: { 'retry-after': 5 } })).toBe(5000);
  });

  it('ignores a non-numeric retry-after and falls back to backoff', async () => {
    expect(await firstDelay({ status: 503, headers: { 'retry-after': 'abc' } })).toBe(1000);
  });

  it('ignores a negative retry-after', async () => {
    expect(await firstDelay({ status: 503, headers: { 'retry-after': -3 } })).toBe(1000);
  });

  it('ignores headers that are not an object', async () => {
    expect(await firstDelay({ status: 503, headers: 'nope' })).toBe(1000);
  });

  it('ignores a missing retry-after header', async () => {
    expect(await firstDelay({ status: 503, headers: {} })).toBe(1000);
  });

  it('reads Retry-After from a real WHATWG Headers object (regression: review BUG-1)', async () => {
    const headers = new Headers({ 'retry-after': '2' });
    expect(await firstDelay({ status: 429, headers })).toBeGreaterThanOrEqual(2000);
  });
});
