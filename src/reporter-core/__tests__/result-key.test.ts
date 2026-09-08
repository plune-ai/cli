import { describe, it, expect } from 'vitest';
import { resultKey, RESULT_KEY_MAX } from '../result-key.js';

// The whole point of this key is AC-04: `playwright merge-reports` runs the reporter a second time
// over the same results, and the platform's unique index on (run_id, result_key) is what turns that
// second send into a `duplicate` instead of a second row. A key that varied between the two runs
// would double every result and nobody would see it happen — the counts would just be wrong.
describe('resultKey (AC-04)', () => {
  it('is the same for the same test and retry, computed independently', () => {
    expect(resultKey('e3b0c442:tests/cart.spec.ts:12', 0)).toBe(
      resultKey('e3b0c442:tests/cart.spec.ts:12', 0),
    );
  });

  it('separates retries of one test', () => {
    const first = resultKey('e3b0c442:tests/cart.spec.ts:12', 0);
    const second = resultKey('e3b0c442:tests/cart.spec.ts:12', 1);
    expect(second).not.toBe(first);
  });

  it('separates two tests', () => {
    expect(resultKey('a:tests/cart.spec.ts:12', 0)).not.toBe(resultKey('b:tests/cart.spec.ts:12', 0));
  });

  // Readable beats hashed while it fits: this string ends up in the database and in error messages,
  // and `a1b2…#0` tells a person nothing about which test it was.
  it('keeps the test id readable while it fits', () => {
    expect(resultKey('tests/cart.spec.ts >> adds an item', 2)).toBe(
      'tests/cart.spec.ts >> adds an item#2',
    );
  });

  it('never exceeds the length the contract accepts', () => {
    const huge = 'x'.repeat(5000);
    expect(resultKey(huge, 0).length).toBeLessThanOrEqual(RESULT_KEY_MAX);
  });

  it('stays deterministic past the length it has to hash', () => {
    const huge = 'x'.repeat(5000);
    expect(resultKey(huge, 3)).toBe(resultKey(huge, 3));
  });

  // A hash that dropped the retry would collapse a flaky test's three attempts into one row.
  it('still separates retries once it has to hash', () => {
    const huge = 'x'.repeat(5000);
    expect(resultKey(huge, 0)).not.toBe(resultKey(huge, 1));
  });

  it('does not collide between two long ids that share a prefix', () => {
    const a = 'x'.repeat(5000) + 'a';
    const b = 'x'.repeat(5000) + 'b';
    expect(resultKey(a, 0)).not.toBe(resultKey(b, 0));
  });
});

// The barrel is the package's published surface, and a typo in it breaks an import with no test
// failing anywhere — every other test here imports the modules directly. Reaching through it once
// is what makes it a surface rather than a file.
describe('the public entry exports what the adapters import', () => {
  it('offers the lifecycle, the key and the fallback', async () => {
    const entry = await import('../index.js');

    expect(typeof entry.startRun).toBe('function');
    expect(typeof entry.resultKey).toBe('function');
    expect(typeof entry.createClient).toBe('function');
    expect(typeof entry.appendBatch).toBe('function');
    expect(entry.DEFAULT_FALLBACK_PATH.length).toBeGreaterThan(0);
    expect(entry.RESULT_KEY_MAX).toBe(200);
  });
});
