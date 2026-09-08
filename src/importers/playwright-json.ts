/**
 * Playwright's own JSON report → results.
 *
 * The reporter in `@plune-ai/playwright` is the better route for a Playwright suite: it reports as
 * the run happens and needs no second step. This is for the case where installing a reporter into
 * someone's config is not on the table — a report handed over by another team, a `merge-reports`
 * artefact from CI, a suite whose config nobody wants to touch.
 *
 * Which is exactly why the identity here must match the reporter's byte for byte. The same test
 * imported once and reported once has to be ONE test in Plune; deriving the keys differently on
 * this path would quietly double every case. `playwright-id` and the `#`-joined `path-title` below
 * are the same two the adapter builds, from the same fields.
 */

import { resultKey } from '../reporter-core/result-key.js';
import type { KeyRef, PendingResult, ResultStatus } from '../reporter-core/types.js';

const SOURCE = 'playwright';

/** `@P<id>` anywhere in a title — the same token the adapter reads, and the same non-stripping. */
const TOKEN = /@P([A-Za-z0-9_-]+)/;

/** As much of Playwright's report as this reads. Everything optional: it is another tool's file. */
interface JsonResult {
  status?: string;
  duration?: number;
  retry?: number;
  startTime?: string;
  workerIndex?: number;
  errors?: { message?: string; stack?: string; value?: string }[];
}
interface JsonTest {
  id?: string;
  expectedStatus?: string;
  annotations?: { type?: string; description?: string }[];
  results?: JsonResult[];
}
interface JsonSpec {
  title?: string;
  file?: string;
  line?: number;
  tests?: JsonTest[];
}
interface JsonSuite {
  title?: string;
  file?: string;
  specs?: JsonSpec[];
  suites?: JsonSuite[];
}

/** A report we could not read. Same contract as the XML side: name the file, never «invalid input». */
export class JsonReportError extends Error {
  constructor(
    readonly file: string,
    detail: string,
  ) {
    super(`${file} — ${detail}`);
    this.name = 'JsonReportError';
  }
}

/** The case this test states outright: an annotation first, then the token in its title (ADR 0023). */
function statedIdOf(test: JsonTest, title: string): string | undefined {
  const annotation = test.annotations?.find((a) => a.type === 'PluneId')?.description;
  if (annotation !== undefined && annotation !== '') return annotation;
  return TOKEN.exec(title)?.[1];
}

function errorTextOf(result: JsonResult): string {
  return (result.errors ?? [])
    .map((e) => e.stack ?? e.message ?? e.value ?? '')
    .filter((text) => text !== '')
    .join('\n\n');
}

function pendingFrom(
  spec: JsonSpec,
  test: JsonTest,
  result: JsonResult,
  file: string,
  titles: string[],
): PendingResult {
  const pathTitle = [file, ...titles].join('#');
  // Without an id there is nothing stable to mint a result key from, so the readable path stands in
  // — it is what the platform would have matched on anyway.
  const seed = test.id ?? pathTitle;
  const stated = statedIdOf(test, spec.title ?? '');
  const expected = test.expectedStatus;
  const errorContext = errorTextOf(result);
  const keys: KeyRef[] = [
    ...(test.id !== undefined ? [{ kind: 'playwright-id' as const, value: test.id }] : []),
    { kind: 'path-title', value: pathTitle },
  ];

  const started = result.startTime !== undefined ? new Date(result.startTime) : undefined;
  const durationMs = typeof result.duration === 'number' && result.duration >= 0 ? result.duration : 0;
  const retry = typeof result.retry === 'number' && result.retry >= 0 ? result.retry : 0;

  return {
    resultKey: resultKey(seed, retry),
    ...(stated !== undefined ? { testCaseId: stated } : {}),
    keys,
    title: titles.join(' › '),
    specRef: spec.line !== undefined ? `${file}:${spec.line}` : file,
    source: SOURCE,
    // Untouched, as everywhere: `timedOut` means what the project's map says it means, not what
    // this file decided.
    rawStatus: result.status ?? 'unknown',
    ...(expected === 'failed' || expected === 'skipped'
      ? { expectedStatus: expected as ResultStatus }
      : {}),
    ...(started !== undefined && !Number.isNaN(started.getTime())
      ? {
          execution: {
            startedAt: started.toISOString(),
            finishedAt: new Date(started.getTime() + durationMs).toISOString(),
            durationMs,
            retry,
            ...(result.workerIndex !== undefined ? { worker: String(result.workerIndex) } : {}),
          },
        }
      : {}),
    ...(errorContext !== '' ? { errorContext } : {}),
  };
}

/**
 * Walk the suite tree.
 *
 * Depth 0 is the file — Playwright titles that suite with the path — and everything below it is a
 * `describe`. That is the same split `titlesOf`/`fileOf` make on the reporter side, which is what
 * keeps the two paths producing one identity.
 */
function walk(suite: JsonSuite, describes: string[], depth: number, out: PendingResult[]): void {
  const here = depth === 0 ? [] : [...describes, suite.title ?? ''];
  for (const spec of suite.specs ?? []) {
    const file = spec.file ?? suite.file ?? suite.title ?? '';
    const titles = [...here, spec.title ?? ''];
    for (const test of spec.tests ?? []) {
      // One result per attempt, exactly as the reporter sends them: a flaky test's retries are
      // three results, and collapsing them here would hide the thing that makes it flaky.
      for (const result of test.results ?? []) out.push(pendingFrom(spec, test, result, file, titles));
    }
  }
  for (const child of suite.suites ?? []) walk(child, here, depth + 1, out);
}

/** Read a Playwright JSON report. */
export function readPlaywrightJson(source: string, file: string): PendingResult[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (err) {
    throw new JsonReportError(file, `not JSON — ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as JsonSuite).suites)) {
    throw new JsonReportError(file, 'no "suites" array — is this a Playwright JSON report?');
  }

  const out: PendingResult[] = [];
  for (const suite of (parsed as { suites: JsonSuite[] }).suites) walk(suite, [], 0, out);
  return out;
}

/** Does this text look like a Playwright JSON report? Read by the detector, never by a parser. */
export function looksLikePlaywrightJson(source: string): boolean {
  const head = source.slice(0, 4096);
  return head.trimStart().startsWith('{') && head.includes('"suites"');
}
