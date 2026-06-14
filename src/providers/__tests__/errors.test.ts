import { describe, expect, it } from 'vitest';
import { APIConnectionError, APIConnectionTimeoutError } from 'openai';
import {
  classifyError,
  redactSecrets,
  normalizeProviderError,
  AuthError,
  ProviderError,
} from '../errors.js';

describe('classifyError (ADR-PRV03)', () => {
  it('classifies 401 and 403 as auth', () => {
    expect(classifyError({ status: 401 })).toBe('auth');
    expect(classifyError({ status: 403 })).toBe('auth');
  });

  it('classifies 429 and 5xx as transient', () => {
    expect(classifyError({ status: 429 })).toBe('transient');
    expect(classifyError({ status: 500 })).toBe('transient');
    expect(classifyError({ status: 503 })).toBe('transient');
  });

  it('classifies network errors (ECONNRESET / ETIMEDOUT) as transient', () => {
    expect(classifyError({ code: 'ECONNRESET' })).toBe('transient');
    expect(classifyError({ code: 'ETIMEDOUT' })).toBe('transient');
  });

  it('classifies non-auth 4xx and unknown errors as fatal', () => {
    expect(classifyError({ status: 400 })).toBe('fatal');
    expect(classifyError({ status: 404 })).toBe('fatal');
    expect(classifyError(new Error('weird'))).toBe('fatal');
  });
});

describe('redactSecrets (FR-6, AC-7)', () => {
  it('removes the secret value from a message', () => {
    const out = redactSecrets('auth failed for key sk-abc123XYZ here', 'sk-abc123XYZ'); // gitleaks:allow — fake fixture key for the redaction test, not a real credential
    expect(out).not.toContain('sk-abc123XYZ');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts Bearer tokens even when the raw key is not passed', () => {
    const out = redactSecrets('Authorization: Bearer sk-secret-token-999 failed');
    expect(out).not.toContain('sk-secret-token-999');
  });

  it('is a no-op when no secret is provided', () => {
    expect(redactSecrets('nothing to hide')).toBe('nothing to hide');
  });
});

describe('AuthError / ProviderError', () => {
  it('AuthError carries the envVar and a stable code', () => {
    const e = new AuthError('missing key', 'OPENAI_API_KEY');
    expect(e).toBeInstanceOf(Error);
    expect(e.envVar).toBe('OPENAI_API_KEY');
    expect(e.code).toBe('PROVIDER_AUTH');
    expect(e.name).toBe('AuthError');
  });

  it('ProviderError carries a code', () => {
    const e = new ProviderError('PROVIDER_TRANSIENT', 'service unavailable');
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('PROVIDER_TRANSIENT');
    expect(e.name).toBe('ProviderError');
  });
});

describe('classifyError — real SDK transport errors (regression: review BUG-2)', () => {
  // These SDK errors carry status === undefined and no errno; they must still be retried.
  it('classifies a real APIConnectionError as transient', () => {
    expect(classifyError(new APIConnectionError({ message: 'connection reset' }))).toBe('transient');
  });

  it('classifies a real APIConnectionTimeoutError as transient', () => {
    expect(classifyError(new APIConnectionTimeoutError({ message: 'request timed out' }))).toBe(
      'transient',
    );
  });
});

describe('normalizeProviderError — redaction across all branches (AC-7)', () => {
  const KEY = 'sk-LEAK-123';

  it('converts an auth-class error to AuthError with the key redacted', () => {
    const e = normalizeProviderError({ status: 401, message: `bad key ${KEY}` }, KEY, 'OPENAI_API_KEY');
    expect(e).toBeInstanceOf(AuthError);
    expect((e as AuthError).envVar).toBe('OPENAI_API_KEY');
    expect(e.message).not.toContain(KEY);
  });

  it('redacts the key when re-wrapping a ProviderError', () => {
    const e = normalizeProviderError(new ProviderError('PROVIDER_FATAL', `fail ${KEY}`), KEY, 'X');
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.message).not.toContain(KEY);
  });

  it('passes an existing AuthError through unchanged', () => {
    const orig = new AuthError('missing', 'K');
    expect(normalizeProviderError(orig, 'secret', 'K')).toBe(orig);
  });

  it('wraps an unknown error as ProviderError with the key redacted', () => {
    const e = normalizeProviderError(new Error(`weird ${KEY}`), KEY, 'X');
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.message).not.toContain(KEY);
  });
});
