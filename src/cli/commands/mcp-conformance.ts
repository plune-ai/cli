// `plune mcp conformance`: the server against the text of the specification. Connect, run each selected check of
// the catalog (or say why it does not apply), score the run against the frozen profile, print one report, write it
// to --out, and say by the exit code whether every counted check passed (0), one failed (1), or the run did not
// establish conformance (3). Exit 2: the server did not start or a flag is wrong. `--list-checks` and `--explain`
// print the catalog without connecting. The model (catalog, states, score, profile) is in
// src/mcp-testing/conformance/; nothing here judges an answer.

import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  connectionConfig,
  UsageError,
  type ConnectionFlags,
} from '../../mcp-testing/connect/options.js';
import { ConnectError, openSession, type Session } from '../../mcp-testing/connect/session.js';
import {
  CATALOG,
  catalogEntry,
  SUITES,
  specUrl,
  type CatalogEntry,
  type Suite,
} from '../../mcp-testing/conformance/catalog.js';
import { IMPLEMENTATIONS } from '../../mcp-testing/conformance/checks/index.js';
import { applicability, eraOf, type CheckOutcome } from '../../mcp-testing/conformance/outcome.js';
import { manifestDigest, PROFILE } from '../../mcp-testing/conformance/profile.js';
import {
  BUCKETS,
  exitCodeOf,
  summarize,
  summaryLine,
  type Summary,
} from '../../mcp-testing/conformance/score.js';
import { MCP_EXIT } from '../../mcp-testing/exit-codes.js';
import { noCommands, noCommandsJson } from '../../mcp-testing/report/human.js';
import { reportOutputs } from '../../mcp-testing/report/options.js';
import type { ConformanceResult, McpConformanceReport } from '../../mcp-testing/result.js';
import { printable } from '../../reporter-core/failure-detail.js';

export interface McpConformanceFlags extends ConnectionFlags {
  suite?: string[];
  check?: string[];
  protocolVersion?: string;
  format?: string;
  out?: string;
  listChecks?: boolean;
  explain?: string;
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
    if (flags.out !== undefined) throw new UsageError('--list-checks and --explain print the catalog: --out is for a run.');
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
  // The same refusals as every report file (a folder, a missing folder), before the server is started.
  const outPath =
    flags.out === undefined ? undefined : reportOutputs({ out: `json=${flags.out}` }, cwd).files[0]?.path;
  const config = connectionConfig(flags, server, io.env);
  if (io.clientVersion !== undefined) config.clientVersion = io.clientVersion;

  const session: Session = await openSession(config);
  const results: ConformanceResult[] = [];
  let serverInfo: McpConformanceReport['server'] = null;
  let protocolVersion: string | null = requested === 'auto' ? null : requested;
  try {
    const clean = (text: string) => cut(printable(session.redact.text(text)));
    if (session.server !== undefined)
      serverInfo = { name: clean(session.server.name), version: clean(session.server.version) };
    const answered = (session.handshake.result as { protocolVersion?: unknown } | undefined)?.protocolVersion;
    if (protocolVersion === null && typeof answered === 'string') protocolVersion = clean(answered);
    const transport = config.target.kind === 'stdio' ? 'stdio' : 'http';
    // The connection made an `initialize` handshake: without a revision to say otherwise, the legacy era.
    const era = eraOf(protocolVersion ?? '2025-11-25');
    for (const entry of entries) {
      let outcome = applicability(entry, { era, transport });
      if (outcome === undefined) {
        const run = IMPLEMENTATIONS[entry.id];
        if (run === undefined) outcome = { state: 'pending' };
        else {
          try {
            outcome = await run({ session, transport, era, protocolVersion });
          } catch (err) {
            if (!(err instanceof ConnectError)) throw err;
            outcome = { state: 'could-not-run', reason: 'transport-error', actual: err.message };
          }
        }
      }
      results.push(result(entry, outcome, clean));
    }
  } finally {
    await session.close();
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
  const document = json(report);
  if (outPath !== undefined) writeWhole(resolve(cwd, outPath), document);
  if (format === 'json') rawOut(document);
  else io.out(humanText(report));
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
  };
}

/** Whole or not at all: a temporary file beside the target, renamed over it. */
function writeWhole(path: string, text: string): void {
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  try {
    writeFileSync(temp, text);
    renameSync(temp, path);
  } catch (err) {
    rmSync(temp, { force: true });
    throw new UsageError(`--out: could not write ${path} (${(err as NodeJS.ErrnoException).code ?? 'error'}).`);
  }
}

const WHY: Record<Summary['verdict'], (s: Summary) => string> = {
  passed: () => 'every scored check that applies passed',
  failed: (s) => `${s.failed.length} scored check${s.failed.length === 1 ? '' : 's'} failed`,
  incomplete: (s) =>
    s.applicable === 0 ? 'nothing was measured, so nothing is proven' : 'a scored check could not run',
};

function humanText(r: McpConformanceReport): string {
  const server = r.server === null ? 'a server without serverInfo' : `${r.server.name} ${r.server.version}`;
  const version =
    r.protocolVersion === null
      ? 'protocol version unknown'
      : `protocol ${r.protocolVersion} (${r.protocolVersionRequested === 'auto' ? 'from the handshake' : 'from --protocol-version'})`;
  const lines = [
    `plune mcp conformance · ${server} · ${r.transport} · ${version}`,
    `Profile ${r.profileId} ${r.profileVersion} · sha256 ${r.manifestDigest.slice(0, 12)}`,
    '',
  ];
  for (const c of r.checks) {
    const level = c.level ?? c.kind;
    const why = c.reason === undefined ? '' : ` (${c.reason})`;
    const unscored = c.bucket === 'pending' && c.state !== 'pending' ? ' · not in the profile, not scored' : '';
    lines.push(`  ${c.state.padEnd(15)} ${level.padEnd(7)} ${c.id}${why}${unscored}`);
  }
  lines.push('');
  const reasons = new Map(r.checks.filter((c) => c.reason !== undefined).map((c) => [c.id, c.reason as string]));
  for (const s of r.suites) {
    const summary = r.bySuite[s];
    if (summary !== undefined) lines.push(`${s}: ${summaryLine(summary, reasons)}`);
  }
  if (r.suites.length > 1) lines.push(`all suites: ${summaryLine(r.summary, reasons)}`);
  lines.push(`Verdict: ${r.summary.verdict} (exit ${r.exitCode}): ${WHY[r.summary.verdict](r.summary)}.`);
  return `${lines.join('\n')}\n`;
}
