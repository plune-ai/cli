// Reading a Cairn run directory into the payload `plune ingest` uploads (ADR-CI-01).
//
// The direction of this dependency is the whole point: Plune reads Cairn's output, Cairn knows nothing
// about Plune. So this file parses Cairn's PUBLISHED artifact rather than importing its package — that
// package exports no parser, and it would drag Playwright and provider SDKs in to read a JSON file.
//
// What we depend on is the artifact's `schemaVersion`, and only that. An unknown version is refused by
// name (Plune FR-1): a shape we do not know, parsed anyway, writes plausible-looking wrong data, and
// that surfaces weeks later looking like corruption rather than like a bad assumption.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { safe, safeText } from '../../mcp-testing/scan/config/config.js';
import { redactSecrets } from '../../providers/errors.js';

/** The artifact format this reader understands. Cairn stamps it from 0.7.0 onward. */
const SUPPORTED_ARTIFACT_VERSION = 1;

/** The payload version the Plune ingest endpoint validates — ours, not Cairn's. */
const INGEST_SCHEMA_VERSION = 1;

export type CairnRunMode = 'explore' | 'design' | 'api' | 'mcp';
export type CairnExecution = 'auto' | 'manual';
/**
 * `blocked`: the case's request got no answer — Cairn's evidence records a transport error
 * after the retries — so the product never said anything either way. Sent as `failed`, it blamed the product for an
 * unreachable target. Needs a platform that accepts it; an older one refuses the payload.
 */
export type CairnVerdict = 'passed' | 'failed' | 'blocked';

export interface CairnIngestCase {
  stableId: string;
  title: string;
  execution: CairnExecution;
  steps: string[];
  expected: string;
  /** Absent means the run never executed this case — NOT "no result yet". */
  verdict?: CairnVerdict;
  technique?: string;
  priority?: string;
}

export interface CairnIngestPayload {
  schemaVersion: typeof INGEST_SCHEMA_VERSION;
  run: { runId: string; mode: CairnRunMode; target: string };
  cases: CairnIngestCase[];
}

/**
 * Nothing to auto-discover under `./runs`. Separate from `CairnRunNotFoundError` because the fix is
 * different: that one means "you pointed at the wrong directory", this one means "you pointed at
 * nothing and there was nothing to guess". (exit 2)
 */
export class NoCairnRunsError extends Error {
  constructor(runsDir: string) {
    super(`No Cairn run found under ${runsDir} — name the directory instead: plune ingest <dir>.`);
    this.name = 'NoCairnRunsError';
  }
}

/**
 * The most recently finished run under `runsDir`, judged by the mtime of its own `report.json`.
 *
 * mtime, NOT the names sorted: Cairn's run ids do not order lexicographically by time, so `sort()`
 * would confidently return whichever id happens to sort last. And the report's own timestamp rather
 * than the directory's, because a directory's mtime moves whenever anything is written inside it —
 * for an `api` run that is `api-evidence.json`, written after the report.
 *
 * The search is deliberately narrow, because this is the one place the command reads a path nobody
 * typed. It looks at the direct children of `runsDir` and nowhere else — never upward — and follows
 * no symlink: `isDirectory()` on a Dirent answers for the link itself, so a symlinked entry is
 * skipped, and the report has to be a real file. An explicit `plune ingest <dir>` is unaffected; the
 * caller named that path, so it is theirs to point wherever they like.
 */
export async function findLatestCairnRun(runsDir = 'runs'): Promise<string> {
  // Inferred, not annotated: `fs.readdir` is overloaded, and `ReturnType<typeof fs.readdir>` picks
  // the Buffer overload, which makes every `entry.name` a Buffer three lines later.
  const entries = await fs.readdir(runsDir, { withFileTypes: true }).catch(() => null);
  if (entries === null) throw new NoCairnRunsError(runsDir);

  let newest: { dir: string; at: number } | undefined;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(runsDir, entry.name);
    try {
      const report = await fs.lstat(path.join(dir, 'report.json'));
      if (!report.isFile()) continue;
      if (newest === undefined || report.mtimeMs > newest.at) {
        newest = { dir, at: report.mtimeMs };
      }
    } catch {
      // Not a run directory. A `./runs` holding notes, logs or an unfinished checkout is ordinary.
    }
  }

  if (newest === undefined) throw new NoCairnRunsError(runsDir);
  return newest.dir;
}

/** The directory holds no `report.json` — usually a mistyped path. (exit 2) */
export class CairnRunNotFoundError extends Error {
  constructor(dir: string) {
    super(
      `No Cairn run found in ${dir} — expected a report.json written by "cairn design|explore|api".`,
    );
    this.name = 'CairnRunNotFoundError';
  }
}

/** The artifact's format is one this CLI does not understand. (exit 2) */
export class CairnRunVersionError extends Error {
  constructor(found: unknown) {
    super(
      found === undefined
        ? 'This run predates versioned Cairn artifacts. Re-run it with Cairn 0.7.0 or newer, which stamps the format so it can be read safely.'
        : `Unsupported Cairn artifact version ${String(found)} (this CLI reads version ${SUPPORTED_ARTIFACT_VERSION}). Upgrade @plune-ai/cli.`,
    );
    this.name = 'CairnRunVersionError';
  }
}

/** The run failed partway; its artifact is a fragment. (exit 2) */
export class CairnRunPartialError extends Error {
  constructor(reason: string) {
    super(`That Cairn run did not finish, so its cases are incomplete: ${reason}`);
    this.name = 'CairnRunPartialError';
  }
}

/**
 * A file of the run does not have the shape this reader needs, or is too big to read. Names the file and the field,
 * and never prints the value found there: an artifact is input from outside, and a value in it may be a token or an
 * escape sequence. (exit 2)
 */
export class CairnArtifactShapeError extends Error {
  constructor(file: string, field: string, problem: string) {
    super(
      `Cannot read this Cairn run: ${file}${field === '' ? '' : field.startsWith('[') ? field : ` ${field}`} ${problem}. Nothing was uploaded.`,
    );
    this.name = 'CairnArtifactShapeError';
  }
}

/** Evidence cannot be joined to cases unambiguously. (exit 2) */
export class CairnEvidenceAmbiguousError extends Error {
  constructor(name: string) {
    super(
      `Cannot attach results safely: the operation "${name}" appears more than once in this run's evidence, ` +
        'and the evidence file carries no case identity to disambiguate it. Nothing was uploaded.',
    );
    this.name = 'CairnEvidenceAmbiguousError';
  }
}

interface EvidenceRecord {
  name: string;
  passed: boolean;
  /** Cairn's transport error, when the request got no response after the retries. */
  error?: string;
}

export interface ReadCairnRunDeps {
  /** Injected for tests; returns `undefined` when the run executed nothing and wrote no evidence. */
  readEvidence?: (dir: string) => Promise<EvidenceRecord[] | undefined>;
}

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};

const str = (v: unknown, fallback = ''): string =>
  typeof v === 'string' && v !== '' ? v : fallback;

/** An own property only: a key like `constructor` or `__proto__` in a file must not reach the prototype chain. */
const own = (rec: Record<string, unknown>, key: string): unknown =>
  Object.hasOwn(rec, key) ? rec[key] : undefined;

/** The most a Cairn JSON file may weigh, checked from the file's size before a byte of it is read. */
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
/** The most cases of one `mcp` run this reader maps. */
const MAX_MCP_CASES = 5000;

/** Refuses a file over the limit, from `stat`. Returns false when the file is not there. */
async function checkSize(dir: string, file: string): Promise<boolean> {
  let size: number;
  try {
    const st = await fs.stat(path.join(dir, file));
    if (!st.isFile()) throw new CairnArtifactShapeError(file, '', 'is not a regular file');
    size = st.size;
  } catch (e) {
    if (e instanceof CairnArtifactShapeError) throw e;
    return false;
  }
  if (size > MAX_ARTIFACT_BYTES) {
    throw new CairnArtifactShapeError(
      file,
      '',
      `is larger than ${MAX_ARTIFACT_BYTES / (1024 * 1024)} MiB`,
    );
  }
  return true;
}

async function readJson(file: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

const ARGS_CHARS = 200;
const SECRET_NAME = /key|token|secret|password|passwd|auth|cookie|credential/i;
const maskNamed = (v: unknown, depth = 0): unknown => {
  if (depth > 16) return '[deep]';
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => maskNamed(x, depth + 1));
  if (typeof v === 'object' && v !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v).slice(0, 50)) {
      out[k] = SECRET_NAME.test(k) ? '***' : maskNamed(x, depth + 1);
    }
    return out;
  }
  return v;
};

/**
 * The arguments of a call as a masked, bounded text. Masked first and cut after: a token that straddles the cut
 * would otherwise leave its head in the text. Cairn masks what it writes, but this file is input, so it is masked
 * again here: by the name of an argument that says it is a credential, by the look of a token, and a Bearer value.
 */
function describeMcpArgs(request: string): string {
  let text = request.slice(0, 4096);
  try {
    text = JSON.stringify(maskNamed(JSON.parse(text) as unknown));
  } catch {
    // Cut mid-value or not JSON: the text is masked by its look below.
  }
  const masked = safeText(redactSecrets(text));
  return masked.length > ARGS_CHARS ? `${masked.slice(0, ARGS_CHARS)} (cut)` : masked;
}

type McpState = 'passed' | 'failed' | 'not-sent' | 'could-not-run' | 'needs-review';
const MCP_STATES: ReadonlySet<string> = new Set([
  'passed',
  'failed',
  'not-sent',
  'could-not-run',
  'needs-review',
]);

interface McpEvidence {
  /** The call went out: Cairn timed it. */
  sent: boolean;
  request?: string;
}

/** `mcp-evidence.json`, strictly: a list of objects, each with an own stableId; `undefined` when the file is absent. */
async function readMcpEvidence(
  dir: string,
  states: Map<string, string>,
): Promise<Map<string, McpEvidence> | undefined> {
  const file = 'mcp-evidence.json';
  if (!(await checkSize(dir, file))) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8')) as unknown;
  } catch {
    throw new CairnArtifactShapeError(file, '', 'is not valid JSON');
  }
  if (!Array.isArray(raw)) throw new CairnArtifactShapeError(file, '', 'must be a list');
  if (raw.length > MAX_MCP_CASES) {
    throw new CairnArtifactShapeError(file, '', `lists more than ${MAX_MCP_CASES} entries`);
  }
  const byId = new Map<string, McpEvidence>();
  raw.forEach((item: unknown, i) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new CairnArtifactShapeError(file, `[${i}]`, 'must be an object');
    }
    const rec = item as Record<string, unknown>;
    const id = own(rec, 'stableId');
    if (typeof id !== 'string' || !states.has(id)) {
      throw new CairnArtifactShapeError(
        file,
        `[${i}].stableId`,
        'does not name a case of report.json',
      );
    }
    if (byId.has(id)) {
      throw new CairnArtifactShapeError(file, `[${i}].stableId`, 'appears more than once');
    }
    if (own(rec, 'state') !== states.get(id)) {
      throw new CairnArtifactShapeError(
        file,
        `[${i}].state`,
        'does not agree with the state in report.json',
      );
    }
    const request = own(rec, 'request');
    if (request !== undefined && typeof request !== 'string') {
      throw new CairnArtifactShapeError(file, `[${i}].request`, 'must be text');
    }
    const durationMs = own(rec, 'durationMs');
    if (durationMs !== undefined && typeof durationMs !== 'number') {
      throw new CairnArtifactShapeError(file, `[${i}].durationMs`, 'must be a number');
    }
    byId.set(id, {
      sent: typeof durationMs === 'number',
      ...(request !== undefined ? { request } : {}),
    });
  });
  return byId;
}

/** What each kind of case is expected to do, in plain words: it is what a reviewer reads. */
function expectedOfMcp(type: 'Positive' | 'Negative', adversarial: boolean): string {
  if (type === 'Positive') {
    return "The call finishes without an error, and the answer fits the tool's outputSchema when it has one.";
  }
  return adversarial
    ? 'The server rejects the call, or handles the value without harm.'
    : "The server rejects the call: it does not act on a value the tool's inputSchema forbids.";
}

/**
 * Cases a `cairn mcp-test` run wrote. `report.json` lists the cases with a state each; `mcp-evidence.json`
 * (optional) holds the call text and whether the call went out.
 *
 *   passed        -> passed
 *   failed        -> failed
 *   could-not-run -> blocked when the call went out and got no answer; no verdict when it was never sent
 *                    (the run stopped first), because "no answer" would blame a call nobody made
 *   not-sent      -> no verdict: the guard refused it, the server never saw it
 *   needs-review  -> no verdict: an answer a rule cannot judge, a person must; passed or failed would be a guess
 */
async function casesFromMcp(
  dir: string,
  report: Record<string, unknown>,
): Promise<CairnIngestCase[]> {
  const list = own(report, 'cases');
  if (!Array.isArray(list))
    throw new CairnArtifactShapeError('report.json', 'cases', 'must be a list');
  if (list.length > MAX_MCP_CASES) {
    throw new CairnArtifactShapeError(
      'report.json',
      'cases',
      `lists more than ${MAX_MCP_CASES} cases`,
    );
  }

  const states = new Map<string, string>();
  const parsed = list.map((raw: unknown, i) => {
    const at = `cases[${i}]`;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new CairnArtifactShapeError('report.json', at, 'must be an object');
    }
    const c = raw as Record<string, unknown>;
    const text = (key: string): string => {
      const v = own(c, key);
      if (typeof v !== 'string' || v === '') {
        throw new CairnArtifactShapeError('report.json', `${at}.${key}`, 'must be text');
      }
      return v;
    };
    const stableId = text('stableId');
    const name = text('name');
    const tool = text('tool');
    const type = text('type');
    const state = text('state');
    if (type !== 'Positive' && type !== 'Negative') {
      throw new CairnArtifactShapeError(
        'report.json',
        `${at}.type`,
        `is "${safe(type)}", not Positive or Negative`,
      );
    }
    if (!MCP_STATES.has(state)) {
      throw new CairnArtifactShapeError(
        'report.json',
        `${at}.state`,
        `is "${safe(state)}", a state this CLI does not know`,
      );
    }
    if (states.has(stableId)) {
      throw new CairnArtifactShapeError('report.json', `${at}.stableId`, 'appears more than once');
    }
    states.set(stableId, state);
    const kind: 'Positive' | 'Negative' = type;
    const technique = own(c, 'technique');
    return {
      stableId,
      name,
      tool,
      type: kind,
      state: state as McpState,
      adversarial: own(c, 'adversarialStyle') !== undefined,
      ...(typeof technique === 'string' ? { technique } : {}),
    };
  });

  const evidence = await readMcpEvidence(dir, states);
  return parsed.map((c): CairnIngestCase => {
    const e = evidence?.get(c.stableId);
    const verdict: CairnVerdict | undefined =
      c.state === 'passed'
        ? 'passed'
        : c.state === 'failed'
          ? 'failed'
          : c.state === 'could-not-run' && e?.sent === true
            ? 'blocked'
            : undefined;
    const args = e?.request !== undefined ? ` ${describeMcpArgs(e.request)}` : '';
    return {
      stableId: c.stableId,
      title: safeText(c.name),
      execution: 'auto',
      steps: [`tools/call ${safe(c.tool)}${args}`],
      expected: expectedOfMcp(c.type, c.adversarial),
      ...(verdict !== undefined ? { verdict } : {}),
      ...(c.technique !== undefined ? { technique: safeText(c.technique) } : {}),
    };
  });
}

async function defaultReadEvidence(dir: string): Promise<EvidenceRecord[] | undefined> {
  const raw = await readJson(path.join(dir, 'api-evidence.json'));
  if (!Array.isArray(raw)) return undefined;
  return raw.map((r) => {
    const rec = asRecord(r);
    const error = str(rec['error']);
    return { name: str(rec['name']), passed: rec['passed'] === true, ...(error !== '' ? { error } : {}) };
  });
}

/**
 * Cases a page-exploring run designed. Both `design` and `explore` write them under the same key with
 * the same fields; only `explore`'s validation report differs, and it is not mapped here — an
 * explored case arrives without a verdict rather than with a guessed one.
 */
function casesFromDesign(report: Record<string, unknown>): CairnIngestCase[] {
  const list = Array.isArray(report['testCases']) ? report['testCases'] : [];
  return list.map((raw) => {
    const c = asRecord(raw);
    const steps = (Array.isArray(c['steps']) ? c['steps'] : [])
      .map((s) => str(s))
      .filter((s) => s !== '');
    return {
      stableId: str(c['stableId']),
      title: str(c['title'], 'untitled case'),
      execution: c['execution'] === 'manual' ? ('manual' as const) : ('auto' as const),
      steps: steps.length > 0 ? steps : ['(no steps recorded)'],
      expected: str(c['expected'], '(no expected result recorded)'),
      ...(typeof c['technique'] === 'string' ? { technique: c['technique'] } : {}),
      ...(typeof c['priority'] === 'string' ? { priority: c['priority'] } : {}),
    };
  });
}

/**
 * Cases an API run generated. Cairn describes these as a request plus the status it expects, so they
 * are restated in the vocabulary the rest of the system uses — the request becomes the step, the
 * declared status becomes the expectation. That is a translation of what the case already says, not an
 * invention of detail it does not carry.
 */
function casesFromApi(
  report: Record<string, unknown>,
  verdicts: Map<string, CairnVerdict>,
): CairnIngestCase[] {
  const list = Array.isArray(report['cases']) ? report['cases'] : [];
  return list.map((raw) => {
    const c = asRecord(raw);
    const name = str(c['name'], 'unnamed operation');
    const request = `${str(c['method'], 'GET')} ${str(c['path'], '/')}`;
    const verdict = verdicts.get(name);
    return {
      stableId: str(c['stableId']),
      title: name,
      execution: 'auto' as const,
      steps: [request],
      expected: `HTTP ${str(c['expectedStatus'], 'default')}`,
      ...(verdict !== undefined ? { verdict } : {}),
      ...(typeof c['technique'] === 'string' ? { technique: c['technique'] } : {}),
    };
  });
}

/**
 * Read a Cairn run directory into an upload payload, or throw a typed error explaining why not.
 *
 * Pure apart from the two file reads, which are injectable, so the mapping rules can be exercised
 * against real artifacts without a filesystem dance.
 */
export async function readCairnRun(
  dir: string,
  deps: ReadCairnRunDeps = {},
): Promise<CairnIngestPayload> {
  await checkSize(dir, 'report.json');
  const raw = await readJson(path.join(dir, 'report.json'));
  if (raw === undefined) throw new CairnRunNotFoundError(dir);

  const report = asRecord(raw);
  if (report['schemaVersion'] !== SUPPORTED_ARTIFACT_VERSION) {
    throw new CairnRunVersionError(report['schemaVersion']);
  }
  if (report['partial'] === true) {
    throw new CairnRunPartialError(str(report['error'], 'no reason recorded'));
  }

  const mode = report['mode'];
  if (mode !== 'design' && mode !== 'explore' && mode !== 'api' && mode !== 'mcp') {
    // Every artifact states its kind from 0.7.0 on, so reaching here means a kind newer than this
    // reader. Inferring it from which keys happen to be present is exactly the guess FR-1a forbids.
    throw new CairnRunVersionError(
      `${SUPPORTED_ARTIFACT_VERSION} (unknown run mode ${String(mode)})`,
    );
  }

  let cases: CairnIngestCase[];
  if (mode === 'api') {
    const evidence = await (deps.readEvidence ?? defaultReadEvidence)(dir);
    const verdicts = new Map<string, CairnVerdict>();
    for (const e of evidence ?? []) {
      if (verdicts.has(e.name)) throw new CairnEvidenceAmbiguousError(e.name);
      // No answer first, as the platform classifies: a request that never reached the product is no verdict on it.
      verdicts.set(e.name, e.error !== undefined ? 'blocked' : e.passed ? 'passed' : 'failed');
    }
    cases = casesFromApi(report, verdicts);
  } else if (mode === 'mcp') {
    cases = await casesFromMcp(dir, report);
  } else {
    cases = casesFromDesign(report);
  }

  return {
    schemaVersion: INGEST_SCHEMA_VERSION,
    run: {
      runId: str(report['runId'], path.basename(dir)),
      mode,
      target: str(report['url'], 'unknown'),
    },
    cases,
  };
}

/** A run's recordings (`--screencast`): each case's video and trace files, by its `stableId`. */
export interface CairnSessionFiles {
  /** Absolute paths, inside the run directory, by the case's `stableId`. */
  byCase: Map<string, string[]>;
  /** Recordings that name no case: a hand-written spec, a test the model did not map, or a Cairn older than the id. */
  unmapped: number;
  /** Paths dropped because they lead out of the run directory, by their text or through a link. */
  outside: number;
}

/**
 * `screencasts/screencasts.json`: per recorded test its `.webm`, its trace when one was written, and the case's `stableId`.
 * `undefined` when the run recorded nothing or the file cannot be read: the recordings are a review aid, never a reason to
 * refuse the run. A path that leaves the run directory is dropped and counted: this file is input, and it must not pick what
 * is uploaded.
 */
export async function readCairnSessionFiles(dir: string): Promise<CairnSessionFiles | undefined> {
  const raw = await readJson(path.join(dir, 'screencasts', 'screencasts.json'));
  if (!Array.isArray(raw)) return undefined;
  // Compared as the disk resolves them: a symlink or a junction (the file's, or a directory's on its way) can lead out of the run.
  const root = await fs.realpath(dir).catch(() => path.resolve(dir));
  const within = (p: string): boolean => {
    const rel = path.relative(root, p);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  };
  let outside = 0;
  /** The file's real path when it stays inside the run; a missing file keeps its own, and the upload says it is missing. */
  const inside = async (p: unknown): Promise<string | undefined> => {
    if (typeof p !== 'string' || p === '') return undefined;
    const abs = path.resolve(root, p);
    const real = await fs.realpath(abs).catch(() => undefined);
    if (within(abs) && (real === undefined || within(real))) return real ?? abs;
    outside += 1;
    return undefined;
  };
  const byCase = new Map<string, string[]>();
  let unmapped = 0;
  for (const entry of raw) {
    const rec = asRecord(entry);
    const files: string[] = [];
    for (const p of [own(rec, 'video'), own(rec, 'trace')]) {
      const file = await inside(p);
      if (file !== undefined) files.push(file);
    }
    if (files.length === 0) continue; // whatever paths it named are counted in `outside`
    const stableId = own(rec, 'stableId');
    if (typeof stableId !== 'string' || stableId === '') unmapped += 1;
    else byCase.set(stableId, [...(byCase.get(stableId) ?? []), ...files]);
  }
  return { byCase, unmapped, outside };
}
