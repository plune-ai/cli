// `plune automate <caseId>` (#148): a case from the platform → Cairn's `automate` → the code it wrote, as a diff.
//
// The direction of the dependency is the platform's ADR 0024: the CLI knows about Cairn, Cairn knows nothing about
// Plune. So Cairn gets the case as a file in its own published format (a run folder with `report.json` and one
// `testcases/ATC-*.md`), and an environment with no `PLUNE_*` variable and no token in it (Cairn ADR-0010).
//
// What comes back is a diff of new files. The main copy of the code lives in the user's repo; writing it there is
// the user's or their CI's job, so nothing here touches the repo. The platform has no route yet that takes an
// automation proposal with code, so the diff goes to stdout and nothing is sent.

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadToken } from '../credentials.js';
import { platformGet } from './plan.js';
import { NotLoggedInError, SyncFileError, SyncHttpError } from './sync.js';
import { reportCasesFailure } from './cases.js';

/** No Cairn where we looked. (exit 2) */
export class CairnMissingError extends Error {
  constructor(command: string) {
    super(
      `Cairn not found: ${command}. Install Cairn, or pass the path to its executable with --cairn.`,
    );
    this.name = 'CairnMissingError';
  }
}

/** The platform has no such case, or not for this token. (exit 2) */
export class CaseNotFoundError extends Error {
  constructor(id: string) {
    super(`Case '${id}' not found — check the id, or whether the token belongs to the case's project.`);
    this.name = 'CaseNotFoundError';
  }
}

/** A case Cairn cannot write code from: no steps. (exit 2) */
export class CaseNotAutomatableError extends Error {
  constructor(id: string, type: string) {
    super(`Case '${id}' (${type}) has no steps: Cairn writes code from a case's steps.`);
    this.name = 'CaseNotAutomatableError';
  }
}

/** Cairn ran and failed. (exit 1) */
export class CairnFailedError extends Error {
  constructor(code: number) {
    super(`Cairn exited with code ${code}; its output is above.`);
    this.name = 'CairnFailedError';
  }
}

/** Cairn ran, said nothing went wrong, and wrote no file. (exit 1) */
export class CairnProducedNothingError extends Error {
  constructor() {
    super('Cairn finished but wrote no test file — nothing to propose.');
    this.name = 'CairnProducedNothingError';
  }
}

/** The fields of `GET /v1/test-cases/:id` this command reads. */
export interface PlatformCaseDetail {
  id: string;
  type: string;
  title: string;
  precondition?: string;
  steps?: { action: string; expected?: string }[];
  expected?: string;
}

export interface GeneratedFile {
  /** Relative to Cairn's `tests/`, forward slashes. */
  path: string;
  content: string;
}

export interface AutomateDeps {
  caseId: string;
  /** Where Cairn runs: its `.env`, `knowledge/` and `.auth/` are read from here. Default: cwd. */
  repo?: string;
  /** Cairn's executable, or its `.js` entry run with this Node. Default: `cairn` on PATH. */
  cairn?: string;
  /** The app's address, for Cairn's `report.json` — the case does not carry one. */
  url?: string;
  /** Passed to `cairn automate` after the run folder. */
  cairnArgs?: string[];
  apiUrl?: string;
  loadToken?: () => string | null;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  spawnImpl?: typeof spawn;
}

const flat = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** The case in Cairn's ATC Markdown (`parseTestCaseMd` in Cairn's `src/artifacts/testcase-md.ts`). */
export function caseToAtcMarkdown(c: PlatformCaseDetail): string {
  const steps = (c.steps ?? []).map((s, i) => `${i + 1}. ${flat(s.action)}${s.expected ? ` (expected: ${flat(s.expected)})` : ''}`);
  const pre = (c.precondition ?? '').split(/\r?\n/).map(flat).filter((l) => l !== '');
  const expected = c.expected ? [flat(c.expected)] : (c.steps ?? []).flatMap((s) => (s.expected ? [flat(s.expected)] : []));
  return [
    '---',
    'id: ATC-PLUNE-001',
    `stableId: ${c.id}`,
    `title: "${flat(c.title).replace(/"/g, "'")}"`,
    'suite: PLUNE',
    'execution: auto',
    'status: ❌ Not implemented',
    '---',
    '',
    `# ATC-PLUNE-001: ${flat(c.title)}`,
    '',
    '## Preconditions',
    '',
    ...(pre.length > 0 ? pre.map((p) => `- ${p}`) : ['- (none)']),
    '',
    '## Steps',
    '',
    ...steps,
    '',
    '## Expected Result',
    '',
    ...expected.map((e) => `- ${e}`),
    '',
  ].join('\n');
}

/**
 * The environment Cairn starts with: no `PLUNE_*` key (any case — Windows keys are case-insensitive) and no value
 * that holds the token. Provider keys and everything else pass, since Cairn needs them.
 */
export function cairnEnv(env: NodeJS.ProcessEnv, token: string): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([k, v]) => v !== undefined && !/^PLUNE_/i.test(k) && (token === '' || !v.includes(token))),
  );
}

/**
 * Cairn loads `.env` from its working directory (dotenv), and a repo's `.env` may hold `PLUNE_TOKEN`. So it gets a
 * copy without those lines instead, through `DOTENV_PATH` (dotenv 17+) and `DOTENV_CONFIG_PATH` (older).
 * Known limit: line-based; a multi-line quoted value would keep its continuation lines. A token is one line.
 */
export function filteredDotenv(text: string, token: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => {
      const key = /^\s*(?:export\s+)?([\w.-]+)\s*[=:]/.exec(line)?.[1];
      return !(key !== undefined && /^PLUNE_/i.test(key)) && (token === '' || !line.includes(token));
    })
    .join('\n');
}

/** Every file under `dir`, relative, forward slashes, sorted so a diff reads the same each time. */
function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((p) => fs.statSync(path.join(dir, p)).isFile())
    .map((p) => p.split(path.sep).join('/'))
    .sort();
}

/** New files as a unified diff `git apply` takes, under `tests/` as Cairn names them. */
export function newFilesDiff(files: GeneratedFile[]): string {
  return files
    .map((f) => {
      const p = `tests/${f.path}`;
      const head = [`diff --git a/${p} b/${p}`, 'new file mode 100644', '--- /dev/null', `+++ b/${p}`];
      if (f.content === '') return head.join('\n') + '\n';
      const lines = f.content.split('\n');
      const endsWithNewline = lines[lines.length - 1] === '';
      if (endsWithNewline) lines.pop();
      const body = lines.map((l) => `+${l}`);
      if (!endsWithNewline) body.push('\\ No newline at end of file');
      return [...head, `@@ -0,0 +1,${lines.length} @@`, ...body].join('\n') + '\n';
    })
    .join('');
}

/** `cairn` on PATH (with PATHEXT on Windows), or the path given; `undefined` when there is none. */
function findExecutable(command: string, env: NodeJS.ProcessEnv): string | undefined {
  if (command.includes('/') || command.includes('\\')) return fs.existsSync(command) ? path.resolve(command) : undefined;
  const exts = process.platform === 'win32' ? (env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  const dirs = (env['PATH'] ?? env['Path'] ?? '').split(path.delimiter).filter((d) => d !== '');
  for (const dir of dirs)
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
  return undefined;
}

/** Fetch the case, run Cairn on it in a temporary run folder, and return what it wrote. */
export async function handleAutomate(deps: AutomateDeps): Promise<{ case: PlatformCaseDetail; files: GeneratedFile[]; diff: string }> {
  for (const a of deps.cairnArgs ?? [])
    if (/^--(run|into-project)(=|$)/.test(a))
      throw new SyncFileError(`${a} is not passed to Cairn: plune automate owns the run folder and does not write into the repo.`);
  const repo = path.resolve(deps.repo ?? process.cwd());
  if (!fs.existsSync(repo) || !fs.statSync(repo).isDirectory()) throw new SyncFileError(`No directory at ${repo} (--repo).`);
  const env = deps.env ?? process.env;
  const command = deps.cairn ?? 'cairn';
  const executable = findExecutable(command, env);
  if (executable === undefined) throw new CairnMissingError(command);

  const token = (deps.loadToken ?? loadToken)();
  if (token === null) throw new NotLoggedInError();
  const get = platformGet({ ...deps, loadToken: () => token });
  let detail: PlatformCaseDetail;
  try {
    detail = await get<PlatformCaseDetail>(`/v1/test-cases/${encodeURIComponent(deps.caseId)}`);
  } catch (err) {
    if (err instanceof SyncHttpError && err.status === 404) throw new CaseNotFoundError(deps.caseId);
    throw err;
  }
  if (!detail.steps?.length) throw new CaseNotAutomatableError(deps.caseId, detail.type);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-automate-'));
  try {
    const runDir = path.join(tmp, 'run');
    fs.mkdirSync(path.join(runDir, 'testcases'), { recursive: true });
    fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify({ url: deps.url ?? '', mode: 'design' }, null, 2));
    fs.writeFileSync(path.join(runDir, 'testcases', 'ATC-PLUNE-001.md'), caseToAtcMarkdown(detail));

    const dotenvSource = env['DOTENV_PATH'] ?? env['DOTENV_CONFIG_PATH'] ?? path.join(repo, '.env');
    const dotenvCopy = path.join(tmp, 'cairn.env');
    fs.writeFileSync(dotenvCopy, fs.existsSync(dotenvSource) ? filteredDotenv(fs.readFileSync(dotenvSource, 'utf8'), token) : '');
    const childEnv = { ...cairnEnv(env, token), DOTENV_PATH: dotenvCopy, DOTENV_CONFIG_PATH: dotenvCopy };

    const args = ['automate', '--run', runDir, ...(deps.cairnArgs ?? [])];
    const isScript = /\.[cm]?js$/i.test(executable);
    const viaShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable);
    // A `.cmd` shim (what npm installs on Windows) runs only through cmd.exe; one quoted string, so no arg is split.
    const quoted = (s: string): string => `"${s.replace(/"/g, '""')}"`;
    const spawnImpl = deps.spawnImpl ?? spawn;
    const code = await new Promise<number>((resolve) => {
      // Cairn's stdout goes to our stderr: stdout is the diff's.
      const opts = { cwd: repo, env: childEnv, stdio: ['ignore', 2, 2] as ['ignore', number, number] };
      const child = isScript
        ? spawnImpl(process.execPath, [executable, ...args], opts)
        : viaShell
          ? spawnImpl([executable, ...args].map(quoted).join(' '), { ...opts, shell: true })
          : spawnImpl(executable, args, opts);
      child.on('close', (exitCode) => resolve(exitCode ?? 1));
      child.on('error', () => resolve(-1));
    });
    if (code === -1) throw new CairnMissingError(command);
    if (code !== 0) throw new CairnFailedError(code);

    const testsDir = path.join(runDir, 'tests');
    const files = filesUnder(testsDir).map((p) => ({ path: p, content: fs.readFileSync(path.join(testsDir, p), 'utf8') }));
    if (files.length === 0) throw new CairnProducedNothingError();
    return { case: detail, files, diff: newFilesDiff(files) };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** The command's rejections → a stderr line and the exit code; `null` for the unexpected. */
export function reportAutomateFailure(err: unknown, write: (s: string) => void): number | null {
  if (err instanceof CairnMissingError || err instanceof CaseNotFoundError || err instanceof CaseNotAutomatableError) {
    write(err.message + '\n');
    return 2;
  }
  if (err instanceof CairnFailedError || err instanceof CairnProducedNothingError) {
    write(err.message + '\n');
    return 1;
  }
  return reportCasesFailure(err, write);
}
