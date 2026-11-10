// AC-8: Ctrl+C while plune waits for a server ends the server, its grandchild and plune itself. The runner is a real
// separate process, so the signal handler and process.exit run as they would in `plune`.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const RUNNER = fileURLToPath(new URL('./fixtures/sigint-runner.ts', import.meta.url));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitFor<T>(read: () => T | undefined, ms: number): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Starts the runner and waits until its server and the grandchild are up. */
async function startRunner(mode?: 'stuck') {
  const pidFile = join(mkdtempSync(join(tmpdir(), 'plune-sigint-')), 'pids.json');
  const runner = spawn(
    process.execPath,
    ['--import', 'tsx', RUNNER, pidFile, ...(mode === undefined ? [] : [mode])],
    { cwd: ROOT, stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true },
  );
  let stderr = '';
  runner.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
  const exited = new Promise<number | null>((resolve) =>
    runner.on('exit', (code) => resolve(code)),
  );
  const pids = await waitFor(
    () =>
      existsSync(pidFile)
        ? (JSON.parse(readFileSync(pidFile, 'utf8')) as { pid: number; grandchild: number })
        : undefined,
    15_000,
  );
  return {
    ...pids,
    exited,
    stderr: () => stderr,
    interrupt: () =>
      process.platform === 'win32' ? runner.stdin.write('SIGINT\n') : runner.kill('SIGINT'),
    /** The exit code, or 'still running' after `ms`. */
    exitWithin: (ms: number) =>
      Promise.race([
        exited,
        new Promise<'still running'>((r) => setTimeout(() => r('still running'), ms)),
      ]),
  };
}

describe('CLI · mcp connect · signals', () => {
  it('CLI · mcp connect · SIGINT while waiting for the server ends the server, its grandchild and plune (AC-8)', async () => {
    const run = await startRunner();
    run.interrupt();
    expect(await run.exited, run.stderr()).toBe(130);
    expect(alive(run.pid)).toBe(false);
    await waitFor(() => (alive(run.grandchild) ? undefined : true), 3_000);
  }, 30_000);

  it('CLI · mcp connect · a second SIGINT while a close hangs ends every server at once and exits', async () => {
    const run = await startRunner('stuck');
    run.interrupt();
    // The first one closes what it can and waits on the session that never lets go.
    expect(await run.exitWithin(1_500)).toBe('still running');
    run.interrupt();
    expect(await run.exitWithin(15_000), run.stderr()).toBe(130);
    expect(alive(run.pid)).toBe(false);
    await waitFor(() => (alive(run.grandchild) ? undefined : true), 3_000);
  }, 40_000);
});
