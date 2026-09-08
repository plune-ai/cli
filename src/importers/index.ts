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
import { looksLikeJUnit, readJUnit } from './junit.js';
import { looksLikePlaywrightJson, readPlaywrightJson } from './playwright-json.js';

export { XmlParseError } from './xml.js';
export { JsonReportError } from './playwright-json.js';

export const IMPORT_FORMATS = ['junit', 'playwright-json'] as const;
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

/** Parse a report into results. `format` omitted means detect it. */
export function readReport(
  source: string,
  file: string,
  format?: ImportFormat,
): { format: ImportFormat; results: PendingResult[] } {
  const chosen = format ?? detectFormat(source, file);
  return {
    format: chosen,
    results: chosen === 'junit' ? readJUnit(source, file) : readPlaywrightJson(source, file),
  };
}
