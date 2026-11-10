// The connection flags every `plune mcp` command shares: what they turn into, and which combinations are a usage
// error (exit 2, one sentence, no secret value in it).

import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import {
  addConnectionOptions,
  connectionConfig,
  UsageError,
  type ConnectionFlags,
} from '../connect/options.js';
import { MCP_EXIT } from '../exit-codes.js';

function parse(argv: string[]): { flags: ConnectionFlags; server: string[] } {
  let got: { flags: ConnectionFlags; server: string[] } | undefined;
  const cmd = addConnectionOptions(new Command('check').exitOverride()).action(
    (server: string[], flags: ConnectionFlags) => {
      got = { flags, server };
    },
  );
  cmd.parse(argv, { from: 'user' });
  return got!;
}

const config = (argv: string[], env: NodeJS.ProcessEnv = {}) => {
  const { flags, server } = parse(argv);
  return connectionConfig(flags, server, env);
};

function usageError(argv: string[], env: NodeJS.ProcessEnv = {}): UsageError {
  try {
    config(argv, env);
  } catch (err) {
    expect(err).toBeInstanceOf(UsageError);
    return err as UsageError;
  }
  throw new Error('expected a usage error');
}

describe('CLI · mcp connect · flags', () => {
  it('CLI · mcp connect · a command after -- is a stdio server, with its own flags untouched', () => {
    const c = config(['--env', 'A=1', '--cwd', 'srv', '--', 'node', 'server.js', '--port', '0']);
    expect(c.target).toMatchObject({
      kind: 'stdio',
      command: 'node',
      args: ['server.js', '--port', '0'],
      env: { A: '1' },
    });
    expect(c.target.kind === 'stdio' && c.target.cwd).toMatch(/srv$/);
    expect(c.timeoutMs).toBe(30_000);
  });

  it('CLI · mcp connect · --env KEY passes the variable on from this environment', () => {
    const c = config(['--env', 'PLUNE_TOKEN', '--', 'node', 's.js'], {
      PLUNE_TOKEN: 'from-shell-123',
    });
    expect(c.target).toMatchObject({ env: { PLUNE_TOKEN: 'from-shell-123' } });
  });

  it('CLI · mcp connect · --url with --header and --header-env, --sse picks the older transport', () => {
    const c = config(
      [
        '--url',
        'http://127.0.0.1:9/mcp',
        '--sse',
        '--header',
        'Authorization: Bearer abc:def',
        '--header-env',
        'X-Api-Key=MY_KEY',
        '--timeout',
        '2m',
        '--debug-out',
        'f.jsonl',
      ],
      { MY_KEY: 'key-from-env' },
    );
    expect(c.target).toEqual({
      kind: 'sse',
      url: 'http://127.0.0.1:9/mcp',
      headers: { Authorization: 'Bearer abc:def', 'X-Api-Key': 'key-from-env' },
    });
    expect(c.timeoutMs).toBe(120_000);
    expect(c.debugOut).toBe('f.jsonl');
  });

  it.each([
    ['--url and a command', ['--url', 'http://127.0.0.1:9/mcp', '--', 'node', 's.js'], /not both/],
    ['--sse without --url', ['--sse', '--', 'node', 's.js'], /--sse/],
    ['nothing at all', [], /--url/],
    [
      '--header without a colon',
      ['--url', 'http://127.0.0.1:9/mcp', '--header', 'Authorization Bearer x'],
      /Name: value/,
    ],
    [
      '--header-env naming an unset variable',
      ['--url', 'http://127.0.0.1:9/mcp', '--header-env', 'X-Api-Key=NOPE_UNSET'],
      /NOPE_UNSET/,
    ],
    [
      '--header-env naming an empty variable',
      ['--url', 'http://127.0.0.1:9/mcp', '--header-env', 'X-Api-Key=EMPTY'],
      /EMPTY/,
    ],
    [
      '--env KEY naming an unset variable',
      ['--env', 'NOPE_UNSET', '--', 'node', 's.js'],
      /NOPE_UNSET/,
    ],
    ['--url that is not http', ['--url', 'ftp://x/mcp'], /--url/],
    ['--header with a stdio server', ['--header', 'A: b', '--', 'node', 's.js'], /--url/],
    ['--env with --url', ['--url', 'http://127.0.0.1:9/mcp', '--env', 'A=1'], /after --/],
    ['a bad --timeout', ['--timeout', 'soon', '--', 'node', 's.js'], /--timeout/],
    [
      '--url with user:password@',
      ['--url', 'http://alice:pw@127.0.0.1:9/mcp'],
      /--header-env Authorization=/,
    ],
  ])('CLI · mcp connect · %s is a usage error: exit 2, one sentence', (_name, argv, text) => {
    const err = usageError(argv, { EMPTY: '' });
    expect(err.exitCode).toBe(MCP_EXIT.usage);
    expect(err.message).toMatch(text);
    expect(err.message.split('\n')).toHaveLength(1);
  });

  it('CLI · mcp connect · a usage error names the variable, never a value', () => {
    const err = usageError([
      '--url',
      'http://127.0.0.1:9/mcp',
      '--header',
      'Authorization: Bearer s3cret-value',
      '--header-env',
      'X=MISSING_VAR',
    ]);
    expect(err.message).toContain('MISSING_VAR');
    expect(err.message).not.toContain('s3cret-value');
    const userinfo = usageError(['--url', 'http://alice:hunter2-pass@127.0.0.1:9/mcp']);
    expect(userinfo.message).not.toMatch(/alice|hunter2-pass/);
  });
});

describe('CLI · mcp connect · exit codes', () => {
  it('CLI · mcp connect · the exit codes are 0, 1, 2 and 3', () => {
    expect(MCP_EXIT).toEqual({ ok: 0, violations: 1, usage: 2, unmeasured: 3 });
  });
});
