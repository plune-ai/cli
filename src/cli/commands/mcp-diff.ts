// `plune mcp diff`: compare a contract snapshot with another snapshot file or with a live server, print every change
// classified, and say by the exit code whether a change at `--fail-on` was found. The rules live in
// src/mcp-testing/snapshot/diff.ts; nothing here judges a change.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  connectionConfig,
  UsageError,
  type ConnectionFlags,
} from '../../mcp-testing/connect/options.js';
import { MCP_EXIT } from '../../mcp-testing/exit-codes.js';
import { noCommands } from '../../mcp-testing/render.js';
import type { McpDiffReport } from '../../mcp-testing/result.js';
import {
  diffSnapshots,
  entityCount,
  parseSnapshot,
  renderDiffMarkdown,
  renderDiffText,
  SnapshotFormatError,
  type McpSnapshot,
} from '../../mcp-testing/snapshot/index.js';
import { printable } from '../../reporter-core/failure-detail.js';
import { reportFailure, takeSnapshot, type SnapshotIo } from './mcp-snapshot.js';

/**
 * Opens a pull request comment of `--format markdown`, so a workflow finds and updates its own comment. Not the eval
 * diff's marker (`plune diff`): the two comments live side by side in one pull request.
 */
export const MCP_DIFF_MARKER = '<!-- plune-mcp-diff -->';

export interface McpDiffFlags extends ConnectionFlags {
  failOn?: string;
  format?: string;
}

export interface DiffOperands {
  baseline: string;
  /** A second snapshot file; without it, the server named by the connection flags is snapshotted. */
  current?: string;
  /** The command after `--`. */
  server: string[];
}

const FAIL_ON = ['breaking', 'any', 'none'] as const;
const FORMATS = ['human', 'json', 'markdown'] as const;

function oneOf<T extends string>(flag: string, value: string, allowed: readonly T[]): T {
  if (!(allowed as readonly string[]).includes(value))
    throw new UsageError(`${flag} must be one of ${allowed.join(', ')} (got "${value}").`);
  return value as T;
}

/**
 * Commander hands every operand as one list, with `--` gone. What follows `--` on the command line is the server
 * command; what comes before it is the baseline and, at most, a current file.
 */
export function diffOperands(
  operands: readonly string[],
  rawArgs: readonly string[],
): DiffOperands {
  const dash = rawArgs.indexOf('--');
  const after = dash < 0 ? 0 : rawArgs.length - dash - 1;
  const files = operands.slice(0, operands.length - after);
  if (files.length > 2)
    throw new UsageError(
      `plune mcp diff takes at most two snapshot files, the baseline and the current one (got ${files.length}); a server command goes after --.`,
    );
  return {
    baseline: files[0] ?? '',
    ...(files[1] === undefined ? {} : { current: files[1] }),
    server: operands.slice(operands.length - after),
  };
}

function readSnapshotFile(name: string, cwd: string): McpSnapshot {
  let text: string;
  try {
    text = readFileSync(resolve(cwd, name), 'utf8');
  } catch (err) {
    throw new UsageError(
      `${name}: cannot be read (${(err as NodeJS.ErrnoException).code ?? 'an error'}).`,
    );
  }
  try {
    return parseSnapshot(text);
  } catch (err) {
    if (err instanceof SnapshotFormatError)
      throw new SnapshotFormatError(`${name}: ${err.message}.`);
    throw err;
  }
}

/** The exit code; every failure the user can act on is printed here, anything else is thrown. */
export async function handleMcpDiff(
  flags: McpDiffFlags,
  operands: DiffOperands,
  raw: SnapshotIo,
): Promise<number> {
  const io: SnapshotIo = {
    ...raw,
    out: (text) => raw.out(noCommands(text)),
    err: (text) => raw.err(noCommands(text)),
  };
  try {
    return await diff(flags, operands, io);
  } catch (err) {
    return reportFailure('diff', err, io);
  }
}

async function diff(flags: McpDiffFlags, operands: DiffOperands, io: SnapshotIo): Promise<number> {
  const failOn = oneOf('--fail-on', flags.failOn ?? 'breaking', FAIL_ON);
  const format = oneOf('--format', flags.format ?? 'human', FORMATS);
  const live = operands.server.length > 0 || flags.url !== undefined;
  if (operands.current !== undefined && live)
    throw new UsageError(
      'Give either a current snapshot file or a server (--url, or a command after --), not both.',
    );
  if (operands.current === undefined && !live)
    throw new UsageError(
      `Name what to compare ${operands.baseline} with: a second snapshot file, or a server (--url, or a command after --).`,
    );
  const before = readSnapshotFile(operands.baseline, io.cwd);
  let after: McpSnapshot;
  if (operands.current !== undefined) after = readSnapshotFile(operands.current, io.cwd);
  else {
    const config = connectionConfig(flags, operands.server, io.env);
    if (io.clientVersion !== undefined) config.clientVersion = io.clientVersion;
    after = await takeSnapshot(config);
  }

  const { changes, summary } = diffSnapshots(before, after);
  const violations =
    failOn === 'breaking' ? summary.breaking > 0 : failOn === 'any' ? changes.length > 0 : false;
  const nothing = entityCount(before) === 0 && entityCount(after) === 0;
  const report: McpDiffReport = {
    schemaVersion: 1,
    command: 'diff',
    failOn,
    summary,
    changes,
    exitCode: violations ? MCP_EXIT.violations : nothing ? MCP_EXIT.unmeasured : MCP_EXIT.ok,
  };
  io.out(render(report, format));
  return report.exitCode;
}

/** Server text reaches the terminal and the comment without a control character, line by line. */
const flat = (text: string) => text.split('\n').map(printable).join('\n');

function render(report: McpDiffReport, format: (typeof FORMATS)[number]): string {
  if (format === 'json') return `${JSON.stringify(report, null, 2)}\n`;
  const diff = { changes: report.changes, summary: report.summary };
  const nothing =
    report.exitCode === MCP_EXIT.unmeasured
      ? 'Nothing to compare: neither snapshot holds a tool, resource, resource template or prompt.'
      : '';
  if (format === 'markdown') {
    return `${[MCP_DIFF_MARKER, '### MCP contract', '', flat(renderDiffMarkdown(diff)).trimEnd(), ...(nothing === '' ? [] : ['', nothing])].join('\n')}\n`;
  }
  return `${[flat(renderDiffText(diff)), '', ...(nothing === '' ? [] : [nothing]), `failing on: ${report.failOn}`].join('\n')}\n`;
}
