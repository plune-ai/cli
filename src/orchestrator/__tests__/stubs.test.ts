// Which stubs of a file a closed scope calls never called, by their place in the file. The scope is a real
// one, so the order and the copies it gives back are the server's own.

import { describe, expect, it } from 'vitest';
import { stubSchema, type StubInput } from '../../mock/schema.js';
import { withServer } from '../../mock/server.js';
import { inStubScope, nothingSeen, unusedPlaces } from '../stubs.js';

const stub = (extra: Partial<StubInput> = {}) => stubSchema.parse({ path: '/v1/messages', response: { text: 'ok' }, ...extra });
const post = (origin: string, path = '/v1/messages') => fetch(`${origin}${path}`, { method: 'POST', body: '{}' });

describe('CLI · run · stubs · places of the stubs never called', () => {
  it('a stub that differs from the others is found by what it holds', () => {
    const stubs = [stub(), stub({ method: 'GET' }), stub({ path: '/v1/other' })];
    expect([...unusedPlaces(stubs, [stubs[1]!])]).toEqual([1]);
    expect([...unusedPlaces(stubs, [stubs[0]!, stubs[2]!])].sort()).toEqual([0, 2]);
    expect([...unusedPlaces(stubs, [])]).toEqual([]);
  });

  it('of stubs written alike the later ones are the ones never called', () => {
    const stubs = [stub({ times: 'once' }), stub({ method: 'GET' }), stub({ times: 'once' }), stub({ times: 'once' })];
    expect([...unusedPlaces(stubs, [stubs[0]!])]).toEqual([3]);
    expect([...unusedPlaces(stubs, [stubs[0]!, stubs[0]!])].sort()).toEqual([2, 3]);
  });

  it('a scope narrows what was never called and adds the requests no stub answered; a throw still closes it', async () => {
    await withServer(async (server) => {
      const stubs = [stub({ times: 'once' }), stub({ times: 'once' }), stub({ method: 'GET' })];
      const seen = nothingSeen(stubs);
      expect(seen).toEqual({ never_called: [0, 1, 2], unmatched: [] });

      await inStubScope(server, 'a.row1', stubs, seen, async (origin) => void (await post(origin)));
      expect(seen).toEqual({ never_called: [1, 2], unmatched: [] });

      const thrown = await inStubScope(server, 'a.row2', stubs, seen, async (origin) => {
        await post(origin);
        await post(origin);
        await post(origin, '/v1/secret-path');
        throw new Error('the row threw');
      }).catch((e: unknown) => e);
      expect((thrown as Error).message).toBe('the row threw');
      expect(seen).toEqual({ never_called: [2], unmatched: [{ scope: 'a.row2', method: 'POST' }] });
      // Closed: the name is free again.
      server.scope('a.row2').close();
    });
  });
});
