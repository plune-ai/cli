import { existsSync } from 'node:fs';
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
export function failureOf(attempt: FailedAttempt): FailureDetail | undefined {
  const error = chosen(attempt);
  const headline = error === undefined ? undefined : firstLine(error.text);
  const steps = chainOf(attempt.steps);
  const location = error === undefined ? undefined : fromRoot(placeOf(error, attempt.testFile), attempt.repoRoot);
  const artifacts = attempt.attachments
    .filter((a) => a.path !== undefined && a.name !== '' && !a.name.startsWith('_') && a.contentType !== METADATA_TYPE)
    .map(({ name, contentType }) => (contentType === undefined ? { name } : { name, contentType }));
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

/** The content type a test hands the reporter its metadata in (platform ADR 0023) — not an artifact. */
const METADATA_TYPE = 'application/plune.metadata+json';

/** What the platform takes as a file from the repository root; anything else would refuse the batch. */
const REPO_RELATIVE = /^(?![A-Za-z][A-Za-z0-9+.-]*:)(?![\\/~])(?!(?:.*[\\/])?\.\.(?:[\\/]|$)).+$/;

/** A stack frame as V8 writes it: `at fn (file:line:col)` or `at file:line:col`. */
const FRAME = /^\s+at (?:.*? \()?(.+?):(\d+):(\d+)\)?$/;

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

/** The first frame in the test's own file — a helper's line is not where the test failed — else the runner's place. */
function placeOf(error: AttemptError, testFile: string): RunnerLocation | undefined {
  const own = normal(testFile);
  for (const line of stripVTControlCharacters(error.text).split('\n')) {
    const frame = FRAME.exec(line);
    if (frame !== null && normal(fileOf(frame[1]!)) === own) return { file: fileOf(frame[1]!), line: Number(frame[2]), column: Number(frame[3]) };
  }
  return error.location;
}

/** `file:///D:/repo/x.ts` or `file:///repo/x.ts` — read the same on every OS, unlike `fileURLToPath`. */
function fileOf(raw: string): string {
  if (!raw.startsWith('file://')) return raw;
  const path = decodeURIComponent(raw.slice('file://'.length));
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

/** A link only for an address a browser opens as a page — never `file:`, `javascript:` or half a URL. */
function webLink(href: string | undefined): string | undefined {
  if (href === undefined) return undefined;
  try {
    const { protocol } = new URL(href);
    return protocol === 'http:' || protocol === 'https:' ? href : undefined;
  } catch {
    return undefined;
  }
}
