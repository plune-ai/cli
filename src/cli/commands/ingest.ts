// `plune ingest <dir>` — record a Cairn run in Plune (Plune #10 / #86, ADR-CI-01).
//
// Cairn writes its runs to disk and knows nothing about Plune; this command is the thing that carries
// one across. That direction is deliberate: a Cairn user who has never heard of Plune should not find
// its URL, its token or its payload shape wired into their tool.
//
// Nothing uploaded here becomes a test case. Generated cases arrive in Plune's review queue as
// proposals for a person to accept or refuse, so a run cannot fill a project with cases nobody
// authored (Plune ADR 0010 / ADR-CI-03). The counters printed at the end say exactly what happened.
//
// Reading the artifact is `cairn-artifact.ts`; this file is the network edge. Same failure discipline
// as `sync`: typed errors, actionable messages, never a stack trace, never the token.

import { loadToken } from '../credentials.js';
import {
  readCairnRun,
  CairnEvidenceAmbiguousError,
  CairnRunNotFoundError,
  CairnRunPartialError,
  CairnRunVersionError,
  type CairnIngestPayload,
} from './cairn-artifact.js';

const DEFAULT_API_URL = 'https://beta-api.plune.ai';

/** No saved token — the user must `plune login` first. (exit 2) */
export class IngestNotLoggedInError extends Error {
  constructor() {
    super('Not logged in. Run "plune login" first to save your API token.');
    this.name = 'IngestNotLoggedInError';
  }
}

/** The token was present but the server rejected it (401). (exit 2) */
export class IngestTokenRejectedError extends Error {
  constructor() {
    super('Your API token was rejected (401). Run "plune login" again with a fresh token.');
    this.name = 'IngestTokenRejectedError';
  }
}

/** The API could not be reached at all — DNS, TLS, offline. (exit 1) */
export class IngestNetworkError extends Error {
  constructor(apiUrl: string) {
    super(`Could not reach the Plune API at ${apiUrl}. Check your connection, then try again.`);
    this.name = 'IngestNetworkError';
  }
}

/** The API answered, but not with success. (exit 1) */
export class IngestHttpError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`Plune API returned ${status}${detail !== '' ? ` — ${detail}` : ''}.`);
    this.name = 'IngestHttpError';
  }
}

export interface IngestDeps {
  /** The Cairn run directory to read. */
  dir: string;
  apiUrl?: string;
  loadToken?: () => string | null;
  fetchImpl?: typeof fetch;
}

/** What the server recorded — the three counters that account for every case sent. */
export interface IngestResult {
  runId: string;
  linked: number;
  proposed: number;
  skipped: number;
}

function resolveApiUrl(explicit: string | undefined): string {
  const raw = explicit ?? process.env['PLUNE_API_URL'] ?? DEFAULT_API_URL;
  return raw.replace(/\/+$/, '');
}

/** Read a non-2xx body for its message, always draining it — an unread body leaves the socket open. */
async function safeErrorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === 'string' ? body.error : '';
  } catch {
    return '';
  }
}

export async function handleIngest(deps: IngestDeps): Promise<IngestResult> {
  const apiUrl = resolveApiUrl(deps.apiUrl);

  // Auth first: the cheapest guard, and the friendliest failure. Reading the run before checking the
  // token would make a logged-out user wait for a parse just to be told to log in.
  const token = (deps.loadToken ?? loadToken)();
  if (token === null) throw new IngestNotLoggedInError();

  // Throws a typed error for an unknown format, an unfinished run, or evidence that cannot be joined
  // safely — all before anything leaves the machine, so a refusal uploads nothing.
  const payload: CairnIngestPayload = await readCairnRun(deps.dir);

  const doFetch = deps.fetchImpl ?? fetch;
  const endpoint = `${apiUrl}/v1/ingest/cairn`;

  let res: Response;
  try {
    res = await doFetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new IngestNetworkError(apiUrl);
  }

  if (!res.ok) {
    const detail = await safeErrorDetail(res);
    if (res.status === 401) throw new IngestTokenRejectedError();
    throw new IngestHttpError(res.status, detail);
  }

  const body = (await res.json().catch(() => ({}))) as Partial<IngestResult>;
  return {
    runId: typeof body.runId === 'string' ? body.runId : '',
    linked: typeof body.linked === 'number' ? body.linked : 0,
    proposed: typeof body.proposed === 'number' ? body.proposed : 0,
    skipped: typeof body.skipped === 'number' ? body.skipped : 0,
  };
}

/**
 * Map an ingest failure to a stderr line and an exit code, or `null` when it is not ours to explain.
 *
 * The split follows `sync`: something the user can fix here and now exits 2, something that may work
 * on the next attempt exits 1. A malformed or unfinished run is the user's to fix, so it is 2.
 */
export function reportIngestFailure(err: unknown, write: (s: string) => void): number | null {
  if (
    err instanceof IngestNotLoggedInError ||
    err instanceof IngestTokenRejectedError ||
    err instanceof CairnRunNotFoundError ||
    err instanceof CairnRunVersionError ||
    err instanceof CairnRunPartialError ||
    err instanceof CairnEvidenceAmbiguousError
  ) {
    write(`${err.message}\n`);
    return 2;
  }
  if (err instanceof IngestNetworkError || err instanceof IngestHttpError) {
    write(`${err.message}\n`);
    return 1;
  }
  return null;
}

/** One line per counter, in the order a reader cares about: what landed, what needs them, what did not. */
export function formatIngestResult(r: IngestResult): string {
  const lines = [
    `Ingested Cairn run → ${r.runId}`,
    `  ${r.linked} result(s) attached to existing cases`,
    `  ${r.proposed} case(s) proposed — review them in Plune to accept`,
    `  ${r.skipped} skipped (already queued, already rejected, repeated, or never executed)`,
  ];
  return `${lines.join('\n')}\n`;
}
