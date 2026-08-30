// `plune login` — save the API token the platform commands use.
//
// The saving half is deliberately small: trim, refuse blank, write 0600, return only the PATH so the
// token cannot reach a terminal or a log through this function.
//
// The checking half exists because it did not (#329). A wrong token used to be accepted here without
// a word and surfaced two commands later, on `plune sync`, as a failure that looks like something
// else entirely — and by then the person has also run their evals. One request at the moment the
// token is pasted turns that into "this token is wrong, here is where to get a right one".

import { resolveApiUrl, whereToGetAToken } from '../api-url.js';
import { saveToken } from '../credentials.js';

/** A pasted token that was empty/blank — the CLI maps this to a clean exit, not a stack trace. */
export class EmptyTokenError extends Error {
  constructor(apiUrl: string = resolveApiUrl()) {
    super(
      `No API token provided. ${whereToGetAToken(apiUrl)} Then pass --token <token> or pipe it via stdin.`,
    );
    this.name = 'EmptyTokenError';
  }
}

/** The server said no. Nothing was saved. (exit 2) */
export class TokenRejectedError extends Error {
  constructor(apiUrl: string = resolveApiUrl()) {
    super(`That API token was rejected (401). Nothing was saved. ${whereToGetAToken(apiUrl)}`);
    this.name = 'TokenRejectedError';
  }
}

/** The api could not be reached at all — DNS, TLS, offline. Nothing was saved. (exit 1) */
export class LoginNetworkError extends Error {
  constructor(apiUrl: string) {
    super(
      `Could not reach the Plune API at ${apiUrl}, so the token was not checked and NOT saved. ` +
        'Try again, or use --skip-verify to save it without checking.',
    );
    this.name = 'LoginNetworkError';
  }
}

/** The api answered, but with neither success nor 401 — something is wrong on its side. (exit 1) */
export class LoginHttpError extends Error {
  constructor(status: number) {
    super(
      `The Plune API returned ${status} while checking the token, so it was NOT saved. Try again.`,
    );
    this.name = 'LoginHttpError';
  }
}

export interface LoginDeps {
  token: string;
  /** Save without asking the server — for setting a machine up offline. */
  skipVerify?: boolean;
  apiUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Validate, check, and persist the token.
 *
 * The check is `GET /v1/runs?limit=1`, and the choice of route matters: `/v1/me` is guarded by the
 * SESSION cookie, not by a bearer token, so it answers 401 for a perfectly good CLI token. Checking
 * against it would reject every token in existence.
 *
 * The token travels in the `Authorization` header and never in the query string — a query reaches
 * proxy logs, and a credential that reaches a log is a credential that leaked.
 */
export async function handleLogin(deps: LoginDeps): Promise<{ path: string; verified: boolean }> {
  const token = deps.token.trim();
  const apiUrl = resolveApiUrl(deps.apiUrl);
  if (token.length === 0) throw new EmptyTokenError(apiUrl);

  if (deps.skipVerify === true) return { path: saveToken(token), verified: false };

  const doFetch = deps.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${apiUrl}/v1/runs?limit=1`, {
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    throw new LoginNetworkError(apiUrl);
  }

  // Drain the body even though nothing reads it: an unread body leaves the socket half-open, and on
  // Windows that trips a libuv assertion during teardown. `sync.ts` documents the same obligation,
  // having been the command that found it.
  await res.text().catch(() => '');

  if (res.status === 401) throw new TokenRejectedError(apiUrl);
  if (!res.ok) throw new LoginHttpError(res.status);

  return { path: saveToken(token), verified: true };
}

/**
 * Map a login failure to a stderr line and an exit code, or `null` when it is not ours to explain.
 *
 * Same split as `sync` and `ingest`: something the person can fix here and now exits 2, something
 * that may work on the next attempt exits 1.
 */
export function reportLoginFailure(err: unknown, write: (s: string) => void): number | null {
  if (err instanceof EmptyTokenError || err instanceof TokenRejectedError) {
    write(`${err.message}\n`);
    return 2;
  }
  if (err instanceof LoginNetworkError || err instanceof LoginHttpError) {
    write(`${err.message}\n`);
    return 1;
  }
  return null;
}
