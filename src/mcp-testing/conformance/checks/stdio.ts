/**
 * stdio: what the server wrote on stdout over the whole run, and whether it exits once its stdin is closed. The
 * catalog keeps both last, so the first has seen every answer and the second, which ends the server, runs at the end.
 */

import type { ConformanceCheck } from './index.js';
import { failed, passed } from './wire.js';

/** How long the server is given to exit after stdin closes: the SDK's own wait before it sends SIGTERM is 2 s. */
export const EXIT_WAIT_MS = 3000;

const stdoutClean: ConformanceCheck = async (ctx) => {
  const noise = ctx.session.stdoutNoise();
  if (noise.count === 0) return passed('Every line on stdout was a JSON-RPC message.');
  return failed(
    `${noise.count} line${noise.count === 1 ? '' : 's'} on stdout ${noise.count === 1 ? 'was' : 'were'} not a JSON-RPC message, the first: ${noise.first.map((l) => JSON.stringify(l)).join(', ')}.`,
    'Write only MCP messages to stdout, one per line; logs go to stderr.',
  );
};

const exitOnEof: ConformanceCheck = async (ctx) => {
  if (await ctx.session.endInput(EXIT_WAIT_MS)) return passed(`The server exited within ${EXIT_WAIT_MS / 1000} s of its stdin closing.`);
  return failed(
    `The server was still running ${EXIT_WAIT_MS / 1000} s after its stdin closed.`,
    'Exit when stdin is closed or reads return end-of-file.',
  );
};

export const STDIO: Record<string, ConformanceCheck> = {
  'stdio-stdout-clean': stdoutClean,
  'stdio-exit-on-eof': exitOnEof,
};
