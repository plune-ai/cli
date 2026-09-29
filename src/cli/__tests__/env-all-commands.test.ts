// plune-ai/cli#46 — one rule for every command: a `.env` in the current directory (and beside the
// config named with -c) is read before the command looks at process.env, and what is already
// exported wins over the file. Until now only `run` and `report` did it; `run import`, `run start`,
// `sync`, `ingest`, `login` never saw `PLUNE_TOKEN` or `PLUNE_API_URL` from a file, and the demo
// project worked around it in every script with `NODE_OPTIONS=--require=dotenv/config`.
//
// Through the real parser, with the real loader: the rule lives in the program's preAction hook,
// which a handler called directly never passes through (the blind spot that hid `run import
// --format`). Only what a command DOES is stubbed — each handler just writes down what it could see
// in process.env at the moment it was called.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RunResult } from '../../types/results.js';

const VAR = 'PLUNE_TEST_ENV_46';
const OTHER = 'PLUNE_TEST_ENV_46_OTHER';

const OK_RESULT: RunResult = {
  schemaVersion: 1,
  plune_version: 'test',
  started_at: '2026-01-01T00:00:00.000Z',
  finished_at: '2026-01-01T00:00:00.000Z',
  config_hash: 'abc',
  summary: { total: 0, passed: 0, failed: 0, errored: 0, cost_usd: 0, duration_ms: 0 },
  evals: [],
};

// What each handler saw when it was called: [VAR, OTHER] read from process.env at that moment.
const { seen, saw } = vi.hoisted(() => {
  const seen: Array<[string | undefined, string | undefined]> = [];
  const saw = (): void => {
    seen.push([process.env['PLUNE_TEST_ENV_46'], process.env['PLUNE_TEST_ENV_46_OTHER']]);
  };
  return { seen, saw };
});

vi.mock('../commands/run.js', () => ({
  handleRun: async () => {
    saw();
    return OK_RESULT;
  },
}));
vi.mock('../commands/report.js', () => ({
  ReportNotFoundError: class extends Error {},
  handleReport: () => {
    saw();
    return OK_RESULT;
  },
}));
vi.mock('../commands/run-import.js', () => ({
  handleRunImport: async () => {
    saw();
    return {};
  },
}));
vi.mock('../commands/run-lifecycle.js', () => ({
  NoTokenError: class extends Error {},
  RunCommandError: class extends Error {},
  handleRunStart: async () => saw(),
  handleRunFinish: async () => saw(),
}));
vi.mock('../commands/ingest.js', () => ({
  handleIngest: async () => {
    saw();
    return {};
  },
  formatIngestResult: () => '',
  reportIngestFailure: () => null,
}));
vi.mock('../commands/sync.js', () => ({
  handleSync: async () => {
    saw();
    return { id: 'run-1', url: 'https://example.test/runs/run-1' };
  },
  reportSyncFailure: () => null,
}));
vi.mock('../commands/login.js', () => ({
  handleLogin: async () => {
    saw();
    return { path: '/nowhere/credentials.json', verified: true };
  },
  reportLoginFailure: () => null,
}));

import { createProgram } from '../../cli.js';

/** Every command the rule has to reach, the way a person types it. */
const COMMANDS: Array<[string, string[]]> = [
  ['run', ['run']],
  ['report', ['report']],
  ['run import', ['run', 'import', 'report.json']],
  ['run start', ['run', 'start']],
  ['run finish', ['run', 'finish', 'run-1']],
  ['ingest', ['ingest']],
  ['sync', ['sync']],
  ['login', ['login', '--token', 'tok']],
];

let root: string;
/** Stand-in for the current directory; `process.chdir` does not exist in a test worker. */
let cwd: string;

function envFile(dir: string, lines: string[]): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.env'), lines.join('\n') + '\n');
}

async function plune(...args: string[]): Promise<void> {
  await createProgram().parseAsync(['node', 'plune', ...args]);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-env-cmds-'));
  cwd = path.join(root, 'here');
  fs.mkdirSync(cwd);
  seen.length = 0;
  delete process.env[VAR];
  delete process.env[OTHER];
  vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env[VAR];
  delete process.env[OTHER];
  vi.restoreAllMocks();
});

describe('.env in the current directory reaches every command (#46)', () => {
  it.each(COMMANDS)('plune %s sees a variable that only the file has', async (_name, args) => {
    envFile(cwd, [`${VAR}=from-file`]);

    await plune(...args);

    expect(seen).toEqual([['from-file', undefined]]);
  });

  it.each(COMMANDS)('plune %s lets what is exported win over the file', async (_name, args) => {
    envFile(cwd, [`${VAR}=from-file`]);
    process.env[VAR] = 'from-shell';

    await plune(...args);

    expect(seen).toEqual([['from-shell', undefined]]);
  });

  it.each(COMMANDS)('plune %s runs the same with no .env at all', async (_name, args) => {
    await plune(...args);

    expect(seen).toEqual([[undefined, undefined]]);
  });
});

describe('.env beside the config named with -c (#46)', () => {
  it.each(COMMANDS)(
    'plune -c … %s reads both files, and the config file wins where they meet',
    async (_name, args) => {
      const configDir = path.join(root, 'evals');
      envFile(configDir, [`${VAR}=from-config-dir`]);
      envFile(cwd, [`${VAR}=from-cwd`, `${OTHER}=only-in-cwd`]);

      await plune('-c', path.join(configDir, 'plune.yaml'), ...args);

      // The file next to the config is the more specific one; the current directory fills the rest.
      expect(seen).toEqual([['from-config-dir', 'only-in-cwd']]);
    },
  );
});
