import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleRunImport } from '../run-import.js';
import { JsonReportError, UnknownFormatError, readReportFile } from '../../../importers/index.js';

/**
 * A k6 summary and a Lighthouse report go the way every other report goes: the same run, the same
 * batches. What these pin is that each arrives as results with the statuses the thresholds gave, and
 * that a file with nothing to judge reaches no platform at all.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string => path.join(here, '../../../importers/__tests__/fixtures/perf', name);

interface Sent {
  path: string;
  body: Record<string, unknown>;
}

function platform() {
  const seen: Sent[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url).replace('https://api.test', '');
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    seen.push({ path: target, body });
    if (target === '/v1/runs') return json(201, { run: { id: 'r-1' }, joined: false });
    if (target === '/v1/test-cases/resolve') {
      const keys = (body['keys'] ?? []) as { value: string }[];
      return json(200, { results: keys.map((key) => ({ key, testCaseId: `tc-${key.value}` })) });
    }
    if (target.endsWith('/results')) {
      const results = (body['results'] ?? []) as { resultKey: string }[];
      return json(200, {
        items: results.map((r, index) => ({ index, resultKey: r.resultKey, status: 'accepted', id: `res-${index}` })),
        counts: { accepted: results.length, duplicate: 0, conflict: 0, rejected: 0 },
      });
    }
    return json(200, { run: { id: 'r-1' }, changed: true });
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const JUNIT = '<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="s" tests="1"><testcase name="t" classname="c"/></testsuite>\n';

const lines: string[] = [];
const deps = (fetchImpl: typeof fetch) => ({
  apiUrl: 'https://api.test',
  token: 'tok',
  fetchImpl,
  write: (l: string) => void lines.push(l),
});
const sentResults = (seen: Sent[]) =>
  seen.filter((s) => s.path.endsWith('/results')).flatMap((s) => s.body['results'] as { rawStatus: string; errorContext?: string }[]);

beforeEach(() => {
  lines.length = 0;
  for (const marker of ['GITHUB_ACTIONS', 'GITLAB_CI', 'JENKINS_URL']) vi.stubEnv(marker, '');
});
afterEach(() => vi.unstubAllEnvs());

describe('plune run import of performance reports', () => {
  it('sends a k6 summary as one result per threshold, crossed ones failed', async () => {
    const { seen, fetchImpl } = platform();
    const out = await handleRunImport({ ...deps(fetchImpl), file: fixture('k6-summary-export.json') });
    expect(out).toMatchObject({ format: 'k6', parsed: 3, accepted: 3 });
    expect(sentResults(seen).map((r) => r.rawStatus)).toEqual(['passed', 'failed', 'passed']);
    expect(seen.find((s) => s.path === '/v1/runs')!.body).toMatchObject({ meta: { runner: 'k6' } });
    expect(lines).toContain('Read 3 result(s) from a k6 report: 3 accepted, 0 already there, 0 unmatched, 0 not delivered.');
  });

  it('sends a Lighthouse report judged by --min-score', async () => {
    const { seen, fetchImpl } = platform();
    const out = await handleRunImport({
      ...deps(fetchImpl),
      file: fixture('lighthouse-report.json'),
      minScores: { accessibility: 80, performance: 98 },
    });
    expect(out).toMatchObject({ format: 'lighthouse', parsed: 4, accepted: 4 });
    expect(sentResults(seen).map((r) => r.rawStatus)).toEqual(['failed', 'passed', 'passed', 'passed']);
  });

  it('opens no run when --min-score names a category the Lighthouse report does not have', async () => {
    const { seen, fetchImpl } = platform();
    await expect(
      handleRunImport({ ...deps(fetchImpl), file: fixture('lighthouse-report.json'), minScores: { perf: 95 } }),
    ).rejects.toThrow(/--min-score perf=95 names a category the report does not have; it has performance, accessibility, best-practices, seo\./);
    expect(seen).toEqual([]);
  });

  it('opens no run when --min-score is given for a k6 summary', async () => {
    const { seen, fetchImpl } = platform();
    await expect(
      handleRunImport({ ...deps(fetchImpl), file: fixture('k6-summary-export.json'), minScores: { performance: 90 } }),
    ).rejects.toThrow(JsonReportError);
    expect(seen).toEqual([]);
  });

  it('refuses k6 and Lighthouse as the format of a folder, before any run is opened', async () => {
    const { seen, fetchImpl } = platform();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-perf-'));
    try {
      fs.copyFileSync(fixture('k6-summary-export.json'), path.join(dir, 'summary.json'));
      for (const format of ['k6', 'lighthouse'] as const) {
        await expect(handleRunImport({ ...deps(fetchImpl), file: dir, format })).rejects.toThrow(
          `this is a folder, and only allure-results or JUnit XML files are read from one, not ${format}.`,
        );
      }
      expect(seen).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('opens no run when --min-score is given for a folder, with the exit code of a k6 file', async () => {
    const { seen, fetchImpl } = platform();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-perf-'));
    try {
      fs.writeFileSync(path.join(dir, 'TEST-a.xml'), JUNIT);
      await expect(handleRunImport({ ...deps(fetchImpl), file: dir, minScores: { performance: 90 } })).rejects.toThrow(JsonReportError);
      await expect(handleRunImport({ ...deps(fetchImpl), file: dir, minScores: { performance: 90 } })).rejects.toThrow(
        '--min-score is for Lighthouse reports, and this is a folder: there is no score here to hold to it. Drop --min-score for this folder.',
      );
      expect(seen).toEqual([]);
      // An empty --min-score is no bar, and the folder reads as it did.
      await expect(handleRunImport({ ...deps(fetchImpl), file: dir, minScores: {} })).resolves.toMatchObject({ format: 'junit', parsed: 1 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('a report file that starts with a UTF-8 BOM', () => {
    let dir: string;
    beforeEach(() => void (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-bom-'))));
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('is read as a Lighthouse report', async () => {
      const file = path.join(dir, 'lighthouse.json');
      fs.writeFileSync(file, `\uFEFF${fs.readFileSync(fixture('lighthouse-report.json'), 'utf8')}`);
      await expect(handleRunImport({ ...deps(platform().fetchImpl), file })).resolves.toMatchObject({ format: 'lighthouse', parsed: 4 });
    });

    it('is read as a JUnit report', async () => {
      const file = path.join(dir, 'TEST-a.xml');
      fs.writeFileSync(file, `\uFEFF${JUNIT}`);
      const { seen, fetchImpl } = platform();
      await expect(handleRunImport({ ...deps(fetchImpl), file })).resolves.toMatchObject({ format: 'junit', parsed: 1 });
      expect(sentResults(seen)).toHaveLength(1);
    });

    it('reaches every parser without its BOM, and only one is taken off', () => {
      const file = path.join(dir, 'TEST-a.xml');
      fs.writeFileSync(file, `\uFEFF${JUNIT}`);
      expect(readReportFile(file)).toBe(JUNIT);
      fs.writeFileSync(file, `\uFEFF\uFEFF${JUNIT}`);
      expect(readReportFile(file)).toBe(`\uFEFF${JUNIT}`);
    });

    it('is read as a JUnit report from a folder', async () => {
      fs.writeFileSync(path.join(dir, 'TEST-a.xml'), `\uFEFF${JUNIT}`);
      await expect(handleRunImport({ ...deps(platform().fetchImpl), file: dir })).resolves.toMatchObject({ format: 'junit', parsed: 1 });
    });
  });

  it('opens no run for a k6 summary with no thresholds', async () => {
    const { seen, fetchImpl } = platform();
    await expect(handleRunImport({ ...deps(fetchImpl), file: fixture('k6-no-thresholds.json') })).rejects.toThrow(JsonReportError);
    expect(seen).toEqual([]);
  });

  it('refuses an unrelated JSON file without opening a run', async () => {
    const { seen, fetchImpl } = platform();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-perf-'));
    try {
      const file = path.join(dir, 'package.json');
      fs.writeFileSync(file, JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: 'vitest' } }));
      await expect(handleRunImport({ ...deps(fetchImpl), file })).rejects.toThrow(UnknownFormatError);
      expect(seen).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
