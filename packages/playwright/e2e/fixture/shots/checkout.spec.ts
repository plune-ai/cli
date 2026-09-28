import * as fs from 'node:fs';
import { test } from '@playwright/test';

// The 1×1 PNG `reporter.e2e.test.ts` expects to arrive. Written here rather than drawn by a browser: the
// reporter is what is under test, and a browser would be a download this suite has no use for.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

test('keeps a screenshot of the checkout', async () => {
  const file = test.info().outputPath('checkout.png');
  fs.writeFileSync(file, PNG);
  // By path, as a test attaches what it drew: the reporter is handed Playwright's copy, `checkout-<sha1>.png`.
  await test.info().attach('checkout', { path: file, contentType: 'image/png' });
});
