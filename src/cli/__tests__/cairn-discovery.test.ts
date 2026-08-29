import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { findLatestCairnRun, NoCairnRunsError } from '../commands/cairn-artifact.js';
import { handleIngest } from '../commands/ingest.js';

/**
 * Picking the run when nobody named one (#295).
 *
 * `plune ingest` used to require the directory, and the directory is named after Cairn's run id —
 * which nobody types from memory. The command therefore began with a `ls runs/` every single time.
 *
 * These tests build real directories rather than mocking `fs`, because the two things that can go
 * wrong here are both properties of a real filesystem: which mtime a file actually has, and what a
 * symlink actually is.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const REAL_RUN = path.join(here, 'fixtures', 'cairn', 'design');

/**
 * Can this machine make a symlink at all?
 *
 * Windows refuses without Developer Mode or elevation (EPERM). Probed once, up front, so the symlink
 * test below is REPORTED as skipped rather than passing without asserting anything — a green test
 * that quietly did nothing is worse than a missing one, because it reads as coverage. CI runs on
 * Linux, where this is always true.
 */
const canSymlink = await (async (): Promise<boolean> => {
  const probe = await fs.mkdtemp(path.join(os.tmpdir(), 'plune-symlink-probe-'));
  try {
    await fs.mkdir(path.join(probe, 'target'));
    await fs.symlink(path.join(probe, 'target'), path.join(probe, 'link'), 'dir');
    return true;
  } catch {
    return false;
  } finally {
    await fs.rm(probe, { recursive: true, force: true });
  }
})();

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

/** A throwaway `runs/` holding one directory per entry, with the mtime each names. */
async function runsDir(
  entries: Array<{ name: string; at?: Date; report?: boolean }>,
): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plune-runs-'));
  made.push(root);
  const runs = path.join(root, 'runs');
  await fs.mkdir(runs);
  for (const entry of entries) {
    const dir = path.join(runs, entry.name);
    await fs.mkdir(dir);
    if (entry.report === false) continue;
    const report = path.join(dir, 'report.json');
    await fs.copyFile(path.join(REAL_RUN, 'report.json'), report);
    if (entry.at) await fs.utimes(report, entry.at, entry.at);
  }
  return runs;
}

describe('findLatestCairnRun', () => {
  it('picks by mtime, not by name — Cairn ids do not sort by time', async () => {
    // The trap this whole function exists to avoid. `zz-…` sorts last and is the OLDER run; a `sort()`
    // implementation passes every other test in this file and fails only here, on real data.
    const runs = await runsDir([
      { name: 'zz-older-id', at: new Date('2026-08-01T10:00:00Z') },
      { name: 'aa-newer-id', at: new Date('2026-08-20T10:00:00Z') },
    ]);

    expect(await findLatestCairnRun(runs)).toBe(path.join(runs, 'aa-newer-id'));
  });

  it('ignores a directory that holds no report', async () => {
    // `./runs` is an ordinary working directory: notes, logs and half-finished runs live there too.
    const runs = await runsDir([
      { name: 'not-a-run', report: false },
      { name: 'a-run', at: new Date('2026-08-01T10:00:00Z') },
    ]);

    expect(await findLatestCairnRun(runs)).toBe(path.join(runs, 'a-run'));
  });

  it('refuses when every candidate is empty, and says what to do instead', async () => {
    const runs = await runsDir([{ name: 'empty-one', report: false }]);

    await expect(findLatestCairnRun(runs)).rejects.toThrow(NoCairnRunsError);
    await expect(findLatestCairnRun(runs)).rejects.toThrow('plune ingest <dir>');
  });

  it('refuses when there is no runs directory at all', async () => {
    // The common case for someone who has never run Cairn here — and the message has to be the one
    // that gets them unstuck, not "ENOENT".
    const runs = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'plune-none-')), 'runs');
    made.push(path.dirname(runs));

    await expect(findLatestCairnRun(runs)).rejects.toThrow(NoCairnRunsError);
  });

  it.skipIf(!canSymlink)('does not follow a symlink planted in runs/', async () => {
    // Auto-discovery is the one place this command reads a path nobody typed, so it stays inside the
    // directory it was given. The guard is `isDirectory()` on a Dirent, which answers for the link
    // itself rather than its target.
    const runs = await runsDir([{ name: 'real', at: new Date('2026-08-01T10:00:00Z') }]);
    const elsewhere = path.join(path.dirname(runs), 'elsewhere');
    await fs.mkdir(elsewhere);
    await fs.copyFile(path.join(REAL_RUN, 'report.json'), path.join(elsewhere, 'report.json'));
    const newer = new Date('2026-08-25T10:00:00Z');
    await fs.utimes(path.join(elsewhere, 'report.json'), newer, newer);
    await fs.symlink(elsewhere, path.join(runs, 'linked'), 'dir');

    // The link points at the NEWER report, so anything that followed it would return that one.
    expect(await findLatestCairnRun(runs)).toBe(path.join(runs, 'real'));
  });
});

describe('handleIngest without a directory', () => {
  const uploaded = (): typeof fetch =>
    (async () =>
      new Response(JSON.stringify({ runId: 'run-1', linked: 0, proposed: 29, skipped: 0 }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

  it('uploads the newest run under runs/', async () => {
    const runs = await runsDir([
      { name: 'older', at: new Date('2026-08-01T10:00:00Z') },
      { name: 'newer', at: new Date('2026-08-20T10:00:00Z') },
    ]);

    const result = await handleIngest({
      runsDir: runs,
      apiUrl: 'https://api.test',
      loadToken: () => 'plune_test_token',
      fetchImpl: uploaded(),
    });
    expect(result.proposed).toBe(29);
  });

  it('sends nothing when there is no run to find', async () => {
    // The refusal has to happen before the network, like every other refusal in this command: a
    // failed ingest must leave no half-request behind.
    const runs = await runsDir([]);
    let called = false;

    await expect(
      handleIngest({
        runsDir: runs,
        apiUrl: 'https://api.test',
        loadToken: () => 'plune_test_token',
        fetchImpl: (async () => {
          called = true;
          return new Response('{}', { status: 201 });
        }) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(NoCairnRunsError);
    expect(called).toBe(false);
  });

  it('still takes an explicit directory, unchanged', async () => {
    const result = await handleIngest({
      dir: REAL_RUN,
      apiUrl: 'https://api.test',
      loadToken: () => 'plune_test_token',
      fetchImpl: uploaded(),
    });
    expect(result.proposed).toBe(29);
  });
});
