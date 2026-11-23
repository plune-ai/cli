import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { findingsFixtures } from '../fixture.js';

type ContextFixture = (
  args: Record<string, unknown>,
  use: (context: unknown) => Promise<void>,
  testInfo: { attach(name: string, options: { body: string; contentType: string }): Promise<void> },
) => Promise<void>;

describe('the context fixture at the end of a test', () => {
  it('attaches what it has at once, with an answer still open whose body never comes', async () => {
    const context = new EventEmitter();
    const attached: { body: string; contentType: string }[] = [];
    const req = {
      url: () => 'http://h/api/pay',
      method: () => 'POST',
      timing: () => ({ startTime: 1_700_000_000_000, responseStart: 21, responseEnd: -1 }),
      failure: () => null,
    };

    const started = performance.now();
    await (findingsFixtures.context as unknown as ContextFixture)(
      { context, pluneFindings: true, pluneSlowRequestMs: 3000, pluneSecretEnv: [] },
      async () => {
        context.emit('request', req);
        context.emit('response', {
          request: () => req,
          status: () => 500,
          finished: () => new Promise(() => undefined),
        });
      },
      { attach: async (_name, options) => void attached.push(options) },
    );

    // Not a measure of speed: an await on the body would never return at all.
    expect(performance.now() - started).toBeLessThan(2000);
    expect(attached).toHaveLength(1);
    expect(attached[0]?.contentType).toBe('application/plune.findings+json');
    expect(JSON.parse(attached[0]?.body ?? '{}')).toEqual({
      items: [
        {
          kind: 'request_failed',
          method: 'POST',
          path: '/api/pay',
          status: 500,
          durationMs: 21,
          at: 1_700_000_000_000,
        },
      ],
      omitted: 0,
    });
  });
});
