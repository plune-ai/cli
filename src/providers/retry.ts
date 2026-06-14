// Shared retry wrapper with exponential backoff + jitter (ADR-PRV03).
// Pure-ish: `sleep` and `random` are injectable so tests run with zero real time.

import { classifyError, messageOf, ProviderError } from './errors.js';

export interface RetryOptions {
  /** Number of retries after the first attempt (total attempts = max_retries + 1). */
  max_retries: number;
  /** Base backoff in ms; doubles each retry. */
  base_delay_ms?: number;
  /** Injectable sleep (tests pass a no-op to avoid real time). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable randomness for jitter (tests pass () => 0 for determinism). */
  random?: () => number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Parse a `Retry-After` header (seconds) off an SDK error, if present, into ms. */
function retryAfterMs(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null || !('headers' in err)) return undefined;
  const raw = readHeader((err as { headers?: unknown }).headers, 'retry-after');
  if (raw === undefined) return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return seconds * 1000;
}

/**
 * Read a header from either a WHATWG `Headers` object (what the real SDKs deliver) or a plain
 * object (legacy / test fixtures). Bracket access on a `Headers` instance returns undefined, so
 * `.get()` must be used when present — this was a production bug the mocked tests missed.
 */
function readHeader(headers: unknown, name: string): string | number | undefined {
  if (headers === null || (typeof headers !== 'object' && typeof headers !== 'function')) {
    return undefined;
  }
  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === 'function') {
    const v = (getter as (n: string) => string | null).call(headers, name);
    return v === null ? undefined : v;
  }
  const v = (headers as Record<string, unknown>)[name];
  return typeof v === 'string' || typeof v === 'number' ? v : undefined;
}

/**
 * Run `fn`, retrying only transient failures with exponential backoff + jitter, honoring
 * `Retry-After`. Auth errors propagate raw (the caller adds key context, FR-7); fatal and
 * exhausted-transient failures are normalized to `ProviderError` (FR-8 / FR-9).
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const { base_delay_ms = 500, sleep = defaultSleep, random = Math.random } = options;
  // Clamp so a misconfigured negative max_retries (e.g. from PLUNE_MAX_RETRIES) means "no retry",
  // never "give up before the first attempt".
  const maxRetries = Math.max(0, Math.floor(options.max_retries));
  let attempt = 0;

  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const klass = classifyError(err);

      if (klass === 'auth') throw err;
      if (klass === 'fatal') throw new ProviderError('PROVIDER_FATAL', messageOf(err));
      if (attempt >= maxRetries) {
        throw new ProviderError('PROVIDER_TRANSIENT_EXHAUSTED', messageOf(err));
      }

      const backoff = base_delay_ms * 2 ** attempt;
      const jitter = backoff * 0.1 * random();
      const delay = Math.max(backoff + jitter, retryAfterMs(err) ?? 0);
      await sleep(delay);
      attempt += 1;
    }
  }
}
