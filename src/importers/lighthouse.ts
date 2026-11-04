/**
 * A Lighthouse JSON report (`lighthouse <url> --output=json`) → results.
 *
 * Lighthouse scores categories and passes none of them, so the bar is set here: one result per
 * category, passed when its score — 0–100, rounded as Lighthouse shows it — is at least the bar.
 * The bar is `--min-score <category>=<n>`, or Lighthouse's own "good" band (90 and up) for a
 * category nobody named. A score Lighthouse could not compute (`null`) is never a pass, and a report
 * that stopped on a `runtimeError` fails every category with that error's words. A bar for a category
 * the report does not have is refused, not ignored: a bar that judged nothing reads as a bar that was met.
 */

import * as path from 'node:path';
import { printable } from '../reporter-core/failure-detail.js';
import { resultKey } from '../reporter-core/result-key.js';
import type { Execution, PendingResult } from '../reporter-core/types.js';
import { JsonReportError } from './playwright-json.js';

export { parseMinScore } from './min-score.js';

const SOURCE = 'lighthouse';

/** Lighthouse's "good" band starts here; a category with no --min-score is held to it. */
export const DEFAULT_MIN_SCORE = 90;

interface Category {
  id?: string;
  title?: string;
  score?: number | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Is this parsed JSON a Lighthouse report? Its own two keys: `lighthouseVersion` and `categories`. */
export function isLighthouseReport(parsed: unknown): boolean {
  return isObject(parsed) && typeof parsed['lighthouseVersion'] === 'string' && isObject(parsed['categories']);
}

/** A category's id: its own `id`, or the key it sits under. */
function idOf(key: string, category: Category): string {
  return typeof category.id === 'string' && category.id !== '' ? category.id : key;
}

/** When the run happened, from the report's own clock: `fetchTime` and `timing.total`. */
function executionOf(report: Record<string, unknown>): Execution | undefined {
  const started = typeof report['fetchTime'] === 'string' ? new Date(report['fetchTime']) : undefined;
  if (started === undefined || Number.isNaN(started.getTime())) return undefined;
  const timing = report['timing'];
  const total = isObject(timing) && typeof timing['total'] === 'number' && timing['total'] >= 0 ? Math.round(timing['total']) : 0;
  return {
    startedAt: started.toISOString(),
    finishedAt: new Date(started.getTime() + total).toISOString(),
    durationMs: total,
    retry: 0,
  };
}

/**
 * The runtime error's own words, or nothing when the run did not stop on one. Older Lighthouse writes
 * `{ code: 'NO_ERROR', message: '' }` into every report that ran clean, and that is no error.
 */
function runtimeErrorOf(report: Record<string, unknown>): string | undefined {
  const err = report['runtimeError'];
  if (!isObject(err)) return undefined;
  const code = typeof err['code'] === 'string' ? err['code'] : undefined;
  if (code === 'NO_ERROR') return undefined;
  const message = typeof err['message'] === 'string' ? err['message'] : undefined;
  if (code === undefined && message === undefined) return undefined;
  return `Lighthouse stopped with ${code ?? 'a runtime error'}${message !== undefined ? `: ${message}` : ''}`;
}

/**
 * Read a Lighthouse report. `minScores` is `--min-score`; a category it names that the report lacks
 * is refused (exit 2) before anything is sent, with the categories the report does have.
 */
export function readLighthouse(
  source: string,
  file: string,
  minScores: Record<string, number> = {},
): PendingResult[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (err) {
    throw new JsonReportError(file, `not JSON — ${printable(err instanceof Error ? err.message : String(err))}`);
  }
  if (!isLighthouseReport(parsed)) {
    throw new JsonReportError(file, 'no "lighthouseVersion" and "categories" — is this a Lighthouse JSON report (lighthouse <url> --output=json)?');
  }
  const report = parsed as Record<string, unknown>;
  const categories = report['categories'] as Record<string, unknown>;
  const url = ['requestedUrl', 'finalDisplayedUrl', 'finalUrl'].map((k) => report[k]).find((u): u is string => typeof u === 'string' && u !== '');
  const runtimeError = runtimeErrorOf(report);
  const execution = executionOf(report);
  const specRef = path.basename(file);

  // A report that stopped before it scored anything has no category to hold a bar to, and fails as it is.
  const known = Object.entries(categories)
    .filter(([, raw]) => isObject(raw))
    .map(([key, raw]) => idOf(key, raw as Category));
  if (known.length > 0) {
    for (const [id, score] of Object.entries(minScores)) {
      if (!known.includes(id)) {
        throw new JsonReportError(
          file,
          `--min-score ${printable(id)}=${score} names a category the report does not have; it has ${known.map(printable).join(', ')}.`,
        );
      }
    }
  }

  const out: PendingResult[] = [];
  const result = (id: string, passed: boolean, message: string): void => {
    const value = `${SOURCE}#${url ?? ''}#${id}`;
    out.push({
      resultKey: resultKey(value, 0),
      keys: [{ kind: 'path-title', value }],
      source: SOURCE,
      rawStatus: passed ? 'passed' : 'failed',
      title: url !== undefined ? `${id} (${url})` : id,
      specRef,
      ...(execution !== undefined ? { execution } : {}),
      errorContext: message,
    });
  };
  for (const [key, raw] of Object.entries(categories)) {
    if (!isObject(raw)) continue;
    const category = raw as Category;
    const id = idOf(key, category);
    const name = typeof category.title === 'string' && category.title !== '' ? category.title : id;
    const bar = minScores[id] ?? DEFAULT_MIN_SCORE;
    let passed = false;
    let message: string;
    if (runtimeError !== undefined) {
      message = runtimeError;
    } else if (typeof category.score !== 'number') {
      message = `Lighthouse could not compute a ${name} score, so it cannot pass.`;
    } else {
      const shown = Math.round(category.score * 100);
      passed = shown >= bar;
      message = `Lighthouse ${name} score: ${shown}, ${passed ? 'at least' : 'below'} the ${bar} needed to pass.`;
    }
    result(id, passed, message);
  }
  // A run that stopped before it scored anything is still a run that failed: one result says so.
  if (out.length === 0 && runtimeError !== undefined) result('run', false, runtimeError);
  if (out.length === 0) {
    throw new JsonReportError(file, 'the report has no categories, so there is nothing to pass or fail.');
  }
  return out;
}
