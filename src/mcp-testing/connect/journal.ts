import { closeSync, fchmodSync, openSync, writeSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import type { Redactor } from './redact.js';

// `--debug-out`: one JSON line per event, in the order they happen. Each line has `ts` (ISO), `dtMs` (since the
// session began, from a monotonic clock) and `dir`:
// - `meta`: the connection, credentials masked (first line);
// - `out` / `in`: a JSON-RPC frame to / from the server, as `frame`;
// - `stderr`: a line the server process wrote, as `line`;
// - `noise`: a line a stdio server wrote on stdout that is not a JSON-RPC message (a log line), as `line`;
// - `error`: why the connection failed, as `kind` and `message`.
// Every line goes through the redactor. The file is opened before the connection is tried, so it is there when the
// connection fails, and created 0600: it holds what the server said.

export type JournalDir = 'meta' | 'out' | 'in' | 'stderr' | 'noise' | 'error';

export interface Journal {
  write(dir: JournalDir, fields: Record<string, unknown>): void;
  close(): void;
}

const NONE: Journal = { write: () => {}, close: () => {} };

export function openJournal(path: string | undefined, redact: Redactor): Journal {
  if (path === undefined) return NONE;
  const fd = openSync(path, 'w', 0o600);
  // The mode above applies only to a file this call creates; an older file keeps its own until told.
  if (process.platform !== 'win32') fchmodSync(fd, 0o600);
  const start = performance.now();
  let closed = false;
  return {
    write(dir, fields) {
      if (closed) return;
      const dtMs = Math.round((performance.now() - start) * 1000) / 1000;
      const line = {
        ts: new Date().toISOString(),
        dtMs,
        dir,
        ...(redact.value(fields) as Record<string, unknown>),
      };
      writeSync(fd, JSON.stringify(line) + '\n');
    },
    close() {
      if (closed) return;
      closed = true;
      closeSync(fd);
    },
  };
}
