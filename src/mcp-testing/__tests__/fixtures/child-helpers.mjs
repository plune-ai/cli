// Shared by the stdio fixture servers: a grandchild that holds a port and outlives its parent unless somebody kills
// the whole tree, and a file that tells the test which processes to look for afterwards.

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

/**
 * Starts the grandchild when FIXTURE_GRANDCHILD=1; its pid, or undefined. Detached, because on Windows Node puts the
 * children it starts in a job that dies with it: a server written in Node would take an attached grandchild along,
 * one behind `cmd /c` or another runtime would not, and that is the case to test.
 */
export function startGrandchild() {
  if (process.env.FIXTURE_GRANDCHILD !== '1') return undefined;
  const child = spawn(
    process.execPath,
    [
      '-e',
      "require('node:net').createServer().listen(0, '127.0.0.1'); setInterval(() => {}, 1000)",
    ],
    { stdio: 'ignore', windowsHide: true, detached: true },
  );
  return child.pid;
}

/** Writes `{ pid, grandchild }` to FIXTURE_PID_FILE when it is set. */
export function writePids(grandchild) {
  const file = process.env.FIXTURE_PID_FILE;
  if (file) writeFileSync(file, JSON.stringify({ pid: process.pid, grandchild }));
}
