import { describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';

// better-sqlite3 is an optional dependency: when it cannot be loaded the cache is off, not fatal.
vi.mock('node:module', async (orig) => {
  const real = await orig<typeof import('node:module')>();
  return {
    ...real,
    createRequire: () => () => {
      throw new Error("Cannot find module 'better-sqlite3'");
    },
  };
});

describe('cache without better-sqlite3', () => {
  it('degrades to a no-op cache and says so once', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { openCache } = await import('../cache.js');
    const file = path.join(os.tmpdir(), 'plune-never-created.db');
    const a = openCache(file);
    const b = openCache(file);
    a.set('k', { output: 'x', usage: { input_tokens: 1, output_tokens: 1 } });
    expect(a.get('k')).toBeUndefined();
    expect(() => b.close()).not.toThrow();
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0]?.[0])).toContain('completion cache disabled');
    err.mockRestore();
  });
});
