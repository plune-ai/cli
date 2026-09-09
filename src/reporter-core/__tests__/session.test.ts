import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { startRun } from '../session.js';
import type { KeyRef, PendingResult, ReporterConfig } from '../types.js';

const TOKEN = 'plune_tok_never_print_me';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-session-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Seen {
  starts: { body: Record<string, unknown> }[];
  resolves: { keys: KeyRef[] }[];
  results: { runId: string; results: Record<string, unknown>[] }[];
  events: { runId: string; body: Record<string, unknown> }[];
  discovered: { body: Record<string, unknown> }[];
}

interface PlatformOptions {
  /** Which keys the platform knows. Anything else resolves to null. */
  known?: Record<string, string>;
  /** Status to answer `POST /v1/runs` with (201 created, 200 joined). */
  startStatus?: number;
  /** Force a reply on `…/results`: a status + error message, or a thrown network failure. */
  resultsFailure?: { status: number; error: string } | 'network';
  /**
   * Whether this deployment has the D13 columns. `false` models one older than them: it validates
   * the body, keeps what it knows, answers 201 — and nothing about that reads as a loss.
   */
  storesDescription?: boolean;
  /** Force a reply on `/v1/review-items/discovered`. */
  discoverFailure?: { status: number; error: string };
  /** What the platform answers per offered test. Defaults to `queued` for each. */
  discoverOutcomes?: string[];
}

function platform(opts: PlatformOptions = {}) {
  const seen: Seen = { starts: [], resolves: [], results: [], events: [], discovered: [] };
  const known = opts.known ?? {};

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;

    if (target.endsWith('/v1/test-cases/resolve')) {
      const keys = body['keys'] as KeyRef[];
      seen.resolves.push({ keys });
      return json({
        results: keys.map((k) => ({ key: k, testCaseId: known[k.value] ?? null, matchedKind: null })),
      });
    }
    if (target.endsWith('/v1/runs')) {
      seen.starts.push({ body });
      const status = opts.startStatus ?? 201;
      const described =
        opts.storesDescription === false
          ? {}
          : {
              title: body['title'] ?? null,
              environment: body['environment'] ?? null,
              labels: body['labels'] ?? null,
            };
      return json({ run: { id: 'r-1', ...described }, joined: status === 200 }, status);
    }
    const results = /\/v1\/runs\/([^/]+)\/results$/.exec(target);
    if (results) {
      if (opts.resultsFailure === 'network') throw new TypeError('fetch failed');
      if (opts.resultsFailure !== undefined) {
        return json({ error: opts.resultsFailure.error }, opts.resultsFailure.status);
      }
      const list = body['results'] as Record<string, unknown>[];
      seen.results.push({ runId: results[1] as string, results: list });
      return json({
        items: [],
        counts: { accepted: list.length, duplicate: 0, conflict: 0, rejected: 0 },
      });
    }
    if (target.endsWith('/v1/review-items/discovered')) {
      if (opts.discoverFailure !== undefined) {
        return json({ error: opts.discoverFailure.error }, opts.discoverFailure.status);
      }
      seen.discovered.push({ body });
      const offered = body['discovered'] as { keys: KeyRef[] }[];
      return json({
        results: offered.map((d, i) => ({
          key: d.keys[0],
          outcome: opts.discoverOutcomes?.[i] ?? 'queued',
        })),
      });
    }
    const events = /\/v1\/runs\/([^/]+)\/events$/.exec(target);
    if (events) {
      seen.events.push({ runId: events[1] as string, body });
      return json({ run: { id: events[1] }, changed: true });
    }
    return json({ error: `unexpected ${target}` }, 500);
  }) as unknown as typeof fetch;

  return { seen, fetchImpl };
}

const result = (id: string, over: Partial<PendingResult> = {}): PendingResult => ({
  resultKey: `${id}#0`,
  keys: [{ kind: 'playwright-id', value: id }],
  source: 'playwright',
  rawStatus: 'passed',
  ...over,
});

function config(fetchImpl: typeof fetch, over: Partial<ReporterConfig> = {}): ReporterConfig {
  const log: string[] = [];
  const cfg: ReporterConfig = {
    apiUrl: 'https://api.test',
    token: TOKEN,
    fallbackPath: path.join(dir, 'pending.jsonl'),
    fetchImpl,
    log: (line) => log.push(line),
    ...over,
  };
  return Object.assign(cfg, { __log: log }) as ReporterConfig;
}
const logOf = (cfg: ReporterConfig): string[] => (cfg as unknown as { __log: string[] }).__log;

describe('startRun — joining one run (AC-02)', () => {
  it('declares schema 2 and the shared key', async () => {
    const { seen, fetchImpl } = platform();
    await startRun(config(fetchImpl, { externalKey: 'ci-42' }));

    expect(seen.starts[0]?.body['schemaVersion']).toBe(2);
    expect(seen.starts[0]?.body['externalKey']).toBe('ci-42');
  });

  it('knows it created the run when the platform says 201', async () => {
    const { fetchImpl } = platform({ startStatus: 201 });
    const run = await startRun(config(fetchImpl));

    expect(run.runId).toBe('r-1');
    expect(run.joined).toBe(false);
  });

  it('knows it joined an existing run when the platform says 200', async () => {
    const { fetchImpl } = platform({ startStatus: 200 });
    const run = await startRun(config(fetchImpl));

    expect(run.runId).toBe('r-1');
    expect(run.joined).toBe(true);
  });

  it('sends every shard results to the one run id', async () => {
    const { seen, fetchImpl } = platform({ startStatus: 200, known: { a: 'tc-a' } });
    for (let i = 0; i < 4; i += 1) {
      const run = await startRun(config(fetchImpl, { externalKey: 'ci-42' }), [
        [{ kind: 'playwright-id', value: 'a' }],
      ]);
      await run.add(result('a'));
      await run.flush();
    }

    expect(seen.results.map((r) => r.runId)).toEqual(['r-1', 'r-1', 'r-1', 'r-1']);
  });
});

describe('startRun — what the run intended to run (AC-09)', () => {
  // Found on beta, not in a unit test: the platform can only count an entry it can identify, so an
  // expected list of raw keys produced an empty `notRun` while every result landed correctly — a
  // crashed shard would have read exactly like a green run.
  it('names the case each test resolved to, so the platform can count what never ran', async () => {
    const { seen, fetchImpl } = platform({ known: { a: 'tc-a', b: 'tc-b' } });
    await startRun(config(fetchImpl), [
      [{ kind: 'playwright-id', value: 'a' }],
      [{ kind: 'playwright-id', value: 'b' }],
    ]);

    const configuration = seen.starts[0]?.body['configuration'] as {
      expected: { testCaseId?: string }[];
    };
    expect(configuration.expected.map((e) => e.testCaseId)).toEqual(['tc-a', 'tc-b']);
  });

  it('looks the tests up before it starts the run, not after', async () => {
    const order: string[] = [];
    const { fetchImpl } = platform({ known: { a: 'tc-a' } });
    const spy = (async (url: string | URL | Request, init?: RequestInit) => {
      order.push(String(url).replace('https://api.test', ''));
      return fetchImpl(url as string, init);
    }) as unknown as typeof fetch;
    await startRun(config(spy), [[{ kind: 'playwright-id', value: 'a' }]]);

    expect(order).toEqual(['/v1/test-cases/resolve', '/v1/runs']);
  });

  it('still declares a test it could not identify, rather than dropping it', async () => {
    const { seen, fetchImpl } = platform({ known: { a: 'tc-a' } });
    await startRun(config(fetchImpl), [
      [{ kind: 'playwright-id', value: 'a' }],
      [{ kind: 'playwright-id', value: 'orphan' }],
    ]);

    const configuration = seen.starts[0]?.body['configuration'] as {
      expected: { testCaseId?: string; externalKey?: KeyRef }[];
    };
    expect(configuration.expected).toHaveLength(2);
    expect(configuration.expected[1]?.externalKey?.value).toBe('orphan');
  });

  it('omits the configuration entirely when the runner does not know its tests', async () => {
    const { seen, fetchImpl } = platform();
    await startRun(config(fetchImpl));

    expect(seen.starts[0]?.body['configuration']).toBeUndefined();
  });
});

describe('resolution happens once per run, never per test (AC-10)', () => {
  const keys = (n: number): KeyRef[][] =>
    Array.from({ length: n }, (_, i) => [{ kind: 'playwright-id' as const, value: `t${i}` }]);

  it('asks once for a hundred and twenty tests', async () => {
    const { seen, fetchImpl } = platform({ known: Object.fromEntries(keys(120).map((k) => [k[0]?.value, 'tc'])) });
    const run = await startRun(config(fetchImpl), keys(120));
    for (const k of keys(120)) await run.add(result(k[0]?.value as string));
    await run.flush();

    expect(seen.resolves).toHaveLength(1);
  });

  it('splits into chunks the platform will accept, and no more', async () => {
    const { seen, fetchImpl } = platform();
    await startRun(config(fetchImpl), keys(700));

    expect(seen.resolves).toHaveLength(2);
    expect(seen.resolves[0]?.keys).toHaveLength(500);
    expect(seen.resolves[1]?.keys).toHaveLength(200);
  });
});

describe('a result with no case is not invented (AC-11)', () => {
  it('does not send it', async () => {
    const { seen, fetchImpl } = platform({ known: { a: 'tc-a' } });
    const run = await startRun(config(fetchImpl), [
      [{ kind: 'playwright-id', value: 'a' }],
      [{ kind: 'playwright-id', value: 'orphan' }],
    ]);
    await run.add(result('a'));
    await run.add(result('orphan'));
    await run.flush();

    expect(seen.results[0]?.results.map((r) => r['testCaseId'])).toEqual(['tc-a']);
  });

  it('counts it and says so once', async () => {
    const { fetchImpl } = platform({ known: { a: 'tc-a' } });
    const cfg = config(fetchImpl);
    const run = await startRun(cfg, [
      [{ kind: 'playwright-id', value: 'a' }],
      [{ kind: 'playwright-id', value: 'orphan' }],
    ]);
    await run.add(result('a'));
    await run.add(result('orphan'));
    await run.finish();

    expect(run.stats.unresolved).toBe(1);
    expect(logOf(cfg).filter((l) => l.includes('1')).length).toBeGreaterThan(0);
  });

  // The top rung of C2's ladder, and the one C1 already needs: a test that names its case outright
  // is not asking to be looked up. The platform makes the same distinction — `plune-id` is not one
  // of its external-key kinds, because it is what those kinds resolve to.
  it('asks nothing about a test that named its case', async () => {
    const { seen, fetchImpl } = platform();
    const run = await startRun(config(fetchImpl));
    await run.add(result('a', { testCaseId: 'tc-named', keys: [] }));
    await run.flush();

    expect(seen.resolves).toHaveLength(0);
    expect(seen.results[0]?.results[0]?.['testCaseId']).toBe('tc-named');
  });

  it('takes the first candidate that resolves, not the first candidate', async () => {
    const { seen, fetchImpl } = platform({ known: { 'tests/a.spec.ts#adds': 'tc-a' } });
    const run = await startRun(config(fetchImpl));
    await run.add(
      result('a', {
        keys: [
          { kind: 'playwright-id', value: 'unknown-id' },
          { kind: 'path-title', value: 'tests/a.spec.ts#adds' },
        ],
      }),
    );
    await run.flush();

    expect(seen.results[0]?.results[0]?.['testCaseId']).toBe('tc-a');
  });
});

describe('batching', () => {
  it('flushes as soon as the buffer reaches the batch size', async () => {
    const { seen, fetchImpl } = platform({ known: { a: 'tc', b: 'tc', c: 'tc' } });
    const run = await startRun(config(fetchImpl, { batchSize: 2 }));
    await run.add(result('a'));
    await run.add(result('b'));
    await run.add(result('c'));
    await run.flush();

    expect(seen.results.map((r) => r.results.length)).toEqual([2, 1]);
  });

  it('sends nothing at all for a run with no tests', async () => {
    const { seen, fetchImpl } = platform();
    const run = await startRun(config(fetchImpl));
    await run.flush();

    expect(seen.results).toHaveLength(0);
  });
});

describe('the platform is not there (AC-05)', () => {
  it('defers the batch and lets the run carry on', async () => {
    const { fetchImpl } = platform({ known: { a: 'tc-a' }, resultsFailure: 'network' });
    const cfg = config(fetchImpl);
    const run = await startRun(cfg);
    await run.add(result('a'));
    await expect(run.flush()).resolves.toBeUndefined();

    const lines = fs.readFileSync(cfg.fallbackPath as string, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(run.stats.deferred).toBe(1);
  });

  it('defers everything when the run itself could not be created', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const cfg = config(fetchImpl);
    const run = await startRun(cfg);
    await run.add(result('a'));
    await run.flush();
    await expect(run.finish()).resolves.toBeUndefined();

    expect(run.runId).toBeNull();
    expect(JSON.parse(fs.readFileSync(cfg.fallbackPath as string, 'utf8').trim())['runId']).toBeNull();
  });
});

describe('a refused token stops the asking (AC-06)', () => {
  it('says what to do once, and never calls again', async () => {
    const { seen, fetchImpl } = platform({
      known: { a: 'tc', b: 'tc' },
      resultsFailure: { status: 401, error: 'unauthorized' },
    });
    const cfg = config(fetchImpl, { batchSize: 1 });
    const run = await startRun(cfg);
    await run.add(result('a'));
    await run.add(result('b'));
    await run.finish();

    expect(logOf(cfg).filter((l) => l.includes('plune login'))).toHaveLength(1);
    expect(seen.events).toHaveLength(0);
  });
});

describe('a closed run is a configuration mistake, not a blip (AC-07)', () => {
  it('names the cause and defers', async () => {
    const { fetchImpl } = platform({
      known: { a: 'tc' },
      resultsFailure: { status: 409, error: "run 'r-1' is closed to new results" },
    });
    const cfg = config(fetchImpl);
    const run = await startRun(cfg);
    await run.add(result('a'));
    await run.flush();

    expect(logOf(cfg).join('\n')).toContain('closed');
    expect(run.stats.deferred).toBe(1);
  });
});

describe('who closes the run (AC-03, AC-08)', () => {
  it('finish sends the lifecycle event', async () => {
    const { seen, fetchImpl } = platform();
    const run = await startRun(config(fetchImpl));
    await run.finish();

    expect(seen.events[0]?.body['event']).toBe('finish');
  });

  it('finishing twice is not an error', async () => {
    const { fetchImpl } = platform();
    const run = await startRun(config(fetchImpl));
    await run.finish();
    await expect(run.finish()).resolves.toBeUndefined();
  });

  it('leaving the run open flushes but does not close it', async () => {
    const { seen, fetchImpl } = platform({ known: { a: 'tc' } });
    const run = await startRun(config(fetchImpl));
    await run.add(result('a'));
    await run.leaveOpen();

    expect(seen.results).toHaveLength(1);
    expect(seen.events).toHaveLength(0);
  });

  it('leaving it open says which run and how to close it', async () => {
    const { fetchImpl } = platform();
    const cfg = config(fetchImpl);
    const run = await startRun(cfg);
    await run.leaveOpen();

    const said = logOf(cfg).join('\n');
    expect(said).toContain('r-1');
    expect(said).toContain('plune run finish');
  });

  // An exit handler that closed the run "just in case" would turn every crashed shard into a green
  // run — which is the one thing AC-08 exists to prevent.
  it('registers no process handler that could close a run behind our back', async () => {
    const before = ['exit', 'beforeExit', 'SIGINT', 'SIGTERM'].map((e) =>
      process.listenerCount(e as NodeJS.Signals),
    );
    const { fetchImpl } = platform();
    await startRun(config(fetchImpl));
    const after = ['exit', 'beforeExit', 'SIGINT', 'SIGTERM'].map((e) =>
      process.listenerCount(e as NodeJS.Signals),
    );

    expect(after).toEqual(before);
  });
});

describe('the reporter does not decide anything the platform decides (AC-01)', () => {
  it('passes the runner word through and never sets a status', async () => {
    const { seen, fetchImpl } = platform({ known: { a: 'tc-a' } });
    const run = await startRun(config(fetchImpl));
    await run.add(result('a', { rawStatus: 'timedOut' }));
    await run.flush();

    const sent = seen.results[0]?.results[0] as Record<string, unknown>;
    expect(sent['rawStatus']).toBe('timedOut');
    expect('status' in sent).toBe(false);
  });
});

describe('nobody logged in', () => {
  // Turning the reporter on before running `plune login` is the ordinary first mistake. It must
  // cost a message, not a run: the results are on disk and a later `plune run report` can send them.
  it('says so, touches nothing, and still keeps the results', async () => {
    const { seen, fetchImpl } = platform();
    const cfg = config(fetchImpl, { token: '' });
    const run = await startRun(cfg);
    await run.add(result('a'));
    await run.finish();

    expect(seen.starts).toHaveLength(0);
    expect(logOf(cfg).join('\n')).toContain('plune login');
    expect(run.stats.deferred).toBe(1);
  });
});

describe('the lookup itself fails', () => {
  it('keeps the results rather than treating them as unmatched', async () => {
    let asked = false;
    const fetchImpl = (async (url: string | URL | Request) => {
      const target = String(url);
      if (target.endsWith('/v1/test-cases/resolve')) {
        asked = true;
        return new Response(JSON.stringify({ error: 'lookup is down' }), { status: 500 });
      }
      if (target.endsWith('/v1/runs')) {
        return new Response(JSON.stringify({ run: { id: 'r-1' }, joined: false }), { status: 201 });
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    }) as unknown as typeof fetch;

    const cfg = config(fetchImpl);
    const run = await startRun(cfg);
    await run.add(result('a'));
    await run.flush();

    expect(asked).toBe(true);
    // Unmatched would mean "the platform knows and says no case exists". It said nothing at all,
    // and reporting that as unmatched would quietly drop a result the run did produce.
    expect(run.stats.unresolved).toBe(0);
    expect(run.stats.deferred).toBe(1);
  });
});

describe('the token stays out of everything a person can read (AC-12)', () => {
  it('is in no log line and in no deferred batch', async () => {
    const { fetchImpl } = platform({
      known: { a: 'tc' },
      resultsFailure: { status: 401, error: `token ${TOKEN} was revoked` },
    });
    const cfg = config(fetchImpl);
    const run = await startRun(cfg);
    await run.add(result('a'));
    await run.finish();

    const written = fs.existsSync(cfg.fallbackPath as string)
      ? fs.readFileSync(cfg.fallbackPath as string, 'utf8')
      : '';
    expect(logOf(cfg).join('\n')).not.toContain(TOKEN);
    expect(written).not.toContain(TOKEN);
  });
});

describe('what the run is called, where it ran, how it is marked (D13)', () => {
  const described = { title: 'nightly regression', environment: 'staging', labels: ['smoke'] };

  it('sends all three when the run opens', async () => {
    const { seen, fetchImpl } = platform();
    await startRun(config(fetchImpl, described));

    expect(seen.starts[0]?.body).toMatchObject(described);
  });

  it('sends nothing it was not given', async () => {
    const { seen, fetchImpl } = platform();
    await startRun(config(fetchImpl));

    expect(Object.keys(seen.starts[0]?.body ?? {})).not.toContain('title');
  });

  /**
   * The one gap the client can see and the server cannot. A deployment older than these columns
   * validates the body, stores what it knows and answers 201 — indistinguishable from success,
   * which is the exact failure the reporter refused these variables to avoid.
   */
  it('says so when the deployment kept none of it', async () => {
    const { fetchImpl } = platform({ storesDescription: false });
    const cfg = config(fetchImpl, described);

    await startRun(cfg);

    expect(logOf(cfg).join('\n')).toMatch(/older than the fields/);
  });

  it('stays quiet when the deployment stored it', async () => {
    const { fetchImpl } = platform();
    const cfg = config(fetchImpl, described);

    await startRun(cfg);

    expect(logOf(cfg).join('\n')).not.toMatch(/older than the fields/);
  });

  // A joiner is told a title it did not set, and the platform keeps the first shard's. One field
  // coming back different is the rule working; only ALL of them coming back empty is a gap.
  it('stays quiet when the run it joined was already named by somebody else', async () => {
    const { fetchImpl } = platform({ startStatus: 200 });
    const cfg = config(fetchImpl, { title: 'shard 2', environment: 'staging' });

    await startRun(cfg);

    expect(logOf(cfg).join('\n')).not.toMatch(/older than the fields/);
  });

  it('stays quiet when it described nothing at all', async () => {
    const { fetchImpl } = platform({ storesDescription: false });
    const cfg = config(fetchImpl);

    await startRun(cfg);

    expect(logOf(cfg).join('\n')).not.toMatch(/older than the fields/);
  });
});

/**
 * D14 — rung 6 of the C2 ladder: `PLUNE_CREATE=1`.
 *
 * It stayed blocked until the platform had a shape for it, and the shape is the whole argument: a
 * proposal carries steps and an expected result, and a reporter has neither. What this sends is a
 * TESTIMONY — this test exists, here is where it lives, here is what it did — and every assertion
 * below is about not sending more than that, and not sending it more than once.
 */
describe('offering tests the platform has no case for (D14)', () => {
  const found = (id: string, over: Partial<PendingResult> = {}): PendingResult =>
    result(id, {
      title: 'cart › adds an item',
      specRef: 'e2e/checkout.spec.ts:12',
      ...over,
    });

  it('offers nothing unless somebody asked for it', async () => {
    // Off by default is a product decision, not caution: a reporter that filled a stranger's review
    // queue on first run would teach the team to stop reading the queue.
    const { seen, fetchImpl } = platform();
    const run = await startRun(config(fetchImpl));
    await run.add(found('pw-1'));
    await run.finish();

    expect(seen.discovered).toEqual([]);
  });

  it('offers the test it could not resolve, with the run that found it', async () => {
    const { seen, fetchImpl } = platform();
    const run = await startRun(config(fetchImpl, { offerDiscovered: true }));
    await run.add(found('pw-1'));
    await run.finish();

    expect(seen.discovered).toHaveLength(1);
    expect(seen.discovered[0]?.body).toMatchObject({
      runId: 'r-1',
      discovered: [
        {
          keys: [{ kind: 'playwright-id', value: 'pw-1' }],
          title: 'cart › adds an item',
          source: 'playwright',
          specRef: 'e2e/checkout.spec.ts:12',
          rawStatus: 'passed',
        },
      ],
    });
  });

  /**
   * The refusal this whole entry kind exists for. A reporter sees a `TestResult`, never the test's
   * source — so there is nothing here that could describe what the test does, and the platform
   * refuses steps by name rather than dropping them.
   */
  it('sends nothing that describes what the test does', async () => {
    const { seen, fetchImpl } = platform();
    const run = await startRun(config(fetchImpl, { offerDiscovered: true }));
    await run.add(found('pw-1'));
    await run.finish();

    const sent = Object.keys((seen.discovered[0]?.body['discovered'] as object[])[0] as object);
    expect(sent.sort()).toEqual(['keys', 'rawStatus', 'source', 'specRef', 'title']);
  });

  it('never offers a test that found its case', async () => {
    const { seen, fetchImpl } = platform({ known: { 'pw-1': 'tc-1' } });
    const run = await startRun(config(fetchImpl, { offerDiscovered: true }));
    await run.add(found('pw-1'));
    await run.finish();

    expect(seen.discovered).toEqual([]);
  });

  // A flaky test runs three times and is ONE missing case. Offering per attempt would fill the queue
  // with rows about a single test, which is how a reviewer learns to ignore it.
  it('offers a retried test once', async () => {
    const { seen, fetchImpl } = platform();
    const run = await startRun(config(fetchImpl, { offerDiscovered: true }));
    await run.add(found('pw-1', { resultKey: 'pw-1#0', rawStatus: 'failed' }));
    await run.add(found('pw-1', { resultKey: 'pw-1#1' }));
    await run.finish();

    expect((seen.discovered[0]?.body['discovered'] as unknown[]).length).toBe(1);
  });

  /**
   * The platform requires both halves and would refuse the whole batch over one thin adapter. Skipped
   * in silence rather than guessed: a file path invented for a test nobody can name is exactly the
   * fabrication D14 was raised to prevent.
   */
  it('skips a test that cannot say what it is called or where it lives', async () => {
    const { seen, fetchImpl } = platform();
    const run = await startRun(config(fetchImpl, { offerDiscovered: true }));
    await run.add(result('pw-thin'));
    await run.add(found('pw-1'));
    await run.finish();

    expect(seen.discovered[0]?.body['discovered']).toHaveLength(1);
  });

  it('counts only what a reviewer now has to look at', async () => {
    // `duplicate`, `refused` and `known` are the platform saying "already handled". Counting them
    // would make every repeat run report new work and the number would stop meaning anything.
    const { fetchImpl } = platform({ discoverOutcomes: ['queued', 'refused'] });
    const cfg = config(fetchImpl, { offerDiscovered: true });
    const run = await startRun(cfg);
    await run.add(found('pw-1'));
    await run.add(found('pw-2', { specRef: 'e2e/checkout.spec.ts:40' }));
    await run.finish();

    expect(run.stats.offered).toBe(1);
    expect(run.stats.unresolved).toBe(2);
    expect(logOf(cfg).at(-1)).toContain('1 offered for review');
  });

  /**
   * A refused offer is reported and dropped, never deferred. The fallback file replays RESULTS; an
   * offer is a question the next run asks again on its own, and writing it there would mean a replay
   * posts to an endpoint the file never promised.
   */
  it('says an offer failed instead of writing it to the fallback file', async () => {
    const { fetchImpl } = platform({ discoverFailure: { status: 500, error: 'nope' } });
    const cfg = config(fetchImpl, { offerDiscovered: true });
    const run = await startRun(cfg);
    await run.add(found('pw-1'));
    await run.finish();

    expect(logOf(cfg).join('\n')).toContain('could not offer 1 unknown test(s) for review');
    expect(fs.existsSync(path.join(dir, 'pending.jsonl'))).toBe(false);
    // The count is also kept, not only printed: the command turns it into the sentence that says
    // another import is needed, and a number that lives only inside a log line cannot do that.
    expect(run.stats.unoffered).toBe(1);
  });

  // Whoever closes the run is not whoever found the test. A shard that only ever leaves the run open
  // would otherwise offer nothing, and a sharded suite is the normal case in CI.
  it('offers from a shard that leaves the run open', async () => {
    const { seen, fetchImpl } = platform();
    const run = await startRun(config(fetchImpl, { offerDiscovered: true }));
    await run.add(found('pw-1'));
    await run.leaveOpen();

    expect(seen.discovered).toHaveLength(1);
  });
});
