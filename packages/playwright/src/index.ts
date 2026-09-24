import { readFileSync } from 'node:fs';
import { stripVTControlCharacters } from 'node:util';
import type { FullConfig, FullResult, Suite, TestCase, TestError, TestResult, TestStep } from '@playwright/test/reporter';
import {
  errorContextOf,
  failureOf,
  readEnv,
  repoRootOf,
  resultKey,
  startRun,
  webLink,
  type DeclaredStep,
  type FailedAttempt,
  type KeyRef,
  type PendingResult,
  type RunSession,
} from '@plune-ai/cli/reporter-core';

/**
 * The Playwright half of the Plune reporter.
 *
 * Everything this file knows is Playwright: how a test identifies itself, what its result object
 * holds, when the runner calls back. Everything about the platform — batching, lookup, retries,
 * what to do when it is down — lives in `@plune-ai/cli/reporter-core`, which is compiled into this
 * package rather than depended on (feature ADR C1/0001).
 *
 * Two things it deliberately does NOT do, and a test guards each:
 * - It never decides what a status means. `result.status` goes over as `rawStatus` and the
 *   platform maps it per project, so a team can redefine `timedOut` without a release here.
 * - It never fails the test run. Every reporter failure is caught and reported as one line; a
 *   reporter that broke a build because a dashboard was down would be worse than no reporter.
 */

/** The key into the project's status map on the platform. */
const SOURCE = 'playwright';

export interface PluneReporterOptions {
  /** Platform base URL. Defaults to `PLUNE_API_URL`, then beta. */
  apiUrl?: string;
  /** API token. Defaults to whatever `plune login` saved. */
  token?: string;
  /**
   * The key that makes several processes land in one run — shards, or a `merge-reports` step.
   * Falls back to `PLUNE_RUN`, which the core reads; without either, this run is its own.
   */
  externalKey?: string;
  /** Results per request. The platform's ceiling is 500. */
  batchSize?: number;
  /** Where unsent batches are written. Defaults to `.plune/pending-results.jsonl`. */
  fallbackPath?: string;
}

/**
 * The file suite's title is the path relative to `rootDir` — walk up to it rather than guessing.
 *
 * Forward slashes on every OS. Playwright titles the file suite with `path.relative`, which uses
 * backslashes on Windows, while its JSON report writes the same path posix-style — so the
 * `path-title` key this reporter wrote on a Windows machine never equalled the one
 * `plune run import` derived from the report of the same run, and the two met only through
 * `playwright-id`. One spelling, the one a person would type.
 */
function fileOf(test: TestCase): string {
  for (let suite: Suite | undefined = test.parent; suite !== undefined; suite = suite.parent) {
    if (suite.type === 'file') return suite.title.replace(/\\/g, '/');
  }
  return '';
}

/** The `describe` titles around the test, outermost first, then the test's own. */
function titlesOf(test: TestCase): string[] {
  const titles = [test.title];
  for (
    let suite: Suite | undefined = test.parent;
    suite !== undefined && suite.type === 'describe';
    suite = suite.parent
  ) {
    if (suite.title !== '') titles.unshift(suite.title);
  }
  return titles;
}

/**
 * How this test says who it is, best candidate first.
 *
 * `playwright-id` is stable across shards and across a `merge-reports` pass, which is what makes
 * it the first ask. `path-title` is the readable one a person can write into a case by hand, and
 * the one that survives a project being renamed.
 */
function keysFor(test: TestCase): KeyRef[] {
  return [
    { kind: 'playwright-id', value: test.id },
    { kind: 'path-title', value: [fileOf(test), ...titlesOf(test)].join('#') },
  ];
}

/** The content type a test uses to hand the reporter structured metadata (ADR 0023). */
const METADATA_TYPE = 'application/plune.metadata+json';

/** `@P<id>` anywhere in a title. Deliberately not stripped from the title afterwards: the token IS
 * the identity, so the readable path-title key is never consulted for that test anyway. */
const TOKEN = /@P([A-Za-z0-9_-]+)/;

interface PluneMetadata {
  id?: string;
  keys?: KeyRef[];
}

/** What an attachment of ours carries, if the test wrote one. Unreadable or malformed is not an
 * error: it means this rung of the ladder said nothing, and the next one is asked instead. */
function metadataOf(result: TestResult): PluneMetadata | undefined {
  const found = result.attachments.find((a) => a.contentType === METADATA_TYPE);
  if (found === undefined) return undefined;
  try {
    const raw =
      found.body !== undefined
        ? found.body.toString('utf8')
        : found.path !== undefined
          ? readFileSync(found.path, 'utf8')
          : undefined;
    return raw === undefined ? undefined : (JSON.parse(raw) as PluneMetadata);
  } catch {
    return undefined;
  }
}

/**
 * The case this test says it is, in the order ADR 0023 fixed.
 *
 * An annotation is the most deliberate thing an author can write, so it wins. The `@P` token is the
 * same statement made where it is visible in the report. An attachment is what a fixture or a
 * helper writes on the test's behalf — later than both, because a person editing a title should not
 * be overruled by something generated.
 */
function statedIdOf(test: TestCase, metadata: PluneMetadata | undefined): string | undefined {
  const annotation = test.annotations.find((a) => a.type === 'PluneId')?.description;
  if (annotation !== undefined && annotation !== '') return annotation;

  const token = TOKEN.exec(test.title)?.[1];
  if (token !== undefined) return token;

  return metadata?.id !== undefined && metadata.id !== '' ? metadata.id : undefined;
}

/** The statuses of an attempt that has no failure detail (#790 AC-02b). */
const NOT_FAILED = new Set(['passed', 'skipped']);

/**
 * One error as Playwright's own JSON report writes it — `formatError` with colours off: the message
 * (the stack's head when there is a stack), the code frame, the stack's `at` lines, a cause after
 * them — so `plune run import` of that report and this reporter send one text (#790 ADR-0001).
 */
function textOf(error: TestError): string {
  const message = error.message || error.value || '';
  if (!error.stack && !error.location) return message;
  const lines = error.stack?.split('\n') ?? [];
  const at = lines.findIndex((line) => line.startsWith('    at '));
  const tokens = [(at === -1 ? lines : lines.slice(0, at)).join('\n') || message];
  if (error.snippet) tokens.push('', stripVTControlCharacters(error.snippet));
  if (at !== -1) tokens.push(lines.slice(at).join('\n'));
  if (error.cause) tokens.push(`[cause]: ${textOf(error.cause)}`);
  return tokens.join('\n');
}

/**
 * The declared steps, as the JSON report keeps them: `test.step` under `test.step` from the test body
 * down, so a step inside a hook or a fixture, and every action, stays out of the chain.
 */
function declared(steps: readonly TestStep[]): DeclaredStep[] {
  return steps
    .filter((step) => step.category === 'test.step')
    .map((step) => ({ title: step.title, failed: step.error !== undefined, steps: declared(step.steps) }));
}

/** What every attempt of this run shares: where the repository is, and the CI run. */
interface RunContext {
  repoRoot?: string;
  buildHref?: string;
}

/** The attempt as the core reads it — the shape `plune run import` builds from the report. */
function attemptOf(test: TestCase, result: TestResult, ctx: RunContext): FailedAttempt {
  return {
    status: result.status,
    errors: result.errors.map((e) => ({ text: textOf(e), ...(e.location !== undefined ? { location: e.location } : {}) })),
    steps: declared(result.steps ?? []),
    attachments: result.attachments.map(({ name, contentType, path }) => ({
      name,
      contentType,
      ...(path !== undefined ? { path } : {}),
    })),
    ...(ctx.buildHref !== undefined ? { buildHref: ctx.buildHref } : {}),
    testFile: test.location.file,
    ...(ctx.repoRoot !== undefined ? { repoRoot: ctx.repoRoot } : {}),
  };
}

function pendingFrom(test: TestCase, result: TestResult, ctx: RunContext): PendingResult {
  const metadata = metadataOf(result);
  const pluneId = statedIdOf(test, metadata);
  const expected = test.expectedStatus;
  const attempt = attemptOf(test, result, ctx);
  const errorContext = errorContextOf(attempt);
  const failure = NOT_FAILED.has(result.status) ? undefined : failureOf(attempt);
  const startedAt = result.startTime;

  return {
    resultKey: resultKey(test.id, result.retry),
    ...(pluneId !== undefined ? { testCaseId: pluneId } : {}),
    // Anything the test named itself comes before what we derived from its location: a Qase or
    // TestRail id written by a fixture is a deliberate statement, and a file path is a guess.
    keys: [...(metadata?.keys ?? []), ...keysFor(test)],
    // Read only if nothing resolves this test, and then it is what the review queue shows (D14).
    // The full `describe > title` path rather than `test.title` alone: two suites in one file
    // routinely share a title, and "adds an item" on its own is not something a person can judge.
    title: titlesOf(test).join(' › '),
    // The line as well as the file. A reviewer's first move on an unknown test is to open it, and
    // `specRef` is the only thing the entry carries that can take them there.
    specRef: `${fileOf(test)}:${test.location.line}`,
    source: SOURCE,
    // The runner's own word, untouched. Mapping it is the platform's job and a project's setting.
    rawStatus: result.status,
    // `passed` is the default and says nothing; the other two are `test.fail()` and `test.skip()`,
    // and they happen to be spelled the same on both sides — so this is a pass-through, not a map.
    ...(expected === 'failed' || expected === 'skipped' ? { expectedStatus: expected } : {}),
    execution: {
      startedAt: startedAt.toISOString(),
      finishedAt: new Date(startedAt.getTime() + result.duration).toISOString(),
      durationMs: result.duration,
      retry: result.retry,
      worker: String(result.workerIndex),
    },
    ...(errorContext !== '' ? { errorContext } : {}),
    ...(failure !== undefined ? { failure } : {}),
  };
}

export default class PluneReporter {
  private readonly options: PluneReporterOptions;
  private session: Promise<RunSession> | null = null;
  /** Every test the runner means to run, captured at the start for the one up-front lookup. */
  private declared: KeyRef[][] = [];
  /** Results arrive from a sync callback; this serialises them into the async core. */
  private chain: Promise<void> = Promise.resolve();
  private keepOpen = false;
  private complained = false;
  /** Kept whole: `metadata.ci` is written into it after `onConfigure`, so it is read at the run's opening. */
  private config: FullConfig | null = null;
  private context: RunContext = {};

  constructor(options: PluneReporterOptions = {}) {
    this.options = options;
  }

  /** Playwright reads this to pick the v2 calling convention (`onConfigure` + `onBegin(suite)`). */
  version(): 'v2' {
    return 'v2';
  }

  /** Nothing is drawn; the runner's own reporter keeps the terminal. */
  printsToStdio(): boolean {
    return false;
  }

  onConfigure(config: FullConfig): void {
    // A shard cannot know the others are done, so it must not close the run — see `onEnd`.
    // `PLUNE_SHARED_RUN` / `PLUNE_PROCEED` say the same thing for a job Playwright cannot see:
    // a `merge-reports` step, or several suites reporting into one run.
    this.keepOpen = (config.shard !== null && config.shard !== undefined) || readEnv().keepOpen;
    this.config = config;
    // Once per run: the failure detail names files from the repository root (#790).
    const repoRoot = config.rootDir === undefined ? undefined : repoRootOf(config.rootDir);
    if (repoRoot !== undefined) this.context = { repoRoot };
  }

  /**
   * Only the list is taken here; the run opens on the first result. `onBegin` also fires for
   * `--list`, for a `--grep` that matches nothing and for a suite of zero tests — and a run opened
   * there was an empty run on the platform every time, and with a rejected token the request it
   * made was the one thing left pending when Node exited (a libuv assertion on Windows). No
   * result, no run.
   */
  onBegin(suite: Suite): void {
    this.declared = suite.allTests().map(keysFor);
  }

  private open(): Promise<RunSession> {
    if (this.session === null) {
      // Not at `onConfigure`: Playwright's git plugin writes `metadata.ci` after it, and before the
      // first result (#790 ADR-0004). Only an http(s) address — anything else opens without a link.
      const ci: unknown = this.config?.metadata?.['ci'];
      const buildHref = typeof ci === 'object' && ci !== null ? (ci as { buildHref?: unknown }).buildHref : undefined;
      if (typeof buildHref === 'string') this.context = { ...this.context, buildHref };
      const ciUrl = webLink(this.context.buildHref);
      this.session = startRun(
        {
          ...(this.options.apiUrl !== undefined ? { apiUrl: this.options.apiUrl } : {}),
          ...(this.options.token !== undefined ? { token: this.options.token } : {}),
          ...(this.options.externalKey !== undefined
            ? { externalKey: this.options.externalKey }
            : {}),
          ...(this.options.batchSize !== undefined ? { batchSize: this.options.batchSize } : {}),
          ...(this.options.fallbackPath !== undefined
            ? { fallbackPath: this.options.fallbackPath }
            : {}),
          meta: { runner: SOURCE, ...(ciUrl !== undefined ? { ciUrl } : {}) },
        },
        this.declared,
      );
    }
    return this.session;
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const session = this.open();
    this.chain = this.chain
      .then(async () => {
        (await session).add(pendingFrom(test, result, this.context));
      })
      .catch((err: unknown) => this.giveUp(err));
  }

  async onEnd(_result: FullResult): Promise<void> {
    // Nothing reported a result — `--list`, an empty filter, zero tests: no run was opened, so
    // there is none to close.
    const session = this.session;
    if (session === null) return;
    try {
      await this.chain;
      const run = await session;
      // A sharded process leaves the run open on purpose: whoever knows every shard is done — the
      // `merge-reports` step, or `plune run finish` — closes it. Closing it here would mark a run
      // finished while three quarters of it was still going.
      if (this.keepOpen) await run.leaveOpen();
      else await run.finish();
    } catch (err) {
      this.giveUp(err);
    }
  }

  /** Say it once, then stay out of the way. The test run's own outcome is not ours to change. */
  private giveUp(err: unknown): void {
    if (this.complained) return;
    this.complained = true;
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(`plune: reporting stopped — ${reason}\n`);
  }

}
