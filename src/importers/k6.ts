/**
 * A k6 end-of-test summary → results.
 *
 * k6 has no tests; it has metrics, and the only part of a summary that passes or fails is a
 * threshold. k6 has already judged each one, so a threshold is one result and k6's verdict is its
 * status: nothing here re-evaluates an expression against the numbers.
 *
 * Two shapes say the same thing. `k6 run --summary-export=summary.json` writes each metric's values
 * flat beside a `thresholds` map of expression → boolean, where `true` means the threshold was
 * crossed (k6 writes `!ok` there). The `data` object `handleSummary` receives keeps the values under
 * `values` and each threshold as `{ ok }`. Both are read; an `ok` is believed over a boolean.
 */

import * as path from 'node:path';
import { printable } from '../reporter-core/failure-detail.js';
import { resultKey } from '../reporter-core/result-key.js';
import type { PendingResult } from '../reporter-core/types.js';
import { JsonReportError } from './playwright-json.js';

const SOURCE = 'k6';

interface K6Metric {
  type?: string;
  contains?: string;
  values?: Record<string, unknown>;
  thresholds?: Record<string, unknown>;
  [value: string]: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Is this parsed JSON a k6 summary? A `metrics` object, and either a metric that has a `type` or
 * `thresholds` of its own or the `root_group` every k6 summary carries — so a summary with no
 * thresholds is still recognised, and refused for that reason rather than as an unknown file.
 */
export function isK6Summary(parsed: unknown): boolean {
  if (!isObject(parsed) || !isObject(parsed['metrics'])) return false;
  if (isObject(parsed['root_group'])) return true;
  return Object.values(parsed['metrics']).some((m) => isObject(m) && (typeof m['type'] === 'string' || isObject(m['thresholds'])));
}

/** k6's verdict on one threshold: `{ ok }` in `handleSummary` data, «crossed» as a boolean in --summary-export. */
function passedOf(verdict: unknown): boolean | undefined {
  if (isObject(verdict) && typeof verdict['ok'] === 'boolean') return verdict['ok'];
  if (typeof verdict === 'boolean') return !verdict;
  return undefined;
}

/** The metric's numbers, `name=value`, in the order k6 wrote them; milliseconds said where k6 says it is time. */
function measuredOf(metric: K6Metric): string {
  const values = isObject(metric.values) ? metric.values : metric;
  const unit = metric.contains === 'time' ? ' ms' : '';
  return Object.entries(values)
    .filter(([name, v]) => name !== 'thresholds' && typeof v === 'number')
    .map(([name, v]) => `${name}=${Math.round((v as number) * 100) / 100}${unit}`)
    .join(', ');
}

/** Read a k6 summary. Throws `JsonReportError` for a file that is not one, or one with no thresholds. */
export function readK6(source: string, file: string): PendingResult[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (err) {
    throw new JsonReportError(file, `not JSON — ${printable(err instanceof Error ? err.message : String(err))}`);
  }
  if (!isObject(parsed) || !isObject(parsed['metrics'])) {
    throw new JsonReportError(file, 'no "metrics" object — is this a k6 summary (k6 run --summary-export, or the data handleSummary receives)?');
  }
  const specRef = path.basename(file);
  const out: PendingResult[] = [];
  for (const [name, raw] of Object.entries(parsed['metrics'])) {
    if (!isObject(raw) || !isObject(raw['thresholds'])) continue;
    const metric = raw as K6Metric;
    const measured = measuredOf(metric);
    for (const [expression, verdict] of Object.entries(metric.thresholds!)) {
      const passed = passedOf(verdict);
      // A verdict in neither shape is k6's to give, not ours to guess: it is not a pass.
      const status = passed === true ? 'passed' : 'failed';
      const said = passed === undefined ? 'no verdict in the summary' : status;
      // The file's name too: smoke.json and load.json with the same threshold under one --key are two results, not a duplicate.
      const value = `${SOURCE}#${specRef}#${name}#${expression}`;
      out.push({
        resultKey: resultKey(value, 0),
        keys: [{ kind: 'path-title', value }],
        source: SOURCE,
        rawStatus: status,
        title: `${name} ${expression}`,
        specRef,
        errorContext: `k6 threshold "${expression}" on ${name}: ${said}.${measured !== '' ? ` Measured: ${measured}.` : ''}`,
      });
    }
  }
  if (out.length === 0) {
    throw new JsonReportError(
      file,
      'k6 defined no thresholds, so there is nothing to pass or fail. Add thresholds to the script\'s options ' +
        '(for example http_req_duration: [\'p(95)<500\']) and run it again.',
    );
  }
  return out;
}
