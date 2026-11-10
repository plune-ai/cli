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
import { MCP_EXIT } from '../../mcp-testing/exit-codes.js';
import { noCommands } from '../../mcp-testing/render.js';
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
}

export interface SnapshotIo {
  out(text: string): void;
  err(text: string): void;
  /** Where --env KEY and --header-env read from. */
  env: NodeJS.ProcessEnv;
  /** Where a relative --out is written. */
  cwd: string;
  clientVersion?: string;
}

/** Pages of one list read at most: a server that always answers with a cursor would otherwise be read forever. */
const MAX_PAGES = 100;

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
    out: (text) => raw.out(noCommands(text)),
    err: (text) => raw.err(noCommands(text)),
  };
  try {
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
    if (flags.out === undefined) io.out(text);
    else {
      writeAtomically(resolve(io.cwd, flags.out), text, flags.out);
      io.err(`Wrote ${flags.out}: ${counts(snapshot)}.\n`);
    }
    return MCP_EXIT.ok;
  } catch (err) {
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
    const { serverInfo, capabilities, instructions } = session.handshake;
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
 * One list to its last page, at most MAX_PAGES. `null`: the server has no `resources/templates/list` (Method not found
 * on the first page) although it declares resources; a server with resources and no templates is common, and its
 * templates section is then `null`. Any other list that is missing fails.
 */
async function listAll(session: Session, method: string, key: string): Promise<unknown[] | null> {
  const items: unknown[] = [];
  let cursor: string | undefined;
  for (let page = 1; page <= MAX_PAGES; page++) {
    let answer: unknown;
    try {
      answer = await session.request(method, cursor === undefined ? undefined : { cursor });
    } catch (err) {
      if (err instanceof ConnectError) throw err;
      if (
        method === 'resources/templates/list' &&
        page === 1 &&
        (err as { code?: unknown }).code === METHOD_NOT_FOUND
      )
        return null;
      throw new ConnectError(
        'protocol',
        `The server declares ${method.split('/')[0]}, but ${method} failed: ${(err as Error).message}. No snapshot written.`,
        [],
      );
    }
    if (!isRecord(answer) || !Array.isArray(answer[key]))
      throw new ConnectError(
        'protocol',
        `${method} answered without a ${key} list. No snapshot written.`,
        [],
      );
    items.push(...(answer[key] as unknown[]));
    cursor =
      typeof answer.nextCursor === 'string' && answer.nextCursor !== ''
        ? answer.nextCursor
        : undefined;
    if (cursor === undefined) return items;
  }
  throw new ConnectError(
    'protocol',
    `${method} did not end within ${MAX_PAGES} pages, so the list is incomplete. No snapshot written.`,
    [],
  );
}

/**
 * The whole text or nothing: written to a temporary file beside the target, then renamed over it. A failure removes
 * the temporary file and leaves the target as it was.
 */
function writeAtomically(path: string, text: string, shown: string): void {
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
    throw new UsageError(`--out: could not write ${shown} (${code}).`);
  }
}
