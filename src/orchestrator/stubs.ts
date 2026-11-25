// The stubs of one eval while it runs: each run of each row gets a scope of the stub server with the stubs
// fresh, so `times` and `failure.first` count per row whatever runs beside it, and what the scopes saw is
// added up for the eval's result.

import type { MockServer } from '../mock/server.js';
import type { Stub } from '../mock/schema.js';
import type { EvalResult } from '../types/results.js';

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
 * throws. `fn` gets the address a provider client is pointed at.
 */
export async function inStubScope<T>(
  server: MockServer,
  name: string,
  stubs: Stub[],
  seen: StubsSeen,
  fn: (origin: string) => Promise<T>,
): Promise<T> {
  const scope = server.scope(name, stubs);
  try {
    return await fn(scope.url);
  } finally {
    const unused = unusedPlaces(stubs, scope.close());
    seen.never_called = seen.never_called.filter((i) => unused.has(i));
    // The method and the scope only: a path or a body may hold what should not be printed.
    for (const entry of scope.journal)
      if (!entry.matched) seen.unmatched.push({ scope: name, method: entry.method });
  }
}
