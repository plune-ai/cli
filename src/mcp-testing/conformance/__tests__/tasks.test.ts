// The tasks suite of `plune mcp conformance`: each check against a server that keeps its requirement and one that breaks
// it. The servers are processes on this machine (../../__tests__/fixtures/tasks-server.mjs, plain JSON-RPC so no SDK
// corrects what it sends), and one node:http wrapper of the same function for the HTTP check. A tool is called only when
// --fixture names it, and a task the run made is cancelled at the end.

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  handleMcpConformance,
  type McpConformanceFlags,
} from '../../../cli/commands/mcp-conformance.js';
import type { McpConformanceReport } from '../../result.js';
import { CATALOG } from '../catalog.js';
import { PROFILE } from '../profile.js';
// @ts-expect-error a plain .mjs fixture, without types
import { answer } from '../../__tests__/fixtures/tasks-server.mjs';

const SERVER = fileURLToPath(new URL('../../__tests__/fixtures/tasks-server.mjs', import.meta.url));
// Each run starts a server process.
vi.setConfig({ testTimeout: 60_000 });
const dir = mkdtempSync(join(tmpdir(), 'plune-conformance-tasks-'));
const TASKS = CATALOG.filter((e) => e.suite === 'tasks');
const IDS = [
  'tasks-result-type',
  'tasks-undeclared-no-task',
  'tasks-undeclared-capability-error',
  'tasks-get-status-shape',
  'tasks-status-payload',
  'tasks-ttl-poll-integers',
  'tasks-unknown-id-get',
  'tasks-unknown-id-update-cancel',
  'tasks-cancel-ack',
  'tasks-update-ack',
  'tasks-failed-status-message',
  'tasks-http-name-header',
  'tasks-input-request-keys-unique',
];
const EXPORT = [{ tool: 'export', arguments: {} }];
const SECRET = 'Zq7vK2mXpL9wR4tY8nB3cD6fG1hJ5sA0eU2iO';

let n = 0;
const fixtureFile = (calls: unknown) => {
  const path = join(dir, `fixture-${++n}.json`);
  writeFileSync(path, JSON.stringify(calls));
  return path;
};
const logFile = () => join(dir, `calls-${++n}.log`);
const lines = (path: string) =>
  existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : [];
const count = (log: string[], what: string) => log.filter((l) => l === what).length;

async function run(
  mode: string,
  flags: McpConformanceFlags = {},
  era: 'legacy' | 'modern' = 'modern',
) {
  let out = '';
  let err = '';
  const code = await handleMcpConformance(
    {
      timeout: '10s',
      format: 'json',
      suite: ['tasks'],
      protocolVersion: era === 'modern' ? '2026-07-28' : '2025-11-25',
      ...flags,
    },
    [process.execPath, SERVER, mode, ...(era === 'legacy' ? ['legacy'] : [])],
    { out: (s) => (out += s), err: (s) => (err += s), env: {}, cwd: dir, clientVersion: '9.9.9' },
  );
  const json = (flags.format ?? 'json') === 'json' && out !== '';
  return { code, out, err, report: json ? (JSON.parse(out) as McpConformanceReport) : undefined };
}
/** A run with the export tool as the fixture and the calls logged. */
async function withFixture(mode: string, flags: McpConformanceFlags = {}) {
  const log = logFile();
  const r = await run(mode, {
    fixture: fixtureFile(EXPORT),
    ...flags,
    env: [`TASKS_CALL_LOG=${log}`, ...(flags.env ?? [])],
  });
  return { ...r, log: lines(log) };
}

const states = (r: McpConformanceReport | undefined) =>
  Object.fromEntries(
    (r?.checks ?? []).map((c) => [
      c.id,
      c.reason === undefined ? c.state : `${c.state} (${c.reason})`,
    ]),
  );
const byId = (r: McpConformanceReport | undefined, id: string) =>
  r!.checks.find((c) => c.id === id)!;
const HTTP_ONLY = 'tasks-http-name-header';
const others = IDS.filter((id) => id !== HTTP_ONLY);

describe('CLI · mcp conformance · tasks · catalog', () => {
  it('holds the thirteen ids, each with a level, a quoted requirement, a cited section and a link to the extension text', () => {
    expect(TASKS.map((e) => e.id)).toEqual(IDS);
    for (const e of TASKS) {
      expect(e.level, e.id).not.toBeNull();
      expect((e.derivation ?? '').trim(), e.id).not.toBe('');
      expect(e.specRefs.length, e.id).toBeGreaterThan(0);
      for (const r of e.specRefs) {
        expect(r.url, e.id).toMatch(/^https:\/\/github\.com\/modelcontextprotocol\/ext-tasks\//);
        expect(r.revision).toBe('2026-07-28');
      }
      expect(e.eras, e.id).toEqual(['modern']);
      expect(e.needsFixture, e.id).toBe(true);
      expect(e.transports, e.id).toEqual(e.id === HTTP_ONLY ? ['http'] : ['stdio', 'http']);
    }
  });

  it('the levels come from a quoted sentence; a level read from a type or from a sentence about the client is derived', () => {
    const entry = (id: string) => TASKS.find((e) => e.id === id)!;
    const should = ['tasks-unknown-id-update-cancel', 'tasks-failed-status-message'];
    for (const id of should) {
      expect(entry(id).level, id).toBe('SHOULD');
      expect(entry(id).derived, id).toBe(false);
    }
    // A type with no keyword, and a sentence that is about the client: SHOULD at most, and derived.
    for (const id of ['tasks-ttl-poll-integers', HTTP_ONLY]) {
      expect(entry(id).level, id).toBe('SHOULD');
      expect(entry(id).derived, id).toBe(true);
    }
    // The quoted sentences are those of the text: no check is a MUST without a MUST in its derivation.
    for (const e of TASKS.filter((x) => x.level === 'MUST'))
      expect(e.derivation, e.id).toMatch(/MUST/);
    for (const e of TASKS.filter((x) => x.level === 'SHOULD' && !x.derived))
      expect(e.derivation, e.id).toMatch(/SHOULD/);
  });

  it('none of the ids is in the frozen profile: a new check is pending until a new version lists it', () => {
    for (const id of IDS) expect(PROFILE.checks, id).not.toContain(id);
  });

  it('--list-checks --suite tasks lists them, and --explain prints the quoted sentence', async () => {
    let out = '';
    await handleMcpConformance({ listChecks: true, suite: ['tasks'] }, [], {
      out: (s) => (out += s),
      err: () => {},
      env: {},
    });
    expect(out).toContain(`${IDS.length} checks.`);
    for (const id of IDS) expect(out).toContain(id);
    expect(out).not.toContain('life-initialize-result');
    out = '';
    await handleMcpConformance({ explain: 'tasks-unknown-id-get' }, [], {
      out: (s) => (out += s),
      err: () => {},
      env: {},
    });
    expect(out).toContain('Servers **MUST** return this error for `tasks/get`.');
    expect(out).toContain('ext-tasks/blob/main/specification/2026-07-28/tasks.md');
  });
});

describe('CLI · mcp conformance · tasks · what does not apply', () => {
  it('a session of the 2025-11-25 revision: every check is not-applicable (era), nothing is called', async () => {
    const log = logFile();
    const { report } = await run(
      'good',
      { fixture: fixtureFile(EXPORT), env: [`TASKS_CALL_LOG=${log}`] },
      'legacy',
    );
    expect(Object.values(states(report))).toEqual(
      IDS.map((id) => (id === HTTP_ONLY ? 'not-applicable (transport)' : 'not-applicable (era)')),
    );
    expect(lines(log)).toEqual([]);
  });

  it('a server that does not declare the extension: not-applicable (capability-not-declared), never passed, no tool called', async () => {
    const { report, log } = await withFixture('ext-missing');
    expect(states(report)).toEqual(
      Object.fromEntries(
        IDS.map((id) => [
          id,
          id === HTTP_ONLY
            ? 'not-applicable (transport)'
            : 'not-applicable (capability-not-declared)',
        ]),
      ),
    );
    expect(byId(report, 'tasks-result-type').actual).toContain('does not declare');
    expect(log).toEqual([]);
  });

  it('without --fixture every check is could-not-run (needs-input), and no tool is called', async () => {
    const log = logFile();
    const { report } = await run('good', { env: [`TASKS_CALL_LOG=${log}`] });
    expect(states(report)).toEqual(
      Object.fromEntries(
        IDS.map((id) => [
          id,
          id === HTTP_ONLY ? 'not-applicable (transport)' : 'could-not-run (needs-input)',
        ]),
      ),
    );
    expect(byId(report, 'tasks-result-type').actual).toContain('No --fixture');
    expect(lines(log)).toEqual([]);
  });

  it('a --fixture that names a tool the server does not list, or one that makes no task: needs-input, and only the named tool is called', async () => {
    const unlisted = await run('good', { fixture: fixtureFile([{ tool: 'nope', arguments: {} }]) });
    expect(
      Object.values(states(unlisted.report)).filter((s) => s !== 'not-applicable (transport)'),
    ).toEqual(others.map(() => 'could-not-run (needs-input)'));
    const log = logFile();
    const plain = await run('good', {
      fixture: fixtureFile([{ tool: 'plain', arguments: {} }]),
      env: [`TASKS_CALL_LOG=${log}`],
    });
    expect(states(plain.report)['tasks-get-status-shape']).toBe('could-not-run (needs-input)');
    expect(lines(log)).toEqual(['tools/call plain']);
    const none = await withFixture('no-task');
    expect(states(none.report)['tasks-cancel-ack']).toBe('could-not-run (needs-input)');
    // One call with the declaration; the same tool is not called again for a task that does not come.
    expect(none.log).toEqual(['tools/call export']);
  });
});

describe('CLI · mcp conformance · tasks · a server that keeps every requirement', () => {
  it('passes every check it can be judged on, and says that a failed task was not seen', async () => {
    const { report, code, log } = await withFixture('good');
    expect(states(report)).toEqual({
      'tasks-result-type': 'passed',
      'tasks-undeclared-no-task': 'passed',
      'tasks-undeclared-capability-error': 'passed',
      'tasks-get-status-shape': 'passed',
      'tasks-status-payload': 'passed',
      'tasks-ttl-poll-integers': 'passed',
      'tasks-unknown-id-get': 'passed',
      'tasks-unknown-id-update-cancel': 'passed',
      'tasks-cancel-ack': 'passed',
      'tasks-update-ack': 'passed',
      'tasks-failed-status-message': 'not-applicable (not-offered)',
      'tasks-http-name-header': 'not-applicable (transport)',
      'tasks-input-request-keys-unique': 'passed',
    });
    // Outside the frozen profile: pending for the score, so a run of this suite alone proves nothing: exit 3.
    expect(code).toBe(3);
    expect(report!.pendingCheckIds).toEqual(expect.arrayContaining(['tasks-result-type']));
    // Three tasks at most: the one read, the one without the declaration, the one that is cancelled.
    expect(count(log, 'tools/call export')).toBe(3);
    // Nothing was left: no note.
    expect(byId(report, 'tasks-input-request-keys-unique').actual).not.toContain('Left behind');
  });

  it('a task that fails is read: payload and statusMessage are judged', async () => {
    const { report } = await withFixture('failing');
    expect(byId(report, 'tasks-status-payload').state).toBe('passed');
    expect(byId(report, 'tasks-failed-status-message').state).toBe('passed');
    expect(byId(report, 'tasks-input-request-keys-unique').state).toBe('not-applicable');
  });
});

describe('CLI · mcp conformance · tasks · each requirement broken on its own', () => {
  const cases: [string, string, string, string][] = [
    ['a task handle without resultType "task"', 'untyped', 'tasks-result-type', 'failed'],
    ['resultType "task" on tools/list', 'task-elsewhere', 'tasks-result-type', 'failed'],
    [
      'a task for a client that did not declare the extension',
      'task-undeclared',
      'tasks-undeclared-no-task',
      'failed',
    ],
    [
      'tasks/* served without the declaration',
      'undeclared-ok',
      'tasks-undeclared-capability-error',
      'failed',
    ],
    [
      '-32602 where -32021 is asked for',
      'undeclared-code',
      'tasks-undeclared-capability-error',
      'failed',
    ],
    [
      '-32021 without data.requiredCapabilities',
      'undeclared-no-data',
      'tasks-undeclared-capability-error',
      'failed',
    ],
    ['tasks/get without resultType', 'no-result-type', 'tasks-get-status-shape', 'failed'],
    ['a status the specification does not have', 'bad-status', 'tasks-get-status-shape', 'failed'],
    ['tasks/get without createdAt', 'no-created', 'tasks-get-status-shape', 'failed'],
    ['completed without a result', 'no-result', 'tasks-status-payload', 'failed'],
    ['failed without an error', 'no-error', 'tasks-status-payload', 'failed'],
    ['input_required without inputRequests', 'no-input-requests', 'tasks-status-payload', 'failed'],
    [
      'a fractional ttlMs and a string pollIntervalMs',
      'float-ttl',
      'tasks-ttl-poll-integers',
      'failed',
    ],
    ['tasks/get for an unknown id served', 'unknown-ok', 'tasks-unknown-id-get', 'failed'],
    [
      'tasks/get for an unknown id answered -32603',
      'unknown-code',
      'tasks-unknown-id-get',
      'failed',
    ],
    [
      'tasks/update and tasks/cancel for an unknown id acknowledged',
      'unknown-update-ok',
      'tasks-unknown-id-update-cancel',
      'failed',
    ],
    ['tasks/cancel that answers a task', 'cancel-extra', 'tasks-cancel-ack', 'failed'],
    ['tasks/cancel without resultType', 'cancel-no-type', 'tasks-cancel-ack', 'failed'],
    [
      'tasks/cancel that is an error for a task that still runs',
      'cancel-error',
      'tasks-cancel-ack',
      'failed',
    ],
    ['tasks/update that answers a task', 'update-extra', 'tasks-update-ack', 'failed'],
    ['tasks/update without resultType', 'update-no-type', 'tasks-update-ack', 'failed'],
    [
      'a failed task without statusMessage',
      'failing-no-message',
      'tasks-failed-status-message',
      'failed',
    ],
    [
      'an inputRequests key that holds another request',
      'key-reuse',
      'tasks-input-request-keys-unique',
      'failed',
    ],
  ];
  for (const [what, mode, id, state] of cases)
    it(`${what}: ${id} is ${state}`, async () => {
      const { report } = await withFixture(mode);
      expect(byId(report, id).state).toBe(state);
      expect(byId(report, id).actual).not.toBe('');
      expect(byId(report, id).fix).not.toBe('');
    });

  it('tasks/update that is an error says nothing about the acknowledgement: could-not-run', async () => {
    const { report } = await withFixture('update-error');
    expect(states(report)['tasks-update-ack']).toBe('could-not-run (prerequisite-failed)');
  });

  it('the broken servers leave the checks they do not break alone', async () => {
    expect(states((await withFixture('float-ttl')).report)['tasks-get-status-shape']).toBe(
      'passed',
    );
    expect(states((await withFixture('no-error')).report)['tasks-ttl-poll-integers']).toBe(
      'passed',
    );
    const untyped = states((await withFixture('untyped')).report);
    // No task to read: the others are could-not-run, never passed or failed.
    expect(untyped['tasks-get-status-shape']).toBe('could-not-run (prerequisite-failed)');
  });

  it('a failed check does not move the exit code: the suite alone is exit 3', async () => {
    const { code } = await withFixture('cancel-extra');
    expect(code).toBe(3);
  });
});

describe('CLI · mcp conformance · tasks · a task that never finishes', () => {
  it('is polled six times at most, then cancelled once; a cancel that works leaves nothing behind', async () => {
    const { report, log } = await withFixture('never', { check: ['tasks-get-status-shape'] });
    expect(byId(report, 'tasks-get-status-shape').state).toBe('passed');
    expect(count(log, 'tools/call export')).toBe(1);
    // Six polls of the check, one after the cancel at the end.
    expect(count(log, 'tasks/get')).toBe(7);
    expect(count(log, 'tasks/cancel')).toBe(1);
    expect(byId(report, 'tasks-get-status-shape').actual).not.toContain('Left behind');
  });

  it('a cancel that is acknowledged but changes nothing is reported as created and left running', async () => {
    const { report, log } = await withFixture('stuck', { check: ['tasks-get-status-shape'] });
    expect(count(log, 'tasks/get')).toBe(7);
    expect(count(log, 'tasks/cancel')).toBe(1);
    const actual = byId(report, 'tasks-get-status-shape').actual;
    expect(actual).toContain('Left behind');
    expect(actual).toContain('1 task created by this run and not seen finished');
    expect(actual).toContain('was left running');
    expect(actual).toContain('"working"');
  });

  it('a task whose cancel is an error is reported with an unknown state', async () => {
    const { report } = await withFixture('cancel-error', { check: ['tasks-cancel-ack'] });
    expect(byId(report, 'tasks-cancel-ack').actual).toContain('Left behind');
    expect(byId(report, 'tasks-cancel-ack').actual).toContain('was left running');
  });
});

describe('CLI · mcp conformance · tasks · text the server chooses', () => {
  it('a secret in a task id is masked before it is cut, and a leading :: is neutralised', async () => {
    for (const format of ['json', 'human']) {
      const { out, err } = await withFixture('hostile', {
        format,
        env: [`TASKS_SECRET=${SECRET}`],
      });
      const all = `${out}\n${err}`;
      for (let i = 0; i + 8 <= SECRET.length; i++)
        expect(all, `${format} ${SECRET.slice(i, i + 8)}`).not.toContain(SECRET.slice(i, i + 8));
      for (const l of all.split('\n')) expect(l.startsWith('::'), l.slice(0, 40)).toBe(false);
    }
  });
});

describe('CLI · mcp conformance · tasks · over Streamable HTTP', () => {
  const open: { close(): void }[] = [];
  afterEach(() => {
    for (const s of open.splice(0)) s.close();
  });
  type Rule = 'good' | 'refuse-name' | 'down';
  async function serve(rule: Rule) {
    const seen: { method: string; name: string | undefined; taskId: unknown }[] = [];
    const state = { tasks: new Map() };
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += String(c)));
      req.on('end', () => {
        if (req.method !== 'POST') return res.writeHead(405).end();
        let msg: { id?: string; method: string; params?: Record<string, unknown> };
        try {
          msg = JSON.parse(body) as typeof msg;
        } catch {
          return res.writeHead(400).end();
        }
        if (msg.id === undefined) return res.writeHead(202).end();
        const name = req.headers['mcp-name'] as string | undefined;
        if (msg.method.startsWith('tasks/'))
          seen.push({ method: msg.method, name, taskId: msg.params?.['taskId'] });
        const reply = (status: number, frame: unknown) =>
          res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(frame));
        if (msg.method === 'tasks/get' && rule === 'down') return res.writeHead(503).end('busy');
        if (
          msg.method.startsWith('tasks/') &&
          (rule === 'refuse-name' || name !== msg.params?.['taskId'])
        )
          return reply(400, {
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32020, message: 'Header mismatch: Mcp-Name' },
          });
        let sent = false;
        answer('good', state, msg, (f: { id?: unknown }) => {
          if (sent || f.id === undefined) return;
          sent = true;
          reply(200, f);
        });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    open.push({
      close: () => {
        server.closeAllConnections();
        server.close();
      },
    });
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, seen };
  }
  const runHttp = async (url: string) => {
    let out = '';
    await handleMcpConformance(
      {
        timeout: '10s',
        format: 'json',
        suite: ['tasks'],
        protocolVersion: '2026-07-28',
        url,
        fixture: fixtureFile(EXPORT),
      },
      [],
      { out: (s) => (out += s), err: () => {}, env: {}, cwd: dir, clientVersion: '9.9.9' },
    );
    return JSON.parse(out) as McpConformanceReport;
  };

  it('tasks/get is sent with Mcp-Name set to the taskId, and a server that accepts it passes every check', async () => {
    const s = await serve('good');
    const report = await runHttp(s.url);
    expect(states(report)[HTTP_ONLY]).toBe('passed');
    expect(states(report)['tasks-get-status-shape']).toBe('passed');
    expect(states(report)['tasks-cancel-ack']).toBe('passed');
    expect(s.seen.length).toBeGreaterThan(0);
    for (const x of s.seen) expect(x.name, x.method).toBe(x.taskId);
  });

  it('a server that refuses Mcp-Name set to the taskId fails the check', async () => {
    const s = await serve('refuse-name');
    const report = await runHttp(s.url);
    expect(states(report)[HTTP_ONLY]).toBe('failed');
  });

  it('a 503 is not a verdict: could-not-run (transport-error), never failed', async () => {
    const s = await serve('down');
    const report = await runHttp(s.url);
    expect(states(report)[HTTP_ONLY]).toBe('could-not-run (transport-error)');
    expect(states(report)['tasks-get-status-shape']).toBe('could-not-run (transport-error)');
  });
});
