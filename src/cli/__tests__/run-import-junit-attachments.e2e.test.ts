// END-TO-END for `plune run import` of a JUnit report that announces files (plune-ai/plune#1220), against
// the REAL built binary (dist/cli.cjs) and a platform on a real socket that has a bucket. Run with
// `pnpm test:e2e` (builds first). What a client checks after an import: did every file I kept arrive, with
// its bytes, and what does the command tell me about the ones that did not.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, startBucketPlatform, type BucketPlatform } from './bucket-platform.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const cli = path.join(root, 'dist', 'cli.cjs');

interface Ran {
  code: number | null;
  out: string;
}

function runCli(args: string[], platform: BucketPlatform, cwd: string): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      env: {
        ...process.env,
        PLUNE_API_URL: platform.url,
        PLUNE_TOKEN: 'tok-e2e',
        PLUNE_FALLBACK: path.join(cwd, 'pending.jsonl'),
        GITHUB_ACTIONS: '',
        GITLAB_CI: '',
        JENKINS_URL: '',
      },
    });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr.on('data', (c: Buffer) => (out += c.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out }));
  });
}

const FILES = {
  'shots/cart.png': Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), randomBytes(4096)]),
  'logs/api.json': Buffer.from('{"items":[1,2,3],"ok":true}'),
  'traces/trace.zip': Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), randomBytes(200_000)]),
} as const;

const marks = (...paths: string[]): string => paths.map((p) => `[[ATTACHMENT|${p}]]`).join('\n');
const report = (...tests: [string, string][]): string =>
  `<?xml version="1.0"?><testsuites><testsuite name="cart" tests="${tests.length}">` +
  tests
    .map(([name, out]) => `<testcase classname="shop.Cart" name="${name}" time="0.1"><system-out><![CDATA[${out}]]></system-out></testcase>`)
    .join('') +
  '</testsuite></testsuites>';

describe('CLI · run import · JUnit · the built binary, a project with a bucket', () => {
  let tmp = '';
  let platform: BucketPlatform;

  beforeAll(() => {
    if (!fs.existsSync(cli)) throw new Error('dist/cli.cjs not found — run `pnpm test:e2e` (it builds first), not plain vitest.');
  });

  /** A folder of its own: the report, the three files beside it, and a file outside that must never move. */
  function lay(xml: string, files: Partial<Record<keyof typeof FILES, boolean>> = { 'shots/cart.png': true, 'logs/api.json': true, 'traces/trace.zip': true }): string {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-junit-e2e-'));
    const ci = path.join(tmp, 'ci');
    for (const [rel, bytes] of Object.entries(FILES)) {
      if (files[rel as keyof typeof FILES] !== true) continue;
      fs.mkdirSync(path.dirname(path.join(ci, rel)), { recursive: true });
      fs.writeFileSync(path.join(ci, rel), bytes);
    }
    fs.writeFileSync(path.join(tmp, 'secret.txt'), 'NEVER-UPLOAD-ME');
    fs.mkdirSync(ci, { recursive: true });
    fs.writeFileSync(path.join(ci, 'report.xml'), xml);
    return path.join(ci, 'report.xml');
  }

  async function withPlatform<T>(work: () => Promise<T>): Promise<T> {
    platform = await startBucketPlatform();
    try {
      return await work();
    } finally {
      await platform.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  it('three files announced by two tests all arrive in the bucket, byte for byte (sha256)', async () => {
    await withPlatform(async () => {
      const file = lay(report(['adds', marks('shots/cart.png', 'logs/api.json')], ['pays', marks('traces/trace.zip')]));

      const ran = await runCli(['run', 'import', file], platform, tmp);

      expect(ran.code).toBe(0);
      const got = Object.fromEntries(platform.puts.map((p) => [p.name, p.sha256]));
      expect(got).toEqual({
        'cart.png': sha256(FILES['shots/cart.png']),
        'api.json': sha256(FILES['logs/api.json']),
        'trace.zip': sha256(FILES['traces/trace.zip']),
      });
      expect(ran.out).toContain('Imported 2 results · 3 files uploaded · 0 files not found');
      expect(ran.out).not.toContain('SECRET_SIG');
    });
  });

  it('one file gone: exit 0, its test and path in the output, the summary counts it, the other two arrive', async () => {
    await withPlatform(async () => {
      const file = lay(report(['adds', marks('shots/cart.png', 'logs/api.json')], ['pays', marks('traces/trace.zip')]), {
        'shots/cart.png': true,
        'logs/api.json': true,
      });

      const ran = await runCli(['run', 'import', file], platform, tmp);

      expect(ran.code).toBe(0);
      expect(ran.out).toContain('plune: attachment not found — "shop.Cart › pays": traces/trace.zip');
      expect(ran.out).toContain('Imported 2 results · 2 files uploaded · 1 files not found');
      expect(platform.puts.map((p) => p.name).sort()).toEqual(['api.json', 'cart.png']);
      expect(platform.results).toHaveLength(2);
    });
  });

  it('the same with --fail-on-missing-attachments: exit 1, and the results are in the platform all the same', async () => {
    await withPlatform(async () => {
      const file = lay(report(['adds', marks('shots/cart.png')], ['pays', marks('traces/trace.zip')]), { 'shots/cart.png': true });

      const ran = await runCli(['run', 'import', file, '--fail-on-missing-attachments'], platform, tmp);

      expect(ran.code).toBe(1);
      expect(platform.results.map((r) => r.rawStatus)).toEqual(['pass', 'pass']);
      expect(platform.puts.map((p) => p.name)).toEqual(['cart.png']);
      expect(ran.out).toContain('1 files not found');
    });
  });

  it('a path that leaves the folder of the report: nothing reaches the bucket, the line is the one of a missing file', async () => {
    await withPlatform(async () => {
      const file = lay(report(['sneaky', marks('../secret.txt', '../../../../../../etc/passwd')]), {});

      const ran = await runCli(['run', 'import', file], platform, tmp);

      expect(ran.code).toBe(0);
      expect(platform.puts).toEqual([]);
      expect(platform.direct).toEqual([]);
      expect(ran.out).toContain('plune: attachment not found — "shop.Cart › sneaky": ../secret.txt');
      expect(ran.out).toContain('0 files uploaded · 2 files not found');
      expect(ran.out).not.toContain('NEVER-UPLOAD-ME');
      expect(platform.results).toHaveLength(1);
    });
  });

  afterAll(() => {
    if (tmp !== '') fs.rmSync(tmp, { recursive: true, force: true });
  });
});
