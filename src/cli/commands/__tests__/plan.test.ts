import { describe, expect, it } from 'vitest';
import { formatGrep, grepFragment, handlePlanGrep, type PlanCase } from '../plan.js';
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
