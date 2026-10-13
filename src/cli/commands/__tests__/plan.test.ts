import { describe, expect, it } from 'vitest';
import {
  formatGrep,
  grepFragment,
  handlePlanGrep,
  handleRunGrep,
  RunRefError,
  runGrepSummary,
  type PlanCase,
} from '../plan.js';
import { NotLoggedInError, SyncHttpError, SyncNetworkError, TokenRejectedError } from '../sync.js';

const TOKEN = 'plune_secret_do_not_leak';

/** A fetch stub that records each call and answers with one canned Response. */
function stubFetch(
  status: number,
  body: string,
): { fn: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(body, { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fn, calls };
}

function planCase(over: Partial<PlanCase>): PlanCase {
  return { id: 'c1', title: 'a case', type: 'automated', externalKeys: [], ...over };
}

const deps = (fn: typeof fetch) => ({ apiUrl: 'https://api.test', loadToken: () => TOKEN, fetchImpl: fn });

/** What each runner tests the pattern against for `describe('cart') → test('rejects a negative quantity')`. */
const RUNNER_NAMES = {
  playwright: 'chromium tests/cart.spec.ts cart rejects a negative quantity',
  vitest4: 'cart rejects a negative quantity', // jest and mocha spell it the same
  vitest5: 'cart > rejects a negative quantity',
};

describe('grepFragment — one case, one piece of the pattern', () => {
  it('takes the title path after the file from path-title, with a boundary every runner spells', () => {
    const c = planCase({
      externalKeys: [
        { kind: 'playwright-id', value: 'abc-1' },
        { kind: 'path-title', value: 'tests/cart.spec.ts#cart#rejects a negative quantity' },
      ],
    });
    // The file is in Playwright's grep title too, but it is the reporter's spelling of a path, not
    // the runner's, so it stays out of the pattern.
    expect(grepFragment(c)).toBe('cart[ >#]+rejects a negative quantity');
    const re = new RegExp(grepFragment(c));
    for (const name of Object.values(RUNNER_NAMES)) expect(re.test(name)).toBe(true);
    expect(re.test('cart rejects a positive quantity')).toBe(false);
  });

  it('keeps a title with its own # selectable — the key cannot tell it from a boundary', () => {
    const c = planCase({ externalKeys: [{ kind: 'path-title', value: 'src/f.test.tsx#form#shows the badge (#742)' }] });
    expect(new RegExp(grepFragment(c)).test('form shows the badge (#742)')).toBe(true);
    expect(new RegExp(grepFragment(c)).test('form > shows the badge (#742)')).toBe(true);
  });

  it('reads the " > " of a vitest junit name and the " › " of a Playwright one as boundaries too', () => {
    const vitest = planCase({ externalKeys: [{ kind: 'path-title', value: 'src/x.test.ts#cart > rejects a negative quantity' }] });
    expect(grepFragment(vitest)).toBe('cart[ >#]+rejects a negative quantity');
    const pw = planCase({ externalKeys: [{ kind: 'path-title', value: 'tests/cart.spec.ts#cart › rejects a negative quantity' }] });
    expect(grepFragment(pw)).toBe(grepFragment(vitest));
  });

  it('falls back to the title when no path-title key exists', () => {
    expect(grepFragment(planCase({ title: 'Оплата карткою Visa проходить' }))).toBe('Оплата карткою Visa проходить');
  });

  it('escapes what a regex would read otherwise', () => {
    const c = planCase({ externalKeys: [{ kind: 'path-title', value: 'a.spec.ts#adds (x+1) to [cart]?' }] });
    expect(grepFragment(c)).toBe('adds \\(x\\+1\\) to \\[cart\\]\\?');
  });
});

describe('formatGrep — the pattern the runner gets', () => {
  it('joins the fragments with | and nothing else on stdout', () => {
    const cases = [
      planCase({ externalKeys: [{ kind: 'path-title', value: 'a.spec.ts#one' }] }),
      planCase({ id: 'c2', externalKeys: [{ kind: 'path-title', value: 'b.spec.ts#suite#two' }] }),
    ];
    expect(formatGrep(cases)).toBe('one|suite[ >#]+two');
  });

  it('matches nothing for an empty plan — an empty --grep would run everything', () => {
    expect(formatGrep([])).toBe('(?!)');
  });
});

describe('handlePlanGrep (C8)', () => {
  it('reads GET /v1/plans/:id/cases with the bearer token and returns the plan with its pattern', async () => {
    const { fn, calls } = stubFetch(
      200,
      JSON.stringify({
        cases: [
          { id: 'c1', title: 'one', type: 'automated', externalKeys: [{ kind: 'path-title', value: 'a.spec.ts#one' }] },
          { id: 'c2', title: 'a manual step', type: 'manual', externalKeys: [] },
        ],
        count: 2,
      }),
    );
    const out = await handlePlanGrep({ ...deps(fn), planId: 'p-1' });

    expect(out).toEqual({ pattern: 'one|a manual step', cases: 2, keyed: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.test/v1/plans/p-1/cases');
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('escapes the id in the path', async () => {
    const { fn, calls } = stubFetch(200, JSON.stringify({ cases: [], count: 0 }));
    await handlePlanGrep({ ...deps(fn), planId: 'a b/c' });
    expect(calls[0]?.url).toBe('https://api.test/v1/plans/a%20b%2Fc/cases');
  });

  it('is the same ladder of refusals as sync: not logged in, rejected token, HTTP, network', async () => {
    await expect(
      handlePlanGrep({ apiUrl: 'https://api.test', loadToken: () => null, fetchImpl: stubFetch(200, '{}').fn, planId: 'p' }),
    ).rejects.toBeInstanceOf(NotLoggedInError);
    await expect(handlePlanGrep({ ...deps(stubFetch(401, '{}').fn), planId: 'p' })).rejects.toBeInstanceOf(
      TokenRejectedError,
    );
    const notFound = handlePlanGrep({ ...deps(stubFetch(404, JSON.stringify({ error: "plan 'p' not found" })).fn), planId: 'p' });
    await expect(notFound).rejects.toBeInstanceOf(SyncHttpError);
    await expect(notFound).rejects.toThrow("plan 'p' not found");
    const down = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(handlePlanGrep({ ...deps(down), planId: 'p' })).rejects.toBeInstanceOf(SyncNetworkError);
  });
});

/** A fetch stub answering each call in turn, recording them. */
function stubFetchSeq(...answers: { status: number; body: unknown }[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const a = answers[calls.length - 1] ?? { status: 500, body: {} };
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fn, calls };
}

const RUN_ID = '0b9f3c1e-6d2a-4f6e-9a51-3c7d2e8f1a40';
const RUN_KEY = 'rk_0123456789';
const RUN_CASES = {
  cases: [
    { id: 'c1', title: 'one', type: 'automated', externalKeys: [{ kind: 'path-title', value: 'a.spec.ts#one' }] },
    { id: 'c2', title: 'two', type: 'automated', externalKeys: [] },
    { id: 'c3', title: 'a person’s check', type: 'manual', externalKeys: [] },
  ],
  count: 3,
};

describe('handleRunGrep (plune-ai/cli#85) — a run’s automated cases as one --grep', () => {
  it('reads GET /v1/runs/:id/cases for a run id and keeps the automated cases, by plan grep’s rule', async () => {
    const { fn, calls } = stubFetchSeq({ status: 200, body: RUN_CASES });
    const out = await handleRunGrep({ ...deps(fn), run: RUN_ID });

    expect(out).toEqual({ pattern: 'one|two', cases: 2, keyed: 1, skipped: 1 });
    expect(calls.map((c) => c.url)).toEqual([`https://api.test/v1/runs/${RUN_ID}/cases`]);
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('--failed asks the platform for the cases whose latest result is a counted failure — it does not count them itself', async () => {
    // The platform answers only failed and broken, a muted failure left out (#1247): whatever it sends is what is taken.
    const { fn, calls } = stubFetchSeq({ status: 200, body: { cases: [RUN_CASES.cases[0]], count: 1 } });
    const out = await handleRunGrep({ ...deps(fn), run: RUN_ID, failed: true });

    expect(calls.map((c) => c.url)).toEqual([`https://api.test/v1/runs/${RUN_ID}/cases?status=failed,broken`]);
    expect(out).toEqual({ pattern: 'one', cases: 1, keyed: 1, skipped: 0 });
  });

  it('finds the run by its key first — the key PLUNE_RUN joins by', async () => {
    const { fn, calls } = stubFetchSeq({ status: 200, body: { runs: [{ id: RUN_ID }], total: 1 } }, { status: 200, body: RUN_CASES });
    const out = await handleRunGrep({ ...deps(fn), run: RUN_KEY });

    expect(calls.map((c) => c.url)).toEqual([
      `https://api.test/v1/runs?key=${RUN_KEY}&limit=1`,
      `https://api.test/v1/runs/${RUN_ID}/cases`,
    ]);
    expect(out.pattern).toBe('one|two');
  });

  it('says so when no run carries the key — exit 1, as for an id the platform does not know', async () => {
    const { fn, calls } = stubFetchSeq({ status: 200, body: { runs: [], total: 0 } });
    const refused = handleRunGrep({ ...deps(fn), run: RUN_KEY });
    await expect(refused).rejects.toBeInstanceOf(RunRefError);
    await expect(refused).rejects.toMatchObject({ exitCode: 1 });
    await expect(refused).rejects.toThrow(RUN_KEY);
    expect(calls).toHaveLength(1);
  });

  it('matches nothing when nothing is taken — an empty --grep would run everything', async () => {
    const { fn } = stubFetchSeq({ status: 200, body: { cases: [RUN_CASES.cases[2]], count: 1 } });
    expect(await handleRunGrep({ ...deps(fn), run: RUN_ID })).toEqual({ pattern: '(?!)', cases: 0, keyed: 0, skipped: 1 });
  });

  it('refuses what is neither a run id nor a run key with exit 2, before a token is read or a request is sent', async () => {
    for (const run of ['p-1', 'rk_012345678', 'rk_0123456789a', 'RK_0123456789', 'rk_ABCDEF0123', `${RUN_ID}x`, '$(rm -rf ~)', '', ' rk_0123456789']) {
      const { fn, calls } = stubFetchSeq();
      let read = false;
      const refused = handleRunGrep({
        apiUrl: 'https://api.test',
        loadToken: () => {
          read = true;
          return TOKEN;
        },
        fetchImpl: fn,
        run,
      });
      await expect(refused, JSON.stringify(run)).rejects.toBeInstanceOf(RunRefError);
      await expect(refused).rejects.toMatchObject({ exitCode: 2 });
      expect(calls, JSON.stringify(run)).toHaveLength(0);
      expect(read).toBe(false);
    }
  });

  it('is the same ladder of refusals as plan grep: not logged in, rejected token, HTTP, network', async () => {
    await expect(
      handleRunGrep({ apiUrl: 'https://api.test', loadToken: () => null, fetchImpl: stubFetchSeq().fn, run: RUN_ID }),
    ).rejects.toBeInstanceOf(NotLoggedInError);
    await expect(handleRunGrep({ ...deps(stubFetchSeq({ status: 401, body: {} }).fn), run: RUN_ID })).rejects.toBeInstanceOf(
      TokenRejectedError,
    );
    const notFound = handleRunGrep({ ...deps(stubFetchSeq({ status: 404, body: { error: `run '${RUN_ID}' not found` } }).fn), run: RUN_ID });
    await expect(notFound).rejects.toBeInstanceOf(SyncHttpError);
    await expect(notFound).rejects.toThrow(`run '${RUN_ID}' not found`);
    const down = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(handleRunGrep({ ...deps(down), run: RUN_ID })).rejects.toBeInstanceOf(SyncNetworkError);
  });
});

describe('runGrepSummary — the stderr line: how many taken, how many left out', () => {
  it('names the cases taken, the keyed ones, and the manual ones left out', () => {
    expect(runGrepSummary({ pattern: 'x', cases: 3, keyed: 2, skipped: 1 }, false)).toBe(
      'plune: 3 automated case(s) of the run, 2 with a test key, the rest by title; 1 manual left out.\n',
    );
    expect(runGrepSummary({ pattern: 'x', cases: 1, keyed: 1, skipped: 0 }, true)).toBe(
      'plune: 1 automated case(s) that failed or broke in the run, 1 with a test key, the rest by title; 0 manual left out.\n',
    );
  });

  it('says the pattern matches nothing when nothing is taken', () => {
    expect(runGrepSummary({ pattern: '(?!)', cases: 0, keyed: 0, skipped: 2 }, false)).toBe(
      'plune: the run holds no automated case (2 manual left out) — the pattern matches nothing.\n',
    );
    expect(runGrepSummary({ pattern: '(?!)', cases: 0, keyed: 0, skipped: 0 }, true)).toBe(
      'plune: no automated case failed or broke in the run (0 manual left out) — the pattern matches nothing.\n',
    );
  });
});
