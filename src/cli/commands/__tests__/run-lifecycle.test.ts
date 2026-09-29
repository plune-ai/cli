import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  handleRunDelete,
  handleRunExec,
  handleRunFinish,
  handleRunReport,
  handleRunStart,
  NoTokenError,
  RunCommandError,
} from '../run-lifecycle.js';

const TOKEN = 'tok-lifecycle';

interface Seen {
  path: string;
  body: Record<string, unknown>;
}

function platform(
  reply?: (
    url: string,
    body: Record<string, unknown>,
  ) => { status: number; body: unknown } | undefined,
) {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url).replace('https://api.test', '');
    const sent = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    seen.push({ path: target, body: sent });
    const forced = reply?.(target, sent);
    const payload =
      forced ??
      (target === '/v1/runs'
        ? { status: 201, body: { run: { id: 'r-1' }, joined: false } }
        : target.endsWith('/results')
          ? {
              status: 200,
              body: {
                items: [],
                // As many accepted as were sent — what a platform that stores them answers.
                counts: {
                  accepted: ((sent['results'] ?? [{}]) as unknown[]).length,
                  duplicate: 0,
                  conflict: 0,
                  rejected: 0,
                },
              },
            }
          : target.endsWith('/resolve')
            ? { status: 200, body: { results: [] } }
            : { status: 200, body: { run: { id: 'r-1' }, changed: true } });
    return new Response(JSON.stringify(payload.body), {
      status: payload.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}

const lines: string[] = [];
const deps = (fetchImpl: typeof fetch) => ({
  apiUrl: 'https://api.test',
  token: TOKEN,
  fetchImpl,
  write: (l: string) => void lines.push(l),
});

beforeEach(() => {
  lines.length = 0;
});

describe('plune run start', () => {
  it('opens a run and points at it', async () => {
    const { seen, fetchImpl } = platform();
    const out = await handleRunStart({ ...deps(fetchImpl), key: 'ci-7' });

    expect(seen[0]?.body).toMatchObject({ schemaVersion: 2, externalKey: 'ci-7' });
    expect(out.joined).toBe(false);
    expect(lines[0]).toContain('Started run r-1');
  });

  it('says it joined when the run already existed', async () => {
    const { fetchImpl } = platform(() => ({ status: 200, body: { run: { id: 'r-1' }, joined: true } }));
    const out = await handleRunStart({ ...deps(fetchImpl), key: 'ci-7' });

    expect(out.joined).toBe(true);
    expect(lines[0]).toContain('Joined run r-1');
  });

  // `exec` passes the key to the child, so there always has to be one — a generated key is what
  // lets `plune run exec` work without the caller inventing a naming scheme.
  it('invents a key when nobody gave one', async () => {
    const { fetchImpl } = platform();
    const out = await handleRunStart({ ...deps(fetchImpl), now: () => 1_700_000_000_000 });

    expect(out.externalKey).toMatch(/^plune-[a-z0-9]+$/);
  });

  it('prints one machine-readable line when asked', async () => {
    const { fetchImpl } = platform();
    await handleRunStart({ ...deps(fetchImpl), key: 'ci-7', json: true });

    expect(JSON.parse(lines[0] as string)).toMatchObject({ id: 'r-1', externalKey: 'ci-7' });
  });

  it('refuses without a token, and says how to get one', async () => {
    const { fetchImpl } = platform();
    await expect(
      handleRunStart({ apiUrl: 'https://api.test', token: '', fetchImpl }),
    ).rejects.toBeInstanceOf(NoTokenError);
  });
});

describe('plune run finish', () => {
  it('sends the lifecycle event', async () => {
    const { seen, fetchImpl } = platform();
    await handleRunFinish('r-1', deps(fetchImpl));

    expect(seen[0]?.path).toBe('/v1/runs/r-1/events');
    expect(seen[0]?.body['event']).toBe('finish');
  });

  it('can cut a run short instead, with a reason', async () => {
    const { seen, fetchImpl } = platform();
    await handleRunFinish('r-1', { ...deps(fetchImpl), terminate: true, reason: 'CI cancelled' });

    expect(seen[0]?.body).toMatchObject({ event: 'terminate', reason: 'CI cancelled' });
  });

  // The platform answers a refusal with the transitions it would have accepted. Passing that
  // through is the difference between "try again" and "the merge step already closed this".
  it('repeats what the platform said when it refused', async () => {
    const { fetchImpl } = platform(() => ({
      status: 409,
      body: { error: "event 'terminate' is not allowed on a finished run — allowed: finish" },
    }));

    await expect(handleRunFinish('r-1', { ...deps(fetchImpl), terminate: true })).rejects.toThrow(
      /not allowed on a finished run/,
    );
  });

  it('names the likely cause of a run it cannot find', async () => {
    const { fetchImpl } = platform(() => ({ status: 404, body: { error: 'nope' } }));

    await expect(handleRunFinish('r-9', deps(fetchImpl))).rejects.toThrow(/same project/);
  });
});

describe('plune run exec', () => {
  function fakeSpawn(code: number) {
    const calls: { cmd: string; args: string[]; env: Record<string, string | undefined> }[] = [];
    const impl = ((cmd: string, args: string[], opts: { env: Record<string, string> }) => {
      calls.push({ cmd, args, env: opts.env });
      const child = new EventEmitter();
      setTimeout(() => child.emit('close', code), 0);
      return child;
    }) as unknown as typeof import('node:child_process').spawn;
    return { calls, impl };
  }

  it('tells the child which run to join, and not to close it', async () => {
    const { fetchImpl } = platform();
    const { calls, impl } = fakeSpawn(0);
    await handleRunExec({ ...deps(fetchImpl), key: 'ci-7', argv: ['npx', 'playwright', 'test'], spawnImpl: impl });

    expect(calls[0]?.cmd).toBe('npx');
    expect(calls[0]?.env['PLUNE_RUN']).toBe('ci-7');
    expect(calls[0]?.env['PLUNE_PROCEED']).toBe('1');
  });

  it('returns the command exit code, not its own', async () => {
    const { fetchImpl } = platform();
    const { impl } = fakeSpawn(3);
    const code = await handleRunExec({ ...deps(fetchImpl), key: 'ci-7', argv: ['false'], spawnImpl: impl });

    expect(code).toBe(3);
  });

  // A failed test run is still a finished one. Leaving it open would say "we never found out".
  it('closes the run even when the command failed', async () => {
    const { seen, fetchImpl } = platform();
    const { impl } = fakeSpawn(1);
    await handleRunExec({ ...deps(fetchImpl), key: 'ci-7', argv: ['false'], spawnImpl: impl });

    expect(seen.map((s) => s.path)).toEqual(['/v1/runs', '/v1/runs/r-1/events']);
  });

  it('refuses an empty command rather than opening a run for nothing', async () => {
    const { seen, fetchImpl } = platform();

    await expect(handleRunExec({ ...deps(fetchImpl), argv: [] })).rejects.toBeInstanceOf(RunCommandError);
    expect(seen).toEqual([]);
  });
});

describe('plune run report', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-replay-'));
    file = path.join(dir, 'pending.jsonl');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const submission = { resultKey: 'a#0', testCaseId: 'tc-1', source: 'playwright', rawStatus: 'passed' };
  /** A platform that knows every test, so a replayed result is sent rather than deferred again. */
  const knowing = (url: string, body: Record<string, unknown>) =>
    url.endsWith('/resolve')
      ? {
          status: 200,
          body: {
            results: ((body['keys'] ?? []) as { value: string }[]).map((key) => ({
              key,
              testCaseId: `tc-${key.value}`,
            })),
          },
        }
      : undefined;
  /** One result of the kind a reporter defers when the platform is not there: no case looked up yet. */
  const unresolved = (key: string) => ({
    resultKey: `${key}#0`,
    keys: [{ value: key }],
    source: 'playwright',
    rawStatus: 'passed',
  });
  /** One line of a reporter's fallback file: a batch that never reached a run, by session `session` if it has one. */
  const batchOf = (session: string | undefined, ...keys: string[]) =>
    JSON.stringify({
      runId: null,
      externalKey: null,
      ...(session !== undefined ? { session } : {}),
      results: keys.map(unresolved),
    });
  const runsOpened = (seen: { path: string }[]) => seen.filter((s) => s.path === '/v1/runs');
  const stillOpen = () => lines.filter((l) => l.includes('is still open'));

  it('sends a batch back to the run it was meant for', async () => {
    fs.writeFileSync(file, JSON.stringify({ runId: 'r-9', externalKey: 'ci-7', results: [submission] }) + '\n');
    const { seen, fetchImpl } = platform();
    const out = await handleRunReport({ ...deps(fetchImpl), file });

    expect(seen[0]?.path).toBe('/v1/runs/r-9/results');
    expect(out.sent).toBe(1);
  });

  it('opens a run for a batch that never reached one', async () => {
    const pending = { resultKey: 'a#0', keys: [{ value: 'a' }], source: 'playwright', rawStatus: 'passed' };
    fs.writeFileSync(file, JSON.stringify({ runId: null, externalKey: 'ci-7', results: [pending] }) + '\n');
    const { seen, fetchImpl } = platform();
    await handleRunReport({ ...deps(fetchImpl), file });

    expect(seen.map((s) => s.path)).toContain('/v1/runs');
  });

  // plune#927. The run a replay opens is the run the reporter would have opened: with the commit and
  // branch the line recorded, not with those of whatever machine replays it. A line written before the
  // field existed has none, and is not given one — nothing is guessed at replay time.
  it('opens the run with the meta the line recorded, and with none for a line that has none', async () => {
    const meta = {
      runner: 'playwright',
      ciUrl: 'https://ci.test/runs/1',
      sha: 'abc123',
      branch: 'feat/panel',
    };
    const pending = {
      resultKey: 'a#0',
      keys: [{ value: 'a' }],
      source: 'playwright',
      rawStatus: 'passed',
    };
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ runId: null, externalKey: 'ci-7', meta, results: [pending] }),
        JSON.stringify({ runId: null, externalKey: 'ci-8', results: [pending] }),
      ].join('\n') + '\n',
    );
    const { seen, fetchImpl } = platform(knowing);
    await handleRunReport({ ...deps(fetchImpl), file });

    const starts = seen.filter((s) => s.path === '/v1/runs').map((s) => s.body);
    expect(starts).toHaveLength(2);
    expect(starts[0]).toMatchObject({ externalKey: 'ci-7', meta });
    expect(starts[1]).toMatchObject({ externalKey: 'ci-8' });
    expect(starts[1]).not.toHaveProperty('meta');
  });

  // The replay cannot know whether the run is complete, so it must not claim it is.
  it('does not close a run it only refilled', async () => {
    const pending = { resultKey: 'a#0', keys: [{ value: 'a' }], source: 'playwright', rawStatus: 'passed' };
    fs.writeFileSync(file, JSON.stringify({ runId: null, externalKey: 'ci-7', results: [pending] }) + '\n');
    const { seen, fetchImpl } = platform();
    await handleRunReport({ ...deps(fetchImpl), file });

    expect(seen.filter((s) => s.path.endsWith('/events'))).toEqual([]);
  });

  // A partly failed replay must not be the reason the rest disappears.
  it('leaves the file where it was when anything did not go', async () => {
    const line = JSON.stringify({ runId: 'r-9', externalKey: null, results: [submission] }) + '\n';
    fs.writeFileSync(file, line);
    const { fetchImpl } = platform((url) =>
      url.endsWith('/results')
        ? { status: 409, body: { error: "run 'r-9' is closed to new results" } }
        : undefined,
    );
    const out = await handleRunReport({ ...deps(fetchImpl), file });

    expect(out).toEqual({ batches: 1, sent: 0, failed: 1 });
    expect(fs.readFileSync(file, 'utf8')).toBe(line);
    expect(fs.readdirSync(dir)).toEqual(['pending.jsonl']);
  });

  /**
   * plune-ai/cli#45. The reporter writes a line per batch, and the replay opened a run for every one:
   * a run of 24 tests at a batch of 10 came back as three open runs, each to be closed by hand. The
   * lines one reporter session wrote are one run's worth, and are marked as such.
   */
  describe('the batches of one reporter session are one run (cli#45)', () => {
    it('opens one run for them, sends every result to it, and leaves it open once', async () => {
      fs.writeFileSync(
        file,
        [batchOf('s-1', 't1', 't2'), batchOf('s-1', 't3', 't4'), batchOf('s-1', 't5')].join('\n') +
          '\n',
      );
      const { seen, fetchImpl } = platform(knowing);
      const out = await handleRunReport({ ...deps(fetchImpl), file });

      expect(runsOpened(seen)).toHaveLength(1);
      const sent = seen
        .filter((s) => s.path === '/v1/runs/r-1/results')
        .flatMap((s) => s.body['results'] as { resultKey: string }[]);
      expect(sent.map((r) => r.resultKey)).toEqual(['t1#0', 't2#0', 't3#0', 't4#0', 't5#0']);
      // Not closed — it cannot know the run is complete — and said once, not once a batch.
      expect(seen.filter((s) => s.path.endsWith('/events'))).toEqual([]);
      expect(stillOpen()).toHaveLength(1);
      expect(out).toEqual({ batches: 3, sent: 5, failed: 0 });
    });

    it('keeps the sessions apart: a run for each', async () => {
      fs.writeFileSync(
        file,
        [batchOf('s-1', 't1'), batchOf('s-2', 't2'), batchOf('s-1', 't3')].join('\n') + '\n',
      );
      const { seen, fetchImpl } = platform(knowing);
      const out = await handleRunReport({ ...deps(fetchImpl), file });

      expect(runsOpened(seen)).toHaveLength(2);
      expect(stillOpen()).toHaveLength(2);
      expect(out).toEqual({ batches: 3, sent: 3, failed: 0 });
    });

    // A file an older reporter wrote has no marker, and nothing in it says that two lines belong
    // together — so each is what it was: a run of its own.
    it('gives a line with no marker a run of its own, as it always had', async () => {
      fs.writeFileSync(
        file,
        [
          batchOf(undefined, 't1'),
          batchOf('s-1', 't2'),
          batchOf('s-1', 't3'),
          batchOf(undefined, 't4'),
        ].join('\n') + '\n',
      );
      const { seen, fetchImpl } = platform(knowing);
      const out = await handleRunReport({ ...deps(fetchImpl), file });

      expect(runsOpened(seen)).toHaveLength(3);
      expect(stillOpen()).toHaveLength(3);
      expect(out).toEqual({ batches: 4, sent: 4, failed: 0 });
    });

    // Those lines already belong to a run and hold results with their cases: each still goes back to
    // that run, as it is, and nothing is opened for it.
    it('still sends a batch that has its run to that run', async () => {
      const line = (id: string) =>
        JSON.stringify({
          runId: 'r-9',
          externalKey: null,
          session: 's-1',
          results: [{ ...submission, resultKey: `${id}#0` }],
        });
      fs.writeFileSync(file, [line('a'), line('b')].join('\n') + '\n');
      const { seen, fetchImpl } = platform();
      const out = await handleRunReport({ ...deps(fetchImpl), file });

      expect(seen.map((s) => s.path)).toEqual(['/v1/runs/r-9/results', '/v1/runs/r-9/results']);
      expect(out).toEqual({ batches: 2, sent: 2, failed: 0 });
    });

    it('counts what did not go in any of them', async () => {
      fs.writeFileSync(file, [batchOf('s-1', 't1'), batchOf('s-2', 't2')].join('\n') + '\n');
      // The platform has never heard of `t2`, so its result cannot be sent.
      const { fetchImpl } = platform((url, body) =>
        url.endsWith('/resolve')
          ? {
              status: 200,
              body: {
                results: ((body['keys'] ?? []) as { value: string }[]).map((key) => ({
                  key,
                  testCaseId: key.value === 't1' ? 'tc-t1' : null,
                })),
              },
            }
          : undefined,
      );
      const out = await handleRunReport({ ...deps(fetchImpl), file });

      expect(out).toEqual({ batches: 2, sent: 1, failed: 1 });
    });
  });

  /**
   * plune-ai/cli#45. "Nothing is lost" became "sent twice": the file stayed where it was after every
   * replay, and the next one sent it all again. Once everything has gone it is set aside under a name
   * that says so — not deleted, since a person may want to see what was sent.
   */
  describe('the file after a replay that sent everything (cli#45)', () => {
    const at = Date.UTC(2026, 8, 29, 21, 5, 33, 123);

    it('is renamed, beside itself, with when — and holds what it held', async () => {
      const fallback = path.join(dir, 'pending-results.jsonl');
      const text = batchOf('s-1', 't1') + '\n' + batchOf('s-1', 't2') + '\n';
      fs.writeFileSync(fallback, text);
      const { fetchImpl } = platform(knowing);
      await handleRunReport({ ...deps(fetchImpl), file: fallback, now: () => at });

      const renamed = path.join(dir, 'pending-results.2026-09-29T21-05-33-123Z.sent.jsonl');
      expect(fs.readdirSync(dir)).toEqual(['pending-results.2026-09-29T21-05-33-123Z.sent.jsonl']);
      expect(fs.readFileSync(renamed, 'utf8')).toBe(text);
      // Where it went is said, so nobody looks for the file and finds nothing.
      expect(lines.join('\n')).toContain(`${fallback} is now ${renamed}`);
    });

    it('is kept as it is when anything did not go, and a later replay finds it', async () => {
      const text = batchOf('s-1', 't1') + '\n';
      fs.writeFileSync(file, text);
      // The platform does not know the test, so nothing can be sent.
      const { fetchImpl } = platform((url, body) =>
        url.endsWith('/resolve')
          ? {
              status: 200,
              body: {
                results: ((body['keys'] ?? []) as { value: string }[]).map((key) => ({
                  key,
                  testCaseId: null,
                })),
              },
            }
          : undefined,
      );
      const out = await handleRunReport({ ...deps(fetchImpl), file, now: () => at });

      expect(out.failed).toBe(1);
      expect(fs.readFileSync(file, 'utf8')).toBe(text);
      expect(fs.readdirSync(dir)).toEqual(['pending.jsonl']);
    });

    // The results are delivered; a file that cannot be renamed is a chore, not a failed replay — and the
    // one thing worth saying is that the next replay would send them again.
    it('says so when it cannot be renamed, and still reports what was sent', async () => {
      fs.writeFileSync(file, batchOf('s-1', 't1') + '\n');
      // Something already lies where the name would go.
      fs.mkdirSync(path.join(dir, 'pending.2026-09-29T21-05-33-123Z.sent.jsonl'));
      const { fetchImpl } = platform(knowing);
      const out = await handleRunReport({ ...deps(fetchImpl), file, now: () => at });

      expect(out).toEqual({ batches: 1, sent: 1, failed: 0 });
      expect(fs.existsSync(file)).toBe(true);
      expect(lines.join('\n')).toMatch(/could not be renamed.*sends them again/s);
    });
  });

  it('says so plainly when there is nothing to send', async () => {
    const { fetchImpl } = platform();

    await expect(handleRunReport({ ...deps(fetchImpl), file })).rejects.toThrow(/no file at/);
    fs.writeFileSync(file, '\n');
    await expect(handleRunReport({ ...deps(fetchImpl), file })).rejects.toThrow(/is empty/);
  });

  it('counts what the platform refused instead of calling it sent', async () => {
    fs.writeFileSync(file, JSON.stringify({ runId: 'r-9', externalKey: null, results: [submission] }) + '\n');
    const { fetchImpl } = platform((url) =>
      url.endsWith('/results') ? { status: 409, body: { error: "run 'r-9' is closed to new results" } } : undefined,
    );
    const out = await handleRunReport({ ...deps(fetchImpl), file });

    expect(out).toMatchObject({ sent: 0, failed: 1 });
    expect(lines.join('\n')).toContain('closed');
  });
});

/**
 * `plune run delete` (D17).
 *
 * Its own fetch fake rather than the shared `platform()` above, because the two things worth
 * asserting are exactly the two that helper hides: the METHOD, which it never records, and a 204,
 * which it never returns. A delete that arrived as a POST and a 204 read as a parse failure would
 * both pass a test written against the shared one.
 */
describe('plune run delete', () => {
  function server(status: number, body?: unknown) {
    const seen: { method: string; path: string }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({
        method: String(init?.method),
        path: String(url).replace('https://api.test', ''),
      });
      return status === 204
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify(body ?? {}), {
            status,
            headers: { 'content-type': 'application/json' },
          });
    }) as unknown as typeof fetch;
    return { seen, fetchImpl };
  }

  it('sends a DELETE and reads the 204 as success, not as an empty body', async () => {
    const { seen, fetchImpl } = server(204);

    await handleRunDelete('r-42', deps(fetchImpl));

    expect(seen).toEqual([{ method: 'DELETE', path: '/v1/runs/r-42' }]);
    // The whole reason the command can be run without asking first, said where the person is
    // looking. Reassurance after the fact is the only kind this command can offer.
    expect(lines.join(' ')).toMatch(/six months/i);
  });

  it('names all three causes of a 404, because the platform names none', async () => {
    const { fetchImpl } = server(404, { error: "run 'r-42' not found" });

    await expect(handleRunDelete('r-42', deps(fetchImpl))).rejects.toThrow(RunCommandError);
    await expect(handleRunDelete('r-42', deps(fetchImpl))).rejects.toThrow(
      /check the id.*same project.*already deleted/s,
    );
  });

  it('does not retry a refusal', async () => {
    // A 404 is classified, not transient. Retrying it would turn a typo into four requests and a
    // several-second wait before the message that was ready immediately.
    const { seen, fetchImpl } = server(404, { error: 'nope' });

    await expect(handleRunDelete('r-42', deps(fetchImpl))).rejects.toThrow(RunCommandError);

    expect(seen).toHaveLength(1);
  });

  it('refuses without a token rather than reporting a delete nobody made', async () => {
    const { seen, fetchImpl } = server(204);

    await expect(
      handleRunDelete('r-42', { apiUrl: 'https://api.test', token: '', fetchImpl }),
    ).rejects.toThrow(NoTokenError);

    expect(seen, 'a request went out with no credential').toEqual([]);
  });
});
