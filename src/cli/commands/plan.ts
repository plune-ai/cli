import { resolveApiUrl } from '../api-url.js';
import { loadToken } from '../credentials.js';
import { NotLoggedInError, SyncHttpError, SyncNetworkError, TokenRejectedError } from './sync.js';

/**
 * `plune plan grep <id>` (C8): a plan on the platform as the `--grep` a runner takes, so the
 * platform decides WHICH tests run and CI only runs them —
 * `npx playwright test --grep "$(plune plan grep <id>)"`.
 *
 * Testomat does the same with `--filter 'testomatio:plan=<id>'`: the plan resolves to test ids,
 * joined with `|`, handed to the framework's `--grep`. Their ids sit in test titles as `@T123`; ours
 * do not have to — a case's identity is its `path-title` key (`file#describe#title`, the one the
 * reporter and `run import` both build), so the pattern is the title path, escaped. One line on
 * stdout and nothing else, so `$(…)` is clean; the summary goes to stderr.
 */
export interface PlanCase {
  id: string;
  title: string;
  type: string;
  externalKeys: { kind: string; value: string }[];
}

export interface PlanGrepDeps {
  planId: string;
  apiUrl?: string;
  loadToken?: () => string | null;
  fetchImpl?: typeof fetch;
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Between two segments of a title path, whatever the runner puts there: a space (Playwright's
 * `_grepTitleWithTags()`, vitest ≤ 4 and jest `-t`, mocha `fullTitle()`), ` > ` (vitest 5's
 * `fullTestName`), or the `#` a title had of its own — the key joins with `#` and does not escape
 * one inside a title, so `… (#742)` splits like a boundary and must still match.
 */
const BOUNDARY = '[ >#]+';

/**
 * What of one case goes into the pattern. From `path-title` (`file#describe#…#title`): everything
 * after the file, segments through {@link BOUNDARY} — the file is left out because the key spells
 * it the reporter's way (forward slashes, relative to its own root), not necessarily the runner's.
 * A junit key is `classname#name`, and `name` carries the producer's own separator — ` > ` from
 * vitest, ` › ` from Playwright — which is a boundary too. No key — a manual case, or one the
 * reporter identified by id alone — falls back to the title, which for a reporter-created case IS
 * the test title.
 */
export function grepFragment(c: PlanCase): string {
  const pathTitle = c.externalKeys.find((k) => k.kind === 'path-title')?.value;
  const segments = pathTitle?.split('#') ?? [c.title];
  // ponytail: a Playwright describe with tags (`cart @smoke rejects…`) is not selected; the stderr
  // count against the runner's own is where that shows.
  return (segments.length > 1 ? segments.slice(1) : segments)
    .flatMap((s) => s.split(/ [>›] /))
    .map(escape)
    .join(BOUNDARY);
}

/** The fragments through `|`; an empty plan is a pattern that matches nothing — an empty `--grep` would run everything. */
export function formatGrep(cases: PlanCase[]): string {
  if (cases.length === 0) return '(?!)';
  return cases.map(grepFragment).join('|');
}

async function safeErrorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === 'string' ? body.error : '';
  } catch {
    return '';
  }
}

/**
 * The platform with the caller's token: a GET of a path, with the ladder of refusals `sync` has —
 * not logged in, a rejected token, an HTTP error with the platform's own words, no network.
 */
export function platformGet(deps: Omit<PlanGrepDeps, 'planId'>): <T>(path: string) => Promise<T> {
  const apiUrl = resolveApiUrl(deps.apiUrl);
  const token = (deps.loadToken ?? loadToken)();
  if (token === null) throw new NotLoggedInError();
  const doFetch = deps.fetchImpl ?? fetch;
  return async <T>(path: string): Promise<T> => {
    let res: Response;
    try {
      res = await doFetch(`${apiUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
    } catch {
      throw new SyncNetworkError(apiUrl);
    }
    if (!res.ok) {
      const detail = await safeErrorDetail(res);
      if (res.status === 401) throw new TokenRejectedError();
      throw new SyncHttpError(res.status, detail);
    }
    return (await res.json()) as T;
  };
}

/** How many of the cases go in by their title path rather than by title — the stderr line's number. */
const keyedOf = (cases: PlanCase[]): number =>
  cases.filter((c) => c.externalKeys.some((k) => k.kind === 'path-title')).length;

/** `GET /v1/plans/:id/cases` → the pattern, and the two numbers the stderr line names. */
export async function handlePlanGrep(
  deps: PlanGrepDeps,
): Promise<{ pattern: string; cases: number; keyed: number }> {
  const get = platformGet(deps);
  const { cases } = await get<{ cases: PlanCase[] }>(
    `/v1/plans/${encodeURIComponent(deps.planId)}/cases`,
  );
  return { pattern: formatGrep(cases), cases: cases.length, keyed: keyedOf(cases) };
}

/**
 * `plune run grep <run>` (plune-ai/cli#85): a run's automated cases as one `--grep`, the way
 * `plan grep` makes a plan's — so the two commands Plune shows for a run work as they are:
 * `npx playwright test --grep "$(plune run grep <run-id> --failed)"` re-runs an automated run's
 * failures where its tests live (Plune starts no CI), and
 * `PLUNE_RUN=<key> npx playwright test --grep "$(plune run grep <key>)"` runs the automated half of
 * a mixed run launched without a plan.
 *
 * The run's cases are the platform's list (`GET /v1/runs/:id/cases`): what it expected — the
 * cases added on its page among them, run or not — and what it holds a result of. `--failed` asks
 * the platform for the ones whose latest result it COUNTS as failed or broken rather than reading
 * statuses here: a muted case's failure is counted `muted` (plune#1247), and the CLI must leave it
 * out exactly as «Re-run N failed» does, by the platform's rule and not by a copy of it. The manual
 * cases are a person's to run; their titles in the pattern would only select tests by accident.
 */
export interface RunGrepDeps extends Omit<PlanGrepDeps, 'planId'> {
  /** The run's id, or its key. */
  run: string;
  failed?: boolean;
}

export interface RunGrep {
  pattern: string;
  /** The automated cases taken. */
  cases: number;
  /** Of those, the ones that go in by their title path. */
  keyed: number;
  /** The run's other cases, left out. */
  skipped: number;
}

/** The two shapes a run is named by: its id, a UUID, and its key, `rk_` and ten hex (`POST /v1/runs/keys`). */
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUN_KEY = /^rk_[0-9a-f]{10}$/;

/** `<run>` names no run: not the shape of one (exit 2 — nothing was asked), or a key no run carries (exit 1). */
export class RunRefError extends Error {
  constructor(
    message: string,
    readonly exitCode: 1 | 2,
  ) {
    super(message);
    this.name = 'RunRefError';
  }
}

/** The run's cases → the pattern of its automated ones, and the three numbers the stderr line names. */
export async function handleRunGrep(deps: RunGrepDeps): Promise<RunGrep> {
  const byKey = RUN_KEY.test(deps.run);
  // Before the token and the network: what was typed goes nowhere unless it has the shape of a run,
  // and a typo is told as one rather than as a 404 from the other end.
  if (!byKey && !RUN_ID.test(deps.run)) {
    throw new RunRefError(
      `${JSON.stringify(deps.run)} is not a run — pass its id (a UUID, as in the run page's address) or its key (rk_ and ten hex, the PLUNE_RUN Plune shows).`,
      2,
    );
  }
  const get = platformGet(deps);
  let runId = deps.run;
  if (byKey) {
    // The key is checked above, so it goes into the query as it is.
    const { runs } = await get<{ runs: { id: string }[] }>(`/v1/runs?key=${deps.run}&limit=1`);
    const run = runs[0];
    if (run === undefined) {
      throw new RunRefError(
        `No run carries the key ${deps.run} — a key becomes a run's when the run is saved or launched in Plune.`,
        1,
      );
    }
    runId = run.id;
  }
  const { cases } = await get<{ cases: PlanCase[] }>(
    `/v1/runs/${encodeURIComponent(runId)}/cases${deps.failed === true ? '?status=failed,broken' : ''}`,
  );
  const automated = cases.filter((c) => c.type === 'automated');
  return {
    pattern: formatGrep(automated),
    cases: automated.length,
    keyed: keyedOf(automated),
    skipped: cases.length - automated.length,
  };
}

/** The stderr line of `run grep`: how many cases were taken, how many left out. */
export function runGrepSummary(out: RunGrep, failed: boolean): string {
  if (out.cases === 0) {
    const none = failed
      ? 'no automated case failed or broke in the run'
      : 'the run holds no automated case';
    return `plune: ${none} (${out.skipped} manual left out) — the pattern matches nothing.\n`;
  }
  const which = failed ? 'that failed or broke in the run' : 'of the run';
  return `plune: ${out.cases} automated case(s) ${which}, ${out.keyed} with a test key, the rest by title; ${out.skipped} manual left out.\n`;
}
