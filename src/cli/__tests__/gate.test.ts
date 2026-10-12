// `--fail-on-failures` (plune-ai/plune#1247, decision 8): the one rule every command's exit code comes from.

import { describe, expect, it } from 'vitest';
import { gateExit } from '../gate.js';

const finished = (counts: Record<string, number>, notRun: string[] = []) => ({ statusEvent: 'finished', counts, notRun });

describe('gateExit', () => {
  it('passes a run where everything passed', () => {
    expect(gateExit(finished({ passed: 3 })).code).toBe(0);
  });

  // The point of the gate: a muted failure is already outside `failed` and `broken`.
  it('passes a run whose only failures are muted, and says how many were muted', () => {
    const out = gateExit(finished({ passed: 2, failed: 0, broken: 0, muted: 2 }));
    expect(out.code).toBe(0);
    expect(out.line).toContain('2 muted');
  });

  it.each([
    ['failed', { passed: 2, failed: 1 }],
    ['broken', { passed: 2, broken: 1 }],
    ['failed and broken beside muted ones', { failed: 1, broken: 1, muted: 4 }],
  ])('fails a run with a counted failure: %s', (_name, counts) => {
    const out = gateExit(finished(counts));
    expect(out.code).toBe(1);
    expect(out.line).toMatch(/gate failed/);
  });

  // A dead shard is not green.
  it('fails a run with an expected case that never reported', () => {
    const out = gateExit(finished({ passed: 3 }, ['tc-9']));
    expect(out.code).toBe(1);
    expect(out.line).toContain('1 not run');
  });

  it('does not fail on blocked or skipped', () => {
    expect(gateExit(finished({ passed: 1, blocked: 2, skipped: 3 })).code).toBe(0);
  });

  it('fails when there is no verdict at all — the platform did not answer', () => {
    const out = gateExit(undefined);
    expect(out.code).toBe(1);
    expect(out.line).toMatch(/no verdict/);
  });

  it('fails on an answer that carries no counts — a platform older than the frozen summary', () => {
    expect(gateExit({ statusEvent: 'finished' }).code).toBe(1);
  });

  it('fails a terminated run, whatever it counted', () => {
    const out = gateExit({ statusEvent: 'terminated', counts: { passed: 3 }, notRun: [] });
    expect(out.code).toBe(1);
    expect(out.line).toMatch(/terminated/);
  });

  it('reads an absent notRun as nothing expected — a run with no lifecycle answers without it', () => {
    expect(gateExit({ counts: { passed: 1 } }).code).toBe(0);
  });

  describe("with the runner's own exit code (`run exec`)", () => {
    it.each([0, 3])('keeps the runner’s code %i when no result reached the run', (code) => {
      expect(gateExit(finished({}), code).code).toBe(code);
      expect(gateExit(finished({ passed: 0, failed: 0 }), code).code).toBe(code);
    });

    it('answers with the verdict once results arrived: a runner that failed on muted cases passes', () => {
      expect(gateExit(finished({ passed: 3, muted: 1 }), 1).code).toBe(0);
    });

    it('answers with the verdict once results arrived: a runner that exited 0 over a failure fails', () => {
      expect(gateExit(finished({ passed: 3, failed: 1 }), 0).code).toBe(1);
    });

    // Nothing reported, yet the run expected cases: that is the dead shard, not a command with nothing to say.
    it('fails a run that expected cases none of which reported, whatever the runner said', () => {
      expect(gateExit(finished({}, ['tc-1']), 0).code).toBe(1);
    });

    it('still fails when there is no verdict', () => {
      expect(gateExit(undefined, 0).code).toBe(1);
    });
  });
});
