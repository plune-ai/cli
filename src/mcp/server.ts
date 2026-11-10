import { McpServer, type CallToolResult, type RegisteredTool } from '@modelcontextprotocol/server';
// A static import on purpose: the CLI bundle is CommonJS, where a dynamic import() of the package loads its ESM build, and
// an McpServer from one build cannot be served by serveStdio from the other (the discover handler fails with -32603).
// This module is itself loaded lazily, only by `plune mcp serve`.
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import {
  PLUNE_TOOLS,
  createPluneToolExecutor,
  type PluneToolExecutorOptions,
  type ToolOutcome,
} from '../mcp-tools/index.js';

/**
 * `plune mcp serve` (plune-ai/plune#1284): the tool contract of `src/mcp-tools` as an MCP server. The tools, their
 * schemas and their behaviour live there; this file only maps an executor outcome onto MCP results and keeps the
 * client's tool list in step with what the executor says is visible (discover_tools, a token learned to be `read`).
 *
 * Both protocol eras are served: a client that opens with `initialize` gets the 2025 revisions, one
 * that sends per-request `_meta` gets 2026-07-28. The transport picks the era from the first message; this file does not
 * branch on it. In the 2026-07-28 era a list change reaches only a client that opened `subscriptions/listen`, and
 * `tools/list` carries `ttlMs: 0`, so a client that does not listen re-reads the list after discover_tools.
 */

export interface PluneMcpServerOptions extends PluneToolExecutorOptions {
  version: string;
}

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

export function createPluneMcpServer(opts: PluneMcpServerOptions): McpServer {
  const { version, ...executorOptions } = opts;
  const executor = createPluneToolExecutor({ ...executorOptions, userAgent: executorOptions.userAgent ?? `plune-cli/${version} mcp` });
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
        annotations: {
          title: tool.title,
          readOnlyHint: !tool.write,
          destructiveHint: tool.name === 'plune_api_request',
          openWorldHint: false,
        },
      },
      async (args: unknown) => {
        const outcome = await executor.execute(tool.name, args);
        sync();
        return toResult(outcome);
      },
    );
    registered.set(tool.name, handle);
  }
  sync();
  return server;
}

/**
 * Serve over stdio, both eras, until the client closes stdin. Nothing but protocol goes to stdout. The transport calls the
 * factory once per connection, and once more for a `server/discover` probe it drops if the client then sends `initialize`.
 */
export async function serveMcpStdio(opts: PluneMcpServerOptions): Promise<void> {
  const transport = new StdioServerTransport();
  await new Promise<void>((resolve) => {
    serveStdio(() => createPluneMcpServer(opts), { transport });
    // serveStdio owns the transport and sets its onclose; chain onto it to learn when stdin is closed.
    const owned = transport.onclose;
    transport.onclose = () => {
      owned?.();
      resolve();
    };
  });
}
