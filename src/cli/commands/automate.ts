// `plune automate <caseId>` (#148): a case from the platform → Cairn's `automate` → the code it wrote, as a diff.
//
// The direction of the dependency is the platform's decision: the CLI knows about Cairn, Cairn knows nothing about
// Plune. So Cairn gets the case as a file in its own published format (a run folder with `report.json` and one
// `testcases/ATC-*.md`), and an environment with no `PLUNE_*` variable and no token in it (Cairn ADR-0010).
//
// What comes back is a diff of new files. The main copy of the code lives in the user's repo; writing it there is
// the user's or their CI's job, so nothing here touches the repo. The diff goes to stdout; with `--send` the same
// files go to the review queue as an automation proposal (`POST /v1/review-items/automations`),
// with the case's `test()` call named as the code a person approves.

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveApiUrl } from '../api-url.js';
import { loadToken } from '../credentials.js';
import { platformGet } from './plan.js';
import { NotLoggedInError, SyncFileError, SyncHttpError, SyncNetworkError, TokenRejectedError } from './sync.js';
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
  /** sha256 of the case's `codeSnapshot`, when it has one: the proposal's `baseHash`. */
  codeSnapshotHash?: string;
}

export interface GeneratedFile {
  /** Relative to Cairn's `tests/`, forward slashes. */
  path: string;
  content: string;
}

export interface AutomateResult {
  case: PlatformCaseDetail;
  files: GeneratedFile[];
  diff: string;
  /** What `cairn --version` said, when asked (`withCairnVersion`). */
  cairnVersion?: string;
}

// The bounds of `automationInputSchema` and its proposal in the platform's `src/contracts/review-item.ts`.
// The server refuses an over-bound file on its own and still queues the rest; checking here first
// means nothing is sent that a person could not approve.
export const AUTOMATION_FILES_MAX = 10;
export const AUTOMATION_FILE_MAX_BYTES = 16_384; // TEXT_FIELD_MAX_BYTES
export const AUTOMATION_TOTAL_MAX_BYTES = 65_536;
export const AUTOMATION_PATH_MAX = 400; // DISCOVERED_SPEC_REF_MAX, the bound of specRef too
const AUTOMATION_ORIGIN_MAX = 32;

/** The body of `POST /v1/review-items/automations` (`automationInputSchema`, strict). */
export interface AutomationInput {
  testCaseId: string;
  /** Where the case's test lives: one of `files[].path`. */
  caseFile: string;
  /** The case's `test()` call, word for word as it stands in `caseFile`: what approval writes as its code snapshot. */
  snapshot: string;
  /** `path:line` of that call. */
  specRef: string;
  files: { path: string; content: string }[];
  baseHash?: string;
  origin: { tool: string; version: string; cliVersion?: string };
}

/** The proposal is over a bound of the contract; nothing was sent. (exit 2) */
export class ProposalBoundsError extends Error {
  constructor(readonly problems: string[]) {
    super(`Not sent: the proposal is over the review queue's bounds —\n${problems.map((p) => `  ${p}`).join('\n')}\nThe diff above is complete; apply it yourself, or have Cairn write less.`);
    this.name = 'ProposalBoundsError';
  }
}

/** Cairn's files hold no `test()` call to name as the case's code. (exit 1) */
export class NoTestCallError extends Error {
  constructor() {
    super("Not sent: none of Cairn's files has a test() call to name as the case's code.");
    this.name = 'NoTestCallError';
  }
}

/** The platform answered the proposal with a refusal; its status, code and words. (exit 1) */
export class ProposalRefusedError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    detail: string,
  ) {
    super(`The platform refused the proposal — HTTP ${status}${code ? ` ${code}` : ''}${detail ? `: ${detail}` : ''}.`);
    this.name = 'ProposalRefusedError';
  }
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
  /** Also run `cairn --version` (same environment) for the proposal's `origin`. Only `--send` needs it. */
  withCairnVersion?: boolean;
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
export async function handleAutomate(deps: AutomateDeps): Promise<AutomateResult> {
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

    const isScript = /\.[cm]?js$/i.test(executable);
    const viaShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable);
    // A `.cmd` shim (what npm installs on Windows) runs only through cmd.exe; one quoted string, so no arg is split.
    const quoted = (s: string): string => `"${s.replace(/"/g, '""')}"`;
    const spawnImpl = deps.spawnImpl ?? spawn;
    // Every start of Cairn goes through here, so every one gets `childEnv` and nothing else.
    const runCairn = (args: string[], capture: boolean) =>
      new Promise<{ code: number; out: string }>((resolve) => {
        // Cairn's stdout goes to our stderr (stdout is the diff's), unless it is read, as `--version` is.
        const opts = { cwd: repo, env: childEnv, stdio: ['ignore', capture ? 'pipe' : 2, 2] as ['ignore', 'pipe' | number, number] };
        const child = isScript
          ? spawnImpl(process.execPath, [executable, ...args], opts)
          : viaShell
            ? spawnImpl([executable, ...args].map(quoted).join(' '), { ...opts, shell: true })
            : spawnImpl(executable, args, opts);
        let out = '';
        child.stdout?.on('data', (chunk: Buffer) => void (out += chunk.toString('utf8')));
        child.on('close', (exitCode) => resolve({ code: exitCode ?? 1, out }));
        child.on('error', () => resolve({ code: -1, out }));
      });

    const { code } = await runCairn(['automate', '--run', runDir, ...(deps.cairnArgs ?? [])], false);
    if (code === -1) throw new CairnMissingError(command);
    if (code !== 0) throw new CairnFailedError(code);

    const testsDir = path.join(runDir, 'tests');
    const files = filesUnder(testsDir).map((p) => ({ path: p, content: fs.readFileSync(path.join(testsDir, p), 'utf8') }));
    if (files.length === 0) throw new CairnProducedNothingError();
    const result = { case: detail, files, diff: newFilesDiff(files) };
    if (!deps.withCairnVersion) return result;
    // `cairn --version` prints the version alone; whatever it prints, the first version-looking word, else "unknown".
    const v = await runCairn(['--version'], true);
    const cairnVersion = (v.code === 0 ? /\d+\.\d+[\w.+-]*/.exec(v.out)?.[0] : undefined) ?? 'unknown';
    return { ...result, cairnVersion: cairnVersion.slice(0, AUTOMATION_ORIGIN_MAX) };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** A `/` here starts a regex literal, not a division: the last code character before it is one of these, or none. */
const REGEX_AFTER = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);

/** Past a string, template, comment or regex literal that starts at `i`; `i` itself when none starts there. */
function skipNonCode(s: string, i: number, prev: string): number {
  const c = s[i];
  const d = s[i + 1];
  if (c === '/' && d === '/') {
    const e = s.indexOf('\n', i);
    return e === -1 ? s.length : e;
  }
  if (c === '/' && d === '*') {
    const e = s.indexOf('*/', i + 2);
    return e === -1 ? s.length : e + 2;
  }
  if (c === '"' || c === "'") {
    let j = i + 1;
    while (j < s.length && s[j] !== c && s[j] !== '\n') j += s[j] === '\\' ? 2 : 1;
    return j + 1;
  }
  if (c === '`') {
    let j = i + 1;
    while (j < s.length && s[j] !== '`') {
      if (s[j] === '\\') j += 2;
      else if (s[j] === '$' && s[j + 1] === '{') j = closeOf(s, j + 2, '{', '}');
      else j++;
    }
    return j + 1;
  }
  if (c === '/' && REGEX_AFTER.has(prev)) {
    let j = i + 1;
    let inClass = false;
    while (j < s.length && s[j] !== '\n' && (s[j] !== '/' || inClass)) {
      if (s[j] === '\\') j++;
      else if (s[j] === '[') inClass = true;
      else if (s[j] === ']') inClass = false;
      j++;
    }
    j++;
    while (/[a-z]/i.test(s[j] ?? '')) j++;
    return j;
  }
  return i;
}

/** The index just past the `close` that matches an `open` before `i`; the end of `s` when there is none. */
function closeOf(s: string, i: number, open: string, close: string): number {
  let depth = 1;
  let prev = open;
  while (i < s.length) {
    const j = skipNonCode(s, i, prev);
    if (j !== i) {
      i = j;
      prev = ')';
      continue;
    }
    const c = s[i]!;
    if (c === open) depth++;
    else if (c === close && --depth === 0) return i + 1;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return s.length;
}

/**
 * The first test declared in a spec file — `test(…)`, or `test.skip/only/fixme/fail(…)` whose last argument is a function
 * body — as its exact text and 1-based line. That is what the platform keeps as a case's code snapshot: the call from its
 * callee to its closing parenthesis, as its import cuts it. A scanner, not a parser: strings, templates, comments and regex
 * literals are stepped over so a parenthesis in them does not end the call. Known limit: a function with an expression
 * body (`() => x`) as the last argument is not taken for a declaration.
 */
export function findTestCall(src: string): { text: string; line: number } | undefined {
  const head = /test(?:\.(?:skip|only|fixme|fail))?\s*\(/y;
  let prev = '';
  for (let i = 0; i < src.length; ) {
    const j = skipNonCode(src, i, prev);
    if (j !== i) {
      i = j;
      prev = ')';
      continue;
    }
    head.lastIndex = i;
    if (!/[\w$.]/.test(src[i - 1] ?? '') && head.test(src)) {
      const end = closeOf(src, head.lastIndex, '(', ')');
      const text = src.slice(i, end);
      if (/\}\s*,?\s*\)$/.test(text)) return { text, line: src.slice(0, i).split('\n').length };
      i = end;
      prev = ')';
      continue;
    }
    if (!/\s/.test(src[i]!)) prev = src[i]!;
    i++;
  }
  return undefined;
}

const bytesOf = (s: string): number => Buffer.byteLength(s, 'utf8');

/**
 * What `--send` posts: the files the diff shows (the same `tests/…` paths, whole), the first spec file's first test as
 * the case's code, the case's current code hash as `baseHash`. Over a bound of the contract, nothing is sent.
 */
export function automationProposal(out: AutomateResult, cliVersion: string): AutomationInput {
  const files = out.files.map((f) => ({ path: `tests/${f.path}`, content: f.content }));
  const problems: string[] = [];
  if (files.length > AUTOMATION_FILES_MAX) problems.push(`${files.length} files, at most ${AUTOMATION_FILES_MAX}`);
  for (const f of files) {
    if (f.path.length > AUTOMATION_PATH_MAX) problems.push(`${f.path}: a path of ${f.path.length} characters, at most ${AUTOMATION_PATH_MAX}`);
    const bytes = bytesOf(f.content);
    if (bytes > AUTOMATION_FILE_MAX_BYTES) problems.push(`${f.path}: ${bytes} bytes, at most ${AUTOMATION_FILE_MAX_BYTES} a file`);
  }
  const total = files.reduce((n, f) => n + bytesOf(f.content), 0);
  if (total > AUTOMATION_TOTAL_MAX_BYTES) problems.push(`${total} bytes in all, at most ${AUTOMATION_TOTAL_MAX_BYTES}`);

  const specFirst = [...files].sort((a, b) => Number(isSpec(b.path)) - Number(isSpec(a.path)));
  let found: { file: string; text: string; line: number } | undefined;
  for (const f of specFirst) {
    const call = findTestCall(f.content);
    if (call !== undefined) {
      found = { file: f.path, ...call };
      break;
    }
  }
  if (found === undefined) {
    if (problems.length > 0) throw new ProposalBoundsError(problems);
    throw new NoTestCallError();
  }
  const specRef = `${found.file}:${found.line}`;
  if (specRef.length > AUTOMATION_PATH_MAX) problems.push(`specRef ${specRef.slice(0, 40)}…: at most ${AUTOMATION_PATH_MAX} characters`);
  if (problems.length > 0) throw new ProposalBoundsError(problems);
  return {
    testCaseId: out.case.id,
    caseFile: found.file,
    snapshot: found.text,
    specRef,
    files,
    ...(out.case.codeSnapshotHash === undefined ? {} : { baseHash: out.case.codeSnapshotHash }),
    origin: { tool: 'cairn', version: out.cairnVersion ?? 'unknown', cliVersion: cliVersion.slice(0, AUTOMATION_ORIGIN_MAX) },
  };
}

const isSpec = (p: string): boolean => /\.(spec|test)\.[cm]?[jt]sx?$/.test(p);

/** What the queue answered: the entry, and whether it replaced a proposal that was waiting for the case. */
export interface SentAutomation {
  id: string;
  replaced: boolean;
  revision: number;
  /** Files the server did not keep (over a bound, a path it does not take, not text). */
  refused: { path: string; bytes: number; reason: string }[];
}

/** `POST /v1/review-items/automations`: 201 a new entry, 200 the one waiting for the case replaced. */
export async function sendAutomation(
  input: AutomationInput,
  deps: Pick<AutomateDeps, 'apiUrl' | 'loadToken' | 'fetchImpl'> = {},
): Promise<SentAutomation> {
  const apiUrl = resolveApiUrl(deps.apiUrl);
  const token = (deps.loadToken ?? loadToken)();
  if (token === null) throw new NotLoggedInError();
  let res: Response;
  try {
    res = await (deps.fetchImpl ?? fetch)(`${apiUrl}/v1/review-items/automations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(input),
    });
  } catch {
    throw new SyncNetworkError(apiUrl);
  }
  const body = (await res.json().catch(() => ({}))) as {
    id?: string;
    revision?: number;
    automation?: { refused?: SentAutomation['refused'] };
    error?: unknown;
    code?: unknown;
  };
  if (res.status === 401) throw new TokenRejectedError();
  if (!res.ok) {
    throw new ProposalRefusedError(
      res.status,
      typeof body.code === 'string' ? body.code : undefined,
      typeof body.error === 'string' ? body.error : '',
    );
  }
  return { id: String(body.id ?? ''), replaced: res.status === 200, revision: body.revision ?? 1, refused: body.automation?.refused ?? [] };
}

/** The stderr lines for a sent proposal. */
export function formatSent(sent: SentAutomation, title: string): string {
  const head = sent.replaced
    ? `Replaced the proposal waiting for '${title}': review item ${sent.id}, now revision ${sent.revision}.`
    : `Queued a new proposal for '${title}': review item ${sent.id}.`;
  const refused = sent.refused.map((r) => `  not kept by the server: ${r.path} (${r.bytes} bytes, ${r.reason})`);
  return [head, ...refused].join('\n') + '\n';
}

/** The command's rejections → a stderr line and the exit code; `null` for the unexpected. */
export function reportAutomateFailure(err: unknown, write: (s: string) => void): number | null {
  if (
    err instanceof CairnMissingError ||
    err instanceof CaseNotFoundError ||
    err instanceof CaseNotAutomatableError ||
    err instanceof ProposalBoundsError
  ) {
    write(err.message + '\n');
    return 2;
  }
  if (
    err instanceof CairnFailedError ||
    err instanceof CairnProducedNothingError ||
    err instanceof NoTestCallError ||
    err instanceof ProposalRefusedError
  ) {
    write(err.message + '\n');
    return 1;
  }
  return reportCasesFailure(err, write);
}
