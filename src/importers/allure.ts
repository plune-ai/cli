/**
 * An `allure-results` folder → results (plune-ai/plune#1221).
 *
 * The folder is what every Allure adapter writes — pytest, JUnit 5, TestNG, Playwright, Cypress, Jest, Vitest,
 * WebdriverIO, .NET — so this one reader is all of them. A test is a `*-result.json`; a `*-container.json` is the
 * suite (a name for the group) and the fixtures around its tests; a file a test, a step or a fixture attached is
 * named by `source`, relative to the folder.
 *
 * Which files may be read is not decided here: every `source` goes through `resolveAttachment` of `attachments.ts`,
 * the check a JUnit report's `[[ATTACHMENT|path]]` goes through (outside the folder, a link, a folder, absent —
 * all refused the same way), and from there to the same upload path the Playwright reporter uses. What the
 * platform makes of the words (`passed`, `broken`, …) is its status map's, as for every other source.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { errorContextOf, failureOf, printable } from '../reporter-core/failure-detail.js';
import { resultKey } from '../reporter-core/result-key.js';
import type { DeclaredStep, FailedAttempt, PendingResult, ResultFile } from '../reporter-core/types.js';
import { MARKERS_PER_TEST, reportFolders, resolveAttachment, typeOfFile, type MissingAttachment } from './attachments.js';

const SOURCE = 'allure';

/** `@P<id>` anywhere in a name — the token JUnit and Playwright read too (ADR 0023). */
const TOKEN = /@P([A-Za-z0-9_-]+)/;

/** A folder we could not read as a report. Exit 2 — the user can fix it. */
export class AllureReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AllureReportError';
  }
}

/** As much of Allure's JSON as this reads. Everything optional: it is another tool's file. */
interface AllureAttachment {
  name?: string;
  source?: string;
  type?: string;
}
interface AllureStep {
  name?: string;
  status?: string;
  steps?: AllureStep[];
  attachments?: AllureAttachment[];
}
interface AllureResult extends AllureStep {
  uuid?: string;
  historyId?: string;
  fullName?: string;
  start?: number;
  stop?: number;
  statusDetails?: { message?: string; trace?: string };
  labels?: { name?: string; value?: string }[];
  parameters?: { name?: string; value?: string }[];
}
interface AllureContainer {
  uuid?: string;
  name?: string;
  children?: string[];
  befores?: AllureStep[];
  afters?: AllureStep[];
}

const RESULT = /-result\.json$/;
const CONTAINER = /-container\.json$/;

/** The largest JSON file read: a result is kilobytes, and a file of a gigabyte is not an Allure result. */
export const MAX_JSON_BYTES = 64 * 1024 * 1024;
/** Steps below this depth are not walked (one note per test): a hostile file must not overflow the stack. */
const MAX_DEPTH = 256;
/** The latest time `Date` can hold (ms). */
const MAX_TIME = 8.64e15;

/** Whether `path` is a folder — the shape of an `allure-results` report, which is the only one that is. */
export function isFolder(path: string): boolean {
  try {
    return fs.statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The regular files of `dir` that match: a link, a pipe or a device with such a name is not a result and is never opened. */
const namesIn = (dir: string, pattern: RegExp): string[] =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && pattern.test(d.name))
    .map((d) => d.name)
    .sort();

function load<T>(file: string, maxBytes: number): T {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch (err) {
    throw new AllureReportError(`${printable(file)} — cannot read — ${printable(err instanceof Error ? err.message : String(err))}`);
  }
  if (size > maxBytes) {
    throw new AllureReportError(`${printable(file)} — ${size} bytes, over the ${maxBytes} an Allure result may have; not read.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new AllureReportError(`${printable(file)} — not JSON — ${printable(err instanceof Error ? err.message : String(err))}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AllureReportError(`${printable(file)} — not an Allure result: expected a JSON object.`);
  }
  return parsed as T;
}

/** The objects of a list: anything else (a number, `null`, a list where an object belongs, a non-list) is nothing. */
function listOf<T>(v: unknown): T[] {
  const out: T[] = [];
  if (!Array.isArray(v)) return out;
  for (const x of v) if (typeof x === 'object' && x !== null && !Array.isArray(x)) out.push(x as T);
  return out;
}

/** A time that `Date` can hold, or nothing. */
const timeOf = (v: unknown): number | undefined => (typeof v === 'number' && Math.abs(v) <= MAX_TIME ? v : undefined);

const textOf = (v: unknown): string => (typeof v === 'string' ? v : '');
const labelOf = (r: AllureResult, name: string): string =>
  textOf(listOf<{ name?: string; value?: string }>(r.labels).find((l) => l.name === name)?.value);

/** The key: the pair a JUnit report of the same test has (`classname#name`) wherever the adapter's words allow. */
function keyOf(r: AllureResult, name: string): string {
  const full = textOf(r.fullName);
  // pytest: the name already carries the parameter ids (`test_x[a]`), as pytest's own report names it (`ids=` included).
  if (name.endsWith(']') && full.includes('#')) return `${full.split('#')[0]}#${name}`;
  let base: string;
  if (full.includes(' › ')) base = full.split(' › ').join('#'); // Playwright's own: file#describe#title
  else if (full.includes('#')) base = full; // pytest, Cypress, Jest, Vitest: already `where#what`
  else if (labelOf(r, 'package') !== '') base = `${labelOf(r, 'package')}#${name}`; // JUnit 5: class#method
  else base = full !== '' ? full : name;
  const params = listOf<{ value?: string }>(r.parameters).map((p) => textOf(p.value));
  // Two parameter sets of one test are two tests; a name that already carries them (pytest) is not asked twice.
  return params.length > 0 && !base.endsWith(']') ? `${base}[${params.join('-')}]` : base;
}

/** The suite chain the adapter labelled the test with, outermost first, no name twice in a row. */
function labelGroup(r: AllureResult): string[] {
  const out: string[] = [];
  for (const l of ['parentSuite', 'suite', 'subSuite']) {
    const v = labelOf(r, l);
    if (v !== '' && out.at(-1) !== v) out.push(v);
  }
  return out;
}

/** The attachments of `holder` and of every step below it, in the order written; true when a step lay below the depth limit. */
function attachmentsOf(holder: AllureStep, out: AllureAttachment[]): boolean {
  let deep = false;
  const todo: { h: AllureStep; depth: number }[] = [{ h: holder, depth: 0 }];
  while (todo.length > 0) {
    const { h, depth } = todo.pop() as { h: AllureStep; depth: number };
    for (const a of listOf<AllureAttachment>(h.attachments)) out.push(a);
    const steps = listOf<AllureStep>(h.steps);
    if (depth >= MAX_DEPTH) {
      deep ||= steps.length > 0;
      continue;
    }
    // Reversed, so the stack gives them back in the order written.
    for (let i = steps.length - 1; i >= 0; i--) todo.push({ h: steps[i] as AllureStep, depth: depth + 1 });
  }
  return deep;
}

const FAILED = new Set(['failed', 'broken']);
const declared = (steps: unknown, depth = 0): DeclaredStep[] =>
  depth >= MAX_DEPTH
    ? []
    : listOf<AllureStep>(steps).map((s) => ({ title: textOf(s.name), failed: FAILED.has(textOf(s.status)), steps: declared(s.steps, depth + 1) }));

interface Context {
  /** The folder as it really is, and as written: a report reached through a link names its files either way. */
  folder: string;
  lexical: string;
  missing: MissingAttachment[];
  notes: string[];
  /** The containers around a uuid, nearest first, through containers of containers. */
  around: (uuid: string) => AllureContainer[];
  /** The containers that list a uuid as a child themselves. */
  direct: Map<string, AllureContainer[]>;
}

/**
 * Read an `allure-results` folder. Throws `AllureReportError` — which names the folder or the file — when it holds
 * no result at all or one that is not JSON.
 *
 * What cannot be given (absent, not a file, outside the folder) is pushed to `missing`, and the test keeps its result.
 */
export function readAllure(
  dir: string,
  missing: MissingAttachment[] = [],
  notes: string[] = [],
  maxBytes: number = MAX_JSON_BYTES,
): PendingResult[] {
  if (!isFolder(dir)) throw new AllureReportError(`${printable(dir)} — not a folder.`);
  const resultNames = namesIn(dir, RESULT);
  if (resultNames.length === 0) {
    throw new AllureReportError(
      `${printable(dir)} — no *-result.json files in it, so there is no Allure report to read. ` +
        'Point at the folder an Allure adapter wrote (pytest --alluredir, allure-results), or at a JUnit or Playwright JSON file.',
    );
  }
  const { lexical, real: folder } = reportFolders(path.join(dir, '_'));
  const tests = resultNames.map((n) => load<AllureResult>(path.join(dir, n), maxBytes));
  const containers = namesIn(dir, CONTAINER).map((n) => load<AllureContainer>(path.join(dir, n), maxBytes));

  const direct = new Map<string, AllureContainer[]>();
  for (const c of containers) {
    for (const child of Array.isArray(c.children) ? c.children : []) {
      if (typeof child !== 'string') continue;
      const list = direct.get(child);
      if (list === undefined) direct.set(child, [c]);
      else list.push(c);
    }
  }

  const around = (uuid: string): AllureContainer[] => {
    const seen = new Set<AllureContainer>();
    const todo = [uuid];
    while (todo.length > 0) {
      for (const c of direct.get(todo.pop() as string) ?? []) {
        if (seen.has(c)) continue;
        seen.add(c);
        if (typeof c.uuid === 'string') todo.push(c.uuid);
      }
    }
    return [...seen];
  };
  const ctx: Context = { folder, lexical, missing, notes, around, direct };

  // Attempts of one test: same historyId. A result without one stands alone.
  const groups = new Map<string, AllureResult[]>();
  tests.forEach((r, i) => {
    const id = textOf(r.historyId);
    const g = id === '' ? `\u0000${i}` : id;
    const list = groups.get(g);
    if (list === undefined) groups.set(g, [r]);
    else list.push(r);
  });

  const out: PendingResult[] = [];
  for (const attempts of groups.values()) {
    // Oldest first, so the last attempt (the one that stopped last) has the highest retry: the one that counts. A tie
    // goes by start, then uuid: the same answer whatever order the folder lists its files in.
    const ordered = attempts
      .map((r, i) => ({ r, i }))
      .sort(
        (a, b) =>
          stopOf(a.r) - stopOf(b.r) ||
          (timeOf(a.r.start) ?? 0) - (timeOf(b.r.start) ?? 0) ||
          compareText(textOf(a.r.uuid), textOf(b.r.uuid)) ||
          a.i - b.i,
      )
      .map((x) => x.r);
    ordered.forEach((r, retry) => out.push(pendingOf(r, retry, ctx)));
  }
  return out;
}

const stopOf = (r: AllureResult): number => timeOf(r.stop) ?? timeOf(r.start) ?? 0;
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function pendingOf(r: AllureResult, retry: number, ctx: Context): PendingResult {
  const name = textOf(r.name);
  const uuid = textOf(r.uuid);
  const key = keyOf(r, name);
  const ancestors = uuid === '' ? [] : ctx.around(uuid);

  // The group: the suite container that holds the test, not the one made for the test alone (JUnit 5 writes both).
  const suite = (uuid === '' ? [] : (ctx.direct.get(uuid) ?? []))
    .filter((c) => textOf(c.name) !== '' && c.name !== name)
    .sort((a, b) => (Array.isArray(b.children) ? b.children.length : 0) - (Array.isArray(a.children) ? a.children.length : 0))[0];
  const group = suite !== undefined ? [textOf(suite.name)] : labelGroup(r);
  const title = [...group, name].join(' › ');
  const safeTitle = printable(title);
  const rkey = resultKey(key, retry);

  const files: ResultFile[] = [];
  const announced = new Set<string>();
  const ignored = new Set<string>();
  const announce = (att: AllureAttachment): void => {
    const source = textOf(att.source);
    if (source === '' || announced.has(source) || ignored.has(source)) return;
    // The same ceiling a JUnit test has: the rest is counted and said once.
    if (announced.size >= MARKERS_PER_TEST) {
      ignored.add(source);
      return;
    }
    announced.add(source);
    const found = resolveAttachment(ctx.folder, source, ctx.lexical);
    if (!('file' in found)) {
      ctx.missing.push({ title: safeTitle, resultKey: rkey, path: source });
      return;
    }
    if (files.some((f) => f.path === found.file)) return; // two names for one file are one file
    const type = textOf(att.type).trim();
    // The name is the adapter's («after add»): what a person reads on the run page. The core gives it the extension
    // of the real file when it has none (`total` -> `total.txt`), so the panel shows a name and the right kind.
    const name = printable(textOf(att.name) !== '' ? textOf(att.name) : path.basename(found.file));
    files.push({ name, contentType: type !== '' ? type : typeOfFile(found.file), path: found.file });
  };

  // Chronological: the fixtures that ran before (outermost first), the test with its steps, the fixtures after.
  const holders: AllureStep[] = [];
  for (const c of [...ancestors].reverse()) for (const h of listOf<AllureStep>(c.befores)) holders.push(h);
  holders.push(r);
  for (const c of ancestors) for (const h of listOf<AllureStep>(c.afters)) holders.push(h);
  const atts: AllureAttachment[] = [];
  let deep = false;
  for (const h of holders) deep = attachmentsOf(h, atts) || deep;
  atts.forEach(announce);
  if (ignored.size > 0) {
    ctx.notes.push(`plune: ${JSON.stringify(safeTitle)}: ${ignored.size} more markers ignored (at most ${MARKERS_PER_TEST} per test)`);
  }
  if (deep) ctx.notes.push(`plune: ${JSON.stringify(safeTitle)}: steps nested deeper than ${MAX_DEPTH} are ignored`);

  const status = textOf(r.status) !== '' ? textOf(r.status) : 'unknown';
  const details: { message?: string; trace?: string } =
    typeof r.statusDetails === 'object' && r.statusDetails !== null ? r.statusDetails : {};
  const message = textOf(details.message);
  const trace = textOf(details.trace);
  const attempt: FailedAttempt = {
    status,
    errors: [{ text: [message, trace].filter((s) => s !== '').join('\n\n') }],
    steps: declared(r.steps),
    attachments: files.map(({ name: n, contentType, path: p }) => ({
      name: n,
      ...(contentType !== undefined ? { contentType } : {}),
      ...(p !== undefined ? { path: p } : {}),
    })),
    testFile: '',
  };
  const errorContext = errorContextOf(attempt);
  const failure = FAILED.has(status) ? failureOf(attempt) : undefined;

  const pkg = labelOf(r, 'package');
  // The key of Vitest, Jest and Cypress starts with the runner (`vt:test/cart.test.js`); the place is the path.
  const where = (key.includes('#') ? key.split('#')[0] : pkg)?.replace(/^[A-Za-z][A-Za-z0-9_-]+:(?![\\/])/, '');
  const stated = TOKEN.exec(name)?.[1];
  const started = timeOf(r.start);
  const stopped = timeOf(r.stop);
  const durationMs = started !== undefined && stopped !== undefined ? Math.max(0, stopped - started) : 0;

  return {
    resultKey: rkey,
    ...(stated !== undefined ? { testCaseId: stated } : {}),
    keys: [{ kind: 'path-title', value: key }],
    source: SOURCE,
    rawStatus: status,
    title,
    ...(where !== undefined && where !== '' ? { specRef: where } : {}),
    ...(started !== undefined
      ? {
          execution: {
            startedAt: new Date(started).toISOString(),
            finishedAt: new Date(started + durationMs).toISOString(),
            durationMs,
            retry,
          },
        }
      : {}),
    ...(errorContext !== '' ? { errorContext } : {}),
    ...(failure !== undefined ? { failure } : {}),
    ...(files.length > 0 ? { files } : {}),
  };
}
