/**
 * Reading a report somebody else's runner wrote.
 *
 * The whole of what these files know is a FORMAT. Which run the results join, how a test resolves
 * to a case, what a status means, what happens when the platform is down — all of that is the
 * reporter core's, and the import command drives it exactly as the Playwright reporter does
 * (ADR 0023). An importer that opened its own connection would be a second reporter to keep
 * correct, and the two would drift on the day one of them was fixed.
 */

import type { PendingResult } from '../reporter-core/types.js';
import { isFolder, readAllure } from './allure.js';
import type { MissingAttachment } from './attachments.js';
import { looksLikeJUnit, readJUnit } from './junit.js';
import { looksLikePlaywrightJson, readPlaywrightJson } from './playwright-json.js';

export { XmlParseError } from './xml.js';
export { JsonReportError } from './playwright-json.js';
export { AllureReportError } from './allure.js';
export type { MissingAttachment } from './attachments.js';

export const IMPORT_FORMATS = ['junit', 'playwright-json', 'allure'] as const;
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
  if (looksLikePlaywrightJson(source)) return 'playwright-json';
  throw new UnknownFormatError(
    file,
    'no <testsuite> and no Playwright "suites" — this is not a report we can read.',
  );
}

export { isFolder };

/** Read an `allure-results` folder (plune-ai/plune#1221); any other `format` asked for is refused. */
export function readFolder(
  dir: string,
  format?: ImportFormat,
): { format: ImportFormat; results: PendingResult[]; missing: MissingAttachment[]; notes: string[] } {
  if (format !== undefined && format !== 'allure') {
    throw new UnknownFormatError(dir, `this is a folder, and only allure-results is read from one, not ${format}.`);
  }
  const missing: MissingAttachment[] = [];
  const notes: string[] = [];
  return { format: 'allure', results: readAllure(dir, missing, notes), missing, notes };
}

/**
 * Parse a report into results — and, where the format names one, the CI run that wrote it (`ciUrl`) and
 * the runner's own record of that CI (`ci`, for the commit and branch). `format` omitted means detect it.
 */
export function readReport(
  source: string,
  file: string,
  format?: ImportFormat,
): { format: ImportFormat; results: PendingResult[]; missing: MissingAttachment[]; notes: string[]; ciUrl?: string; ci?: unknown } {
  const chosen = format ?? detectFormat(source, file);
  const missing: MissingAttachment[] = [];
  if (chosen === 'allure') throw new UnknownFormatError(file, 'allure-results is a folder, and this is a file.');
  const notes: string[] = [];
  if (chosen === 'junit') return { format: chosen, results: readJUnit(source, file, missing, notes), missing, notes };
  // A Playwright JSON report names its files itself; nothing in it can be announced and then absent.
  return { format: chosen, ...readPlaywrightJson(source, file), missing, notes };
}
