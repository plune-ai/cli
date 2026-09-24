import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { AttemptError, DeclaredStep, FailedAttempt, FailureDetail, RunnerLocation } from './types.js';

/**
 * The failure detail of one attempt (#790, ADR-0001 of the feature): what failed, the declared steps
 * down to it, where, what the runner kept, and the CI run — derived from the attempt both roads
 * reduce their data to, so `plune run import` and the adapter cannot disagree about it.
 *
 * Pure: the repository root is found once by the caller (`repoRootOf`) and handed in. Nothing is cut
 * and nothing is searched for credentials — the platform does both after its own cleaning, and a cut
 * here could halve a credential it would then not recognise.
 */
export function failureOf(attempt: FailedAttempt, home: string = homedir()): FailureDetail | undefined {
  const error = chosen(attempt);
  // Rewritten as the text is; past `HEADLINE_LIMIT` left out whole, never cut (ADR-0001).
  const line = error === undefined ? undefined : firstLine(machineless(error.text, attempt.repoRoot, home));
  const headline = line !== undefined && jsonBytes(line) <= HEADLINE_LIMIT ? line : undefined;
  const steps = chainOf(attempt.steps);
  const location = error === undefined ? undefined : fromRoot(placeOf(error, attempt.testFile), attempt.repoRoot);
  // An empty type is no type: the platform refuses one, and the whole batch with it.
  const artifacts = attempt.attachments
    .filter((a) => a.path !== undefined && !a.name.startsWith('_') && a.contentType !== METADATA_TYPE)
    .map(({ name, contentType }) => ({ name: fileNameOf(name), ...(contentType ? { contentType } : {}) }))
    .filter((a) => a.name !== '');
  const ciUrl = webLink(attempt.buildHref);

  const failure: FailureDetail = {
    ...(headline !== undefined ? { headline } : {}),
    ...(steps.length > 0 ? { steps } : {}),
    ...(location !== undefined ? { location } : {}),
    ...(artifacts.length > 0 ? { artifacts } : {}),
    ...(ciUrl !== undefined ? { ciUrl } : {}),
  };
  return Object.keys(failure).length === 0 ? undefined : failure;
}

/**
 * The nearest folder with a `.git` above the runner's root dir — a folder, or the file a worktree
 * keeps instead. Found once per run by the caller; `stopAt` bounds the walk for a test.
 */
export function repoRootOf(dir: string, stopAt?: string): string | undefined {
  for (let here = resolve(dir); ; here = dirname(here)) {
    if (existsSync(join(here, '.git'))) return here;
    if (here === stopAt || dirname(here) === here) return undefined;
  }
}

/**
 * `errorContext` for one attempt: every error in order, colour codes gone, the repository as relative
 * paths and a home folder as `~` — any home folder when the root is unknown, since the report may come
 * from another machine — and no longer than the CLI's transport limit, cut by whole lines. Nothing is
 * searched for credentials: the platform does that before its own cut (ADR-0005).
 */
export function errorContextOf(attempt: FailedAttempt, home: string = homedir()): string {
  const text = attempt.errors
    .map((e) => e.text)
    .filter((t) => t !== '')
    .join('\n\n');
  return cut(machineless(text, attempt.repoRoot, home));
}

/**
 * A text without this machine in it: colour codes gone, the repository as relative paths and a home
 * folder as `~` — any home folder when the root is unknown. The headline and the text both go through
 * here, so neither can name a folder the other hides (#790 AC-05).
 */
function machineless(raw: string, repoRoot: string | undefined, home: string): string {
  let text = stripVTControlCharacters(raw).replaceAll('\u001b', '');
  const root = repoRoot === undefined ? undefined : pathIn(repoRoot);
  if (root !== undefined) text = text.replace(new RegExp(`${PATH_START}${root.source}[\\\\/]+`, root.flags), '');
  const own = pathIn(home);
  if (own !== undefined) text = text.replace(new RegExp(`${PATH_START}${own.source}(?![\\w.-])`, own.flags), '~');
  if (repoRoot === undefined) text = text.replace(ANY_HOME, '~');
  return text;
}

/**
 * Where a path may start: not glued to a word, a path or an address — a root of one segment is a word
 * an address holds too (`http://localhost:3000/app/login` for a root `/app`).
 */
// ponytail: a route in a line of code (`'/app/login'` for a root `/app`) still reads as a path; telling
// the two apart needs the disk (`existsSync` of root + the rest), not a pattern.
const PATH_START = '(?<![\\w.~%/\\\\-])';

/**
 * The CLI's own transport limit for one text (ADR-0006) — not a copy of the platform's 256 KB — in the
 * bytes the text weighs in a batch, which is packed by its JSON (#790 review G1).
 */
const TEXT_LIMIT = 524_288;

/**
 * The longest headline sent, in the bytes it weighs in a batch. The platform keeps 300 characters of it
 * after its own cleaning, and a credential straddling that point is a few KB at most; and with a text at
 * `TEXT_LIMIT`, a result has ~34 KB left for everything else if 100 of them are to fit 7 batches of
 * 8 MiB — 10 calls. A longer first line still travels in the text, which the dashboard shows instead.
 */
const HEADLINE_LIMIT = 8 * 1024;

/** What a text weighs inside a batch: JSON writes a quote, a backslash or a control character in two bytes or more. */
const jsonBytes = (text: string): number => Buffer.byteLength(JSON.stringify(text)) - 2;

/**
 * A home folder opening a path in a text: `/home/<u>`, `/Users/<u>`, `C:\Users\<u>` — with the
 * backslashes doubled too, as a diff prints a string — a file URL too.
 */
// ponytail: a user name with a space is cut at the space; the machine's own home is matched exactly.
const ANY_HOME = /(?<=^|[\s'"`(=,[])(?:file:\/\/\/?)?(?:\/home\/|\/Users\/|[A-Za-z]:[\\/]+Users[\\/]+)[^\\/\s'"`:*?<>|]+/g;

/**
 * `path` as a text may spell it: either slash, doubled as a printed string doubles a backslash, as a
 * file URL, and on Windows in any case. Nothing for `/` or a bare drive — they would match every path.
 */
function pathIn(path: string): RegExp | undefined {
  const parts = path.split(/[\\/]+/);
  while (parts.length > 1 && parts.at(-1) === '') parts.pop();
  if (!parts.some((part) => part !== '' && !/^[A-Za-z]:$/.test(part))) return undefined;
  const escaped = parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\\\/]+');
  return new RegExp(`(?:file:\\/\\/\\/?)?${escaped}`, /^[A-Za-z]:$/.test(parts[0]!) ? 'gi' : 'g');
}

/** An attachment named by its path — `testInfo.attach(file, { path: file })` — by the file alone. */
const fileNameOf = (name: string): string =>
  /^(?:file:\/\/|[\\/]|~[\\/]|[A-Za-z]:[\\/])/.test(name) ? (name.split(/[\\/]/).pop() ?? '') : name;

/**
 * At most `TEXT_LIMIT` bytes as a batch carries it, by whole lines: lines from the head, then from the
 * tail, and one `…[omitted N lines]…` where the rest were. A line longer than the limit goes whole, so
 * no part of a one-line credential can show; the lines left out never leave the machine.
 */
function cut(text: string): string {
  if (jsonBytes(text) <= TEXT_LIMIT) return text;
  const lines = text.split('\n');
  // A line and the `\n` after it, which JSON writes in two bytes; the marker's separator is one of them.
  const size = lines.map((line) => jsonBytes(line) + 2);
  const budget = TEXT_LIMIT - jsonBytes(omitted(lines.length));
  let used = 0;
  let head = 0;
  let tail = lines.length;
  while (head < tail && used + size[head]! <= budget / 2) used += size[head++]!;
  while (tail > head && used + size[tail - 1]! <= budget) used += size[--tail]!;
  return [...lines.slice(0, head), omitted(tail - head), ...lines.slice(tail)].join('\n');
}

const omitted = (lines: number): string => `…[omitted ${lines} lines]…`;

/** The content type a test hands the reporter its metadata in (platform ADR 0023) — not an artifact. */
const METADATA_TYPE = 'application/plune.metadata+json';

/** What the platform takes as a file from the repository root; anything else would refuse the batch. */
const REPO_RELATIVE = /^(?![A-Za-z][A-Za-z0-9+.-]*:)(?![\\/~])(?!(?:.*[\\/])?\.\.(?:[\\/]|$)).+$/;

/** A stack frame as V8 writes it: `at fn (file:line:col)` or `at file:line:col`. */
const FRAME = /^\s+at (?:.*? \()?(.+?):(\d+):(\d+)\)?$/;
const FRAME_MAX = 8192;

const firstLine = (text: string): string | undefined =>
  stripVTControlCharacters(text)
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '');

/**
 * The error the headline and the place come from: the first — except on a test timeout, where the
 * timeout's own error says only that time ran out, and the action that was still waiting follows it.
 */
function chosen({ status, errors }: FailedAttempt): AttemptError | undefined {
  if (status === 'timedOut') {
    const timeout = errors.findIndex((e) => firstLine(e.text)?.startsWith('Test timeout of ') === true);
    if (timeout !== -1 && timeout + 1 < errors.length) return errors[timeout + 1];
  }
  return errors[0];
}

/** From the outermost declared step to the one that failed; where two failed side by side, the first. */
function chainOf(steps: DeclaredStep[]): string[] {
  const chain: string[] = [];
  for (let failed = steps.find((s) => s.failed); failed !== undefined; failed = failed.steps.find((s) => s.failed)) {
    chain.push(failed.title);
  }
  return chain;
}

/**
 * The first frame in the test's own file — a helper's line is not where the test failed — else where
 * it was thrown: the runner's place, or the first frame outside `node_modules` as Playwright takes it
 * when the error has none, so a raw error and the report's formatted one land on the same line.
 */
function placeOf(error: AttemptError, testFile: string): RunnerLocation | undefined {
  const own = normal(testFile);
  let first: RunnerLocation | undefined;
  for (const line of stripVTControlCharacters(error.text).split('\n')) {
    // ponytail: past PATH_MAX plus a function name a line is no frame, and on it `FRAME` retries from
    // every " (" — quadratic. Below the cap it still is: ~5 ms for the worst 8 191 characters.
    if (line.length > FRAME_MAX) continue;
    const frame = FRAME.exec(line);
    if (frame === null) continue;
    const place = { file: fileOf(frame[1]!), line: Number(frame[2]), column: Number(frame[3]) };
    if (normal(place.file) === own) return place;
    if (first === undefined && !normal(place.file).includes('/node_modules/')) first = place;
  }
  return error.location ?? first;
}

/** `file:///D:/repo/x.ts` or `file:///repo/x.ts` — read the same on every OS, unlike `fileURLToPath`. */
function fileOf(raw: string): string {
  if (!raw.startsWith('file://')) return raw;
  let path = raw.slice('file://'.length);
  try {
    path = decodeURIComponent(path);
  } catch {
    // A broken escape: kept as written, rather than ending the whole report on a `URIError`.
  }
  return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
}

/** One spelling of a path from any OS: forward slashes, no `.` or `..`, an upper-case drive letter. */
const normal = (path: string): string =>
  posix.normalize(path.replace(/\\/g, '/')).replace(/^([a-z]):/, (_, drive: string) => `${drive.toUpperCase()}:`);

/** The place from the repository root, or nothing: an unknown root, a file outside it, a line below 1. */
function fromRoot(place: RunnerLocation | undefined, root: string | undefined): FailureDetail['location'] {
  if (place === undefined || root === undefined || !Number.isInteger(place.line) || place.line < 1) return undefined;
  const base = normal(root).replace(/\/+$/, '');
  const file = normal(place.file);
  if (!file.startsWith(`${base}/`)) return undefined;
  const relative = file.slice(base.length + 1);
  if (!REPO_RELATIVE.test(relative)) return undefined;
  const column = place.column !== undefined && Number.isInteger(place.column) && place.column >= 1 ? place.column : undefined;
  return column === undefined ? { file: relative, line: place.line } : { file: relative, line: place.line, column };
}

/**
 * A link only for an address a browser opens as a page — never `file:`, `javascript:` or half a URL.
 * As the platform checks it: `new URL` alone mends `https:/host` and `https:host` into https, and a
 * link the platform refuses costs the run's start or the whole batch.
 */
export function webLink(href: string | undefined): string | undefined {
  return href !== undefined && /^https?:\/\//i.test(href) && URL.canParse(href) ? href : undefined;
}
