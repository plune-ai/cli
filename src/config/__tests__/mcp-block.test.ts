// The `mcp` block of plune.yaml: which MCP server an agentic eval talks to, which of its tools the model may use, and
// the limits that end the loop. Only the description and its checks live here; nothing connects to a server.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pluneConfigSchema } from '../schema.js';
import { loadConfig } from '../loader.js';
import { ConfigValidationError } from '../errors.js';
import {
  MCP_LIMIT_DEFAULTS,
  expandVars,
  mcpLimits,
  mcpSecretWarnings,
  mcpVariableIssues,
  resolveMcpServer,
} from '../mcp.js';
import type { Config } from '../../types/config.js';
import { ConnectError, closeAllSessions, openSession } from '../../mcp-testing/connect/session.js';
import { streamableServer } from '../../mcp-testing/__tests__/fixtures/http-servers.js';

const evalWith = (extra: Record<string, unknown> = {}) => ({
  id: 'agent-eval',
  prompt: 'Find the issue',
  dataset: { examples: [{ vars: {} }] },
  assertions: [],
  ...extra,
});

const base = (extra: Record<string, unknown> = {}, evalExtra: Record<string, unknown> = {}) => ({
  version: 1,
  provider: { type: 'anthropic', model: 'claude-3-opus' },
  evals: [evalWith(evalExtra)],
  ...extra,
});

const stdioServers = { servers: { everything: { command: 'node', args: ['server.js'] } } };

/** The issues of a config the schema refuses, as loadConfig prints them. */
function issues(input: unknown): string[] {
  const result = pluneConfigSchema.safeParse(input);
  expect(result.success).toBe(false);
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
}

const parsed = (input: unknown): Config => {
  const result = pluneConfigSchema.safeParse(input);
  expect(result.success, result.success ? '' : JSON.stringify(result.error.issues)).toBe(true);
  return result.data as unknown as Config;
};

describe('CLI · config · mcp block · schema', () => {
  it('CLI · config · mcp block · a stdio server and an HTTP server are both accepted', () => {
    parsed(
      base(
        {
          mcp: {
            servers: {
              local: { command: 'npx', args: ['-y', 'some-server'], env: { DEBUG: '1' }, cwd: '.' },
              remote: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${T}' } },
            },
            limits: { max_steps: 5 },
          },
        },
        { mcp: { server: 'local', allowed_tools: ['search'], limits: { max_tool_calls: 3 } } },
      ),
    );
  });

  it('CLI · config · mcp block · a server with both command and url is refused, naming the server (AC-2)', () => {
    const out = issues(
      base({ mcp: { servers: { both: { command: 'node', url: 'http://127.0.0.1:3000/mcp' } } } }),
    );
    expect(out.join('\n')).toMatch(/mcp\.servers\.both: .*"both".*not both/);
  });

  it('CLI · config · mcp block · a server with neither command nor url is refused, naming the server (AC-2)', () => {
    const out = issues(base({ mcp: { servers: { empty: { args: ['x'] } } } }));
    expect(out.join('\n')).toMatch(/mcp\.servers\.empty: .*"empty".*command.*url/);
  });

  it('CLI · config · mcp block · headers on a stdio server and env on an HTTP server are refused', () => {
    expect(
      issues(base({ mcp: { servers: { s: { command: 'node', headers: { A: 'b' } } } } })).join(
        '\n',
      ),
    ).toMatch(/mcp\.servers\.s: .*headers/);
    expect(
      issues(base({ mcp: { servers: { h: { url: 'http://x/mcp', env: { A: 'b' } } } } })).join(
        '\n',
      ),
    ).toMatch(/mcp\.servers\.h: .*env/);
  });

  it('CLI · config · mcp block · a misspelt field is refused, not dropped', () => {
    expect(issues(base({ mcp: { servers: { s: { comand: 'node' } } } })).join('\n')).toMatch(
      /comand/,
    );
    expect(
      issues(
        base({ mcp: stdioServers }, { mcp: { server: 'everything', allowed_tool: ['a'] } }),
      ).join('\n'),
    ).toMatch(/allowed_tool/);
  });

  it('CLI · config · mcp block · an eval naming a server mcp.servers does not define is refused, naming the eval and the server (AC-3)', () => {
    const out = issues(base({ mcp: stdioServers }, { mcp: { server: 'evrything' } })).join('\n');
    expect(out).toMatch(/evals\.0\.mcp\.server: .*"agent-eval".*"evrything"/);
  });

  it('CLI · config · mcp block · an eval naming a server with no root mcp block is refused (AC-3)', () => {
    const out = issues(base({}, { mcp: { server: 'everything' } })).join('\n');
    expect(out).toMatch(/evals\.0\.mcp\.server: .*"agent-eval".*"everything"/);
  });

  it('CLI · config · mcp block · an empty allowed_tools is refused; a missing one means every tool (AC-4)', () => {
    expect(
      issues(
        base({ mcp: stdioServers }, { mcp: { server: 'everything', allowed_tools: [] } }),
      ).join('\n'),
    ).toMatch(/evals\.0\.mcp\.allowed_tools: .*at least one/);
    const config = parsed(base({ mcp: stdioServers }, { mcp: { server: 'everything' } }));
    expect(config.evals[0]!.mcp!.allowed_tools).toBeUndefined();
  });

  it('CLI · config · mcp block · every limit has a finite default, and an eval without limits gets them (AC-5)', () => {
    const config = parsed(base({ mcp: stdioServers }, { mcp: { server: 'everything' } }));
    const limits = mcpLimits(config, config.evals[0]!);
    expect(Object.keys(limits).sort()).toEqual(
      ['max_steps', 'max_tool_calls', 'max_total_tokens', 'timeout_ms', 'tool_timeout_ms'].sort(),
    );
    for (const value of Object.values(limits)) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
    expect(limits).toEqual(MCP_LIMIT_DEFAULTS);
  });

  it('CLI · config · mcp block · eval limits win over root limits, root limits over the defaults (AC-5)', () => {
    const config = parsed(
      base(
        { mcp: { ...stdioServers, limits: { max_steps: 4, max_tool_calls: 8 } } },
        { mcp: { server: 'everything', limits: { max_steps: 2 } } },
      ),
    );
    expect(mcpLimits(config, config.evals[0]!)).toEqual({
      ...MCP_LIMIT_DEFAULTS,
      max_steps: 2,
      max_tool_calls: 8,
    });
  });

  it.each(['max_steps', 'max_tool_calls', 'max_total_tokens', 'timeout_ms', 'tool_timeout_ms'])(
    'CLI · config · mcp block · %s of 0, below 0, a fraction or infinity is refused (AC-5)',
    (name) => {
      for (const value of [0, -1, 1.5, Infinity]) {
        expect(
          issues(base({ mcp: { ...stdioServers, limits: { [name]: value } } })).join('\n'),
        ).toMatch(new RegExp(`mcp\\.limits\\.${name}`));
        expect(
          issues(
            base(
              { mcp: stdioServers },
              { mcp: { server: 'everything', limits: { [name]: value } } },
            ),
          ).join('\n'),
        ).toMatch(new RegExp(`evals\\.0\\.mcp\\.limits\\.${name}`));
      }
    },
  );

  it('CLI · config · mcp block · an unknown key at the root is refused, so a CLI that predates a block stops instead of ignoring it (AC-10)', () => {
    // The root object is strict: that is what makes a CLI older than the `mcp` block stop on it. This pins it for
    // the next root block.
    const out = issues(base({ agents: { servers: {} } })).join('\n');
    expect(out).toMatch(/agents/);
  });

  it('CLI · config · mcp block · prompt and prompt_file stay mutually exclusive on an eval with mcp', () => {
    expect(
      issues(
        base({ mcp: stdioServers }, { prompt_file: 'p.txt', mcp: { server: 'everything' } }),
      ).join('\n'),
    ).toMatch(/mutually exclusive/);
  });
});

describe('CLI · config · mcp block · ${VAR}', () => {
  it('CLI · config · mcp block · ${VAR} and ${VAR:-default} are filled, and nothing else is', () => {
    const env = { HOST: 'example.com', EMPTY: '' };
    expect(expandVars('https://${HOST}/mcp', env)).toBe('https://example.com/mcp');
    expect(expandVars('${PORT:-3000}', env)).toBe('3000');
    expect(expandVars('${EMPTY:-fallback}', env)).toBe('fallback');
    expect(expandVars('${HOST:-other}', env)).toBe('example.com');
    // No shell: $VAR, $(cmd) and backticks stay as they are.
    expect(expandVars('$HOST $(whoami) `id` ~', env)).toBe('$HOST $(whoami) `id` ~');
  });

  it('CLI · config · mcp block · an unset or empty ${VAR} without a default names the variable', () => {
    expect(() => expandVars('Bearer ${MISSING_TOKEN}', {})).toThrow(/MISSING_TOKEN/);
    expect(() => expandVars('${EMPTY}', { EMPTY: '' })).toThrow(/EMPTY/);
  });

  it('CLI · config · mcp block · a ${ that is not a reference is refused, without the value', () => {
    expect(() => expandVars('Bearer ${sk-live-abcdef', {})).toThrow(/\$\{/);
    expect(() => expandVars('Bearer ${sk-live-abcdef', {})).not.toThrow(/sk-live/);
  });

  it('CLI · config · mcp block · a server resolves to the connection target the connection core takes', () => {
    const env = { TOKEN: 'abc', BIN: 'node' };
    expect(
      resolveMcpServer(
        { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${TOKEN}' } },
        env,
      ),
    ).toEqual({
      kind: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer abc' },
    });
    expect(
      resolveMcpServer(
        { command: '${BIN}', args: ['${DIR:-srv}/main.js'], env: { KEY: '${TOKEN}' }, cwd: 'srv' },
        env,
        '/base',
      ),
    ).toEqual({
      kind: 'stdio',
      command: 'node',
      args: ['srv/main.js'],
      env: { KEY: 'abc' },
      cwd: path.resolve('/base', 'srv'),
    });
  });

  it('CLI · config · mcp block · a server with only command or only url resolves with empty args, env and headers and no cwd', () => {
    expect(resolveMcpServer({ command: 'node' }, {})).toEqual({
      kind: 'stdio',
      command: 'node',
      args: [],
      env: {},
    });
    expect(resolveMcpServer({ url: 'http://127.0.0.1:3000/mcp' }, {})).toEqual({
      kind: 'http',
      url: 'http://127.0.0.1:3000/mcp',
      headers: {},
    });
  });

  it('CLI · config · mcp block · an unset ${VAR} in command, args or cwd is an issue on that field', () => {
    const config = parsed(
      base({
        mcp: {
          servers: {
            local: { command: '${MISSING_BIN}', args: ['${MISSING_ARG}'], cwd: '${MISSING_DIR}' },
          },
        },
      }),
    );
    const out = mcpVariableIssues(config, {});
    expect(out).toHaveLength(3);
    expect(out[0]).toMatch(/^mcp\.servers\.local\.command: .*MISSING_BIN/);
    expect(out[1]).toMatch(/^mcp\.servers\.local\.args\.0: .*MISSING_ARG/);
    expect(out[2]).toMatch(/^mcp\.servers\.local\.cwd: .*MISSING_DIR/);
  });

  it('CLI · config · mcp block · every unset variable is one issue with its field and name, and never a value that is set (AC-6)', () => {
    const secret = 'sk-live-0123456789abcdef';
    const env = { PRESENT_TOKEN: secret };
    // The value is really there: an issue list without it would prove nothing otherwise.
    expect(env.PRESENT_TOKEN).toBe(secret);
    const config = parsed(
      base({
        mcp: {
          servers: {
            remote: {
              url: 'https://${MISSING_HOST}/mcp',
              // The set value comes first in the same value, so an error that shows what was filled so far leaks it.
              headers: {
                Authorization: 'Bearer ${PRESENT_TOKEN}',
                'X-Other': '${PRESENT_TOKEN}:${MISSING_OTHER}',
              },
            },
          },
        },
      }),
    );
    const out = mcpVariableIssues(config, env);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatch(/^mcp\.servers\.remote\.url: .*MISSING_HOST/);
    expect(out[1]).toMatch(/^mcp\.servers\.remote\.headers\.X-Other: .*MISSING_OTHER/);
    expect(out.join('\n')).not.toContain(secret);
  });

  it('CLI · config · mcp block · a substituted header secret does not leak when the connection fails', async () => {
    const secret = 'wrong-token-from-the-environment';
    const env = { MCP_TEST_TOKEN: secret };
    expect(env.MCP_TEST_TOKEN).toBe(secret);
    const f = await streamableServer({ token: 'the-right-token' });
    try {
      const target = resolveMcpServer(
        { url: `${f.origin}/mcp`, headers: { Authorization: 'Bearer ${MCP_TEST_TOKEN}' } },
        env,
      );
      const err = await openSession({ target, timeoutMs: 5_000 }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ConnectError);
      const connectError = err as ConnectError;
      expect(connectError.kind).toBe('auth');
      // The server repeats what it was sent; that is what the mask has to catch.
      expect(f.requests.some((r) => r.headers['authorization'] === `Bearer ${secret}`)).toBe(true);
      expect(`${connectError.message}${connectError.stderrTail.join('')}`).not.toContain(secret);
    } finally {
      await closeAllSessions();
      await f.close();
    }
  });
});

describe('CLI · config · mcp block · secret written into the file', () => {
  it('CLI · config · mcp block · a literal value under a secret-looking key is a warning that names the key, not the value (AC-8)', () => {
    const config = parsed(
      base({
        mcp: {
          servers: {
            remote: {
              url: 'https://example.com/mcp',
              headers: { Authorization: 'Bearer sk-literal-123', 'X-Request-Source': 'ci' },
            },
            local: {
              command: 'node',
              env: {
                GITHUB_TOKEN: 'ghp_literal',
                api_key: '${API_KEY}',
                Password: 'hunter2',
                MODE: 'dev',
              },
            },
          },
        },
      }),
    );
    const out = mcpSecretWarnings(config);
    expect(out).toHaveLength(3);
    expect(out.join('\n')).toContain('mcp.servers.remote.headers.Authorization');
    expect(out.join('\n')).toContain('mcp.servers.local.env.GITHUB_TOKEN');
    expect(out.join('\n')).toContain('mcp.servers.local.env.Password');
    for (const literal of ['sk-literal-123', 'ghp_literal', 'hunter2'])
      expect(out.join('\n')).not.toContain(literal);
  });

  it('CLI · config · mcp block · a config without mcp has no warnings and no variable issues (AC-1)', () => {
    const config = parsed(base());
    expect(mcpSecretWarnings(config)).toEqual([]);
    expect(mcpVariableIssues(config, {})).toEqual([]);
  });
});

describe('CLI · config · mcp block · loadConfig', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-mcp-block-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const write = (yaml: string): string => {
    const file = path.join(dir, 'plune.yaml');
    fs.writeFileSync(file, yaml);
    return file;
  };

  const yaml = `version: 1
provider: { type: anthropic, model: claude-3-opus }
mcp:
  servers:
    remote:
      url: https://example.com/mcp
      headers:
        Authorization: "Bearer \${LOADER_TOKEN}"
evals:
  - id: agent-eval
    prompt: hi
    dataset: { examples: [{ vars: {} }] }
    assertions: []
    mcp: { server: remote }
`;

  it('CLI · config · mcp block · an unset ${VAR} is a ConfigValidationError that names it (AC-6)', async () => {
    const err = await loadConfig({ configPath: write(yaml), env: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigValidationError);
    expect((err as ConfigValidationError).issues.join('\n')).toMatch(
      /mcp\.servers\.remote\.headers\.Authorization: .*LOADER_TOKEN/,
    );
  });

  it('CLI · config · mcp block · the loaded config keeps ${VAR} as written, so the value stays out of it (AC-7)', async () => {
    const secret = 'loader-secret-value-1234';
    const config = await loadConfig({ configPath: write(yaml), env: { LOADER_TOKEN: secret } });
    expect(config.mcp!.servers['remote']!.headers!['Authorization']).toBe('Bearer ${LOADER_TOKEN}');
    expect(JSON.stringify(config)).not.toContain(secret);
  });
});
