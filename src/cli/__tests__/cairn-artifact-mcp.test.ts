import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readCairnRun,
  CairnArtifactShapeError,
  CairnRunVersionError,
  type CairnIngestCase,
} from '../commands/cairn-artifact.js';

/**
 * The fixtures are REAL runs of `cairn mcp-test` (see fixtures/cairn/mcp/README.md), not hand-written
 * approximations. The cases that need a damaged or hostile file are built from them in a temp directory.
 *
 *   mcp/judged/   passed, failed, needs-review and not-sent cases
 *   mcp/stopped/  passed, could-not-run (sent and never sent) and not-sent cases
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string => path.join(here, 'fixtures', 'cairn', 'mcp', name);

interface ReportCase {
  name: string;
  stableId: string;
  tool: string;
  type: string;
  technique?: string;
  state: string;
}
const readJson = async <T>(file: string): Promise<T> =>
  JSON.parse(await fs.readFile(file, 'utf8')) as T;

const temps: string[] = [];
afterEach(async () => {
  for (const d of temps.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

/** A copy of a fixture that a test may damage. */
async function copyOf(
  name: string,
): Promise<{ dir: string; report: Record<string, unknown>; evidence: Record<string, unknown>[] }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'plune-mcp-run-'));
  temps.push(dir);
  const report = await readJson<Record<string, unknown>>(path.join(fixture(name), 'report.json'));
  const evidence = await readJson<Record<string, unknown>[]>(
    path.join(fixture(name), 'mcp-evidence.json'),
  );
  return { dir, report, evidence };
}
async function save(c: { dir: string; report: unknown; evidence?: unknown }): Promise<string> {
  await fs.writeFile(path.join(c.dir, 'report.json'), JSON.stringify(c.report));
  if (c.evidence !== undefined)
    await fs.writeFile(path.join(c.dir, 'mcp-evidence.json'), JSON.stringify(c.evidence));
  return c.dir;
}
const rejection = async (p: Promise<unknown>): Promise<Error> => {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected the read to be refused');
};

describe('CLI · ingest · mcp run · reading a real run', () => {
  it('reads every case of report.json, in order, with its stable id and the run it came from', async () => {
    const report = await readJson<{ cases: ReportCase[] }>(
      path.join(fixture('judged'), 'report.json'),
    );
    const payload = await readCairnRun(fixture('judged'));
    expect(payload.run.mode).toBe('mcp');
    expect(payload.run.runId).toBe('f7');
    expect(payload.run.target).toBe('node');
    expect(payload.cases).toHaveLength(report.cases.length);
    expect(payload.cases.map((c) => c.stableId)).toEqual(report.cases.map((c) => c.stableId));
    expect(payload.cases.map((c) => c.title)).toEqual(report.cases.map((c) => c.name));
  });

  it('maps passed to passed and failed to failed, and leaves not-sent and needs-review without a verdict', async () => {
    const report = await readJson<{ cases: ReportCase[] }>(
      path.join(fixture('judged'), 'report.json'),
    );
    const payload = await readCairnRun(fixture('judged'));
    const expected = new Map<string, CairnIngestCase['verdict']>([
      ['passed', 'passed'],
      ['failed', 'failed'],
      ['not-sent', undefined],
      ['needs-review', undefined],
    ]);
    report.cases.forEach((c, i) => {
      expect(payload.cases[i]?.verdict, `${c.name} (${c.state})`).toBe(expected.get(c.state));
    });
    const count = (v: string | undefined): number =>
      payload.cases.filter((c) => c.verdict === v).length;
    expect([count('passed'), count('failed'), count(undefined)]).toEqual([2, 3, 49]);
  });

  it('sends a case whose call got no answer as blocked, and a could-not-run case that was never sent with no verdict', async () => {
    const report = await readJson<{ cases: ReportCase[] }>(
      path.join(fixture('stopped'), 'report.json'),
    );
    const evidence = await readJson<{ stableId: string; durationMs?: number }[]>(
      path.join(fixture('stopped'), 'mcp-evidence.json'),
    );
    const sent = new Set(
      evidence.filter((e) => typeof e.durationMs === 'number').map((e) => e.stableId),
    );
    const payload = await readCairnRun(fixture('stopped'));
    const states = report.cases.filter((c) => c.state === 'could-not-run');
    expect(states).toHaveLength(9);
    report.cases.forEach((c, i) => {
      const want =
        c.state === 'passed'
          ? 'passed'
          : c.state === 'could-not-run' && sent.has(c.stableId)
            ? 'blocked'
            : undefined;
      expect(payload.cases[i]?.verdict, `${c.name} (${c.state})`).toBe(want);
    });
    expect(payload.cases.filter((c) => c.verdict === 'blocked')).toHaveLength(3);
  });

  it('states a case as a tools/call step with its masked arguments and an expectation in plain words', async () => {
    const payload = await readCairnRun(fixture('judged'));
    const valid = payload.cases.find((c) => c.title === 'echo · valid · required');
    expect(valid).toMatchObject({
      execution: 'auto',
      steps: ['tools/call echo {"q":"a"}'],
      technique: 'equivalence-partitioning',
    });
    expect(valid?.expected).toMatch(/finishes without an error/);
    const wrong = payload.cases.find((c) => c.title === 'echo · wrong-type · q');
    expect(wrong?.steps).toEqual(['tools/call echo {"q":12345}']);
    expect(wrong?.expected).toMatch(/server rejects the call/);
    expect(wrong?.technique).toBe('error-guessing');
  });

  it('keeps a case that was never sent readable: the tool, and no invented arguments', async () => {
    const payload = await readCairnRun(fixture('judged'));
    const unsent = payload.cases.find((c) => c.title.startsWith('crash · valid'));
    expect(unsent?.steps).toEqual(['tools/call crash']);
    expect(unsent?.verdict).toBeUndefined();
  });

  it('reads a run with no evidence file as cases without verdicts for what was never sent', async () => {
    const c = await copyOf('judged');
    await save({ dir: c.dir, report: c.report });
    const payload = await readCairnRun(c.dir);
    expect(payload.cases).toHaveLength(54);
    // The state lives in report.json too: a judged case keeps its verdict; the call text is what is missing.
    expect(payload.cases.filter((x) => x.verdict !== undefined)).toHaveLength(5);
    expect(
      payload.cases.every((x) => x.steps.length === 1 && x.steps[0]?.startsWith('tools/call ')),
    ).toBe(true);
  });
});

describe('CLI · ingest · mcp run · arguments in steps', () => {
  const evidenceWith = (c: { evidence: Record<string, unknown>[] }, request: string): void => {
    const e = c.evidence.find((x) => x['name'] === 'echo · valid · required');
    if (e === undefined) throw new Error('fixture changed');
    e['request'] = request;
  };

  it('masks a token that straddles the cut, instead of cutting first and leaving its head', async () => {
    const c = await copyOf('judged');
    const token = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
    // The token starts a few characters before the cut, so a cut-then-mask would keep "ghp_A1b2…".
    evidenceWith(c, JSON.stringify({ note: `${'x'.repeat(170)}${token}`, tail: 'y'.repeat(60) }));
    const payload = await readCairnRun(await save(c));
    const step = payload.cases.find((x) => x.title === 'echo · valid · required')?.steps[0] ?? '';
    expect(step).not.toContain('ghp_');
    expect(step).not.toContain('A1b2C3');
    expect(step.startsWith('tools/call echo ')).toBe(true);
  });

  it('masks the value of an argument whose name says it is a credential', async () => {
    const c = await copyOf('judged');
    evidenceWith(
      c,
      JSON.stringify({ q: 'a', password: 'hunter2-hunter2', apiKey: 'plain-value-123' }),
    );
    const payload = await readCairnRun(await save(c));
    const step = payload.cases.find((x) => x.title === 'echo · valid · required')?.steps[0] ?? '';
    expect(step).not.toContain('hunter2');
    expect(step).not.toContain('plain-value-123');
    expect(step).toContain('"q":"a"');
  });

  it('bounds the arguments and marks the cut, however long the request text is', async () => {
    const c = await copyOf('judged');
    evidenceWith(c, JSON.stringify({ q: 'z'.repeat(5000) }));
    const payload = await readCairnRun(await save(c));
    const step = payload.cases.find((x) => x.title === 'echo · valid · required')?.steps[0] ?? '';
    expect(step.length).toBeLessThan(260);
    expect(step.endsWith(' (cut)')).toBe(true);
  });

  it('keeps an escape sequence, a line break and a workflow command out of the text of a step', async () => {
    const c = await copyOf('judged');
    evidenceWith(c, '{"q":"\u001b[31m::error::boom\\n##[warning]x"}');
    const payload = await readCairnRun(await save(c));
    const step = payload.cases.find((x) => x.title === 'echo · valid · required')?.steps[0] ?? '';
    expect(step).not.toContain('\u001b');
    expect(step).not.toContain('##[');
    expect(step).not.toMatch(/[\r\n]/);
  });
});

describe('CLI · ingest · mcp run · refuses rather than guesses', () => {
  it('refuses a case state it does not know, naming the file and the field, and prints nothing raw', async () => {
    const c = await copyOf('judged');
    const cases = c.report['cases'] as Record<string, unknown>[];
    cases[3]!['state'] = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij12\u001b[31m';
    const err = await rejection(readCairnRun(await save(c)));
    expect(err).toBeInstanceOf(CairnArtifactShapeError);
    expect(err.message).toContain('report.json');
    expect(err.message).toContain('cases[3].state');
    expect(err.message).not.toContain('ghp_ABCDEF');
    expect(err.message).not.toContain('\u001b');
    expect(err.message).toMatch(/Nothing was uploaded/);
  });

  it('still refuses a run mode it does not know, by name', async () => {
    const c = await copyOf('judged');
    c.report['mode'] = 'mcp-future';
    const err = await rejection(readCairnRun(await save(c)));
    expect(err).toBeInstanceOf(CairnRunVersionError);
    expect(err.message).toContain('unknown run mode mcp-future');
  });

  it.each([
    [
      'cases is not a list',
      (r: Record<string, unknown>) => {
        r['cases'] = {};
      },
      'cases',
    ],
    [
      'a case is not an object',
      (r: Record<string, unknown>) => {
        (r['cases'] as unknown[])[1] = 'x';
      },
      'cases[1]',
    ],
    [
      'a case has no stableId',
      (r: Record<string, unknown>) => {
        delete (r['cases'] as Record<string, unknown>[])[2]!['stableId'];
      },
      'cases[2].stableId',
    ],
    [
      'a case has no name',
      (r: Record<string, unknown>) => {
        (r['cases'] as Record<string, unknown>[])[2]!['name'] = '';
      },
      'cases[2].name',
    ],
    [
      'a case has no tool',
      (r: Record<string, unknown>) => {
        (r['cases'] as Record<string, unknown>[])[0]!['tool'] = 7;
      },
      'cases[0].tool',
    ],
    [
      'a case has an unknown type',
      (r: Record<string, unknown>) => {
        (r['cases'] as Record<string, unknown>[])[4]!['type'] = 'Maybe';
      },
      'cases[4].type',
    ],
    [
      'two cases share a stableId',
      (r: Record<string, unknown>) => {
        const l = r['cases'] as Record<string, unknown>[];
        l[5]!['stableId'] = l[4]!['stableId'];
      },
      'cases[5].stableId',
    ],
  ])('refuses a report where %s, naming the field', async (_what, damage, field) => {
    const c = await copyOf('judged');
    damage(c.report);
    const err = await rejection(readCairnRun(await save(c)));
    expect(err).toBeInstanceOf(CairnArtifactShapeError);
    expect(err.message).toContain('report.json');
    expect(err.message).toContain(field);
  });

  it.each([
    ['is not a list', (): unknown => ({ not: 'a list' }), 'mcp-evidence.json'],
    [
      'holds an entry that is not an object',
      (e: unknown[]) => {
        e[0] = 5;
        return e;
      },
      'mcp-evidence.json[0]',
    ],
    [
      'holds a request that is not text',
      (e: Record<string, unknown>[]) => {
        e[1]!['request'] = { q: 1 };
        return e;
      },
      'mcp-evidence.json[1].request',
    ],
    [
      'holds a stableId twice',
      (e: Record<string, unknown>[]) => {
        e[2]!['stableId'] = e[1]!['stableId'];
        return e;
      },
      'mcp-evidence.json[2].stableId',
    ],
    [
      'holds an entry for a case the report does not have',
      (e: Record<string, unknown>[]) => {
        e[0]!['stableId'] = 'ffffffffffff';
        return e;
      },
      'mcp-evidence.json[0].stableId',
    ],
    [
      'disagrees with the report about a state',
      (e: Record<string, unknown>[]) => {
        e[0]!['state'] = e[0]!['state'] === 'passed' ? 'failed' : 'passed';
        return e;
      },
      'mcp-evidence.json[0].state',
    ],
  ])('refuses evidence that %s, naming the field', async (_what, damage, field) => {
    const c = await copyOf('judged');
    const evidence = damage(c.evidence as never) as unknown;
    const err = await rejection(
      readCairnRun(await save({ dir: c.dir, report: c.report, evidence })),
    );
    expect(err).toBeInstanceOf(CairnArtifactShapeError);
    expect(err.message).toContain(field);
  });

  it('refuses evidence that is not JSON, naming the file', async () => {
    const c = await copyOf('judged');
    await save({ dir: c.dir, report: c.report });
    await fs.writeFile(path.join(c.dir, 'mcp-evidence.json'), '{"cut off');
    const err = await rejection(readCairnRun(c.dir));
    expect(err).toBeInstanceOf(CairnArtifactShapeError);
    expect(err.message).toContain('mcp-evidence.json');
  });

  it('refuses a file over the size limit before it reads it', async () => {
    for (const file of ['report.json', 'mcp-evidence.json']) {
      const c = await copyOf('judged');
      const dir = await save({ dir: c.dir, report: c.report, evidence: c.evidence });
      await fs.truncate(path.join(dir, file), 40 * 1024 * 1024); // zeros: parsing them would say "not JSON"
      const err = await rejection(readCairnRun(dir));
      expect(err).toBeInstanceOf(CairnArtifactShapeError);
      expect(err.message).toContain(file);
      expect(err.message).toMatch(/larger than/);
    }
  });

  it('refuses a report with more cases than it will read, before it maps any', async () => {
    const c = await copyOf('judged');
    const one = (c.report['cases'] as unknown[])[0];
    c.report['cases'] = Array.from({ length: 5001 }, () => one);
    const err = await rejection(readCairnRun(await save(c)));
    expect(err).toBeInstanceOf(CairnArtifactShapeError);
    expect(err.message).toMatch(/more than 5000 cases/);
  });

  it('joins evidence to cases by id without trusting the id as a property name', async () => {
    const c = await copyOf('judged');
    const cases = c.report['cases'] as Record<string, unknown>[];
    const sent = c.evidence.find((e) => typeof e['request'] === 'string');
    const at = cases.findIndex((x) => x['stableId'] === sent?.['stableId']);
    expect(at).toBeGreaterThanOrEqual(0);
    cases[at]!['stableId'] = '__proto__';
    sent!['stableId'] = '__proto__';
    const payload = await readCairnRun(await save(c));
    expect(payload.cases[at]?.stableId).toBe('__proto__');
    expect(payload.cases[at]?.steps[0]).toContain('{');
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });
});
