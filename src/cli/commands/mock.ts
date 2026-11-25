// `plune mock <file>`: serves a stub file from a local stub server, for a replay by hand.
// `plune mock <file> --record --target <origin>`: a recording proxy that writes the stub file.
//
// Serving makes no outbound request at all: the outbound function is handed to the recorder only.
// Everything the command prints goes through `io`, so a test can read every byte of it.

import { loadStubFile, StubFileError } from '../../mock/schema.js';
import { RECORDING_NOTES, RecordError, startRecorder, type Outbound } from '../../mock/record.js';
import { start } from '../../mock/server.js';
import * as path from 'node:path';

export interface MockFlags {
  file: string;
  record: boolean;
  target?: string;
  force: boolean;
  scope: string;
  port: number;
}

export interface MockIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Aborted to stop the server: Ctrl+C in the CLI. */
  signal: AbortSignal;
  cwd?: string;
  /** Called once the server listens, with the base URL a client is pointed at. */
  onReady?: (url: string) => void;
  outbound?: Outbound;
  today?: () => string;
  maxBodyBytes?: number;
  upstreamTimeoutMs?: number;
}

/** A wrong flag, target, path or stub file: the message is the user's to act on, exit 2. */
export class MockUsageError extends Error {
  readonly code = 'MOCK_USAGE_ERROR' as const;
  constructor(message: string) {
    super(message);
    this.name = 'MockUsageError';
  }
}

const stopped = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });

/**
 * Runs until `io.signal` aborts, then closes the server and resolves with the exit code: 0, or 1 when a
 * recording ends with exchanges that could not be written to the file.
 */
export async function handleMock(flags: MockFlags, io: MockIo): Promise<number> {
  const cwd = io.cwd ?? process.cwd();
  if (flags.record !== (flags.target !== undefined))
    throw new MockUsageError(
      '--record and --target go together: `plune mock <file> --record --target <origin>`',
    );

  if (flags.record) {
    let recorder;
    try {
      recorder = await startRecorder({
        target: flags.target!,
        file: flags.file,
        cwd,
        force: flags.force,
        scope: flags.scope,
        port: flags.port,
        warn: (line) => io.stderr(`${line}\n`),
        onRecorded: (method, status) => io.stdout(`recorded: ${method} ${status}\n`),
        ...(io.outbound === undefined ? {} : { outbound: io.outbound }),
        ...(io.today === undefined ? {} : { today: io.today }),
        ...(io.maxBodyBytes === undefined ? {} : { maxBodyBytes: io.maxBodyBytes }),
        ...(io.upstreamTimeoutMs === undefined ? {} : { upstreamTimeoutMs: io.upstreamTimeoutMs }),
      });
    } catch (err) {
      if (err instanceof RecordError) throw new MockUsageError(err.message);
      throw err;
    }
    io.stdout(
      `Recording at ${recorder.url}: point the base URL of the client there.\n` +
        'Prompts and answers are stored as they are and may hold personal or confidential text. The file stays on this machine.\n' +
        // What the masking does and where it stops, in the words the file starts with.
        RECORDING_NOTES.slice(1, 5)
          .map((line) => `${line.slice(2)}\n`)
          .join('') +
        'Ctrl+C stops.\n',
    );
    io.onReady?.(recorder.url);
    await stopped(io.signal);
    await recorder.close();
    io.stdout(`Stopped. Exchanges recorded: ${recorder.recorded}.\n`);
    if (recorder.unwritten === 0) return 0;
    io.stderr(
      `Exchanges that could not be written to the file and are lost: ${recorder.unwritten}. The file holds the ${recorder.recorded} before them.\n`,
    );
    return 1;
  }

  if (flags.force) throw new MockUsageError('--force goes with --record');
  // Any path the user names is served: the file is only read. The folder limit is the recorder's, which writes.
  let stubs;
  try {
    stubs = (await loadStubFile(path.resolve(cwd, flags.file))).stubs;
  } catch (err) {
    if (err instanceof StubFileError) throw new MockUsageError(err.message);
    throw err;
  }
  let server;
  try {
    server = await start({ port: flags.port });
  } catch (err) {
    throw new MockUsageError(
      `Cannot listen on 127.0.0.1: ${(err as NodeJS.ErrnoException).code ?? 'error'}`,
    );
  }
  let scope;
  try {
    scope = server.scope(flags.scope, stubs);
  } catch (err) {
    await server.close();
    throw new MockUsageError((err as Error).message);
  }
  const count = `${stubs.length} ${stubs.length === 1 ? 'stub' : 'stubs'}`;
  io.stdout(`Serving ${count} at ${scope.url}, with no network. Ctrl+C stops.\n`);
  io.onReady?.(scope.url);
  await stopped(io.signal);
  const unused = scope.close().length;
  await server.close();
  io.stdout(`Stopped. Stubs never called: ${unused}.\n`);
  return 0;
}
