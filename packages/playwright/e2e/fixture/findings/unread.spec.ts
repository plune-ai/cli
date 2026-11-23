import { test, expect } from '../../../dist/fixture.js';

// An answer whose body the page never reads. In Chromium such a request never finishes, so it has to be
// recorded when its headers arrive. Both tests fail on purpose: findings go only with an attempt that did not pass.
const site = process.env['PLUNE_FINDINGS_SITE'] ?? '';

test('a 500 to a POST whose body is not read', async ({ page }) => {
  await page.goto(`${site}/blank`);
  const status = await page.evaluate(
    async () => (await fetch('/api/pay', { method: 'POST', body: '{}' })).status,
  );
  expect(status).toBe(200);
});

test('a 404 to a GET whose body is not read', async ({ page }) => {
  await page.goto(`${site}/blank`);
  const status = await page.evaluate(async () => (await fetch('/api/missing')).status);
  expect(status).toBe(200);
});
