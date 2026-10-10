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
import { reportFolders, resolveAttachment, typeOfFile, type MissingAttachment } from './attachments.js';

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

const isDirectory = (dir: string): boolean => {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
};

const namesIn = (dir: string, pattern: RegExp): string[] => fs.readdirSync(dir).filter((n) => pattern.test(n)).sort();

/** Whether `dir` is a folder with at least one `*-result.json` in it. Read by the format detector. */
export function looksLikeAllureDir(dir: string): boolean {
  try {
    return isDirectory(dir) && namesIn(dir, RESULT).length > 0;
  } catch {
    return false;
  }
}

function load<T>(file: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new AllureReportError(`${file} — not JSON — ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AllureReportError(`${file} — not an Allure result: expected a JSON object.`);
  }
  return parsed as T;
}

const textOf = (v: unknown): string => (typeof v === 'string' ? v : '');
const labelOf = (r: AllureResult, name: string): string => textOf(r.labels?.find((l) => l.name === name)?.value);

/** The key: the pair a JUnit report of the same test has (`classname#name`) wherever the adapter's words allow. */
function keyOf(r: AllureResult, name: string): string {
  const full = textOf(r.fullName);
  let base: string;
  if (full.includes(' › ')) base = full.split(' › ').join('#'); // Playwright's own: file#describe#title
  else if (full.includes('#')) base = full; // pytest, Cypress, Jest, Vitest: already `where#what`
  else if (labelOf(r, 'package') !== '') base = `${labelOf(r, 'package')}#${name}`; // JUnit 5: class#method
  else base = full !== '' ? full : name;
  const params = (r.parameters ?? []).map((p) => textOf(p.value));
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

/** The attachments of `holder` and of every step below it, in the order written. */
function attachmentsOf(holder: AllureStep, out: AllureAttachment[]): void {
  out.push(...(holder.attachments ?? []));
  for (const s of holder.steps ?? []) attachmentsOf(s, out);
}

const FAILED = new Set(['failed', 'broken']);
const declared = (steps: AllureStep[] | undefined): DeclaredStep[] =>
  (steps ?? []).map((s) => ({ title: textOf(s.name), failed: FAILED.has(textOf(s.status)), steps: declared(s.steps) }));

interface Context {
  /** The folder as it really is, and as written: a report reached through a link names its files either way. */
  folder: string;
  lexical: string;
  missing: MissingAttachment[];
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
export function readAllure(dir: string, missing: MissingAttachment[] = []): PendingResult[] {
  if (!isDirectory(dir)) throw new AllureReportError(`${dir} — not a folder.`);
  const resultNames = namesIn(dir, RESULT);
  if (resultNames.length === 0) {
    throw new AllureReportError(
      `${dir} — no *-result.json files in it, so there is no Allure report to read. ` +
        'Point at the folder an Allure adapter wrote (pytest --alluredir, allure-results), or at a JUnit or Playwright JSON file.',
    );
  }
  const { lexical, real: folder } = reportFolders(path.join(dir, '_'));
  const tests = resultNames.map((n) => load<AllureResult>(path.join(dir, n)));
  const containers = namesIn(dir, CONTAINER).map((n) => load<AllureContainer>(path.join(dir, n)));

  const direct = new Map<string, AllureContainer[]>();
  for (const c of containers) for (const child of c.children ?? []) direct.set(child, [...(direct.get(child) ?? []), c]);

  const around = (uuid: string): AllureContainer[] => {
    const seen = new Set<AllureContainer>();
    const walk = (id: string): void => {
      for (const c of direct.get(id) ?? []) {
        if (seen.has(c)) continue;
        seen.add(c);
        if (c.uuid !== undefined) walk(c.uuid);
      }
    };
    walk(uuid);
    return [...seen];
  };
  const ctx: Context = { folder, lexical, missing, around, direct };

  // Attempts of one test: same historyId. A result without one stands alone.
  const groups = new Map<string, AllureResult[]>();
  tests.forEach((r, i) => {
    const id = textOf(r.historyId);
    const g = id === '' ? `\u0000${i}` : id;
    groups.set(g, [...(groups.get(g) ?? []), r]);
  });

  const out: PendingResult[] = [];
  for (const attempts of groups.values()) {
    // Oldest first, so the last attempt (the one that stopped last) has the highest retry: the one that counts.
    const ordered = attempts
      .map((r, i) => ({ r, i }))
      .sort((a, b) => (a.r.stop ?? a.r.start ?? 0) - (b.r.stop ?? b.r.start ?? 0) || a.i - b.i)
      .map((x) => x.r);
    ordered.forEach((r, retry) => out.push(pendingOf(r, retry, ctx)));
  }
  return out;
}

function pendingOf(r: AllureResult, retry: number, ctx: Context): PendingResult {
  const name = textOf(r.name);
  const uuid = textOf(r.uuid);
  const key = keyOf(r, name);
  const ancestors = uuid === '' ? [] : ctx.around(uuid);

  // The group: the suite container that holds the test, not the one made for the test alone (JUnit 5 writes both).
  const suite = (uuid === '' ? [] : (ctx.direct.get(uuid) ?? []))
    .filter((c) => textOf(c.name) !== '' && c.name !== name)
    .sort((a, b) => (b.children?.length ?? 0) - (a.children?.length ?? 0))[0];
  const group = suite !== undefined ? [textOf(suite.name)] : labelGroup(r);
  const title = [...group, name].join(' › ');
  const safeTitle = printable(title);
  const rkey = resultKey(key, retry);

  const files: ResultFile[] = [];
  const announced = new Set<string>();
  const announce = (att: AllureAttachment): void => {
    const source = textOf(att.source);
    if (source === '' || announced.has(source)) return;
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
  for (const c of [...ancestors].reverse()) holders.push(...(c.befores ?? []));
  holders.push(r);
  for (const c of ancestors) holders.push(...(c.afters ?? []));
  const atts: AllureAttachment[] = [];
  for (const h of holders) attachmentsOf(h, atts);
  atts.forEach(announce);

  const status = textOf(r.status) !== '' ? textOf(r.status) : 'unknown';
  const message = textOf(r.statusDetails?.message);
  const trace = textOf(r.statusDetails?.trace);
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
  const where = key.includes('#') ? key.split('#')[0] : pkg;
  const stated = TOKEN.exec(name)?.[1];
  const started = typeof r.start === 'number' && Number.isFinite(r.start) ? r.start : undefined;
  const stopped = typeof r.stop === 'number' && Number.isFinite(r.stop) ? r.stop : undefined;
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
