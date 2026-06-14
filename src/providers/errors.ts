// Provider error taxonomy + secret redaction (ADR-PRV03).
// Pure module — no I/O, no SDK imports.

export type ErrorClass = 'auth' | 'transient' | 'fatal';

/** Network-level error codes worth retrying (connection dropped, timed out, DNS hiccup). */
const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

/** A setup/credentials problem — never retried, surfaced to the CLI as exit 2 (FR-7). */
export class AuthError extends Error {
  readonly code = 'PROVIDER_AUTH' as const;
  readonly envVar: string;

  constructor(message: string, envVar: string) {
    super(message);
    this.name = 'AuthError';
    this.envVar = envVar;
  }
}

/** A normalized provider failure — orchestrator maps it to an `error`-status row (FR-9). */
export class ProviderError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
  }
}

function statusOf(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null && 'status' in err) {
    const s = (err as { status?: unknown }).status;
    if (typeof s === 'number') return s;
  }
  return undefined;
}

function codeOf(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const c = (err as { code?: unknown }).code;
    if (typeof c === 'string') return c;
  }
  return undefined;
}

/**
 * Map any provider/SDK error onto a retry decision class.
 * 401/403 → auth (fail fast); 429 + 5xx + network → transient (retry); everything else → fatal.
 */
export function classifyError(err: unknown): ErrorClass {
  const status = statusOf(err);
  if (status !== undefined) {
    if (status === 401 || status === 403) return 'auth';
    if (status === 429 || (status >= 500 && status <= 599)) return 'transient';
    return 'fatal';
  }

  // No HTTP status → a transport-level failure (connection dropped, timeout, DNS). The official
  // SDKs wrap these as APIConnectionError / APIConnectionTimeoutError with `status === undefined`
  // and no errno, so we match by error/class name as well as by raw network codes.
  const code = codeOf(err);
  if (code !== undefined && NETWORK_ERROR_CODES.has(code)) return 'transient';
  if (isTransportError(err)) return 'transient';
  return 'fatal';
}

/** Detect SDK/transport connection + timeout + abort errors by error name or class name. */
function isTransportError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: unknown; constructor?: { name?: unknown } };
  const names = [e.name, e.constructor?.name].filter(
    (n): n is string => typeof n === 'string',
  );
  return names.some((n) =>
    /APIConnection|ConnectionError|TimeoutError|AbortError|FetchError/.test(n),
  );
}

/**
 * Strip secrets out of a message before it is shown or logged (FR-6).
 * Removes any provided key values and, as a backstop, any `Bearer <token>`.
 */
export function redactSecrets(message: string, ...secrets: string[]): string {
  let out = message;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join('[REDACTED]');
  }
  out = out.replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [REDACTED]');
  return out;
}

/** Best-effort message extraction from an unknown thrown value. */
export function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return String((err as { message?: unknown }).message);
  }
  return String(err);
}

/**
 * Convert an error thrown out of a provider call into a redacted, normalized error:
 * auth-class → AuthError(envVar); anything else → ProviderError. `secret` is stripped from
 * every surfaced message (FR-6). Adapters call this because only they know the key + env var.
 */
export function normalizeProviderError(err: unknown, secret: string, envVar: string): Error {
  if (err instanceof AuthError) return err;
  if (classifyError(err) === 'auth') {
    return new AuthError(redactSecrets(messageOf(err), secret), envVar);
  }
  if (err instanceof ProviderError) {
    return new ProviderError(err.code, redactSecrets(err.message, secret));
  }
  return new ProviderError('PROVIDER_ERROR', redactSecrets(messageOf(err), secret));
}
