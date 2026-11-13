// `plune mcp conformance`: the server against the text of the specification. Connect, run each selected check of
// the catalog (or say why it does not apply), score the run against the frozen profile, print one report, write it
// to each --out (JSON or JUnit XML), and say by the exit code whether every counted check passed (0), one failed (1), or the run did not
// establish conformance (3). Exit 2: the server did not start or a flag is wrong. `--list-checks` and `--explain`
// print the catalog without connecting. The model (catalog, states, score, profile) is in
// src/mcp-testing/conformance/; nothing here judges an answer.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  connectionConfig,
  UsageError,
  type ConnectionFlags,
} from '../../mcp-testing/connect/options.js';
import { redactorFor } from '../../mcp-testing/connect/redact.js';
import { ConnectError, openSession, type Session } from '../../mcp-testing/connect/session.js';
import {
  CATALOG,
  catalogEntry,
  SUITES,
  specUrl,
  type CatalogEntry,
  type Suite,
} from '../../mcp-testing/conformance/catalog.js';
import {
  IMPLEMENTATIONS,
  type ConformanceContext,
  type FixtureCall,
} from '../../mcp-testing/conformance/checks/index.js';
import { initializeProblems } from '../../mcp-testing/conformance/checks/lifecycle.js';
import { applicability, eraOf, type CheckOutcome } from '../../mcp-testing/conformance/outcome.js';
import { manifestDigest, PROFILE } from '../../mcp-testing/conformance/profile.js';
import { BUCKETS, exitCodeOf, summarize } from '../../mcp-testing/conformance/score.js';
import { MCP_EXIT } from '../../mcp-testing/exit-codes.js';
import { noCommands, noCommandsJson } from '../../mcp-testing/report/human.js';
import { conformanceRun, reportOutputs, writeReport } from '../../mcp-testing/report/index.js';
import type { ConformanceResult, McpConformanceReport } from '../../mcp-testing/result.js';
import { printable } from '../../reporter-core/failure-detail.js';

export interface McpConformanceFlags extends ConnectionFlags {
  suite?: string[];
  check?: string[];
  protocolVersion?: string;
  format?: string;
  reporter?: string;
  /** Repeatable; a string from a caller that passes one. */
  out?: string | string[];
  listChecks?: boolean;
  explain?: string;
  fixture?: string;
}

export interface ConformanceIo {
  out(text: string): void;
  err(text: string): void;
  env: NodeJS.ProcessEnv;
  cwd?: string;
  clientVersion?: string;
}

const FORMATS = ['human', 'json'] as const;
const REVISION = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TEXT = 500;
const cut = (text: string) =>
  text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT)}… (cut: ${text.length} characters)`;
/** The check every other one rests on: without a handshake, the rest are could-not-run (prerequisite-failed). */
const HANDSHAKE_CHECK = 'life-initialize-result';
/** After this many timeouts in a row, the checks left are not tried: each would wait out --timeout as well. */
const TIMEOUTS_IN_A_ROW = 2;

/**
 * `--fixture`: a JSON list of `{ "tool": name, "arguments": {...} }`, the only tools a run calls. A file that is not
 * such a list is a flag error, before the server starts.
 */
function loadFixture(path: string): FixtureCall[] {
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new UsageError(`--fixture: could not read ${path} as JSON${code === undefined ? '' : ` (${code})`}.`);
  }
  if (!Array.isArray(doc)) throw new UsageError('--fixture must hold a JSON list of { "tool": "<name>", "arguments": { ... } }.');
  return doc.map((entry, i) => {
    const e = entry as { tool?: unknown; arguments?: unknown } | null;
    const args = e?.arguments ?? {};
    if (typeof e?.tool !== 'string' || e.tool === '' || args === null || typeof args !== 'object' || Array.isArray(args))
      throw new UsageError(`--fixture entry ${i + 1} needs "tool" (a name) and, when given, "arguments" (an object).`);
    return { tool: e.tool, arguments: args as Record<string, unknown> };
  });
}

export async function handleMcpConformance(
  flags: McpConformanceFlags,
  server: string[],
  raw: ConformanceIo,
): Promise<number> {
  const io: ConformanceIo = {
    ...raw,
    out: (text) => raw.out(noCommands(text)),
    err: (text) => raw.err(noCommands(text)),
  };
  try {
    return await conformance(flags, server, io, raw.out);
  } catch (err) {
    if (err instanceof UsageError || err instanceof ConnectError) {
      io.err(`plune mcp conformance: ${err.message}\n`);
      if (err instanceof ConnectError && err.stderrTail.length > 0)
        io.err(
          `The last lines the server wrote to stderr:\n${err.stderrTail.map((l) => `  ${l}\n`).join('')}`,
        );
      return MCP_EXIT.usage;
    }
    throw err;
  }
}

function oneOf<T extends string>(flag: string, value: string, allowed: readonly T[]): T {
  if (!(allowed as readonly string[]).includes(value))
    throw new UsageError(`${flag} must be one of ${allowed.join(', ')} (got "${value}").`);
  return value as T;
}

const json = (value: unknown) => `${noCommandsJson(JSON.stringify(value, null, 2))}\n`;

/** The checks the flags select, in catalog order; an unknown id, or one outside the suites, is a flag error. */
function selection(flags: McpConformanceFlags): { suites: Suite[]; entries: CatalogEntry[] } {
  const suites = [...new Set((flags.suite ?? ['protocol']).map((s) => oneOf('--suite', s, SUITES)))];
  const ids = flags.check ?? [];
  for (const id of ids) {
    const entry = catalogEntry(id);
    if (entry === undefined)
      throw new UsageError(`--check ${id}: no such check (plune mcp conformance --list-checks lists them).`);
    if (!suites.includes(entry.suite))
      throw new UsageError(`--check ${id} is in the ${entry.suite} suite: add --suite ${entry.suite}.`);
  }
  const entries = CATALOG.filter(
    (e) => suites.includes(e.suite) && (ids.length === 0 || ids.includes(e.id)),
  );
  return { suites, entries };
}

function catalogText(entries: readonly CatalogEntry[]): string {
  const rows = entries.map((e) => [
    e.id,
    e.suite,
    e.kind === 'check' ? `${e.level}${e.derived ? '*' : ''}` : e.kind,
    e.eras.join('+'),
    e.transports.join('+'),
    PROFILE.checks.includes(e.id) ? 'scored' : '',
  ]);
  const head = ['id', 'suite', 'level', 'eras', 'transports', 'profile'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (r: string[]) => r.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ').trimEnd();
  return `${[head, ...rows].map(line).join('\n')}\n\n${entries.length} checks. * level derived from neighbouring provisions. Profile ${PROFILE.id} ${PROFILE.version}: ${PROFILE.checks.length} scored.\n`;
}

function explainText(e: CatalogEntry): string {
  const lines = [
    `${e.id}: ${e.title}`,
    e.description,
    `suite: ${e.suite}`,
    `kind: ${e.kind}`,
    `level: ${e.level ?? 'none'}${e.derived ? ` (derived: ${e.derivation ?? ''})` : ''}`,
    `eras: ${e.eras.join(', ')}`,
    `transports: ${e.transports.join(', ')}`,
    `needs a fixture: ${e.needsFixture ? 'yes' : 'no'}`,
    `in profile ${PROFILE.id} ${PROFILE.version}: ${PROFILE.checks.includes(e.id) ? 'yes, scored' : 'no'}`,
    ...e.specRefs.map((r) => `spec: ${specUrl(r)} (${r.section})`),
  ];
  return `${lines.join('\n')}\n`;
}

async function conformance(
  flags: McpConformanceFlags,
  server: string[],
  io: ConformanceIo,
  rawOut: (text: string) => void,
): Promise<number> {
  const format = oneOf('--format', flags.format ?? 'human', FORMATS);
  if (flags.listChecks === true || flags.explain !== undefined) {
    if (flags.out !== undefined || flags.reporter !== undefined)
      throw new UsageError('--list-checks and --explain print the catalog: --out is for a run.');
    if (flags.explain !== undefined) {
      const entry = catalogEntry(flags.explain);
      if (entry === undefined) throw new UsageError(`--explain ${flags.explain}: no such check.`);
      io.out(format === 'json' ? json(entry) : explainText(entry));
      return MCP_EXIT.ok;
    }
    const entries = flags.suite === undefined ? CATALOG : selection(flags).entries;
    io.out(
      format === 'json'
        ? json({
            kind: 'mcp-conformance-catalog',
            schemaVersion: 1,
            profile: { id: PROFILE.id, version: PROFILE.version, manifestDigest: manifestDigest(PROFILE.checks), checks: PROFILE.checks },
            checks: entries,
          })
        : catalogText(entries),
    );
    return MCP_EXIT.ok;
  }

  const { suites, entries } = selection(flags);
  const requested = flags.protocolVersion ?? 'auto';
  if (requested !== 'auto' && !REVISION.test(requested))
    throw new UsageError(`--protocol-version must be auto or a revision such as 2025-11-25 (got "${requested}").`);
  const cwd = io.cwd ?? process.cwd();
  // The report flags of every command that tests a server, refused before the server is started; no markdown here.
  const markdown = [flags.out ?? []].flat().find((raw) => raw.startsWith('markdown='));
  if (markdown !== undefined)
    throw new UsageError(`--out ${markdown}: plune mcp conformance writes json or junit-xml.`);
  const { files } = reportOutputs(
    {
      ...(flags.reporter === undefined ? {} : { reporter: flags.reporter }),
      ...(flags.out === undefined ? {} : { out: flags.out }),
    },
    cwd,
  );
  const config = connectionConfig(flags, server, io.env);
  if (io.clientVersion !== undefined) config.clientVersion = io.clientVersion;

  const fixture = flags.fixture === undefined ? undefined : loadFixture(resolve(cwd, flags.fixture));
  const transport = config.target.kind === 'stdio' ? 'stdio' : 'http';
  const results: ConformanceResult[] = [];
  let serverInfo: McpConformanceReport['server'] = null;
  let protocolVersion: string | null = requested === 'auto' ? null : requested;

  let session: Session | undefined;
  try {
    session = await openSession(config);
  } catch (err) {
    // The server ran and answered, but not with a handshake the connection could take: that is the verdict of
    // life-initialize-result, and every check after it has nothing to stand on. A server that never answered is exit 2.
    if (!(err instanceof ConnectError) || err.kind !== 'protocol') throw err;
    const clean = (text: string) => cut(printable(redactorFor(config.target).text(text)));
    const era = eraOf(protocolVersion ?? '2025-11-25');
    for (const entry of entries)
      results.push(
        result(
          entry,
          applicability(entry, { era, transport }) ??
            (entry.id === HANDSHAKE_CHECK
              ? { state: 'failed', actual: err.message, fix: 'Answer initialize with a result an MCP client accepts.' }
              : { state: 'could-not-run', reason: 'prerequisite-failed', actual: 'The handshake failed.' }),
          clean,
        ),
      );
  }
  if (session !== undefined) {
    const live = session;
    try {
      const clean = (text: string) => cut(printable(live.redact.text(text)));
      if (live.server !== undefined)
        serverInfo = { name: clean(live.server.name), version: clean(live.server.version) };
      const answered = (live.handshake.result as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      if (protocolVersion === null && typeof answered === 'string') protocolVersion = clean(answered);
      // The connection made an `initialize` handshake: without a revision to say otherwise, the legacy era.
      const era = eraOf(protocolVersion ?? '2025-11-25');
      const memos = new Map<string, Promise<unknown>>();
      const ctx: ConformanceContext = {
        session: live,
        transport,
        era,
        protocolVersion,
        ...(fixture !== undefined ? { fixture } : {}),
        ...(config.target.kind === 'http'
          ? {
              http: {
                url: config.target.url,
                fetch: live.fetchForOrigin(config.target.url),
                headers: config.target.headers,
                redact: live.redact,
              },
            }
          : {}),
        memo: <T>(key: string, make: () => Promise<T>) => {
          if (!memos.has(key)) memos.set(key, make());
          return memos.get(key) as Promise<T>;
        },
      };
      const broken = initializeProblems(live.handshake.result);
      let timeouts = 0;
      const measure = async (entry: CatalogEntry): Promise<CheckOutcome> => {
        const run = IMPLEMENTATIONS[entry.id];
        if (run === undefined) return { state: 'pending' };
        if (broken.length > 0 && entry.id !== HANDSHAKE_CHECK)
          return { state: 'could-not-run', reason: 'prerequisite-failed', actual: `The initialize result is malformed: ${broken.join('; ')}.` };
        if (timeouts >= TIMEOUTS_IN_A_ROW)
          return { state: 'could-not-run', reason: 'timeout', actual: `Not run: ${TIMEOUTS_IN_A_ROW} checks in a row timed out.` };
        let outcome: CheckOutcome;
        try {
          outcome = await run(ctx);
        } catch (err) {
          if (!(err instanceof ConnectError)) throw err;
          outcome = { state: 'could-not-run', reason: err.kind === 'timeout' ? 'timeout' : 'transport-error', actual: err.message };
        }
        timeouts = outcome.state === 'could-not-run' && outcome.reason === 'timeout' ? timeouts + 1 : 0;
        return outcome;
      };
      for (const entry of entries)
        results.push(result(entry, applicability(entry, { era, transport }) ?? (await measure(entry)), clean));
    } finally {
      await live.close();
    }
  }

  const summary = summarize(results);
  const bucket = new Map(BUCKETS.flatMap((k) => summary[k].map((id) => [id, k] as const)));
  for (const r of results) r.bucket = bucket.get(r.id) ?? 'pending';
  const bySuite: McpConformanceReport['bySuite'] = {};
  for (const s of suites) bySuite[s] = summarize(results.filter((r) => r.suite === s));
  const report: McpConformanceReport = {
    kind: 'mcp-conformance-report',
    schemaVersion: 1,
    command: 'conformance',
    checkerVersion: io.clientVersion ?? '0.0.0',
    profileId: PROFILE.id,
    profileVersion: PROFILE.version,
    manifestDigest: manifestDigest(PROFILE.checks),
    protocolVersion,
    protocolVersionRequested: requested,
    server: serverInfo,
    transport: config.target.kind,
    suites,
    checks: results,
    pendingCheckIds: summary.pending,
    bySuite,
    summary,
    exitCode: exitCodeOf(summary.verdict),
  };
  writeReport(conformanceRun(report), { format, files }, { out: rawOut, err: io.err, cwd });
  return report.exitCode;
}

function result(
  entry: CatalogEntry,
  outcome: CheckOutcome,
  clean: (text: string) => string,
): ConformanceResult {
  const first = entry.specRefs[0];
  return {
    id: entry.id,
    suite: entry.suite,
    kind: entry.kind,
    class: entry.kind === 'advice' ? 'heuristic' : 'deterministic',
    level: entry.level,
    state: outcome.state,
    ...('reason' in outcome ? { reason: outcome.reason } : {}),
    bucket: 'pending',
    expected: 'expected' in outcome && outcome.expected !== undefined ? clean(outcome.expected) : entry.description,
    actual: outcome.actual === undefined ? '' : clean(outcome.actual),
    fix: 'fix' in outcome && outcome.fix !== undefined ? clean(outcome.fix) : '',
    specRef: first === undefined ? '' : `${specUrl(first)} (${first.section})`,
    ...(outcome.details === undefined ? {} : { details: outcome.details }),
  };
}
