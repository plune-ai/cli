// The tool-call assertions on transcripts kept from real runs of the agent loop (the stdio fixture server of the
// orchestrator tests, a scripted model): a complete turn, a turn with a tool error, a turn stopped by max_steps, and a
// turn whose 1 MiB result was cut to its excerpt. Every passing case has a failing twin on a changed transcript.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getAssertion } from '../registry.js';
import { AssertionRunError, absence } from '../tool-calls/transcript.js';
import type { AssertionResult } from '../../types/assertion.js';
import type { AssertionConfig } from '../../types/config.js';
import type { AgentCall, AgentTranscript } from '../../types/results.js';

const fixture = (name: string): AgentTranscript =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/transcript-${name}.json`, import.meta.url), 'utf8'),
  ) as AgentTranscript;

const COMPLETE = fixture('complete');
const TOOL_ERROR = fixture('tool-error');
const MAX_STEPS = fixture('max-steps');
const CUT = fixture('cut-result');

/** The result texts of the fixtures: no failure reason may carry them. */
const RESULT_TEXTS = ['contents of a.txt', 'the tool failed', 'xxxxxxxx'];

function run(
  params: AssertionConfig,
  transcript: AgentTranscript | undefined,
  vars: Record<string, string> = {},
): Promise<AssertionResult> {
  return getAssertion(params.type).run({
    output: 'done',
    vars,
    row: { vars },
    params,
    ...(transcript !== undefined ? { transcript } : {}),
  });
}

async function failed(params: AssertionConfig, transcript: AgentTranscript): Promise<string> {
  const r = await run(params, transcript);
  expect(r.passed).toBe(false);
  const reason = r.reason!;
  for (const text of RESULT_TEXTS) expect(reason).not.toContain(text);
  return reason;
}

async function thrown(
  params: AssertionConfig,
  transcript?: AgentTranscript,
): Promise<AssertionRunError> {
  const err = await run(params, transcript).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(AssertionRunError);
  return err as AssertionRunError;
}

/** A copy with every step's calls replaced by `calls` (one step), the rest kept. */
function withCalls(t: AgentTranscript, calls: Partial<AgentCall>[]): AgentTranscript {
  const copy = structuredClone(t);
  copy.steps = [
    {
      ...copy.steps[0]!,
      calls: calls.map((c, i) => ({
        id: `c${i}`,
        name: 'echo',
        args: {},
        executed: true,
        is_error: false,
        duration_ms: 1,
        result: { text: '{}', bytes: 2, truncated: false },
        ...c,
      })),
    },
    ...copy.steps.slice(1).map((s) => ({ ...s, calls: [] })),
  ];
  return copy;
}

/** The model answered without a call and the loop ended on its own. */
const NO_CALLS = withCalls(COMPLETE, []);

describe('CLI · assertions · tool-calls · fixtures', () => {
  it('CLI · assertions · tool-calls · the fixtures are what the loop recorded: complete, tool error, max_steps, cut result', () => {
    expect(COMPLETE).toMatchObject({ stop: { reason: 'complete' }, collection: 'complete' });
    expect(TOOL_ERROR.steps[0]!.calls[0]).toMatchObject({
      name: 'fail',
      is_error: true,
      error_kind: 'content',
    });
    expect(MAX_STEPS).toMatchObject({
      stop: { reason: 'limit', limit: 'max_steps' },
      collection: 'partial',
    });
    expect(CUT.steps[0]!.calls[0]!.result).toMatchObject({ bytes: 1048576, truncated: true });
  });

  it('CLI · assertions · tool-calls · without a transcript a tool-call assertion is not measured', async () => {
    const err = await thrown({ type: 'tool-called', tool: 'echo' });
    expect(err.code).toBe('ASSERTION_UNMEASURED');
    expect(err.message).toMatch(/tool-called.*mcp/);
    expect(err.message).toMatch(/after it in this row were not run/);
  });
});

describe('CLI · assertions · tool-called', () => {
  it('CLI · assertions · tool-called · passes when the tool was called', async () => {
    expect(await run({ type: 'tool-called', tool: 'echo' }, COMPLETE)).toEqual({ passed: true });
  });

  it('CLI · assertions · tool-called · fails below min_count, naming expected, got and the step', async () => {
    const reason = await failed({ type: 'tool-called', tool: 'echo', min_count: 2 }, COMPLETE);
    expect(reason).toMatch(/expected "echo" called at least 2 times/);
    expect(reason).toMatch(/got 1/);
    expect(reason).toMatch(/step 1 echo \{"text":"hi"\}/);
  });

  it('CLI · assertions · tool-called · fails when the model called nothing', async () => {
    const reason = await failed({ type: 'tool-called', tool: 'echo' }, NO_CALLS);
    expect(reason).toMatch(/got 0.*no tool call/);
  });

  it('CLI · assertions · tool-called · an unknown tool name is errored with the offered list (AC-4)', async () => {
    const err = await thrown({ type: 'tool-called', tool: 'ecoh' }, COMPLETE);
    expect(err.code).toBe('ASSERTION_UNKNOWN_TOOL');
    expect(err.message).toContain('"ecoh"');
    expect(err.message).toContain('echo, files/read, fail, big, slow, crash');
  });
});

describe('CLI · assertions · tool-not-called', () => {
  it('CLI · assertions · tool-not-called · passes when the tool was never called', async () => {
    expect(await run({ type: 'tool-not-called', tool: 'fail' }, COMPLETE)).toEqual({
      passed: true,
    });
  });

  it('CLI · assertions · tool-not-called · passes when the model called nothing and the loop ended on its own', async () => {
    expect(await run({ type: 'tool-not-called', tool: 'echo' }, NO_CALLS)).toEqual({
      passed: true,
    });
  });

  it('CLI · assertions · tool-not-called · fails when the tool was called, with the step', async () => {
    const reason = await failed({ type: 'tool-not-called', tool: 'echo' }, COMPLETE);
    expect(reason).toMatch(/expected "echo" never called/);
    expect(reason).toMatch(/got 1 call: step 1 echo/);
  });

  it('CLI · assertions · tool-not-called · on a loop stopped by max_steps, nothing found is not measured (AC-3)', async () => {
    const err = await thrown({ type: 'tool-not-called', tool: 'fail' }, MAX_STEPS);
    expect(err.code).toBe('ASSERTION_UNMEASURED');
    expect(err.message).toMatch(/tool-not-called.*not measured.*max_steps/);
  });

  it('CLI · assertions · tool-not-called · on a loop stopped by max_steps, a call found still fails (AC-3)', async () => {
    const reason = await failed({ type: 'tool-not-called', tool: 'echo' }, MAX_STEPS);
    expect(reason).toMatch(/step 1 echo/);
  });

  it('CLI · assertions · tool-not-called · a name that is not among the offered tools is errored, not passed (AC-4)', async () => {
    const err = await thrown({ type: 'tool-not-called', tool: 'delete_all' }, COMPLETE);
    expect(err.code).toBe('ASSERTION_UNKNOWN_TOOL');
    expect(err.message).toMatch(/"delete_all".*offered: echo, files\/read/);
  });

  it('CLI · assertions · tool-not-called · a tool the server listed but allowed_tools left out is unknown too (AC-4)', async () => {
    const t = structuredClone(COMPLETE);
    t.tools = t.tools.map((tool) => ({ ...tool, offered: tool.name === 'echo' }));
    const err = await thrown({ type: 'tool-not-called', tool: 'fail' }, t);
    expect(err.message).toMatch(/offered: echo\. /);
  });

  it('CLI · assertions · tool-not-called · a limit stop that does not name its limit still says a limit stopped it', async () => {
    const t = structuredClone(MAX_STEPS);
    t.stop = { reason: 'limit' };
    expect((await thrown({ type: 'tool-not-called', tool: 'fail' }, t)).message).toMatch(
      /stopped by a limit/,
    );
  });

  it('CLI · assertions · tool-not-called · a server that offered nothing names no tools', async () => {
    const t = structuredClone(NO_CALLS);
    t.tools = [];
    const err = await thrown({ type: 'tool-not-called', tool: 'echo' }, t);
    expect(err.message).toMatch(/offered: \(none\)/);
  });
});

describe('CLI · assertions · tool-args', () => {
  const READ = withCalls(COMPLETE, [{ name: 'files/read', args: { path: 'a.txt', mode: 'r' } }]);

  it('CLI · assertions · tool-args · partial passes on a subset of the arguments', async () => {
    expect(
      await run({ type: 'tool-args', tool: 'files/read', args: { path: 'a.txt' } }, COMPLETE),
    ).toEqual({ passed: true });
  });

  it('CLI · assertions · tool-args · partial, exact and ignore give three documented results on one transcript (AC-8)', async () => {
    const verdict = async (match: 'partial' | 'exact' | 'ignore', args: Record<string, unknown>) =>
      (await run({ type: 'tool-args', tool: 'files/read', args, match }, READ)).passed;
    // A subset of the call's arguments: partial yes, exact no, ignore yes.
    expect(await verdict('partial', { path: 'a.txt' })).toBe(true);
    expect(await verdict('exact', { path: 'a.txt' })).toBe(false);
    expect(await verdict('ignore', { path: 'a.txt' })).toBe(true);
    // A different value: only ignore passes.
    expect(await verdict('partial', { path: 'b.txt' })).toBe(false);
    expect(await verdict('exact', { path: 'b.txt' })).toBe(false);
    expect(await verdict('ignore', { path: 'b.txt' })).toBe(true);
    // The same arguments, key order aside: all three pass.
    expect(await verdict('exact', { mode: 'r', path: 'a.txt' })).toBe(true);
  });

  it('CLI · assertions · tool-args · fails with the expected arguments, the mode and the calls seen', async () => {
    const reason = await failed(
      { type: 'tool-args', tool: 'files/read', args: { path: 'b.txt' } },
      COMPLETE,
    );
    expect(reason).toMatch(
      /expected a call to "files\/read" with arguments \{"path":"b.txt"\} \(partial\)/,
    );
    expect(reason).toMatch(/got 0 of 1 call/);
    expect(reason).toMatch(/step 1 files\/read \{"path":"a.txt"\}/);
  });

  it('CLI · assertions · tool-args · strings are exact and case-sensitive; 5 is not "5"', async () => {
    const t = withCalls(COMPLETE, [{ name: 'echo', args: { text: 'Hi', n: 5 } }]);
    const ok = async (args: Record<string, unknown>) =>
      (await run({ type: 'tool-args', tool: 'echo', args }, t)).passed;
    expect(await ok({ text: 'Hi' })).toBe(true);
    expect(await ok({ text: 'hi' })).toBe(false);
    expect(await ok({ n: 5 })).toBe(true);
    expect(await ok({ n: '5' })).toBe(false);
  });

  it('CLI · assertions · tool-args · nested objects match by subset, arrays only whole', async () => {
    const t = withCalls(COMPLETE, [
      { name: 'echo', args: { q: { a: 1, b: { c: 2, d: 3 } }, list: [1, 2] } },
    ]);
    const ok = async (args: Record<string, unknown>) =>
      (await run({ type: 'tool-args', tool: 'echo', args }, t)).passed;
    expect(await ok({ q: { b: { c: 2 } } })).toBe(true);
    expect(await ok({ q: { b: { c: 3 } } })).toBe(false);
    expect(await ok({ q: { e: 1 } })).toBe(false);
    expect(await ok({ q: 'x' })).toBe(false);
    expect(await ok({ list: [1, 2] })).toBe(true);
    expect(await ok({ list: [1] })).toBe(false);
  });

  it('CLI · assertions · tool-args · arguments that are not an object never match partial', async () => {
    const t = withCalls(COMPLETE, [
      { name: 'echo', args: 'not an object' },
      { name: 'echo', args: undefined },
    ]);
    expect((await run({ type: 'tool-args', tool: 'echo', args: {} }, t)).passed).toBe(false);
    expect(
      (await run({ type: 'tool-args', tool: 'echo', args: {}, match: 'exact' }, t)).passed,
    ).toBe(false);
  });

  it('CLI · assertions · tool-args · {{vars.x}} in an argument comes from the row, nested strings too', async () => {
    const t = withCalls(COMPLETE, [
      { name: 'echo', args: { path: 'a.txt', tags: ['a.txt'], o: { p: 'a.txt' } } },
    ]);
    const args = { path: '{{vars.file}}', tags: ['{{vars.file}}'], o: { p: '{{vars.file}}' } };
    expect(
      (await run({ type: 'tool-args', tool: 'echo', args }, t, { file: 'a.txt' })).passed,
    ).toBe(true);
    expect(
      (await run({ type: 'tool-args', tool: 'echo', args }, t, { file: 'b.txt' })).passed,
    ).toBe(false);
  });

  it('CLI · assertions · tool-args · min_count counts the matching calls only', async () => {
    const t = withCalls(COMPLETE, [
      { name: 'echo', args: { text: 'a' } },
      { name: 'echo', args: { text: 'b' } },
    ]);
    expect((await run({ type: 'tool-args', tool: 'echo', args: {}, min_count: 2 }, t)).passed).toBe(
      true,
    );
    const reason = await failed(
      { type: 'tool-args', tool: 'echo', args: { text: 'a' }, min_count: 2 },
      t,
    );
    expect(reason).toMatch(/at least 2 times; got 1 of 2 calls/);
  });
});

describe('CLI · assertions · tool-order', () => {
  const MIXED = withCalls(COMPLETE, [{ name: 'echo' }, { name: 'fail' }, { name: 'files/read' }]);

  it('CLI · assertions · tool-order · passes when the calls come in that order, others between them allowed', async () => {
    expect(await run({ type: 'tool-order', tools: ['echo', 'files/read'] }, COMPLETE)).toEqual({
      passed: true,
    });
    expect(await run({ type: 'tool-order', tools: ['echo', 'files/read'] }, MIXED)).toEqual({
      passed: true,
    });
  });

  it('CLI · assertions · tool-order · fails when the order is reversed', async () => {
    const reason = await failed({ type: 'tool-order', tools: ['files/read', 'echo'] }, COMPLETE);
    expect(reason).toMatch(/expected calls in the order files\/read → echo/);
    expect(reason).toMatch(/step 1 echo .*step 1 files\/read/);
  });

  it('CLI · assertions · tool-order · strict passes on exactly the list and fails on a call between', async () => {
    expect(
      await run({ type: 'tool-order', tools: ['echo', 'files/read'], strict: true }, COMPLETE),
    ).toEqual({ passed: true });
    const reason = await failed(
      { type: 'tool-order', tools: ['echo', 'files/read'], strict: true },
      MIXED,
    );
    expect(reason).toMatch(/exactly the calls echo → files\/read/);
    expect(reason).toMatch(/step 1 fail/);
  });

  it('CLI · assertions · tool-order · fails on no call at all', async () => {
    expect(await failed({ type: 'tool-order', tools: ['echo'] }, NO_CALLS)).toMatch(/no tool call/);
  });
});

describe('CLI · assertions · only-tools', () => {
  it('CLI · assertions · only-tools · passes when every call is on the list', async () => {
    expect(await run({ type: 'only-tools', tools: ['echo', 'files/read'] }, COMPLETE)).toEqual({
      passed: true,
    });
  });

  it('CLI · assertions · only-tools · fails on a call off the list, naming it', async () => {
    const reason = await failed({ type: 'only-tools', tools: ['echo'] }, COMPLETE);
    expect(reason).toMatch(/expected only echo called/);
    expect(reason).toMatch(/got step 1 files\/read/);
  });

  it('CLI · assertions · only-tools · an empty list means no call at all', async () => {
    expect(await run({ type: 'only-tools', tools: [] }, NO_CALLS)).toEqual({ passed: true });
    expect(await failed({ type: 'only-tools', tools: [] }, COMPLETE)).toMatch(
      /expected no tool call/,
    );
  });

  it('CLI · assertions · only-tools · on a loop stopped by a limit: nothing found is not measured, a finding fails (AC-3)', async () => {
    expect((await thrown({ type: 'only-tools', tools: ['echo'] }, MAX_STEPS)).code).toBe(
      'ASSERTION_UNMEASURED',
    );
    expect(await failed({ type: 'only-tools', tools: ['fail'] }, MAX_STEPS)).toMatch(/step 1 echo/);
  });
});

describe('CLI · assertions · tool-calls · a cut excerpt (#223)', () => {
  it('CLI · assertions · only-tools · a loop that ended on its own with a cut excerpt is measured on what the calls show', async () => {
    expect(CUT).toMatchObject({ stop: { reason: 'complete' }, collection: 'partial' });
    expect(await run({ type: 'only-tools', tools: ['big', 'echo'] }, CUT)).toEqual({
      passed: true,
    });
    expect(await failed({ type: 'only-tools', tools: ['echo'] }, CUT)).toMatch(/got step 1 big/);
    expect(await run({ type: 'tool-not-called', tool: 'files/read' }, CUT)).toEqual({
      passed: true,
    });
  });

  it('CLI · assertions · only-tools · a loop stopped by a limit stays unmeasured, a cut excerpt or not', async () => {
    const t = structuredClone(MAX_STEPS);
    t.steps[0]!.calls[0]!.result = { text: 'x', bytes: 1048576, truncated: true };
    const err = await thrown({ type: 'only-tools', tools: ['echo'] }, t);
    expect(err.code).toBe('ASSERTION_UNMEASURED');
    expect(err.message).toMatch(/stopped by max_steps/);
  });

  it('CLI · assertions · tool-calls · a check that reads answer texts stays unmeasured on a cut excerpt', () => {
    let err: unknown;
    try {
      absence('a-text-check', CUT, 'a forbidden word', 'text');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AssertionRunError);
    expect((err as AssertionRunError).code).toBe('ASSERTION_UNMEASURED');
    expect((err as AssertionRunError).message).toMatch(/a stored excerpt was cut/);
    expect(absence('a-text-check', COMPLETE, 'a forbidden word', 'text')).toEqual({ passed: true });
  });
});

describe('CLI · assertions · first-tool', () => {
  it('CLI · assertions · first-tool · passes when the first call is that tool', async () => {
    expect(await run({ type: 'first-tool', tool: 'echo' }, COMPLETE)).toEqual({ passed: true });
  });

  it('CLI · assertions · first-tool · fails when another tool came first', async () => {
    const reason = await failed({ type: 'first-tool', tool: 'files/read' }, COMPLETE);
    expect(reason).toMatch(/expected the first call to be "files\/read"; got step 1 echo/);
  });

  it('CLI · assertions · first-tool · no call at all is a failure that says so', async () => {
    expect(await failed({ type: 'first-tool', tool: 'echo' }, NO_CALLS)).toMatch(
      /got no tool call at all: the model answered without one/,
    );
  });
});

describe('CLI · assertions · no-tool-errors', () => {
  it('CLI · assertions · no-tool-errors · passes on a turn without errors', async () => {
    expect(await run({ type: 'no-tool-errors' }, COMPLETE)).toEqual({ passed: true });
    expect(await run({ type: 'no-tool-errors' }, NO_CALLS)).toEqual({ passed: true });
  });

  it('CLI · assertions · no-tool-errors · fails on an isError answer with its kind and step, never its text', async () => {
    const reason = await failed({ type: 'no-tool-errors' }, TOOL_ERROR);
    expect(reason).toMatch(/expected no tool call with an error; got step 1 fail \{\} \(content\)/);
  });

  it('CLI · assertions · no-tool-errors · a call that never ran (not offered, bad arguments) is an error too', async () => {
    const t = withCalls(COMPLETE, [
      { name: 'echo', executed: false, is_error: true, error_kind: 'bad-arguments' },
    ]);
    expect(await failed({ type: 'no-tool-errors' }, t)).toMatch(/\(bad-arguments\)/);
    const unkinded = withCalls(COMPLETE, [{ name: 'echo', is_error: true }]);
    expect(await failed({ type: 'no-tool-errors' }, unkinded)).toMatch(/\(error\)/);
  });

  it('CLI · assertions · no-tool-errors · tool narrows the calls looked at', async () => {
    expect(await run({ type: 'no-tool-errors', tool: 'echo' }, TOOL_ERROR)).toEqual({
      passed: true,
    });
    expect(await failed({ type: 'no-tool-errors', tool: 'fail' }, TOOL_ERROR)).toMatch(
      /step 1 fail/,
    );
  });

  it('CLI · assertions · no-tool-errors · on a loop stopped by a limit: nothing found is not measured, a finding fails (AC-3)', async () => {
    expect((await thrown({ type: 'no-tool-errors' }, MAX_STEPS)).code).toBe('ASSERTION_UNMEASURED');
    const t = structuredClone(MAX_STEPS);
    Object.assign(t.steps[0]!.calls[0]!, { is_error: true, error_kind: 'not-offered' });
    expect(await failed({ type: 'no-tool-errors' }, t)).toMatch(/not-offered/);
  });

  it('CLI · assertions · no-tool-errors · a cut excerpt on a loop that ended on its own is measured: the flags of the calls are all there (#223)', async () => {
    expect(await run({ type: 'no-tool-errors' }, CUT)).toEqual({ passed: true });
    const t = structuredClone(CUT);
    Object.assign(t.steps[0]!.calls[1]!, { is_error: true, error_kind: 'content' });
    expect(await failed({ type: 'no-tool-errors' }, t)).toMatch(/step 1 echo/);
  });
});

describe('CLI · assertions · tool-call-count', () => {
  it('CLI · assertions · tool-call-count · passes within min and max, both inclusive', async () => {
    expect(await run({ type: 'tool-call-count', min: 2, max: 2 }, COMPLETE)).toEqual({
      passed: true,
    });
    expect(await run({ type: 'tool-call-count', tool: 'echo', max: 1 }, COMPLETE)).toEqual({
      passed: true,
    });
  });

  it('CLI · assertions · tool-call-count · fails above max and below min, with the calls', async () => {
    const above = await failed({ type: 'tool-call-count', max: 1 }, COMPLETE);
    expect(above).toMatch(/expected at most 1 call; got 2: step 1 echo/);
    const below = await failed({ type: 'tool-call-count', tool: 'echo', min: 2 }, COMPLETE);
    expect(below).toMatch(/expected at least 2 calls to "echo"; got 1/);
    const range = await failed({ type: 'tool-call-count', min: 3, max: 4 }, COMPLETE);
    expect(range).toMatch(/expected 3 to 4 calls; got 2/);
  });
});

describe('CLI · assertions · no-repeated-call', () => {
  it('CLI · assertions · no-repeated-call · passes when no call repeats the one before it', async () => {
    expect(await run({ type: 'no-repeated-call' }, COMPLETE)).toEqual({ passed: true });
  });

  it('CLI · assertions · no-repeated-call · fails on the same name and arguments twice in a row', async () => {
    const t = withCalls(COMPLETE, [
      { name: 'echo', args: { text: 'hi', n: 1 } },
      { name: 'echo', args: { n: 1, text: 'hi' } },
    ]);
    const reason = await failed({ type: 'no-repeated-call' }, t);
    expect(reason).toMatch(
      /expected no call repeated right after itself; got step 1 echo .* then step 1 echo/,
    );
  });

  it('CLI · assertions · no-repeated-call · only a cursor changed, or a real argument changed: not a repeat (AC-7)', async () => {
    const cursor = withCalls(COMPLETE, [
      { name: 'echo', args: { text: 'hi' } },
      { name: 'echo', args: { text: 'hi', cursor: 'p2' } },
    ]);
    const changed = withCalls(COMPLETE, [
      { name: 'echo', args: { text: 'hi' } },
      { name: 'echo', args: { text: 'ho' } },
    ]);
    expect(await run({ type: 'no-repeated-call' }, cursor)).toEqual({ passed: true });
    expect(await run({ type: 'no-repeated-call' }, changed)).toEqual({ passed: true });
  });

  it('CLI · assertions · no-repeated-call · tool narrows it; a repeat of another tool is not counted', async () => {
    const t = withCalls(COMPLETE, [{ name: 'echo' }, { name: 'echo' }]);
    expect(await run({ type: 'no-repeated-call', tool: 'files/read' }, t)).toEqual({
      passed: true,
    });
    expect((await run({ type: 'no-repeated-call', tool: 'echo' }, t)).passed).toBe(false);
  });
});

describe('CLI · assertions · token-budget', () => {
  it('CLI · assertions · token-budget · passes at the budget (input + output over every step)', async () => {
    expect(await run({ type: 'token-budget', max: 30 }, COMPLETE)).toEqual({ passed: true });
  });

  it('CLI · assertions · token-budget · fails above it, with every step', async () => {
    const reason = await failed({ type: 'token-budget', max: 29 }, COMPLETE);
    expect(reason).toMatch(/expected at most 29 tokens .*; got 30 \(step 1: 15, step 2: 15\)/);
  });

  it('CLI · assertions · token-budget · no step, no tokens: not measured (AC-5)', async () => {
    const t = structuredClone(COMPLETE);
    t.steps = [];
    const err = await thrown({ type: 'token-budget', max: 1000 }, t);
    expect(err.code).toBe('ASSERTION_UNMEASURED');
    expect(err.message).toMatch(/token-budget: not measured/);
  });
});

describe('CLI · assertions · tool-latency', () => {
  it('CLI · assertions · tool-latency · passes when every call is within max_ms', async () => {
    expect(await run({ type: 'tool-latency', max_ms: 10_000 }, COMPLETE)).toEqual({ passed: true });
  });

  it('CLI · assertions · tool-latency · fails on a slow call, with its step and time', async () => {
    const t = withCalls(COMPLETE, [
      { name: 'echo', duration_ms: 5 },
      { name: 'files/read', duration_ms: 900 },
    ]);
    const reason = await failed({ type: 'tool-latency', max_ms: 500 }, t);
    expect(reason).toMatch(
      /expected every call within 500 ms; got step 1 files\/read \{\}: 900 ms/,
    );
    expect(await run({ type: 'tool-latency', max_ms: 500, tool: 'echo' }, t)).toEqual({
      passed: true,
    });
  });

  it('CLI · assertions · tool-latency · a call without its time, or no call that ran: not measured (AC-5)', async () => {
    const untimed = withCalls(COMPLETE, [{ name: 'echo', duration_ms: undefined }]);
    expect((await thrown({ type: 'tool-latency', max_ms: 500 }, untimed)).code).toBe(
      'ASSERTION_UNMEASURED',
    );
    expect((await thrown({ type: 'tool-latency', max_ms: 500 }, NO_CALLS)).message).toMatch(
      /no call ran/,
    );
    // A slow call found among them still fails.
    const mixed = withCalls(COMPLETE, [
      { name: 'echo', duration_ms: undefined },
      { name: 'echo', duration_ms: 900 },
    ]);
    expect((await run({ type: 'tool-latency', max_ms: 500 }, mixed)).passed).toBe(false);
  });
});

describe('CLI · assertions · tool-result-size', () => {
  it('CLI · assertions · tool-result-size · passes within max_bytes', async () => {
    expect(await run({ type: 'tool-result-size', max_bytes: 2_000_000 }, CUT)).toEqual({
      passed: true,
    });
  });

  it('CLI · assertions · tool-result-size · measures the result before the cut: a 4 KiB excerpt of 1 MiB still fails (AC-6)', async () => {
    const reason = await failed({ type: 'tool-result-size', max_bytes: 100_000, tool: 'big' }, CUT);
    expect(reason).toMatch(
      /expected every result of "big" at most 100000 bytes; got step 1 big \{\}: 1048576 bytes/,
    );
  });

  it('CLI · assertions · tool-result-size · a call that ran without a result, or no call: not measured (AC-5)', async () => {
    const t = withCalls(COMPLETE, [{ name: 'echo', result: undefined }]);
    expect((await thrown({ type: 'tool-result-size', max_bytes: 10 }, t)).code).toBe(
      'ASSERTION_UNMEASURED',
    );
    expect((await thrown({ type: 'tool-result-size', max_bytes: 10 }, NO_CALLS)).code).toBe(
      'ASSERTION_UNMEASURED',
    );
  });
});

describe('CLI · assertions · tool-result-schema', () => {
  const SCHEMA = { type: 'object', required: ['n'], properties: { n: { type: 'number' } } };

  it('CLI · assertions · tool-result-schema · passes when the result text parses as JSON that fits the schema', async () => {
    expect(await run({ type: 'tool-result-schema', tool: 'echo', schema: SCHEMA }, CUT)).toEqual({
      passed: true,
    });
  });

  it('CLI · assertions · tool-result-schema · fails on a result that is not JSON, without quoting it', async () => {
    const reason = await failed(
      { type: 'tool-result-schema', tool: 'files/read', schema: SCHEMA },
      COMPLETE,
    );
    expect(reason).toMatch(
      /expected every result of "files\/read" to fit the schema; got step 1 files\/read .*: not JSON/,
    );
  });

  it('CLI · assertions · tool-result-schema · fails on JSON that does not fit, with the schema error', async () => {
    const t = withCalls(COMPLETE, [
      { name: 'echo', result: { text: '{"n":"one"}', bytes: 11, truncated: false } },
    ]);
    expect(await failed({ type: 'tool-result-schema', schema: SCHEMA }, t)).toMatch(
      /\/n must be number/,
    );
  });

  it('CLI · assertions · tool-result-schema · a schema that does not compile fails and says so', async () => {
    expect(await failed({ type: 'tool-result-schema', schema: { type: 'nope' } }, CUT)).toMatch(
      /invalid schema/,
    );
  });

  it('CLI · assertions · tool-result-schema · a cut result, or no result at all: not measured; error answers are left out', async () => {
    expect(
      (await thrown({ type: 'tool-result-schema', tool: 'big', schema: SCHEMA }, CUT)).message,
    ).toMatch(/cut to its excerpt/);
    expect(
      (await thrown({ type: 'tool-result-schema', schema: SCHEMA }, TOOL_ERROR)).message,
    ).toMatch(/no result to check/);
    const unanswered = withCalls(COMPLETE, [{ name: 'echo', result: undefined }]);
    expect((await thrown({ type: 'tool-result-schema', schema: SCHEMA }, unanswered)).code).toBe(
      'ASSERTION_UNMEASURED',
    );
  });
});

describe('CLI · assertions · no-destructive-tool', () => {
  it('CLI · assertions · no-destructive-tool · readOnlyHint: true passes (AC-10)', async () => {
    expect(await run({ type: 'no-destructive-tool' }, COMPLETE)).toEqual({ passed: true });
  });

  it('CLI · assertions · no-destructive-tool · a tool without annotations fails and says the hints are missing (AC-10)', async () => {
    const reason = await failed({ type: 'no-destructive-tool' }, TOOL_ERROR);
    expect(reason).toMatch(/got step 1 fail \{\}: "fail" declares no annotations/);
    expect(reason).toMatch(/missing hint as possibly destructive/);
  });

  it('CLI · assertions · no-destructive-tool · destructiveHint: false passes, destructiveHint: true fails', async () => {
    const hinted = (annotations: Record<string, unknown>) => {
      const t = structuredClone(TOOL_ERROR);
      t.tools.find((tool) => tool.name === 'fail')!.annotations = annotations;
      return t;
    };
    expect(await run({ type: 'no-destructive-tool' }, hinted({ destructiveHint: false }))).toEqual({
      passed: true,
    });
    expect(
      await failed({ type: 'no-destructive-tool' }, hinted({ destructiveHint: true })),
    ).toMatch(/declares destructiveHint: true/);
    expect(await failed({ type: 'no-destructive-tool' }, hinted({ readOnlyHint: false }))).toMatch(
      /neither readOnlyHint: true nor destructiveHint: false/,
    );
  });

  it('CLI · assertions · no-destructive-tool · a name the server never listed was not run there and is skipped', async () => {
    const t = withCalls(COMPLETE, [
      { name: 'made_up', executed: false, is_error: true, error_kind: 'not-offered' },
    ]);
    expect(await run({ type: 'no-destructive-tool' }, t)).toEqual({ passed: true });
  });

  it('CLI · assertions · no-destructive-tool · no tool list, or a partial transcript with nothing found: not measured (AC-3)', async () => {
    const unlisted = structuredClone(COMPLETE);
    unlisted.tools = [];
    expect((await thrown({ type: 'no-destructive-tool' }, unlisted)).message).toMatch(
      /no tools\/list/,
    );
    expect((await thrown({ type: 'no-destructive-tool' }, MAX_STEPS)).code).toBe(
      'ASSERTION_UNMEASURED',
    );
    const risky = structuredClone(MAX_STEPS);
    risky.steps[0]!.calls[0]!.name = 'fail';
    expect(await failed({ type: 'no-destructive-tool' }, risky)).toMatch(/declares no annotations/);
  });
});

describe('CLI · assertions · tool-calls · failure text', () => {
  it('CLI · assertions · tool-calls · long arguments are cut and secrets in them masked; many calls are counted, not listed', async () => {
    const calls = Array.from({ length: 8 }, (_, i) => ({
      name: 'echo',
      args: { text: `Bearer abcdef0123456789 ${'y'.repeat(200)} ${i}` },
    }));
    const reason = await failed(
      { type: 'tool-not-called', tool: 'echo' },
      withCalls(COMPLETE, calls),
    );
    expect(reason).not.toContain('abcdef0123456789');
    expect(reason).toContain('Bearer [REDACTED]');
    expect(reason).not.toContain('y'.repeat(200));
    expect(reason).toMatch(/got 8 calls: .* \(and 3 more\)/);
  });
});
