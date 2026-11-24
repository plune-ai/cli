// `--format` of `plune run` and `plune report`: which renderer a value reaches, and what the help says.

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

vi.mock('../commands/run.js', () => ({ handleRun: async () => OK_RESULT }));
vi.mock('../commands/report.js', () => ({
  handleReport: () => OK_RESULT,
  ReportNotFoundError: class extends Error {},
}));
const renderReportMock = vi.fn((..._args: unknown[]) => 'RENDERED');
vi.mock('../../reporters/index.js', () => ({
  renderReport: (...args: unknown[]) => renderReportMock(...args),
}));
vi.mock('../env.js', () => ({ loadEnv: () => undefined }));

import { createProgram } from '../../cli.js';

let stderr: string;
beforeEach(() => {
  renderReportMock.mockClear();
  stderr = '';
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

  // An unknown value is not refused: the report is printed as console, with no message and exit 0.
  it('an unknown value is rendered as console, as before', async () => {
    expect(await formatOf(command, '--format', 'bogus')).toBe('console');
    expect(stderr).toBe('');
    expect(process.exitCode ?? 0).toBe(0);
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
});
