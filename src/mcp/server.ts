import { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { McpServer, PROTOCOL_VERSION_META_KEY, UnsupportedProtocolVersionError, type CallToolResult, type JSONRPCMessage, type ProtocolEra, type RegisteredTool, type Tool } from '@modelcontextprotocol/server';
import { z } from 'zod';
// A static import on purpose: the CLI bundle is CommonJS, where a dynamic import() of the package loads its ESM build, and
// an McpServer from one build cannot be served by serveStdio from the other (the discover handler fails with -32603).
// This module is itself loaded lazily, only by `plune mcp serve`.
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import {
  PLUNE_TOOLS,
  createPluneToolExecutor,
  defaultVisibleTools,
  type PluneToolDefinition,
  type PluneToolExecutorOptions,
  type ToolOutcome,
} from '../mcp-tools/index.js';

/**
 * `plune mcp serve`: the tool contract of `src/mcp-tools` as an MCP server. The tools, their
 * schemas and their behaviour live there; this file only maps an executor outcome onto MCP results and decides what
 * the client's tool list holds.
 *
 * Both protocol eras are served: a client that opens with `initialize` gets the 2025 revisions, one that sends
 * per-request `_meta` gets 2026-07-28. The transport picks the era from the first message and hands it to the factory;
 * `createPluneMcpServer` is the one place that branches on it:
 * - 2025 era: the list follows what the executor says is visible (discover_tools, a token learned to be `read`), and
 *   each change is announced with `notifications/tools/list_changed`.
 * - 2026-07-28: the set in `tools/list` «MUST NOT vary per-connection or as a side effect of other requests on the
 *   connection» (https://modelcontextprotocol.io/specification/2026-07-28/server/tools). The core tools are listed for
 *   the whole connection, every tool the token may use is callable by its name, and discover_tools only describes the
 *   hidden ones.
 */

export interface PluneMcpServerOptions extends PluneToolExecutorOptions {
  version: string;
}

const annotationsOf = (tool: PluneToolDefinition) => ({
  title: tool.title,
  readOnlyHint: !tool.write,
  destructiveHint: tool.name === 'plune_api_request',
  openWorldHint: false,
});

/**
 * A `tools/list` entry as McpServer builds it from the same registration. McpServer lists every enabled tool, and a
 * disabled one cannot be called, so the fixed list of the 2026-07-28 era is answered here instead.
 */
const listed = (tool: PluneToolDefinition): Tool => ({
  name: tool.name,
  title: tool.title,
  description: tool.description,
  inputSchema: z.toJSONSchema(tool.input, { target: 'draft-2020-12', io: 'input' }) as Tool['inputSchema'],
  outputSchema: z.toJSONSchema(tool.output, { target: 'draft-2020-12', io: 'output' }) as Tool['outputSchema'],
  annotations: annotationsOf(tool),
});

function toResult(outcome: ToolOutcome): CallToolResult {
  if (outcome.ok) {
    return { content: [{ type: 'text', text: JSON.stringify(outcome.data, null, 2) }], structuredContent: outcome.data };
  }
  return {
    isError: true,
    content: [{ type: 'text', text: outcome.error.message }],
    structuredContent: { error: outcome.error },
  };
}

export function createPluneMcpServer(opts: PluneMcpServerOptions, era: ProtocolEra): McpServer {
  const { version, ...executorOptions } = opts;
  const fixed = era === 'modern';
  const executor = createPluneToolExecutor({
    ...executorOptions,
    userAgent: executorOptions.userAgent ?? `plune-cli/${version} mcp`,
    fixedToolList: fixed,
  });
  const server = new McpServer({ name: 'plune', version }, { capabilities: { tools: { listChanged: true } } });
  const registered = new Map<string, RegisteredTool>();

  const sync = () => {
    const visible = new Set<string>(executor.visibleTools());
    for (const [name, tool] of registered) {
      if (visible.has(name) && !tool.enabled) tool.enable();
      else if (!visible.has(name) && tool.enabled) tool.disable();
    }
  };

  for (const tool of PLUNE_TOOLS) {
    // A known `read` token never sees a writer (#1283 AC-03: a forbidden tool is not listed rather than failing).
    if (opts.scope === 'read' && tool.write) continue;
    const handle = server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        outputSchema: tool.output,
        annotations: annotationsOf(tool),
      },
      async (args: unknown) => {
        const outcome = await executor.execute(tool.name, args);
        if (!fixed) sync();
        return toResult(outcome);
      },
    );
    registered.set(tool.name, handle);
  }
  if (fixed) {
    // Every registered tool stays enabled, so tools/call reaches it with the SDK's own checks; only the list is ours.
    const tools = PLUNE_TOOLS.filter((t) => defaultVisibleTools(opts.scope).includes(t.name)).map(listed);
    server.server.setRequestHandler('tools/list', () => ({ tools }));
  } else sync();
  return server;
}

/** The answer to a line that is not JSON: its id cannot be read, so it is null (JSON-RPC 2.0, section 5). */
export const PARSE_ERROR_LINE = '{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}\n';

/**
 * stdin as the transport reads it, less the lines that are not JSON: each of those is answered with PARSE_ERROR_LINE
 * through `answer`. The SDK's reader drops such a line without a word, and every MCP message "MUST follow the JSON-RPC
 * 2.0 specification" (https://modelcontextprotocol.io/specification/2025-11-25/basic/index), which answers invalid JSON
 * with -32700. Blank lines pass as they are.
 */
export function answeringParseErrors(answer: (line: string) => void): Transform {
  const decoder = new StringDecoder('utf8');
  let rest = '';
  const pass = (stream: Transform, line: string) => {
    const text = line.replace(/\r$/, '');
    if (text.trim() === '') return void stream.push(`${line}\n`);
    try {
      JSON.parse(text);
    } catch {
      return answer(PARSE_ERROR_LINE);
    }
    stream.push(`${line}\n`);
  };
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      // A line is held whole until its newline, as the SDK's reader holds it; that reader's size cap applies after this.
      const lines = (rest + decoder.write(chunk)).split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) pass(this, line);
      done();
    },
    flush(done) {
      rest += decoder.end();
      if (rest !== '') this.push(rest);
      done();
    },
  });
}

/**
 * Serve over stdio, both eras, until the client closes stdin. Nothing but protocol goes to stdout. The transport calls the
 * factory once per connection, and once more for a `server/discover` probe it drops if the client then sends `initialize`.
 */
export async function serveMcpStdio(opts: PluneMcpServerOptions): Promise<void> {
  const input = process.stdin.pipe(answeringParseErrors((line) => process.stdout.write(line)));
  const transport = new StdioServerTransport(input, process.stdout);
  await new Promise<void>((resolve) => {
    // Out-of-band errors (a line that is not JSON-RPC, a failed write) have no request to answer, so stderr is the only
    // place to say so. One short line from the message only, never the payload: it may carry tool arguments. A schema
    // failure's message is a long dump of the offending message's shape, so it gets a fixed sentence instead.
    serveStdio((ctx) => createPluneMcpServer(opts, ctx.era), {
      transport,
      onerror: (error) => {
        const said = error.name === 'ZodError' ? 'ignored a line that is not a JSON-RPC message' : error.message.replace(/\s+/g, ' ').slice(0, 200);
        process.stderr.write(`plune mcp: ${said}\n`);
      },
    });
    // 2026-07-28: «the server accepts or rejects each request independently»
    // (https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning). serveStdio checks the version the opening
    // message claims and then pins the connection, so a later claim of another version reached the instance unchecked.
    const served = transport.onmessage;
    transport.onmessage = (message: JSONRPCMessage) => {
      const refused = unsupportedClaim(message);
      if (refused === undefined) served?.(message);
      else void transport.send(refused).catch(() => undefined);
    };
    // serveStdio owns the transport and sets its onclose; chain onto it to learn when stdin is closed.
    const owned = transport.onclose;
    transport.onclose = () => {
      owned?.();
      resolve();
    };
  });
}

/**
 * The revisions of the 2026-07-28 era this server speaks: what its `server/discover` answers in `supportedVersions`.
 * ponytail: written out because SDK 2.4.0 does not export its modern list; serve-stdio.e2e compares the two.
 */
const MODERN_REVISIONS = ['2026-07-28'];

/** The -32022 answer to a request whose envelope claims a revision this server does not speak; undefined for any other message. */
export function unsupportedClaim(message: JSONRPCMessage): JSONRPCMessage | undefined {
  if (!('method' in message) || !('id' in message)) return undefined;
  const meta = (message.params as { _meta?: Record<string, unknown> } | undefined)?._meta;
  const requested = meta?.[PROTOCOL_VERSION_META_KEY];
  if (typeof requested !== 'string' || MODERN_REVISIONS.includes(requested)) return undefined;
  const error = new UnsupportedProtocolVersionError({ supported: [...MODERN_REVISIONS], requested });
  return { jsonrpc: '2.0', id: message.id, error: { code: error.code, message: error.message, data: error.data } };
}
