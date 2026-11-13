// `plune mcp snapshot`: connect to a server, read every list it declares to its last page, and write the contract as
// one stable JSON file (or to stdout). The format and its normalization live in src/mcp-testing/snapshot/; this file
// only gathers the answers and writes them down.

import { randomBytes } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  connectionConfig,
  UsageError,
  type ConnectConfig,
  type ConnectionFlags,
} from '../../mcp-testing/connect/options.js';
import { isSecretEnv, isSecretHeader, maskUrl } from '../../mcp-testing/connect/redact.js';
import { ConnectError, openSession, type Session } from '../../mcp-testing/connect/session.js';
import { listAll as listToEnd, MAX_PAGES } from '../../mcp-testing/connect/tools.js';
import { MCP_EXIT } from '../../mcp-testing/exit-codes.js';
import { noCommands, noCommandsJson } from '../../mcp-testing/report/human.js';
import {
  checkPushFlags,
  describePush,
  pushSnapshot,
  pushToken,
  SnapshotPushError,
  type PushDeps,
} from './mcp-snapshot-push.js';
import {
  buildSnapshot,
  entityCount,
  nestedDeeperThan,
  SECTIONS,
  serializeSnapshot,
  SnapshotFormatError,
  type McpSnapshot,
  type SnapshotInput,
} from '../../mcp-testing/snapshot/index.js';

export interface McpSnapshotFlags extends ConnectionFlags {
  out?: string;
  /** Send the snapshot to the platform's MCP catalog (nothing is sent without it). */
  push?: boolean;
  /** `--push`: the id of a server the platform has. */
  server?: string;
  /** `--push`: the server's name; found among the project's servers, or created. */
  serverName?: string;
  /** `--push`: where the server was running. */
  environment?: string;
}

export interface SnapshotIo {
  out(text: string): void;
  err(text: string): void;
  /** Where --env KEY and --header-env read from. */
  env: NodeJS.ProcessEnv;
  /** Where a relative --out is written. */
  cwd: string;
  clientVersion?: string;
  /** Test seam for `--push`: the platform address, token, transport. */
  push?: PushDeps;
}

/** Where an unsent snapshot is kept when the platform cannot be reached and no --out was given. */
const KEPT_FILE = 'mcp-snapshot.unsent.json';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The exit code; every failure the user can act on is printed here, anything else is thrown. */
export async function handleMcpSnapshot(
  flags: McpSnapshotFlags,
  server: string[],
  raw: SnapshotIo,
): Promise<number> {
  const io: SnapshotIo = {
    ...raw,
    // stdout carries only the snapshot, a JSON document.
    out: (text) => raw.out(noCommandsJson(text)),
    err: (text) => raw.err(noCommands(text)),
  };
  try {
    const flagProblem = checkPushFlags(flags);
    if (flagProblem !== undefined) throw new UsageError(flagProblem);
    // Asked before the server is connected to: a logged-out `--push` should not wait for a handshake to be told so.
    const token = flags.push === true ? pushToken(io.push ?? {}) : undefined;
    const config = connectionConfig(flags, server, io.env);
    if (io.clientVersion !== undefined) config.clientVersion = io.clientVersion;
    const snapshot = await takeSnapshot(config);
    if (entityCount(snapshot) === 0) {
      io.err(
        'plune mcp snapshot: Nothing measured: the server lists no tool, resource, resource template or prompt. No snapshot written.\n',
      );
      return MCP_EXIT.unmeasured;
    }
    const text = serializeSnapshot(snapshot);
    // With --push the snapshot goes to the platform and stdout carries the answer, so a file is written only if asked for.
    if (flags.out !== undefined) {
      writeAtomically(resolve(io.cwd, flags.out), text, flags.out);
      io.err(`Wrote ${flags.out}: ${counts(snapshot)}.\n`);
    } else if (token === undefined) io.out(text);
    if (token === undefined) return MCP_EXIT.ok;
    try {
      const pushed = await pushSnapshot(
        snapshot,
        {
          ...(flags.server !== undefined ? { serverId: flags.server.trim() } : {}),
          ...(flags.serverName !== undefined ? { serverName: flags.serverName } : {}),
          ...(flags.environment !== undefined ? { environment: flags.environment } : {}),
        },
        token,
        io.push ?? {},
      );
      raw.out(noCommands(describePush(pushed)));
      return MCP_EXIT.ok;
    } catch (err) {
      if (!(err instanceof SnapshotPushError)) throw err;
      io.err(`plune mcp snapshot: ${err.message}\n`);
      if (err.kind !== 'unavailable') return MCP_EXIT.usage;
      // The platform could not be reached: the snapshot is not lost. Exit 1, as `plune run import` does.
      const kept = flags.out ?? KEPT_FILE;
      if (flags.out === undefined) writeAtomically(resolve(io.cwd, kept), text, kept, '--push');
      io.err(`The snapshot is kept in ${kept}.\n`);
      return 1;
    }
  } catch (err) {
    if (err instanceof SnapshotPushError) {
      io.err(`plune mcp snapshot: ${err.message}\n`);
      return MCP_EXIT.usage;
    }
    return reportFailure('snapshot', err, io);
  }
}

/** The failures a `plune mcp` snapshot command reports as exit 2: one sentence each, no stack. */
export function reportFailure(command: string, err: unknown, io: Pick<SnapshotIo, 'err'>): number {
  if (err instanceof UsageError || err instanceof SnapshotFormatError) {
    io.err(`plune mcp ${command}: ${err.message}\n`);
    return MCP_EXIT.usage;
  }
  if (err instanceof ConnectError) {
    io.err(`plune mcp ${command}: ${err.message}\n`);
    if (err.stderrTail.length > 0)
      io.err(
        `The last lines the server wrote to stderr:\n${err.stderrTail.map((l) => `  ${l}\n`).join('')}`,
      );
    return MCP_EXIT.usage;
  }
  throw err;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const counts = (s: McpSnapshot) =>
  [
    plural(s.tools?.length ?? 0, 'tool', 'tools'),
    plural(s.resources?.length ?? 0, 'resource', 'resources'),
    plural(s.resourceTemplates?.length ?? 0, 'resource template', 'resource templates'),
    plural(s.prompts?.length ?? 0, 'prompt', 'prompts'),
  ].join(', ');

/**
 * The snapshot of a live server: the handshake, then every list whose capability the server declared, each to its last
 * page. A declared list that fails, answers without its array, or does not end is a `ConnectError` naming it: a partial
 * snapshot is never returned. What the server sent passes the connection's masking (every value the core knows), and
 * the server's own address never reaches the snapshot.
 */
export async function takeSnapshot(config: ConnectConfig): Promise<McpSnapshot> {
  const session = await openSession(config);
  try {
    const { serverInfo, capabilities, instructions } = initializeResult(session);
    const declared = isRecord(capabilities) ? capabilities : {};
    const masked = (value: unknown, what: string) => {
      // The connection's masking reads MASK_DEPTH levels and cuts the rest to one marker; a cut schema would compare
      // equal to any other cut schema, so a change below the cut would pass as no change.
      if (nestedDeeperThan(value, MASK_DEPTH))
        throw new SnapshotFormatError(
          `${what} is nested deeper than ${MASK_DEPTH} levels, past what the masking of secrets reads, so it cannot be compared. No snapshot written`,
        );
      return session.redact.value(value);
    };
    const input: SnapshotInput = {
      transport: config.target.kind,
      serverInfo: masked(serverInfo, 'The server info'),
      instructions: masked(instructions, 'The instructions'),
      capabilities: masked(capabilities, 'The capabilities'),
    };
    for (const { section, capability, method, key, entity } of SECTIONS) {
      if (declared[capability] === undefined) continue;
      const listed = await listAll(session, method, section);
      input[section] =
        listed === null
          ? null
          : listed.map((entry, i) => {
              const id = isRecord(entry) ? entry[key] : undefined;
              return masked(
                entry,
                typeof id === 'string'
                  ? `The ${entity} ${JSON.stringify(id)}`
                  : `${method} entry ${i}`,
              );
            });
    }
    return buildSnapshot(input, {
      secrets: addressOf(config),
      credentials: credentialsOf(config),
      home: homedir(),
    });
  } finally {
    await session.close();
  }
}

/** How deep the connection's masking reads an entity (its own limit, in src/mcp-testing/connect/redact.ts). */
const MASK_DEPTH = 64;
/** As the connection's masking: a value shorter than this is looked for only when its name says it is a credential. */
const MIN_ARGUMENT_LENGTH = 8;

/**
 * What the snapshot masks at any length besides what the connection masks: the values of credential-named variables
 * and headers, however short (`API_KEY=sk12345`), and the command line that starts the server, which a server may
 * repeat (its path names this machine).
 */
function credentialsOf(config: ConnectConfig): string[] {
  const { target } = config;
  if (target.kind !== 'stdio')
    return Object.entries(target.headers)
      .filter(([name]) => isSecretHeader(name))
      .map(([, value]) => value);
  return [
    ...Object.entries(target.env)
      .filter(([name]) => isSecretEnv(name))
      .map(([, value]) => value),
    ...[target.command, ...target.args].filter((part) => part.length >= MIN_ARGUMENT_LENGTH),
  ];
}

/** The forms of an HTTP server's address, masked by the snapshot wherever the server repeats it. */
function addressOf(config: ConnectConfig): string[] {
  const { target } = config;
  if (target.kind === 'stdio') return [];
  const url = new URL(target.url);
  return [target.url, url.href, maskUrl(target.url), url.origin];
}

/** The JSON-RPC code of a method the server does not have. */
const METHOD_NOT_FOUND = -32601;

/**
 * `serverInfo`, `capabilities` and `instructions` of the `initialize` result as the server sent it (the session keeps
 * the raw frame); each undefined when the result is not an object or lacks it.
 */
function initializeResult(session: Session): {
  serverInfo: unknown;
  capabilities: unknown;
  instructions: unknown;
} {
  const result = session.handshake.result;
  if (!isRecord(result))
    return { serverInfo: undefined, capabilities: undefined, instructions: undefined };
  return {
    serverInfo: result.serverInfo,
    capabilities: result.capabilities,
    instructions: result.instructions,
  };
}

/**
 * One list to its last page, at most MAX_PAGES (the shared reader of connect/tools.ts). `null`: the server has no
 * `resources/templates/list` (Method not found) although it declares resources; a server with resources and no
 * templates is common, and its templates section is then `null`. Any other list that is missing, malformed or endless
 * fails the snapshot.
 */
async function listAll(session: Session, method: string, key: string): Promise<unknown[] | null> {
  let listing: Awaited<ReturnType<typeof listToEnd>>;
  try {
    listing = await listToEnd(session, method, key);
  } catch (err) {
    if (err instanceof ConnectError) throw err;
    if (
      method === 'resources/templates/list' &&
      (err as { code?: unknown }).code === METHOD_NOT_FOUND
    )
      return null;
    throw new ConnectError(
      'protocol',
      `The server declares ${method.split('/')[0]}, but ${method} failed: ${(err as Error).message}. No snapshot written.`,
      [],
    );
  }
  if (listing.malformed)
    throw new ConnectError(
      'protocol',
      `${method} answered without a ${key} list. No snapshot written.`,
      [],
    );
  if (!listing.complete) {
    throw new ConnectError(
      'protocol',
      `${method} did not end within ${MAX_PAGES} pages, so the list is incomplete. No snapshot written.`,
      [],
    );
  }
  return listing.items;
}

/**
 * The whole text or nothing: written to a temporary file beside the target, then renamed over it. A failure removes
 * the temporary file and leaves the target as it was.
 */
export function writeAtomically(path: string, text: string, shown: string, flag = '--out'): void {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,
  );
  try {
    writeFileSync(temporary, text, { flag: 'wx' });
    renameSync(temporary, path);
  } catch (err) {
    rmSync(temporary, { force: true });
    const code = (err as NodeJS.ErrnoException).code ?? 'an error';
    throw new UsageError(`${flag}: could not write ${shown} (${code}).`);
  }
}
