import { test, expect } from '@playwright/test';

// Only `PLUNE_TEST_DIR=./nested` runs these: a spec one directory down (`checkout\cart.spec.ts` on
// Windows) with a top-level test, a `describe` inside a `describe`, and an `@P<id>` in a title — the
// shapes a JUnit report of this run has to key the way the reporter did (plune-ai/cli#47, #38).
test('starts with an empty cart', () => {
  expect([]).toHaveLength(0);
});

test.describe('cart', () => {
  test('adds an item', () => {
    expect(1 + 1).toBe(2);
  });

  test.describe('coupons', () => {
    test('applies a coupon', () => {
      expect(true).toBe(true);
    });

    test('keeps its case when renamed @P42', () => {
      expect(true).toBe(true);
    });
  });
});
