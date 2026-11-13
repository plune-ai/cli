import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { handleMcpSnapshot, type McpSnapshotFlags } from '../commands/mcp-snapshot.js';
import { checkPushFlags, snapshotBody } from '../commands/mcp-snapshot-push.js';

/**
 * `plune mcp snapshot --push` against a real stdio server (the snapshot fixture) and a fake platform that holds
 * the platform's MCP catalog contract: strict bodies, 201 for a new contract, 200 for the same one.
 */
// Each test starts a real server process, some twice.
vi.setConfig({ testTimeout: 40_000 });

const FIXTURE = fileURLToPath(
  new URL('../../mcp-testing/__tests__/fixtures/snapshot-server.mjs', import.meta.url),
);
const TOKEN = 'plune-test-token-0123456789';

const KEYS = {
  snapshot: [
    'kind',
    'schemaVersion',
    'transport',
    'environment',
    'server',
    'instructions',
    'capabilities',
    'tools',
    'resources',
    'resourceTemplates',
    'prompts',
  ],
  server: ['name', 'version', 'title'],
  tool: [
    'name',
    'title',
    'description',
    'inputSchema',
    'outputSchema',
    'annotations',
    'execution',
    'x-plune',
  ],
  resource: ['uri', 'name', 'title', 'description', 'mimeType'],
  template: ['uriTemplate', 'name', 'title', 'description', 'mimeType'],
  prompt: ['name', 'title', 'description', 'arguments'],
  argument: ['name', 'title', 'description', 'required'],
};
const unknownKey = (o: unknown, allowed: string[], where: string): string | undefined => {
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return `${where} is not an object`;
  const extra = Object.keys(o).find((k) => !allowed.includes(k));
  return extra === undefined ? undefined : `${where}: unrecognized key '${extra}'`;
};
/** The strict schema of the platform, as far as keys go: the first field it would refuse, or undefined. */
function refusedField(body: Record<string, unknown>): string | undefined {
  const list = (v: unknown, allowed: string[], where: string): string | undefined => {
    for (const [i, e] of (Array.isArray(v) ? v : []).entries()) {
      const bad = unknownKey(e, allowed, `${where}[${i}]`);
      if (bad !== undefined) return bad;
      for (const [j, a] of (Array.isArray((e as { arguments?: unknown }).arguments)
        ? (e as { arguments: unknown[] }).arguments
        : []
      ).entries()) {
        const badArg = unknownKey(a, KEYS.argument, `${where}[${i}].arguments[${j}]`);
        if (badArg !== undefined) return badArg;
      }
    }
    return undefined;
  };
  return (
    unknownKey(body, KEYS.snapshot, 'body') ??
    (body['server'] === null || body['server'] === undefined
      ? undefined
      : unknownKey(body['server'], KEYS.server, 'server')) ??
    list(body['tools'], KEYS.tool, 'tools') ??
    list(body['resources'], KEYS.resource, 'resources') ??
    list(body['resourceTemplates'], KEYS.template, 'resourceTemplates') ??
    list(body['prompts'], KEYS.prompt, 'prompts')
  );
}

interface Seen {
  method: string;
  path: string;
  authorization: string | null;
  body: Record<string, unknown> | undefined;
}

/** An in-memory platform: servers by name, snapshots by hash of the contract (the environment is not in it). */
function platform(over: { fail?: (req: Seen) => Response | undefined } = {}) {
  const servers: { id: string; name: string; transport: string }[] = [];
  const snapshots = new Map<string, { number: number; hash: string }[]>();
  const seen: Seen[] = [];
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body =
      typeof init.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    const req: Seen = {
      method: init.method ?? 'GET',
      path,
      authorization: (init.headers as Record<string, string>)['authorization'] ?? null,
      body,
    };
    seen.push(req);
    const failed = over.fail?.(req);
    if (failed !== undefined) return failed;
    if (req.method === 'GET' && path === '/v1/mcp-servers') return json({ servers });
    if (req.method === 'POST' && path === '/v1/mcp-servers') {
      const extra = Object.keys(body ?? {}).find(
        (k) => !['name', 'transport', 'description'].includes(k),
      );
      if (extra !== undefined)
        return json({ error: `validation failed — unrecognized key '${extra}'` }, 400);
      if (servers.some((s) => s.name === body?.['name']))
        return json(
          { error: 'the project has an MCP server of this name', code: 'server_exists' },
          409,
        );
      const made = {
        id: `srv-${servers.length + 1}`,
        name: String(body?.['name']),
        transport: String(body?.['transport']),
      };
      servers.push(made);
      snapshots.set(made.id, []);
      return json(made, 201);
    }
    const m = /^\/v1\/mcp-servers\/([^/]+)\/snapshots$/.exec(path);
    if (req.method === 'POST' && m !== null) {
      const list = snapshots.get(decodeURIComponent(m[1] ?? ''));
      if (list === undefined) return json({ error: `MCP server '${m[1]}' not found` }, 404);
      const bad = refusedField(body ?? {});
      if (bad !== undefined) return json({ error: `validation failed — ${bad}` }, 400);
      const {
        environment: _environment,
        kind: _kind,
        schemaVersion: _version,
        transport: _transport,
        ...contract
      } = body ?? {};
      const hash = createHash('sha256').update(JSON.stringify(contract)).digest('hex');
      const latest = list[list.length - 1];
      if (latest?.hash === hash)
        return json({ id: 'snap', number: latest.number, hash, tools: 3 }, 200);
      const taken = { number: list.length + 1, hash };
      list.push(taken);
      return json({ id: `snap-${taken.number}`, number: taken.number, hash, tools: 3 }, 201);
    }
    return json({ error: 'not found' }, 404);
  }) as unknown as typeof fetch;
  return { fetchImpl, seen, servers, snapshots };
}

interface Run {
  code: number;
  out: string;
  err: string;
  cwd: string;
}
async function push(
  flags: McpSnapshotFlags,
  fake: ReturnType<typeof platform>,
  opts: { token?: string | null; server?: string[]; cwd?: string } = {},
): Promise<Run> {
  const sink = { out: '', err: '' };
  const cwd = opts.cwd ?? mkdtempSync(join(tmpdir(), 'plune-push-'));
  const code = await handleMcpSnapshot(
    { timeout: '20s', ...flags },
    opts.server ?? [process.execPath, FIXTURE, 'full'],
    {
      out: (s) => (sink.out += s),
      err: (s) => (sink.err += s),
      env: {},
      cwd,
      push: {
        apiUrl: 'https://api.test',
        loadToken: () => (opts.token === undefined ? TOKEN : opts.token),
        fetchImpl: fake.fetchImpl,
        wait: async () => undefined,
      },
    },
  );
  return { code, ...sink, cwd };
}

describe('CLI · mcp snapshot · push · what is sent and said', () => {
  it('adds the server on the first push, sends the snapshot, and prints its number (AC-1)', async () => {
    const fake = platform();
    const r = await push({ push: true, serverName: 'Notes MCP', environment: 'ci' }, fake);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/Added server "Notes MCP"/);
    expect(r.out).toMatch(/Pushed snapshot 1 of server "Notes MCP": a new contract/);
    expect(fake.servers).toEqual([{ id: 'srv-1', name: 'Notes MCP', transport: 'stdio' }]);
    expect(fake.snapshots.get('srv-1')).toHaveLength(1);
    const sent = fake.seen.find((s) => s.path.endsWith('/snapshots'));
    expect(sent?.body?.['environment']).toBe('ci');
    expect(sent?.body?.['kind']).toBe('plune-mcp-snapshot');
    // The snapshot goes to the platform; stdout holds the answer, not the JSON.
    expect(r.out).not.toContain('"tools"');
  });

  it('says plainly when the platform already holds this contract, and records nothing new (AC-2)', async () => {
    const fake = platform();
    await push({ push: true, serverName: 'Notes MCP' }, fake);
    const again = await push({ push: true, serverName: 'Notes MCP', environment: 'staging' }, fake);
    expect(again.code, again.err).toBe(0);
    expect(again.out).toMatch(
      /Snapshot 1 of server "Notes MCP" already holds this contract \([0-9a-f]{12}\); nothing new was recorded/,
    );
    expect(again.out).not.toMatch(/Added server/);
    expect(fake.servers).toHaveLength(1);
    expect(fake.snapshots.get('srv-1')).toHaveLength(1);
  });

  it('pushes to a server by id', async () => {
    const fake = platform();
    await push({ push: true, serverName: 'Notes MCP' }, fake);
    const r = await push({ push: true, server: 'srv-1' }, fake);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/snapshot 1 of server srv-1/i);
    expect(
      fake.seen.filter((s) => s.method === 'POST' && s.path === '/v1/mcp-servers'),
    ).toHaveLength(1);
  });

  it('also writes the snapshot where --out says, and still pushes', async () => {
    const fake = platform();
    const r = await push({ push: true, serverName: 'Notes MCP', out: 'snap.json' }, fake);
    expect(r.code, r.err).toBe(0);
    expect(readFileSync(join(r.cwd, 'snap.json'), 'utf8')).toContain('"plune-mcp-snapshot"');
    expect(fake.snapshots.get('srv-1')).toHaveLength(1);
  });

  it('sends only what the strict schema accepts: no command, environment variable, header or address (AC-5)', async () => {
    const fake = platform();
    const secret = 'supersecret-env-value-98765';
    const r = await push(
      { push: true, serverName: 'Notes MCP', env: [`NOTES_API_KEY=${secret}`] },
      fake,
    );
    expect(r.code, r.err).toBe(0);
    const sent = fake.seen
      .filter((s) => s.method === 'POST')
      .map((s) => JSON.stringify(s.body))
      .join('\n');
    expect(sent).not.toContain(secret);
    expect(sent).not.toContain(FIXTURE.replace(/\\/g, '\\\\'));
    expect(sent).not.toContain(TOKEN);
    expect(r.out + r.err).not.toContain(TOKEN);
    expect(r.out + r.err).not.toContain(secret);
    // The token travels in one header and nowhere else.
    expect(fake.seen.every((s) => s.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  it('builds the body from a list of fields: a field the snapshot should never carry does not go up', () => {
    const body = snapshotBody(
      {
        kind: 'plune-mcp-snapshot',
        schemaVersion: 2,
        transport: 'stdio',
        server: { name: 's', version: '1', command: 'node secret.js' } as never,
        instructions: null,
        capabilities: null,
        tools: [{ name: 't', headers: { authorization: 'x' } } as never],
        resources: null,
        resourceTemplates: null,
        prompts: null,
        env: { A: 'b' },
      } as never,
      'ci',
    );
    expect(refusedField(body)).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/secret\.js|authorization|"env"/);
    expect(body['environment']).toBe('ci');
    expect(
      Object.keys(
        snapshotBody({
          kind: 'plune-mcp-snapshot',
          schemaVersion: 2,
          transport: 'http',
          server: null,
          instructions: null,
          capabilities: null,
          tools: null,
          resources: null,
          resourceTemplates: null,
          prompts: null,
        }),
      ),
    ).not.toContain('environment');
  });
});

describe('CLI · mcp snapshot · push · nothing goes up unasked, and every failure is plain', () => {
  it('sends nothing without --push (the snapshot goes to stdout as before)', async () => {
    const fake = platform();
    const r = await push({}, fake);
    expect(r.code, r.err).toBe(0);
    expect(fake.seen).toEqual([]);
    expect(r.out).toContain('"plune-mcp-snapshot"');
  });

  it.each([
    [{ push: true }, /exactly one of --server <id> and --server-name <name>/],
    [{ push: true, server: 'a', serverName: 'b' }, /exactly one/],
    [{ server: 'a' }, /--server only means something with --push/],
    [{ environment: 'ci' }, /--environment only means something with --push/],
    [{ push: true, serverName: 'x'.repeat(101) }, /1 to 100 characters/],
  ] as [McpSnapshotFlags, RegExp][])(
    'refuses flags %j before connecting or sending',
    async (flags, said) => {
      const fake = platform();
      const r = await push(flags, fake, { server: ['node', '--no-such-flag-xyz'] });
      expect(r.code).toBe(2);
      expect(r.err).toMatch(said);
      expect(fake.seen).toEqual([]);
      expect(checkPushFlags(flags)).toMatch(said);
    },
  );

  it('without a token says so and exits 2, before it connects to the server (AC-5)', async () => {
    const fake = platform();
    const r = await push({ push: true, serverName: 'Notes MCP' }, fake, {
      token: null,
      server: ['node', '--no-such-flag-xyz'],
    });
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/Not logged in.*Nothing was sent/);
    expect(fake.seen).toEqual([]);
  });

  it('a rejected token is exit 2 with the plain line', async () => {
    const fake = platform({ fail: () => new Response('{}', { status: 401 }) });
    const r = await push({ push: true, serverName: 'Notes MCP' }, fake);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/token was rejected \(401\)/);
  });

  it("a refused body is exit 2 with the platform's reason, and a token the platform echoed is not printed", async () => {
    const fake = platform({
      fail: (req) =>
        req.path.endsWith('/snapshots')
          ? new Response(JSON.stringify({ error: `validation failed — nope ${TOKEN}` }), {
              status: 400,
            })
          : undefined,
    });
    const r = await push({ push: true, serverName: 'Notes MCP' }, fake);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/refused the snapshot \(400\): validation failed — nope \*\*\*/);
    expect(r.out + r.err).not.toContain(TOKEN);
  });

  it('an unknown --server id is exit 2, not an outage', async () => {
    const fake = platform();
    const r = await push({ push: true, server: 'srv-404' }, fake);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/srv-404/);
  });

  it('an agent or read-only token (403) is exit 2 and names what to change', async () => {
    const fake = platform({
      fail: (req) =>
        req.method === 'POST'
          ? new Response(
              JSON.stringify({
                error: 'an agent does not write the MCP catalog yet',
                code: 'agent_proposes',
              }),
              { status: 403 },
            )
          : undefined,
    });
    const r = await push({ push: true, server: 'srv-1' }, fake);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/needs a token that may write/);
  });

  it('with the platform unreachable keeps the snapshot in a file and exits 1 (AC-6)', async () => {
    const fake = platform({
      fail: () => {
        throw new Error(`connect ECONNREFUSED with ${TOKEN}`);
      },
    });
    const r = await push({ push: true, serverName: 'Notes MCP' }, fake);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/Could not reach the Plune API/);
    expect(r.err).toMatch(/The snapshot is kept in mcp-snapshot\.unsent\.json/);
    expect(readFileSync(join(r.cwd, 'mcp-snapshot.unsent.json'), 'utf8')).toContain(
      '"plune-mcp-snapshot"',
    );
    expect(r.out + r.err).not.toContain(TOKEN);
  });

  it('with the platform down and --out given, keeps that file and writes no other', async () => {
    const fake = platform({ fail: () => new Response('{}', { status: 503 }) });
    const r = await push({ push: true, serverName: 'Notes MCP', out: 'mine.json' }, fake);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/answered 503/);
    expect(readdirSync(r.cwd).sort()).toEqual(['mine.json']);
    expect(existsSync(join(r.cwd, 'mcp-snapshot.unsent.json'))).toBe(false);
  });
});
