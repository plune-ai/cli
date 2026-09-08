import { resolveApiUrl } from '../cli/api-url.js';
import { loadToken } from '../cli/credentials.js';
import { createClient, type PlatformClient } from './client.js';
import { appendBatch, DEFAULT_FALLBACK_PATH, type DeferredResult } from './fallback.js';
import type {
  ExpectedEntry,
  KeyRef,
  PendingResult,
  ReporterConfig,
  ResultSubmission,
  RunStats,
} from './types.js';

/** The platform's ceiling on one resolve request. */
const RESOLVE_CHUNK = 500;
/** The platform's ceiling on one results batch. */
const BATCH_MAX = 500;
const BATCH_DEFAULT = 100;
/** What `configuration.expected` may hold before the contract refuses the whole start. */
const EXPECTED_MAX = 10_000;

/**
 * A run in progress.
 *
 * `runId: null` is not an error state to check for — it is a run that never reached the platform,
 * and everything below keeps working: results go to the fallback file, `finish` does nothing, and
 * the test run itself is untouched. A reporter that failed a build because a dashboard was down
 * would be worse than no reporter.
 */
export interface RunSession {
  readonly runId: string | null;
  readonly joined: boolean;
  readonly stats: Readonly<RunStats>;
  /** Hand over one result. Sends a batch as soon as enough have accumulated. */
  add(result: PendingResult): Promise<void>;
  /** Send whatever is buffered. Safe to call when nothing is. */
  flush(): Promise<void>;
  /** Send what is left and close the run. */
  finish(reason?: string): Promise<void>;
  /** Send what is left and deliberately leave the run open — the shard case (AC-03). */
  leaveOpen(): Promise<void>;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Start a run, or join the one that already carries this key.
 *
 * `expected` — one list of candidate identifiers per test the runner knows about — is used twice
 * on purpose. It becomes `configuration.expected`, from which the platform derives what never ran
 * (AC-09); and it is the input to the single up-front resolve, so the per-test path afterwards is
 * a map lookup rather than a request (AC-10). A runner that cannot enumerate its tests passes
 * nothing and resolves lazily on the first flush — same function, later moment.
 */
export async function startRun(
  cfg: ReporterConfig,
  expected?: readonly (readonly KeyRef[])[],
): Promise<RunSession> {
  const log = cfg.log ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const fallbackPath = cfg.fallbackPath ?? DEFAULT_FALLBACK_PATH;
  const externalKey = cfg.externalKey ?? null;
  const batchSize = Math.min(cfg.batchSize ?? BATCH_DEFAULT, BATCH_MAX);

  const token = cfg.token ?? loadToken() ?? '';
  const client: PlatformClient = createClient({
    apiUrl: resolveApiUrl(cfg.apiUrl),
    token,
    ...(cfg.fetchImpl !== undefined ? { fetchImpl: cfg.fetchImpl } : {}),
  });

  const stats: RunStats = {
    accepted: 0,
    duplicate: 0,
    conflict: 0,
    rejected: 0,
    unresolved: 0,
    deferred: 0,
  };
  /** `null` records a key we already asked about and the platform did not know — asking twice
   * would cost a request to learn the same thing. */
  const resolved = new Map<string, string | null>();
  let buffer: PendingResult[] = [];
  let runId: string | null = null;
  let joined = false;
  /** Set once the platform has told us it will not accept anything more from this process. */
  let offline = token === '';
  let done = false;

  if (offline) {
    log('plune: no API token — run "plune login" first. Results will be written to the fallback file.');
  }

  function defer(results: DeferredResult[]): void {
    appendBatch(fallbackPath, { runId, externalKey, results });
    stats.deferred += results.length;
  }

  /** Ask the platform about every key we have not asked about yet. */
  async function resolveKeys(values: readonly KeyRef[]): Promise<void> {
    const unknown = values.filter((k) => !resolved.has(k.value));
    // Deliberately not gated on a run: `/v1/test-cases/resolve` is about cases, not runs, and
    // needing the run first is what made the run's own configuration unusable (see below).
    if (unknown.length === 0 || offline) return;

    for (const part of chunk(unknown, RESOLVE_CHUNK)) {
      const out = await client.post<{ results: { key: KeyRef; testCaseId: string | null }[] }>(
        '/v1/test-cases/resolve',
        { keys: part },
      );
      if (!out.ok) {
        // Not fatal: an unresolved key defers its result rather than losing it.
        log(`plune: could not look up test cases (${out.detail || out.kind}).`);
        return;
      }
      for (const row of out.body.results) resolved.set(row.key.value, row.testCaseId);
    }
  }

  /**
   * Look every test up FIRST, then start the run — and that order is the whole point.
   *
   * `configuration.expected` is what the platform derives `notRun` from, and it can only match an
   * entry it can identify. Built before the lookup, it could carry nothing but a raw external key,
   * and a project whose cases are keyed some other way got an empty `notRun` while its results
   * landed perfectly — a crashed shard would have looked exactly like a green run. Resolving first
   * costs nothing (the lookup is about cases, not runs) and lets each entry name its actual case.
   */
  if (!offline) {
    if (expected !== undefined) await resolveKeys(expected.flat());

    const declared = expected?.slice(0, EXPECTED_MAX) ?? [];
    const configuration =
      declared.length === 0
        ? undefined
        : {
            expected: declared.flatMap<ExpectedEntry>((keys) => {
              const hit = keys.map((k) => resolved.get(k.value)).find((v) => typeof v === 'string');
              if (typeof hit === 'string') return [{ testCaseId: hit }];
              // Unresolved: say what we know rather than dropping the entry. The platform cannot
              // count it, but the run still declares how many tests it meant to run.
              return keys[0] === undefined ? [] : [{ externalKey: keys[0] }];
            }),
          };
    if (expected !== undefined && expected.length > EXPECTED_MAX) {
      log(`plune: ${expected.length} tests is more than the run configuration holds — reporting the first ${EXPECTED_MAX}.`);
    }

    const start = await client.post<{ run: { id: string }; joined: boolean }>('/v1/runs', {
      schemaVersion: 2,
      kind: cfg.kind ?? 'automated',
      ...(externalKey !== null ? { externalKey } : {}),
      ...(cfg.meta !== undefined ? { meta: cfg.meta } : {}),
      ...(configuration !== undefined ? { configuration } : {}),
    });

    if (start.ok) {
      runId = start.body.run.id;
      joined = start.status === 200;
    } else {
      log(`plune: could not start the run (${start.detail || start.kind}). Results will be written to ${fallbackPath}.`);
    }
  }

  /**
   * What the platform has told us about this result's identity.
   *
   * `unmatched` and `unanswered` look the same from a distance and must not be treated the same.
   * `unmatched` means the platform looked and there is no case — the result cannot be sent, and
   * C2's ladder decides what to do about it. `unanswered` means the lookup itself failed, so we
   * know nothing; reporting that as unmatched would drop a result the run really produced, on
   * the strength of a question nobody answered.
   */
  type Match =
    | { kind: 'found'; testCaseId: string }
    | { kind: 'unmatched' }
    | { kind: 'unanswered' };

  function matchFor(result: PendingResult): Match {
    // The test named its case outright. Nothing to look up, and nothing to rank against.
    if (result.testCaseId !== undefined) return { kind: 'found', testCaseId: result.testCaseId };
    let unanswered = false;
    for (const key of result.keys) {
      const hit = resolved.get(key.value);
      if (typeof hit === 'string') return { kind: 'found', testCaseId: hit };
      if (hit === undefined) unanswered = true;
    }
    return unanswered ? { kind: 'unanswered' } : { kind: 'unmatched' };
  }

  async function flush(): Promise<void> {
    if (buffer.length === 0) return;
    const pending = buffer;
    buffer = [];

    if (offline || runId === null) {
      defer(pending);
      return;
    }

    await resolveKeys(pending.flatMap((p) => p.keys));

    const submissions: ResultSubmission[] = [];
    const unanswered: PendingResult[] = [];
    for (const result of pending) {
      const match = matchFor(result);
      if (match.kind === 'found') {
        const { keys: _keys, ...rest } = result;
        submissions.push({ ...rest, testCaseId: match.testCaseId });
      } else if (match.kind === 'unmatched') {
        stats.unresolved += 1;
      } else {
        unanswered.push(result);
      }
    }
    if (unanswered.length > 0) defer(unanswered);
    if (submissions.length === 0) return;

    const out = await client.post<{ counts: Record<keyof RunStats, number> }>(
      `/v1/runs/${runId}/results`,
      { results: submissions },
    );
    if (out.ok) {
      stats.accepted += out.body.counts.accepted ?? 0;
      stats.duplicate += out.body.counts.duplicate ?? 0;
      stats.conflict += out.body.counts.conflict ?? 0;
      stats.rejected += out.body.counts.rejected ?? 0;
      return;
    }

    if (out.kind === 'auth') {
      log('plune: the API token was refused — run "plune login" with a fresh one.');
      offline = true;
    } else if (out.kind === 'conflict') {
      // Two processes closed one run. Retrying would not help and hiding it would leave someone
      // wondering why a third of a sharded run is missing.
      log(`plune: this run is closed — ${out.detail}`);
    } else {
      log(`plune: could not send results (${out.detail || out.kind}).`);
    }
    defer(submissions);
  }

  function summarise(): void {
    const parts = [`${stats.accepted} accepted`];
    if (stats.duplicate > 0) parts.push(`${stats.duplicate} already reported`);
    if (stats.conflict > 0) parts.push(`${stats.conflict} conflicting`);
    if (stats.rejected > 0) parts.push(`${stats.rejected} rejected`);
    if (stats.unresolved > 0) parts.push(`${stats.unresolved} with no matching test case`);
    if (stats.deferred > 0) parts.push(`${stats.deferred} written to ${fallbackPath}`);
    log(`plune: ${parts.join(' · ')}`);
  }

  return {
    get runId() {
      return runId;
    },
    get joined() {
      return joined;
    },
    get stats() {
      return stats;
    },
    async add(result) {
      buffer.push(result);
      if (buffer.length >= batchSize) await flush();
    },
    flush,
    async finish(reason?: string) {
      if (done) return;
      done = true;
      await flush();
      if (runId !== null && !offline) {
        const out = await client.post(`/v1/runs/${runId}/events`, {
          event: 'finish',
          ...(reason !== undefined ? { reason } : {}),
        });
        // A refusal here leaves the run open, which is a truthful state — see `leaveOpen`.
        if (!out.ok) log(`plune: could not close run ${runId} (${out.detail || out.kind}).`);
      }
      summarise();
    },
    async leaveOpen() {
      if (done) return;
      done = true;
      await flush();
      if (runId !== null) {
        // Deliberately open: this process is one shard and cannot know the others are done.
        // Whoever does know closes it, and until then the run reads as still running — which is
        // the truth, and the whole point of AC-08.
        log(`plune: run ${runId} is still open — close it with "plune run finish ${runId}".`);
      }
      summarise();
    },
  };
}
