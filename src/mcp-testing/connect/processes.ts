import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';

// Everything about ending server processes lives here, so the way it is done can be replaced in one file.
//
// The SDK's stdio transport ends only the process it started. A server started as `npx …` or `cmd /c …` is that
// process's child, and survives it; so does a server's own helper. So before a session lets the SDK close, it notes
// every descendant of the server, and kills the ones still there afterwards. Plus: SIGINT and SIGTERM to `plune`
// close every open session before exiting, and `process.on('exit')` kills whatever is left.

/** A parent-child pair; `started` orders them where a parent pid can be stale (Windows does not reparent). */
interface Proc {
  pid: number;
  ppid: number;
  started: number;
}

function processTable(): Proc[] {
  if (process.platform === 'win32') {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CreationDate.ToFileTimeUtc())" }',
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return out.split(/\r?\n/).flatMap((line) => {
      const [pid, ppid, started] = line.trim().split(' ').map(Number);
      return pid !== undefined &&
        ppid !== undefined &&
        started !== undefined &&
        !Number.isNaN(started)
        ? [{ pid, ppid, started }]
        : [];
    });
  }
  if (process.platform === 'linux') {
    // /proc/<pid>/stat: "pid (comm) state ppid ..."; comm may hold spaces and parentheses, so read after the last ")".
    return readdirSync('/proc').flatMap((name) => {
      if (!/^\d+$/.test(name)) return [];
      try {
        const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
        const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
        return [{ pid: Number(name), ppid, started: 0 }];
      } catch {
        return [];
      }
    });
  }
  const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 15_000 });
  return out.split('\n').flatMap((line) => {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    return pid !== undefined && ppid !== undefined && !Number.isNaN(ppid)
      ? [{ pid, ppid, started: 0 }]
      : [];
  });
}

/**
 * Every process below `root`, children before grandchildren. On Windows a child counts only if it started after
 * its parent: a pid there can name a parent long gone, and the server may have been given that pid since.
 */
export function descendantsOf(root: number): number[] {
  let table: Proc[];
  try {
    table = processTable();
  } catch {
    return [];
  }
  const started = new Map(table.map((p) => [p.pid, p.started]));
  const found: number[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const p of table) {
      if (p.ppid !== parent || p.pid === parent || found.includes(p.pid)) continue;
      if (p.started < (started.get(parent) ?? 0)) continue;
      found.push(p.pid);
      queue.push(p.pid);
    }
  }
  return found;
}

/** Kills each pid that is still there; one already gone is not an error. */
// Known limit: the pids were noted at most a few seconds earlier; a pid reused by the system in between would be killed
// too. Comparing start times before the kill closes that if it ever matters.
export function killAll(pids: readonly number[]): void {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // gone already, or not ours to kill
    }
  }
}

/** What the registry needs of a session: an orderly close, and a last resort that cannot wait. */
export interface Closable {
  close(): Promise<void>;
  killNow(): void;
}

const open = new Set<Closable>();

const onSignal = (signal: NodeJS.Signals) => {
  void closeAllSessions().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
};
const onExit = () => {
  for (const session of open) session.killNow();
};

/** Registers a session until it is closed; the signal handlers are installed only while one is open. */
export function track(session: Closable): () => void {
  if (open.size === 0) {
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    process.on('exit', onExit);
  }
  open.add(session);
  return () => {
    if (!open.delete(session) || open.size > 0) return;
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    process.off('exit', onExit);
  };
}

/** Closes every open session, including one still connecting. */
export async function closeAllSessions(): Promise<void> {
  await Promise.all([...open].map((session) => session.close()));
}
