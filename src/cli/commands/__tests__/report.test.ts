import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleReport, ReportNotFoundError } from '../report.js';
import { createProgram } from '../../../cli.js';
import { mixed } from '../../../reporters/__tests__/fixtures.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-report-'));
  // Workers forbid process.chdir(); mock cwd() so the report command reads our temp dir.
  vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeLastRun(): void {
  fs.mkdirSync(path.join(tmpDir, '.plune'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.plune', 'last-run.json'), JSON.stringify(mixed));
}

describe('handleReport', () => {
  it('reads the saved RunResult (AC-5)', () => {
    writeLastRun();
    expect(handleReport({ cwd: tmpDir }).summary.total).toBe(3);
  });

  it('throws ReportNotFoundError when there is no saved run (AC-6)', () => {
    expect(() => handleReport({ cwd: tmpDir })).toThrow(ReportNotFoundError);
  });

  it('throws on a valid-JSON-but-malformed saved run (review fix)', () => {
    fs.mkdirSync(path.join(tmpDir, '.plune'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.plune', 'last-run.json'), '{}');
    expect(() => handleReport({ cwd: tmpDir })).toThrow(ReportNotFoundError);
  });

  it('throws on invalid JSON in the saved run', () => {
    fs.mkdirSync(path.join(tmpDir, '.plune'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.plune', 'last-run.json'), 'not valid json');
    expect(() => handleReport({ cwd: tmpDir })).toThrow(ReportNotFoundError);
  });
});

describe('plune report command', () => {
  it('renders the last run to stdout (AC-5)', async () => {
    writeLastRun();
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array): boolean => {
      writes.push(typeof c === 'string' ? c : Buffer.from(c).toString());
      return true;
    });
    await createProgram().parseAsync(['node', 'plune', 'report']);
    expect(writes.join('')).toContain('e-fail');
  });

  it('exits 2 when there is no saved run (AC-6)', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {}) as (code?: string | number | null | undefined) => never);
    await createProgram().parseAsync(['node', 'plune', 'report']);
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it('honors a global -c by reading .plune from the config directory (AC-T01.3)', async () => {
    // The saved run lives next to a config in a subdir; cwd (mocked to tmpDir) has none.
    const sub = path.join(tmpDir, 'proj');
    fs.mkdirSync(path.join(sub, '.plune'), { recursive: true });
    fs.writeFileSync(path.join(sub, '.plune', 'last-run.json'), JSON.stringify(mixed));
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array): boolean => {
      writes.push(typeof c === 'string' ? c : Buffer.from(c).toString());
      return true;
    });
    await createProgram().parseAsync([
      'node',
      'plune',
      '-c',
      path.join(sub, 'plune.yaml'),
      'report',
    ]);
    expect(writes.join('')).toContain('e-fail');
  });

  it('-o writes the report to a file instead of stdout (AC-7)', async () => {
    writeLastRun();
    const outFile = path.join(tmpDir, 'report.json');
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array): boolean => {
      writes.push(typeof c === 'string' ? c : Buffer.from(c).toString());
      return true;
    });
    await createProgram().parseAsync(['node', 'plune', 'report', '--format', 'json', '-o', outFile]);
    expect(fs.existsSync(outFile)).toBe(true);
    expect((JSON.parse(fs.readFileSync(outFile, 'utf8')) as { summary: { total: number } }).summary.total).toBe(3);
    expect(writes.join('')).not.toContain('"summary"');
  });
});
