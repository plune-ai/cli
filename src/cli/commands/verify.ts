import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { platformGet, type PlanGrepDeps } from './plan.js';
import { SyncFileError } from './sync.js';

/**
 * `plune verify` (plune-ai/plune#1291, AC-07): the project's automated cases against the tests the code has now,
 * read-only. Both sides of the difference are printed — what the platform has and the code no longer does (the
 * cases a full run would mark `detached`), and what the code has and the platform does not know yet — so drift is
 * seen before a test leaves a regression, not after. Nothing is written, in either direction.
 *
 * Playwright only for now: the tests come from `playwright test --list --reporter=json`, and a test is the case it
 * names (`PluneId` annotation or `@P<id>` in its title) or else the case holding its `path-title` key, built the
 * way the reporter builds it (`file#describe#…#title`, the file as Playwright titles it, forward slashes).
 */
export interface CodeTest {
  /** `file#describe#…#title`. */
  pathTitle: string;
  /** A case id the test names outright, if it does. */
  id?: string;
}

interface JsonSpec {
  title: string;
  tests?: { annotations?: { type: string; description?: string }[] }[];
}
interface JsonSuite {
  title: string;
  specs?: JsonSpec[];
  suites?: JsonSuite[];
}

const TOKEN = /@P([A-Za-z0-9_-]+)/;

/** The tests of a `--list --reporter=json` document, deduplicated (one per project would repeat a path). */
export function testsOfListing(listing: { suites?: JsonSuite[] }): CodeTest[] {
  const found = new Map<string, CodeTest>();
  const walk = (suite: JsonSuite, titles: string[]): void => {
    for (const spec of suite.specs ?? []) {
      const annotated = spec.tests
        ?.flatMap((t) => t.annotations ?? [])
        .find(
          (a) => a.type === 'PluneId' && a.description !== undefined && a.description !== '',
        )?.description;
      const id = annotated ?? TOKEN.exec(spec.title)?.[1];
      const pathTitle = [...titles, spec.title].join('#');
      if (!found.has(pathTitle))
        found.set(pathTitle, { pathTitle, ...(id === undefined ? {} : { id }) });
    }
    for (const child of suite.suites ?? []) walk(child, [...titles, child.title]);
  };
  // A top-level suite is a file: its title is the path relative to testDir, the reporter's `fileOf`.
  for (const file of listing.suites ?? []) walk(file, [file.title.replace(/\\/g, '/')]);
  return [...found.values()];
}

interface PlatformCase {
  id: string;
  title: string;
  type: string;
  state: string;
  externalKeys?: { kind: string; value: string }[];
}

export interface VerifyReport {
  matched: number;
  /** In the platform, not in the code. `detached` says whether the platform has already noticed. */
  onlyInPlatform: { id: string; title: string; state: string; detached: boolean }[];
  /** In the code, no case for it yet. */
  onlyInCode: { pathTitle: string }[];
}

/** Pure: the two sides set against each other. Retired (`deprecated`) cases are a person's decision and are left out. */
export function compare(code: CodeTest[], cases: PlatformCase[]): VerifyReport {
  const live = cases.filter((c) => c.type === 'automated' && c.state !== 'deprecated');
  const byPath = new Map<string, PlatformCase>();
  for (const c of live)
    for (const k of c.externalKeys ?? []) if (k.kind === 'path-title') byPath.set(k.value, c);
  const byId = new Map(live.map((c) => [c.id, c]));
  const seen = new Set<string>();
  const onlyInCode: VerifyReport['onlyInCode'] = [];
  for (const t of code) {
    const hit = (t.id === undefined ? undefined : byId.get(t.id)) ?? byPath.get(t.pathTitle);
    if (hit === undefined) onlyInCode.push({ pathTitle: t.pathTitle });
    else seen.add(hit.id);
  }
  return {
    matched: seen.size,
    onlyInPlatform: live
      .filter((c) => !seen.has(c.id))
      .map((c) => ({ id: c.id, title: c.title, state: c.state, detached: c.state === 'detached' })),
    onlyInCode,
  };
}

export interface VerifyDeps extends Omit<PlanGrepDeps, 'planId'> {
  /** A saved `playwright test --list --reporter=json` document, instead of running Playwright. */
  from?: string;
  /** Passed to `playwright test --config`. */
  playwrightConfig?: string;
  cwd?: string;
  /** Runs Playwright's listing; injected in tests. */
  list?: (args: string[], cwd: string) => string;
}

function runPlaywrightList(args: string[], cwd: string): string {
  try {
    return execFileSync('npx', ['playwright', 'test', ...args], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim();
    throw new SyncFileError(`could not list the Playwright tests${stderr ? `: ${stderr}` : ''}`);
  }
}

export async function handleVerify(deps: VerifyDeps): Promise<VerifyReport> {
  const get = platformGet(deps);
  let raw: string;
  if (deps.from !== undefined) {
    try {
      raw = readFileSync(deps.from, 'utf8');
    } catch {
      throw new SyncFileError(`cannot read ${deps.from}`);
    }
  } else {
    const args = [
      '--list',
      '--reporter=json',
      ...(deps.playwrightConfig === undefined ? [] : ['--config', deps.playwrightConfig]),
    ];
    raw = (deps.list ?? runPlaywrightList)(args, deps.cwd ?? process.cwd());
  }
  let listing: { suites?: JsonSuite[] };
  try {
    listing = JSON.parse(raw) as { suites?: JsonSuite[] };
  } catch {
    throw new SyncFileError('the Playwright listing is not JSON');
  }

  const cases: PlatformCase[] = [];
  let cursor: string | null = null;
  do {
    const page: { testCases: PlatformCase[]; nextCursor: string | null } = await get(
      `/v1/test-cases?type=automated&stability=0&limit=200${cursor === null ? '' : `&cursor=${cursor}`}`,
    );
    cases.push(...page.testCases);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return compare(testsOfListing(listing), cases);
}

/** The report as text: the two sides by name, then the count that matched. */
export function formatVerify(r: VerifyReport): string {
  const lines: string[] = [];
  if (r.onlyInPlatform.length > 0) {
    lines.push(`In Plune, not in the code (${r.onlyInPlatform.length}):`);
    for (const c of r.onlyInPlatform) {
      lines.push(
        `  ${c.id}  ${c.title}  [${c.detached ? 'already detached' : `${c.state} — a full run would detach it`}]`,
      );
    }
  }
  if (r.onlyInCode.length > 0) {
    lines.push(`In the code, not in Plune (${r.onlyInCode.length}):`);
    for (const t of r.onlyInCode) lines.push(`  ${t.pathTitle}`);
  }
  lines.push(
    r.onlyInPlatform.length + r.onlyInCode.length === 0
      ? `No drift: ${r.matched} case(s) match the code.`
      : `${r.matched} matched. Nothing was changed.`,
  );
  return lines.join('\n') + '\n';
}
