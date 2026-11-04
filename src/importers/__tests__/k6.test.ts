import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readK6 } from '../k6.js';
import { JsonReportError, detectFormat, readReport } from '../index.js';

/**
 * A k6 summary carries no tests, only metrics. What it does carry that can pass or fail is a
 * threshold, and k6 already decided each one: these tests pin that the import takes k6's word for
 * it and invents nothing — no threshold, no result.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string => path.join(here, 'fixtures', 'perf', name);
const read = (name: string): string => fs.readFileSync(fixture(name), 'utf8');

describe('k6 summary import', () => {
  it('makes one result per threshold of the --summary-export file, named metric and expression', () => {
    const results = readK6(read('k6-summary-export.json'), fixture('k6-summary-export.json'));
    expect(results.map((r) => [r.title, r.rawStatus])).toEqual([
      ['http_req_duration p(95)<500', 'passed'],
      ['http_req_duration p(90)<20', 'failed'],
      ['http_req_failed rate<0.01', 'passed'],
    ]);
  });

  it('puts the measured values in the message, the crossed threshold said as failed', () => {
    const [, crossed] = readK6(read('k6-summary-export.json'), fixture('k6-summary-export.json'));
    expect(crossed!.errorContext).toBe(
      'k6 threshold "p(90)<20" on http_req_duration: failed. Measured: avg=12.41, min=3.02, med=9.87, max=61.5, p(90)=24.3, p(95)=38.71.',
    );
  });

  it('reads the handleSummary data object by its ok flags, with the unit k6 names', () => {
    const results = readK6(read('k6-handle-summary.json'), fixture('k6-handle-summary.json'));
    expect(results.map((r) => [r.title, r.rawStatus])).toEqual([
      ['http_req_duration p(95)<500', 'passed'],
      ['http_req_duration p(90)<20', 'failed'],
      ['http_req_failed rate<0.01', 'passed'],
    ]);
    expect(results[0]!.errorContext).toBe(
      'k6 threshold "p(95)<500" on http_req_duration: passed. Measured: avg=12.41 ms, min=3.02 ms, med=9.87 ms, max=61.5 ms, p(90)=24.3 ms, p(95)=38.71 ms.',
    );
  });

  it('keys each threshold by source, metric and expression, the same in both shapes', () => {
    const exported = readK6(read('k6-summary-export.json'), fixture('k6-summary-export.json'));
    const handled = readK6(read('k6-handle-summary.json'), fixture('k6-handle-summary.json'));
    expect(exported[0]!.keys).toEqual([{ kind: 'path-title', value: 'k6#http_req_duration#p(95)<500' }]);
    expect(handled.map((r) => r.keys)).toEqual(exported.map((r) => r.keys));
    expect(exported[0]!.source).toBe('k6');
    expect(exported[0]!.specRef).toBe('k6-summary-export.json');
  });

  it('refuses a summary with no thresholds, saying there is nothing to pass or fail', () => {
    expect(() => readK6(read('k6-no-thresholds.json'), fixture('k6-no-thresholds.json'))).toThrow(JsonReportError);
    expect(() => readK6(read('k6-no-thresholds.json'), fixture('k6-no-thresholds.json'))).toThrow(
      /k6 defined no thresholds, so there is nothing to pass or fail/,
    );
  });

  it('is detected by its own keys, with or without thresholds', () => {
    expect(detectFormat(read('k6-summary-export.json'), 'x.json')).toBe('k6');
    expect(detectFormat(read('k6-handle-summary.json'), 'x.json')).toBe('k6');
    expect(detectFormat(read('k6-no-thresholds.json'), 'x.json')).toBe('k6');
    expect(readReport(read('k6-summary-export.json'), fixture('k6-summary-export.json')).format).toBe('k6');
  });

  it('refuses a JSON file that is not a k6 summary when --format k6 says it is', () => {
    expect(() => readReport('{"name":"pkg"}', 'package.json', 'k6')).toThrow(/no "metrics" object/);
  });
});
