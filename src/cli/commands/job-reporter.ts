// The platform's job queue, as the commands that upload to it describe their work there: `plune sync` (kind `sync`,
// cli#139) and `plune ingest` (kind `ingest`, plune#2047). Both are kinds the queue panel has words for (plune
// `app/src/i18n/en.json`, `queue.kind.*`).

/** A job report never holds the command up for long: the upload is the work, the job only describes it. */
const JOB_TIMEOUT_MS = 5000;
/** What the platform keeps of a name and of a reason, and refuses past (`JOB_SUBJECT_NAME_MAX`, `JOB_REASON_MAX`). */
const JOB_SUBJECT_NAME_MAX = 200;
const JOB_REASON_MAX = 2000;

/**
 * Describes one upload to the platform's job queue so it can show it and fail it when it goes quiet, in the shape
 * plune `src/contracts/job.ts` takes (cli#139): `POST /v1/jobs` opens it, `PATCH /v1/jobs/:id/progress` says how
 * far, `PATCH /v1/jobs/:id/state` ends it. Progress counts the upload's rows as `{ done, total }`, and is left out
 * while there are none to count: never `0 / 0`.
 * Best effort by design: nothing here throws, and the command carries on whatever the platform answers. An older
 * server (404 / 405 on opening) has no queue, so nothing is said; any other failure is kept, the first, as `problem`.
 */
export class JobReporter {
  private id: string | undefined;
  /** The upload's rows, the job's `total`; `null` while there are none to count. */
  private size: number | null = null;
  /** The first report the platform did not take, for the CLI to say once. */
  problem: string | undefined;

  constructor(
    private readonly doFetch: typeof fetch,
    private readonly base: string,
    private readonly token: string,
    private readonly kind: 'sync' | 'ingest',
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
      kind: this.kind,
      ...(name !== '' ? { subjectName: name } : {}),
      ...(this.size !== null ? { progress: { done: 0, total: this.size } } : {}),
    });
    if (typeof body?.id === 'string') this.id = body.id;
  }

  /**
   * The upload is in: every row is on the platform. `subjectId` is what the job works on, learnt from the upload's
   * answer (the run an ingest landed in): the platform takes it while the job names none (#1279).
   */
  async uploaded(at: { cursor?: string | undefined; subjectId?: string | undefined }): Promise<void> {
    if (this.id === undefined) return;
    await this.send('PATCH', `/${encodeURIComponent(this.id)}/progress`, {
      done: this.size,
      total: this.size,
      ...(at.cursor !== undefined ? { cursor: at.cursor } : {}),
      ...(at.subjectId !== undefined ? { subjectId: at.subjectId } : {}),
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
