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

describe('readCairnRun — api runs', () => {
  it('reads the cases and attaches the verdict each one actually produced', async () => {
    const payload = await readCairnRun(fixture('api'));
    expect(payload.run.mode).toBe('api');
    expect(payload.cases).toHaveLength(26);
    expect(payload.cases.every((c) => c.verdict !== undefined)).toBe(true);
    // The real Petstore run passed 8 of 26 — the verdicts are read, not assumed.
    expect(payload.cases.filter((c) => c.verdict === 'passed')).toHaveLength(8);
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
