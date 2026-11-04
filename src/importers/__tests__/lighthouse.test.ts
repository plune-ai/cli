import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLighthouse, parseMinScore, DEFAULT_MIN_SCORE } from '../lighthouse.js';
import { JsonReportError, UnknownFormatError, detectFormat, readReport } from '../index.js';

/**
 * A Lighthouse report scores categories; it does not pass or fail them. The bar is ours to set, so
 * these tests pin where it is (Lighthouse's own "good" band unless --min-score says otherwise) and
 * that a score Lighthouse could not compute is never read as a pass.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string => path.join(here, 'fixtures', 'perf', name);
const read = (name: string): string => fs.readFileSync(fixture(name), 'utf8');
const REPORT = read('lighthouse-report.json');

describe('Lighthouse report import', () => {
  it('makes one result per category, scored 0–100 against the default of 90', () => {
    expect(DEFAULT_MIN_SCORE).toBe(90);
    const results = readLighthouse(REPORT, fixture('lighthouse-report.json'));
    expect(results.map((r) => [r.title, r.rawStatus])).toEqual([
      ['performance (http://localhost:4173/)', 'passed'],
      ['accessibility (http://localhost:4173/)', 'failed'],
      ['best-practices (http://localhost:4173/)', 'passed'],
      // 0.895 is the 90 Lighthouse shows, and the 90 is what is compared.
      ['seo (http://localhost:4173/)', 'passed'],
    ]);
    expect(results[1]!.errorContext).toBe('Lighthouse Accessibility score: 84, below the 90 needed to pass.');
    expect(results[0]!.errorContext).toBe('Lighthouse Performance score: 97, at least the 90 needed to pass.');
  });

  it('lets --min-score move the bar per category', () => {
    const results = readLighthouse(REPORT, fixture('lighthouse-report.json'), { performance: 98, accessibility: 80 });
    expect(results.map((r) => r.rawStatus)).toEqual(['failed', 'passed', 'passed', 'passed']);
    expect(results[0]!.errorContext).toBe('Lighthouse Performance score: 97, below the 98 needed to pass.');
  });

  it('keys a category by the page it scored, and times the run from the report', () => {
    const [first] = readLighthouse(REPORT, fixture('lighthouse-report.json'));
    expect(first!.keys).toEqual([{ kind: 'path-title', value: 'lighthouse#http://localhost:4173/#performance' }]);
    expect(first!.source).toBe('lighthouse');
    expect(first!.execution).toEqual({
      startedAt: '2026-11-04T09:15:02.118Z',
      finishedAt: '2026-11-04T09:15:10.353Z',
      durationMs: 8235,
      retry: 0,
    });
  });

  it('fails a category Lighthouse could not score, and says so', () => {
    const report = JSON.parse(REPORT) as { categories: Record<string, { score: number | null }> };
    report.categories['seo']!.score = null;
    const results = readLighthouse(JSON.stringify(report), 'lh.json', { seo: 0 });
    const seo = results.find((r) => r.title!.startsWith('seo'))!;
    expect(seo.rawStatus).toBe('failed');
    expect(seo.errorContext).toBe('Lighthouse could not compute a SEO score, so it cannot pass.');
  });

  it('fails every category of a report with a runtime error, with that error as the message', () => {
    const results = readLighthouse(read('lighthouse-runtime-error.json'), 'lh.json');
    expect(results.map((r) => r.rawStatus)).toEqual(['failed', 'failed']);
    expect(results[0]!.errorContext).toBe(
      'Lighthouse stopped with NO_FCP: The page did not paint any content. Please ensure you keep the browser window in the foreground during the load and try again. (NO_FCP)',
    );
  });

  it('fails a report that stopped before it scored anything as one result, not as nothing', () => {
    const report = JSON.parse(read('lighthouse-runtime-error.json')) as { categories: object };
    report.categories = {};
    const results = readLighthouse(JSON.stringify(report), 'lh.json');
    expect(results.map((r) => [r.title, r.rawStatus])).toEqual([['run (http://localhost:4173/)', 'failed']]);
    expect(results[0]!.errorContext).toMatch(/^Lighthouse stopped with NO_FCP: /);
  });

  it('reads a runtimeError of NO_ERROR, which older Lighthouse writes into every good report, as no error', () => {
    const report = JSON.parse(REPORT) as Record<string, unknown>;
    report['runtimeError'] = { code: 'NO_ERROR', message: '' };
    const without = readLighthouse(REPORT, 'lh.json');
    const withField = readLighthouse(JSON.stringify(report), 'lh.json');
    expect(withField.map((r) => r.rawStatus)).toEqual(['passed', 'failed', 'passed', 'passed']);
    expect(withField.map((r) => [r.rawStatus, r.errorContext])).toEqual(without.map((r) => [r.rawStatus, r.errorContext]));
  });

  it('refuses a --min-score for a category the report does not have, naming the ones it has', () => {
    expect(() => readLighthouse(REPORT, 'lh.json', { perf: 95 })).toThrow(JsonReportError);
    expect(() => readLighthouse(REPORT, 'lh.json', { performance: 90, perf: 95 })).toThrow(
      'lh.json — --min-score perf=95 names a category the report does not have; it has performance, accessibility, best-practices, seo.',
    );
  });

  it('holds --min-score to the categories by their own id, and an entry that is not a category to nothing', () => {
    const report = JSON.parse(REPORT) as { categories: Record<string, unknown> };
    report.categories['broken'] = null;
    report.categories['custom'] = { id: 'my-budget', title: 'My budget', score: 0.5 };
    const results = readLighthouse(JSON.stringify(report), 'lh.json', { 'my-budget': 40 });
    expect(results.map((r) => [r.title, r.rawStatus])).toContainEqual(['my-budget (http://localhost:4173/)', 'passed']);
    expect(() => readLighthouse(JSON.stringify(report), 'lh.json', { broken: 10 })).toThrow(
      'it has performance, accessibility, best-practices, seo, my-budget.',
    );
  });

  it('holds a report that stopped before it scored anything to its failure, whatever --min-score names', () => {
    const report = JSON.parse(read('lighthouse-runtime-error.json')) as { categories: object };
    report.categories = {};
    const results = readLighthouse(JSON.stringify(report), 'lh.json', { performance: 90 });
    expect(results.map((r) => r.rawStatus)).toEqual(['failed']);
  });

  it('reads --min-score as category=0..100 and refuses anything else', () => {
    expect(parseMinScore('performance=90', {})).toEqual({ performance: 90 });
    expect(parseMinScore('seo=75', { performance: 90 })).toEqual({ performance: 90, seo: 75 });
    expect(() => parseMinScore('performance', {})).toThrow(/category=score/);
    expect(() => parseMinScore('performance=101', {})).toThrow(/0 to 100/);
  });

  it('is detected by lighthouseVersion and categories', () => {
    expect(detectFormat(REPORT, 'report.json')).toBe('lighthouse');
    expect(readReport(REPORT, 'report.json', undefined, { minScores: { accessibility: 80 } }).results[1]!.rawStatus).toBe(
      'passed',
    );
  });

  it('refuses a JSON file that is not a Lighthouse report when --format lighthouse says it is', () => {
    expect(() => readReport('{"categories":{}}', 'x.json', 'lighthouse')).toThrow(JsonReportError);
  });

  it('is detected as Lighthouse even when a string in the report is "suites"', () => {
    const report = JSON.parse(REPORT) as { audits: Record<string, Record<string, unknown>> };
    report.audits['first-contentful-paint']!['details'] = { type: 'list', items: [{ label: 'suites' }] };
    expect(detectFormat(JSON.stringify(report), 'report.json')).toBe('lighthouse');
  });

  it('refuses --min-score for a report that is not Lighthouse', () => {
    const k6 = fs.readFileSync(fixture('k6-summary-export.json'), 'utf8');
    expect(() => readReport(k6, 'summary.json', undefined, { minScores: { performance: 90 } })).toThrow(JsonReportError);
    expect(() => readReport(k6, 'summary.json', undefined, { minScores: { performance: 90 } })).toThrow(
      'summary.json — --min-score is for Lighthouse reports, and this is a k6 report: there is no score here to hold to it. Drop --min-score for this file.',
    );
    const junit = '<testsuite name="s" tests="1"><testcase name="t" classname="c"/></testsuite>';
    expect(() => readReport(junit, 'TEST-a.xml', undefined, { minScores: { seo: 80 } })).toThrow(/this is a junit report/);
    expect(readReport(junit, 'TEST-a.xml', undefined, { minScores: {} }).results).toHaveLength(1);
  });

  it('refuses an unrelated JSON file with the formats it looked for', () => {
    expect(() => detectFormat('{"name":"pkg","version":"1.0.0"}', 'package.json')).toThrow(UnknownFormatError);
    expect(() => detectFormat('{"name":"pkg","version":"1.0.0"}', 'package.json')).toThrow(
      /no k6 "metrics" and no Lighthouse "lighthouseVersion"/,
    );
  });
});
