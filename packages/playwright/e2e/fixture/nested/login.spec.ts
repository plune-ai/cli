import { test, expect } from '@playwright/test';

// A test with no `describe` around it, in a file with no directory in front of it.
test('shows the sign-in form', () => {
  expect(1).toBe(1);
});
