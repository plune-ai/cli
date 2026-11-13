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
  type ConnectConfig,
  type ConnectionFlags,
} from '../../mcp-testing/connect/options.js';
import { createRedactor, redactorFor } from '../../mcp-testing/connect/redact.js';
import { ConnectError, openSession, type RawReply, type Session } from '../../mcp-testing/connect/session.js';
import {
  CATALOG,
  catalogEntry,
  SUITES,
  specUrl,
  type CatalogEntry,
  type Era,
  type Suite,
} from '../../mcp-testing/conformance/catalog.js';
import {
  IMPLEMENTATIONS,
  type ConformanceContext,
  type FixtureCall,
} from '../../mcp-testing/conformance/checks/index.js';
import { loadOauthConfig, type OauthConfig } from '../../mcp-testing/conformance/checks/auth-config.js';
import type { OauthContext } from '../../mcp-testing/conformance/checks/auth.js';
import { initializeProblems } from '../../mcp-testing/conformance/checks/lifecycle.js';
import { modernMeta } from '../../mcp-testing/conformance/checks/modern/meta.js';
import { answerOf, isObject, nextId, said, type Answer } from '../../mcp-testing/conformance/checks/wire.js';
import { applicability, eraOf, type CheckOutcome } from '../../mcp-testing/conformance/outcome.js';
import { manifestDigest, PROFILE } from '../../mcp-testing/conformance/profile.js';
import { BUCKETS, exitCodeOf, summarize } from '../../mcp-testing/conformance/score.js';
import { MCP_EXIT } from '../../mcp-testing/exit-codes.js';
import { noCommands, noCommandsJson } from '../../mcp-testing/report/human.js';
import { conformanceRun, conformanceSetRun, reportOutputs, writeReport } from '../../mcp-testing/report/index.js';
import type { ConformanceResult, McpConformanceReport, McpConformanceReportSet } from '../../mcp-testing/result.js';
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
  /** The oauth suite: a JSON file of how the run may sign in. */
  config?: string;
  /** The oauth suite: origins other than the server's that may be asked; repeatable. */
  allowOrigin?: string[];
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
/** Its counterpart in the modern era: without capabilities from server/discover the rest have nothing to stand on. */
const DISCOVER_CHECK = 'mod-discover-result';
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
    ...(!e.derived && e.derivation !== undefined ? [`quoted: ${e.derivation}`] : []),
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
  if (requested !== 'auto' && requested !== 'both' && !REVISION.test(requested))
    throw new UsageError(
      `--protocol-version must be auto or a revision such as 2025-11-25 or 2026-07-28, or both (got "${requested}").`,
    );
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
  const plan: Era[] | 'auto' =
    requested === 'both' ? ['legacy', 'modern'] : requested === 'auto' ? 'auto' : [eraOf(requested)];
  if (config.target.kind === 'sse' && plan !== 'auto' && plan.includes('modern'))
    throw new UsageError('--protocol-version: the HTTP+SSE transport carries the legacy era only (2025-11-25 and earlier).');
  const base: Base = { requested, suites, entries, fixture };
  const reports: McpConformanceReport[] = [];
  if (suites.includes('oauth')) {
    if (suites.length > 1) throw new UsageError('--suite oauth cannot be run together with another suite yet: run it on its own.');
    const setup = oauthSetup(flags, cwd, io.env);
    const revisions = requested === 'auto' || requested === 'both' ? (setup.config.protocolVersions ?? OAUTH_REVISIONS) : [requested];
    for (const revision of revisions) reports.push(await measureOauth(config, base, revision, setup, io));
  } else if (plan === 'auto') reports.push(await measure(config, base, await detect(config), io));
  else
    for (const era of plan) {
      const version = requested !== 'both' ? requested : era === 'modern' ? MODERN : null;
      reports.push(await measure(config, base, { era, version, how: 'from --protocol-version' }, io));
    }

  const [only] = reports;
  if (reports.length === 1 && only !== undefined) {
    writeReport(conformanceRun(only), { format, files }, { out: rawOut, err: io.err, cwd });
    return only.exitCode;
  }
  const set: McpConformanceReportSet = {
    kind: 'mcp-conformance-report-set',
    schemaVersion: 1,
    command: 'conformance',
    reports,
    exitCode: worstExit(reports.map((r) => r.exitCode)),
  };
  writeReport(conformanceSetRun(set), { format, files }, { out: rawOut, err: io.err, cwd });
  return set.exitCode;
}

/** The revision a modern run is for. */
const MODERN = '2026-07-28';

/** One exit code for several runs: a failed check wins, then a run that proved nothing, then a pass. */
const worstExit = (codes: (0 | 1 | 3)[]): 0 | 1 | 3 => (codes.includes(1) ? 1 : codes.includes(3) ? 3 : 0);

interface Base {
  requested: string;
  suites: Suite[];
  entries: CatalogEntry[];
  fixture: FixtureCall[] | undefined;
}

/** The era a run is for, the revision when it is known before the run, and how it was chosen. */
interface Plan {
  era: Era;
  version: string | null;
  how: string;
  /** A modern session the detection opened and left open for the run. */
  session?: Session;
  /** The answer to the detection's server/discover, which the run reads instead of asking again. */
  discover?: RawReply;
}

const MODERN_ERRORS = new Set([-32020, -32021, -32022]);

/**
 * `--protocol-version auto`: the era by the rule of the specification. A modern request first, server/discover with
 * the preferred modern revision in `_meta` (on stdio the probe of basic/transports/stdio, Backward Compatibility; over
 * HTTP the modern request of streamable-http, Backward Compatibility): a DiscoverResult or a recognized modern error
 * (-32020, -32021, -32022) is a modern server; any other error, an HTTP error without one, or silence is a legacy
 * one. The fallback is never keyed to one error code. HTTP+SSE is legacy without a probe.
 */
async function detect(config: ConnectConfig): Promise<Plan> {
  if (config.target.kind === 'sse') return { era: 'legacy', version: null, how: 'HTTP+SSE carries the legacy era only' };
  const session = await openSession(config, { modern: { version: MODERN } });
  let why: string;
  try {
    const reply = await discoverRaw(session, MODERN);
    const result = reply.frame?.['result'];
    const error = reply.frame?.['error'];
    const code = isObject(error) ? error['code'] : undefined;
    if (isObject(result) && ('supportedVersions' in result || 'resultType' in result))
      return { era: 'modern', version: MODERN, how: 'server/discover answered a DiscoverResult', session, discover: reply };
    if (typeof code === 'number' && MODERN_ERRORS.has(code))
      return { era: 'modern', version: MODERN, how: `server/discover answered the modern error ${code}`, session, discover: reply };
    why = isObject(error)
      ? `server/discover answered error ${String(code)}, not a modern one`
      : reply.status !== undefined && reply.status >= 400
        ? `server/discover got HTTP ${reply.status} without a modern error`
        : 'server/discover answered neither a DiscoverResult nor a modern error';
  } catch (err) {
    if (!(err instanceof ConnectError) || (err.kind !== 'timeout' && err.kind !== 'exited-early')) {
      await session.close();
      throw err;
    }
    why = err.kind === 'timeout' ? 'server/discover got no answer within --timeout' : 'the server exited on server/discover';
  }
  await session.close();
  return { era: 'legacy', version: null, how: `${why}: legacy, the initialize handshake` };
}

/** server/discover over the raw layer, with the per-request metadata of `version`. */
function discoverRaw(session: Session, version: string): Promise<RawReply> {
  const id = nextId();
  const body = { jsonrpc: '2.0', id, method: 'server/discover', params: { _meta: modernMeta(version) } };
  return session.raw(JSON.stringify(body), id);
}

/** One run of the selected checks in one era: connect, check, score. */
async function measure(
  config: ConnectConfig,
  { requested, suites, entries, fixture }: Base,
  plan: Plan,
  io: ConformanceIo,
): Promise<McpConformanceReport> {
  const transport = config.target.kind === 'stdio' ? 'stdio' : 'http';
  const results: ConformanceResult[] = [];
  let serverInfo: McpConformanceReport['server'] = null;
  const modern = plan.era === 'modern';
  let protocolVersion: string | null = plan.version ?? (modern ? MODERN : null);
  const sessionOptions = modern ? { modern: { version: protocolVersion ?? MODERN } } : {};

  let session: Session | undefined = plan.session;
  if (session === undefined)
    try {
      session = await openSession(config, sessionOptions);
    } catch (err) {
      // The server ran and answered, but not with a handshake the connection could take: that is the verdict of
      // life-initialize-result, and every check after it has nothing to stand on. A server that never answered is exit 2.
      if (modern || !(err instanceof ConnectError) || err.kind !== 'protocol') throw err;
      const clean = (text: string) => cut(printable(redactorFor(config.target).text(text)));
      for (const entry of entries)
        results.push(
          result(
            entry,
            applicability(entry, { era: plan.era, transport }) ??
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
      let broken: string | undefined;
      let discover: Answer | undefined;
      if (modern) {
        try {
          discover = answerOf(plan.discover ?? (await discoverRaw(live, protocolVersion ?? MODERN)));
          const info = discover.kind === 'result' ? serverInfoOf(discover.result) : undefined;
          if (info !== undefined) serverInfo = { name: clean(info.name), version: clean(info.version) };
          if (discover.kind !== 'result' || !isObject(discover.result['capabilities']))
            broken = `server/discover answered ${said(discover)}${discover.kind === 'result' ? ' without a capabilities object' : ''}.`;
        } catch (err) {
          if (!(err instanceof ConnectError)) throw err;
          broken = `server/discover could not be asked: ${err.message}`;
        }
      } else {
        if (live.server !== undefined) serverInfo = { name: clean(live.server.name), version: clean(live.server.version) };
        const answered = (live.handshake.result as { protocolVersion?: unknown } | undefined)?.protocolVersion;
        if (protocolVersion === null && typeof answered === 'string') protocolVersion = clean(answered);
        const problems = initializeProblems(live.handshake.result);
        if (problems.length > 0) broken = `The initialize result is malformed: ${problems.join('; ')}.`;
      }
      // A legacy run takes its era from the revision the handshake gave; without one, the handshake itself is legacy.
      const era: Era = modern ? 'modern' : eraOf(protocolVersion ?? '2025-11-25');
      const memos = new Map<string, Promise<unknown>>();
      const ctx: ConformanceContext = {
        session: live,
        transport,
        era,
        protocolVersion,
        ...(discover !== undefined ? { discover } : {}),
        connect: () => openSession(config, sessionOptions),
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
      const prerequisite = modern ? DISCOVER_CHECK : HANDSHAKE_CHECK;
      let timeouts = 0;
      const run = async (entry: CatalogEntry): Promise<CheckOutcome> => {
        const check = IMPLEMENTATIONS[entry.id];
        if (check === undefined) return { state: 'pending' };
        if (broken !== undefined && entry.id !== prerequisite)
          return { state: 'could-not-run', reason: 'prerequisite-failed', actual: broken };
        if (timeouts >= TIMEOUTS_IN_A_ROW)
          return { state: 'could-not-run', reason: 'timeout', actual: `Not run: ${TIMEOUTS_IN_A_ROW} checks in a row timed out.` };
        let outcome: CheckOutcome;
        try {
          outcome = await check(ctx);
        } catch (err) {
          if (!(err instanceof ConnectError)) throw err;
          outcome = { state: 'could-not-run', reason: err.kind === 'timeout' ? 'timeout' : 'transport-error', actual: err.message };
        }
        timeouts = outcome.state === 'could-not-run' && outcome.reason === 'timeout' ? timeouts + 1 : 0;
        return outcome;
      };
      for (const entry of entries)
        results.push(result(entry, applicability(entry, { era, transport }) ?? (await run(entry)), clean));
    } finally {
      await live.close();
    }
  }

  const summary = summarize(results);
  const bucket = new Map(BUCKETS.flatMap((k) => summary[k].map((id) => [id, k] as const)));
  for (const r of results) r.bucket = bucket.get(r.id) ?? 'pending';
  const bySuite: McpConformanceReport['bySuite'] = {};
  for (const s of suites) bySuite[s] = summarize(results.filter((r) => r.suite === s));
  return {
    kind: 'mcp-conformance-report',
    schemaVersion: 1,
    command: 'conformance',
    checkerVersion: io.clientVersion ?? '0.0.0',
    profileId: PROFILE.id,
    profileVersion: PROFILE.version,
    manifestDigest: manifestDigest(PROFILE.checks),
    protocolVersion,
    protocolVersionRequested: requested,
    era: plan.era,
    eraDetection: plan.how,
    server: serverInfo,
    transport: config.target.kind,
    suites,
    checks: results,
    pendingCheckIds: summary.pending,
    bySuite,
    summary,
    exitCode: exitCodeOf(summary.verdict),
  };
}

/** `_meta["io.modelcontextprotocol/serverInfo"]` of a result, when it names a server. */
function serverInfoOf(result: Record<string, unknown>): { name: string; version: string } | undefined {
  const meta = result['_meta'];
  const info = isObject(meta) ? meta['io.modelcontextprotocol/serverInfo'] : undefined;
  if (!isObject(info) || typeof info['name'] !== 'string') return undefined;
  return { name: info['name'], version: typeof info['version'] === 'string' ? info['version'] : '' };
}

/** The revisions the oauth suite covers when none is named: those of the catalog. */
const OAUTH_REVISIONS = ['2025-11-25', '2026-07-28'];

interface OauthSetup {
  config: OauthConfig;
  allowOrigins: Set<string>;
  env: NodeJS.ProcessEnv;
}

/** `--config` and `--allow-origin`, read and checked before any request is sent. */
function oauthSetup(flags: McpConformanceFlags, cwd: string, env: NodeJS.ProcessEnv): OauthSetup {
  const allowOrigins = new Set<string>();
  for (const raw of [flags.allowOrigin ?? []].flat()) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new UsageError(`--allow-origin ${raw}: not an origin such as https://auth.example.com.`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
      throw new UsageError(`--allow-origin ${raw}: not an origin such as https://auth.example.com.`);
    allowOrigins.add(url.origin);
  }
  return { config: flags.config === undefined ? {} : loadOauthConfig(resolve(cwd, flags.config)), allowOrigins, env };
}

/**
 * One run of the oauth suite for one revision. No session is opened: the suite asks the server as a client that has
 * no credentials, so a server that answers every request with 401 is a normal case, not a failed connection.
 */
async function measureOauth(
  config: ConnectConfig,
  { requested, suites, entries }: Base,
  revision: string,
  setup: OauthSetup,
  io: ConformanceIo,
): Promise<McpConformanceReport> {
  const era = eraOf(revision);
  const transport = config.target.kind === 'stdio' ? 'stdio' : 'http';
  const secrets = new Set<string>();
  // The connection's own values (--header, the URL's password) are masked as well, though this suite never sends them.
  const own = config.target.kind === 'stdio' ? undefined : redactorFor(config.target);
  const clean = (text: string) => cut(printable(createRedactor(secrets, { named: secrets }).text(own === undefined ? text : own.text(text))));
  const memos = new Map<string, Promise<unknown>>();
  const oauth: OauthContext | undefined =
    config.target.kind === 'http' || config.target.kind === 'sse'
      ? {
          url: config.target.url,
          revision,
          era,
          config: setup.config,
          allowOrigins: setup.allowOrigins,
          env: setup.env,
          timeoutMs: config.timeoutMs,
          fetch: (input, init) => fetch(input, init),
          secrets,
          memo: <T>(key: string, make: () => Promise<T>) => {
            if (!memos.has(key)) memos.set(key, make());
            return memos.get(key) as Promise<T>;
          },
        }
      : undefined;
  // The suite's checks read `oauth` only; the session and the rest of a protocol run's context are not part of it.
  const ctx = { transport, era, protocolVersion: revision, ...(oauth === undefined ? {} : { oauth }) } as unknown as ConformanceContext;
  const results: ConformanceResult[] = [];
  let timeouts = 0;
  for (const entry of entries) {
    let outcome: CheckOutcome | undefined = applicability(entry, { era, transport });
    if (outcome === undefined) {
      const check = IMPLEMENTATIONS[entry.id];
      if (check === undefined) outcome = { state: 'pending' };
      else if (timeouts >= TIMEOUTS_IN_A_ROW)
        outcome = { state: 'could-not-run', reason: 'timeout', actual: `Not run: ${TIMEOUTS_IN_A_ROW} checks in a row timed out.` };
      else
        try {
          outcome = await check(ctx);
        } catch (err) {
          if (!(err instanceof ConnectError)) throw err;
          outcome = { state: 'could-not-run', reason: err.kind === 'timeout' ? 'timeout' : 'transport-error', actual: err.message };
        }
    }
    timeouts = outcome.state === 'could-not-run' && outcome.reason === 'timeout' ? timeouts + 1 : 0;
    results.push(result(entry, outcome, clean));
  }
  const summary = summarize(results);
  const bucket = new Map(BUCKETS.flatMap((k) => summary[k].map((id) => [id, k] as const)));
  for (const r of results) r.bucket = bucket.get(r.id) ?? 'pending';
  const bySuite: McpConformanceReport['bySuite'] = {};
  for (const s of suites) bySuite[s] = summarize(results.filter((r) => r.suite === s));
  return {
    kind: 'mcp-conformance-report',
    schemaVersion: 1,
    command: 'conformance',
    checkerVersion: io.clientVersion ?? '0.0.0',
    profileId: PROFILE.id,
    profileVersion: PROFILE.version,
    manifestDigest: manifestDigest(PROFILE.checks),
    protocolVersion: revision,
    protocolVersionRequested: requested,
    era,
    eraDetection: 'the oauth suite runs once for each revision it covers',
    server: null,
    transport: config.target.kind,
    suites,
    checks: results,
    pendingCheckIds: summary.pending,
    bySuite,
    summary,
    exitCode: exitCodeOf(summary.verdict),
  };
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
