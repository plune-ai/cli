import { performance } from 'node:perf_hooks';
import type { CheckState } from '../result.js';

// The loop `plune mcp check` runs its checks in, and its smoke calls too: one step after another, each under a time
// limit, on a clock it is given (tests bring one that needs no real time). The rules:
// - a step with no answer in time is `could-not-run` with `timedOut: true`, never `failed`: not tested is not passed;
// - after two timeouts in a row the rest is `could-not-run` without `timedOut`, and is not run: a server that stopped
//   answering would otherwise cost one full timeout per check;
// - a step that read only what the connection already held (`offline`) proves nothing about the server answering, so
//   it does not end a run of timeouts;
// - with a budget, all steps together stay within it: a step gets what is left of it, and past it the rest is
//   `could-not-run`.

export interface Clock {
  /** Milliseconds, from any fixed point. */
  now(): number;
  /** Resolves `done` after `ms`, unless cancelled first (then it never resolves). */
  after(ms: number): { done: Promise<void>; cancel(): void };
}

export const realClock: Clock = {
  now: () => performance.now(),
  after(ms) {
    let timer: NodeJS.Timeout | undefined;
    const done = new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)));
    return { done, cancel: () => clearTimeout(timer) };
  },
};

export interface StepResult {
  state: CheckState;
  /** One sentence: what was seen. */
  detail: string;
  timedOut?: true;
  /** Read from what the connection already holds: no request was made, so no answer came. */
  offline?: true;
}

export interface Step<R extends StepResult = StepResult> {
  id: string;
  run(): Promise<R | StepResult>;
}

export interface RunOptions {
  timeoutMs: number;
  /** The detail of a step that timed out. */
  timedOutDetail: string;
  budgetMs?: number;
  /** The detail of a step the budget cut short, or did not leave time for. */
  budgetDetail?: string;
}

export interface Ran<R extends StepResult = StepResult> {
  id: string;
  result: R | StepResult;
  ms: number;
}

const SKIPPED = 'skipped after two timeouts in a row';
const TIMED_OUT: unique symbol = Symbol('timed out');

export async function runChecks<R extends StepResult>(
  steps: readonly Step<R>[],
  clock: Clock,
  opts: RunOptions,
): Promise<Ran<R>[]> {
  const ran: Ran<R>[] = [];
  const start = clock.now();
  let timeouts = 0;
  for (const step of steps) {
    const left = opts.budgetMs === undefined ? Infinity : opts.budgetMs - (clock.now() - start);
    if (timeouts >= 2 || left <= 0) {
      const detail = timeouts >= 2 ? SKIPPED : (opts.budgetDetail ?? SKIPPED);
      ran.push({ id: step.id, result: { state: 'could-not-run', detail }, ms: 0 });
      continue;
    }
    const byBudget = left < opts.timeoutMs;
    const began = clock.now();
    const timer = clock.after(Math.min(opts.timeoutMs, left));
    const running = step.run();
    // A step left behind may still settle later; what it says then is no longer heard.
    running.catch(() => {});
    let result: R | StepResult;
    try {
      const settled = await Promise.race([
        running,
        timer.done.then((): typeof TIMED_OUT => TIMED_OUT),
      ]);
      result =
        settled === TIMED_OUT
          ? {
              state: 'could-not-run',
              detail: byBudget ? (opts.budgetDetail ?? opts.timedOutDetail) : opts.timedOutDetail,
              timedOut: true,
            }
          : settled;
    } finally {
      timer.cancel();
    }
    if (result.timedOut === true) timeouts++;
    else if (result.offline !== true) timeouts = 0;
    ran.push({ id: step.id, result, ms: clock.now() - began });
  }
  return ran;
}
