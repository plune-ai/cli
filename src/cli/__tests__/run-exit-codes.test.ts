// The exit code of `plune run` on every path, pinned where the command line meets the run: the handler is
// replaced, the rest of the action is real. README.md and docs/guide/cli.md hold the same table in words.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RowResult, RunResult } from '../../types/results.js';

const handleRunMock = vi.fn(async (..._args: unknown[]): Promise<RunResult> => resultOf([]));
vi.mock('../commands/run.js', () => ({
  handleRun: (...args: unknown[]) => handleRunMock(...args),
}));
// No test in this file may reach a real handler: one of them sends a run to a server. Each is a spy, and the
// cases that go past `run` also make the exit throw, as the real one ends the process.
const realHandlers = {
  handleRunImport: vi.fn(),
  handleReport: vi.fn(),
  diffFiles: vi.fn(),
  handleMcpCheck: vi.fn(),
};
vi.mock('../commands/run-import.js', () => ({ handleRunImport: (...a: unknown[]) => realHandlers.handleRunImport(...a) }));
vi.mock('../commands/report.js', () => ({
  handleReport: (...a: unknown[]) => realHandlers.handleReport(...a),
  ReportNotFoundError: class extends Error {},
}));
vi.mock('../commands/diff.js', () => ({
  diffFiles: (...a: unknown[]) => realHandlers.diffFiles(...a),
  DiffInputError: class extends Error {},
}));
vi.mock('../commands/mcp-check.js', () => ({ handleMcpCheck: (...a: unknown[]) => realHandlers.handleMcpCheck(...a) }));
vi.mock('../../reporters/index.js', () => ({ renderReport: () => 'RENDERED' }));
vi.mock('../env.js', () => ({ loadEnv: () => undefined }));

import { createProgram } from '../../cli.js';
import { ConfigNotFoundError, ConfigValidationError, YamlParseError } from '../../config/errors.js';
import { RunConfigError } from '../../orchestrator/index.js';
import { AuthError } from '../../providers/errors.js';

const passed: RowResult = { vars: {}, output: 'ok', cached: false, assertions: [{ type: 'contains', passed: true }] };
const failed: RowResult = { ...passed, assertions: [{ type: 'contains', passed: false }] };
const errored: RowResult = { ...passed, output: null, error: { code: 'X', message: 'boom' }, assertions: [] };
const blocked: RowResult = { ...passed, output: null, inconclusive: 'blocked', assertions: [] };
const skipped: RowResult = { ...passed, output: null, inconclusive: 'skipped', assertions: [] };
const missed: RowResult = { ...errored, error: { code: 'CACHE_MISS', message: 'no usable cache entry' } };

function resultOf(rows: RowResult[], extra: Partial<RunResult> = {}): RunResult {
  const count = (r: RowResult) => rows.filter((x) => x === r).length;
  return {
    schemaVersion: 1,
    plune_version: 'test',
    started_at: '2026-01-01T00:00:00.000Z',
    finished_at: '2026-01-01T00:00:00.000Z',
    config_hash: 'abc',
    summary: {
      total: rows.length,
      passed: count(passed),
      failed: count(failed),
      errored: count(errored) + count(missed),
      blocked: count(blocked),
      skipped: count(skipped),
      cost_usd: 0,
      duration_ms: 0,
    },
    evals: rows.length === 0 ? [] : [{ id: 'e1', tags: [], rows, passed: rows.every((r) => r === passed) }],
    ...extra,
  };
}

let stderr: string;
let exits: unknown[];
beforeEach(() => {
  handleRunMock.mockClear();
  for (const handler of Object.values(realHandlers)) handler.mockClear();
  process.exitCode = undefined;
  stderr = '';
  exits = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  // The process would end at the first `process.exit`; here the first call is the code and the rest is ignored.
  vi.spyOn(process, 'exit').mockImplementation(((code?: unknown) => {
    exits.push(code);
  }) as (code?: string | number | null | undefined) => never);
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

/** The code the process would end with: the first `process.exit`, else `process.exitCode`, else 0. */
async function codeOf(...flags: string[]): Promise<unknown> {
  await createProgram().parseAsync(['node', 'plune', 'run', ...flags]);
  return exits.length > 0 ? exits[0] : (process.exitCode ?? 0);
}

describe('CLI · run · exit code of a finished run', () => {
  it.each<[string, RowResult[], number]>([
    ['every row passed', [passed, passed], 0],
    ['a row failed', [passed, failed], 1],
    ['rows failed and rows errored: the failure wins', [failed, errored, passed], 1],
    ['rows errored and none failed', [passed, errored], 2],
    ['every row errored', [errored], 2],
    ['the rows not passed are only blocked or skipped', [passed, blocked, skipped], 0],
    ['no row was judged at all', [blocked, skipped], 0],
    ['a blocked row beside a failed one', [blocked, failed], 1],
    ['a blocked row beside an errored one', [blocked, errored], 2],
  ])('%s → %i', async (_name, rows, code) => {
    handleRunMock.mockResolvedValueOnce(resultOf(rows));
    expect(await codeOf()).toBe(code);
    expect(exits).toEqual([]);
  });

  it('a dry run → 0', async () => {
    handleRunMock.mockResolvedValueOnce(resultOf([skipped, skipped], { dry_run: true }));
    expect(await codeOf('--dry-run')).toBe(0);
  });

  it('--only that matches no eval → 0, with a line on stderr', async () => {
    expect(await codeOf('--only', 'nothing')).toBe(0);
    expect(stderr).toContain('No evals matched the selector.');
  });

  it('a run with no evals → 0', async () => {
    expect(await codeOf()).toBe(0);
  });

  it.each<[string, RowResult[], number]>([
    ['the eval it stopped on failed', [failed], 1],
    ['the eval it stopped on only errored', [errored], 2],
    ['nothing failed', [passed], 0],
  ])('--bail does not change the code: %s → %i', async (_name, rows, code) => {
    handleRunMock.mockResolvedValueOnce(resultOf(rows));
    expect(await codeOf('--bail')).toBe(code);
    expect((handleRunMock.mock.calls[0]![0] as { bail: boolean }).bail).toBe(true);
  });

  it.each<[string, RowResult[]]>([
    ['and nothing else', [passed, missed]],
    ['beside a failed row (it would be 1)', [failed, missed]],
    ['beside an errored row (it would be 2)', [errored, missed]],
  ])('--cache-strict with a row that has no cache entry → 5: %s', async (_name, rows) => {
    handleRunMock.mockResolvedValueOnce(resultOf(rows));
    expect(await codeOf('--cache-strict')).toBe(5);
  });

  it('--cache-strict with every row in the cache → the code of the rows', async () => {
    handleRunMock.mockResolvedValueOnce(resultOf([passed, failed]));
    expect(await codeOf('--cache-strict')).toBe(1);
  });

  it.each(['console', 'json', 'markdown', 'junit'])('--format %s does not change the code', async (format) => {
    handleRunMock.mockResolvedValueOnce(resultOf([passed, errored]));
    expect(await codeOf('--format', format)).toBe(2);
  });
});

describe('CLI · run · exit code when the run did not start', () => {
  it.each<[string, string[]]>([
    ['--no-cache with --cache-strict', ['--no-cache', '--cache-strict']],
    ['--no-cache with --cache-max-age', ['--no-cache', '--cache-max-age', '1h']],
    ['--cache-max-age that is not a duration', ['--cache-max-age', 'soon']],
  ])('flags that do not go together: %s → 2, and nothing runs', async (_name, flags) => {
    expect(await codeOf(...flags)).toBe(2);
    expect(handleRunMock).not.toHaveBeenCalled();
    expect(stderr).not.toBe('');
  });

  it.each<[string, Error]>([
    ['a config that does not validate', new ConfigValidationError('Invalid config', ['evals: required'])],
    ['no config file', new ConfigNotFoundError('plune.yaml not found')],
    ['YAML that does not parse', new YamlParseError('bad indentation')],
    ['a missing provider key', new AuthError('PROVIDER_API_KEY is not set', 'PROVIDER_API_KEY')],
    ['--runs out of range, an unknown prompt variable, a bad --tool-description', new RunConfigError('--runs must be a whole number from 1 to 100')],
  ])('%s → 2, with the message on stderr', async (_name, err) => {
    handleRunMock.mockRejectedValueOnce(err);
    expect(await codeOf()).toBe(2);
    expect(stderr).toContain(err.message);
  });

  it('a file or folder that cannot be read or written → 2', async () => {
    const err = Object.assign(new Error("ENOENT: no such file or directory, open 'out/report.md'"), {
      code: 'ENOENT',
      syscall: 'open',
      path: 'out/report.md',
    });
    handleRunMock.mockRejectedValueOnce(err);
    expect(await codeOf()).toBe(2);
    expect(stderr).toContain('This is a file or folder on this machine');
  });

  // 1 is also the code of a failed row: a crash of the CLI itself reads as a failure to a script.
  it('an error nobody classified → 1', async () => {
    handleRunMock.mockRejectedValueOnce(new Error('something else'));
    expect(await codeOf()).toBe(1);
    expect(stderr).toContain('This one is on us.');
  });

  // `run` has an action of its own, so the parser does not refuse a word after it that is no subcommand.
  // The action does: a mistyped subcommand must not run the suite and call models.
  it.each<[string, string[], string]>([
    ['a mistyped subcommand and its file', ['improt', 'report.xml'], 'improt report.xml'],
    ['one word', ['evals'], 'evals'],
    ['a word after the options', ['--dry-run', 'evals'], 'evals'],
    ['a word after --', ['--', 'evals'], 'evals'],
  ])('an argument run does not take: %s → 2, and nothing runs', async (_name, flags, named) => {
    expect(await codeOf(...flags)).toBe(2);
    expect(stderr).toContain(`\`plune run\` takes no arguments, but got: ${named}\n`);
    expect(stderr).toContain('start, finish, exec, delete, grep, report, import');
    expect(handleRunMock).not.toHaveBeenCalled();
  });

  // The option parser's own errors are usage errors: 2 with the parser's message, on every command.
  it.each<[string, string[]]>([
    ['an option the command does not have', ['--no-such-flag']],
    ['an option with its value missing', ['--format']],
  ])('%s → 2, with the option parser’s message', async (_name, flags) => {
    expect(await codeOf(...flags)).toBe(2);
    expect(stderr).toMatch(/^error: /);
  });
});

describe('CLI · every command · exit code of the option parser', () => {
  // The exit throws here, as the real one ends the process: with an exit that returns, the command's action
  // would run after the parser's error, on the real handler.
  const codeOfArgv = async (...argv: string[]): Promise<unknown> => {
    vi.mocked(process.exit).mockImplementation((code) => {
      throw new Error(`exit ${String(code)}`);
    });
    const outcome = await createProgram()
      .parseAsync(['node', 'plune', ...argv])
      .then(() => 'no exit', (err: Error) => err.message);
    for (const handler of [handleRunMock, ...Object.values(realHandlers)]) expect(handler).not.toHaveBeenCalled();
    return outcome;
  };

  it.each<[string, string[], RegExp]>([
    ['report · an unknown option', ['report', '--no-such-flag'], /^error: unknown option '--no-such-flag'/],
    ['diff · a missing argument', ['diff', 'baseline.json'], /^error: missing required argument 'current'/],
    ['run import · an unknown option', ['run', 'import', 'report.xml', '--no-such-flag'], /^error: unknown option/],
    ['run import · an option value that is not a number', ['run', 'import', 'report.xml', '--timeout', 'abc'], /^error: option '--timeout <seconds>' argument 'abc' is invalid/],
    ['run import · an option value out of range', ['run', 'import', 'report.xml', '--upload-concurrency', '99'], /^error: option '--upload-concurrency <n>' argument '99' is invalid/],
    ['mcp check · an unknown option', ['mcp', 'check', '--no-such-flag'], /^error: unknown option/],
    ['mcp · a subcommand the group does not have', ['mcp', 'bogus'], /^error: unknown command 'bogus'/],
    ['plan · a subcommand the group does not have', ['plan', 'bogus'], /^error: unknown command 'bogus'/],
    ['mcp · a command group without a subcommand prints its help', ['mcp'], /^Usage: plune mcp/],
    ['no command at all prints the help', [], /^Usage: plune/],
  ])('%s → 2', async (_name, argv, message) => {
    expect(await codeOfArgv(...argv)).toBe('exit 2');
    expect(stderr).toMatch(message);
  });

  it.each<[string, string[]]>([
    ['--help', ['--help']],
    ['run --help', ['run', '--help']],
    ['--version', ['--version']],
  ])('%s → 0', async (_name, argv) => {
    expect(await codeOfArgv(...argv)).toBe('exit 0');
  });
});

describe('CLI · run · its subcommands are not taken for an argument', () => {
  const run = () => createProgram().commands.find((c) => c.name() === 'run')!;

  it('run has these subcommands and no argument of its own', () => {
    expect(run().commands.map((c) => c.name())).toEqual(['start', 'finish', 'exec', 'delete', 'grep', 'report', 'import']);
    expect(run().registeredArguments).toEqual([]);
  });

  it.each(['start', 'finish', 'exec', 'delete', 'grep', 'report', 'import'])(
    'run %s reaches the subcommand, not the suite',
    async (sub) => {
      // The help ends the process: here the exit throws, so that nothing after it runs.
      let stdout = '';
      vi.mocked(process.stdout.write).mockImplementation((chunk) => {
        stdout += String(chunk);
        return true;
      });
      vi.mocked(process.exit).mockImplementation((code) => {
        throw new Error(`exit ${String(code)}`);
      });
      await expect(createProgram().parseAsync(['node', 'plune', 'run', sub, '--help'])).rejects.toThrow('exit 0');
      expect(stdout).toContain(`Usage: plune run ${sub}`);
      expect(stderr).toBe('');
      expect(handleRunMock).not.toHaveBeenCalled();
    },
  );
});
