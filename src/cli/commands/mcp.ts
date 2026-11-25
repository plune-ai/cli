import { loadToken as loadStoredToken } from '../credentials.js';
import { resolveApiUrl, tokenRefusedBy } from '../api-url.js';
import { NotLoggedInError } from './sync.js';
import type { PluneMcpServerOptions } from '../../mcp/server.js';

export interface McpServeFlags {
  project?: string | undefined;
  readOnly?: boolean | undefined;
  /** `--disable-tool`, once per name. */
  disableTool?: string[] | undefined;
}

/** `--disable-tool` named something that is not a Plune tool: a typo would otherwise leave the tool on without a word. */
export class NoSuchToolError extends Error {
  constructor(name: string, tools: readonly string[]) {
    super(`no such tool: ${name}. The tools are: ${tools.join(', ')}`);
    this.name = 'NoSuchToolError';
  }
}

export interface McpServeDeps {
  loadToken?: () => string | null;
  apiUrl?: string;
  serve?: (opts: PluneMcpServerOptions) => Promise<void>;
  version: string;
}

/**
 * `plune mcp serve`: the Plune tools over MCP stdio. stdout carries the protocol, so nothing
 * here may print; the caller reports failures on stderr.
 */
export async function handleMcpServe(flags: McpServeFlags, deps: McpServeDeps): Promise<void> {
  const disabledTools = (flags.disableTool ?? []).map((n) => n.trim());
  if (disabledTools.length > 0) {
    const { PLUNE_TOOL_NAMES, isPluneToolName } = await import('../../mcp-tools/index.js');
    const unknown = disabledTools.find((n) => !isPluneToolName(n));
    if (unknown !== undefined) throw new NoSuchToolError(unknown, PLUNE_TOOL_NAMES);
  }

  const token = (deps.loadToken ?? loadStoredToken)();
  if (token === null) throw new NotLoggedInError();

  const apiUrl = resolveApiUrl(deps.apiUrl);
  const projectId = flags.project?.trim() || process.env['PLUNE_PROJECT']?.trim() || undefined;
  const serve = deps.serve ?? (await import('../../mcp/server.js')).serveMcpStdio;

  await serve({
    token,
    apiUrl,
    version: deps.version,
    tokenRejectedHint: tokenRefusedBy(apiUrl),
    ...(projectId !== undefined ? { projectId } : {}),
    ...(flags.readOnly === true ? { scope: 'read' as const } : {}),
    ...(disabledTools.length > 0 ? { disabledTools } : {}),
  });
}
