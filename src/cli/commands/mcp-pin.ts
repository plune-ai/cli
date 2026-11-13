// `plune mcp pin`: show a server's tools, prompts and resource templates in full, and on an explicit approval write them
// to a lock file that is committed with the project; `--check` compares a live server with that file for CI, and
// `--stability` asks for the tool list several times. The format, the hashes and the comparison live in
// src/mcp-testing/pin/pin.ts; this file connects, asks, prints and writes.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  connectionConfig,
  UsageError,
  type ConnectConfig,
  type ConnectionFlags,
} from '../../mcp-testing/connect/options.js';
import { ConnectError, openSession } from '../../mcp-testing/connect/session.js';
import { listAll } from '../../mcp-testing/connect/tools.js';
import { MCP_EXIT } from '../../mcp-testing/exit-codes.js';
import {
  applyApproved,
  comparePinned,
  emptyLock,
  HASHED_FIELDS,
  keyOf,
  LOCK_FILE,
  LockFormatError,
  measureStability,
  parseLock,
  PIN_RULES,
  pinEntry,
  pinnedCount,
  pinServer,
  serializeLock,
  stabilityFindings,
  type ListingSession,
  type LockFile,
  type PinComparison,
  type PinDifference,
  type PinnedEntry,
  type PinnedSection,
  type PinnedServer,
  type StabilityFinding,
} from '../../mcp-testing/pin/pin.js';
import { noCommands, noCommandsJson } from '../../mcp-testing/report/human.js';
import { visible } from '../../mcp-testing/scan/descriptions.js';
import { buildSnapshot, SnapshotFormatError } from '../../mcp-testing/snapshot/index.js';
import { parseTimerDuration } from '../../util/duration.js';
import { takeSnapshot, writeAtomically, type SnapshotIo } from './mcp-snapshot.js';

export interface McpPinFlags extends ConnectionFlags {
  check?: boolean;
  stability?: boolean;
  yes?: boolean;
  lock?: string;
  name?: string;
  format?: string;
  times?: string;
  pause?: string;
  wait?: string;
}

export interface PinIo extends SnapshotIo {
  /** A person can answer a question (stdin and stderr are a terminal). */
  interactive: boolean;
  /** Asks a yes/no question; only called when `interactive`. */
  confirm(question: string): Promise<boolean>;
  /** The time of an approval (tests fix it). */
  now?: () => Date;
}

/**
 * What `--stability` says of its own limit, every time: it is part of the result, not a footnote. A server that answers
 * a scanner one list and a model's client another is not caught by asking more often.
 */
export const STABILITY_LIMIT =
  'Limit: this sees only what the server answered this connection, at this time. A server can answer a scanner differently from the client a model uses: by the client name in initialize, the number of calls, the time or the address.';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Every line as `visible` shows it: nothing that does not print reaches the terminal, whatever the server sent. */
const shown = (text: string): string =>
  text
    .split('\n')
    .map((line) => visible(line, Infinity))
    .join('\n');

/** JSON with everything outside printable ASCII as `\uXXXX`: the same document to a parser, nothing hidden to a person. */
const asciiJson = (doc: unknown): string =>
  `${JSON.stringify(doc, null, 2).replace(/[^\x20-\x7e\n]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}\n`;

/** The exit code. Every failure the user can act on is printed here; anything else is thrown. */
export async function handleMcpPin(flags: McpPinFlags, server: string[], raw: PinIo): Promise<number> {
  const json = flags.format === 'json';
  const io: PinIo = {
    ...raw,
    out: (text) => raw.out(json ? noCommandsJson(text) : noCommands(shown(text))),
    err: (text) => raw.err(noCommands(shown(text))),
    // The question names the server's entry, which is the server's own text.
    confirm: (question) => raw.confirm(noCommands(shown(question))),
  };
  try {
    if (flags.format !== undefined && flags.format !== 'human' && flags.format !== 'json')
      throw new UsageError(`--format must be human or json (got "${flags.format}").`);
    if (flags.check === true && flags.stability === true) throw new UsageError('Give --check or --stability, not both.');
    if (json && flags.check !== true && flags.stability !== true)
      throw new UsageError('--format json is for --check and --stability; pinning shows what it pins to a person.');
    const config = connectionConfig(flags, server, io.env);
    if (io.clientVersion !== undefined) config.clientVersion = io.clientVersion;
    if (flags.stability === true) return await stability(flags, config, io, json);
    return await pinOrCheck(flags, config, io, json);
  } catch (err) {
    if (err instanceof UsageError || err instanceof LockFormatError) {
      io.err(`plune mcp pin: ${err.message}\n`);
      if (json) io.out(asciiJson({ kind: KIND(flags), schemaVersion: 1, result: 'usage-error', exitCode: MCP_EXIT.usage, error: err.message }));
      return MCP_EXIT.usage;
    }
    // Not reached, or the lists could not be read: nothing was compared, and that is not a match.
    if (err instanceof ConnectError || err instanceof SnapshotFormatError) {
      const message = `${err.message} Nothing was compared.`;
      io.err(`plune mcp pin: ${message}\n`);
      if (err instanceof ConnectError && err.stderrTail.length > 0)
        io.err(`The last lines the server wrote to stderr:\n${err.stderrTail.map((l) => `  ${l}\n`).join('')}`);
      if (json) io.out(asciiJson({ kind: KIND(flags), schemaVersion: 1, result: 'unmeasured', exitCode: MCP_EXIT.unmeasured, error: message }));
      return MCP_EXIT.unmeasured;
    }
    throw err;
  }
}

const KIND = (flags: McpPinFlags) => (flags.stability === true ? 'plune-mcp-pin-stability' : 'plune-mcp-pin-check');

function readLock(path: string, name: string, required: boolean): LockFile {
  if (!existsSync(path)) {
    if (required) throw new UsageError(`${name} does not exist; pin the server first with plune mcp pin.`);
    return emptyLock();
  }
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new UsageError(`${name}: cannot be read (${(err as NodeJS.ErrnoException).code ?? 'an error'}).`);
  }
  try {
    return parseLock(text);
  } catch (err) {
    if (err instanceof LockFormatError) throw new LockFormatError(`${name}: ${err.message}.`);
    throw err;
  }
}

/** Where the server was reached, with no secret: `stdio` (the command stays out), or the HTTP origin and path. */
function sourceOf(config: ConnectConfig): string {
  if (config.target.kind === 'stdio') return 'stdio';
  const url = new URL(config.target.url);
  return `${url.origin}${url.pathname}`;
}

async function pinOrCheck(flags: McpPinFlags, config: ConnectConfig, io: PinIo, json: boolean): Promise<number> {
  const lockName = flags.lock ?? LOCK_FILE;
  const lockPath = resolve(io.cwd, lockName);
  const lock = readLock(lockPath, lockName, flags.check === true);
  const snapshot = await takeSnapshot(config);
  const approvedAt = (io.now?.() ?? new Date()).toISOString();
  const live = pinServer(snapshot, sourceOf(config), approvedAt);
  if (pinnedCount(live) === 0) {
    const message = 'Nothing measured: the server lists no tool, prompt or resource template.';
    io.err(`plune mcp pin: ${message}${flags.check === true ? ' Nothing was compared.' : ' Nothing written.'}\n`);
    if (json) io.out(asciiJson({ kind: KIND(flags), schemaVersion: 1, result: 'unmeasured', exitCode: MCP_EXIT.unmeasured, error: message }));
    return MCP_EXIT.unmeasured;
  }
  const label = flags.name ?? (snapshot.server?.name || sourceOf(config));
  const pinned = Object.hasOwn(lock.servers, label) ? lock.servers[label] : undefined;
  if (flags.check === true) return check(label, lockName, pinned, live, lock, io, json);

  if (pinned === undefined) {
    io.out(`Server ${JSON.stringify(label)} (${live.transport}, ${live.source}) is not in ${lockName}. Everything it lists, in full:\n\n`);
    io.out(fullListing(live));
    const n = pinnedCount(live);
    if (!(await approved(flags, io, `Pin these ${n} ${n === 1 ? 'entry' : 'entries'} of ${JSON.stringify(label)} in ${lockName}? [y/N] `))) return declined(flags, io);
    lock.servers[label] = live;
    writeAtomically(lockPath, serializeLock(lock), lockName, '--lock');
    io.out(`\nPinned ${n} ${n === 1 ? 'entry' : 'entries'} of ${JSON.stringify(label)} in ${lockName}. Commit the file: the commit is the approval.\n`);
    return MCP_EXIT.ok;
  }

  const comparison = comparePinned(pinned, live);
  io.out(header(label, lockName, pinned, comparison));
  if (comparison.same) {
    io.out('Nothing to approve; the file is left as it is.\n');
    return MCP_EXIT.ok;
  }
  const take: PinDifference[] = [];
  if (flags.yes !== true && !io.interactive) {
    for (const d of comparison.differences) io.out(renderDifference(d));
    return declined(flags, io);
  }
  for (const d of comparison.differences) {
    io.out(renderDifference(d));
    if (flags.yes === true || (await io.confirm(`Approve this ${d.class === 'changed' ? 'change' : d.class === 'added' ? 'addition' : 'removal'}? [y/N] `))) take.push(d);
  }
  if (take.length === 0) {
    io.out('\nNothing approved; the file is left as it is.\n');
    return MCP_EXIT.violations;
  }
  lock.servers[label] = applyApproved(pinned, live, take, approvedAt);
  writeAtomically(lockPath, serializeLock(lock), lockName, '--lock');
  const left = comparison.differences.length - take.length;
  io.out(`\nWrote ${lockName}: ${take.length} approved${left > 0 ? `, ${left} left as pinned (pin --check fails until they are approved)` : ''}. Commit the file: the commit is the approval.\n`);
  return left > 0 ? MCP_EXIT.violations : MCP_EXIT.ok;
}

async function approved(flags: McpPinFlags, io: PinIo, question: string): Promise<boolean> {
  if (flags.yes === true) return true;
  if (!io.interactive) return false;
  return io.confirm(question);
}

/** Without a person to ask and without --yes, nothing is written: exit 2. A person who says no: exit 1. */
function declined(flags: McpPinFlags, io: PinIo): number {
  if (flags.yes !== true && !io.interactive) {
    io.err('plune mcp pin: Nothing written: an approval is needed. Run it in a terminal to answer, or pass --yes once you have read what is shown above.\n');
    return MCP_EXIT.usage;
  }
  io.out('\nNot approved; nothing written.\n');
  return MCP_EXIT.violations;
}

function check(label: string, lockName: string, pinned: PinnedServer | undefined, live: PinnedServer, lock: LockFile, io: PinIo, json: boolean): number {
  if (pinned === undefined) {
    const labels = Object.keys(lock.servers);
    const message = `server ${JSON.stringify(label)}: no entry in the pin file; nothing was compared`;
    if (json) {
      io.out(asciiJson({ kind: 'plune-mcp-pin-check', schemaVersion: 1, lock: lockName, server: label, result: 'not-pinned', rule: 'scan/pin/server-not-pinned', exitCode: MCP_EXIT.violations, message }));
    } else {
      io.out(`${message} (scan/pin/server-not-pinned).\n`);
      io.out(`${lockName} pins ${labels.length === 0 ? 'no server' : labels.map((l) => JSON.stringify(l)).join(', ')}. ${PIN_RULES['scan/pin/server-not-pinned'].fix}\n`);
    }
    return MCP_EXIT.violations;
  }
  const comparison = comparePinned(pinned, live);
  const exitCode = comparison.same ? MCP_EXIT.ok : MCP_EXIT.violations;
  if (json) {
    io.out(
      asciiJson({
        kind: 'plune-mcp-pin-check',
        schemaVersion: 1,
        lock: lockName,
        server: label,
        approvedAt: pinned.approvedAt,
        result: comparison.same ? 'match' : 'differs',
        exitCode,
        unchanged: comparison.unchanged,
        ...(comparison.version === undefined ? {} : { version: comparison.version }),
        differences: comparison.differences.map((d) => ({
          class: d.class,
          ...(d.rule === undefined ? {} : { rule: d.rule }),
          section: d.section,
          name: d.name,
          modelText: d.modelText,
          changes: d.changes.map((c) => ({ field: c.field, kind: c.kind, classification: c.classification, reason: c.reason, before: c.before, after: c.after, ...(c.signal === undefined ? {} : { signal: c.signal }) })),
          pinned: d.pinned,
          live: d.live,
        })),
      }),
    );
    return exitCode;
  }
  io.out(header(label, lockName, pinned, comparison));
  for (const d of comparison.differences) io.out(renderDifference(d));
  if (!comparison.same) io.out(`\nReview the differences; to approve them, run plune mcp pin and commit ${lockName}.\n`);
  return exitCode;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const NOUN: Record<PinnedSection, string> = { tools: 'tool', prompts: 'prompt', resourceTemplates: 'resource template' };

function header(label: string, lockName: string, pinned: PinnedServer, c: PinComparison): string {
  const count = (cls: PinDifference['class']) => c.differences.filter((d) => d.class === cls).length;
  const lines = [
    `Server ${JSON.stringify(label)} (${pinned.transport}, ${pinned.source}), approved ${pinned.approvedAt} in ${lockName}: ` +
      (c.same ? `the same, ${plural(c.unchanged, 'entry', 'entries')} as pinned.` : `${count('changed')} changed, ${count('added')} added, ${count('removed')} removed, ${c.unchanged} as pinned.`),
  ];
  if (c.version !== undefined) lines.push(`The server version changed from ${c.version.pinned} to ${c.version.live}; the version is not pinned, it is shown for reference.`);
  return `${lines.join('\n')}\n`;
}

/** Server text as a block: each line behind `| `, so it cannot pass for a line of this report. */
const block = (indent: string, text: string, mark = '|') =>
  text
    .split(/\r?\n/)
    .map((l) => `${indent}${mark} ${l}`)
    .join('\n');

/** One entry in full, every hashed field, as it will be pinned. */
function renderEntry(section: PinnedSection, e: PinnedEntry): string {
  const lines = [`${NOUN[section]} ${keyOf(section, e)}`, `  sha256 ${e.sha256}`];
  for (const f of HASHED_FIELDS[section]) {
    const v = e[f];
    if (v === undefined || f === 'name' || f === 'uriTemplate') continue;
    lines.push(`  ${f}:`, block('    ', typeof v === 'string' ? v : JSON.stringify(v, null, 2)));
  }
  return `${lines.join('\n')}\n`;
}

function fullListing(s: PinnedServer): string {
  const parts: string[] = [];
  for (const section of Object.keys(HASHED_FIELDS) as PinnedSection[]) for (const e of s[section] ?? []) parts.push(renderEntry(section, e));
  return `${parts.join('\n')}\n`;
}

const primitive = (v: unknown) => v === null || ['boolean', 'number'].includes(typeof v);

function renderDifference(d: PinDifference): string {
  const subject = d.name === '' ? 'the lists' : `${NOUN[d.section]} ${d.name}`;
  const lines = [`\n${d.class.padEnd(8)} ${subject}${d.modelText ? '  [the text the model reads changed]' : ''}${d.rule === undefined ? '' : `  (${d.rule})`}`];
  if (d.name === '') lines.push('  The server hash differs, though no entry does: the lists differ in order, or a section is declared differently.');
  if (d.class === 'added') for (const e of d.live) lines.push(renderEntry(d.section, e).trimEnd().replace(/^/gm, '  '));
  for (const c of d.changes) {
    lines.push(`  ${c.field}  ${c.classification}: ${c.reason}`);
    if (typeof c.before === 'string' || typeof c.after === 'string') {
      // The old and the new text one under the other, whole: what a model was told and what it is told now.
      lines.push(typeof c.before === 'string' ? block('    ', c.before, 'pinned |') : '    pinned | (none)');
      lines.push(typeof c.after === 'string' ? block('    ', c.after, 'now    |') : '    now    | (none)');
    } else if ((c.before === undefined || primitive(c.before)) && (c.after === undefined || primitive(c.after))) {
      lines.push(`    pinned: ${c.before === undefined ? '(not set)' : JSON.stringify(c.before)}, now: ${c.after === undefined ? '(not set)' : JSON.stringify(c.after)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function duration(flag: string, value: string): number {
  if (value.trim() === '0') return 0;
  try {
    return parseTimerDuration(value);
  } catch (err) {
    throw new UsageError(`${flag}: ${(err as Error).message}.`);
  }
}

async function stability(flags: McpPinFlags, config: ConnectConfig, io: PinIo, json: boolean): Promise<number> {
  const times = Number(flags.times ?? '3');
  if (!Number.isInteger(times) || times < 2 || times > 100) throw new UsageError(`--times must be a whole number from 2 to 100 (got "${flags.times}").`);
  const pauseMs = duration('--pause', flags.pause ?? '1s');
  const waitMs = duration('--wait', flags.wait ?? '2s');

  const open = async (): Promise<ListingSession> => {
    const session = await openSession(config);
    const result = session.handshake.result;
    const tools = isRecord(result) && isRecord(result['capabilities']) ? result['capabilities']['tools'] : undefined;
    return {
      declared: isRecord(tools) && tools['listChanged'] === true,
      async tools() {
        let listing: Awaited<ReturnType<typeof listAll>>;
        try {
          listing = await listAll(session, 'tools/list', 'tools');
        } catch (err) {
          if (err instanceof ConnectError) throw err;
          throw new ConnectError('protocol', `tools/list failed: ${(err as Error).message}.`, []);
        }
        if (listing.malformed || !listing.complete) throw new ConnectError('protocol', 'tools/list did not answer with a whole tools list.', []);
        const snapshot = buildSnapshot({ transport: config.target.kind, tools: listing.items.map((t) => session.redact.value(t)) });
        return (snapshot.tools ?? []).map((t) => pinEntry('tools', t as unknown as Record<string, unknown>));
      },
      announced: () => session.notified('notifications/tools/list_changed'),
      close: () => session.close(),
    };
  };

  const answers = await measureStability(open, { times, pauseMs, waitMs });
  const findings = stabilityFindings(answers);
  const exitCode = findings.some((f) => f.level === 'warn') ? MCP_EXIT.violations : MCP_EXIT.ok;
  if (json) {
    io.out(
      asciiJson({
        kind: 'plune-mcp-pin-stability',
        schemaVersion: 1,
        exitCode,
        requests: { firstSession: times, pauseMs, waitMs, newSession: 1 },
        announced: answers.announced,
        declaredListChanged: answers.declared,
        findings,
        limit: STABILITY_LIMIT,
      }),
    );
    return exitCode;
  }
  io.out(`tools/list was asked ${times} times in one session (${pauseMs} ms apart, then ${waitMs} ms for list_changed), and once in a new session.\n`);
  io.out(findings.length === 0 ? 'No finding: every answer was the same list.\n' : `${findings.map(renderFinding).join('\n')}\n`);
  io.out(`${STABILITY_LIMIT}\n`);
  return exitCode;
}

const renderFinding = (f: StabilityFinding) => `${f.level.padEnd(5)} ${f.rule}: ${f.message}\n      ${PIN_RULES[f.rule].fix}`;
