// `plune mcp snapshot` and `plune mcp diff` end to end against real servers: the stdio fixture
// (./fixtures/snapshot-server.mjs) as a process, and the same server over Streamable HTTP on 127.0.0.1. Nothing here
// reaches past this machine.

import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  diffOperands,
  handleMcpDiff,
  MCP_DIFF_MARKER,
  type McpDiffFlags,
} from '../../cli/commands/mcp-diff.js';
import { handleMcpSnapshot, type McpSnapshotFlags } from '../../cli/commands/mcp-snapshot.js';
import type { McpDiffReport } from '../result.js';
import { recorder } from './fixtures/http-servers.js';
import { snapshotServer } from './fixtures/snapshot-server.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/snapshot-server.mjs', import.meta.url));

const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  vi.unstubAllEnvs();
});

const tmp = () => mkdtempSync(join(tmpdir(), 'plune-snapshot-'));

interface Run {
  code: number;
  out: string;
  err: string;
}

const io = (cwd: string, env: NodeJS.ProcessEnv, sink: { out: string; err: string }) => ({
  out: (s: string) => (sink.out += s),
  err: (s: string) => (sink.err += s),
  env,
  cwd,
});

/** `mode` (and `reverse`) start the stdio fixture; `server` replaces it, `flags.url` points at an HTTP one. */
async function snapshot(
  opts: {
    mode?: string;
    reverse?: boolean;
    flags?: McpSnapshotFlags;
    server?: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<Run> {
  const sink = { out: '', err: '' };
  const server =
    opts.server ??
    (opts.mode === undefined
      ? []
      : [process.execPath, FIXTURE, opts.mode, ...(opts.reverse === true ? ['reverse'] : [])]);
  const code = await handleMcpSnapshot(
    { timeout: '20s', ...opts.flags },
    server,
    io(opts.cwd ?? tmp(), opts.env ?? {}, sink),
  );
  return { code, ...sink };
}

async function diff(
  operands: { baseline: string; current?: string; server?: string[] },
  opts: { flags?: McpDiffFlags; cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<Run> {
  const sink = { out: '', err: '' };
  const code = await handleMcpDiff(
    { timeout: '20s', ...opts.flags },
    { server: [], ...operands },
    io(opts.cwd ?? tmp(), opts.env ?? {}, sink),
  );
  return { code, ...sink };
}

/** The fixture over Streamable HTTP, stateless: a fresh server per request, built with what the request carried. */
async function httpServer(mode: string): Promise<string> {
  const server: HttpServer = createServer((req, res) => {
    // Stateless: without a sessionIdGenerator the transport keeps no session.
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    void snapshotServer(mode, { echo: req.headers['authorization'] })
      .connect(transport)
      .then(() => transport.handleRequest(req, res));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push({
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
}

/**
 * A machine logged in to Plune whose platform records every request: a token in the environment, `PLUNE_API_URL` at
 * the recorder, a fresh HOME. Both are in `process.env` and in the env the command is given.
 */
async function loggedIn(): Promise<{ env: NodeJS.ProcessEnv; requests: unknown[] }> {
  const home = tmp();
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  const platform = await recorder();
  servers.push(platform);
  const env = { PLUNE_TOKEN: 'plune-test-token', PLUNE_API_URL: platform.origin };
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  return { env, requests: platform.requests };
}

/** A snapshot of the fixture written to `<dir>/<name>`; its text. */
async function written(dir: string, name: string, mode = 'full', reverse = false): Promise<string> {
  const run = await snapshot({ mode, reverse, cwd: dir, flags: { out: name } });
  expect(run.code, run.err).toBe(0);
  return readFileSync(join(dir, name), 'utf8');
}

const edit = (
  dir: string,
  from: string,
  to: string,
  change: (s: Record<string, unknown>) => void,
) => {
  const s = JSON.parse(readFileSync(join(dir, from), 'utf8')) as Record<string, unknown>;
  change(s);
  writeFileSync(join(dir, to), `${JSON.stringify(s, null, 2)}\n`);
};
type Tool = {
  name: string;
  annotations?: Record<string, unknown>;
  inputSchema: { properties: Record<string, Record<string, unknown>> };
};
const tools = (s: Record<string, unknown>) => s['tools'] as Tool[];

describe('CLI · mcp snapshot · the file', () => {
  it('CLI · mcp snapshot · the same server taken twice, its lists in another order, is the same file byte for byte (AC-1)', async () => {
    const dir = tmp();
    const a = await written(dir, 'a.json');
    const b = await written(dir, 'b.json', 'full', true);
    expect(b).toBe(a);
    const parsed = JSON.parse(a) as Record<string, unknown>;
    expect(tools(parsed).map((t) => t.name)).toEqual([
      'Zeta',
      'alpha',
      'note_delete',
      'weather_get',
    ]);
    expect((tools(parsed)[3]?.inputSchema as unknown as { required: string[] }).required).toEqual([
      'city',
      'units',
    ]);
    expect(Object.keys(parsed)).toContain('resourceTemplates');
    // Without --out the same text goes to stdout, and nothing else does.
    expect((await snapshot({ mode: 'full', reverse: true })).out).toBe(a);
  });

  it('CLI · mcp snapshot · every section: server, instructions, capabilities and the four lists', async () => {
    const s = JSON.parse(await written(tmp(), 's.json')) as Record<string, unknown>;
    expect(s).toMatchObject({
      kind: 'plune-mcp-snapshot',
      schemaVersion: 2,
      transport: 'stdio',
      server: { name: 'notes-full', version: '2.0.0', title: 'Notes' },
      instructions: 'Read a note before you delete it.',
      capabilities: { tools: { listChanged: true }, resources: { subscribe: true }, prompts: {} },
    });
    expect((s['resources'] as { uri: string }[]).map((r) => r.uri)).toEqual([
      'file:///notes/index.json',
      'file:///notes/readme.md',
    ]);
    expect((s['resourceTemplates'] as unknown[]).length).toBe(1);
    expect((s['prompts'] as { name: string }[]).map((p) => p.name)).toEqual(['звіт']);
  });

  it('CLI · mcp snapshot · no command, env value, URL, header, time or machine path in the file (AC-2)', async () => {
    const dir = tmp();
    const env = { NOTES_TOKEN: 'tok-env-value-0123456789' };
    const stdio = await snapshot({
      mode: 'full',
      cwd: dir,
      flags: { out: 'stdio.json', env: ['NOTES_TOKEN'] },
      env,
    });
    expect(stdio.code, stdio.err).toBe(0);
    const url = await httpServer('full');
    const http = await snapshot({
      cwd: dir,
      flags: { url, out: 'http.json', headerEnv: ['Authorization=NOTES_AUTH'] },
      env: { NOTES_AUTH: 'Bearer hdr-secret-0123456789' },
    });
    expect(http.code, http.err).toBe(0);
    const year = String(new Date().getUTCFullYear());
    for (const file of ['stdio.json', 'http.json']) {
      const bytes = readFileSync(join(dir, file));
      for (const leaked of [
        FIXTURE,
        'snapshot-server',
        process.execPath,
        'tok-env-value-0123456789',
        url,
        new URL(url).host,
        'hdr-secret-0123456789',
        homedir(),
        year,
      ]) {
        expect(bytes.includes(Buffer.from(leaked)), `${file} holds ${leaked}`).toBe(false);
      }
      expect(bytes.toString('utf8')).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    }
    expect(JSON.parse(readFileSync(join(dir, 'http.json'), 'utf8'))).toMatchObject({
      transport: 'http',
    });
  });

  it('CLI · mcp snapshot · a server that repeats the --header-env value in a description gives a file without it (AC-3)', async () => {
    const url = await httpServer('echo');
    const dir = tmp();
    const run = await snapshot({
      cwd: dir,
      flags: { url, out: 'echo.json', headerEnv: ['Authorization=NOTES_AUTH'] },
      env: { NOTES_AUTH: 'Bearer sk-echoed-0123456789' },
    });
    expect(run.code, run.err).toBe(0);
    const text = readFileSync(join(dir, 'echo.json'), 'utf8');
    expect(text).toContain('Sends Authorization: ');
    expect(text.split('sk-echoed-0123456789').length - 1).toBe(0);
  });

  it('CLI · mcp snapshot · a declared list the server does not give: exit 2, its name, and no file (AC-4)', async () => {
    const dir = tmp();
    const run = await snapshot({ mode: 'resources-fail', cwd: dir, flags: { out: 'r.json' } });
    expect(run.code).toBe(2);
    expect(run.err).toContain('resources/list');
    expect(run.err).toContain('the notes folder is not mounted');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('CLI · mcp snapshot · a server with no entity at all: exit 3, "Nothing measured", and no file (AC-5)', async () => {
    const dir = tmp();
    const run = await snapshot({ mode: 'empty', cwd: dir, flags: { out: 'e.json' } });
    expect(run.code).toBe(3);
    expect(run.err).toContain('Nothing measured');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('CLI · mcp snapshot · LF only, two-space indent, one LF at the end, on every OS (AC-6)', async () => {
    const bytes = readFileSync(
      join(
        await (async () => {
          const dir = tmp();
          await written(dir, 'lf.json');
          return dir;
        })(),
        'lf.json',
      ),
    );
    expect(bytes.includes(0x0d)).toBe(false);
    const text = bytes.toString('utf8');
    expect(text.startsWith('{\n  "capabilities"')).toBe(true);
    expect(text.endsWith('}\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
  });

  it('CLI · mcp snapshot · lists are read to their last page; a list that never ends is exit 2 and no file', async () => {
    const paged = JSON.parse(await written(tmp(), 'p.json', 'paged')) as Record<string, unknown>;
    expect(tools(paged)).toHaveLength(4);
    const dir = tmp();
    const run = await snapshot({ mode: 'endless', cwd: dir, flags: { out: 'x.json' } });
    expect(run.code).toBe(2);
    expect(run.err).toContain('tools/list did not end within 100 pages');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('CLI · mcp snapshot · --out replaces a file whole and leaves no temporary file; an unwritable --out is exit 2', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'snap.json'), 'old');
    const text = await written(dir, 'snap.json');
    expect(readdirSync(dir)).toEqual(['snap.json']);
    expect(text.startsWith('{')).toBe(true);
    const run = await snapshot({
      mode: 'full',
      cwd: dir,
      flags: { out: join('missing', 'snap.json') },
    });
    expect(run.code).toBe(2);
    expect(run.err).toContain('--out');
    expect(readdirSync(dir)).toEqual(['snap.json']);
  });

  it('CLI · mcp snapshot · a server that cannot start is exit 2', async () => {
    const run = await snapshot({ server: [join(tmp(), 'no-such-server')] });
    expect(run.code).toBe(2);
    expect(run.err).toMatch(/^plune mcp snapshot: /);
  });
});

describe('CLI · mcp diff · classes and exit codes', () => {
  it('CLI · mcp diff · a removed tool is breaking: exit 1 and "breaking" in the output (AC-7)', async () => {
    const dir = tmp();
    await written(dir, 'a.json');
    edit(
      dir,
      'a.json',
      'b.json',
      (s) => (s['tools'] = tools(s).filter((t) => t.name !== 'note_delete')),
    );
    const run = await diff({ baseline: 'a.json', current: 'b.json' }, { cwd: dir });
    expect(run.code).toBe(1);
    expect(run.out).toMatch(
      /^ {2}breaking +tool note_delete {2}tool {2}removed: The tool was removed/m,
    );
    expect((await diff({ baseline: 'a.json', current: 'a.json' }, { cwd: dir })).code).toBe(0);
  });

  it('CLI · mcp diff · the security signal is in the JSON and a badge in the human output (AC-9)', async () => {
    const dir = tmp();
    await written(dir, 'a.json');
    edit(dir, 'a.json', 'b.json', (s) => {
      const t = tools(s);
      t.find((x) => x.name === 'weather_get')!.annotations = {
        readOnlyHint: false,
        destructiveHint: false,
      };
      t.find((x) => x.name === 'alpha')!.annotations = {
        readOnlyHint: true,
        destructiveHint: true,
      };
    });
    const json = await diff(
      { baseline: 'a.json', current: 'b.json' },
      { cwd: dir, flags: { format: 'json' } },
    );
    const report = JSON.parse(json.out) as McpDiffReport;
    expect(report.changes.map((c) => [c.name, c.field, c.signal])).toEqual([
      ['alpha', 'annotations.destructiveHint', 'security'],
      ['weather_get', 'annotations.readOnlyHint', 'security'],
    ]);
    const human = await diff({ baseline: 'a.json', current: 'b.json' }, { cwd: dir });
    expect(human.out).toMatch(
      /tool weather_get {2}annotations\.readOnlyHint {2}modified \[security\]/,
    );
    expect(human.out).toMatch(
      /tool alpha {2}annotations\.destructiveHint {2}modified \[security\]/,
    );
  });

  it('CLI · mcp diff · --fail-on breaking fails on breaking only, any on any change including not classified, none never (AC-10)', async () => {
    const dir = tmp();
    await written(dir, 'a.json');
    // A keyword no rule knows: not classified.
    edit(
      dir,
      'a.json',
      'odd.json',
      (s) =>
        (tools(s).find((t) => t.name === 'weather_get')!.inputSchema.properties['city']!['format'] =
          'city'),
    );
    edit(dir, 'a.json', 'gone.json', (s) => (s['tools'] = tools(s).slice(1)));
    const code = async (current: string, failOn?: string) =>
      (
        await diff(
          { baseline: 'a.json', current },
          { cwd: dir, flags: failOn === undefined ? {} : { failOn } },
        )
      ).code;
    expect(await code('odd.json')).toBe(0);
    expect(await code('odd.json', 'breaking')).toBe(0);
    expect(await code('odd.json', 'any')).toBe(1);
    expect(await code('gone.json', 'breaking')).toBe(1);
    expect(await code('gone.json', 'none')).toBe(0);
    const odd = await diff({ baseline: 'a.json', current: 'odd.json' }, { cwd: dir });
    expect(odd.out).toContain('1 not classified');
    expect(odd.out).toContain('[not classified]: Could not classify: `format` changed');
    const bad = await diff(
      { baseline: 'a.json', current: 'a.json' },
      { cwd: dir, flags: { failOn: 'warn' } },
    );
    expect([bad.code, bad.err]).toEqual([
      2,
      'plune mcp diff: --fail-on must be one of breaking, any, none (got "warn").\n',
    ]);
  });

  it('CLI · mcp diff · an unknown schemaVersion names both versions; broken JSON and a missing file are exit 2 without a stack (AC-11)', async () => {
    const dir = tmp();
    await written(dir, 'a.json');
    edit(dir, 'a.json', 'future.json', (s) => (s['schemaVersion'] = 7));
    writeFileSync(join(dir, 'broken.json'), '{"kind": "plune-mcp-snapshot", "sch');
    const future = await diff({ baseline: 'future.json', current: 'a.json' }, { cwd: dir });
    expect(future.code).toBe(2);
    expect(future.err).toContain(
      'future.json: schemaVersion 7 is not supported: this plune reads schemaVersion 2',
    );
    for (const run of [
      await diff({ baseline: 'a.json', current: 'broken.json' }, { cwd: dir }),
      await diff({ baseline: 'none.json', current: 'a.json' }, { cwd: dir }),
    ]) {
      expect(run.code).toBe(2);
      expect(run.err).toMatch(/^plune mcp diff: (broken|none)\.json: /);
      expect(run.err).not.toMatch(/\n\s+at /);
      expect(run.out).toBe('');
    }
  });

  it('CLI · mcp diff · against a live server gives what snapshot then file against file gives (AC-12)', async () => {
    const dir = tmp();
    await written(dir, 'a.json');
    edit(dir, 'a.json', 'base.json', (s) => {
      s['tools'] = tools(s).filter((t) => t.name !== 'alpha');
      (s['server'] as Record<string, unknown>)['version'] = '1.9.0';
    });
    await written(dir, 'now.json', 'full', true);
    const flags = { format: 'json' };
    const files = await diff({ baseline: 'base.json', current: 'now.json' }, { cwd: dir, flags });
    const live = await diff(
      { baseline: 'base.json', server: [process.execPath, FIXTURE, 'full', 'reverse'] },
      { cwd: dir, flags },
    );
    expect(live.code, live.err).toBe(files.code);
    expect(live.out).toBe(files.out);
    const report = JSON.parse(live.out) as McpDiffReport;
    expect(report.summary).toMatchObject({
      breaking: 0,
      'non-breaking': 1,
      informational: 1,
      overall: 'non-breaking',
    });
  });

  it('CLI · mcp diff · --format markdown carries its own marker, never the eval diff one (AC-13)', async () => {
    const dir = tmp();
    await written(dir, 'a.json');
    edit(dir, 'a.json', 'b.json', (s) => (s['tools'] = tools(s).slice(1)));
    const md = await diff(
      { baseline: 'a.json', current: 'b.json' },
      { cwd: dir, flags: { format: 'markdown' } },
    );
    expect(MCP_DIFF_MARKER).toBe('<!-- plune-mcp-diff -->');
    expect(md.out.startsWith(`${MCP_DIFF_MARKER}\n`)).toBe(true);
    expect(md.out).not.toContain('<!-- plune-eval-diff -->');
    expect(md.out.split('<!--').length - 1).toBe(1);
    expect(md.out).toContain('| breaking | tool | Zeta | tool | removed |');
  });

  it('CLI · mcp diff · two snapshots with no entity at all: exit 3, nothing to compare', async () => {
    const dir = tmp();
    const empty = {
      kind: 'plune-mcp-snapshot',
      schemaVersion: 2,
      transport: 'stdio',
      server: null,
      instructions: null,
      capabilities: {},
      tools: null,
      resources: null,
      resourceTemplates: null,
      prompts: null,
    };
    writeFileSync(join(dir, 'e.json'), JSON.stringify(empty));
    const run = await diff({ baseline: 'e.json', current: 'e.json' }, { cwd: dir });
    expect(run.code).toBe(3);
    expect(run.out).toContain('Nothing to compare');
  });

  it('CLI · mcp diff · a current file and a server together, or neither, is exit 2', async () => {
    const dir = tmp();
    await written(dir, 'a.json');
    const both = await diff(
      { baseline: 'a.json', current: 'a.json', server: ['node', 'x.js'] },
      { cwd: dir },
    );
    expect([both.code, both.err]).toEqual([
      2,
      'plune mcp diff: Give either a current snapshot file or a server (--url, or a command after --), not both.\n',
    ]);
    const neither = await diff({ baseline: 'a.json' }, { cwd: dir });
    expect(neither.code).toBe(2);
    expect(neither.err).toContain('Name what to compare a.json with');
  });

  it('CLI · mcp diff · operands: what follows -- is the server, what comes before it the files', () => {
    const raw = (...args: string[]) => ['node', 'plune', 'mcp', 'diff', ...args];
    expect(diffOperands(['a.json', 'b.json'], raw('a.json', 'b.json'))).toEqual({
      baseline: 'a.json',
      current: 'b.json',
      server: [],
    });
    expect(
      diffOperands(
        ['a.json', 'node', 'dist/server.js'],
        raw('a.json', '--', 'node', 'dist/server.js'),
      ),
    ).toEqual({
      baseline: 'a.json',
      server: ['node', 'dist/server.js'],
    });
    expect(diffOperands(['a.json', 'srv'], raw('a.json', '--fail-on', 'any', '--', 'srv'))).toEqual(
      { baseline: 'a.json', server: ['srv'] },
    );
    expect(() =>
      diffOperands(['a.json', 'b.json', 'c.json'], raw('a.json', 'b.json', 'c.json')),
    ).toThrow(/at most two snapshot files/);
  });
});

describe('CLI · mcp snapshot · review round', () => {
  it('CLI · mcp snapshot · a schema deeper than the masking reads is exit 2 with the tool and the limit, no file', async () => {
    for (const mode of ['deepA', 'deepB']) {
      const dir = tmp();
      const run = await snapshot({ mode, cwd: dir, flags: { out: 'deep.json' } });
      expect(run.code, run.err).toBe(2);
      expect(run.err).toContain('tool "deep"');
      expect(run.err).toContain('64 levels');
      expect(readdirSync(dir)).toEqual([]);
    }
  });

  it('CLI · mcp snapshot · a short credential and the command line repeated by the server do not reach the file', async () => {
    const dir = tmp();
    const run = await snapshot({
      mode: 'argv',
      cwd: dir,
      flags: { out: 'argv.json', env: ['API_KEY=sk12345'] },
    });
    expect(run.code, run.err).toBe(0);
    const bytes = readFileSync(join(dir, 'argv.json'));
    for (const leaked of ['sk12345', FIXTURE, process.execPath]) {
      expect(bytes.includes(Buffer.from(leaked)), `holds ${leaked}`).toBe(false);
      expect(bytes.toString('utf8').toLowerCase()).not.toContain(leaked.toLowerCase());
    }
    // The short key is masked by the snapshot; the command line by the connection (***) or the snapshot ([redacted]).
    expect(bytes.toString('utf8')).toMatch(
      /key=\[redacted\] argv=(\*\*\*|\[redacted\]) (\*\*\*|\[redacted\]) argv"/,
    );
  });

  it('CLI · mcp snapshot · resources declared and no resources/templates/list (Method not found): templates null, exit 0', async () => {
    const dir = tmp();
    const run = await snapshot({ mode: 'no-templates', cwd: dir, flags: { out: 'n.json' } });
    expect(run.code, run.err).toBe(0);
    const s = JSON.parse(readFileSync(join(dir, 'n.json'), 'utf8')) as Record<string, unknown>;
    expect(s['resourceTemplates']).toBeNull();
    expect(s['resources']).toHaveLength(2);
  });

  it('CLI · mcp diff · a snapshot file nested 200 000 levels deep is exit 2 without a stack, even with --fail-on none', async () => {
    const dir = tmp();
    await written(dir, 'a.json');
    const text = readFileSync(join(dir, 'a.json'), 'utf8').replace(
      '"instructions": "Read a note before you delete it."',
      `"instructions": "x", "extra": ${'['.repeat(200_000)}1${']'.repeat(200_000)}`,
    );
    writeFileSync(join(dir, 'deep.json'), text);
    const run = await diff(
      { baseline: 'deep.json', current: 'a.json' },
      { cwd: dir, flags: { failOn: 'none' } },
    );
    expect(run.code).toBe(2);
    expect(run.err).toMatch(/^plune mcp diff: deep\.json: .*nested deeper than/);
    expect(run.err).not.toMatch(/\n\s+at /);
  });
});

describe('CLI · mcp snapshot, mcp diff · the platform', () => {
  it('CLI · mcp snapshot · logged in to Plune, it still never calls the platform: stdio and HTTP', async () => {
    const platform = await loggedIn();
    const dir = tmp();
    const stdio = await snapshot({
      mode: 'full',
      cwd: dir,
      flags: { out: 'a.json' },
      env: platform.env,
    });
    const http = await snapshot({
      cwd: dir,
      flags: { url: await httpServer('full') },
      env: platform.env,
    });
    expect([stdio.code, http.code]).toEqual([0, 0]);
    expect(platform.requests).toEqual([]);
  });

  it('CLI · mcp diff · logged in to Plune, it still never calls the platform: file against file and against a live server', async () => {
    const dir = tmp();
    await written(dir, 'a.json');
    edit(dir, 'a.json', 'b.json', (s) => (s['tools'] = tools(s).slice(1)));
    const platform = await loggedIn();
    const files = await diff(
      { baseline: 'a.json', current: 'b.json' },
      { cwd: dir, env: platform.env },
    );
    const live = await diff(
      { baseline: 'a.json', server: [process.execPath, FIXTURE, 'full'] },
      { cwd: dir, env: platform.env },
    );
    expect([files.code, live.code]).toEqual([1, 0]);
    expect(platform.requests).toEqual([]);
  });
});
