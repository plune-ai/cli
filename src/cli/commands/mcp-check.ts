// `plune mcp check`: is the server alive, and does it answer the basic requests? Connect (waiting for it with --wait),
// run the checks in order, with --smoke call the tools that are safe to call, print one report, write it to --out, and
// say by the exit code whether everything that applies passed (0), something failed (1), or something could not be
// measured (3). Exit 2: nothing about the server's health was proven, and the user can fix why. The checks live in
// src/mcp-testing/check/; nothing here judges an answer.

import { performance } from 'node:perf_hooks';
import { runChecks, realClock, type Clock, type Ran } from '../../mcp-testing/check/run.js';
import { healthSteps, smokeSteps, type CheckResult } from '../../mcp-testing/check/steps.js';
import {
  connectionConfig,
  UsageError,
  type ConnectConfig,
  type ConnectionFlags,
} from '../../mcp-testing/connect/options.js';
import { ConnectError, openSession, type Session } from '../../mcp-testing/connect/session.js';
import { MCP_EXIT } from '../../mcp-testing/exit-codes.js';
import { noCommands } from '../../mcp-testing/report/human.js';
import {
  checkRun,
  reportOutputs,
  writeReport,
  type ReportFlags,
} from '../../mcp-testing/report/index.js';
import type {
  HealthCheck,
  HealthCheckId,
  McpCheckReport,
  SmokeCall,
} from '../../mcp-testing/result.js';
import { printable } from '../../reporter-core/failure-detail.js';
import { parseTimerDuration } from '../../util/duration.js';

/** What commander hands the action: the connection flags and the check's own. */
export interface McpCheckFlags extends ConnectionFlags, ReportFlags {
  checkTimeout?: string;
  wait?: string;
  smoke?: boolean;
  smokeLimit?: string;
  smokeTimeout?: string;
  budget?: string;
  allowWriteCalls?: boolean;
}

export interface CheckIo {
  out(text: string): void;
  err(text: string): void;
  /** Where --env KEY and --header-env read from. */
  env: NodeJS.ProcessEnv;
  clientVersion?: string;
  clock?: Clock;
}

/** How often --wait tries again. */
const RETRY_MS = 250;
/** Server text in a report is cut here: one error message can be megabytes, and the report is meant to be attached. */
const MAX_TEXT = 500;
const cut = (text: string) =>
  text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT)}… (cut: ${text.length} characters)`;

const WRITE_WARNING =
  'warning: --allow-write-calls: tools that may change data will be called. readOnlyHint is what the server says of itself, not a guarantee.\n';
const AUTH_HINT =
  'The server wants credentials: pass them with --header-env Authorization=VAR, the value in that variable.\n';

/** The exit code; every failure the user can act on is printed here, anything else is thrown. */
export async function handleMcpCheck(
  flags: McpCheckFlags,
  server: string[],
  raw: CheckIo,
): Promise<number> {
  // The one way out: report, errors and the server's stderr tail all pass noCommands.
  const io: CheckIo = {
    ...raw,
    out: (text) => raw.out(noCommands(text)),
    err: (text) => raw.err(noCommands(text)),
  };
  try {
    return await check(flags, server, io, raw.out);
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`plune mcp check: ${err.message}\n`);
      return MCP_EXIT.usage;
    }
    if (err instanceof ConnectError) {
      io.err(`plune mcp check: ${err.message}\n`);
      if (err.kind === 'auth') io.err(AUTH_HINT);
      if (err.stderrTail.length > 0)
        io.err(
          `The last lines the server wrote to stderr:\n${err.stderrTail.map((l) => `  ${l}\n`).join('')}`,
        );
      return MCP_EXIT.usage;
    }
    throw err;
  }
}

function duration(flag: string, value: string): number {
  try {
    return parseTimerDuration(value);
  } catch (err) {
    throw new UsageError(`${flag}: ${(err as Error).message}.`);
  }
}

function parseFlags(flags: McpCheckFlags) {
  const outputs = reportOutputs(flags);
  const smokeLimit = flags.smokeLimit ?? '5';
  if (!/^\d+$/.test(smokeLimit) || Number(smokeLimit) < 1)
    throw new UsageError(
      `--smoke-limit must be a whole number of 1 or more (got "${smokeLimit}").`,
    );
  if (flags.allowWriteCalls === true && flags.smoke !== true)
    throw new UsageError('--allow-write-calls is for --smoke: without it no tool is called.');
  const wait = flags.wait ?? '0';
  const waitMs = wait.trim() === '0' ? 0 : duration('--wait', wait);
  if (waitMs > 0 && flags.url === undefined)
    throw new UsageError(
      '--wait is for a server at --url; a command after -- is started, not waited for.',
    );
  const text = {
    checkTimeout: flags.checkTimeout ?? '15s',
    smokeTimeout: flags.smokeTimeout ?? '15s',
    budget: flags.budget ?? '60s',
    wait,
  };
  return {
    outputs,
    text,
    checkTimeoutMs: duration('--check-timeout', text.checkTimeout),
    smokeTimeoutMs: duration('--smoke-timeout', text.smokeTimeout),
    budgetMs: duration('--budget', text.budget),
    smokeLimit: Number(smokeLimit),
    waitMs,
  };
}

/**
 * The session, trying again while the server cannot be reached until --wait is over. Only `network` is waited out: a
 * server that answered, even with a refusal, is there.
 */
async function connect(
  config: ConnectConfig,
  waitMs: number,
  waitText: string,
  clock: Clock,
): Promise<Session> {
  const start = clock.now();
  for (;;) {
    try {
      return await openSession(config);
    } catch (err) {
      if (!(err instanceof ConnectError) || err.kind !== 'network' || waitMs === 0) throw err;
      const left = waitMs - (clock.now() - start);
      if (left <= 0)
        throw new ConnectError('network', `${err.message} (still, after --wait ${waitText})`, []);
      await clock.after(Math.min(RETRY_MS, left)).done;
    }
  }
}

const AFTER_HANDSHAKE: HealthCheckId[] = [
  'protocol-version',
  'capabilities',
  'tools-list',
  'resources-list',
  'resource-templates-list',
  'prompts-list',
  'ping',
];

async function check(
  flags: McpCheckFlags,
  server: string[],
  io: CheckIo,
  rawOut: (text: string) => void,
): Promise<number> {
  const opts = parseFlags(flags);
  const config = connectionConfig(flags, server, io.env);
  if (io.clientVersion !== undefined) config.clientVersion = io.clientVersion;
  const clock = io.clock ?? realClock;
  const began = performance.now();
  const startDetail =
    config.target.kind === 'stdio' ? 'the server process started' : 'the server answered at --url';

  const checks: HealthCheck[] = [];
  const timing: McpCheckReport['timing'] = { totalMs: 0, checks: [], calls: [] };
  let session: Session | undefined;
  let stderrTail: string[] = [];
  let calls: SmokeCall[] | null = null;
  let serverInfo: McpCheckReport['server'] = null;
  let protocolVersion: string | null = null;
  try {
    try {
      session = await connect(config, opts.waitMs, opts.text.wait, clock);
    } catch (err) {
      // Could not start, could not reach, refused: exit 2, nothing about the server's health is proven.
      if (
        !(err instanceof ConnectError) ||
        !['exited-early', 'protocol', 'timeout'].includes(err.kind)
      )
        throw err;
      checks.push(
        { id: 'start', state: 'passed', detail: startDetail },
        err.kind === 'timeout'
          ? {
              id: 'initialize',
              state: 'could-not-run',
              detail: `no answer to initialize within --timeout (${flags.timeout ?? '30s'})`,
              timedOut: true,
            }
          : { id: 'initialize', state: 'failed', detail: cut(err.message) },
        ...AFTER_HANDSHAKE.map(
          (id): HealthCheck => ({
            id,
            state: 'could-not-run',
            detail: 'the handshake did not finish',
          }),
        ),
      );
      stderrTail = err.stderrTail.map(cut);
    }

    if (session !== undefined) {
      const live = session;
      const clean = (text: string) => cut(printable(live.redact.text(text)));
      const name = live.server;
      checks.push(
        { id: 'start', state: 'passed', detail: startDetail },
        {
          id: 'initialize',
          state: 'passed',
          detail:
            name === undefined
              ? 'the handshake finished; the server sent no serverInfo'
              : `serverInfo: ${clean(name.name)} ${clean(name.version)}`,
        },
      );
      const found: { tools?: unknown[] } = {};
      const limits = {
        timeoutMs: opts.checkTimeoutMs,
        timedOutDetail: `no answer within --check-timeout (${opts.text.checkTimeout})`,
      };
      const ran = await runChecks(healthSteps(live, limits, found), clock, limits);
      for (const r of ran) {
        checks.push(healthCheck(r, clean));
        timing.checks.push({ id: r.id as HealthCheckId, ms: Math.round(r.ms) });
      }

      if (flags.smoke === true) {
        const smoke = smokeSteps(live, found.tools ?? [], {
          limit: opts.smokeLimit,
          timeoutMs: opts.smokeTimeoutMs,
          timedOutDetail: `no answer within --smoke-timeout (${opts.text.smokeTimeout})`,
          allowWrite: flags.allowWriteCalls === true,
        });
        if (flags.allowWriteCalls === true) io.err(WRITE_WARNING);
        const called = await runChecks(smoke.called, clock, {
          timeoutMs: opts.smokeTimeoutMs,
          timedOutDetail: `no answer within --smoke-timeout (${opts.text.smokeTimeout})`,
          budgetMs: opts.budgetMs,
          budgetDetail: `the --budget (${opts.text.budget}) was spent`,
        });
        calls = [
          ...called.map((r): SmokeCall => {
            timing.calls.push({ tool: clean(r.id), ms: Math.round(r.ms) });
            return {
              tool: clean(r.id),
              state: r.result.state as SmokeCall['state'],
              detail: clean(r.result.detail),
              ...(r.result.timedOut === true ? { timedOut: true as const } : {}),
            };
          }),
          ...smoke.notCalled.map(
            (n): SmokeCall => ({ tool: clean(n.tool), state: 'not-applicable', detail: n.detail }),
          ),
        ];
      }
      stderrTail = live.stderrTail().map(cut);
      if (name !== undefined) serverInfo = { name: clean(name.name), version: clean(name.version) };
      const version = (live.handshake.result as { protocolVersion?: unknown } | undefined)
        ?.protocolVersion;
      if (typeof version === 'string') protocolVersion = clean(version);
    }
  } finally {
    await session?.close();
  }
  timing.totalMs = Math.max(1, Math.round(performance.now() - began));

  const report: McpCheckReport = {
    kind: 'mcp-check-report',
    schemaVersion: 1,
    command: 'check',
    plune: io.clientVersion ?? '0.0.0',
    server: serverInfo,
    transport: config.target.kind,
    protocolVersion,
    checkTimeout: opts.text.checkTimeout,
    checks,
    smoke:
      calls === null
        ? null
        : {
            limit: opts.smokeLimit,
            timeout: opts.text.smokeTimeout,
            budget: opts.text.budget,
            calls,
          },
    writeCallsAllowed: flags.smoke === true && flags.allowWriteCalls === true,
    stderrTail,
    exitCode: exitCode(checks, calls),
    timing,
  };
  writeReport(checkRun(report), opts.outputs, { out: rawOut, err: io.err });
  return report.exitCode;
}

function healthCheck(r: Ran<CheckResult>, clean: (text: string) => string): HealthCheck {
  const result = r.result as CheckResult;
  return {
    id: r.id as HealthCheckId,
    state: result.state,
    detail: clean(result.detail),
    ...(result.timedOut === true ? { timedOut: true as const } : {}),
    ...(result.count === undefined ? {} : { count: result.count }),
  };
}

/**
 * 1 on any failure; 3 when something could not run, when no check passed, or when --smoke called nothing: not
 * measured is not healthy; 0 otherwise (`not-applicable` is neither).
 */
function exitCode(checks: HealthCheck[], calls: SmokeCall[] | null): 0 | 1 | 3 {
  const states = [...checks, ...(calls ?? [])].map((c) => c.state);
  if (states.includes('failed')) return MCP_EXIT.violations;
  const smokeCalledNothing =
    calls !== null && !calls.some((c) => c.state === 'passed' || c.state === 'could-not-run');
  if (
    states.includes('could-not-run') ||
    !checks.some((c) => c.state === 'passed') ||
    smokeCalledNothing
  )
    return MCP_EXIT.unmeasured;
  return MCP_EXIT.ok;
}
