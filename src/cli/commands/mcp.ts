import { loadToken as loadStoredToken } from '../credentials.js';
import { resolveApiUrl } from '../api-url.js';
import { NotLoggedInError } from './sync.js';
import type { PluneMcpServerOptions } from '../../mcp/server.js';

export interface McpServeFlags {
  project?: string | undefined;
  readOnly?: boolean | undefined;
}

export interface McpServeDeps {
  loadToken?: () => string | null;
  apiUrl?: string;
  serve?: (opts: PluneMcpServerOptions) => Promise<void>;
  version: string;
}

/**
 * `plune mcp serve` (plune-ai/plune#1284): the Plune tools over MCP stdio. stdout carries the protocol, so nothing
 * here may print; the caller reports failures on stderr.
 */
export async function handleMcpServe(flags: McpServeFlags, deps: McpServeDeps): Promise<void> {
  const token = (deps.loadToken ?? loadStoredToken)();
  if (token === null) throw new NotLoggedInError();

  const apiUrl = resolveApiUrl(deps.apiUrl);
  const projectId = flags.project?.trim() || process.env['PLUNE_PROJECT']?.trim() || undefined;
  const serve = deps.serve ?? (await import('../../mcp/server.js')).serveStdio;

  await serve({
    token,
    apiUrl,
    version: deps.version,
    ...(projectId !== undefined ? { projectId } : {}),
    ...(flags.readOnly === true ? { scope: 'read' as const } : {}),
  });
}
