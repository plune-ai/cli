// The stubs of one eval while it runs: each run of each row gets a scope of the stub server with the stubs
// fresh, so `times` and `failure.first` count per row whatever runs beside it, and what the scopes saw is
// added up for the eval's result.

import type { MockScope, MockServer } from '../mock/server.js';
import type { Stub } from '../mock/schema.js';
import type { EvalResult } from '../types/results.js';
import type { Provider } from '../types/provider.js';
import { ProviderError } from '../providers/errors.js';

/** The code of a row whose answer came back while its scope of the stub server had received no request. */
export const STUB_NOT_CALLED = 'STUB_NOT_CALLED';

/**
 * The provider of one run of a row of an eval with stubs: `inner` is the client that was asked to point at
 * `scope`. An answer counts only when the scope received a request for it. Whoever builds providers may
 * ignore the address, and the answer is then a model's: it is dropped and the row errors, before any check
 * or judge sees it. A call the stub server answered is not spend, so it costs 0.
 */
export function viaStubs(inner: Provider, scope: MockScope): Provider {
  return {
    async complete(req) {
      const res = await inner.complete(req);
      if (scope.journal.length + scope.dropped === 0)
        throw new ProviderError(
          STUB_NOT_CALLED,
          'the answer did not come from the stub server: the provider of this run was not pointed at it, so the answer is dropped',
        );
      return res;
    },
    estimateCost: () => ({ cost_usd: 0, priced: true }),
  };
}

export type StubsSeen = NonNullable<EvalResult['stubs']>;

/** The result of an eval none of whose rows has run yet: every stub is still never called. */
export const nothingSeen = (stubs: Stub[]): StubsSeen => ({
  never_called: stubs.map((_, i) => i),
  unmatched: [],
});

/**
 * The places in `stubs` of the ones a closed scope gives back as never called. The scope gives back copies,
 * in the order of the file. Stubs written alike are told apart from the end: of two the earlier answers
 * first, so the one never called is the later.
 */
export function unusedPlaces(stubs: Stub[], unused: Stub[]): Set<number> {
  const places = new Set<number>();
  let u = unused.length - 1;
  for (let i = stubs.length - 1; i >= 0 && u >= 0; i -= 1) {
    if (JSON.stringify(stubs[i]) !== JSON.stringify(unused[u])) continue;
    places.add(i);
    u -= 1;
  }
  return places;
}

/**
 * Runs `fn` with a scope of its own that holds `stubs`, and closes the scope afterwards, also when `fn`
 * throws. `fn` gets the scope: its `url` is the address a provider client is pointed at.
 */
export async function inStubScope<T>(
  server: MockServer,
  name: string,
  stubs: Stub[],
  seen: StubsSeen,
  fn: (scope: MockScope) => Promise<T>,
): Promise<T> {
  const scope = server.scope(name, stubs);
  try {
    return await fn(scope);
  } finally {
    const unused = unusedPlaces(stubs, scope.close());
    seen.never_called = seen.never_called.filter((i) => unused.has(i));
    // The method and the scope only: a path or a body may hold what should not be printed.
    for (const entry of scope.journal)
      if (!entry.matched) seen.unmatched.push({ scope: name, method: entry.method });
  }
}
