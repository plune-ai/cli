// The contract snapshot of `plune mcp serve`, taken from what a client really receives: the real server behind its stdio
// entry over an in-memory transport, in the 2025 era, after `plune_discover_tools` switched on every hidden tool, so the
// list holds every tool of the contract. The JSON schemas come from the SDK, so this is the answer a model sees, and a
// change of SDK shows in the diff too. `x-plune` (visibility, write) comes from the contract itself. The server, its
// capabilities and instructions come from the `initialize` answer, as `plune mcp snapshot` takes them from any server.

import { InMemoryTransport } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { PLUNE_TOOLS } from '../mcp-tools/index.js';
import { createPluneMcpServer } from '../mcp/server.js';
import { buildSnapshot, diffSnapshots, parseSnapshot, renderDiffMarkdown, SnapshotFormatError, type McpSnapshot } from './snapshot/index.js';

/** Relative to the repository root. */
export const PLUNE_SNAPSHOT_FILE = 'contracts/plune-mcp-tools.snapshot.json';

const TOKEN = 'plt_snapshot';
const API_URL = 'https://api.snapshot.invalid';
const ANSWER_MS = 5_000;

type Msg = { id?: number; method?: string; result?: Record<string, unknown>; error?: { code: number; message: string } };

export type ProtocolEra = 'legacy' | 'modern';

/** The `_meta` a 2026-07-28 client sends with every request, in place of a handshake. */
const MODERN_META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
};

export interface PluneConnectionOptions {
  era?: ProtocolEra;
  scope?: 'read' | 'write';
  /** The platform behind the tools; by default any request to it fails, since listing tools never makes one. */
  fetchImpl?: typeof fetch;
}

export interface PluneConnection {
  /** The `initialize` answer (legacy era); undefined in the modern era, which has no handshake. */
  readonly initialized: Record<string, unknown> | undefined;
  request(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Asks `plune_discover_tools` for every hidden tool. */
  revealHidden(): Promise<void>;
  listTools(): Promise<unknown[]>;
  close(): Promise<void>;
}

/** A client of the real server behind its stdio entry, over an in-memory transport, opened in the given era. */
export async function connectPluneServer(opts: PluneConnectionOptions = {}): Promise<PluneConnection> {
  const era = opts.era ?? 'legacy';
  const [client, serverSide] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(
    (ctx) =>
      createPluneMcpServer(
        {
          token: TOKEN,
          apiUrl: API_URL,
          fetchImpl:
            opts.fetchImpl ??
            ((async () => {
              throw new Error('the tool list must not call the platform');
            }) as typeof fetch),
          version: '0.0.0-snapshot',
          scope: opts.scope ?? 'write',
        },
        ctx.era,
      ),
    { transport: serverSide },
  );
  const pending = new Map<number, (m: Msg) => void>();
  client.onmessage = (m) => {
    const msg = m as Msg;
    if (msg.id !== undefined && msg.method === undefined) pending.get(msg.id)?.(msg);
  };
  await client.start();
  let next = 0;
  const request = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => reject(new Error(`${method}: no answer`)), ANSWER_MS);
      pending.set(id, (m) => {
        clearTimeout(timer);
        if (m.error) reject(new Error(`${method}: ${m.error.code} ${m.error.message}`));
        else resolve(m.result ?? {});
      });
      client.send({ jsonrpc: '2.0', id, method, params: era === 'modern' ? { ...params, _meta: MODERN_META } : params }).catch(reject);
    });

  let initialized: Record<string, unknown> | undefined;
  try {
    if (era === 'legacy') {
      initialized = await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'snapshot', version: '1' } });
      await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    }
  } catch (err) {
    await handle.close();
    throw err;
  }
  return {
    initialized,
    request,
    async revealHidden() {
      const names = PLUNE_TOOLS.filter((t) => t.visibility === 'discoverable').map((t) => t.name);
      const discovered = await request('tools/call', { name: 'plune_discover_tools', arguments: { names } });
      if (discovered['isError'] === true) throw new Error(`plune_discover_tools failed: ${JSON.stringify(discovered['content'])}`);
    },
    async listTools() {
      const tools = (await request('tools/list'))['tools'];
      if (!Array.isArray(tools)) throw new Error('tools/list answered without a tools array');
      return tools;
    },
    close: () => handle.close(),
  };
}

/** The `tools/list` answer of the server with a write token, after every discoverable tool was switched on. */
export async function listAllPluneTools(): Promise<{ tools: unknown[]; initialized: Record<string, unknown> | undefined }> {
  const c = await connectPluneServer();
  try {
    await c.revealHidden();
    return { tools: await c.listTools(), initialized: c.initialized };
  } finally {
    await c.close();
  }
}

/**
 * A snapshot of our server's answers, with `x-plune` from the contract. Its only capability is tools: a resource or a
 * prompt list it declared would have to be listed here as well, and `buildSnapshot` refuses a declared list not given.
 */
export function snapshotPluneTools(listed: readonly unknown[], initialized: Record<string, unknown> | undefined, secrets: readonly string[] = []): McpSnapshot {
  const input = {
    transport: 'stdio' as const,
    serverInfo: initialized?.['serverInfo'],
    instructions: initialized?.['instructions'],
    capabilities: initialized?.['capabilities'],
    tools: listed,
  };
  return buildSnapshot(input, {
    pluneFields: (name) => {
      const t = PLUNE_TOOLS.find((d) => d.name === name);
      return t === undefined ? undefined : { visibility: t.visibility, write: t.write };
    },
    secrets,
  });
}

export async function pluneToolsSnapshot(): Promise<McpSnapshot> {
  const { tools, initialized } = await listAllPluneTools();
  return snapshotPluneTools(tools, initialized, [TOKEN, API_URL]);
}

/** The run summary of a pull request: this branch's contract against the base branch's file (`null`: there is none). */
export function pluneContractSummary(baseFile: string | null, current: McpSnapshot): string {
  const head = '### Tool contract\n\n';
  if (baseFile === null) return `${head}No snapshot of the tool contract on the base branch yet, so nothing to compare.\n`;
  let base: McpSnapshot;
  try {
    base = parseSnapshot(baseFile);
  } catch (err) {
    // The base branch holds a file of another format version: the branch that changes the format compares nothing.
    if (err instanceof SnapshotFormatError) return `${head}The snapshot on the base branch cannot be read (${err.message}), so nothing to compare.\n`;
    throw err;
  }
  const diff = diffSnapshots(base, current);
  if (diff.changes.length === 0) return `${head}${renderDiffMarkdown(diff)}`;
  return `${head}This contract is shared by \`plune mcp serve\` and the platform's built-in agent: a change reaches both.\n\n${renderDiffMarkdown(diff)}`;
}
