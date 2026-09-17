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

/** `GET /v1/plans/:id/cases` → the pattern, and the two numbers the stderr line names. */
export async function handlePlanGrep(
  deps: PlanGrepDeps,
): Promise<{ pattern: string; cases: number; keyed: number }> {
  const apiUrl = resolveApiUrl(deps.apiUrl);
  const token = (deps.loadToken ?? loadToken)();
  if (token === null) throw new NotLoggedInError();

  const doFetch = deps.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${apiUrl}/v1/plans/${encodeURIComponent(deps.planId)}/cases`, {
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    throw new SyncNetworkError(apiUrl);
  }
  if (!res.ok) {
    const detail = await safeErrorDetail(res);
    if (res.status === 401) throw new TokenRejectedError();
    throw new SyncHttpError(res.status, detail);
  }
  const { cases } = (await res.json()) as { cases: PlanCase[] };
  return {
    pattern: formatGrep(cases),
    cases: cases.length,
    keyed: cases.filter((c) => c.externalKeys.some((k) => k.kind === 'path-title')).length,
  };
}
