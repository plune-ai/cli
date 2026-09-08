import { test, expect } from '@playwright/test';

// No browser fixture anywhere in here on purpose: the reporter is what is under test, and pulling
// a browser in would make this suite need a download it has no use for.
test.describe('cart', () => {
  test('accepts a positive quantity', () => {
    expect(1 + 1).toBe(2);
  });

  test('rejects a negative quantity', () => {
    // Deliberately failing — a reporter that only ever sees green results is not tested.
    expect(-1).toBeGreaterThan(0);
  });

  test('leaves the currency alone', () => {
    test.skip(true, 'not implemented yet');
  });
});
