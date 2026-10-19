import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compare, formatVerify, handleVerify, testsOfListing } from '../verify.js';

// A real `playwright test --list --reporter=json` of a file with a describe, a nested describe, a PluneId
// annotation and an `@P` token (locations stripped).
const FIXTURE = new URL('../../__tests__/fixtures/playwright-list.json', import.meta.url);
const listing = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Parameters<typeof testsOfListing>[0];

const kase = (over: Record<string, unknown>) => ({
  id: 'c',
  title: 't',
  type: 'automated',
  state: 'active',
  externalKeys: [],
  ...over,
});

describe('plune verify (plune-ai/plune#1291)', () => {
  it('reads the tests as the reporter keys them: file, describes, title, with the id a test names', () => {
    expect(testsOfListing(listing)).toEqual([
      { pathTitle: 'nested/cart.spec.ts#top level' },
      { pathTitle: 'nested/cart.spec.ts#cart#rejects a negative quantity', id: 'tc-1a2b' },
      { pathTitle: 'nested/cart.spec.ts#cart#inner#adds @Ptc-9', id: 'tc-9' },
    ]);
  });

  it('AC-04: shows both sides, and says which platform cases are already detached', () => {
    const report = compare(testsOfListing(listing), [
      kase({ id: 'tc-1a2b' }), // by id
      kase({
        id: 'k1',
        externalKeys: [{ kind: 'path-title', value: 'nested/cart.spec.ts#top level' }],
      }), // by key
      kase({ id: 'gone', title: 'removed test' }), // not in code, still active
      kase({ id: 'old', title: 'older test', state: 'detached' }),
      kase({ id: 'retired', state: 'deprecated' }), // a person's decision: not drift
      kase({ id: 'manual', type: 'manual' }),
    ]);
    expect(report.matched).toBe(2);
    expect(report.onlyInCode).toEqual([
      { pathTitle: 'nested/cart.spec.ts#cart#inner#adds @Ptc-9' },
    ]);
    expect(report.onlyInPlatform).toEqual([
      { id: 'gone', title: 'removed test', state: 'active', detached: false },
      { id: 'old', title: 'older test', state: 'detached', detached: true },
    ]);
    const text = formatVerify(report);
    expect(text).toContain('gone  removed test  [active — a full run would detach it]');
    expect(text).toContain('old  older test  [already detached]');
    expect(text).toContain('In the code, not in Plune (1)');
  });

  it('AC-05: running it again changes nothing, and AC-07: it only ever reads', async () => {
    const calls: { url: string; method: string }[] = [];
    const pages = [
      { testCases: [kase({ id: 'tc-1a2b' })], nextCursor: '200' },
      { testCases: [kase({ id: 'tc-9' })], nextCursor: null },
    ];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET' });
      return new Response(JSON.stringify(pages.shift() ?? { testCases: [], nextCursor: null }));
    }) as typeof fetch;
    const run = () =>
      handleVerify({
        apiUrl: 'https://api.test',
        loadToken: () => 'tok',
        fetchImpl,
        list: () => JSON.stringify(listing),
      });
    const first = await run();
    expect(first.matched).toBe(2);
    expect(calls.map((c) => c.method)).toEqual(['GET', 'GET']);
    expect(calls[1]?.url).toContain('cursor=200');
    pages.push(
      { testCases: [kase({ id: 'tc-1a2b' })], nextCursor: '200' },
      { testCases: [kase({ id: 'tc-9' })], nextCursor: null },
    );
    expect(await run()).toEqual(first);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });
});
