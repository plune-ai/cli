import * as fs from 'node:fs';
import { test } from '@playwright/test';

// What `reporter.e2e.test.ts` expects to arrive, written here rather than fetched from anywhere: the reporter is
// what is under test, and a browser or a server would be a download this suite has no use for.
test('keeps what the API answered and the log of the run', async () => {
  // By body, as a test attaches what it holds in memory: Playwright keeps no file for it, and hands the reporter
  // the bytes.
  await test.info().attach('api-response', {
    body: JSON.stringify({ items: [1, 2, 3], ok: true }),
    contentType: 'application/json',
  });
  // By path, as a test attaches what it wrote: the reporter is handed Playwright's copy, `console.log-<sha1>.log`.
  const log = test.info().outputPath('console.log');
  fs.writeFileSync(log, 'GET /cart 200 привіт\nGET /cart/pay 402\n');
  await test.info().attach('console.log', { path: log, contentType: 'text/plain' });
  // A byte over what Plune keeps of a text: it stays behind, and the run does not notice.
  await test.info().attach('too-long', { body: 'x'.repeat(512 * 1024 + 1), contentType: 'text/plain' });
});
