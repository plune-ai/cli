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

function platform(reply?: (url: string) => { status: number; body: unknown } | undefined) {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url).replace('https://api.test', '');
    seen.push({ path: target, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    const forced = reply?.(target);
    const payload =
      forced ??
      (target === '/v1/runs'
        ? { status: 201, body: { run: { id: 'r-1' }, joined: false } }
        : target.endsWith('/results')
          ? { status: 200, body: { items: [], counts: { accepted: 1, duplicate: 0, conflict: 0, rejected: 0 } } }
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

  // The replay cannot know whether the run is complete, so it must not claim it is.
  it('does not close a run it only refilled', async () => {
    const pending = { resultKey: 'a#0', keys: [{ value: 'a' }], source: 'playwright', rawStatus: 'passed' };
    fs.writeFileSync(file, JSON.stringify({ runId: null, externalKey: 'ci-7', results: [pending] }) + '\n');
    const { seen, fetchImpl } = platform();
    await handleRunReport({ ...deps(fetchImpl), file });

    expect(seen.filter((s) => s.path.endsWith('/events'))).toEqual([]);
  });

  // A partly failed replay must not be the reason the rest disappears.
  it('leaves the file where it was', async () => {
    fs.writeFileSync(file, JSON.stringify({ runId: 'r-9', externalKey: null, results: [submission] }) + '\n');
    const { fetchImpl } = platform();
    await handleRunReport({ ...deps(fetchImpl), file });

    expect(fs.existsSync(file)).toBe(true);
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
