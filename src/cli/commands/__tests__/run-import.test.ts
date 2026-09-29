import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
  /** An upload's type and bytes — its body is the file, not JSON. */
  file?: { type: string; bytes: Buffer };
}

function platform(
  resolveTo: (key: string) => string | null = () => 'tc-1',
  discoveryOutcome: 'queued' | 'known' | 'created' = 'queued',
) {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url).replace('https://api.test', '');
    if (target.includes('/files?name=')) {
      const bytes = Buffer.from(init?.body as Uint8Array);
      seen.push({ path: target, body: {}, file: { type: (init?.headers as Record<string, string>)['content-type']!, bytes } });
      return json(201, { id: 'f-1', size: bytes.length });
    }
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
      const results = (body['results'] ?? []) as { resultKey: string }[];
      return json(200, {
        items: results.map((r, index) => ({ index, resultKey: r.resultKey, status: 'accepted', id: `res-${index}` })),
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
  // The run opens with the commit and branch of the CI it runs in (plune#927), so these tests are not
  // to know which CI that is: on GitHub Actions every run here would open with the job's own.
  for (const marker of ['GITHUB_ACTIONS', 'GITLAB_CI', 'JENKINS_URL']) vi.stubEnv(marker, '');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
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
    expect(lines.join('\n')).toContain('Read 2 result(s) from a junit report');
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

    /**
     * A trusted source (platform ADR 0030) answers the offer instead of queueing it — and the
     * reporter counted only `queued`, so a run that filled a project with cases printed nothing at
     * all about them. That is the same shape as every silence that has cost a day here: the work
     * happened, the accounting did not, and there is nobody to complain to.
     */
    it('says what a trusted source created, instead of reporting that nothing happened', async () => {
      const { fetchImpl } = platform(() => null, 'created');
      const out = await handleRunImport({
        ...deps(fetchImpl),
        file: write('r.xml', REPORT),
        create: true,
      });

      expect(out.created).toBe(2);
      expect(out.offered).toBe(0);
      expect(lines.join('\n')).toContain('2 unknown test(s) became cases without review');
      // And NOT the queue advice. These tests never entered a queue, so a line pointing at one
      // sends the reader to an empty screen to look for work that was already done.
      expect(lines.join('\n')).not.toContain('already in the review queue');
      expect(lines.join('\n')).not.toContain('pass --create');
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
   * The verb has to survive a run where nothing landed (#622).
   *
   * When the platform is unreachable the line read «Imported 555 result(s) … 0 accepted, 0 already
   * there, 0 unmatched» — the first half announcing success, the second half three zeros. A reader
   * stops at the verb and takes the rest for detail, which is how a run that reached nobody gets
   * read as a run that worked.
   *
   * `Read` is true of every outcome, because it describes the FILE, and the file was read.
   */
  it('says what it read, not what it landed, when nothing landed', async () => {
    const { fetchImpl } = platform(() => null);
    await handleRunImport({ ...deps(fetchImpl), file: write('results.xml', REPORT) });

    expect(lines.some((l) => l.includes('Imported'))).toBe(false);
    expect(lines.some((l) => l.includes('Read 2 result(s)'))).toBe(true);
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

  /**
   * #790 T16. What did not reach Plune is said on the line people and workflows already read, and in
   * GitHub Actions once more where a run's annotations show it; the CI run comes from the report the
   * runner wrote, never from the machine that happens to import it.
   */
  describe('what was not delivered, and the CI run (#790)', () => {
    const BUILD = 'https://github.com/acme/shop/actions/runs/42';
    const playwrightReport = (buildHref: string) =>
      JSON.stringify({
        config: { rootDir: '/nowhere/here', metadata: { ci: { buildHref } } },
        suites: [
          {
            title: 'a.spec.ts',
            file: 'a.spec.ts',
            specs: [{ title: 't', file: 'a.spec.ts', line: 1, tests: [{ id: 'id-1', results: [{ status: 'passed', retry: 0 }] }] }],
          },
        ],
      });
    /** The command's own summary — after the session's `plune: …` line, which comes first. */
    const readLine = () => lines.find((l) => l.startsWith('Read '));
    const refusingResults = (inner: typeof fetch) =>
      (async (url: string | URL | Request, init?: RequestInit) =>
        String(url).endsWith('/results') ? json(413, { error: 'request body too large' }) : inner(url, init)) as unknown as typeof fetch;

    beforeEach(() => {
      vi.stubEnv('GITHUB_ACTIONS', '');
      vi.stubEnv('PLUNE_FALLBACK', path.join(dir, 'pending.jsonl'));
    });
    afterEach(() => vi.unstubAllEnvs());

    it('always says how many were not delivered, zero included, and the unmatched count reads as before', async () => {
      const { fetchImpl } = platform(() => null);
      await handleRunImport({ ...deps(fetchImpl), file: write('results.xml', REPORT) });

      expect(readLine()).toBe('Read 2 result(s) from a junit report: 0 accepted, 0 already there, 2 unmatched, 0 not delivered.');
      // The pattern pre-release.yml and regression-beta.yml read the count with.
      expect(readLine()?.match(/[0-9]+ unmatched/)?.[0]).toBe('2 unmatched');
    });

    it('counts a refused batch as not delivered, keeps the fallback line, and exits as before', async () => {
      const { fetchImpl } = platform();
      const out = await handleRunImport({ ...deps(refusingResults(fetchImpl)), file: write('results.xml', REPORT) });

      expect(out.deferred).toBe(2);
      expect(readLine()).toBe('Read 2 result(s) from a junit report: 0 accepted, 0 already there, 0 unmatched, 2 not delivered.');
      expect(lines).toContain('2 could not be sent and are in the fallback file — "plune run report" retries them.');
      expect(lines.some((l) => l.startsWith('::warning::'))).toBe(false);
    });

    it('in GitHub Actions warns once when something was not delivered, and never when all was', async () => {
      vi.stubEnv('GITHUB_ACTIONS', 'true');
      const { fetchImpl } = platform();
      await handleRunImport({ ...deps(refusingResults(fetchImpl)), file: write('results.xml', REPORT) });
      expect(lines.filter((l) => l.startsWith('::warning::'))).toEqual([
        "::warning::2 result(s) were not delivered to Plune — see the reporting step's log.",
      ]);

      lines.length = 0;
      await handleRunImport({ ...deps(platform().fetchImpl), file: write('results.xml', REPORT) });
      expect(lines.some((l) => l.startsWith('::warning::'))).toBe(false);
    });

    it('opens the run with the CI run the report names, not this machine’s GITHUB_* (AC-04, AC-04b)', async () => {
      vi.stubEnv('GITHUB_SERVER_URL', 'https://github.com');
      vi.stubEnv('GITHUB_REPOSITORY', 'someone/else');
      vi.stubEnv('GITHUB_RUN_ID', '999');
      const { seen, fetchImpl } = platform();
      await handleRunImport({ ...deps(fetchImpl), file: write('report.json', playwrightReport(BUILD)) });

      expect(seen.find((s) => s.path === '/v1/runs')?.body['meta']).toEqual({ runner: 'playwright-json', ciUrl: BUILD });
    });

    it('opens the run without a link when the report’s is no web address, rather than being refused (AC-07b)', async () => {
      const { seen, fetchImpl } = platform();
      const out = await handleRunImport({ ...deps(fetchImpl), file: write('report.json', playwrightReport('javascript:alert(1)')) });

      expect(seen.find((s) => s.path === '/v1/runs')?.body['meta']).toEqual({ runner: 'playwright-json' });
      expect(out.runId).toBe('r-9');
    });
  });

  /**
   * plune-ai/plune#927. The run opens with the commit and branch it ran at, read from the CI's own
   * variables — as `@plune-ai/playwright` reads them, and from the report's when it names a commit:
   * whoever imports may be another job, and this job's branch is not that commit's.
   */
  describe('the commit and branch the run opens with (plune#927)', () => {
    const SHA = '0123456789abcdef0123456789abcdef01234567';
    const OTHER = 'fedcba9876543210fedcba9876543210fedcba98';
    const BUILD = 'https://github.com/acme/shop/actions/runs/42';
    /** Playwright's report of a run under GitHub Actions: a commit, and no branch. */
    const playwrightReport = (commitHash: string) =>
      JSON.stringify({
        config: {
          rootDir: '/nowhere/here',
          metadata: {
            ci: {
              commitHref: `https://github.com/acme/shop/commit/${commitHash}`,
              commitHash,
              buildHref: BUILD,
            },
          },
        },
        suites: [
          {
            title: 'a.spec.ts',
            file: 'a.spec.ts',
            specs: [
              {
                title: 't',
                file: 'a.spec.ts',
                line: 1,
                tests: [{ id: 'id-1', results: [{ status: 'passed', retry: 0 }] }],
              },
            ],
          },
        ],
      });
    const environment = (vars: Record<string, string>): void => {
      for (const [name, value] of Object.entries(vars)) vi.stubEnv(name, value);
    };
    const opensWith = async (name: string, text: string): Promise<unknown> => {
      const { seen, fetchImpl } = platform();
      await handleRunImport({ ...deps(fetchImpl), file: write(name, text) });
      return seen.find((s) => s.path === '/v1/runs')?.body['meta'];
    };

    it('on a GitHub push: GITHUB_SHA, and the ref name as the branch', async () => {
      environment({
        GITHUB_ACTIONS: 'true',
        GITHUB_SHA: SHA,
        GITHUB_HEAD_REF: '',
        GITHUB_REF_NAME: 'main',
      });

      expect(await opensWith('results.xml', REPORT)).toEqual({
        runner: 'junit',
        sha: SHA,
        branch: 'main',
      });
    });

    it('on a GitHub pull request: the pull request’s own branch, not "12/merge"', async () => {
      environment({
        GITHUB_ACTIONS: 'true',
        GITHUB_SHA: SHA,
        GITHUB_HEAD_REF: 'feat/panel',
        GITHUB_REF_NAME: '12/merge',
      });

      expect(await opensWith('results.xml', REPORT)).toEqual({
        runner: 'junit',
        sha: SHA,
        branch: 'feat/panel',
      });
    });

    it('on GitLab: CI_COMMIT_SHA and CI_COMMIT_REF_NAME', async () => {
      environment({ GITLAB_CI: 'true', CI_COMMIT_SHA: SHA, CI_COMMIT_REF_NAME: 'release/1.4' });

      expect(await opensWith('results.xml', REPORT)).toEqual({
        runner: 'junit',
        sha: SHA,
        branch: 'release/1.4',
      });
    });

    it('on Jenkins: GIT_COMMIT and GIT_BRANCH', async () => {
      environment({
        JENKINS_URL: 'https://ci.acme.test/',
        GIT_COMMIT: SHA,
        GIT_BRANCH: 'origin/main',
      });

      expect(await opensWith('results.xml', REPORT)).toEqual({
        runner: 'junit',
        sha: SHA,
        branch: 'origin/main',
      });
    });

    it('outside a CI: the format and nothing else — a stray GIT_COMMIT is not a commit', async () => {
      environment({ GIT_COMMIT: SHA, GIT_BRANCH: 'main' });

      expect(await opensWith('results.xml', REPORT)).toEqual({ runner: 'junit' });
    });

    it('a Playwright report of this very commit: the commit it names, and this job’s branch — GitHub gives the report none', async () => {
      environment({
        GITHUB_ACTIONS: 'true',
        GITHUB_SHA: SHA,
        GITHUB_HEAD_REF: '',
        GITHUB_REF_NAME: 'main',
      });

      expect(await opensWith('report.json', playwrightReport(SHA))).toEqual({
        runner: 'playwright-json',
        ciUrl: BUILD,
        sha: SHA,
        branch: 'main',
      });
    });

    it('a Playwright report another job wrote: its own commit, and no branch that belongs to this job’s', async () => {
      environment({
        GITHUB_ACTIONS: 'true',
        GITHUB_SHA: SHA,
        GITHUB_HEAD_REF: '',
        GITHUB_REF_NAME: 'main',
      });

      expect(await opensWith('report.json', playwrightReport(OTHER))).toEqual({
        runner: 'playwright-json',
        ciUrl: BUILD,
        sha: OTHER,
      });
    });
  });

  /**
   * plune-ai/plune#913. A Playwright JSON report names the files each attempt kept; the screenshots
   * among them go to their result — a passed test's too — once the batch that carries it is stored.
   */
  describe('the screenshots a Playwright report keeps (plune#913)', () => {
    // A 1×1 PNG.
    const PNG = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    /** One test that passed, keeping these attachments. */
    const keeping = (attachments: unknown[]) =>
      JSON.stringify({
        config: {},
        suites: [
          {
            title: 'a.spec.ts',
            file: 'a.spec.ts',
            specs: [{ title: 't', file: 'a.spec.ts', line: 1, tests: [{ id: 'id-1', results: [{ status: 'passed', retry: 0, attachments }] }] }],
          },
        ],
      });

    it('uploads them to their results, a passed test’s included, and says how many', async () => {
      const shot = path.join(dir, 'test-finished-1.png');
      fs.writeFileSync(shot, PNG);
      const { seen, fetchImpl } = platform();
      const out = await handleRunImport({
        ...deps(fetchImpl),
        file: write(
          'report.json',
          keeping([
            { name: 'screenshot', contentType: 'image/png', path: shot },
            { name: 'trace', contentType: 'application/zip', path: path.join(dir, 'trace.zip') },
          ]),
        ),
      });

      const uploads = seen.filter((s) => s.file !== undefined);
      // As Playwright's `screenshot` option names it: `screenshot`, at `test-finished-1.png`.
      expect(uploads.map((s) => s.path)).toEqual(['/v1/results/res-0/files?name=screenshot.png']);
      expect(uploads[0]?.file).toEqual({ type: 'image/png', bytes: PNG });
      // After the batch that stored the result, before the run is closed.
      const order = seen.map((s) => s.path);
      expect(order.indexOf('/v1/runs/r-9/results')).toBeLessThan(order.indexOf(uploads[0]!.path));
      expect(order.indexOf(uploads[0]!.path)).toBeLessThan(order.indexOf('/v1/runs/r-9/events'));
      expect(out.screenshots).toEqual({ uploaded: 1, skipped: 0, failed: 0 });
      expect(lines).toContain('1 screenshot(s) uploaded to their results.');
      // The line the workflows read stays as it was.
      expect(lines.find((l) => l.startsWith('Read '))).toBe(
        'Read 1 result(s) from a playwright-json report: 1 accepted, 0 already there, 0 unmatched, 0 not delivered.',
      );
    });

    it('counts a screenshot that is not on this machine as skipped, and still reports its result', async () => {
      // A report copied from another job: the files stayed on the runner that wrote it.
      const { fetchImpl } = platform();
      const out = await handleRunImport({
        ...deps(fetchImpl),
        file: write('report.json', keeping([{ name: 'screenshot', contentType: 'image/png', path: path.join(dir, 'elsewhere.png') }])),
      });

      expect(out).toMatchObject({ accepted: 1, deferred: 0, screenshots: { uploaded: 0, skipped: 1, failed: 0 } });
      expect(lines).toContain('0 screenshot(s) uploaded to their results, 1 skipped.');
    });

    it('says nothing about screenshots for a report that has none', async () => {
      const { fetchImpl } = platform();
      await handleRunImport({ ...deps(fetchImpl), file: write('results.xml', REPORT) });

      expect(lines.some((l) => l.includes('screenshot'))).toBe(false);
    });
  });
});
