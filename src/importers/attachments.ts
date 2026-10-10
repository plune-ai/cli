/**
 * The files a JUnit report points at (plune-ai/plune#1220).
 *
 * The format has no field for a file. Jenkins' JUnit Attachments plugin and GitLab settled on a line of
 * the test's own output — `[[ATTACHMENT|path]]` in `system-out` or `system-err` — and pytest, Surefire,
 * Vitest, PHPUnit, .NET's logger and Cypress's reporter all carry a test's output into its `testcase`.
 * This file reads that line and hands the files to the same upload path the Playwright reporter uses
 * (`PendingResult.files`); where they go — a bucket, the platform's own route, a skip — is the core's.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { printable } from '../reporter-core/failure-detail.js';
import type { ResultFile } from '../reporter-core/types.js';
import type { XmlElement } from './xml.js';

/** A marker on a line of its own: other text on the line means somebody quoted it, not announced a file. */
const MARKER = /^[ \t]*\[\[ATTACHMENT\|([^\r\n]*?)\]\][ \t]*$/gm;

/**
 * A file a test announced and this machine cannot give: absent, not a file, or outside the report's folder.
 * Collected in one list for the whole report, so the day the platform can keep «not there at import» as a
 * state of its own, sending it is one change at the one place that reads this list.
 */
export interface MissingAttachment {
  /** The test, as the review queue would name it. */
  title: string;
  /** The key of the result the file belonged to: what a «not found at import» marker on the platform is sent against. */
  resultKey?: string;
  /** The path as the report wrote it. */
  path: string;
}

/**
 * The media types by extension. No allow-list: an extension not here is an `application/octet-stream`, which
 * the core treats as any other file (a bucket takes it). The images and the two text types are the ones
 * Playwright's own attachments name, which is what the core's limits are written for.
 */
const TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.md': 'text/plain',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.xml': 'application/xml',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.har': 'application/json',
};

export const typeOfFile = (file: string): string => TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';

/** The real folder of the report: what a path must stay inside after every link has been followed. */
export function reportFolder(report: string): string {
  const folder = path.dirname(path.resolve(report));
  try {
    return fs.realpathSync(folder);
  } catch {
    return folder;
  }
}

/** The folder of the report as written and as it really is: the first judges a path's face, the second where it lands. */
export function reportFolders(report: string): { lexical: string; real: string } {
  return { lexical: path.dirname(path.resolve(report)), real: reportFolder(report) };
}

/** At most this many markers of a test are read; the rest are counted and said once. */
export const MARKERS_PER_TEST = 100;

/** Whether `target` is `folder` or lies below it. */
function within(folder: string, target: string): boolean {
  const rel = path.relative(folder, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** Why a marker's path gives no file: `outside` the report's folder (by its face or after links), `absent`, or `not-a-file`. */
export type NotFoundWhy = 'outside' | 'absent' | 'not-a-file';

/**
 * The whole check of one marker path (the same for every format that carries one): the real file it names
 * inside the report's folder, or why it is "not found". `folder` is the report's real folder, `lexical` it
 * as written (default: the same).
 */
export function resolveAttachment(folder: string, ref: string, lexical: string = folder): { file: string } | { why: NotFoundWhy } {
  // Judged on its face first, with no I/O: opening `\\host\share\x` makes a Windows machine talk SMB (and hand
  // over an NTLM hash) and `\\.\pipe\x` opens a pipe. A UNC or device path, another drive and `..` fail here.
  if (/^[\\/]{2}/.test(ref) || ref.includes('\0')) return { why: 'outside' };
  // Inside the folder as written or as it really is: a report reached through a link names its files either way.
  const face = path.resolve(lexical, ref);
  if (!within(lexical, face) && !within(folder, face)) return { why: 'outside' };
  let real: string;
  try {
    // Then where it really points: a link inside the folder can lead out.
    real = fs.realpathSync(path.resolve(folder, ref));
  } catch {
    return { why: 'absent' };
  }
  if (!within(folder, real)) return { why: 'outside' };
  try {
    return fs.statSync(real).isFile() ? { file: real } : { why: 'not-a-file' };
  } catch {
    return { why: 'absent' };
  }
}

/** Every `[[ATTACHMENT|…]]` line in the test's `system-out` and `system-err`, in the order written, once each. */
export function markersOf(test: XmlElement): string[] {
  const refs = new Set<string>();
  for (const stream of test.children) {
    if (stream.name !== 'system-out' && stream.name !== 'system-err') continue;
    for (const match of stream.text.matchAll(MARKER)) {
      const ref = match[1]?.trim() ?? '';
      if (ref !== '') refs.add(ref);
    }
  }
  return [...refs];
}

/**
 * The files one test announced. What cannot be given goes to `missing`, and the test still has its result.
 * The name is the file's own (the last segment); two paths to one file are one file. `folder` is the real
 * folder of the report; `options.lexical` is it as written (default: the same).
 */
export function filesOfTest(
  test: XmlElement,
  folder: string,
  title: string,
  missing: MissingAttachment[],
  options: { lexical?: string; resultKey?: string; notes?: string[] } = {},
): ResultFile[] {
  const files: ResultFile[] = [];
  const all = markersOf(test);
  if (all.length > MARKERS_PER_TEST) {
    options.notes?.push(
      `plune: ${JSON.stringify(printable(title))}: ${all.length - MARKERS_PER_TEST} more markers ignored (at most ${MARKERS_PER_TEST} per test)`,
    );
  }
  for (const ref of all.slice(0, MARKERS_PER_TEST)) {
    const found = resolveAttachment(folder, ref, options.lexical);
    if (!('file' in found)) {
      missing.push({ title, path: ref, ...(options.resultKey !== undefined ? { resultKey: options.resultKey } : {}) });
      continue;
    }
    const real = found.file;
    if (!files.some((f) => f.path === real)) {
      files.push({ name: printable(ref.split(/[\\/]/).pop() || path.basename(real)), contentType: typeOfFile(real), path: real });
    }
  }
  return files;
}
