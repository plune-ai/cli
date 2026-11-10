// The check loop on a clock of its own: no test here waits for real time. A step that "hangs" is a promise that never
// settles; the fake clock decides when its timeout has come.

import { describe, expect, it } from 'vitest';
import { runChecks, type Clock, type Step, type StepResult } from '../run.js';

/**
 * A virtual clock: time jumps to the next timer only once nothing else is left to run (setImmediate comes after every
 * pending promise), so a step that answers always beats its timeout, and timers fire in the order they are due.
 */
function fakeClock(early = 0): Clock & { elapsed: () => number } {
  let now = 0;
  let timers: { at: number; fire: () => void; cancelled: boolean }[] = [];
  let scheduled = false;
  const schedule = () => {
    if (scheduled || timers.length === 0) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      timers = timers.filter((t) => !t.cancelled).sort((a, b) => a.at - b.at);
      const next = timers.shift();
      if (next === undefined) return;
      now = next.at;
      next.fire();
      schedule();
    });
  };
  return {
    now: () => now,
    elapsed: () => now,
    after(ms) {
      let fire = () => {};
      const done = new Promise<void>((resolve) => (fire = resolve));
      // `early`: a coarse timer that fires a few milliseconds before the clock says it is due.
      const timer = { at: Math.max(now, now + ms - early), fire, cancelled: false };
      timers.push(timer);
      schedule();
      return { done, cancel: () => (timer.cancelled = true) };
    },
  };
}

const answers = (id: string, result: StepResult = { state: 'passed', detail: 'ok' }): Step => ({
  id,
  run: async () => result,
});
const hangs = (id: string): Step => ({ id, run: () => new Promise<never>(() => {}) });
const offline = (id: string): Step => ({
  id,
  run: async () => ({ state: 'passed', detail: 'read from the handshake', offline: true }),
});

const OPTS = { timeoutMs: 15_000, timedOutDetail: 'no answer within --check-timeout (15s)' };
const states = (ran: Awaited<ReturnType<typeof runChecks>>) =>
  ran.map((r) => `${r.id} ${r.result.state}${r.result.timedOut === true ? ' timedOut' : ''}`);

describe('CLI · mcp check · the check loop', () => {
  it('CLI · mcp check · a step that does not answer in time is could-not-run with timedOut, never failed', async () => {
    const clock = fakeClock();
    const ran = await runChecks([answers('a'), hangs('b'), answers('c')], clock, OPTS);
    expect(states(ran)).toEqual(['a passed', 'b could-not-run timedOut', 'c passed']);
    expect(ran[1]!.result.detail).toBe('no answer within --check-timeout (15s)');
    expect(ran[1]!.ms).toBe(15_000);
  });

  it('CLI · mcp check · after two timeouts in a row the rest is could-not-run without timedOut, and not run (AC-4)', async () => {
    const clock = fakeClock();
    let reached = false;
    const ran = await runChecks(
      [
        answers('a'),
        hangs('b'),
        hangs('c'),
        { id: 'd', run: async () => ((reached = true), { state: 'passed', detail: 'ok' }) },
        hangs('e'),
      ],
      clock,
      OPTS,
    );
    expect(states(ran)).toEqual([
      'a passed',
      'b could-not-run timedOut',
      'c could-not-run timedOut',
      'd could-not-run',
      'e could-not-run',
    ]);
    expect(ran[3]!.result).toEqual({
      state: 'could-not-run',
      detail: 'skipped after two timeouts in a row',
    });
    expect(reached).toBe(false);
    expect(clock.elapsed()).toBe(2 * 15_000);
  });

  it('CLI · mcp check · an answer between two timeouts resets the count', async () => {
    const ran = await runChecks(
      [hangs('a'), answers('b'), hangs('c'), answers('d')],
      fakeClock(),
      OPTS,
    );
    expect(states(ran)).toEqual([
      'a could-not-run timedOut',
      'b passed',
      'c could-not-run timedOut',
      'd passed',
    ]);
  });

  it('CLI · mcp check · a step that reads only the connection does not reset the count (AC-5)', async () => {
    const clock = fakeClock();
    const ran = await runChecks(
      [hangs('tools-list'), offline('capabilities'), hangs('prompts-list'), answers('ping')],
      clock,
      OPTS,
    );
    expect(states(ran)).toEqual([
      'tools-list could-not-run timedOut',
      'capabilities passed',
      'prompts-list could-not-run timedOut',
      'ping could-not-run',
    ]);
    expect(clock.elapsed()).toBe(2 * 15_000);
  });

  it('CLI · mcp check · a step that answers failed is failed and resets the count', async () => {
    const failed: StepResult = { state: 'failed', detail: 'the server answered with an error' };
    const ran = await runChecks(
      [hangs('a'), answers('b', failed), hangs('c'), answers('d')],
      fakeClock(),
      OPTS,
    );
    expect(states(ran)).toEqual([
      'a could-not-run timedOut',
      'b failed',
      'c could-not-run timedOut',
      'd passed',
    ]);
  });

  it('CLI · mcp check · a budget bounds all steps together: the last one gets what is left, the rest could-not-run', async () => {
    const clock = fakeClock();
    const slow = (id: string): Step => ({
      id,
      run: async () => {
        await clock.after(4_000).done;
        return { state: 'passed', detail: 'ok' };
      },
    });
    const ran = await runChecks([slow('a'), slow('b'), hangs('c'), answers('d')], clock, {
      ...OPTS,
      budgetMs: 10_000,
      budgetDetail: 'the --budget (10s) was spent',
    });
    expect(states(ran)).toEqual([
      'a passed',
      'b passed',
      'c could-not-run timedOut',
      'd could-not-run',
    ]);
    expect(ran[2]!.ms).toBe(2_000);
    expect(ran[3]!.result).toEqual({
      state: 'could-not-run',
      detail: 'the --budget (10s) was spent',
    });
    expect(clock.elapsed()).toBe(10_000);
  });

  it('CLI · mcp check · a step the budget cut ends the budget: the rest is "budget spent", not "two timeouts", though 3 ms seem left', async () => {
    const clock = fakeClock(3);
    let started = 0;
    const counted = (id: string): Step => ({
      id,
      run: () => {
        started++;
        return new Promise<never>(() => {});
      },
    });
    const ran = await runChecks([counted('a'), counted('b'), counted('c')], clock, {
      ...OPTS,
      budgetMs: 1_000,
      budgetDetail: 'the --budget (1s) was spent',
    });
    expect(states(ran)).toEqual(['a could-not-run timedOut', 'b could-not-run', 'c could-not-run']);
    expect(ran.map((r) => r.result.detail)).toEqual([
      'the --budget (1s) was spent',
      'the --budget (1s) was spent',
      'the --budget (1s) was spent',
    ]);
    expect(started).toBe(1);
  });

  it('CLI · mcp check · a step is not started on a crumb of budget: under 50 ms left is "budget spent"', async () => {
    const clock = fakeClock();
    const slow: Step = {
      id: 'a',
      run: async () => {
        await clock.after(970).done;
        return { state: 'passed', detail: 'ok' };
      },
    };
    let reached = false;
    const ran = await runChecks(
      [slow, { id: 'b', run: async () => ((reached = true), { state: 'passed', detail: 'ok' }) }],
      clock,
      { ...OPTS, budgetMs: 1_000, budgetDetail: 'the --budget (1s) was spent' },
    );
    expect(states(ran)).toEqual(['a passed', 'b could-not-run']);
    expect(ran[1]!.result.detail).toBe('the --budget (1s) was spent');
    expect(reached).toBe(false);
  });

  it('CLI · mcp check · no steps, no results', async () => {
    expect(await runChecks([], fakeClock(), OPTS)).toEqual([]);
  });
});
