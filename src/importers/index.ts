/**
 * Reading a report somebody else's runner wrote.
 *
 * The whole of what these files know is a FORMAT. Which run the results join, how a test resolves
 * to a case, what a status means, what happens when the platform is down — all of that is the
 * reporter core's, and the import command drives it exactly as the Playwright reporter does
 * (ADR 0023). An importer that opened its own connection would be a second reporter to keep
 * correct, and the two would drift on the day one of them was fixed.
 */

import * as path from 'node:path';
import { RunCommandError } from '../cli/commands/run-lifecycle.js';
import { printable } from '../reporter-core/failure-detail.js';
import type { PendingResult } from '../reporter-core/types.js';
import { AllureReportError, RESULT, isFolder, namesIn, readAllure } from './allure.js';
import type { MissingAttachment } from './attachments.js';
import { looksLikeJUnit, readJUnit } from './junit.js';
import { JsonReportError, looksLikePlaywrightJson, readPlaywrightJson } from './playwright-json.js';
import { isK6Summary, readK6 } from './k6.js';
import { isLighthouseReport, readLighthouse } from './lighthouse.js';
import { readReportFile } from './read-file.js';

export { XmlParseError } from './xml.js';
export { JsonReportError } from './playwright-json.js';
export { AllureReportError } from './allure.js';
export type { MissingAttachment } from './attachments.js';
export { readReportFile } from './read-file.js';

export const IMPORT_FORMATS = ['junit', 'playwright-json', 'allure', 'k6', 'lighthouse'] as const;
export type ImportFormat = (typeof IMPORT_FORMATS)[number];

/** Neither sniff matched, or the name given is not one we have. Exit 2 — the user can fix it. */
export class UnknownFormatError extends Error {
  constructor(file: string, detail: string) {
    super(`${file} — ${detail} Say which with --format ${IMPORT_FORMATS.join(' | ')}.`);
    this.name = 'UnknownFormatError';
  }
}

/**
 * Which format this is, by looking at the file rather than at its name.
 *
 * An extension is a habit, not a fact — CI systems write `results.xml`, `junit.xml`, `report.json`
 * and `TEST-*.xml` for the same two formats, and a `.json` that is a Jest report rather than a
 * Playwright one has to be refused, not guessed at.
 */
export function detectFormat(source: string, file: string): ImportFormat {
  if (looksLikeJUnit(source)) return 'junit';
  // The two performance reports by their own top-level keys, before Playwright's: its check is a word
  // anywhere in the text, and a Lighthouse audit's prose may hold "suites".
  const perf = perfFormatOf(source);
  if (perf !== undefined) return perf;
  if (looksLikePlaywrightJson(source)) return 'playwright-json';
  throw new UnknownFormatError(
    file,
    'no <testsuite>, no Playwright "suites", no k6 "metrics" and no Lighthouse "lighthouseVersion" — this is not a report we can read.',
  );
}

/** A k6 summary or a Lighthouse report, by the keys of the parsed object; parsed only when one of them is in the text. */
function perfFormatOf(source: string): 'k6' | 'lighthouse' | undefined {
  if (!/^\s*\{/.test(source) || !(source.includes('"lighthouseVersion"') || source.includes('"metrics"'))) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return undefined;
  }
  if (isLighthouseReport(parsed)) return 'lighthouse';
  if (isK6Summary(parsed)) return 'k6';
  return undefined;
}

export { isFolder };

/**
 * Read a folder: an `allure-results` one (plune-ai/plune#1221) when a `*-result.json` is in it, otherwise the
 * JUnit files Maven Surefire and Gradle write one per class (plune-ai/plune#2309), all of them one run.
 * `--format` says which outright; `playwright-json` is never a folder. `--min-score` is refused for a folder as it is
 * for any file that is not Lighthouse: no folder holds a Lighthouse report, and a bar that judged nothing reads as met.
 */
export function readFolder(
  dir: string,
  format?: ImportFormat,
  options: ReadOptions = {},
): { format: ImportFormat; results: PendingResult[]; missing: MissingAttachment[]; notes: string[] } {
  if (format === 'playwright-json' || format === 'k6' || format === 'lighthouse') {
    throw new UnknownFormatError(dir, `this is a folder, and only allure-results or JUnit XML files are read from one, not ${format}.`);
  }
  if (options.minScores !== undefined && Object.keys(options.minScores).length > 0) {
    throw new JsonReportError(
      dir,
      '--min-score is for Lighthouse reports, and this is a folder: there is no score here to hold to it. Drop --min-score for this folder.',
    );
  }
  const missing: MissingAttachment[] = [];
  const notes: string[] = [];
  if (format === 'allure' || (format === undefined && namesIn(dir, RESULT).length > 0)) {
    return { format: 'allure', results: readAllure(dir, missing, notes), missing, notes };
  }
  // The files of the folder itself, by name: Gradle's binary/ beside them is not walked, a link is not opened.
  const results: PendingResult[] = [];
  const skipped: string[] = [];
  let reports = 0;
  for (const name of namesIn(dir, /\.xml$/)) {
    const file = path.join(dir, name);
    let source: string;
    try {
      source = readReportFile(file);
    } catch {
      // As one file that cannot be read is said (run-import.ts): exit 1.
      throw new RunCommandError(`Cannot read ${printable(file)}.`);
    }
    if (!looksLikeJUnit(source)) {
      skipped.push(name);
      notes.push(`plune: ${printable(file)} is not a JUnit report — skipped.`);
      continue;
    }
    reports += 1;
    // A file's markers count from its own folder; a test in two files is sent twice, as twice in one file is.
    for (const r of readJUnit(source, file, missing, notes)) results.push(r);
  }
  if (reports === 0) {
    // Without --format the folder has no *-result.json either, or it would have been read as Allure. The notes
    // are never printed when the import stops here, so the files skipped are named in the error.
    const names = skipped.slice(0, 3).map(printable).join(', ') + (skipped.length > 3 ? ` and ${skipped.length - 3} more` : '');
    throw new AllureReportError(
      `${printable(dir)} — no ${format === undefined ? '*-result.json files and no ' : ''}JUnit XML files in it` +
        `${skipped.length > 0 ? ` (skipped, not JUnit: ${names})` : ''}, so there is no report to read. ` +
        'Point at the folder an Allure adapter wrote (pytest --alluredir, allure-results), the one Maven or Gradle wrote ' +
        '(target/surefire-reports, build/test-results/test), or at a JUnit or Playwright JSON file.',
    );
  }
  return { format: 'junit', results, missing, notes };
}

/** What a format reads beside the file: `--min-score` for Lighthouse, by category. */
export interface ReadOptions {
  minScores?: Record<string, number>;
}

/**
 * Parse a report into results — and, where the format names one, the CI run that wrote it (`ciUrl`) and
 * the runner's own record of that CI (`ci`, for the commit and branch). `format` omitted means detect it.
 */
export function readReport(
  source: string,
  file: string,
  format?: ImportFormat,
  options: ReadOptions = {},
): { format: ImportFormat; results: PendingResult[]; missing: MissingAttachment[]; notes: string[]; ciUrl?: string; ci?: unknown } {
  const chosen = format ?? detectFormat(source, file);
  const missing: MissingAttachment[] = [];
  if (chosen === 'allure') throw new UnknownFormatError(file, 'allure-results is a folder, and this is a file.');
  const notes: string[] = [];
  // Refused, not ignored: a bar that judged nothing reads as a bar that was met, and no run is opened for it.
  if (chosen !== 'lighthouse' && options.minScores !== undefined && Object.keys(options.minScores).length > 0) {
    throw new JsonReportError(
      file,
      `--min-score is for Lighthouse reports, and this is a ${chosen} report: there is no score here to hold to it. Drop --min-score for this file.`,
    );
  }
  if (chosen === 'junit') return { format: chosen, results: readJUnit(source, file, missing, notes), missing, notes };
  if (chosen === 'k6') return { format: chosen, results: readK6(source, file), missing, notes };
  if (chosen === 'lighthouse') {
    return { format: chosen, results: readLighthouse(source, file, options.minScores), missing, notes };
  }
  // A Playwright JSON report names its files itself; nothing in it can be announced and then absent.
  return { format: chosen, ...readPlaywrightJson(source, file), missing, notes };
}
