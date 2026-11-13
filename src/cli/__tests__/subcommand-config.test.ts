// A subcommand's own `--config` is not the program's global `-c/--config`. `mcp conformance --config` (the oauth
// suite's file) and `mcp scan --config` (a client configuration, repeatable) share the name with the global option,
// and commander hands a `--config` written after a subcommand to the global one. Through the real parser, with the
// real `.env` loader: the handlers only write down what they were given and what they could see in process.env.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configFlagValues } from '../config-flag.js';

const VAR = 'PLUNE_TEST_SUBCONFIG_ENV';

const { given, saw } = vi.hoisted(() => {
  const given: { command: string; config: unknown; env: string | undefined }[] = [];
  const saw = (command: string, flags: { config?: unknown }): void => {
    given.push({ command, config: flags.config, env: process.env['PLUNE_TEST_SUBCONFIG_ENV'] });
  };
  return { given, saw };
});

vi.mock('../commands/mcp-conformance.js', () => ({
  handleMcpConformance: async (flags: { config?: unknown }) => {
    saw('conformance', flags);
    return 0;
  },
}));
vi.mock('../commands/mcp-scan.js', () => ({
  handleMcpScan: async (flags: { config?: unknown }) => {
    saw('scan', flags);
    return 0;
  },
}));
vi.mock('../commands/run.js', () => ({
  handleRun: async () => {
    saw('run', {});
    return {
      schemaVersion: 1,
      plune_version: 'test',
      started_at: '2026-01-01T00:00:00.000Z',
      finished_at: '2026-01-01T00:00:00.000Z',
      config_hash: 'abc',
      summary: { total: 0, passed: 0, failed: 0, errored: 0, cost_usd: 0, duration_ms: 0 },
      evals: [],
    };
  },
}));

import { createProgram } from '../../cli.js';

let root: string;
const plune = (...args: string[]) => createProgram().parseAsync(['node', 'plune', ...args]);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-subconfig-'));
  fs.mkdirSync(path.join(root, 'cwd'));
  fs.mkdirSync(path.join(root, 'conf'));
  fs.writeFileSync(path.join(root, 'conf', '.env'), `${VAR}=from-the-config-dir\n`);
  given.length = 0;
  delete process.env[VAR];
  vi.spyOn(process, 'cwd').mockReturnValue(path.join(root, 'cwd'));
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env[VAR];
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

const conf = (name: string) => path.join(root, 'conf', name);

describe('CLI · a subcommand --config is its own', () => {
  it('mcp conformance gets the file it was given', async () => {
    await plune(
      'mcp',
      'conformance',
      '--url',
      'http://127.0.0.1:1/mcp',
      '--config',
      conf('oauth.yaml'),
    );
    expect(given).toEqual([{ command: 'conformance', config: conf('oauth.yaml'), env: undefined }]);
  });

  it('mcp scan gets every --config it was given, in order, not only the last', async () => {
    await plune(
      'mcp',
      'scan',
      '--config',
      conf('a.json'),
      '--config',
      conf('b.json'),
      '--config=' + conf('c.json'),
    );
    expect(given.map((g) => g.config)).toEqual([[conf('a.json'), conf('b.json'), conf('c.json')]]);
  });

  it('the .env beside a subcommand --config is not loaded', async () => {
    await plune(
      'mcp',
      'conformance',
      '--url',
      'http://127.0.0.1:1/mcp',
      '--config',
      conf('oauth.yaml'),
    );
    await plune('mcp', 'scan', '--config', conf('client.json'));
    expect(given.map((g) => g.env)).toEqual([undefined, undefined]);
  });

  it('the global -c before the subcommand still names the plune.yaml: its .env is loaded, and the subcommand keeps its own file', async () => {
    await plune(
      '-c',
      conf('plune.yaml'),
      'mcp',
      'conformance',
      '--url',
      'http://127.0.0.1:1/mcp',
      '--config',
      path.join(root, 'cwd', 'oauth.yaml'),
    );
    expect(given).toEqual([
      {
        command: 'conformance',
        config: path.join(root, 'cwd', 'oauth.yaml'),
        env: 'from-the-config-dir',
      },
    ]);
  });

  it('plune run --config still names the plune.yaml: its .env is loaded', async () => {
    await plune('run', '--config', conf('plune.yaml'));
    expect(given).toEqual([{ command: 'run', config: undefined, env: 'from-the-config-dir' }]);
  });

  it('what follows -- (the server command) is not read as a --config of the command', () => {
    expect(
      configFlagValues(
        ['mcp', 'scan', '--config', 'a', '--', 'node', 's.js', '--config', 'b'],
        ['mcp', 'scan'],
      ),
    ).toEqual({
      before: [],
      after: ['a'],
    });
    expect(
      configFlagValues(
        ['-c', 'p.yaml', 'mcp', 'conformance', '--config=o.yaml'],
        ['mcp', 'conformance'],
      ),
    ).toEqual({
      before: ['p.yaml'],
      after: ['o.yaml'],
    });
  });
});
