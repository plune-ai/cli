// `--format` of `plune run` and `plune report`: which renderer a value reaches, and what the help says.

import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunResult } from '../../types/results.js';

const OK_RESULT: RunResult = {
  schemaVersion: 1,
  plune_version: 'test',
  started_at: '2026-01-01T00:00:00.000Z',
  finished_at: '2026-01-01T00:00:00.000Z',
  config_hash: 'abc',
  summary: { total: 0, passed: 0, failed: 0, errored: 0, cost_usd: 0, duration_ms: 0 },
  evals: [],
};

const handleRunMock = vi.fn(async () => OK_RESULT);
const handleReportMock = vi.fn(() => OK_RESULT);
const diffFilesMock = vi.fn();
vi.mock('../commands/run.js', () => ({ handleRun: () => handleRunMock() }));
vi.mock('../commands/diff.js', () => ({
  diffFiles: () => diffFilesMock(),
  DiffInputError: class extends Error {},
}));
vi.mock('../commands/report.js', () => ({
  handleReport: () => handleReportMock(),
  ReportNotFoundError: class extends Error {},
}));
const renderReportMock = vi.fn((..._args: unknown[]) => 'RENDERED');
vi.mock('../../reporters/index.js', () => ({
  renderReport: (...args: unknown[]) => renderReportMock(...args),
}));
vi.mock('../env.js', () => ({ loadEnv: () => undefined }));

import { createProgram } from '../../cli.js';

let stderr: string;
let exits: unknown[];
beforeEach(() => {
  vi.clearAllMocks();
  stderr = '';
  exits = [];
  vi.spyOn(process, 'exit').mockImplementation(((code?: unknown) => {
    exits.push(code);
  }) as (code?: string | number | null | undefined) => never);
  process.exitCode = undefined;
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

const formatOf = async (...argv: string[]): Promise<unknown> => {
  await createProgram().parseAsync(['node', 'plune', ...argv]);
  return renderReportMock.mock.calls[0]![1];
};

describe.each(['run', 'report'])('CLI · %s · --format', (command) => {
  it.each(['console', 'json', 'markdown', 'junit'])('%s reaches its renderer', async (format) => {
    expect(await formatOf(command, '--format', format)).toBe(format);
  });

  it('is console when the flag is not given', async () => {
    expect(await formatOf(command)).toBe('console');
  });

  // An unknown value was rendered as console with exit 0, even into `-o file`.
  it.each(['bogus', 'JSON', 'xml', ''])('an unknown value "%s" → 2 with the accepted formats, and nothing is run or written', async (value) => {
    const out = join(tmpdir(), `plune-run-format-${process.pid}.txt`);
    await createProgram().parseAsync(['node', 'plune', command, '--format', value, '-o', out]);
    expect(exits).toEqual([2]);
    expect(stderr).toBe(`Unknown --format "${value}". Use console | json | markdown | junit.\n`);
    expect(handleRunMock).not.toHaveBeenCalled();
    expect(handleReportMock).not.toHaveBeenCalled();
    expect(renderReportMock).not.toHaveBeenCalled();
    expect(existsSync(out)).toBe(false);
  });

  it('the help lists junit among the formats', () => {
    const help = createProgram().commands.find((c) => c.name() === command)!.helpInformation();
    expect(help).toContain('console | json | markdown | junit');
  });
});

describe('CLI · diff · --format', () => {
  it('does not offer junit: a diff has no JUnit form', () => {
    const help = createProgram().commands.find((c) => c.name() === 'diff')!.helpInformation();
    expect(help).toContain('console | json | markdown');
    expect(help).not.toContain('junit');
  });

  it.each(['junit', 'bogus'])('a value it does not write, "%s" → 2 with its own formats, and nothing is compared', async (value) => {
    await createProgram().parseAsync(['node', 'plune', 'diff', 'a.json', 'b.json', '--format', value]);
    expect(exits).toEqual([2]);
    expect(stderr).toBe(`Unknown --format "${value}". Use console | json | markdown.\n`);
    expect(diffFilesMock).not.toHaveBeenCalled();
  });
});
