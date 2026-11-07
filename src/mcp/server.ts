import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
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

/** Serve over stdio until the client closes stdin. Nothing but protocol goes to stdout. */
export async function serveStdio(opts: PluneMcpServerOptions): Promise<void> {
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const server = createPluneMcpServer(opts);
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
  });
  await server.connect(transport);
  await closed;
}
