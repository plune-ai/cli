// A stand-in for `plune` waiting on a server that never answers: it opens a session to the silent fixture (which
// starts a grandchild) and waits. The test interrupts it with a real SIGINT on POSIX. Windows has no way to send one
// process a Ctrl+C, so there the test writes `SIGINT` on stdin and this raises the same event in-process.

//
// With `stuck` as the second argument it also registers a session whose close never ends, as a server that will not
// let go: then only a second Ctrl+C can end plune, and it has to end the real session's processes on its way out.

import { fileURLToPath } from 'node:url';
import { track } from '../../connect/processes.js';
import { openSession } from '../../connect/session.js';

const pidFile = process.argv[2] ?? '';
process.stdin.setEncoding('utf8').on('data', (chunk: string) => {
  for (const _ of chunk.matchAll(/SIGINT/g)) process.emit('SIGINT', 'SIGINT');
});
if (process.argv[3] === 'stuck')
  track({ close: () => new Promise<void>(() => {}), killNow: () => {} });

openSession({
  target: {
    kind: 'stdio',
    command: process.execPath,
    args: [fileURLToPath(new URL('./raw-stdio.mjs', import.meta.url)), 'silent'],
    env: { FIXTURE_GRANDCHILD: '1', FIXTURE_PID_FILE: pidFile },
  },
  timeoutMs: 60_000,
}).catch(() => {});
