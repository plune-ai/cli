import { closeSync, fchmodSync, openSync, writeSync } from 'node:fs';
import { UsageError } from '../../connect/options.js';
import { MASK, isSecretHeader, type Redactor } from '../../connect/redact.js';

/**
 * `--journal`: one JSON line for every frame a probe sends, every answer and every frame the wrapper refuses, written
 * as it happens (one `write` call each, so the file is there after a crash or a budget stop).
 *
 * A line is made of fixed fields: the direction, a number, the method, the tool and the id of the probe, which kind of
 * credential was sent (never its value), the headers with every secret one as a mark, and for an answer the status, the
 * JSON-RPC id, whether it held a result, an error or `isError`, and a size. A response body is never written: it may
 * echo a token or hold somebody's data. The whole line then goes through the redactor of the run (the tokens, in plain,
 * URL-encoded, base64 and base64url form) before it is written.
 *
 * It is opened like `--debug-out`: created 0600 (and made 0600 on a system that has modes), an older file with the
 * same name is replaced.
 */

/** What the wrapper writes to. `record` throws when the line could not be written: the wrapper then stops. */
export interface ProbeJournal {
  record(line: Record<string, unknown>): void;
  close?(): void;
  /** Hands over the redactor of the run, before the first line. */
  bind?(redact: Redactor): void;
}

/** The headers of a frame as the journal shows them: a secret one, or the session id, is a mark. */
export function journalHeaders(headers: [string, string][]): Record<string, string> {
  return Object.fromEntries(
    headers.map(([name, value]) => [
      name,
      isSecretHeader(name) || name.toLowerCase() === 'mcp-session-id' ? MASK : value,
    ]),
  );
}

export function openProbeJournal(path: string): ProbeJournal {
  let fd: number;
  try {
    fd = openSync(path, 'w', 0o600);
    if (process.platform !== 'win32') fchmodSync(fd, 0o600);
  } catch {
    // A fixed message: the text of the OS error holds the full path.
    throw new UsageError('--journal: the file cannot be opened for writing.');
  }
  let redact: Redactor | undefined;
  let closed = false;
  return {
    bind(r) {
      redact = r;
    },
    record(line) {
      if (closed) throw new Error('journal closed');
      // Without the redactor of the run nothing is written: a line is never written unmasked.
      if (redact === undefined) throw new Error('journal not bound');
      const masked = redact.value({ ts: new Date().toISOString(), ...line });
      writeSync(fd, JSON.stringify(masked) + '\n');
    },
    close() {
      if (closed) return;
      closed = true;
      closeSync(fd);
    },
  };
}
