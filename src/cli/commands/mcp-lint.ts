// `plune mcp lint`: connect to a server, read its whole tool list, run the lint rules over it (and, with --call, over
// the answers of the tools that are safe to call), set the exceptions file's entries aside, print one report and say
// by the exit code whether it passed. The rules live in src/mcp-testing/lint/; nothing here judges a tool.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  connectionConfig,
  UsageError,
  type ConnectionFlags,
} from '../../mcp-testing/connect/options.js';
import { selectSafeTools } from '../../mcp-testing/connect/safe-tools.js';
import { ConnectError, openSession, type Session } from '../../mcp-testing/connect/session.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import {
  ExceptionsFileError,
  parseExceptionsFile,
  type FileException,
} from '../../mcp-testing/exceptions-file.js';
import { MCP_EXIT } from '../../mcp-testing/exit-codes.js';
import {
  applyExceptions,
  CALL_RULES,
  compareLevels,
  failsAt,
  LINT_RULES,
  lintCall,
  lintTools,
  type CallContext,
  type ListedTool,
  type LintFinding,
} from '../../mcp-testing/lint/index.js';
import { CATALOG_RENDERERS, RENDERERS } from '../../mcp-testing/render.js';
import type {
  CallOutcome,
  ExceptionNote,
  FailOn,
  McpReport,
  ReportFinding,
} from '../../mcp-testing/result.js';
import { printable } from '../../reporter-core/failure-detail.js';
import { parseDuration } from '../../util/duration.js';

/** What commander hands the action: the connection flags and the lint's own. */
export interface McpLintFlags extends ConnectionFlags {
  failOn?: string;
  showInfo?: boolean;
  format?: string;
  ignoreFile?: string;
  listRules?: boolean;
  call?: boolean;
  callLimit?: string;
  callTimeout?: string;
}

export interface LintIo {
  out(text: string): void;
  err(text: string): void;
  /** Where --env KEY and --header-env read from. */
  env: NodeJS.ProcessEnv;
  /** Where the default exceptions file is looked for, and a relative --ignore-file is read from. */
  cwd: string;
  /** `YYYY-MM-DD` an `expires` is compared with; today in UTC by default. */
  today?: string;
  clientVersion?: string;
}

export const DEFAULT_IGNORE_FILE = 'plune-mcp-ignore.yaml';
/** Pages of tools/list read at most: a server that always answers with a cursor would otherwise be read forever. */
const MAX_PAGES = 100;
const FAIL_ON: readonly FailOn[] = ['error', 'warn', 'info', 'never'];
const FORMATS = ['human', 'json'] as const;
type Format = (typeof FORMATS)[number];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The exit code; every failure the user can act on is printed here, anything else is thrown. */
export async function handleMcpLint(
  flags: McpLintFlags,
  server: string[],
  io: LintIo,
): Promise<number> {
  try {
    return await lint(flags, server, io);
  } catch (err) {
    if (err instanceof UsageError || err instanceof ExceptionsFileError) {
      io.err(`plune mcp lint: ${err.message}\n`);
      return MCP_EXIT.usage;
    }
    if (err instanceof ConnectError) {
      io.err(`plune mcp lint: ${err.message}\n`);
      if (err.stderrTail.length > 0)
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

async function lint(flags: McpLintFlags, server: string[], io: LintIo): Promise<number> {
  const format = oneOf<Format>('--format', flags.format ?? 'human', FORMATS);
  if (flags.listRules === true) {
    const rules = [...LINT_RULES, ...CALL_RULES].map(
      ({ id, class: cls, level, description, fix, specRef }) => ({
        id,
        class: cls,
        level,
        description,
        fix,
        specRef,
      }),
    );
    io.out(CATALOG_RENDERERS[format](rules));
    return MCP_EXIT.ok;
  }
  const failOn = oneOf('--fail-on', flags.failOn ?? 'error', FAIL_ON);
  const callLimit = flags.callLimit ?? '10';
  if (!/^\d+$/.test(callLimit) || Number(callLimit) < 1)
    throw new UsageError(`--call-limit must be a whole number of 1 or more (got "${callLimit}").`);
  const callTimeout = flags.callTimeout ?? '15s';
  let callTimeoutMs: number;
  try {
    callTimeoutMs = parseDuration(callTimeout);
  } catch (err) {
    throw new UsageError(`--call-timeout: ${(err as Error).message}.`);
  }
  const exceptions = readExceptions(flags.ignoreFile, io);
  const config = connectionConfig(flags, server, io.env);
  if (io.clientVersion !== undefined) config.clientVersion = io.clientVersion;

  const session = await openSession(config);
  try {
    const { tools, pages, complete } = await listTools(session);
    const findings = lintTools(tools);
    const calls =
      flags.call === true
        ? await callSafeTools(session, tools, Number(callLimit), callTimeoutMs, callTimeout)
        : null;
    if (calls !== null) findings.push(...calls.findings);
    const applied = applyExceptions(findings, exceptions?.active ?? []);

    const clean = (text: string) => printable(session.redact.text(text));
    const violations = applied.findings.some((f) => failsAt(f, failOn));
    const unmeasured =
      tools.length === 0 ||
      !complete ||
      (calls !== null &&
        (calls.called.length === 0 || calls.called.some((c) => c.state === 'could-not-run')));
    const report: McpReport = {
      schemaVersion: 1,
      command: 'lint',
      server:
        session.server === undefined
          ? null
          : { name: clean(session.server.name), version: clean(session.server.version) },
      transport: config.target.kind,
      toolCount: tools.length,
      listing: { state: complete ? 'passed' : 'could-not-run', pages },
      failOn,
      counts: {
        error: applied.findings.filter((f) => f.level === 'error').length,
        warn: applied.findings.filter((f) => f.level === 'warn').length,
        info: applied.findings.filter((f) => f.level === 'info').length,
        suppressed: applied.excepted.length,
      },
      findings: sorted(applied.findings.map((f) => reported(f, clean))),
      suppressed: sorted(
        applied.excepted.map(({ finding, exception }) => ({
          ...reported(finding, clean),
          reason: clean(exception.reason),
          ...(exception.expires === undefined ? {} : { expires: exception.expires }),
        })),
      ),
      exceptions: {
        file: exceptions === undefined ? null : clean(exceptions.name),
        expired: (exceptions?.expired ?? []).map((e) => note(e, clean)),
        stale: applied.unused.map((e) => note(e, clean)),
      },
      calls:
        calls === null
          ? null
          : {
              limit: Number(callLimit),
              called: calls.called.map((c) => ({
                ...c,
                tool: clean(c.tool),
                ...(c.reason === undefined ? {} : { reason: clean(c.reason) }),
              })),
              skipped: calls.skipped.map((s) => ({ tool: clean(s.tool), reason: s.reason })),
            },
      exitCode: violations ? MCP_EXIT.violations : unmeasured ? MCP_EXIT.unmeasured : MCP_EXIT.ok,
    };
    io.out(RENDERERS[format](report, { showInfo: flags.showInfo === true }));
    return report.exitCode;
  } finally {
    await session.close();
  }
}

function readExceptions(flag: string | undefined, io: LintIo) {
  const name = flag ?? DEFAULT_IGNORE_FILE;
  const path = resolve(io.cwd, name);
  if (!existsSync(path)) {
    if (flag !== undefined) throw new UsageError(`--ignore-file: ${name} does not exist.`);
    return undefined;
  }
  const today = io.today ?? new Date().toISOString().slice(0, 10);
  return { name, ...parseExceptionsFile(readFileSync(path, 'utf8'), name, today) };
}

/** tools/list to its last page, at most MAX_PAGES. An entry that is not an object, or has no string name, keeps its place under an empty name, which the name rules report. */
async function listTools(
  session: Session,
): Promise<{ tools: ListedTool[]; pages: number; complete: boolean }> {
  const tools: ListedTool[] = [];
  let cursor: string | undefined;
  for (let pages = 1; pages <= MAX_PAGES; pages++) {
    let page: unknown;
    try {
      page = await session.request('tools/list', cursor === undefined ? undefined : { cursor });
    } catch (err) {
      if (err instanceof ConnectError) throw err;
      throw new ConnectError(
        'protocol',
        `The server answered tools/list with an error: ${(err as Error).message}`,
        [],
      );
    }
    const listed: unknown[] = isRecord(page) && Array.isArray(page.tools) ? page.tools : [];
    for (const t of listed)
      tools.push(
        isRecord(t) && typeof t.name === 'string'
          ? (t as unknown as ListedTool)
          : { ...(isRecord(t) ? t : {}), name: '' },
      );
    cursor =
      isRecord(page) && typeof page.nextCursor === 'string' && page.nextCursor !== ''
        ? page.nextCursor
        : undefined;
    if (cursor === undefined) return { tools, pages, complete: true };
  }
  return { tools, pages: MAX_PAGES, complete: false };
}

/**
 * JSON Schema 2020-12, the dialect MCP schemas are written in. Not strict (a server's schema may carry keywords of its
 * own), and a fresh instance per schema: one instance refuses a second schema with the same `$id`.
 */
const SCHEMAS: CallContext = {
  validate(schema, value) {
    try {
      const check = new Ajv2020({ strict: false, validateSchema: false }).compile(schema);
      if (check(value)) return undefined;
      return (check.errors ?? [])
        .map((e) => `${e.instancePath || '/'} ${e.message ?? 'is invalid'}`)
        .join('; ');
    } catch (err) {
      return `the output schema does not compile: ${(err as Error).message.split('\n')[0] ?? ''}`;
    }
  },
};

/** Calls each tool `selectSafeTools` allows, one after another, with `{}`; a call with no answer is could-not-run. */
async function callSafeTools(
  session: Session,
  tools: readonly ListedTool[],
  limit: number,
  timeoutMs: number,
  timeoutText: string,
) {
  const { safe, skipped } = selectSafeTools(tools);
  const findings: LintFinding[] = [];
  const called: CallOutcome[] = [];
  for (const tool of safe.slice(0, limit)) {
    try {
      const result = await session.request(
        'tools/call',
        { name: tool.name, arguments: {} },
        { timeoutMs },
      );
      const found = lintCall(tool, result, SCHEMAS);
      findings.push(...found);
      called.push({ tool: tool.name, state: found.length > 0 ? 'failed' : 'passed' });
    } catch (err) {
      const reason =
        err instanceof ConnectError && err.kind === 'timeout'
          ? `no answer within --call-timeout (${timeoutText})`
          : (err as Error).message;
      called.push({ tool: tool.name, state: 'could-not-run', reason });
    }
  }
  return {
    findings,
    called,
    skipped: [
      ...skipped.map((s) => ({ tool: s.tool.name, reason: s.reason as string })),
      ...safe.slice(limit).map((t) => ({ tool: t.name, reason: 'call-limit' })),
    ],
  };
}

function reported(f: LintFinding, clean: (s: string) => string): ReportFinding {
  return {
    rule: f.id,
    class: f.class,
    level: f.level,
    state: f.state,
    target: {
      tool: clean(f.target.tool),
      ...(f.target.param === undefined ? {} : { param: clean(f.target.param) }),
    },
    message: clean(f.message),
    expected: clean(f.expected),
    actual: clean(f.actual),
    fix: f.fix,
    specRef: f.specRef,
  };
}

const note = (e: FileException, clean: (s: string) => string): ExceptionNote => ({
  rule: clean(e.id),
  ...(e.target.tool === undefined ? {} : { tool: clean(e.target.tool) }),
  line: e.line,
  ...(e.expires === undefined ? {} : { expires: e.expires }),
});

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** By level (error first), tool, rule; then parameter and message, so the order never depends on the rules' order. */
function sorted<F extends ReportFinding>(findings: F[]): F[] {
  return findings.sort(
    (a, b) =>
      compareLevels(b.level, a.level) ||
      cmp(a.target.tool, b.target.tool) ||
      cmp(a.rule, b.rule) ||
      cmp(a.target.param ?? '', b.target.param ?? '') ||
      cmp(a.message, b.message),
  );
}
