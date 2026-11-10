// `plune mcp lint`: connect to a server, read its whole tool list, run the lint rules over it (and, with --call, over
// the answers of the tools that are safe to call), set the exceptions file's entries aside, print one report and say
// by the exit code whether it passed. The rules live in src/mcp-testing/lint/; nothing here judges a tool.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ProtocolError } from '@modelcontextprotocol/client';
import {
  connectionConfig,
  UsageError,
  type ConnectionFlags,
} from '../../mcp-testing/connect/options.js';
import { ConnectError, openSession, type Session } from '../../mcp-testing/connect/session.js';
import { asTools, callableTools, callTool, listAll } from '../../mcp-testing/connect/tools.js';
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
import { CATALOG_RENDERERS, noCommands, RENDERERS } from '../../mcp-testing/render.js';
import type {
  CallOutcome,
  ExceptionNote,
  FailOn,
  McpReport,
  ReportFinding,
} from '../../mcp-testing/result.js';
import { printable } from '../../reporter-core/failure-detail.js';
import { parseTimerDuration } from '../../util/duration.js';

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
const FAIL_ON: readonly FailOn[] = ['error', 'warn', 'info', 'never'];
const FORMATS = ['human', 'json'] as const;
type Format = (typeof FORMATS)[number];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The exit code; every failure the user can act on is printed here, anything else is thrown. */
export async function handleMcpLint(
  flags: McpLintFlags,
  server: string[],
  raw: LintIo,
): Promise<number> {
  // The one way out: report, errors and the server's stderr tail all pass noCommands.
  const io: LintIo = {
    ...raw,
    out: (text) => raw.out(noCommands(text)),
    err: (text) => raw.err(noCommands(text)),
  };
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
    callTimeoutMs = parseTimerDuration(callTimeout);
  } catch (err) {
    throw new UsageError(`--call-timeout: ${(err as Error).message}.`);
  }
  const exceptions = readExceptions(flags.ignoreFile, io);
  const config = connectionConfig(flags, server, io.env);
  if (io.clientVersion !== undefined) config.clientVersion = io.clientVersion;

  const session = await openSession(config);
  try {
    const { tools, unnamed, pages, complete } = await listTools(session);
    const findings = lintTools(tools);
    const calls =
      flags.call === true
        ? await callSafeTools(
            session,
            tools,
            unnamed,
            Number(callLimit),
            callTimeoutMs,
            callTimeout,
          )
        : null;
    if (calls !== null) for (const f of calls.findings) findings.push(f);
    const applied = applyExceptions(findings, exceptions?.active ?? []);

    const clean = (text: string) => printable(session.redact.text(text));
    const violations = applied.findings.some((f) => failsAt(f, failOn));
    const unmeasured =
      tools.length === 0 ||
      !complete ||
      applied.findings.some((f) => f.state === 'could-not-run') ||
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

/** tools/list to its last page (connect/tools.ts); an error answer stops the lint as a server that did not answer. */
async function listTools(session: Session): Promise<{
  tools: ListedTool[];
  unnamed: Map<ListedTool, string>;
  pages: number;
  complete: boolean;
}> {
  try {
    const listing = await listAll(session, 'tools/list', 'tools');
    return { ...asTools(listing.items), pages: listing.pages, complete: listing.complete };
  } catch (err) {
    // Only a JSON-RPC error is the server's answer; anything else is ours and is not blamed on the server.
    if (!(err instanceof ProtocolError)) throw err;
    throw new ConnectError(
      'protocol',
      `The server answered tools/list with an error: ${(err as Error).message}`,
      [],
    );
  }
}

/** Keywords whose value maps names to schemas: the names are not keywords. */
const NAMED_SCHEMAS = new Set(['properties', '$defs', 'definitions', 'dependentSchemas']);
/** Keywords whose value is data, not a schema. */
const DATA = new Set(['const', 'enum', 'default', 'examples']);
/** A server's schema bigger than this is not checked: its size alone would cost more than the call. */
const MAX_SCHEMA_NODES = 10_000;
const MAX_SCHEMA_DEPTH = 64;

class SchemaTooBig extends Error {}

/**
 * A copy of a server's schema without `pattern` and `patternProperties`: a regular expression from the server, run on
 * a value from the server, can backtrack for minutes (`^(a+)+$`), and a call timeout cannot stop a synchronous match.
 * Without its `patternProperties` a node allows any other property too, so its `additionalProperties` goes with them.
 * The original is not touched.
 */
function withoutPatterns(schema: unknown): {
  schema: unknown;
  stripped: boolean;
  formats: boolean;
} {
  let nodes = 0;
  let stripped = false;
  let formats = false;
  const copy = (v: unknown, depth: number): unknown => {
    if (++nodes > MAX_SCHEMA_NODES || depth > MAX_SCHEMA_DEPTH) throw new SchemaTooBig();
    if (Array.isArray(v)) return v.map((x) => copy(x, depth + 1));
    if (!isRecord(v)) return v;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(v)) {
      if (key === 'pattern' || key === 'patternProperties') {
        stripped = true;
        continue;
      }
      if (key === 'format') formats = true;
      if (DATA.has(key)) out[key] = value;
      else if (NAMED_SCHEMAS.has(key) && isRecord(value))
        out[key] = Object.fromEntries(
          Object.entries(value).map(([n, s]) => [n, copy(s, depth + 1)]),
        );
      else out[key] = copy(value, depth + 1);
    }
    if ('patternProperties' in v) delete out.additionalProperties;
    return out;
  };
  return { schema: copy(schema, 0), stripped, formats };
}

/**
 * JSON Schema 2020-12, the dialect MCP schemas are written in. Not strict (a server's schema may carry keywords of its
 * own), no formats (a format name is server text, and ajv would log an unknown one), no logger: ajv writes nothing.
 * A fresh instance per schema (one instance refuses a second schema with the same `$id`), compiled once per schema.
 */
function schemaValidator(): CallContext {
  const compiled = new WeakMap<object, (value: unknown) => string | undefined>();
  const compile = (schema: Record<string, unknown>): ((value: unknown) => string | undefined) => {
    let safe: ReturnType<typeof withoutPatterns>;
    try {
      safe = withoutPatterns(schema);
    } catch (err) {
      if (!(err instanceof SchemaTooBig)) throw err;
      return () =>
        `the output schema is too large to check (over ${MAX_SCHEMA_NODES} nodes or ${MAX_SCHEMA_DEPTH} levels)`;
    }
    const notChecked = [
      ...(safe.stripped ? ['pattern and patternProperties were not checked'] : []),
      ...(safe.formats ? ['formats were not checked'] : []),
    ].join('; ');
    try {
      const check = new Ajv2020({
        strict: false,
        validateSchema: false,
        validateFormats: false,
        logger: false,
      }).compile(safe.schema as Record<string, unknown>);
      return (value) => {
        if (check(value)) return undefined;
        const errors = (check.errors ?? [])
          .map((e) => `${e.instancePath || '/'} ${e.message ?? 'is invalid'}`)
          .join('; ');
        return notChecked === '' ? errors : `${errors} (${notChecked})`;
      };
    } catch (err) {
      const message = `the output schema does not compile: ${(err as Error).message.split('\n')[0] ?? ''}`;
      return () => message;
    }
  };
  return {
    validate(schema, value) {
      let check = compiled.get(schema);
      if (check === undefined) compiled.set(schema, (check = compile(schema)));
      return check(value);
    },
  };
}

/**
 * Calls each tool `callableTools` allows (connect/tools.ts), one after another, with `{}`; a call with no answer is
 * could-not-run.
 */
async function callSafeTools(
  session: Session,
  tools: readonly ListedTool[],
  unnamed: ReadonlyMap<ListedTool, string>,
  limit: number,
  timeoutMs: number,
  timeoutText: string,
) {
  const { safe, skipped } = callableTools(tools, unnamed);
  const schemas = schemaValidator();
  const findings: LintFinding[] = [];
  const called: CallOutcome[] = [];
  for (const tool of safe.slice(0, limit)) {
    const answer = await callTool(session, tool.name, timeoutMs);
    if (answer.kind === 'result') {
      const found = lintCall(tool, answer.result, schemas);
      for (const f of found) findings.push(f);
      called.push({ tool: tool.name, state: found.length > 0 ? 'failed' : 'passed' });
    } else {
      const reason =
        answer.kind === 'timeout'
          ? `no answer within --call-timeout (${timeoutText})`
          : answer.message;
      called.push({ tool: tool.name, state: 'could-not-run', reason });
    }
  }
  return {
    findings,
    called,
    skipped: [
      ...skipped,
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
  ...(e.target.param === undefined ? {} : { param: clean(e.target.param) }),
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
