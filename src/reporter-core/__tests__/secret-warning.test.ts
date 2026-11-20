import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { credentialsIn } from '../code-snapshot.js';
import { startRun } from '../session.js';
import type { PendingResult } from '../types.js';
import { fakePlatform } from './fake-platform.js';

// Built at run time, so no scanner reads a credential in this file. 40 characters.
const SECRET = ['ghp', 'Zq7Xw2Lp9Rt4Vb6Nm1Kc8Hd3Jf5Gs0Ya2Ue7'].join('_');

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-secret-'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

const failed = (over: Partial<PendingResult>): PendingResult => ({
  resultKey: 'login#0',
  keys: [{ kind: 'playwright-id', value: 'login' }],
  source: 'playwright',
  rawStatus: 'failed',
  title: 'signs in',
  ...over,
});

async function report(result: PendingResult) {
  const platform = await fakePlatform();
  const log: string[] = [];
  try {
    const run = await startRun({
      apiUrl: platform.url,
      token: 'tok',
      fallbackPath: path.join(dir, 'pending.jsonl'),
      log: (line) => log.push(line),
    });
    await run.add(result);
    await run.finish();
    return { platform, run, log, warnings: log.filter((l) => l.includes('looks like a secret')) };
  } finally {
    await platform.close();
  }
}

describe('credentialsIn — where maskCredentials would mask, never what', () => {
  it('gives the line and the length of each masked value', () => {
    expect(credentialsIn(`one\ntwo\ntoken ${SECRET} here`)).toEqual([{ line: 3, length: 40 }]);
    expect(credentialsIn("const password = 'abc12345';\nok")).toEqual([{ line: 1, length: 8 }]);
    expect(credentialsIn('nothing to see\nhere')).toEqual([]);
  });
});

describe('the secret check before upload', () => {
  it('warns about a secret in the error text with its test, line and length, and still sends the text', async () => {
    const errorContext = `Error: expected 200\n\nreceived 401 for\n  token ${SECRET}`;
    const { platform, warnings, log } = await report(failed({ errorContext }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('the error text of "signs in"');
    expect(warnings[0]).toContain('line 4');
    expect(warnings[0]).toContain('(40 characters)');
    expect(warnings[0]).toContain('PLUNE_SECRET_CHECK=0');
    expect(log.join('\n')).not.toContain(SECRET);
    // The upload goes on: the result is posted with the text as it was.
    expect(platform.results).toHaveLength(1);
    expect(platform.results[0]!['errorContext']).toBe(errorContext);
  });

  it('warns about a secret in a text attachment, on disk or in memory, and still uploads it', async () => {
    const onDisk = path.join(dir, 'response.txt');
    fs.writeFileSync(onDisk, `HTTP/1.1 200\n${['Authorization', ` Bearer ${SECRET}`].join(':')}\n`);
    const { platform, warnings, log } = await report(
      failed({
        files: [
          { name: 'response.txt', contentType: 'text/plain', path: onDisk },
          { name: 'state.json', contentType: 'application/json', body: Buffer.from(`{\n  "a": 1,\n  "key": "${SECRET}"\n}`) },
          // Not a text: never read for the check.
          { name: 'trace.zip', contentType: 'application/zip', body: Buffer.from(`x ${SECRET}`) },
        ],
      }),
    );
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('the attachment "response.txt" of "signs in"');
    expect(warnings[0]).toContain('line 2');
    expect(warnings[1]).toContain('the attachment "state.json" of "signs in"');
    expect(warnings[1]).toContain('line 3');
    expect(warnings[1]).toContain('(40 characters)');
    expect(log.join('\n')).not.toContain(SECRET);
    expect(platform.stored).toBe(2);
  });

  it('says nothing with PLUNE_SECRET_CHECK=0, and sends the same', async () => {
    vi.stubEnv('PLUNE_SECRET_CHECK', '0');
    const { platform, warnings } = await report(failed({ errorContext: `token ${SECRET}` }));
    expect(warnings).toEqual([]);
    expect(platform.results).toHaveLength(1);
  });

  it('says nothing about a clean result', async () => {
    const { warnings } = await report(failed({ errorContext: 'Error: expected 200, received 500' }));
    expect(warnings).toEqual([]);
  });
});
