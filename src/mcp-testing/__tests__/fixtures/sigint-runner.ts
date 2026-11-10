// A stand-in for `plune` waiting on a server that never answers: it opens a session to the silent fixture (which
// starts a grandchild) and waits. The test interrupts it with a real SIGINT on POSIX. Windows has no way to send one
// process a Ctrl+C, so there the test writes `SIGINT` on stdin and this raises the same event in-process.

import { fileURLToPath } from 'node:url';
import { openSession } from '../../connect/session.js';

const pidFile = process.argv[2] ?? '';
process.stdin.setEncoding('utf8').on('data', (chunk: string) => {
  if (chunk.includes('SIGINT')) process.emit('SIGINT', 'SIGINT');
});

openSession({
  target: {
    kind: 'stdio',
    command: process.execPath,
    args: [fileURLToPath(new URL('./raw-stdio.mjs', import.meta.url)), 'silent'],
    env: { FIXTURE_GRANDCHILD: '1', FIXTURE_PID_FILE: pidFile },
  },
  timeoutMs: 60_000,
}).catch(() => {});
