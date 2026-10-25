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

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseRunResult, type ParsedRunResult } from '../../types/run-result-schema.js';
import { resolveApiUrl } from '../api-url.js';
import { loadToken } from '../credentials.js';
import { gateExit, type Verdict } from '../gate.js';

// ponytail: alpha points at beta — the only live, token-issuing surface today. Flip to
// https://api.plune.ai once prod is deployed and the alpha graduates. `PLUNE_API_URL` overrides
// it for testers / self-hosters, so the default is a convenience, not a lock-in.

/** No saved token — the user must `plune login` before syncing. (exit 2) */
export class NotLoggedInError extends Error {
  constructor() {
    super('Not logged in. Run "plune login" first, or set PLUNE_TOKEN.');
    this.name = 'NotLoggedInError';
  }
}

/** The token was present but the server rejected it (401 — revoked or invalid). (exit 2) */
export class TokenRejectedError extends Error {
  constructor() {
    super(
      'Your API token was rejected (revoked or invalid). Run "plune login" with a fresh token.',
    );
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
    super(
      `Could not reach the Plune API at ${apiUrl}. Check your connection (or PLUNE_API_URL) and try again.`,
    );
    this.name = 'SyncNetworkError';
  }
}

/** The server answered with a non-2xx that is not a 401 (e.g. 400 invalid body, 5xx). (exit 1) */
export class SyncHttpError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`Sync failed — the server returned HTTP ${status}${detail ? ` (${detail})` : ''}.`);
    this.name = 'SyncHttpError';
  }
}

/** The kind the platform's queue panel has words for: «Sync», «Synced» (plune `app/src/i18n/en.json`, `queue.kind.sync`). */
const JOB_KIND = 'sync';
/** A job report never holds the sync up for long: the upload is the work, the job only describes it. */
const JOB_TIMEOUT_MS = 5000;
/** What the platform keeps of a name and of a reason, and refuses past (`JOB_SUBJECT_NAME_MAX`, `JOB_REASON_MAX`). */
const JOB_SUBJECT_NAME_MAX = 200;
const JOB_REASON_MAX = 2000;

/**
 * Describes one sync to the platform's job queue so it can show it and fail it when it goes quiet, in the shape
 * plune `src/contracts/job.ts` takes (cli#139): `POST /v1/jobs` opens it, `PATCH /v1/jobs/:id/progress` says how
 * far, `PATCH /v1/jobs/:id/state` ends it. Progress counts the run's rows as `{ done, total }`, and is left out
 * while there are none to count: never `0 / 0`.
 * Best effort by design: nothing here throws, and the sync carries on whatever the platform answers. An older
 * server (404 / 405 on opening) has no queue, so nothing is said; any other failure is kept, the first, as `problem`.
 */
class JobReporter {
  private id: string | undefined;
  /** The run's rows, the job's `total`; `null` while there are none to count. */
  private size: number | null = null;
  /** The first report the platform did not take, for the CLI to say once. */
  problem: string | undefined;

  constructor(
    private readonly doFetch: typeof fetch,
    private readonly base: string,
    private readonly token: string,
  ) {}

  private async send(method: 'POST' | 'PATCH', route: string, body: unknown): Promise<{ id?: unknown } | undefined> {
    try {
      const res = await this.doFetch(`${this.base}/v1/jobs${route}`, {
        method,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(JOB_TIMEOUT_MS),
      });
      // Read on every status: an unread body holds the socket open (see handleSync).
      const json = (await res.json().catch(() => undefined)) as { id?: unknown; error?: unknown } | undefined;
      if (res.ok) return json ?? {};
      if (route === '' && (res.status === 404 || res.status === 405)) return undefined; // an older server: no queue
      this.problem ??= `HTTP ${res.status}${typeof json?.error === 'string' ? ` — ${json.error}` : ''}`;
    } catch (err) {
      this.problem ??= err instanceof Error ? err.message : String(err);
    }
    return undefined;
  }

  async open(subjectName: string, rows: number): Promise<void> {
    this.size = Number.isInteger(rows) && rows > 0 ? rows : null;
    // A sync from a drive root has an empty basename, which the platform refuses: that job goes unnamed instead.
    const name = subjectName.trim().slice(0, JOB_SUBJECT_NAME_MAX);
    const body = await this.send('POST', '', {
      kind: JOB_KIND,
      ...(name !== '' ? { subjectName: name } : {}),
      ...(this.size !== null ? { progress: { done: 0, total: this.size } } : {}),
    });
    if (typeof body?.id === 'string') this.id = body.id;
  }

  /** The upload is in: every row of the run is on the platform. */
  async uploaded(cursor: string | undefined): Promise<void> {
    if (this.id === undefined) return;
    await this.send('PATCH', `/${encodeURIComponent(this.id)}/progress`, {
      done: this.size,
      total: this.size,
      ...(cursor !== undefined ? { cursor } : {}),
    });
  }

  async finish(outcome: { ok: true } | { ok: false; reason: string }): Promise<void> {
    if (this.id === undefined) return;
    const id = this.id;
    this.id = undefined;
    await this.send(
      'PATCH',
      `/${encodeURIComponent(id)}/state`,
      outcome.ok ? { state: 'completed' } : { state: 'failed', reason: outcome.reason.slice(0, JOB_REASON_MAX) },
    );
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
  /** `--fail-on-failures`: read the run's summary back once after the upload and judge it (plune#1247). */
  failOnFailures?: boolean;
}

export interface SyncResult {
  /** Server-assigned run id. */
  id: string;
  /** The `GET /v1/runs/:id` URL where the uploaded run can be read back. */
  url: string;
  /** The exit code `--fail-on-failures` asks for and the line that says why; absent without the flag. */
  gate?: { code: number; line: string };
  /** Why the platform's job queue did not take this sync's report: the first refusal or error. The upload went in. */
  jobProblem?: string;
}

/** Read + validate the run to upload, failing locally (with a clear message) before any network call. */
function readRun(cwd: string, file: string | undefined): ParsedRunResult {
  const target =
    file !== undefined ? path.resolve(cwd, file) : path.join(cwd, '.plune', 'last-run.json');
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

  // The key is the SHA-256 of the exact bytes sent: the same upload retried has the same key, other content
  // another. The server answers a repeat with 200 and the same id (no second run), a key reused with another
  // body with 422, a key of a run in the Bin with 409 (plune ADR 0053); an older server ignores the header.
  const payload = JSON.stringify(run);
  const idempotencyKey = createHash('sha256').update(payload).digest('hex');

  const bearer: string = token;
  const job = new JobReporter(doFetch, apiUrl, bearer);
  await job.open(path.basename(deps.file !== undefined ? path.resolve(cwd, deps.file) : cwd), run.summary.total);
  try {
    const result = await upload();
    await job.finish({ ok: true });
    if (job.problem !== undefined) result.jobProblem = job.problem;
    return result;
  } catch (err) {
    await job.finish({ ok: false, reason: err instanceof Error ? err.message : 'Sync failed.' });
    throw err;
  }

  async function upload(): Promise<SyncResult> {
    let res: Response;
    try {
      res = await doFetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${bearer}`,
          'idempotency-key': idempotencyKey,
        },
        body: payload,
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
    const result: SyncResult = { id, url: `${endpoint}/${id}` };
    await job.uploaded(id || undefined);
    if (deps.failOnFailures === true) {
      result.gate = gateExit(await readVerdict(doFetch, `${endpoint}/${id}/summary`, bearer));
    }
    return result;
  }
}

/**
 * The run's verdict as `GET /v1/runs/:id/summary` reads it: `counts` (a muted failure under `muted`), `notRun`
 * and the run's `statusEvent`. `undefined` when the platform does not answer with one — no verdict, no pass.
 */
async function readVerdict(doFetch: typeof fetch, url: string, token: string): Promise<Verdict | undefined> {
  try {
    const res = await doFetch(url, { method: 'GET', headers: { authorization: `Bearer ${token}` } });
    // Read on every status, as above: an unread body holds the socket open.
    const body = (await res.json().catch(() => undefined)) as
      | { counts?: Record<string, number>; notRun?: string[]; run?: { statusEvent?: string } }
      | undefined;
    return res.ok ? { statusEvent: body?.run?.statusEvent, counts: body?.counts, notRun: body?.notRun } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Map a `handleSync` rejection to a friendly stderr line + the exit code to use, or `null` if the error
 * is not a known sync failure (caller then treats it as unexpected).
 */
export function reportSyncFailure(err: unknown, write: (s: string) => void): number | null {
  if (
    err instanceof NotLoggedInError ||
    err instanceof TokenRejectedError ||
    err instanceof SyncFileError
  ) {
    write(err.message + '\n');
    return 2; // user-actionable: log in, or produce/point at a valid run
  }
  if (err instanceof SyncNetworkError || err instanceof SyncHttpError) {
    write(err.message + '\n');
    return 1; // environmental / server-side
  }
  return null;
}
