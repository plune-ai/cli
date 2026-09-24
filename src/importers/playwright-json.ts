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

import { existsSync } from 'node:fs';
import { errorContextOf, failureOf, repoRootOf, webLink } from '../reporter-core/failure-detail.js';
import { resultKey } from '../reporter-core/result-key.js';
import type { DeclaredStep, FailedAttempt, KeyRef, PendingResult, ResultStatus } from '../reporter-core/types.js';

const SOURCE = 'playwright';

/** `@P<id>` anywhere in a title — the same token the adapter reads, and the same non-stripping. */
const TOKEN = /@P([A-Za-z0-9_-]+)/;

/** The statuses of an attempt that has no failure detail (#790 AC-02b). */
const NOT_FAILED = new Set(['passed', 'skipped']);

/** As much of Playwright's report as this reads. Everything optional: it is another tool's file. */
interface JsonResult {
  status?: string;
  duration?: number;
  retry?: number;
  startTime?: string;
  workerIndex?: number;
  /**
   * `formatError` of each error: the message, the code frame and the stack's `at` lines in one text,
   * and where it was thrown. No `stack` of its own — the frames are in the message.
   */
  errors?: { message?: string; value?: string; location?: { file?: string; line?: number; column?: number } }[];
  /** The declared steps only — the report filters hooks, fixtures and actions out at every level. */
  steps?: JsonStep[];
  attachments?: { name?: string; contentType?: string; path?: string }[];
}
interface JsonStep {
  title?: string;
  error?: unknown;
  steps?: JsonStep[];
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
interface JsonReport {
  config?: { rootDir?: string; metadata?: { ci?: { buildHref?: string } } };
  suites: JsonSuite[];
}

/** What every attempt of one report shares. */
interface ReportContext {
  /** Where the runner ran — spec files are relative to it. */
  rootDir?: string;
  /** Found only when `rootDir` is on this machine: a report from elsewhere names no place (#790). */
  repoRoot?: string;
  buildHref?: string;
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

/** The attempt as the core reads it (#790 ADR-0001) — the same shape the adapter builds from its events. */
function attemptOf(result: JsonResult, file: string, ctx: ReportContext): FailedAttempt {
  const steps = (list: JsonStep[] | undefined): DeclaredStep[] =>
    (list ?? []).map((s) => ({ title: s.title ?? '', failed: s.error !== undefined, steps: steps(s.steps) }));
  return {
    status: result.status ?? 'unknown',
    errors: (result.errors ?? []).map(({ message, value, location: at }) => ({
      text: message ?? value ?? '',
      ...(typeof at?.file === 'string' && typeof at.line === 'number'
        ? { location: { file: at.file, line: at.line, ...(typeof at.column === 'number' ? { column: at.column } : {}) } }
        : {}),
    })),
    steps: steps(result.steps),
    attachments: (result.attachments ?? []).map(({ name, contentType, path }) => ({
      name: name ?? '',
      ...(contentType !== undefined ? { contentType } : {}),
      ...(path !== undefined ? { path } : {}),
    })),
    ...(ctx.buildHref !== undefined ? { buildHref: ctx.buildHref } : {}),
    // Spec files are posix and relative to the root dir; the core reads either slash.
    testFile: ctx.rootDir === undefined ? file : `${ctx.rootDir.replace(/[\\/]+$/, '')}/${file}`,
    ...(ctx.repoRoot !== undefined ? { repoRoot: ctx.repoRoot } : {}),
  };
}

function pendingFrom(
  spec: JsonSpec,
  test: JsonTest,
  result: JsonResult,
  file: string,
  titles: string[],
  ctx: ReportContext,
): PendingResult {
  const pathTitle = [file, ...titles].join('#');
  // Without an id there is nothing stable to mint a result key from, so the readable path stands in
  // — it is what the platform would have matched on anyway.
  const seed = test.id ?? pathTitle;
  const stated = statedIdOf(test, spec.title ?? '');
  const expected = test.expectedStatus;
  const attempt = attemptOf(result, file, ctx);
  const errorContext = errorContextOf(attempt);
  const failure = NOT_FAILED.has(attempt.status) ? undefined : failureOf(attempt);
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
    ...(failure !== undefined ? { failure } : {}),
  };
}

/**
 * Walk the suite tree.
 *
 * Depth 0 is the file — Playwright titles that suite with the path — and everything below it is a
 * `describe`. That is the same split `titlesOf`/`fileOf` make on the reporter side, which is what
 * keeps the two paths producing one identity.
 */
function walk(suite: JsonSuite, describes: string[], depth: number, ctx: ReportContext, out: PendingResult[]): void {
  const here = depth === 0 ? [] : [...describes, suite.title ?? ''];
  for (const spec of suite.specs ?? []) {
    const file = spec.file ?? suite.file ?? suite.title ?? '';
    const titles = [...here, spec.title ?? ''];
    for (const test of spec.tests ?? []) {
      // One result per attempt, exactly as the reporter sends them: a flaky test's retries are
      // three results, and collapsing them here would hide the thing that makes it flaky.
      for (const result of test.results ?? []) out.push(pendingFrom(spec, test, result, file, titles, ctx));
    }
  }
  for (const child of suite.suites ?? []) walk(child, here, depth + 1, ctx, out);
}

/**
 * Read a Playwright JSON report: its results, and the CI run that wrote it (`metadata.ci.buildHref`,
 * an http(s) address or nothing) for the run to open with — from the report, never from the machine
 * that imports it (#790 AC-04b).
 */
export function readPlaywrightJson(source: string, file: string): { results: PendingResult[]; ciUrl?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (err) {
    throw new JsonReportError(file, `not JSON — ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as JsonSuite).suites)) {
    throw new JsonReportError(file, 'no "suites" array — is this a Playwright JSON report?');
  }

  const { config, suites } = parsed as JsonReport;
  const rootDir = typeof config?.rootDir === 'string' ? config.rootDir : undefined;
  const buildHref = config?.metadata?.ci?.buildHref;
  // Looked up once per report. A root dir this machine does not have is another machine's run.
  const repoRoot = rootDir !== undefined && existsSync(rootDir) ? repoRootOf(rootDir) : undefined;
  const ctx: ReportContext = {
    ...(rootDir !== undefined ? { rootDir } : {}),
    ...(repoRoot !== undefined ? { repoRoot } : {}),
    ...(typeof buildHref === 'string' ? { buildHref } : {}),
  };
  const out: PendingResult[] = [];
  for (const suite of suites) walk(suite, [], 0, ctx, out);
  const ciUrl = webLink(ctx.buildHref);
  return ciUrl === undefined ? { results: out } : { results: out, ciUrl };
}

/**
 * Does this text look like a Playwright JSON report? Read by the detector, never by a parser. The whole
 * text, not a head of it: Playwright writes `config` first — argv, every project, each reporter's
 * options — and a real report put "suites" past its first 7 KB (#790 T18).
 */
export function looksLikePlaywrightJson(source: string): boolean {
  return /^\s*\{/.test(source) && source.includes('"suites"');
}
