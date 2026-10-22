// `plune requirements links <file.md>` — a traceability matrix (requirement key -> test) from a Markdown
// file, imported as links between requirements and cases (plune-ai/cli follow-up of plune-ai/plune#1608).
//
//   no --table  → POST /v1/projects/:id/requirements/import/discover: the tables of the file;
//   --table + --requirement-column + --test-column → POST /v1/projects/:id/requirements/import/links:
//                 a DRY RUN unless `--yes`; the same report either way.
//
// Nothing is matched here: the file goes to the platform as one string and the flags are the body keys.
// Token, project, file reading and error messages are those of `requirements import`.

import { createClient } from '../../reporter-core/client.js';
import { resolveApiUrl } from '../api-url.js';
import { loadToken } from '../credentials.js';
import {
  RequirementsImportError,
  cut,
  flat,
  plural,
  readMarkdown,
  refusal,
  resolveProject,
  type DiscoverResult,
} from './requirements-import.js';

export interface LinksFlags {
  table?: string;
  requirementColumn?: string;
  testColumn?: string;
  separator?: string;
  yes?: boolean;
  json?: boolean;
  project?: string;
}
export interface LinksDeps extends LinksFlags {
  file: string;
  cwd?: string;
  apiUrl?: string;
  loadToken?: () => string | null;
  fetchImpl?: typeof fetch;
}

// The platform's shapes (RequirementsLinksReport).
export interface LinksReport {
  dryRun: boolean;
  applied: boolean;
  summary: { link: number; unchanged: number; unmatched: number };
  items: {
    line: number;
    action: 'link' | 'unchanged' | 'unmatched';
    key: string;
    test: string;
    reason: string;
    requirementId?: string;
    caseId?: string;
  }[];
}
export type LinksResult = { step: 'discover'; result: DiscoverResult } | { step: 'links'; report: LinksReport };

const usage = (message: string): never => {
  throw new RequirementsImportError(message, 2);
};

/** The flags → the body of the request (without the markdown); `null` is the discover step. */
export function buildLinksBody(f: LinksFlags): Record<string, unknown> | null {
  if (f.table === undefined && f.requirementColumn === undefined && f.testColumn === undefined && f.separator === undefined) return null;
  if (f.table === undefined) return usage('--requirement-column, --test-column and --separator need --table <n>. Run without flags to see which tables the file has.');
  if (!/^\d+$/.test(f.table)) usage(`--table is the number of the table in the list (0, 1, ...), not "${f.table}".`);
  if (f.requirementColumn === undefined || f.requirementColumn.trim() === '') usage('--table needs --requirement-column <header> (the column with the requirement keys).');
  if (f.testColumn === undefined || f.testColumn.trim() === '') usage('--table needs --test-column <header> (the column with the test titles or paths).');
  const body: Record<string, unknown> = { table: Number(f.table), requirementColumn: f.requirementColumn, testColumn: f.testColumn };
  if (f.separator !== undefined) {
    // The platform takes 1 to 3 characters; refused here before a byte is sent.
    if (f.separator.length < 1 || f.separator.length > 3) usage(`--separator is 1 to 3 characters, not "${f.separator}".`);
    body['requirementSeparator'] = f.separator;
  }
  return body;
}

export async function handleRequirementsLinks(deps: LinksDeps): Promise<LinksResult> {
  const apiUrl = resolveApiUrl(deps.apiUrl);
  const mapping = buildLinksBody(deps);
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
  const out = await client.post<LinksReport>(`${base}/links`, { markdown, dryRun: deps.yes !== true, ...mapping });
  if (!out.ok) throw refusal(out, apiUrl, projectId);
  return { step: 'links', report: out.body };
}

/** The tables to choose from, then the command to run. */
export function formatLinksDiscover(file: string, r: DiscoverResult): string {
  const out: string[] = [`${file}: ${plural(r.tables.length, 'table')}`, ''];
  if (r.tables.length === 0) out.push('  (none)');
  for (const t of r.tables) {
    const mark = t.unreadable !== undefined ? `   cannot be read: ${t.unreadable}` : '';
    out.push(`  #${t.index}  line ${t.line}  ${t.heading === null ? '(no heading)' : `"${flat(t.heading)}"`}  ${cut(t.headers.map(flat).join(' | '), 100)}  ${plural(t.rowCount, 'row')}${mark}`);
  }
  if (r.truncated) out.push('', 'The file has more tables than are listed here.');
  out.push('', 'Pick the matrix and name its two columns (a dry run, nothing is written):', `  plune requirements links ${file} --table <n> --requirement-column <header> --test-column <header>`);
  return out.join('\n') + '\n';
}

const SHOWN = 50;

export function formatLinks(report: LinksReport): string {
  const s = report.summary;
  const out: string[] = [`link ${s.link} · unchanged ${s.unchanged} · unmatched ${s.unmatched}`];
  for (const action of ['unmatched', 'link', 'unchanged'] as const) {
    const rows = report.items.filter((i) => i.action === action);
    if (rows.length === 0) continue;
    out.push('', `${action} (${rows.length})`);
    for (const i of rows.slice(0, SHOWN)) {
      out.push(`  line ${i.line}  ${i.key === '' ? '-' : i.key}  ->  ${i.test === '' ? '-' : cut(flat(i.test), 80)}  - ${flat(i.reason)}`);
    }
    if (rows.length > SHOWN) out.push(`  ... and ${rows.length - SHOWN} more (--json lists every row)`);
  }
  out.push('', report.applied ? `applied — ${plural(s.link, 'link')} created.` : 'dry run — nothing was written; add --yes to apply');
  return out.join('\n') + '\n';
}
