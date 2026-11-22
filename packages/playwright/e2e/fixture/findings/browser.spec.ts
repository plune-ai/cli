import { test, expect } from '../../../dist/fixture.js';

// The one place in this suite that opens a browser: what the fixture collects is what a real browser context
// emits, and no fake can say that. The site is the tiny server `reporter.e2e.test.ts` starts.
// Every test here fails on purpose: what the browser reported is sent only with an attempt that did not pass.
const site = process.env['PLUNE_FINDINGS_SITE'] ?? '';

test.describe('with a page', () => {
  test.use({ pluneSlowRequestMs: 300 });

  test('a page that goes wrong in every way', async ({ page }) => {
    await test.step('open the shop', async () => {
      await page.goto(`${site}/`);
    });
    await test.step('load the cart', async () => {
      await page.evaluate(async () => {
        // An answer that never ends: not a finding, and nothing the end of the test may wait for.
        await fetch('/api/stream');
        for (const path of ['/api/fail?token=secret', '/api/slow', '/api/drop']) {
          await fetch(path)
            .then((r) => r.text())
            .catch(() => undefined);
        }
      });
    });
    expect(await page.title()).toBe('not the shop');
  });
});

// The titles here go to the platform as they are, so they do not hold the word the e2e looks for.
test.describe('with a named variable', () => {
  test.use({ pluneSecretEnv: ['SHOP_KEY_FOR_E2E'] });

  test('a page that prints its key', async ({ page }) => {
    await page.goto(`${site}/`);
    await page.evaluate(async (key) => {
      console.error(`the shop refused the key ${key}`);
      // Read to the end: an answer still arriving when the test ends is not reported.
      await fetch(`/api/keys/${encodeURIComponent(key)}`)
        .then((r) => r.text())
        .catch(() => undefined);
    }, process.env['SHOP_KEY_FOR_E2E'] ?? '');
    expect(await page.title()).toBe('not the shop');
  });
});

test('a test that opens no browser', () => {
  expect(1 + 1).toBe(3);
});

test.describe('switched off', () => {
  test.use({ pluneFindings: false });

  test('a page nobody listens to', async ({ page }) => {
    await page.goto(`${site}/`);
    expect(await page.title()).toBe('not the shop');
  });
});
