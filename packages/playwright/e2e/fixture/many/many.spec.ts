import { test, expect } from '@playwright/test';

// A hundred quick passes — the count of the AC-15 run, without its texts (#790). Only the e2e that
// asks for `PLUNE_TEST_DIR=./many` runs these.
for (let i = 0; i < 100; i += 1) {
  test(`item ${i}`, () => {
    expect(i).toBeGreaterThanOrEqual(0);
  });
}
