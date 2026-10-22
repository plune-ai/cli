import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadSources, type CodeTest, type PlatformCase, type VerifyDeps } from './verify.js';
import { SyncFileError } from './sync.js';

/**
 * `plune ids` (plune-ai/plune#1291, AC-01/AC-05): writes the Plune case id of each Playwright test that does not
 * name one into a mapfile, `plune/ids.json` — `{ "<path-title>": "<case id>" }` — instead of editing the test
 * sources. A test is covered when it already names an id (`PluneId` annotation, `@P<id>`) or already has an entry.
 * Only tests whose case the platform already holds get an entry; a test with no case yet is listed and left alone
 * (the platform creates the case on the first run). Entries are only ever added: one for a test the code no longer
 * has is kept and reported. Dry run unless `write` is set; the file is sorted, so diffs stay small.
 *
 * The mapfile is storage only: the reporter does not read it yet (a resolution rung after the annotation and
 * `@P<id>`, before `path-title`, is a separate change).
 */
export const DEFAULT_IDS_FILE = 'plune/ids.json';

export interface IdsDeps extends VerifyDeps {
  /** Mapfile path; `plune/ids.json` by default. */
  file?: string;
  write?: boolean;
}

export interface IdsReport {
  file: string;
  /** Entries this run adds (or would add), by path-title. */
  added: Record<string, string>;
  /** Tests already covered: they name an id, or the file has their entry. */
  covered: number;
  /** Tests with no case in the platform: nothing to write. */
  noCase: string[];
  /** Entries whose test is no longer in the code; kept. */
  orphaned: string[];
  written: boolean;
}

export function readMap(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new SyncFileError(`${file} is not valid JSON; fix or remove it, nothing was written`);
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.values(parsed).some((v) => typeof v !== 'string' || v === '')
  )
    throw new SyncFileError(
      `${file} must be an object of path-title to case id strings; nothing was written`,
    );
  return parsed as Record<string, string>;
}

// Code-unit order, not locale: the same file on every machine.
const compareKeys = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Pure: what the map gains, given the code, the cases and the map as it is. */
export function planIds(
  code: CodeTest[],
  cases: PlatformCase[],
  current: Record<string, string>,
): Omit<IdsReport, 'file' | 'written'> {
  const byPath = new Map<string, PlatformCase>();
  for (const c of cases)
    if (c.type === 'automated' && c.state !== 'deprecated')
      for (const k of c.externalKeys ?? []) if (k.kind === 'path-title') byPath.set(k.value, c);
  const added: Record<string, string> = {};
  const noCase: string[] = [];
  let covered = 0;
  for (const t of code) {
    if (t.id !== undefined || current[t.pathTitle] !== undefined) covered++;
    else {
      const hit = byPath.get(t.pathTitle);
      if (hit === undefined) noCase.push(t.pathTitle);
      else added[t.pathTitle] = hit.id;
    }
  }
  const inCode = new Set(code.map((t) => t.pathTitle));
  return {
    added,
    covered,
    noCase: noCase.sort(compareKeys),
    orphaned: Object.keys(current)
      .filter((k) => !inCode.has(k))
      .sort(compareKeys),
  };
}

export function serializeMap(map: Record<string, string>): string {
  const sorted: Record<string, string> = {};
  for (const k of Object.keys(map).sort(compareKeys)) sorted[k] = map[k] as string;
  return JSON.stringify(sorted, null, 2) + '\n';
}

export async function handleIds(deps: IdsDeps): Promise<IdsReport> {
  const file = deps.file ?? DEFAULT_IDS_FILE;
  const current = readMap(file); // a broken file stops here, before anything is asked of the platform
  const { code, cases } = await loadSources(deps);
  const plan = planIds(code, cases, current);
  let written = false;
  if (deps.write === true && Object.keys(plan.added).length > 0) {
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, serializeMap({ ...current, ...plan.added }));
    } catch {
      throw new SyncFileError(`cannot write ${file}`);
    }
    written = true;
  }
  return { file, ...plan, written };
}

export function formatIds(r: IdsReport, write: boolean): string {
  const n = Object.keys(r.added).length;
  const lines: string[] = [];
  if (n > 0) {
    lines.push(`${write ? 'Added to' : 'Would add to'} ${r.file} (${n}):`);
    for (const k of Object.keys(r.added).sort(compareKeys)) lines.push(`  ${k}  ->  ${r.added[k]}`);
  }
  if (r.noCase.length > 0) {
    lines.push(`In the code, no case in Plune yet, nothing to write (${r.noCase.length}):`);
    for (const k of r.noCase) lines.push(`  ${k}`);
  }
  if (r.orphaned.length > 0) {
    lines.push(`In ${r.file}, test no longer in the code, kept (${r.orphaned.length}):`);
    for (const k of r.orphaned) lines.push(`  ${k}`);
  }
  lines.push(
    n === 0
      ? `Nothing to write: ${r.covered} test(s) already have an id.`
      : write
        ? `${r.covered} already had an id. ${r.file} written.`
        : `${r.covered} already had an id. Dry run: nothing was written; add --write.`,
  );
  return lines.join('\n') + '\n';
}
