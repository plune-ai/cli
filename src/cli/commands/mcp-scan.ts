// `plune mcp scan`: the static rules of the scanner over what the user names (snapshot files, configuration files, a
// pin file) or over one live server they start themselves, one report in five formats, one exit code. The rules live in
// src/mcp-testing/scan/; the report and its formats in src/mcp-testing/scan/report.ts; this file reads, connects,
// prints and exits. It never runs a command that a configuration file holds: that text is only read.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { ConnectError } from '../../mcp-testing/connect/session.js';
import {
  connectionConfig,
  UsageError,
  type ConnectionFlags,
} from '../../mcp-testing/connect/options.js';
import { ExceptionsFileError } from '../../mcp-testing/exceptions-file.js';
import { MCP_EXIT } from '../../mcp-testing/exit-codes.js';
import { LockFormatError, parseLock } from '../../mcp-testing/pin/pin.js';
import { noCommands } from '../../mcp-testing/report/human.js';
import {
  reportOutputs,
  writeReport,
  type McpRun,
  type ReportFlags,
} from '../../mcp-testing/report/index.js';
import {
  MAX_FILE_BYTES,
  safe,
  safeText,
  type ConfigFile,
} from '../../mcp-testing/scan/config/config.js';
import { parseScanExceptions } from '../../mcp-testing/scan/exceptions.js';
import { parseProbeFile } from '../../mcp-testing/scan/probes/file.js';
import { DEFAULT_MAX_CALLS, DEFAULT_MAX_REQUESTS } from '../../mcp-testing/scan/probes/guard.js';
import { isThisMachine } from '../../mcp-testing/scan/probes/local.js';
import { runProbes, type ProbeRunOptions } from '../../mcp-testing/scan/probes/runner.js';
import { GROUPS, renderScan, type FailOn, type ScanGroup } from '../../mcp-testing/scan/report.js';
import { ALL_RULES, runScan, type ScanSnapshot } from '../../mcp-testing/scan/run.js';
import {
  parseSnapshot,
  serializeSnapshot,
  SnapshotFormatError,
} from '../../mcp-testing/snapshot/index.js';
import { takeSnapshot, writeAtomically, type SnapshotIo } from './mcp-snapshot.js';

export interface McpScanFlags extends ConnectionFlags, ReportFlags {
  snapshot?: string[];
  config?: string[];
  client?: string;
  pinFile?: string;
  only?: string[];
  skip?: string[];
  active?: boolean;
  failOn?: string;
  gateHeuristics?: boolean;
  allowPartial?: boolean;
  ignoreFile?: string;
  allowLongExceptions?: boolean;
  saveSnapshot?: string;
  allowHost?: string[];
  allowPackage?: string[];
  /** Active probes (`--active`): the probe file, the consent, the budgets and the names of the variables with the tokens. */
  probes?: string;
  confirmHost?: string;
  yes?: boolean;
  maxCalls?: string;
  maxRequests?: string;
  tokenEnv?: string;
  otherTokenEnv?: string;
}

export interface ScanIo extends SnapshotIo {
  /** `YYYY-MM-DD` an exception's `expires` is compared with; today in UTC by default. */
  today?: string;
}

export const DEFAULT_SCAN_IGNORE_FILE = 'plune-mcp-scan-ignore.yaml';

/**
 * The project files each client reads, in the folder the command runs in. Read from the clients' documentation on
 * 2026-11-13: Claude Code, https://code.claude.com/docs/en/mcp ("storing configurations in a `.mcp.json` file at your
 * project's root directory", key `mcpServers`); Cursor, https://cursor.com/docs/context/mcp ("Create
 * `.cursor/mcp.json` in your project for project-specific tools", key `mcpServers`); VS Code,
 * https://code.visualstudio.com/docs/agents/reference/mcp-configuration (the `servers` format in the workspace
 * `.vscode/mcp.json`). User-level files (`~/.claude.json`, `~/.cursor/mcp.json`) are not read by `--client`: name one
 * with `--config`.
 */
export const CLIENT_FILES = {
  'claude-code': '.mcp.json',
  cursor: '.cursor/mcp.json',
  vscode: '.vscode/mcp.json',
} as const;
type Client = keyof typeof CLIENT_FILES;
const CLIENTS = Object.keys(CLIENT_FILES) as Client[];

const FORMATS = ['human', 'json', 'github', 'sarif'] as const;
const FILE_FORMATS = ['json', 'junit-xml', 'sarif'] as const;

/** `--only a,b` and repeated: the groups named, or a usage error. */
function groupsOf(flag: string, values: string[] | undefined): ScanGroup[] | undefined {
  if (values === undefined) return undefined;
  const names = values
    .flatMap((v) => v.split(','))
    .map((s) => s.trim())
    .filter((s) => s !== '');
  for (const n of names)
    if (!(GROUPS as readonly string[]).includes(n))
      throw new UsageError(`${flag}: "${n}" is not a group (${GROUPS.join(', ')}).`);
  return names as ScanGroup[];
}

/** A file over `MAX_FILE_BYTES`: a snapshot or a pin file becomes a "not evaluated" row, an exceptions file a usage error. */
class TooLargeError extends UsageError {}
/** A file whose size or contents cannot be read (gone since the check, no permission): the same outcomes as too large. */
class UnreadableError extends UsageError {}

/**
 * A path as a report shows it: relative to the folder when inside it, else the file name alone. An absolute path
 * carries the user's home folder, and a report is uploaded, committed and posted.
 */
function shown(cwd: string, path: string): string {
  const full = resolve(cwd, path);
  const rel = relative(cwd, full);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
    ? rel.replace(/\\/g, '/')
    : basename(full);
}

function readText(cwd: string, path: string, flag: string, limit = true): string {
  const full = resolve(cwd, path);
  if (!existsSync(full)) throw new UsageError(`${flag}: ${path} does not exist.`);
  // A fixed message: the text of an OS error holds the full path.
  const unreadable = () =>
    new UnreadableError(`${flag}: ${safeText(shown(cwd, path))} cannot be read.`);
  let size = 0;
  if (limit)
    try {
      size = statSync(full).size;
    } catch {
      throw unreadable();
    }
  if (size > MAX_FILE_BYTES)
    throw new TooLargeError(
      `${flag}: ${path} is too large to read (over ${MAX_FILE_BYTES / 1024 / 1024} MiB).`,
    );
  try {
    return readFileSync(full, 'utf8');
  } catch {
    throw unreadable();
  }
}

/** Which client's format a configuration file is in, from its name; Claude Code's when nothing says. */
function clientOf(path: string): ConfigFile['client'] {
  const p = path.replace(/\\/g, '/').toLowerCase();
  if (p.endsWith('claude_desktop_config.json')) return 'claude-desktop';
  if (p.includes('.cursor/')) return 'cursor';
  if (p.includes('.vscode/')) return 'vscode';
  return 'claude-code';
}

/** The exit code. A failure the user can act on is printed here; anything else is thrown. */
export async function handleMcpScan(
  flags: McpScanFlags,
  server: string[],
  raw: ScanIo,
): Promise<number> {
  const io: ScanIo = { ...raw, err: (text) => raw.err(noCommands(text)) };
  try {
    return await scan(flags, server, io);
  } catch (err) {
    if (
      err instanceof UsageError ||
      err instanceof ExceptionsFileError ||
      err instanceof LockFormatError ||
      err instanceof SnapshotFormatError
    ) {
      io.err(`plune mcp scan: ${err.message}\n`);
      return MCP_EXIT.usage;
    }
    throw err;
  }
}

async function scan(flags: McpScanFlags, server: string[], io: ScanIo): Promise<number> {
  const failOn = (flags.failOn ?? 'error') as FailOn;
  if (!['error', 'warn', 'never'].includes(failOn))
    throw new UsageError(`--fail-on must be error, warn or never (got "${flags.failOn}").`);
  const outputs = reportOutputs(flags, io.cwd, { sarif: true });
  if (!(FORMATS as readonly string[]).includes(outputs.format))
    throw new UsageError(
      `--format must be one of ${FORMATS.join(', ')} (got "${outputs.format}").`,
    );
  for (const f of outputs.files)
    if (!(FILE_FORMATS as readonly string[]).includes(f.format))
      throw new UsageError(
        `--out: ${f.format} is not written by scan (${FILE_FORMATS.join(', ')}).`,
      );
  if (flags.client !== undefined && !(CLIENTS as string[]).includes(flags.client))
    throw new UsageError(`--client must be one of ${CLIENTS.join(', ')} (got "${flags.client}").`);
  const only = groupsOf('--only', flags.only);
  const skip = groupsOf('--skip', flags.skip);
  const live = flags.url !== undefined || server.length > 0;

  // The active probes are planned first: a bad probe file, token or budget is a usage error before any connection.
  let plan: Omit<ProbeRunOptions, 'announce'> | undefined;
  if (flags.active === true) plan = planProbes(flags, server, io);
  else if (
    flags.probes !== undefined ||
    flags.confirmHost !== undefined ||
    flags.yes === true ||
    flags.maxCalls !== undefined ||
    flags.maxRequests !== undefined ||
    flags.tokenEnv !== undefined ||
    flags.otherTokenEnv !== undefined
  )
    throw new UsageError(
      '--probes, --confirm-host, --yes, --max-calls, --max-requests, --token-env and --other-token-env are for --active; nothing is sent without it.',
    );

  // snapshots: files named by the user, and at most one live server
  const snapshots: ScanSnapshot[] = [];
  const unreadable: { target: string; reason: string }[] = [];
  for (const spec of flags.snapshot ?? []) {
    const named = /^([A-Za-z0-9_.-]+)=(.+)$/s.exec(spec);
    const path = named === null ? spec : (named[2] ?? '');
    let text: string;
    try {
      text = readText(io.cwd, path, '--snapshot');
    } catch (err) {
      if (!(err instanceof TooLargeError) && !(err instanceof UnreadableError)) throw err;
      unreadable.push({
        target: shown(io.cwd, path),
        reason:
          err instanceof TooLargeError
            ? 'the file is too large to read (over 8 MiB)'
            : 'the file cannot be read',
      });
      continue;
    }
    let snapshot;
    try {
      snapshot = parseSnapshot(text);
    } catch (err) {
      if (err instanceof SnapshotFormatError)
        throw new UsageError(`--snapshot ${path}: ${err.message}.`);
      throw err;
    }
    const label =
      named?.[1] ??
      (snapshot.server?.name !== undefined && snapshot.server.name !== ''
        ? snapshot.server.name
        : basename(path).replace(/\.[^.]*$/, ''));
    snapshots.push({ label, snapshot, file: shown(io.cwd, path), text });
  }
  if (live) {
    const config = connectionConfig(flags, server, io.env);
    if (io.clientVersion !== undefined) config.clientVersion = io.clientVersion;
    try {
      const snapshot = await takeSnapshot(config);
      const text = serializeSnapshot(snapshot);
      if (flags.saveSnapshot !== undefined)
        writeAtomically(
          resolve(io.cwd, flags.saveSnapshot),
          text,
          flags.saveSnapshot,
          '--save-snapshot',
        );
      snapshots.push({
        label:
          snapshot.server?.name !== undefined && snapshot.server.name !== ''
            ? snapshot.server.name
            : 'server',
        snapshot,
        ...(flags.saveSnapshot === undefined
          ? {}
          : { file: shown(io.cwd, flags.saveSnapshot), text }),
      });
    } catch (err) {
      if (!(err instanceof ConnectError) && !(err instanceof SnapshotFormatError)) throw err;
      // Not reached: nothing was read, and that is not a pass.
      unreadable.push({
        target: 'live server',
        reason: 'the server could not be reached or its lists could not be read',
      });
      io.err(`plune mcp scan: ${err.message} Nothing was scanned for this server.\n`);
    }
  } else if (flags.saveSnapshot !== undefined)
    throw new UsageError('--save-snapshot is for a live server (--url, or a command after --).');

  const labelFile = new Map<string, string>();
  for (const s of snapshots) {
    const where = s.file ?? 'the live server';
    const first = labelFile.get(s.label);
    if (first !== undefined)
      throw new UsageError(
        `two snapshots are called "${safe(s.label)}" (${safeText(first)} and ${safeText(where)}); a label names a server, so name them apart: label=file.`,
      );
    labelFile.set(s.label, where);
  }

  // configuration files: only those named, or the project file of the client named, in this folder
  const configFiles: ConfigFile[] = [];
  let configMissing: string | undefined;
  for (const path of flags.config ?? [])
    configFiles.push({
      path: shown(io.cwd, path),
      client: (flags.client as Client | undefined) ?? clientOf(path),
      text: readText(io.cwd, path, '--config', false),
    });
  let configRequested = (flags.config ?? []).length > 0;
  if ((flags.config ?? []).length === 0 && flags.client !== undefined) {
    configRequested = true;
    const path = CLIENT_FILES[flags.client as Client];
    if (existsSync(resolve(io.cwd, path)))
      configFiles.push({
        path,
        client: flags.client as Client,
        text: readText(io.cwd, path, '--client', false),
      });
    else configMissing = `${path} is not in this folder`;
  }

  let pin: { file: string; text: string; lock: ReturnType<typeof parseLock> } | undefined;
  let pinProblem: { file: string; reason: string } | undefined;
  if (flags.pinFile !== undefined) {
    let text: string | undefined;
    try {
      text = readText(io.cwd, flags.pinFile, '--pin-file');
    } catch (err) {
      if (!(err instanceof TooLargeError) && !(err instanceof UnreadableError)) throw err;
      pinProblem = {
        file: shown(io.cwd, flags.pinFile),
        reason:
          err instanceof TooLargeError
            ? 'the file is too large to read (over 8 MiB)'
            : 'the file cannot be read',
      };
    }
    try {
      if (text !== undefined)
        pin = { file: shown(io.cwd, flags.pinFile), text, lock: parseLock(text) };
    } catch (err) {
      if (err instanceof LockFormatError)
        throw new LockFormatError(`--pin-file ${flags.pinFile}: ${err.message}.`);
      throw err;
    }
  }

  const today = io.today ?? new Date().toISOString().slice(0, 10);
  const ignoreName =
    flags.ignoreFile ??
    (existsSync(resolve(io.cwd, DEFAULT_SCAN_IGNORE_FILE)) ? DEFAULT_SCAN_IGNORE_FILE : undefined);
  const exceptions =
    ignoreName === undefined
      ? undefined
      : {
          file: shown(io.cwd, ignoreName),
          ...parseScanExceptions(readText(io.cwd, ignoreName, '--ignore-file'), ignoreName, today, {
            allowLong: flags.allowLongExceptions === true,
          }),
        };

  const asked =
    snapshots.length > 0 ||
    unreadable.length > 0 ||
    configRequested ||
    pin !== undefined ||
    pinProblem !== undefined ||
    flags.active === true ||
    (only?.length ?? 0) > 0;
  if (!asked)
    throw new UsageError(
      'Name something to scan: --snapshot <file>, --config <file> or --client, --pin-file <file>, or a server (--url, or a command after --).',
    );
  if (
    (pin !== undefined || pinProblem !== undefined) &&
    snapshots.length === 0 &&
    unreadable.length === 0
  )
    throw new UsageError(
      '--pin-file compares a server with the file: give --snapshot <file> or a live server too.',
    );

  const probes =
    plan === undefined
      ? undefined
      : await runProbes({ ...plan, announce: (line) => io.err(`plune mcp scan: ${line}\n`) });

  const report = runScan(
    {
      snapshots,
      unreadable,
      configFiles,
      configRequested,
      ...(configMissing === undefined ? {} : { configMissing }),
      ...(pin === undefined ? {} : { pin }),
      ...(pinProblem === undefined ? {} : { pinProblem }),
      active: flags.active === true,
      ...(probes === undefined ? {} : { probes }),
      allowHosts: flags.allowHost ?? [],
      allowPackages: flags.allowPackage ?? [],
    },
    {
      ...(only === undefined ? {} : { only }),
      ...(skip === undefined ? {} : { skip }),
      failOn,
      gateHeuristics: flags.gateHeuristics === true,
      allowPartial: flags.allowPartial === true,
      ...(exceptions === undefined ? {} : { exceptions }),
    },
  );
  if (report.groups.every((g) => g.state === 'not-requested'))
    throw new UsageError('nothing was scanned: --only and --skip left every group out.');
  const run: McpRun = {
    command: 'scan',
    document: report,
    cases: [],
    checks: [],
    nothing: '',
    showInfo: false,
    custom: (format) => renderScan(report, format, ALL_RULES, io.clientVersion ?? '0'),
  };
  writeReport(run, outputs, io);
  return report.exitCode;
}

/** A positive whole number from a flag. */
function count(flag: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^\d{1,6}$/.test(value) || Number(value) < 1)
    throw new UsageError(`${flag} must be a whole number of 1 or more.`);
  return Number(value);
}

/** A token is read from the variable a flag names; unset and empty are both refused. */
function token(flag: string, name: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  if (name === undefined) return undefined;
  const value = env[name];
  if (value === undefined || value === '')
    throw new UsageError(`${flag}: the variable ${name} is not set or is empty.`);
  return value;
}

/** The active probes: the file, the consent, the tokens and the budgets in, the section of the report out. */
function planProbes(
  flags: McpScanFlags,
  server: string[],
  io: ScanIo,
): Omit<ProbeRunOptions, 'announce'> {
  const entries =
    flags.probes === undefined
      ? undefined
      : parseProbeFile(readText(io.cwd, flags.probes, '--probes'), shown(io.cwd, flags.probes));
  const live = flags.url !== undefined || server.length > 0;
  const config = live ? connectionConfig(flags, server, io.env) : undefined;
  const tokens = {
    ...(flags.tokenEnv === undefined
      ? {}
      : { accountA: token('--token-env', flags.tokenEnv, io.env)! }),
    ...(flags.otherTokenEnv === undefined
      ? {}
      : { accountB: token('--other-token-env', flags.otherTokenEnv, io.env)! }),
  };
  const target = config?.target;
  if (
    Object.keys(tokens).length > 0 &&
    target !== undefined &&
    target.kind !== 'stdio' &&
    new URL(target.url).protocol !== 'https:' &&
    !isThisMachine(target.url)
  )
    throw new UsageError(
      'A token goes only over https, or over http to this machine; this address is plain http to another host.',
    );
  return {
    entries,
    target,
    tokens,
    ...(flags.confirmHost === undefined ? {} : { confirmHost: flags.confirmHost }),
    maxCalls: count('--max-calls', flags.maxCalls, DEFAULT_MAX_CALLS),
    maxRequests: count('--max-requests', flags.maxRequests, DEFAULT_MAX_REQUESTS),
    timeoutMs: config?.timeoutMs ?? 30_000,
  };
}
