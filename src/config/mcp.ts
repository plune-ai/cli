import * as path from 'node:path';
import type { ConnectTarget } from '../mcp-testing/connect/options.js';
import type { Config, EvalConfig, McpLimits, McpServerConfig } from '../types/config.js';

// The `mcp` block of plune.yaml after the schema: limits with their defaults, `${VAR}` in a server's values, and
// the checks `plune run` makes before anything connects. The config itself keeps `${VAR}` as written, so
// `config_hash` holds no value of the environment; the values are filled only when a server is reached.

/** Every limit has one: an agentic eval always ends. */
export const MCP_LIMIT_DEFAULTS: Required<McpLimits> = {
  max_steps: 10,
  max_tool_calls: 20,
  max_total_tokens: 100_000,
  timeout_ms: 120_000,
  tool_timeout_ms: 30_000,
};

/** The limits of one eval: its own over the root ones over the defaults. */
export function mcpLimits(config: Config, evalConfig: EvalConfig): Required<McpLimits> {
  return { ...MCP_LIMIT_DEFAULTS, ...config.mcp?.limits, ...evalConfig.mcp?.limits };
}

const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * `${VAR}` and `${VAR:-default}` filled from `env`; nothing else is read and no shell runs. An unset or empty `VAR`
 * without a default, or a `${` that is neither form, throws. The message names the variable, never a value.
 */
export function expandVars(value: string, env: NodeJS.ProcessEnv): string {
  const literal = (text: string): string => {
    if (text.includes('${')) throw new Error('has a "${" that is not ${NAME} or ${NAME:-default}');
    return text;
  };
  let out = '';
  let last = 0;
  for (const match of value.matchAll(REFERENCE)) {
    const [whole, name, fallback] = match as unknown as [string, string, string | undefined];
    out += literal(value.slice(last, match.index));
    const set = env[name];
    if (set !== undefined && set !== '') out += set;
    else if (fallback !== undefined) out += fallback;
    else
      throw new Error(
        `\${${name}} is not set or is empty, and has no default (\${${name}:-default})`,
      );
    last = match.index + whole.length;
  }
  return out + literal(value.slice(last));
}

/** Every value of a server that `${VAR}` may sit in, with the path a config error names. */
function serverValues(server: McpServerConfig): [string, string][] {
  const out: [string, string][] = [];
  if (server.command !== undefined) out.push(['command', server.command]);
  (server.args ?? []).forEach((arg, i) => out.push([`args.${i}`, arg]));
  for (const [key, value] of Object.entries(server.env ?? {})) out.push([`env.${key}`, value]);
  if (server.cwd !== undefined) out.push(['cwd', server.cwd]);
  if (server.url !== undefined) out.push(['url', server.url]);
  for (const [key, value] of Object.entries(server.headers ?? {}))
    out.push([`headers.${key}`, value]);
  return out;
}

/** One `path: message` per value whose `${VAR}` cannot be filled from `env`, as a config error lists them. */
export function mcpVariableIssues(config: Config, env: NodeJS.ProcessEnv): string[] {
  const issues: string[] = [];
  for (const [name, server] of Object.entries(config.mcp?.servers ?? {})) {
    for (const [field, value] of serverValues(server)) {
      try {
        expandVars(value, env);
      } catch (err) {
        issues.push(`mcp.servers.${name}.${field}: ${(err as Error).message}`);
      }
    }
  }
  return issues;
}

/**
 * The server as the connection core takes it, every `${VAR}` filled. `cwd` is resolved against `baseDir` (the folder
 * of plune.yaml). Throws like `expandVars`; `plune run` has already refused a config where that would happen.
 */
export function resolveMcpServer(
  server: McpServerConfig,
  env: NodeJS.ProcessEnv = process.env,
  baseDir: string = process.cwd(),
): ConnectTarget {
  const fill = (value: string) => expandVars(value, env);
  const fillAll = (entries: Record<string, string> = {}) =>
    Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, fill(value)]));
  if (server.url !== undefined)
    return { kind: 'http', url: fill(server.url), headers: fillAll(server.headers) };
  return {
    kind: 'stdio',
    command: fill(server.command!),
    args: (server.args ?? []).map(fill),
    env: fillAll(server.env),
    ...(server.cwd !== undefined ? { cwd: path.resolve(baseDir, fill(server.cwd)) } : {}),
  };
}

const SECRET_KEY = /authorization|token|key|secret|password/i;

/**
 * A heuristic, never a gate: a value under a key that looks like a credential, written into the file instead of
 * `${VAR}`. Each warning names the key, never the value.
 */
export function mcpSecretWarnings(config: Config): string[] {
  const warnings: string[] = [];
  for (const [name, server] of Object.entries(config.mcp?.servers ?? {})) {
    for (const [field, entries] of [
      ['env', server.env],
      ['headers', server.headers],
    ] as const) {
      for (const [key, value] of Object.entries(entries ?? {})) {
        if (SECRET_KEY.test(key) && !value.includes('${')) {
          warnings.push(
            `mcp.servers.${name}.${field}.${key} looks like a secret written into plune.yaml; use \${VAR} so it comes from the environment.`,
          );
        }
      }
    }
  }
  return warnings;
}
