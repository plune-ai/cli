import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveApiUrl } from '../api-url.js';
import { loadToken } from '../credentials.js';
import {
  NotLoggedInError,
  SyncFileError,
  SyncHttpError,
  SyncNetworkError,
  TokenRejectedError,
} from './sync.js';

/**
 * `plune pull` / `plune push` (D9): the project's cases as one Markdown document in Testomat's
 * classical format — `GET /v1/test-cases/markdown` into a file, and the file back through
 * `POST /v1/test-cases/markdown`, whose report says what was created, updated, left alone and
 * refused, line by line. The platform matches by id, never deletes, and with `--dry-run` writes
 * nothing; the format itself is documented at https://docs.plune.ai/platform/cases/markdown/.
 *
 * Mirrors `sync`: the same errors (not logged in → 2, network/HTTP → 1), the same rule that the
 * token is never printed. Two exit codes of its own: a pull refused by the git guard (3), a push
 * with refusals in its report (4) — both are the caller's to act on, and both are scriptable.
 */
export const DEFAULT_CASES_FILE = path.join('plune', 'cases.md');

/** The target file has uncommitted changes and `--force` was not given. (exit 3) */
export class DirtyFileError extends Error {
  constructor(file: string) {
    super(`${file} has uncommitted changes; commit them or pass --force to overwrite.`);
    this.name = 'DirtyFileError';
  }
}

/** What a push did — the platform's report, verbatim (`PushReport` on the server). */
export interface PushReport {
  dryRun: boolean;
  created: { id?: string; title: string; line: number }[];
  updated: { id: string; title: string; line: number }[];
  unchanged: { id: string; title: string; line: number }[];
  refused: { title: string; line: number; error: string }[];
  suites: {
    created: { id?: string; path: string; line: number }[];
    updated: { id: string; path: string; line: number }[];
  };
  warnings: { line?: number; message: string }[];
}

export interface CasesDeps {
  cwd?: string;
  /** The document's file; defaults to `plune/cases.md` under `cwd`. */
  file?: string;
  apiUrl?: string;
  loadToken?: () => string | null;
  fetchImpl?: typeof fetch;
  /** Whether `file` is under git with uncommitted changes (injected in tests). Defaults to `git status`. */
  isDirty?: (file: string) => boolean;
}

/** `git status --porcelain -- <file>`: any line means the file is modified, added or untracked. Not a repo → clean. */
function gitDirty(file: string): boolean {
  try {
    const out = execFileSync('git', ['status', '--porcelain', '--', file], {
      cwd: path.dirname(file),
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
    return out.trim() !== '';
  } catch {
    return false;
  }
}

async function safeErrorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === 'string' ? body.error : '';
  } catch {
    return '';
  }
}

/** The token, or the friendliest refusal there is. */
function tokenOf(deps: CasesDeps): string {
  const token = (deps.loadToken ?? loadToken)();
  if (token === null) throw new NotLoggedInError();
  return token;
}

/**
 * `GET /v1/test-cases/markdown` (or one node's subtree with `suiteId`) into the file. Refuses to
 * overwrite a file git knows as modified unless `force` — the document is a person's working copy,
 * and a pull over their unsaved edits is the one loss this command could cause.
 */
export async function handlePull(
  deps: CasesDeps & { suiteId?: string; force?: boolean } = {},
): Promise<{ file: string; cases: number }> {
  const cwd = deps.cwd ?? process.cwd();
  const apiUrl = resolveApiUrl(deps.apiUrl);
  const token = tokenOf(deps);
  const file = path.resolve(cwd, deps.file ?? DEFAULT_CASES_FILE);
  if (fs.existsSync(file) && !deps.force && (deps.isDirty ?? gitDirty)(file))
    throw new DirtyFileError(path.relative(cwd, file) || file);

  const doFetch = deps.fetchImpl ?? fetch;
  const endpoint =
    deps.suiteId !== undefined
      ? `${apiUrl}/v1/suites/${encodeURIComponent(deps.suiteId)}/markdown`
      : `${apiUrl}/v1/test-cases/markdown`;
  let res: Response;
  try {
    res = await doFetch(endpoint, { headers: { authorization: `Bearer ${token}` } });
  } catch {
    throw new SyncNetworkError(apiUrl);
  }
  if (!res.ok) {
    const detail = await safeErrorDetail(res);
    if (res.status === 401) throw new TokenRejectedError();
    throw new SyncHttpError(res.status, detail);
  }
  const text = await res.text();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
  return { file, cases: Number(res.headers.get('x-plune-cases') ?? '0') };
}

/** The file through `POST /v1/test-cases/markdown`, `?dryRun=true` when asked; the report as the server gave it. */
export async function handlePush(deps: CasesDeps & { dryRun?: boolean } = {}): Promise<PushReport> {
  const cwd = deps.cwd ?? process.cwd();
  const apiUrl = resolveApiUrl(deps.apiUrl);
  const token = tokenOf(deps);
  const file = path.resolve(cwd, deps.file ?? DEFAULT_CASES_FILE);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new SyncFileError(
      `No document to push: ${file}. Run "plune pull" first (or pass a file).`,
    );
  }
  if (text.trim() === '') throw new SyncFileError(`The document is empty: ${file}`);

  const doFetch = deps.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${apiUrl}/v1/test-cases/markdown${deps.dryRun ? '?dryRun=true' : ''}`, {
      method: 'POST',
      headers: { 'content-type': 'text/markdown', authorization: `Bearer ${token}` },
      body: text,
    });
  } catch {
    throw new SyncNetworkError(apiUrl);
  }
  if (!res.ok) {
    const detail = await safeErrorDetail(res);
    if (res.status === 401) throw new TokenRejectedError();
    throw new SyncHttpError(res.status, detail);
  }
  return (await res.json()) as PushReport;
}

/** The report as lines for the terminal: the counts, then every refusal and warning with its line. */
export function formatReport(report: PushReport): string {
  const verb = (past: string, future: string) => (report.dryRun ? future : past);
  const lines = [
    `${report.dryRun ? 'Dry run — nothing written.' : 'Pushed.'} ${report.created.length} ${verb('created', 'to create')} · ${report.updated.length} ${verb('updated', 'to update')} · ${report.unchanged.length} unchanged · ${report.refused.length} refused` +
      (report.suites.created.length > 0
        ? ` · ${report.suites.created.length} suite(s) ${verb('created', 'to create')}`
        : ''),
  ];
  for (const r of report.refused)
    lines.push(`  refused  line ${r.line}  ${r.title || '(no title)'} — ${r.error}`);
  for (const w of report.warnings)
    lines.push(`  warning  ${w.line !== undefined ? `line ${w.line}  ` : ''}${w.message}`);
  return lines.join('\n') + '\n';
}

/** `handlePull`/`handlePush` rejections → a stderr line and the exit code; `null` for the unexpected. */
export function reportCasesFailure(err: unknown, write: (s: string) => void): number | null {
  if (err instanceof DirtyFileError) {
    write(err.message + '\n');
    return 3;
  }
  if (
    err instanceof NotLoggedInError ||
    err instanceof TokenRejectedError ||
    err instanceof SyncFileError
  ) {
    write(err.message + '\n');
    return 2;
  }
  if (err instanceof SyncNetworkError || err instanceof SyncHttpError) {
    write(err.message + '\n');
    return 1;
  }
  return null;
}
