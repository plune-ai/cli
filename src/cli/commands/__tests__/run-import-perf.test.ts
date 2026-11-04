import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleRunImport } from '../run-import.js';
import { JsonReportError, UnknownFormatError } from '../../../importers/index.js';

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
