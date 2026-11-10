import { resolve } from 'node:path';
import type { Command } from 'commander';
import { parseTimerDuration } from '../../util/duration.js';
import { MCP_EXIT } from '../exit-codes.js';

// The connection flags every `plune mcp` command shares. This module stays light (no MCP client): src/cli.ts may
// import it at the top, the session that does the connecting is loaded inside the action.

/** What commander hands the action for the options `addConnectionOptions` adds. */
export interface ConnectionFlags {
  url?: string;
  sse?: boolean;
  header?: string[];
  headerEnv?: string[];
  env?: string[];
  cwd?: string;
  timeout?: string;
  debugOut?: string;
}

export type ConnectTarget =
  | { kind: 'stdio'; command: string; args: string[]; env: Record<string, string>; cwd?: string }
  | { kind: 'http' | 'sse'; url: string; headers: Record<string, string> };

export interface ConnectConfig {
  target: ConnectTarget;
  /** How long to wait for the server: the connection, and each request. */
  timeoutMs: number;
  /** Where the frame journal goes (`--debug-out`). */
  debugOut?: string;
  /** The version `plune` gives the server in `clientInfo`. */
  clientVersion?: string;
}

/** A wrong combination of flags: exit 2, one sentence, no stack, no secret value. */
export class UsageError extends Error {
  readonly exitCode = MCP_EXIT.usage;
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

const collect = (value: string, previous: string[] = []): string[] => [...previous, value];

export function addConnectionOptions(cmd: Command): Command {
  return cmd
    .argument(
      '[server...]',
      'The command that starts a stdio server, after -- (plune mcp <command> -- node server.js)',
    )
    .option('--url <url>', 'The server is at this Streamable HTTP endpoint')
    .option('--sse', 'The server at --url speaks the older HTTP+SSE transport')
    .option(
      '--header <header>',
      '"Name: value" sent with every request to --url (repeatable)',
      collect,
    )
    .option(
      '--header-env <header>',
      '"Name=ENV_VAR": a header whose value is read from that variable, so it is not on the command line (repeatable)',
      collect,
    )
    .option(
      '--env <entry>',
      'KEY=VALUE for the server process, or KEY to pass that variable on from this environment (repeatable)',
      collect,
    )
    .option('--cwd <dir>', 'Working directory of the server process')
    .option('--timeout <duration>', 'How long to wait for the server (e.g. 30s, 2m)', '30s')
    .option(
      '--debug-out <path>',
      'Write every JSON-RPC frame and stderr line of the server to this file as JSON Lines, secrets masked',
    );
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** A variable's value; unset and empty are both refused, so an empty credential never goes out (a fork's PR has none). */
function fromEnv(flag: string, name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name];
  if (value === undefined || value === '')
    throw new UsageError(`${flag}: the variable ${name} is not set or is empty.`);
  return value;
}

function parseHeaders(flags: ConnectionFlags, env: NodeJS.ProcessEnv): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const entry of flags.header ?? []) {
    const colon = entry.indexOf(':');
    const name = entry.slice(0, colon).trim();
    const value = entry.slice(colon + 1).trim();
    if (colon < 0 || !HEADER_NAME.test(name) || value === '') {
      throw new UsageError(
        `--header needs the form "Name: value" (got a header named "${colon < 0 ? '' : name}").`,
      );
    }
    headers[name] = value;
  }
  for (const entry of flags.headerEnv ?? []) {
    const eq = entry.indexOf('=');
    const name = entry.slice(0, eq).trim();
    const variable = entry.slice(eq + 1).trim();
    if (eq < 0 || !HEADER_NAME.test(name) || variable === '')
      throw new UsageError(`--header-env needs the form "Name=ENV_VAR" (got "${entry}").`);
    headers[name] = fromEnv('--header-env', variable, env);
  }
  return headers;
}

function parseEnv(flags: ConnectionFlags, env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of flags.env ?? []) {
    const eq = entry.indexOf('=');
    const key = eq < 0 ? entry : entry.slice(0, eq);
    if (key === '') throw new UsageError('--env needs KEY=VALUE or KEY (got an empty name).');
    out[key] = eq < 0 ? fromEnv('--env', key, env) : entry.slice(eq + 1);
  }
  return out;
}

/**
 * The flags and the command after `--` as one connection, or a `UsageError`. `env` is where `--header-env` and
 * `--env KEY` read from (process.env in a command).
 */
export function connectionConfig(
  flags: ConnectionFlags,
  server: string[],
  env: NodeJS.ProcessEnv = process.env,
): ConnectConfig {
  const [command, ...args] = server;
  if (flags.url !== undefined && command !== undefined)
    throw new UsageError('Give either --url or a server command after --, not both.');
  if (flags.sse === true && flags.url === undefined)
    throw new UsageError('--sse is for a server at --url.');
  if (flags.url === undefined && command === undefined) {
    throw new UsageError(
      'Name a server: --url <url>, or the command that starts it after -- (plune mcp <command> -- node server.js).',
    );
  }

  let timeoutMs: number;
  try {
    timeoutMs = parseTimerDuration(flags.timeout ?? '30s');
  } catch (err) {
    throw new UsageError(`--timeout: ${(err as Error).message}.`);
  }
  const common = {
    timeoutMs,
    ...(flags.debugOut !== undefined ? { debugOut: flags.debugOut } : {}),
  };

  if (flags.url !== undefined) {
    if ((flags.env ?? []).length > 0 || flags.cwd !== undefined)
      throw new UsageError('--env and --cwd are for a server started after --, not one at --url.');
    let url: URL;
    try {
      url = new URL(flags.url);
    } catch {
      throw new UsageError('--url is not a URL (use e.g. http://127.0.0.1:3000/mcp).');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      throw new UsageError('--url must start with http:// or https://.');
    // A password in the URL sits on the command line, in shell history and in every echo of the URL; Node's fetch
    // refuses such a URL anyway. The header route keeps it out of all three.
    if (url.username !== '' || url.password !== '') {
      throw new UsageError(
        '--url must not carry user:password@; put the credentials in a variable and pass --header-env Authorization=VAR.',
      );
    }
    return {
      target: {
        kind: flags.sse === true ? 'sse' : 'http',
        url: flags.url,
        headers: parseHeaders(flags, env),
      },
      ...common,
    };
  }

  if ((flags.header ?? []).length + (flags.headerEnv ?? []).length > 0)
    throw new UsageError('--header and --header-env are for a server at --url.');
  return {
    target: {
      kind: 'stdio',
      command: command!,
      args,
      env: parseEnv(flags, env),
      ...(flags.cwd !== undefined ? { cwd: resolve(flags.cwd) } : {}),
    },
    ...common,
  };
}
