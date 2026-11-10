import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';

// Everything about ending server processes lives here, so the way it is done can be replaced in one file.
//
// The SDK's stdio transport ends only the process it started. A server started as `npx …` or `cmd /c …` is that
// process's child, and survives it; so does a server's own helper. So before a session lets the SDK close, it notes
// every descendant of the server with its start time, and afterwards kills the ones still there with that same start
// time. Plus: SIGINT and SIGTERM to `plune` close every open session before exiting (a second one stops waiting and
// kills at once), and `process.on('exit')` kills whatever is left.

/**
 * A process as the table shows it. `started` is its start time as the system writes it (Windows: CreationDate as a
 * file time; Linux: `starttime`, field 22 of /proc/<pid>/stat; elsewhere: `ps -o lstart`). A pid alone can be given
 * to another process once the first is gone; a pid with its start time cannot.
 */
export interface Proc {
  pid: number;
  ppid: number;
  started: string;
}

/** Lines of "pid ppid started…"; a line that does not read as one is skipped, never the whole table. */
export function parseProcessTable(text: string): Proc[] {
  return text.split(/\r?\n/).flatMap((line) => {
    const [pid, ppid, ...started] = line.trim().split(/\s+/);
    const proc = { pid: Number(pid), ppid: Number(ppid), started: started.join(' ') };
    return Number.isInteger(proc.pid) && Number.isInteger(proc.ppid) && proc.started !== ''
      ? [proc]
      : [];
  });
}

// One process whose fields cannot be read (CreationDate is empty for some system processes) is skipped inside the
// script; the output is read whatever the exit code, so a failure on one line costs that line only.
const WINDOWS_TABLE =
  'Get-CimInstance Win32_Process | ForEach-Object { try { "{0} {1} {2}" -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToFileTimeUtc() } catch {} }';

function processTable(): Proc[] {
  if (process.platform === 'win32') {
    const out = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_TABLE],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    return parseProcessTable(out.stdout ?? '');
  }
  if (process.platform === 'linux') {
    // /proc/<pid>/stat: "pid (comm) state ppid …"; comm may hold spaces and parentheses, so read after the last ")".
    // From there the fields are numbered from 3 (state): ppid is field 4, starttime field 22.
    return readdirSync('/proc').flatMap((name) => {
      if (!/^\d+$/.test(name)) return [];
      try {
        const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        return parseProcessTable(`${name} ${fields[1]} ${fields[19]}`);
      } catch {
        return [];
      }
    });
  }
  const out = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,lstart='], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  return parseProcessTable(out.stdout ?? '');
}

function readTable(): Proc[] {
  try {
    return processTable();
  } catch {
    return [];
  }
}

/**
 * Every process below `root`, children before grandchildren. A child counts only if it did not start before its
 * parent: on Windows a pid can name a parent long gone, and the server may have been given that pid since.
 */
export function descendantsOf(root: number): Proc[] {
  const table = readTable();
  const startOf = new Map(table.map((p) => [p.pid, Number(p.started)]));
  const found: Proc[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const p of table) {
      if (p.ppid !== parent || p.pid === parent || found.some((f) => f.pid === p.pid)) continue;
      // NaN (a start time that is not a number, as ps writes it) compares false: kept.
      if (Number(p.started) < (startOf.get(parent) ?? 0)) continue;
      found.push(p);
      queue.push(p.pid);
    }
  }
  return found;
}

/** The pids of `noted` that are still the same processes in `now`: same pid, same start time. */
export function survivors(noted: readonly Proc[], now: readonly Proc[]): number[] {
  const current = new Set(now.map((p) => `${p.pid} ${p.started}`));
  return noted.filter((p) => current.has(`${p.pid} ${p.started}`)).map((p) => p.pid);
}

/** Kills each pid that is still there; one already gone is not an error. */
export function killAll(pids: readonly number[]): void {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // gone already, or not ours to kill
    }
  }
}

/**
 * Kills what is left of processes noted earlier. The table is read again, and only a pid that still has the start
 * time it was noted with is killed: one the system has given to another process in between is left alone.
 */
export function killSurvivors(noted: readonly Proc[]): void {
  if (noted.length > 0) killAll(survivors(noted, readTable()));
}

/** What the registry needs of a session: an orderly close, and a last resort that cannot wait. */
export interface Closable {
  close(): Promise<void>;
  killNow(): void;
}

const open = new Set<Closable>();

let interrupted = false;
/** The first signal closes every session in order; a second one, while that waits, kills at once and exits. */
const onSignal = (signal: NodeJS.Signals) => {
  const code = signal === 'SIGINT' ? 130 : 143;
  if (interrupted) {
    for (const session of open) session.killNow();
    process.exit(code);
  }
  interrupted = true;
  void closeAllSessions().finally(() => process.exit(code));
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
