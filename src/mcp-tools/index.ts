/**
 * `@plune-ai/cli/mcp-tools` — the tool contract of Plune's agent surface and the executor that runs it over the HTTP API.
 *
 * Transport-free and side-effect-free on import: no MCP SDK, no stdio, no filesystem. `plune mcp serve` wraps it in an
 * MCP server; the platform's built-in agent imports the same definitions, so both paths offer the
 * same tools with the same schemas.
 */
export {
  MAX_VISIBLE_TOOLS,
  PLUNE_TOOLS,
  PLUNE_TOOL_NAMES,
  defaultVisibleTools,
  isPluneToolName,
  pluneTool,
  type PluneToolDefinition,
  type PluneToolName,
  type ToolVisibility,
} from './contract.js';
export {
  CONFIRM_TTL_MS,
  createPluneToolExecutor,
  type PluneToolExecutor,
  type PluneToolExecutorOptions,
  type TokenScope,
  type ToolError,
  type ToolOutcome,
} from './execute.js';
export { PluneApiError, PluneNetworkError } from './client.js';
export { BATCH_MAX } from './schemas.js';
