import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  readCairnRun,
  CairnRunNotFoundError,
  CairnRunPartialError,
  CairnRunVersionError,
  CairnEvidenceAmbiguousError,
} from '../commands/cairn-artifact.js';

/**
 * Every fixture here is a REAL Cairn run directory, captured on 30–31 July 2026, not a hand-written
 * approximation. An invented artifact tests our idea of the format; these test the format.
 *
 *   design/   — `cairn design` over plune.ai (Cairn 0.7.0): 29 cases, no verdicts, nothing executed
 *   api/      — `cairn api` over the public Swagger Petstore: 26 cases, executed, verdicts in a
 *               separate evidence file
 *   partial/  — a run that failed before it reached the model (unreachable host, cost $0.00)
 *   legacy/   — a run from BEFORE Cairn versioned its artifact: no version, no kind
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string => path.join(here, 'fixtures', 'cairn', name);

describe('readCairnRun — design runs', () => {
  it('reads the cases and says which run they came from', async () => {
    const payload = await readCairnRun(fixture('design'));
    expect(payload.run.mode).toBe('design');
    expect(payload.run.target).toBe('https://plune.ai');
    expect(payload.cases).toHaveLength(29);
  });

  it('sends the run cost the report states, so a proposal does not read «cost not named»', async () => {
    const payload = await readCairnRun(fixture('design'));
    expect(payload.run.cost).toEqual({ tokens: 9987, cases: 29 });
  });

  it('sends no cost when the report counted none, rather than a zero', async () => {
    const payload = await readCairnRun(fixture('api'));
    expect(payload.run).not.toHaveProperty('cost');
  });

  it('carries the identity that makes dedup possible', async () => {
    const payload = await readCairnRun(fixture('design'));
    for (const c of payload.cases) expect(c.stableId).toMatch(/^[0-9a-f]{12}$/);
    expect(new Set(payload.cases.map((c) => c.stableId)).size).toBe(payload.cases.length);
  });

  // A design run writes cases and executes nothing, so no case may claim a verdict. Synthesising one
  // would turn "never ran" into "ran and passed" at the very first boundary the data crosses.
  it('gives no case a verdict, because nothing was executed', async () => {
    const payload = await readCairnRun(fixture('design'));
    expect(payload.cases.every((c) => c.verdict === undefined)).toBe(true);
  });

  // FR-7: manual cases were 8 of 41 in a real run — a quarter of the value would vanish if the reader
  // quietly kept only the automatable ones.
  it('keeps manual cases alongside automatable ones', async () => {
    const payload = await readCairnRun(fixture('design'));
    const kinds = new Set(payload.cases.map((c) => c.execution));
    expect(kinds).toContain('manual');
    expect(kinds).toContain('auto');
  });

  it('keeps every case readable — a title, steps and an expected result', async () => {
    const payload = await readCairnRun(fixture('design'));
    for (const c of payload.cases) {
      expect(c.title.length).toBeGreaterThan(0);
      expect(c.steps.length).toBeGreaterThan(0);
      expect(c.expected.length).toBeGreaterThan(0);
    }
  });
});

const TRACE = 'https://trace.example.com/project/p1/traces/t1';

/** The real design run, with `traceUrl` set on every case as Cairn writes it, under the given mode. */
async function runWithTrace(traceUrl: unknown, mode: 'design' | 'explore' = 'design'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cairn-trace-'));
  const report = JSON.parse(await fs.readFile(path.join(fixture('design'), 'report.json'), 'utf8')) as {
    mode: string;
    testCases: Record<string, unknown>[];
  };
  report.mode = mode;
  report.testCases = report.testCases.map((c) => ({ ...c, traceUrl }));
  await fs.writeFile(path.join(dir, 'report.json'), JSON.stringify(report), 'utf8');
  return dir;
}

describe('readCairnRun — the trace link of a case', () => {
  it('CLI · ingest · design run · gives each case the trace link its report carries', async () => {
    const dir = await runWithTrace(TRACE);
    const notes: string[] = [];
    const payload = await readCairnRun(dir, { notes });
    expect(payload.cases).toHaveLength(29);
    expect(payload.cases.every((c) => c.traceUrl === TRACE)).toBe(true);
    expect(notes).toEqual([]);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('CLI · ingest · explore run · gives each case the trace link its report carries', async () => {
    const dir = await runWithTrace(TRACE, 'explore');
    const payload = await readCairnRun(dir);
    expect(payload.run.mode).toBe('explore');
    expect(payload.cases.every((c) => c.traceUrl === TRACE)).toBe(true);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('CLI · ingest · a report without the link gives cases without the key, not a null or an empty text', async () => {
    const payload = await readCairnRun(fixture('design'));
    for (const c of payload.cases) expect(c).not.toHaveProperty('traceUrl');
    const empty = await runWithTrace('');
    for (const c of (await readCairnRun(empty)).cases) expect(c).not.toHaveProperty('traceUrl');
    await fs.rm(empty, { recursive: true, force: true });
  });

  // The platform refuses such a link with a 400 for the whole run: here it costs the link alone.
  it.each([
    ['an http address', 'http://trace.example.com/project/p1/traces/t1?key=k-123', /https/],
    ['an address with a user name and password', 'https://user:pw-123@trace.example.com/project/p1/traces/t1', /user name or password/],
    ['an over-long address', `${TRACE}/${'a'.repeat(2048)}`, /longer than 2048/],
  ])('CLI · ingest · %s is left out, the case is still sent, and it is said once', async (_name, link, why) => {
    const dir = await runWithTrace(link);
    const notes: string[] = [];
    const payload = await readCairnRun(dir, { notes });
    expect(payload.cases).toHaveLength(29);
    for (const c of payload.cases) expect(c).not.toHaveProperty('traceUrl');
    // Every case carries the same refused link: one line for the reason, one for how many more, never the address.
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatch(/trace link not sent/);
    expect(notes[0]).toMatch(why);
    expect(notes[1]).toMatch(/28 more case\(s\)/);
    expect(notes.join('\n')).not.toMatch(/trace\.example\.com|k-123|pw-123/);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

/**
 * fixtures/cairn/failure-variants is what `cairn propose-failures` wrote for one eval and a stub file recorded with
 * `plune mock --record`: a `design` run whose cases are variants of the eval under a provider failure. Each case says
 * why it exists in `rationale`, and the review queue shows that text when the proposal is opened.
 */
describe('readCairnRun — the reason a case gives for itself', () => {
  it('CLI · ingest · design run · sends the rationale of a case, and the eval it is a variant of stays in the text', async () => {
    const payload = await readCairnRun(fixture('failure-variants'));
    expect(payload.run).toMatchObject({ mode: 'design', target: 'plune.yaml', cost: { tokens: 0, cases: 5 } });
    expect(payload.cases).toHaveLength(5);
    for (const c of payload.cases) {
      expect(c.title).toContain('Eval "refund-answer"');
      expect(c.rationale).toMatch(/^Variant of eval "refund-answer": /);
      expect(c.technique).toBe('provider-failure');
      expect(c.verdict).toBeUndefined();
    }
  });

  it('CLI · ingest · a report without a rationale gives cases without the key', async () => {
    for (const c of (await readCairnRun(fixture('design'))).cases) expect(c).not.toHaveProperty('rationale');
  });

  /** The failure-variants run with the rationale of its first cases replaced, in a folder of its own. */
  const runWithRationale = async (...rationales: unknown[]): Promise<string> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'plune-rationale-'));
    const report = JSON.parse(await fs.readFile(path.join(fixture('failure-variants'), 'report.json'), 'utf8')) as {
      testCases: Record<string, unknown>[];
    };
    rationales.forEach((r, i) => (report.testCases[i]!['rationale'] = r));
    await fs.writeFile(path.join(dir, 'report.json'), JSON.stringify(report));
    return dir;
  };

  it.each([
    ['an empty text', '   '],
    ['a value that is not a text', 7],
  ])('CLI · ingest · %s as the rationale is left out, the case is still sent, and nothing is said', async (_name, rationale) => {
    const dir = await runWithRationale(rationale);
    const notes: string[] = [];
    const payload = await readCairnRun(dir, { notes });
    expect(payload.cases).toHaveLength(5);
    expect(payload.cases[0]).not.toHaveProperty('rationale');
    expect(notes).toEqual([]);
    await fs.rm(dir, { recursive: true, force: true });
  });

  // The platform takes at most 400 characters and refuses the whole run for one more: a cut text serves the reviewer
  // better than none, and the cut is said.
  it('CLI · ingest · a rationale of 400 characters is sent whole, one of 401 is cut to 400, and the cut is said once', async () => {
    const dir = await runWithRationale(`  ${'b'.repeat(400)}  `, 'c'.repeat(401), 'd'.repeat(2000));
    const notes: string[] = [];
    const payload = await readCairnRun(dir, { notes });
    expect(payload.cases[0]!.rationale).toBe('b'.repeat(400));
    expect(payload.cases[1]!.rationale).toBe('c'.repeat(400));
    expect(payload.cases[2]!.rationale).toBe('d'.repeat(400));
    expect(notes).toEqual(['plune: 2 case(s) carry an explanation over 400 characters — sent cut to 400.']);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('CLI · ingest · a rationale of 400 characters or fewer says nothing', async () => {
    const notes: string[] = [];
    await readCairnRun(fixture('failure-variants'), { notes });
    expect(notes).toEqual([]);
  });

  it('CLI · ingest · the cut does not leave half of a character at the end', async () => {
    const dir = await runWithRationale(`${'e'.repeat(399)}😀 and more`);
    const payload = await readCairnRun(dir);
    expect(payload.cases[0]!.rationale).toBe('e'.repeat(399));
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('CLI · ingest · mcp run · a proposed agent scenario carries its rationale too', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'plune-rationale-'));
    const report = JSON.parse(await fs.readFile(path.join(fixture('mcp'), 'scenarios', 'report.json'), 'utf8')) as {
      testCases: Record<string, unknown>[];
    };
    report.testCases[0]!['rationale'] = 'The server has one search tool, so a search request should reach it.';
    await fs.writeFile(path.join(dir, 'report.json'), JSON.stringify(report));
    const payload = await readCairnRun(dir);
    expect(payload.run.mode).toBe('mcp');
    expect(payload.cases[0]!.rationale).toBe('The server has one search tool, so a search request should reach it.');
    expect(payload.cases[1]).not.toHaveProperty('rationale');
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('readCairnRun — api runs', () => {
  it('reads the cases and attaches the verdict each one actually produced', async () => {
    const payload = await readCairnRun(fixture('api'));
    expect(payload.run.mode).toBe('api');
    expect(payload.cases).toHaveLength(26);
    expect(payload.cases.every((c) => c.verdict !== undefined)).toBe(true);
    // The real Petstore run passed 8 of 26 — the verdicts are read, not assumed.
    expect(payload.cases.filter((c) => c.verdict === 'passed')).toHaveLength(8);
  });

  // Cairn writes `error` when a request got no response after the retries; the product never
  // answered, so the case is `blocked`, not `failed`. Read through the real file reader, not an injected one.
  it('sends a case whose request got no answer as blocked, not failed', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cairn-api-'));
    await fs.copyFile(path.join(fixture('api'), 'report.json'), path.join(dir, 'report.json'));
    const evidence = JSON.parse(await fs.readFile(path.join(fixture('api'), 'api-evidence.json'), 'utf8')) as {
      name: string;
      passed: boolean;
      error?: string;
      response?: unknown;
    }[];
    const unreachable = evidence.find((e) => !e.passed)!;
    unreachable.error = 'fetch failed: connect ECONNREFUSED 127.0.0.1:8080';
    delete unreachable.response;
    await fs.writeFile(path.join(dir, 'api-evidence.json'), JSON.stringify(evidence), 'utf8');

    const payload = await readCairnRun(dir);
    expect(payload.cases.find((c) => c.title === unreachable.name)?.verdict).toBe('blocked');
    expect(payload.cases.filter((c) => c.verdict === 'blocked')).toHaveLength(1);
    expect(payload.cases.filter((c) => c.verdict === 'passed')).toHaveLength(8);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('states each case in our vocabulary — the request as a step, the status as the expectation', async () => {
    const payload = await readCairnRun(fixture('api'));
    const first = payload.cases[0];
    expect(first?.steps[0]).toMatch(/^(GET|POST|PUT|DELETE|PATCH) \//);
    expect(first?.expected).toMatch(/\d{3}|default/);
  });
});

describe('readCairnRun — refuses rather than guesses', () => {
  // AC-1. A version we do not know means a shape we do not know; parsing it anyway writes
  // plausible-looking wrong data, which is worse than not writing at all.
  it('refuses an artifact from before Cairn versioned its format, and says so', async () => {
    await expect(readCairnRun(fixture('legacy'))).rejects.toThrow(CairnRunVersionError);
    await expect(readCairnRun(fixture('legacy'))).rejects.toThrow(/0\.7\.0/);
  });

  it('refuses a run that did not finish, instead of ingesting a fragment as if it were whole', async () => {
    await expect(readCairnRun(fixture('partial'))).rejects.toThrow(CairnRunPartialError);
  });

  it('says which directory it could not find', async () => {
    await expect(readCairnRun(fixture('nope'))).rejects.toThrow(CairnRunNotFoundError);
  });
});

describe('readCairnRun — the join it is not allowed to guess', () => {
  // ADR-CI-02: the evidence file carries no identity, so it joins to cases by operation name. That
  // name was unique in every run we checked, but nothing in the contract guarantees it. Mis-joining
  // would attach one case's verdict to another and look like corrupted data weeks later.
  it('refuses to attach verdicts when two cases share an operation name', async () => {
    await expect(
      readCairnRun(fixture('api'), {
        readEvidence: async () => [
          { name: 'updatePet', passed: true },
          { name: 'updatePet', passed: false },
        ],
      }),
    ).rejects.toThrow(CairnEvidenceAmbiguousError);
  });

  // Without --base-url Cairn executes nothing and writes no evidence file. That is a design run's
  // situation, not an error: the cases are still worth recording.
  it('reads an api run with no evidence file as cases without verdicts', async () => {
    const payload = await readCairnRun(fixture('api'), { readEvidence: async () => undefined });
    expect(payload.cases).toHaveLength(26);
    expect(payload.cases.every((c) => c.verdict === undefined)).toBe(true);
  });
});
