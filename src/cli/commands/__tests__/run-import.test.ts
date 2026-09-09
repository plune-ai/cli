import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleRunImport } from '../run-import.js';
import { NoTokenError, RunCommandError } from '../run-lifecycle.js';
import { XmlParseError, UnknownFormatError } from '../../../importers/index.js';

/**
 * `plune run import` is the keyless door into the product, so what it must never do is look like it
 * worked when it did not: an empty summary, a cheerful count with nothing in Plune, a report that
 * half-parsed. Each of those has its own test below.
 */

const TOKEN = 'tok-import';

interface Seen {
  path: string;
  body: Record<string, unknown>;
}

function platform(
  resolveTo: (key: string) => string | null = () => 'tc-1',
  discoveryOutcome: 'queued' | 'known' = 'queued',
) {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url).replace('https://api.test', '');
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    seen.push({ path: target, body });

    if (target === '/v1/runs') return json(201, { run: { id: 'r-9' }, joined: false });
    if (target === '/v1/test-cases/resolve') {
      const keys = (body['keys'] ?? []) as { kind?: string; value: string }[];
      return json(200, { results: keys.map((key) => ({ key, testCaseId: resolveTo(key.value) })) });
    }
    if (target === '/v1/review-items/discovered') {
      const discovered = (body['discovered'] ?? []) as { keys: { value: string }[] }[];
      return json(200, {
        results: discovered.map((d) => ({ key: d.keys[0], outcome: discoveryOutcome, id: 'ri-1' })),
      });
    }
    if (target.endsWith('/results')) {
      const results = (body['results'] ?? []) as unknown[];
      return json(200, {
        items: [],
        counts: { accepted: results.length, duplicate: 0, conflict: 0, rejected: 0 },
      });
    }
    return json(200, { run: { id: 'r-9' }, changed: true });
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const REPORT = `<testsuites>
  <testsuite name="cart" timestamp="2026-09-09T10:00:00.000Z" file="tests/cart.spec.ts">
    <testcase classname="cart" name="adds an item" time="0.1"/>
    <testcase classname="cart" name="rejects a negative quantity" time="0.2">
      <failure message="expected 1 to be 0"/>
    </testcase>
  </testsuite>
</testsuites>`;

let dir = '';
const lines: string[] = [];

function write(name: string, text: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

const deps = (fetchImpl: typeof fetch) => ({
  apiUrl: 'https://api.test',
  token: TOKEN,
  fetchImpl,
  write: (l: string) => void lines.push(l),
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-import-'));
  lines.length = 0;
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('plune run import', () => {
  it('turns a report nobody here wrote into a run', async () => {
    const { seen, fetchImpl } = platform();
    const out = await handleRunImport({ ...deps(fetchImpl), file: write('results.xml', REPORT) });

    expect(out.format).toBe('junit');
    expect(out.parsed).toBe(2);
    expect(out.accepted).toBe(2);
    expect(seen.map((s) => s.path)).toContain('/v1/runs');
    expect(seen.some((s) => s.path === '/v1/runs/r-9/results')).toBe(true);
    expect(lines.join('\n')).toContain('Imported 2 result(s) from a junit report');
  });

  it('tells the platform which tests the report accounts for', async () => {
    // The file IS the complete list of what ran, so the platform can derive what never ran from it
    // — and one resolve request answers every test instead of one request per result.
    const { seen, fetchImpl } = platform();
    await handleRunImport({ ...deps(fetchImpl), file: write('results.xml', REPORT) });

    const start = seen.find((s) => s.path === '/v1/runs');
    expect((start?.body['configuration'] as { expected?: unknown[] })?.expected).toHaveLength(2);
    expect(seen.filter((s) => s.path === '/v1/test-cases/resolve')).toHaveLength(1);
    expect(start?.body['meta']).toMatchObject({ runner: 'junit' });
  });

  it('reads the format from the file, and lets the caller say it outright', async () => {
    const { fetchImpl } = platform();
    const report = write('anything.txt', REPORT);

    expect((await handleRunImport({ ...deps(fetchImpl), file: report })).format).toBe('junit');
    expect(
      (await handleRunImport({ ...deps(fetchImpl), file: report, format: 'junit' })).format,
    ).toBe('junit');
  });

  describe('a test the platform has no case for', () => {
    it('is counted, and not offered to anyone’s queue by default', async () => {
      // A reporter that filled a stranger's review queue on first run would teach the team to
      // ignore the queue. Asking is the switch.
      const { seen, fetchImpl } = platform(() => null);
      const out = await handleRunImport({ ...deps(fetchImpl), file: write('r.xml', REPORT) });

      expect(out.unresolved).toBe(2);
      expect(out.offered).toBe(0);
      expect(seen.some((s) => s.path === '/v1/review-items/discovered')).toBe(false);
      expect(lines.join('\n')).toContain('pass --create');
    });

    it('is offered when asked for', async () => {
      const { seen, fetchImpl } = platform(() => null);
      const out = await handleRunImport({
        ...deps(fetchImpl),
        file: write('r.xml', REPORT),
        create: true,
      });

      expect(out.offered).toBe(2);
      const offer = seen.find((s) => s.path === '/v1/review-items/discovered');
      expect(offer?.body['discovered']).toHaveLength(2);
      expect(lines.join('\n')).toContain('2 unknown test(s) offered to the review queue');
    });

    it('does not tell you to pass the flag you just passed', async () => {
      // Found by running it against beta, not by a test: a second import of the same report offers
      // nothing NEW — every test is already queued — and the summary said «pass --create», which
      // was already on the command line. A hint that ignores what the user typed reads as the
      // command not having heard them.
      // Everything offered comes back `known`: the queue has seen these tests before.
      const { fetchImpl } = platform(() => null, 'known');
      const out = await handleRunImport({
        ...deps(fetchImpl),
        file: write('r.xml', REPORT),
        create: true,
      });

      expect(out.offered).toBe(0);
      expect(lines.join('\n')).not.toContain('pass --create');
      expect(lines.join('\n')).toContain('already in the review queue');
    });

    it('says how many the report locates nowhere, instead of dropping them in silence', async () => {
      // Without a file or a classname there is no `specRef`, so the core cannot offer the test —
      // and a count that never appears is the same as the test never existing.
      const { fetchImpl } = platform(() => null);
      const out = await handleRunImport({
        ...deps(fetchImpl),
        file: write('r.xml', '<testsuite name="s"><testcase name="floating"/></testsuite>'),
        create: true,
      });

      expect(out.unlocatable).toBe(1);
      expect(out.offered).toBe(0);
      expect(lines.join('\n')).toContain('carry no file or class in the report');
    });
  });

  describe('when it cannot do the job', () => {
    it('refuses without a token rather than filing everything away as deferred', async () => {
      // A session with no token writes to the fallback file and reports success — right for a
      // reporter that must never break a build, wrong for a command a person just typed.
      const { fetchImpl } = platform();
      await expect(
        handleRunImport({ apiUrl: 'https://api.test', token: '', fetchImpl, file: write('r.xml', REPORT) }),
      ).rejects.toThrow(NoTokenError);
    });

    it('names the file and the line when the report is malformed', async () => {
      const { fetchImpl } = platform();
      await expect(
        handleRunImport({ ...deps(fetchImpl), file: write('r.xml', '<testsuite>\n<testcase name="t">\n') }),
      ).rejects.toThrow(XmlParseError);
    });

    it('refuses a file that is neither format instead of importing zero results', async () => {
      const { fetchImpl } = platform();
      await expect(
        handleRunImport({ ...deps(fetchImpl), file: write('notes.md', '# just some notes') }),
      ).rejects.toThrow(UnknownFormatError);
    });

    it('refuses a report that parses but holds nothing', async () => {
      // "Imported 0 results" beside a green tick is the shape of a silent failure: the operator
      // reads a success and the run they expected is not there.
      const { fetchImpl } = platform();
      await expect(
        handleRunImport({ ...deps(fetchImpl), file: write('r.xml', '<testsuites></testsuites>') }),
      ).rejects.toThrow(RunCommandError);
    });

    it('says so when the file is not there', async () => {
      const { fetchImpl } = platform();
      await expect(
        handleRunImport({ ...deps(fetchImpl), file: path.join(dir, 'nope.xml') }),
      ).rejects.toThrow(/Cannot read/);
    });
  });

  /**
   * A queue that fills up mid-import (#627).
   *
   * The review queue holds at most 1000 waiting items. A mature suite arriving for the first time
   * is bigger than that — this repository's own is 2029 — so the offer stops partway, and what the
   * person is told at that moment decides whether the import ever finishes.
   *
   * Offers go out in batches of 500. The count that matters is not the batch that was refused, it
   * is everything still unoffered after it: the batch AND every batch behind it, which the loop
   * abandons.
   */
  describe('more unmatched tests than the review queue can hold', () => {
    const REPORT_OF = (n: number): string => {
      const cases = Array.from(
        { length: n },
        (_, i) => `<testcase classname="big" name="case ${i}" time="0.1"/>`,
      ).join('');
      return `<testsuites><testsuite name="big" timestamp="2026-09-09T10:00:00.000Z" file="tests/big.spec.ts">${cases}</testsuite></testsuites>`;
    };

    /** Nothing resolves, and the queue accepts one batch of offers before it is full. */
    function fullQueue(acceptBatches: number) {
      const seen: Seen[] = [];
      let offers = 0;
      const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
        const target = String(url).replace('https://api.test', '');
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        seen.push({ path: target, body });

        if (target === '/v1/runs') return json(201, { run: { id: 'r-9' }, joined: false });
        if (target === '/v1/test-cases/resolve') {
          const keys = (body['keys'] ?? []) as { kind?: string; value: string }[];
          return json(200, { results: keys.map((key) => ({ key, testCaseId: null })) });
        }
        if (target === '/v1/review-items/discovered') {
          offers += 1;
          if (offers > acceptBatches) {
            return json(429, {
              error: 'review queue quota reached — at most 1000 items waiting.',
            });
          }
          const discovered = (body['discovered'] ?? []) as { keys: { value: string }[] }[];
          return json(200, {
            results: discovered.map((d) => ({ key: d.keys[0], outcome: 'queued', id: 'ri-1' })),
          });
        }
        if (target.endsWith('/results')) {
          return json(200, { items: [], counts: { accepted: 0, duplicate: 0, conflict: 0, rejected: 0 } });
        }
        return json(200, { run: { id: 'r-9' }, changed: true });
      }) as unknown as typeof fetch;
      return { seen, fetchImpl };
    }

    it('counts everything left unoffered, not the one batch that was refused', async () => {
      // 1200 unmatched in batches of 500: 500 queued, 500 refused, 200 never attempted.
      const { fetchImpl } = fullQueue(1);
      const out = await handleRunImport({
        ...deps(fetchImpl),
        file: write('big.xml', REPORT_OF(1200)),
        create: true,
      });

      expect(out.offered).toBe(500);
      // Naming 500 here would be naming the refused batch and forgetting the 200 behind it.
      expect(out.unoffered).toBe(700);
    });

    it('says another round is needed, rather than that the queue already has them', async () => {
      const { fetchImpl } = fullQueue(1);
      await handleRunImport({
        ...deps(fetchImpl),
        file: write('big.xml', REPORT_OF(1200)),
        create: true,
      });

      const text = lines.join(' ');
      // The old line said the unmatched tests were "already in the review queue". 700 of them were
      // not in it, had never been in it, and would not be until somebody emptied it and ran again.
      expect(text).not.toContain('already in the review queue');
      expect(text).toContain('700');
      expect(text).toMatch(/import .* again|run .* again|again/i);
    });

    it('shows the suite moving while a long import is under way', async () => {
      // 1200 results at 100 per batch is twelve silent round trips. A person watching a first
      // import of a mature suite has no way to tell a slow import from a hung one.
      const { fetchImpl } = fullQueue(99);
      await handleRunImport({
        ...deps(fetchImpl),
        file: write('big.xml', REPORT_OF(1200)),
        create: true,
      });

      expect(lines.some((l) => l.includes('of 1200') && l.includes('sent'))).toBe(true);
    });
  });

  /**
   * A shared run is the whole reason `--key` exists, and it is the one thing import could not do.
   *
   * `PLUNE_SHARED_RUN` has been read into `keepOpen` since the reporter needed it, and `env.test.ts`
   * checks all four ways of setting it. Nothing checked that anything ACTS on it: import called
   * `finish()` unconditionally, so the first of two jobs closed the run and the second was answered
   * 409 and wrote its results to a fallback file. Green step, green CI, quarter of a suite missing.
   *
   * That is why these assert on the REQUEST rather than on a return value. The loss happened on the
   * wire, in a call nobody made a claim about.
   */
  describe('a run several jobs report into', () => {
    const finishes = (seen: Seen[]): Seen[] =>
      seen.filter((s) => s.path.endsWith('/events') && s.body['event'] === 'finish');

    afterEach(() => {
      delete process.env['PLUNE_SHARED_RUN'];
      delete process.env['PLUNE_PROCEED'];
    });

    it.each(['PLUNE_SHARED_RUN', 'PLUNE_PROCEED'])('leaves the run open when %s is set', async (name) => {
      process.env[name] = '1';
      const { seen, fetchImpl } = platform();
      await handleRunImport({ ...deps(fetchImpl), file: write('results.xml', REPORT) });

      expect(finishes(seen)).toEqual([]);
      // The results still go — leaving the run open is about who closes it, not about withholding.
      expect(seen.some((s) => s.path === '/v1/runs/r-9/results')).toBe(true);
      expect(lines.some((l) => l.includes('plune run finish r-9'))).toBe(true);
    });

    it('closes the run when nothing says another job is coming', async () => {
      const { seen, fetchImpl } = platform();
      await handleRunImport({ ...deps(fetchImpl), file: write('results.xml', REPORT) });

      expect(finishes(seen)).toHaveLength(1);
    });
  });
});
