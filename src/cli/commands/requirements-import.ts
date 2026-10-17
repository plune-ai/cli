// `plune requirements import <file.md>` — requirements from a Markdown file (plune-ai/cli#113, epic
// plune-ai/plune#1594). Two steps, as the platform's two routes:
//
//   no mapping flags  → POST /v1/projects/:id/requirements/import/discover: what the file holds (the
//                       tables and sections), so the person can choose;
//   --table / --sections (+ columns) → POST /v1/projects/:id/requirements/import: a DRY RUN unless
//                       `--yes`; the same report either way.
//
// Nothing is guessed here and nothing is parsed: the file goes to the platform as one string and every
// flag becomes the body key of the same name. Mistakes that the platform would refuse anyway (a table
// and a section together, a title and a text column) are refused locally, before any request.
//
// Same rules as the other platform commands: the token ladder of `loadToken`, the shared client (retry
// and backoff, the quota-body-first 429 rule, the token scrubbed from anything the far side says), a
// typed error per failure with a message, never a stack trace.

import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient, type ClientOutcome } from '../../reporter-core/client.js';
import { resolveApiUrl, whereToGetAToken } from '../api-url.js';
import { loadToken } from '../credentials.js';

/** The platform reads at most this much Markdown (`limits.markdownBytes`); refused here before a byte is sent. */
export const MAX_MARKDOWN_BYTES = 1_048_576;

/** A refusal with its own message and exit code: 2 the person can fix it here, 1 the platform or the wire said no. */
export class RequirementsImportError extends Error {
  constructor(
    message: string,
    readonly exitCode: 1 | 2,
  ) {
    super(message);
    this.name = 'RequirementsImportError';
  }
}
const usage = (message: string): never => {
  throw new RequirementsImportError(message, 2);
};

export interface ImportFlags {
  /** A bare number (the single-table form) or, repeated, `"<n>:key=ID,text=Requirement,..."` specs. */
  table?: string | string[];
  sections?: string;
  keyColumn?: string;
  titleColumn?: string;
  textColumn?: string;
  descriptionColumn?: string;
  priorityColumn?: string;
  categoryColumn?: string;
  typeColumn?: string;
  statusColumn?: string;
  criteriaColumn?: string;
  mapPriority?: string;
  mapCategory?: string;
  unit?: string;
  keyPrefix?: string;
  priorityFrom?: string;
  type?: string;
  yes?: boolean;
  json?: boolean;
  project?: string;
}

export interface ImportDeps extends ImportFlags {
  file: string;
  cwd?: string;
  apiUrl?: string;
  loadToken?: () => string | null;
  fetchImpl?: typeof fetch;
  write?: (line: string) => void;
}

// ---- the platform's shapes (docs/api: RequirementsDiscoverResult, RequirementsImportReport) ----

export interface DiscoverResult {
  frontmatter: { keys: string[]; title: string | null };
  sections: { index: number; heading: string; level: number; line: number; bulletCount: number; subheadingCount: number }[];
  tables: {
    index: number;
    line: number;
    heading: string | null;
    headers: string[];
    rowCount: number;
    firstRows: string[][];
    looksLikeRequirements: boolean;
    unreadable?: string;
  }[];
  truncated: boolean;
}

type Action = 'create' | 'update' | 'unchanged' | 'skip';
export interface ImportReport {
  dryRun: boolean;
  applied: boolean;
  mode: 'table' | 'sections';
  summary: Record<Action, number>;
  items: {
    line: number;
    action: Action;
    key: string | null;
    title: string;
    reason: string;
    changes?: string[];
    id?: string;
    notes?: string[];
    /** Only when several tables were sent: the table the row is from, and its heading. */
    table?: number;
    tableHeading?: string | null;
  }[];
  /** `true` when every row read was a template placeholder: nothing to import. */
  emptyTemplate?: true;
  message?: string;
  values: { priority: ImportValue[]; category: ImportValue[] };
  notImported: {
    frontmatterKeys: string[];
    tables: { index: number; heading: string | null; headers: string[]; rowCount: number }[];
    sections: { index: number; heading: string; level: number; bulletCount: number }[];
  };
}
interface ImportValue {
  value: string;
  count: number;
  mappedTo: string | null;
}

// ---- flags → body ----

const COLUMN_FLAGS = [
  ['keyColumn', '--key-column', 'keyColumn'],
  ['titleColumn', '--title-column', 'titleColumn'],
  ['textColumn', '--text-column', 'textColumn'],
  ['descriptionColumn', '--description-column', 'descriptionColumn'],
  ['priorityColumn', '--priority-column', 'priorityColumn'],
  ['categoryColumn', '--category-column', 'categoryColumn'],
  ['typeColumn', '--type-column', 'typeColumn'],
  ['statusColumn', '--status-column', 'statusColumn'],
  ['criteriaColumn', '--criteria-column', 'acceptanceCriteriaColumn'],
] as const;
const SECTION_FLAGS = [
  ['unit', '--unit'],
  ['keyPrefix', '--key-prefix'],
  ['priorityFrom', '--priority-from'],
] as const;

/** `"Critical=Must-have,High=Should-have"` → `{Critical: 'Must-have', High: 'Should-have'}`. */
export function parseMap(flag: string, raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    if (pair.trim() === '') continue;
    const at = pair.indexOf('=');
    const from = at < 0 ? '' : pair.slice(0, at).trim();
    const to = at < 0 ? '' : pair.slice(at + 1).trim();
    if (from === '' || to === '') usage(`${flag}: "${pair.trim()}" is not Value=Value. Write it like ${flag} "Critical=Must-have,High=Should-have".`);
    out[from] = to;
  }
  if (Object.keys(out).length === 0) usage(`${flag} is empty. Write it like ${flag} "Critical=Must-have,High=Should-have".`);
  return out;
}

const oneOf = (flag: string, value: string, allowed: readonly string[]): string =>
  allowed.includes(value) ? value : usage(`${flag} must be ${allowed.join(' or ')}, not "${value}".`);

/** The keys of one `--table "<n>:key=Header,..."` spec → the field of that table in the request's `tables`. */
const TABLE_SPEC_KEYS: Record<string, string> = {
  key: 'keyColumn',
  title: 'titleColumn',
  text: 'textColumn',
  description: 'descriptionColumn',
  priority: 'priorityColumn',
  category: 'categoryColumn',
  type: 'typeColumn',
  status: 'statusColumn',
  criteria: 'acceptanceCriteriaColumn',
  'fixed-category': 'fixedCategory',
  'fixed-type': 'fixedType',
};
const SPEC_HELP = 'Write it like --table "3:key=ID,text=Requirement,fixed-category=functional".';

/** `"3:key=ID,text=Requirement"` → `{table: 3, keyColumn: 'ID', textColumn: 'Requirement'}`. A header with a comma cannot be named here. */
export function parseTableSpec(spec: string): Record<string, unknown> {
  const at = spec.indexOf(':');
  const index = (at < 0 ? spec : spec.slice(0, at)).trim();
  if (!/^\d+$/.test(index)) usage(`--table "${spec}": "${index}" is not a table number. ${SPEC_HELP}`);
  const t: Record<string, unknown> = { table: Number(index) };
  for (const pair of (at < 0 ? '' : spec.slice(at + 1)).split(',')) {
    if (pair.trim() === '') continue;
    const eq = pair.indexOf('=');
    const name = (eq < 0 ? pair : pair.slice(0, eq)).trim().toLowerCase();
    const value = eq < 0 ? '' : pair.slice(eq + 1).trim();
    const field = TABLE_SPEC_KEYS[name];
    if (field === undefined) return usage(`--table "${spec}": "${name}" is not a column name. Use ${Object.keys(TABLE_SPEC_KEYS).join(', ')}.`);
    if (value === '') usage(`--table "${spec}": "${name}" has no value. ${SPEC_HELP}`);
    if (field in t) usage(`--table "${spec}": "${name}" is given twice.`);
    if (field === 'fixedCategory') oneOf('fixed-category', value, ['functional', 'non-functional', 'other']);
    if (field === 'fixedType') oneOf('fixed-type', value, ['user_story', 'feature', 'epic']);
    t[field] = value;
  }
  if (t['titleColumn'] !== undefined && t['textColumn'] !== undefined) usage(`--table "${spec}": give title= or text=, not both.`);
  if (t['titleColumn'] === undefined && t['textColumn'] === undefined) usage(`--table "${spec}": each table needs title=<header> or text=<header>.`);
  return t;
}

/** Which step the flags ask for, and the body of the import (without the markdown); `null` is the discover step. */
export function buildImportBody(f: ImportFlags): Record<string, unknown> | null {
  const tables = f.table === undefined ? [] : Array.isArray(f.table) ? f.table : [f.table];
  const columnFlags = COLUMN_FLAGS.filter(([k]) => f[k] !== undefined);
  const sectionFlags = SECTION_FLAGS.filter(([k]) => f[k] !== undefined);
  const anyMapping =
    tables.length > 0 || f.sections !== undefined || columnFlags.length > 0 || sectionFlags.length > 0 ||
    f.mapPriority !== undefined || f.mapCategory !== undefined || f.type !== undefined;
  if (!anyMapping) return null;

  if (tables.length > 0 && f.sections !== undefined) usage('Give --table or --sections, not both: one import reads one table or one section.');
  if (tables.length === 0 && f.sections === undefined) {
    usage('The mapping flags need --table <n> (a table) or --sections <heading|n> (a section). Run without flags to see which the file has.');
  }

  const body: Record<string, unknown> = {};
  if (f.mapPriority !== undefined) body['priorityMap'] = parseMap('--map-priority', f.mapPriority);
  if (f.type !== undefined) body['defaultType'] = oneOf('--type', f.type, ['user_story', 'feature', 'epic']);

  // Several tables: each --table carries its own columns, so the single-table column flags are refused (one form or the other).
  if (tables.length > 1 || tables.some((t) => t.includes(':'))) {
    if (sectionFlags.length > 0) usage(`${sectionFlags.map(([, n]) => n).join(', ')} ${sectionFlags.length > 1 ? 'are' : 'is'} for --sections, not --table.`);
    if (columnFlags.length > 0) {
      usage(`${columnFlags.map(([, n]) => n).join(', ')} cannot be used with --table "<n>:...": put the column inside each --table, e.g. --table "3:key=ID,text=Requirement".`);
    }
    const specs = tables.map(parseTableSpec);
    const seen = new Set<unknown>();
    for (const t of specs) {
      if (seen.has(t['table'])) usage(`Table ${String(t['table'])} is given twice in --table.`);
      seen.add(t['table']);
    }
    body['mode'] = 'table';
    // --map-category is shared here: the request keeps one `categoryMap` per table, so it is copied into each.
    const categoryMap = f.mapCategory !== undefined ? parseMap('--map-category', f.mapCategory) : undefined;
    body['tables'] = specs.map((t) => (categoryMap === undefined ? t : { ...t, categoryMap }));
  } else if (tables.length === 1) {
    const only = tables[0]!;
    if (!/^\d+$/.test(only)) usage(`--table is the number of the table in the list (0, 1, ...), not "${only}".`);
    if (sectionFlags.length > 0) usage(`${sectionFlags.map(([, n]) => n).join(', ')} ${sectionFlags.length > 1 ? 'are' : 'is'} for --sections, not --table.`);
    if (f.titleColumn !== undefined && f.textColumn !== undefined) usage('Give --title-column or --text-column, not both.');
    if (f.titleColumn === undefined && f.textColumn === undefined) usage('--table needs --title-column <header> or --text-column <header>.');
    body['mode'] = 'table';
    body['table'] = Number(only);
    for (const [k, , key] of columnFlags) body[key] = f[k];
    if (f.mapCategory !== undefined) body['categoryMap'] = parseMap('--map-category', f.mapCategory);
  } else {
    if (columnFlags.length > 0) usage(`${columnFlags.map(([, n]) => n).join(', ')} ${columnFlags.length > 1 ? 'are' : 'is'} for --table, not --sections.`);
    if (f.mapCategory !== undefined) usage('--map-category is for --table, not --sections.');
    body['mode'] = 'sections';
    const section = (f.sections ?? '').trim();
    if (section === '') usage('--sections needs a heading or its number in the list.');
    body['section'] = /^\d+$/.test(section) ? Number(section) : section;
    if (f.unit !== undefined) body['unit'] = oneOf('--unit', f.unit, ['bullets', 'subheadings']);
    if (f.keyPrefix !== undefined) body['keyPrefix'] = f.keyPrefix;
    if (f.priorityFrom !== undefined) body['priorityFrom'] = oneOf('--priority-from', f.priorityFrom, ['subheading']);
  }
  return body;
}

// ---- the file ----

function readMarkdown(cwd: string, file: string): string {
  const target = resolve(cwd, file);
  let size: number;
  try {
    const st = statSync(target);
    if (!st.isFile()) return usage(`${target} is not a file.`);
    size = st.size;
  } catch {
    return usage(`File not found: ${target}`);
  }
  if (size > MAX_MARKDOWN_BYTES) {
    return usage(`${target} is ${size} bytes; the platform reads at most ${MAX_MARKDOWN_BYTES} bytes (1 MiB). Nothing was sent. Split the file.`);
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(target));
  } catch {
    return usage(`${target} is not valid UTF-8. Save it as UTF-8 and try again.`);
  }
  text = text.replace(/^﻿/, '');
  if (text.trim() === '') usage(`${target} is empty.`);
  return text;
}

// ---- the platform ----

const SUPPORT = 'This platform does not support requirements import yet. Nothing was sent to a project; try a newer Plune platform.';

/** A failed outcome → the message a person can act on. */
function refusal(out: Extract<ClientOutcome<unknown>, { ok: false }>, apiUrl: string, projectId: string): RequirementsImportError {
  const d = out.detail;
  const said = d === '' ? '' : ` (${d})`;
  switch (out.status) {
    case null:
      return new RequirementsImportError(`Could not reach the Plune API at ${apiUrl}. Check your connection (or PLUNE_API_URL) and try again.`, 1);
    case 401:
      return new RequirementsImportError(`Your API token was rejected (revoked or invalid). ${whereToGetAToken(apiUrl)} Then run "plune login".`, 2);
    case 403:
      return new RequirementsImportError(`The platform refused: ${d || 'read-only member'}. Importing needs an owner or a member of the project.`, 1);
    case 404:
      // The platform's own "no such project" names the project; any other 404 is a route it does not have.
      return /^project '.*' not found$/.test(d)
        ? new RequirementsImportError(`Project ${projectId} was not found for this token. A token only works in the project it was minted in; pass --project <id> or use a token from that project.`, 1)
        : new RequirementsImportError(SUPPORT, 1);
    case 409:
      return new RequirementsImportError(`A requirement key was taken by another change while the import ran. Nothing was written; run it again${said}.`, 1);
    case 413:
      return new RequirementsImportError(`The platform refused the file as too large${said}. Nothing was written.`, 1);
    case 400:
      return new RequirementsImportError(`The platform refused the mapping${said}.`, 1);
    default:
      return new RequirementsImportError(`The platform answered HTTP ${out.status}${said}. Nothing was written.`, 1);
  }
}

async function resolveProject(client: ReturnType<typeof createClient>, explicit: string | undefined, apiUrl: string): Promise<string> {
  const given = (explicit ?? process.env['PLUNE_PROJECT'])?.trim();
  if (given !== undefined && given !== '') return given;
  const out = await client.get<{ projects?: { id: string; name?: string }[] }>('/v1/projects');
  if (!out.ok) throw refusal(out, apiUrl, '');
  const projects = out.body.projects ?? [];
  if (projects.length === 1 && projects[0] !== undefined) return projects[0].id;
  const list = projects.map((p) => `${p.id}${p.name ? ` (${p.name})` : ''}`).join(', ');
  return usage(
    projects.length === 0
      ? 'No project found for this token. Pass --project <id>.'
      : `This account is in ${projects.length} projects (${list}). A token only works in the project it was minted in: pass --project <id> (or set PLUNE_PROJECT).`,
  );
}

export type ImportResult =
  | { step: 'discover'; result: DiscoverResult }
  | { step: 'import'; report: ImportReport };

export async function handleRequirementsImport(deps: ImportDeps): Promise<ImportResult> {
  const apiUrl = resolveApiUrl(deps.apiUrl);
  // Local checks first, cheapest first: flags, then the file, then the token. No request until all pass.
  const mapping = buildImportBody(deps);
  const markdown = readMarkdown(deps.cwd ?? process.cwd(), deps.file);
  const token = (deps.loadToken ?? loadToken)();
  if (token === null) throw new RequirementsImportError('Not logged in. Run "plune login" first, or set PLUNE_TOKEN.', 2);

  const client = createClient({ apiUrl, token, ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}) });
  const projectId = await resolveProject(client, deps.project, apiUrl);
  const base = `/v1/projects/${encodeURIComponent(projectId)}/requirements/import`;

  if (mapping === null) {
    const out = await client.post<DiscoverResult>(`${base}/discover`, { markdown });
    if (!out.ok) throw refusal(out, apiUrl, projectId);
    return { step: 'discover', result: out.body };
  }
  const out = await client.post<ImportReport>(base, { markdown, dryRun: deps.yes !== true, ...mapping });
  if (!out.ok) throw refusal(out, apiUrl, projectId);
  return { step: 'import', report: out.body };
}

// ---- the terminal ----

const SHOWN = 50;
const flat = (s: string): string => s.replace(/\s+/g, ' ').trim();
const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export function formatDiscover(file: string, r: DiscoverResult): string {
  const out: string[] = [`${file}: ${plural(r.tables.length, 'table')}, ${plural(r.sections.length, 'section')}`];
  if (r.frontmatter.keys.length > 0) out.push(`Frontmatter keys: ${r.frontmatter.keys.join(', ')}`);
  out.push('', 'Tables');
  if (r.tables.length === 0) out.push('  (none)');
  for (const t of r.tables) {
    const mark = t.unreadable !== undefined ? `   cannot be read: ${t.unreadable}` : t.looksLikeRequirements ? '   <- looks like requirements' : '';
    out.push(`  #${t.index}  line ${t.line}  ${t.heading === null ? '(no heading)' : `"${flat(t.heading)}"`}  ${cut(t.headers.map(flat).join(' | '), 100)}  ${plural(t.rowCount, 'row')}${mark}`);
  }
  out.push('', 'Sections');
  if (r.sections.length === 0) out.push('  (none)');
  for (const s of r.sections) {
    out.push(`  #${s.index}  line ${s.line}  ${'#'.repeat(s.level)} ${flat(s.heading)}  ${plural(s.bulletCount, 'bullet')}, ${plural(s.subheadingCount, 'sub-heading')}`);
  }
  if (r.truncated) out.push('', 'The file has more headings or tables than are listed here.');
  out.push(
    '',
    'Pick one and map it (a dry run, nothing is written):',
    `  plune requirements import ${file} --table <n> --key-column <header> --title-column <header>`,
    `  plune requirements import ${file} --sections <heading|n> --unit bullets|subheadings`,
    'Several tables in one run, each with its own columns:',
    `  plune requirements import ${file} --table "<n>:key=<header>,text=<header>,fixed-category=functional" --table "<m>:key=<header>,text=<header>"`,
  );
  return out.join('\n') + '\n';
}

export function formatReport(report: ImportReport): string {
  const s = report.summary;
  const out: string[] = [`create ${s.create} · update ${s.update} · unchanged ${s.unchanged} · skip ${s.skip}`];
  // The exit code stays 0: like a skipped row, a file with nothing to import is an answer, not a failure (--json carries emptyTemplate).
  if (report.emptyTemplate === true) {
    const said = report.message !== undefined && !/empty template/i.test(report.message) ? ` ${flat(report.message)}` : '';
    out.push('', `this file is an empty template: every row is a placeholder, nothing to import.${said}`);
  }
  for (const action of ['create', 'update', 'skip', 'unchanged'] as const) {
    const rows = report.items.filter((i) => i.action === action);
    if (rows.length === 0) continue;
    out.push('', `${action} (${rows.length})`);
    for (const i of rows.slice(0, SHOWN)) {
      const changes = i.changes !== undefined && i.changes.length > 0 ? `; changes: ${i.changes.join(', ')}` : '';
      const notes = i.notes !== undefined && i.notes.length > 0 ? `; note: ${i.notes.join('; ')}` : '';
      const from = i.table === undefined ? '' : `table #${i.table}${i.tableHeading ? ` "${cut(flat(i.tableHeading), 40)}"` : ''}  `;
      out.push(`  ${from}line ${i.line}  ${i.key ?? '-'}  ${cut(flat(i.title), 80)}  - ${flat(i.reason)}${changes}${notes}`);
    }
    if (rows.length > SHOWN) out.push(`  ... and ${rows.length - SHOWN} more (--json lists every row)`);
  }
  for (const [label, values] of [['Priority values', report.values.priority], ['Category values', report.values.category]] as const) {
    if (values.length === 0) continue;
    out.push('', label);
    for (const v of values.slice(0, SHOWN)) out.push(`  ${v.value}  x${v.count}  -> ${v.mappedTo ?? '(no mapping: kept as written)'}`);
  }
  const n = report.notImported;
  if (n.tables.length + n.sections.length + n.frontmatterKeys.length > 0) {
    out.push('', 'Not imported');
    for (const t of n.tables) out.push(`  table #${t.index} ${t.heading === null ? '' : `"${flat(t.heading)}" `}(${cut(t.headers.map(flat).join(' | '), 80)}; ${plural(t.rowCount, 'row')})`);
    for (const x of n.sections) out.push(`  section #${x.index} "${flat(x.heading)}" (${plural(x.bulletCount, 'bullet')})`);
    if (n.frontmatterKeys.length > 0) out.push(`  frontmatter keys: ${n.frontmatterKeys.join(', ')}`);
  }
  out.push('', report.applied ? `applied — ${plural(s.create, 'requirement')} created, ${s.update} updated.` : 'dry run — nothing was written; add --yes to apply');
  return out.join('\n') + '\n';
}

/** A rejection → stderr line and exit code, or `null` for an error that is not ours to explain. */
export function reportRequirementsImportFailure(err: unknown, write: (s: string) => void): number | null {
  if (!(err instanceof RequirementsImportError)) return null;
  write(err.message + '\n');
  return err.exitCode;
}
