import { test, expect } from '../../../dist/fixture.js';

// The one place in this suite that opens a browser: what the fixture collects is what a real browser context
// emits, and no fake can say that. The site is the tiny server `findings.e2e.test.ts` starts.
const site = process.env['PLUNE_FINDINGS_SITE'] ?? '';

test.describe('with a page', () => {
  test.use({ pluneSlowRequestMs: 300 });

  test('a page that goes wrong in every way', async ({ page }) => {
    await test.step('open the shop', async () => {
      await page.goto(`${site}/`);
    });
    await test.step('load the cart', async () => {
      await page.evaluate(async () => {
        for (const path of ['/api/fail?token=secret', '/api/slow', '/api/drop']) {
          await fetch(path)
            .then((r) => r.text())
            .catch(() => undefined);
        }
      });
    });
    expect(await page.title()).toBe('shop');
  });
});

test('a test that opens no browser', () => {
  expect(1 + 1).toBe(2);
});

test.describe('switched off', () => {
  test.use({ pluneFindings: false });

  test('a page nobody listens to', async ({ page }) => {
    await page.goto(`${site}/`);
  });
});
