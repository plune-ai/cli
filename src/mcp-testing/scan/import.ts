import { UsageError } from '../connect/options.js';
import { safeText } from './config/config.js';

/**
 * `--import-conformance <file>`: the report of `plune mcp conformance` (one report, or a set of reports), shown in the
 * scan summary as imported. The scan does not repeat those checks and sends nothing for them. The file is untrusted:
 * it is size-limited before it is read, its shape is checked strictly (anything of a type that was not expected is an
 * error, never a permission), and only fixed fields are kept: the check id, its suite, its own state, its reason and its
 * level. The free text of a check (expected, actual, fix) is server text and is dropped. Every string kept goes through
 * the masking of the reports, and is cut. Imported rows are not findings: their states stay as the report gave them, and
 * they never change the exit code of this command.
 */
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 5000;
const MAX_REPORTS = 8;
const MAX_FIELD = 1000;
const SHOWN = 120;

export const IMPORT_STATES = [
  'passed',
  'failed',
  'could-not-run',
  'not-applicable',
  'pending',
] as const;
export type ImportState = (typeof IMPORT_STATES)[number];

export interface ImportedRow {
  id: string;
  suite: string;
  state: ImportState;
  reason?: string;
  level?: string;
}
export interface ImportedReport {
  protocolVersion: string;
  transport: string;
  /** The exit code the conformance report itself had; shown, never used. */
  exitCode: 0 | 1 | 3 | null;
  rows: ImportedRow[];
}
export interface ImportedConformance {
  source: 'plune mcp conformance';
  file: string;
  /** Always false: what another command measured does not decide the exit code of this one. */
  affectsExitCode: false;
  reports: ImportedReport[];
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const clean = (s: string): string => safeText(s).slice(0, SHOWN);

export function parseConformanceImport(text: string, file: string): ImportedConformance {
  const bad = (why: string): never => {
    throw new UsageError(`--import-conformance ${safeText(file)}: ${why}`);
  };
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return bad('not JSON.');
  }
  if (!isObject(root) || root['schemaVersion'] !== 1)
    return bad('not a report of plune mcp conformance (kind and schemaVersion 1 expected).');
  let sources: unknown[];
  if (root['kind'] === 'mcp-conformance-report') sources = [root];
  else if (root['kind'] === 'mcp-conformance-report-set' && Array.isArray(root['reports']))
    sources = root['reports'] as unknown[];
  else return bad('not a report of plune mcp conformance (kind and schemaVersion 1 expected).');
  if (sources.length === 0 || sources.length > MAX_REPORTS)
    return bad(`the file holds no report, or more than ${MAX_REPORTS}.`);
  let total = 0;
  const reports = sources.map((src): ImportedReport => {
    if (!isObject(src) || src['kind'] !== 'mcp-conformance-report' || src['schemaVersion'] !== 1)
      return bad('a report of the set is not a report of plune mcp conformance.');
    const checks = src['checks'];
    if (!Array.isArray(checks)) return bad('a report has no list of checks.');
    total += checks.length;
    if (total > MAX_IMPORT_ROWS) return bad(`more than ${MAX_IMPORT_ROWS} checks.`);
    const rows = checks.map((c): ImportedRow => {
      if (!isObject(c)) return bad('a check is not an object.');
      const { id, suite, state, reason, level } = c;
      if (typeof id !== 'string' || id === '' || id.length > MAX_FIELD)
        return bad('a check has no id.');
      if (typeof suite !== 'string' || suite.length > MAX_FIELD)
        return bad('a check has no suite.');
      if (typeof state !== 'string' || !(IMPORT_STATES as readonly string[]).includes(state))
        return bad('a check has a state that conformance does not write.');
      if (reason !== undefined && (typeof reason !== 'string' || reason.length > MAX_FIELD))
        return bad('a check has a reason that is not text.');
      if (level !== undefined && (typeof level !== 'string' || level.length > MAX_FIELD))
        return bad('a check has a level that is not text.');
      return {
        id: clean(id),
        suite: clean(suite),
        state: state as ImportState,
        ...(reason === undefined ? {} : { reason: clean(reason) }),
        ...(level === undefined ? {} : { level: clean(level) }),
      };
    });
    const code = src['exitCode'];
    const pv = src['protocolVersion'];
    const tr = src['transport'];
    return {
      protocolVersion: typeof pv === 'string' ? clean(pv) : '',
      transport: typeof tr === 'string' ? clean(tr) : '',
      exitCode: code === 0 || code === 1 || code === 3 ? code : null,
      rows,
    };
  });
  return { source: 'plune mcp conformance', file: safeText(file), affectsExitCode: false, reports };
}
