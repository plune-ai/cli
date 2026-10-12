// `--fail-on-failures` (plune-ai/plune#1247, decision 8 of 12.10.2026): a release gate on the verdict the platform
// already keeps. The platform counts a muted case's `failed` or `broken` under `muted`, so a muted failure is
// outside both counts here without the CLI knowing what a mute is — the case flag stays the one source (decision 7).

/** The platform's verdict on a run: the summary `finish` froze, or the one `GET /v1/runs/:id/summary` reads. */
export interface Verdict {
  /** `terminated` is a run cut short. */
  statusEvent?: string | undefined;
  /** By the status each result is counted under; an absent key is zero. Absent altogether: there is no verdict. */
  counts?: Readonly<Record<string, number>> | undefined;
  /** The expected cases that never reported. Absent: the run expected nothing. */
  notRun?: readonly string[] | undefined;
}

/**
 * The exit code `--fail-on-failures` asks for, and the line that says why.
 *
 * - 1 on `failed + broken > 0`, and on `notRun > 0`: a dead shard is not green;
 * - `blocked` and `skipped` do not fail it;
 * - 1 with no verdict — the platform did not answer with one, or the run was terminated;
 * - `runnerCode` (`run exec`) is kept when no result reached the run and nothing was expected of it.
 */
export function gateExit(verdict: Verdict | undefined, runnerCode?: number): { code: number; line: string } {
  if (verdict?.statusEvent === 'terminated') {
    return { code: 1, line: 'plune: gate failed — the run was terminated, so it has no verdict to pass on.' };
  }
  const counts = verdict?.counts;
  if (counts == null) return { code: 1, line: 'plune: gate failed — no verdict from the platform, and no verdict is no pass.' };

  const n = (status: string): number => counts[status] ?? 0;
  const notRun = verdict?.notRun?.length ?? 0;
  if (runnerCode !== undefined && notRun === 0 && Object.values(counts).every((k) => !k)) {
    return { code: runnerCode, line: `plune: gate — no result reached the run, so the exit code is the command's own (${runnerCode}).` };
  }
  const said = `${n('failed')} failed · ${n('broken')} broken · ${notRun} not run · ${n('muted')} muted`;
  return n('failed') + n('broken') > 0 || notRun > 0
    ? { code: 1, line: `plune: gate failed — ${said}` }
    : { code: 0, line: `plune: gate passed — ${said}` };
}
