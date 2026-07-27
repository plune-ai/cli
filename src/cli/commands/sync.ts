// `plune sync` — upload the latest local run to the Plune platform. The credential from `plune login`
// is sent as `Authorization: Bearer …`; the run body is the SAME `.plune/last-run.json` the
// orchestrator persists (a `RunResult`, `schemaVersion: 1`), which is byte-for-byte what the server's
// `POST /v1/runs` contract validates — so no shape translation is needed, the local file posts as-is.
//
// Cloud commands are optional: nothing here runs unless the user asks for it, and `plune run` keeps
// working with no account, no token, and no network (ADR 0006).
//
// Every failure is mapped to a typed error with a clean, actionable message (never a stack trace, never
// the token). `cli.ts` turns those into the right exit code via `reportSyncFailure`.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseRunResult, type ParsedRunResult } from '../../types/run-result-schema.js';
import { loadToken } from '../credentials.js';

// ponytail: alpha points at beta — the only live, token-issuing surface today. Flip to
// https://api.plune.ai once prod is deployed and the alpha graduates. `PLUNE_API_URL` overrides
// it for testers / self-hosters, so the default is a convenience, not a lock-in.
const DEFAULT_API_URL = 'https://beta-api.plune.ai';

/** No saved token — the user must `plune login` before syncing. (exit 2) */
export class NotLoggedInError extends Error {
  constructor() {
    super('Not logged in. Run "plune login" first to save your API token.');
    this.name = 'NotLoggedInError';
  }
}

/** The token was present but the server rejected it (401 — revoked or invalid). (exit 2) */
export class TokenRejectedError extends Error {
  constructor() {
    super('Your API token was rejected (revoked or invalid). Run "plune login" with a fresh token.');
    this.name = 'TokenRejectedError';
  }
}

/** No run to sync, or the run file is unreadable / not a valid RunResult. (exit 2) */
export class SyncFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncFileError';
  }
}

/** The API was unreachable (DNS / TLS / offline). Message names the host, never the token. (exit 1) */
export class SyncNetworkError extends Error {
  constructor(apiUrl: string) {
    super(`Could not reach the Plune API at ${apiUrl}. Check your connection (or PLUNE_API_URL) and try again.`);
    this.name = 'SyncNetworkError';
  }
}

/** The server answered with a non-2xx that is not a 401 (e.g. 400 invalid body, 5xx). (exit 1) */
export class SyncHttpError extends Error {
  constructor(readonly status: number, detail: string) {
    super(`Sync failed — the server returned HTTP ${status}${detail ? ` (${detail})` : ''}.`);
    this.name = 'SyncHttpError';
  }
}

export interface SyncDeps {
  /** Base dir the default run file is read from (config dir or cwd). Defaults to `process.cwd()`. */
  cwd?: string;
  /** Explicit run JSON to sync instead of `<cwd>/.plune/last-run.json`. */
  file?: string;
  /** Override the API base URL. Falls back to `PLUNE_API_URL`, then the beta default. */
  apiUrl?: string;
  /** Token source (injected in tests). Defaults to the real credentials store. */
  loadToken?: () => string | null;
  /** HTTP transport (injected in tests — e.g. a real Hono app's `request`). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

export interface SyncResult {
  /** Server-assigned run id. */
  id: string;
  /** The `GET /v1/runs/:id` URL where the uploaded run can be read back. */
  url: string;
}

function resolveApiUrl(explicit: string | undefined): string {
  const raw = explicit ?? process.env['PLUNE_API_URL'] ?? DEFAULT_API_URL;
  return raw.replace(/\/+$/, ''); // tolerate a trailing slash so `${base}/v1/runs` never doubles up
}

/** Read + validate the run to upload, failing locally (with a clear message) before any network call. */
function readRun(cwd: string, file: string | undefined): ParsedRunResult {
  const target = file !== undefined ? path.resolve(cwd, file) : path.join(cwd, '.plune', 'last-run.json');
  let raw: string;
  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch {
    throw new SyncFileError(
      file !== undefined
        ? `Run file not found: ${target}`
        : 'No run to sync. Run "plune run" first (or pass --file <path>).',
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new SyncFileError(`Run file is not valid JSON: ${target}`);
  }
  try {
    // Same zod contract the server enforces — a bad file fails here, not as an opaque 400 mid-upload.
    return parseRunResult(json);
  } catch {
    throw new SyncFileError(`Run file does not match the RunResult schema: ${target}`);
  }
}

async function safeErrorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === 'string' ? body.error : '';
  } catch {
    return '';
  }
}

/**
 * Upload the latest (or `--file`) local run to `POST {apiUrl}/v1/runs` with the stored Bearer token.
 * Returns the server-assigned id + the read-back URL. Throws a typed error (see the classes above) on
 * every failure path so the CLI can exit cleanly without ever leaking the token or a stack trace.
 */
export async function handleSync(deps: SyncDeps = {}): Promise<SyncResult> {
  const cwd = deps.cwd ?? process.cwd();
  const apiUrl = resolveApiUrl(deps.apiUrl);

  // Auth first (cheapest guard, and the friendliest hint): no token → tell them to log in.
  const token = (deps.loadToken ?? loadToken)();
  if (token === null) throw new NotLoggedInError();

  const run = readRun(cwd, deps.file);
  const doFetch = deps.fetchImpl ?? fetch;
  const endpoint = `${apiUrl}/v1/runs`;

  let res: Response;
  try {
    res = await doFetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(run),
    });
  } catch {
    throw new SyncNetworkError(apiUrl); // network/DNS/TLS — clean message, no stack, no token
  }

  if (!res.ok) {
    // Drain the body on EVERY non-2xx (via safeErrorDetail) before throwing. An unread response body
    // leaves undici's socket half-open, which blocks a clean process exit and — on Windows — trips a
    // libuv teardown assertion (UV_HANDLE_CLOSING) when the CLI exits. Reading it releases the socket.
    const detail = await safeErrorDetail(res);
    if (res.status === 401) throw new TokenRejectedError();
    throw new SyncHttpError(res.status, detail);
  }

  const body = (await res.json().catch(() => ({}))) as { id?: unknown };
  const id = typeof body.id === 'string' ? body.id : '';
  return { id, url: `${endpoint}/${id}` };
}

/**
 * Map a `handleSync` rejection to a friendly stderr line + the exit code to use, or `null` if the error
 * is not a known sync failure (caller then treats it as unexpected).
 */
export function reportSyncFailure(err: unknown, write: (s: string) => void): number | null {
  if (err instanceof NotLoggedInError || err instanceof TokenRejectedError || err instanceof SyncFileError) {
    write(err.message + '\n');
    return 2; // user-actionable: log in, or produce/point at a valid run
  }
  if (err instanceof SyncNetworkError || err instanceof SyncHttpError) {
    write(err.message + '\n');
    return 1; // environmental / server-side
  }
  return null;
}
