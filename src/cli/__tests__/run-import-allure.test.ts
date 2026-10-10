import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProgram } from '../../cli.js';
import { sha256, startBucketPlatform, type BucketPlatform } from './bucket-platform.js';

/**
 * plune-ai/plune#1221, through the command line: `plune run import allure-results/` of a folder an Allure adapter
 * wrote. The program is the one the binary runs; the platform is on a real socket, a project with a bucket, and a
 * file is "uploaded" when its bytes arrive there.
 */

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'importers', '__tests__', 'fixtures', 'allure-results');

let dir = '';
let platform: BucketPlatform;
let printed: string[] = [];

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-allure-cli-'));
  printed = [];
  platform = await startBucketPlatform();
  vi.stubEnv('PLUNE_TOKEN', 'tok-allure');
  vi.stubEnv('PLUNE_API_URL', platform.url);
  vi.stubEnv('PLUNE_FALLBACK', path.join(dir, 'pending.jsonl'));
  for (const marker of ['GITHUB_ACTIONS', 'GITLAB_CI', 'JENKINS_URL']) vi.stubEnv(marker, '');
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array): boolean => {
    printed.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array): boolean => {
    printed.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`the command exited with ${String(code)}`);
  }) as (code?: string | number | null) => never);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
  await platform.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A copy of the folder an adapter wrote, that a test may change. */
function copyOf(adapter: string): string {
  const to = path.join(dir, 'allure-results');
  fs.cpSync(path.join(fixtures, adapter), to, { recursive: true });
  return to;
}

async function importIt(target: string, ...flags: string[]): Promise<string> {
  await createProgram().parseAsync(['node', 'plune', 'run', 'import', target, ...flags]);
  return printed.join('');
}

const notFound = (out: string): string[] => out.split('\n').filter((l) => l.startsWith('plune: attachment not found'));
const shaOf = (folder: string, source: string): string => sha256(fs.readFileSync(path.join(folder, source)));
const sources = (folder: string, name: string): string[] => {
  const found: string[] = [];
  for (const f of fs.readdirSync(folder).filter((n) => n.endsWith('-result.json'))) {
    const r = JSON.parse(fs.readFileSync(path.join(folder, f), 'utf8')) as { name: string; attachments?: { source: string }[]; steps?: unknown[] };
    if (r.name !== name) continue;
    const walk = (h: { attachments?: { source: string }[]; steps?: unknown[] }): void => {
      for (const a of h.attachments ?? []) found.push(a.source);
      for (const s of h.steps ?? []) walk(s as typeof h);
    };
    walk(r);
  }
  return found;
};

describe.each([
  ['pytest', 'test_adds_item'],
  ['junit5', 'addsItem()'],
  ['playwright', 'adds an item'],
  ['vitest', 'adds an item'],
  ['cypress', 'adds an item'],
  ['jest', 'adds an item'],
])('CLI · run import · Allure · %s · the folder reaches the bucket', (adapter, passing) => {
  it('every file of the passing test, on the test and on its step, arrives with its bytes; the results are sent', async () => {
    const folder = copyOf(adapter);

    const out = await importIt(folder);

    const want = sources(folder, passing);
    expect(want.length).toBeGreaterThanOrEqual(2);
    for (const s of want) expect(platform.puts.map((p) => p.sha256)).toContain(shaOf(folder, s));
    expect(platform.results.length).toBeGreaterThanOrEqual(3);
    expect(out).toMatch(/Read \d+ result\(s\) from an allure report/);
    expect(out).toMatch(/Imported \d+ results · \d+ files uploaded · 0 files not found/);
    expect(notFound(out)).toEqual([]);
    expect(process.exitCode ?? 0).toBe(0);
  });
});

describe('CLI · run import · Allure · jest · what jest-junit cannot say', () => {
  it('a file on a test and a file on a step both reach the bucket', async () => {
    const folder = copyOf('jest');

    await importIt(folder);

    const onTest = sources(folder, 'adds an item').find((s) => s.endsWith('.json'));
    const onStep = sources(folder, 'adds an item').find((s) => s.endsWith('.png'));
    expect(onTest).toBeDefined();
    expect(onStep).toBeDefined();
    expect(platform.puts.map((p) => p.sha256)).toEqual(expect.arrayContaining([shaOf(folder, onTest!), shaOf(folder, onStep!)]));
  });
});

describe('CLI · run import · Allure · a source that is not there', () => {
  it('is named with its test and its source, counted, and the import does not fail', async () => {
    const folder = copyOf('pytest');
    const gone = sources(folder, 'test_adds_item').find((s) => s.endsWith('.png'))!;
    fs.rmSync(path.join(folder, gone));

    const out = await importIt(folder);

    expect(notFound(out)).toEqual([`plune: attachment not found — "tests › test_cart › test_adds_item": ${gone}`]);
    expect(out).toMatch(/Imported 6 results · \d+ files uploaded · 1 files not found/);
    expect(platform.results).toHaveLength(6);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('with --fail-on-missing-attachments the exit code is 1 and the results are in the platform all the same', async () => {
    const folder = copyOf('pytest');
    fs.rmSync(path.join(folder, sources(folder, 'test_adds_item')[0]!));

    await importIt(folder, '--fail-on-missing-attachments');

    expect(process.exitCode).toBe(1);
    expect(platform.results).toHaveLength(6);
  });

  it('without a missing source the flag changes nothing', async () => {
    await importIt(copyOf('pytest'), '--fail-on-missing-attachments');
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('a test name with a line break and ::warning:: cannot start a line of the output of its own', async () => {
    const folder = copyOf('pytest');
    const file = fs.readdirSync(folder).find((n) => n.endsWith('-result.json') && JSON.parse(fs.readFileSync(path.join(folder, n), 'utf8')).name === 'test_adds_item')!;
    const r = JSON.parse(fs.readFileSync(path.join(folder, file), 'utf8')) as { name: string };
    r.name = 'evil\n::warning::pwned';
    fs.writeFileSync(path.join(folder, file), JSON.stringify(r));
    fs.rmSync(path.join(folder, sources(folder, 'evil\n::warning::pwned')[0]!));

    const out = await importIt(folder);

    expect(out.split('\n').filter((l) => l.startsWith('::'))).toEqual([]);
    expect(notFound(out)).toHaveLength(1);
  });
});

describe('CLI · run import · Allure · a source outside the folder', () => {
  it('is refused like a missing one: nothing of it reaches the bucket', async () => {
    const folder = copyOf('pytest');
    fs.writeFileSync(path.join(dir, 'secret.txt'), 'NEVER-UPLOAD-ME');
    const file = fs.readdirSync(folder).find((n) => n.endsWith('-result.json'))!;
    const r = JSON.parse(fs.readFileSync(path.join(folder, file), 'utf8')) as { attachments?: unknown[] };
    r.attachments = [
      { name: 'up', source: '../secret.txt', type: 'text/plain' },
      { name: 'abs', source: path.join(dir, 'secret.txt'), type: 'text/plain' },
    ];
    fs.writeFileSync(path.join(folder, file), JSON.stringify(r));

    const out = await importIt(folder);

    expect(platform.puts.map((p) => p.sha256)).not.toContain(sha256('NEVER-UPLOAD-ME'));
    expect(platform.direct.map((d) => d.bytes.toString())).not.toContain('NEVER-UPLOAD-ME');
    expect(notFound(out).some((l) => l.includes('../secret.txt'))).toBe(true);
    expect(out).not.toContain('NEVER-UPLOAD-ME');
  });
});

describe('CLI · run import · Allure · a folder that is not a report', () => {
  it('an empty folder: exit 2 with a message that says why, and nothing is sent', async () => {
    const empty = path.join(dir, 'empty');
    fs.mkdirSync(empty);

    await expect(importIt(empty)).rejects.toThrow('the command exited with 2');

    expect(printed.join('')).toMatch(/no \*-result\.json files/);
    expect(platform.results).toEqual([]);
  });

  it('--format junit on a folder is refused, and --format allure on a file is too', async () => {
    await expect(importIt(copyOf('pytest'), '--format', 'junit')).rejects.toThrow('the command exited with 2');
    expect(printed.join('')).toMatch(/only allure-results is read from one/);
    printed = [];
    const file = path.join(dir, 'r.xml');
    fs.writeFileSync(file, '<testsuite name="s"><testcase name="t"/></testsuite>');
    await expect(importIt(file, '--format', 'allure')).rejects.toThrow('the command exited with 2');
    expect(printed.join('')).toMatch(/is a folder, and this is a file/);
  });
});

describe('CLI · run import · Allure · what the platform is given as a file name', () => {
  it('the name the adapter gave with the extension of the real file: «after add» arrives as «after add.png», «state» as «state.json»', async () => {
    await importIt(copyOf('pytest'));

    const names = [...platform.puts.map((p) => p.name), ...platform.direct.map((d) => d.name)];
    expect(names).toEqual(expect.arrayContaining(['after add.png', 'state.json']));
    expect(names.some((n) => n.endsWith('-attachment.png') || n.endsWith('-attachment.json'))).toBe(false);
  });
});

describe('CLI · run import · Allure · a folder reached through a link', () => {
  it('a source inside the real folder arrives with its bytes', async (ctx) => {
    const real = copyOf('pytest');
    const link = path.join(dir, 'link-to-results');
    try {
      fs.symlinkSync(real, link, 'junction');
    } catch {
      return ctx.skip();
    }

    const out = await importIt(link);

    const want = sources(real, 'test_adds_item');
    for (const s of want) expect(platform.puts.map((p) => p.sha256)).toContain(shaOf(real, s));
    expect(notFound(out)).toEqual([]);
    expect(out).toMatch(/Imported \d+ results · \d+ files uploaded · 0 files not found/);
  });
});

describe('CLI · run import · Allure · the summary line is for the formats whose files can be absent', () => {
  it('a Playwright JSON report with a file has no «Imported … files» line, an Allure folder with files has one', async () => {
    const shot = path.join(dir, 'shot.png');
    fs.writeFileSync(shot, 'png');
    const report = path.join(dir, 'report.json');
    fs.writeFileSync(
      report,
      JSON.stringify({
        config: {},
        suites: [
          {
            title: 'a.spec.ts',
            file: 'a.spec.ts',
            specs: [
              {
                title: 't',
                file: 'a.spec.ts',
                line: 1,
                tests: [{ id: 'id-1', results: [{ status: 'passed', retry: 0, attachments: [{ name: 'shot', contentType: 'image/png', path: shot }] }] }],
              },
            ],
          },
        ],
      }),
    );

    expect(await importIt(report)).not.toMatch(/Imported \d+ results · \d+ files uploaded/);
    printed = [];
    expect(await importIt(copyOf('pytest'))).toMatch(/Imported \d+ results · \d+ files uploaded/);
  });
});
