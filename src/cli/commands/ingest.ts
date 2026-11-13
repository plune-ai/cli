// `plune ingest <dir>` — record a Cairn run in Plune (ADR-CI-01).
//
// Cairn writes its runs to disk and knows nothing about Plune; this command is the thing that carries
// one across. That direction is deliberate: a Cairn user who has never heard of Plune should not find
// its URL, its token or its payload shape wired into their tool.
//
// Nothing uploaded here becomes a test case. Generated cases arrive in Plune's review queue as
// proposals for a person to accept or refuse, so a run cannot fill a project with cases nobody
// authored (ADR-CI-03). The counters printed at the end say exactly what happened.
//
// Reading the artifact is `cairn-artifact.ts`; this file is the network edge. Same failure discipline
// as `sync`: typed errors, actionable messages, never a stack trace, never the token. And the same job report:
// the platform's queue shows the ingest from start to end, and the report never decides the exit code.

import { promises as disk } from 'node:fs';
import * as path from 'node:path';
import { createClient } from '../../reporter-core/client.js';
import { UPLOAD_RETRIES } from '../../reporter-core/env.js';
import { fileSender, type Upload } from '../../reporter-core/session.js';
import { resolveApiUrl } from '../api-url.js';
import { loadToken } from '../credentials.js';
import {
  findLatestCairnRun,
  readCairnRun,
  readCairnSessionFiles,
  CairnArtifactShapeError,
  CairnEvidenceAmbiguousError,
  CairnRunNotFoundError,
  CairnRunPartialError,
  CairnRunVersionError,
  NoCairnRunsError,
  type CairnIngestPayload,
} from './cairn-artifact.js';
import { JobReporter } from './job-reporter.js';

/** No saved token — the user must `plune login` first. (exit 2) */
export class IngestNotLoggedInError extends Error {
  constructor() {
    super('Not logged in. Run "plune login" first, or set PLUNE_TOKEN.');
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
  /** The Cairn run directory to read. Omit it and the newest run under `runsDir` is used. */
  dir?: string;
  /** Where to look when `dir` is omitted; relative paths resolve against the process's cwd. */
  runsDir?: string;
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
  /** Why the platform's job queue did not take this ingest's report: the first refusal or error. The run is recorded. */
  jobProblem?: string;
  /** What became of the run's recordings (videos, traces): a count, then a line per reason a file stayed behind. */
  files?: string[];
}

/** What the ingest wrote for one case: the proposal it queued, or the result it attached. A skipped case has none. */
interface IngestItem {
  stableId: string;
  reviewItemId?: string;
  resultId?: string;
}

/** The most a session file may weigh; a bigger one stays behind with a line, and costs nothing else. */
const SESSION_FILE_MAX = 100 * 1024 * 1024;
/** Session files in flight at once: a few large files, so a few at a time. */
const SESSION_UPLOADS_AT_ONCE = 4;
const TYPE_BY_EXTENSION: Record<string, string> = { '.webm': 'video/webm', '.zip': 'application/zip' };

/** `items` as the platform sends it, or `undefined` from a platform older than it. Entries without an id are left out. */
function itemsOf(body: unknown): IngestItem[] | undefined {
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return undefined;
  return items.flatMap((raw) => {
    const i = (raw ?? {}) as Record<string, unknown>;
    if (typeof i['stableId'] !== 'string') return [];
    const reviewItemId = typeof i['reviewItemId'] === 'string' && i['reviewItemId'] !== '' ? i['reviewItemId'] : undefined;
    const resultId = typeof i['resultId'] === 'string' && i['resultId'] !== '' ? i['resultId'] : undefined;
    if (reviewItemId === undefined && resultId === undefined) return [];
    return [{ stableId: i['stableId'], ...(reviewItemId !== undefined ? { reviewItemId } : {}), ...(resultId !== undefined ? { resultId } : {}) }];
  });
}

/**
 * The run's videos and traces, each to what its case became: the proposal in the review queue (a reviewer watches it before
 * approving; approval moves it to the result), or the result of a case approved before. Through the reporter's own file
 * machinery. A file that does not go is a line, and the ingest ends as it would have without it.
 */
async function sendSessionFiles(
  dir: string,
  sent: { items: IngestItem[] | undefined; repeat: boolean },
  platform: { apiUrl: string; token: string; fetchImpl?: typeof fetch },
): Promise<string[]> {
  const session = await readCairnSessionFiles(dir);
  if (session === undefined || (session.byCase.size === 0 && session.unmapped === 0)) return [];
  if (sent.items === undefined) {
    return ['session files not uploaded — this Plune is older than the routes that take them'];
  }
  // ponytail: the platform's one-file routes keep no hash, so a second send would be a second copy on the item.
  if (sent.repeat) return ['session files not uploaded again — this run was ingested before'];

  const lines: string[] = [];
  const jobs: Upload[] = [];
  let tooBig = 0;
  let unplaced = session.unmapped;
  const placed = new Set<string>();
  for (const item of sent.items) {
    const paths = session.byCase.get(item.stableId);
    if (paths === undefined || placed.has(item.stableId)) continue;
    placed.add(item.stableId);
    for (const file of paths) {
      const name = path.basename(file);
      const size = await disk.stat(file).then((s) => s.size, () => undefined);
      if (size !== undefined && size > SESSION_FILE_MAX) {
        tooBig += 1;
        lines.push(`"${name}" skipped — larger than the ${SESSION_FILE_MAX / (1024 * 1024)} MiB a session file may be`);
        continue;
      }
      const type = TYPE_BY_EXTENSION[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
      jobs.push({
        id: item.reviewItemId ?? (item.resultId as string),
        ...(item.reviewItemId !== undefined ? { owner: 'review-items' as const } : {}),
        kind: 'file',
        name,
        type,
        path: file,
      });
    }
  }
  for (const stableId of session.byCase.keys()) if (!placed.has(stableId)) unplaced += 1;
  if (unplaced > 0) lines.push(`${unplaced} recording(s) not uploaded — no proposal or result of this run to attach them to`);

  const counts = { screenshots: { uploaded: 0, skipped: 0, failed: 0 }, textFiles: { uploaded: 0, skipped: 0, failed: 0 }, otherFiles: { uploaded: 0, skipped: 0, failed: 0 } };
  if (jobs.length > 0) {
    const notes: string[] = [];
    const files = fileSender({
      client: createClient({
        apiUrl: platform.apiUrl,
        token: platform.token,
        uploadRetries: UPLOAD_RETRIES.default,
        ...(platform.fetchImpl !== undefined ? { fetchImpl: platform.fetchImpl } : {}),
      }),
      log: (line) => notes.push(line.replace(/^plune: /, '')),
      stats: counts,
      uploadsAtOnce: SESSION_UPLOADS_AT_ONCE,
      uploadRetries: UPLOAD_RETRIES.default,
      without: 'the run is recorded without it',
    });
    await files.uploadEach(jobs);
    lines.push(...notes.filter((n) => !n.startsWith('storage bucket found')));
  }
  const { uploaded, skipped, failed } = counts.otherFiles;
  const total = `${uploaded} session file(s) uploaded` + (skipped + tooBig > 0 ? `, ${skipped + tooBig} skipped` : '') + (failed > 0 ? `, ${failed} failed to upload` : '');
  return [total, ...lines];
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

  // With no directory named, pick the newest run under ./runs. Cairn writes there by default, and
  // the id it names the run with is not something anyone types from memory.
  const dir = deps.dir ?? (await findLatestCairnRun(deps.runsDir));

  // Throws a typed error for an unknown format, an unfinished run, or evidence that cannot be joined
  // safely — all before anything leaves the machine, so a refusal uploads nothing.
  const payload: CairnIngestPayload = await readCairnRun(dir);

  const doFetch = deps.fetchImpl ?? fetch;
  const endpoint = `${apiUrl}/v1/ingest/cairn`;

  // Opened only once the run reads cleanly, so a refusal above still sends nothing. Sized by the cases sent; named
  // after the run's directory, as a sync is after its folder.
  const job = new JobReporter(doFetch, apiUrl, token, 'ingest');
  await job.open(path.basename(path.resolve(dir)), payload.cases.length);
  try {
    const { result, ...sent } = await upload();
    // The run the ingest landed in is the job's subject, so the run's page lists it.
    await job.uploaded({ subjectId: result.runId || undefined });
    // The run is recorded by now: nothing about its recordings may turn that into a failure.
    const files = await sendSessionFiles(dir, sent, { apiUrl, token, ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}) }).catch(
      () => ['session files not uploaded (an unexpected error) — the run is recorded'],
    );
    if (files.length > 0) result.files = files;
    await job.finish({ ok: true });
    if (job.problem !== undefined) result.jobProblem = job.problem;
    return result;
  } catch (err) {
    // An empty message would be a reason the platform refuses (400), leaving the job to the stale sweep.
    await job.finish({ ok: false, reason: (err instanceof Error && err.message.trim()) || 'Ingest failed.' });
    throw err;
  }

  async function upload(): Promise<{ result: IngestResult; items: IngestItem[] | undefined; repeat: boolean }> {
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
    const result = {
      runId: typeof body.runId === 'string' ? body.runId : '',
      linked: typeof body.linked === 'number' ? body.linked : 0,
      proposed: typeof body.proposed === 'number' ? body.proposed : 0,
      skipped: typeof body.skipped === 'number' ? body.skipped : 0,
    };
    // A repeat of a run already recorded is answered 200 with the first answer; a new one is 201.
    return { result, items: itemsOf(body), repeat: res.status === 200 };
  }
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
    err instanceof NoCairnRunsError ||
    err instanceof CairnRunVersionError ||
    err instanceof CairnRunPartialError ||
    err instanceof CairnEvidenceAmbiguousError ||
    err instanceof CairnArtifactShapeError
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
    ...(r.files ?? []).map((line, i) => (i === 0 ? `  ${line}` : `    ${line}`)),
  ];
  return `${lines.join('\n')}\n`;
}
