// END-TO-END for `plune run import` of an allure-results folder (plune-ai/plune#1221), against the REAL built
// binary (dist/cli.cjs) and a platform on a real socket that has a bucket. Run with `pnpm test:e2e` (builds first).
// What a client checks after an import: did every file the adapter kept arrive, with its bytes, and what does the
// command tell me about the ones that did not.

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, startBucketPlatform, type BucketPlatform } from './bucket-platform.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const cli = path.join(root, 'dist', 'cli.cjs');
const fixtures = path.join(root, 'src', 'importers', '__tests__', 'fixtures', 'allure-results');

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

/** Every `source` of the test called `name` — on the test, on its steps, at any depth. */
function sourcesOf(folder: string, name: string): string[] {
  const found: string[] = [];
  const walk = (h: { attachments?: { source: string }[]; steps?: unknown[] }): void => {
    for (const a of h.attachments ?? []) found.push(a.source);
    for (const s of h.steps ?? []) walk(s as typeof h);
  };
  for (const f of fs.readdirSync(folder).filter((n) => n.endsWith('-result.json'))) {
    const r = JSON.parse(fs.readFileSync(path.join(folder, f), 'utf8')) as { name: string };
    if (r.name === name) walk(r);
  }
  return found;
}

let tmp = '';
let platform: BucketPlatform;

beforeAll(() => {
  if (!fs.existsSync(cli)) throw new Error('dist/cli.cjs not found — run `pnpm test:e2e` (it builds first), not plain vitest.');
});

afterEach(() => {
  if (tmp !== '') fs.rmSync(tmp, { recursive: true, force: true });
});

async function withFolder<T>(adapter: string, work: (folder: string) => Promise<T>): Promise<T> {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-allure-e2e-'));
  const folder = path.join(tmp, 'allure-results');
  fs.cpSync(path.join(fixtures, adapter), folder, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'secret.txt'), 'NEVER-UPLOAD-ME');
  platform = await startBucketPlatform();
  try {
    return await work(folder);
  } finally {
    await platform.close();
  }
}

describe('CLI · run import · Allure · the built binary, a project with a bucket', () => {
  it.each([
    ['pytest', 'test_adds_item'],
    ['junit5', 'addsItem()'],
    ['playwright', 'adds an item'],
    ['vitest', 'adds an item'],
    ['cypress', 'adds an item'],
  ])('%s: the files of a test and of its steps arrive in the bucket, byte for byte (sha256)', async (adapter, passing) => {
    await withFolder(adapter, async (folder) => {
      const ran = await runCli(['run', 'import', folder], platform, tmp);

      expect(ran.code).toBe(0);
      const sent = platform.puts.map((p) => p.sha256);
      for (const s of sourcesOf(folder, passing)) expect(sent).toContain(sha256(fs.readFileSync(path.join(folder, s))));
      expect(ran.out).toMatch(/Imported \d+ results · \d+ files uploaded · 0 files not found/);
    });
  });

  it('one source gone: exit 0, its test and source in the output, the summary counts it, the rest arrive', async () => {
    await withFolder('pytest', async (folder) => {
      const [gone] = sourcesOf(folder, 'test_adds_item').filter((s) => s.endsWith('.png'));
      fs.rmSync(path.join(folder, gone!));

      const ran = await runCli(['run', 'import', folder], platform, tmp);

      expect(ran.code).toBe(0);
      expect(ran.out).toContain(`plune: attachment not found — "tests › test_cart › test_adds_item": ${gone}`);
      expect(ran.out).toMatch(/Imported 6 results · \d+ files uploaded · 1 files not found/);
      expect(platform.results).toHaveLength(6);
      expect(platform.puts.length).toBeGreaterThan(0);
    });
  });

  it('the same with --fail-on-missing-attachments: exit 1, and the results are in the platform all the same', async () => {
    await withFolder('pytest', async (folder) => {
      fs.rmSync(path.join(folder, sourcesOf(folder, 'test_adds_item')[0]!));

      const ran = await runCli(['run', 'import', folder, '--fail-on-missing-attachments'], platform, tmp);

      expect(ran.code).toBe(1);
      expect(platform.results).toHaveLength(6);
      expect(ran.out).toContain('1 files not found');
    });
  });

  it('a source that leaves the folder: nothing of it reaches the bucket, the line is the one of a missing file', async () => {
    await withFolder('pytest', async (folder) => {
      const file = fs.readdirSync(folder).find((n) => n.endsWith('-result.json'))!;
      const r = JSON.parse(fs.readFileSync(path.join(folder, file), 'utf8')) as { attachments?: unknown[] };
      r.attachments = [
        { name: 'up', source: '../secret.txt', type: 'text/plain' },
        { name: 'abs', source: path.join(tmp, 'secret.txt'), type: 'text/plain' },
        { name: 'deep', source: '../../../../../../etc/passwd', type: 'text/plain' },
      ];
      // Only this result's own files are of interest: the others keep theirs, so the bucket is not empty,
      // but not one byte of what lies outside may be in it.
      fs.writeFileSync(path.join(folder, file), JSON.stringify(r));

      const ran = await runCli(['run', 'import', folder], platform, tmp);

      expect(ran.code).toBe(0);
      expect(platform.puts.map((p) => p.bytes.toString('utf8'))).not.toContain('NEVER-UPLOAD-ME');
      expect(platform.direct.map((d) => d.bytes.toString('utf8'))).not.toContain('NEVER-UPLOAD-ME');
      expect(ran.out).toContain('../secret.txt');
      expect(ran.out).toMatch(/3 files not found/);
      expect(ran.out).not.toContain('NEVER-UPLOAD-ME');
    });
  });

  it('a folder with nothing to read: exit 2, a message that says why, nothing in the platform', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-allure-e2e-'));
    const empty = path.join(tmp, 'allure-results');
    fs.mkdirSync(empty);
    platform = await startBucketPlatform();
    try {
      const ran = await runCli(['run', 'import', empty], platform, tmp);

      expect(ran.code).toBe(2);
      expect(ran.out).toMatch(/no \*-result\.json files/);
      expect(platform.results).toEqual([]);
    } finally {
      await platform.close();
    }
  });
});

describe('CLI · run import · Allure · jest · the built binary', () => {
  it('the file on a test and the file on a step both reach the bucket — what jest-junit cannot carry', async () => {
    await withFolder('jest', async (folder) => {
      const ran = await runCli(['run', 'import', folder], platform, tmp);

      expect(ran.code).toBe(0);
      const sources = sourcesOf(folder, 'adds an item');
      const onTest = sources.find((s) => s.endsWith('.json'))!;
      const onStep = sources.find((s) => s.endsWith('.png'))!;
      expect(platform.puts.map((p) => p.sha256)).toEqual(expect.arrayContaining([sha256(fs.readFileSync(path.join(folder, onTest))), sha256(fs.readFileSync(path.join(folder, onStep)))]));
      expect(platform.results).toHaveLength(4);
    });
  });

});
