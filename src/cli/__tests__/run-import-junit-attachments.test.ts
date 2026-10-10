import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProgram } from '../../cli.js';
import { sha256, startBucketPlatform, type BucketPlatform } from './bucket-platform.js';

// The real `fs`, with `realpathSync` counted: a test below needs to know which paths the disk was asked about.
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  const realpathSync = vi.fn(actual.realpathSync);
  return { ...actual, realpathSync, default: { ...actual, realpathSync } };
});

/**
 * plune-ai/plune#1220, through the command line: `plune run import report.xml` of a JUnit report whose tests
 * print `[[ATTACHMENT|path]]` on a line of their own. The program is the one the binary runs; the platform
 * is on a real socket, a project with a bucket, and the file is "uploaded" when its bytes arrive there.
 */

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'importers', '__tests__', 'fixtures', 'junit-attachments');

let dir = '';
let platform: BucketPlatform;
let printed: string[] = [];

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-junit-attachments-'));
  printed = [];
  platform = await startBucketPlatform();
  vi.stubEnv('PLUNE_TOKEN', 'tok-junit');
  vi.stubEnv('PLUNE_API_URL', platform.url);
  vi.stubEnv('PLUNE_FALLBACK', path.join(dir, 'pending.jsonl'));
  for (const marker of ['GITHUB_ACTIONS', 'GITLAB_CI', 'JENKINS_URL']) vi.stubEnv(marker, '');
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array): boolean => {
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

/** The bytes a file of this name holds in these tests: its own name, so a mix-up between two shows. */
const bytesOf = (name: string): Buffer => Buffer.from(`bytes of ${name}`);

/** Write `files` (paths below `base`, each holding `bytesOf` its path) and the report beside them; return its path. */
function lay(base: string, xml: string, files: string[] = []): string {
  fs.mkdirSync(base, { recursive: true });
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(base, f)), { recursive: true });
    fs.writeFileSync(path.join(base, f), bytesOf(f));
  }
  const report = path.join(base, 'report.xml');
  fs.writeFileSync(report, xml, 'utf8');
  return report;
}

async function importIt(report: string, ...flags: string[]): Promise<string> {
  await createProgram().parseAsync(['node', 'plune', 'run', 'import', report, ...flags]);
  return printed.join('');
}

/** One suite of test cases: `[name, system-out lines, system-err lines]`. */
function suite(cases: [string, string[], string[]?][]): string {
  const body = cases
    .map(([name, out, err]) => {
      const stream = (tag: string, lines: string[] | undefined): string =>
        lines === undefined ? '' : `<${tag}><![CDATA[${lines.join('\n')}]]></${tag}>`;
      return `<testcase classname="shop.Cart" name="${name}" time="0.1">${stream('system-out', out)}${stream('system-err', err)}</testcase>`;
    })
    .join('\n');
  return `<?xml version="1.0"?><testsuites><testsuite name="cart" tests="${cases.length}">${body}</testsuite></testsuites>`;
}

const mark = (p: string): string => `[[ATTACHMENT|${p}]]`;
const notFound = (out: string): string[] => out.split('\n').filter((l) => l.startsWith('plune: attachment not found'));
const putNames = (): string[] => platform.puts.map((p) => p.name).sort();

describe('CLI · run import · JUnit · a file a test announced reaches the bucket', () => {
  /** [label, fixture, files the report names that exist, the one it names that does not, the test that names it] */
  const FRAMEWORKS: [string, string, string[], string, string][] = [
    ['pytest --junitxml', 'pytest.xml', ['artifacts/cart.png'], 'artifacts/missing-trace.zip', 'test_rejects_negative'],
    ['Maven Surefire (JUnit 5)', 'surefire-junit5.xml', ['target/artifacts/cart.png'], 'target/artifacts/missing-trace.zip', 'rejectsANegativeQuantity'],
    ['Vitest junit', 'vitest.xml', ['artifacts/cart.png'], 'artifacts/missing-trace.zip', 'rejects a negative quantity'],
    ['.NET JunitXml.TestLogger', 'dotnet-junitxml-testlogger.xml', ['artifacts/cart.png'], 'artifacts/missing-trace.zip', 'RejectsANegativeQuantity'],
    ['PHPUnit', 'phpunit.xml', ['artifacts/cart.png'], 'artifacts/missing-trace.zip', 'testRejectsANegativeQuantity'],
    [
      'Cypress mocha-junit-reporter',
      'cypress-mocha-junit-reporter.xml',
      ['cypress/screenshots/cart.cy.js/cart -- adds an item.png', 'cypress/screenshots/cart.cy.js/cart -- rejects a negative quantity (failed).png'],
      'cypress/videos/cart.cy.js.mp4',
      'rejects a negative quantity',
    ],
  ];

  it.each(FRAMEWORKS)('%s: the files that exist arrive with their bytes, the missing one is named, both results are sent', async (_label, fixture, present, missing, test) => {
    const report = lay(path.join(dir, 'ci'), fs.readFileSync(path.join(fixtures, fixture), 'utf8'), present);

    const out = await importIt(report);

    expect(putNames()).toEqual(present.map((p) => path.basename(p)).sort());
    for (const p of present) {
      const put = platform.puts.find((x) => x.name === path.basename(p));
      expect(put?.sha256).toBe(sha256(bytesOf(p)));
    }
    expect(platform.results).toHaveLength(2);
    const lines = notFound(out);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(test);
    expect(lines[0]).toContain(missing);
    expect(out).toContain(`Imported 2 results · ${present.length} files uploaded · 1 files not found`);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('Jest jest-junit: the console is written once per suite, so no file can be told to a test — nothing is read, nothing is warned, the results arrive', async () => {
    const report = lay(path.join(dir, 'ci'), fs.readFileSync(path.join(fixtures, 'jest-junit.xml'), 'utf8'), ['artifacts/cart.png']);

    const out = await importIt(report);

    expect(platform.puts).toEqual([]);
    expect(platform.results).toHaveLength(2);
    expect(notFound(out)).toEqual([]);
    expect(out).not.toContain('files not found');
  });
});

describe('CLI · run import · JUnit · what the marker may look like', () => {
  it('system-out and system-err of a test are both read', async () => {
    const report = lay(path.join(dir, 'ci'), suite([['both', [mark('out.txt')], [mark('err.log')]]]), ['out.txt', 'err.log']);

    await importIt(report);

    expect(putNames()).toEqual(['err.log', 'out.txt']);
  });

  it('several markers in one test are several files, a path named twice is one', async () => {
    const report = lay(path.join(dir, 'ci'), suite([['many', [mark('a.png'), mark('b.json'), mark('a.png')]]]), ['a.png', 'b.json']);

    const out = await importIt(report);

    expect(putNames()).toEqual(['a.png', 'b.json']);
    expect(out).toContain('2 files uploaded');
  });

  it('text around the marker is ignored, and so is whitespace around it', async () => {
    const lines = ['starting', 'screenshot follows', `   ${mark('shot.png')}  `, 'done: see above'];
    const report = lay(path.join(dir, 'ci'), suite([['chatty', lines]]), ['shot.png']);

    await importIt(report);

    expect(putNames()).toEqual(['shot.png']);
  });

  it('a marker quoted inside a line of other text is not a file', async () => {
    const report = lay(path.join(dir, 'ci'), suite([['quoting', [`print("${mark('secret.txt')}")`]]]), ['secret.txt']);

    const out = await importIt(report);

    expect(platform.puts).toEqual([]);
    expect(notFound(out)).toEqual([]);
  });

  it('a path is counted from the folder of the report, not from where the command ran', async () => {
    const report = lay(path.join(dir, 'ci', 'nested'), suite([['rel', [mark('shots/one.png'), mark('./two.png')]]]), ['shots/one.png', 'two.png']);

    expect(path.dirname(report)).not.toBe(process.cwd());
    await importIt(report);

    expect(putNames()).toEqual(['one.png', 'two.png']);
  });

  it('a file of any kind goes: a trace and a page need the bucket, which this project has', async () => {
    const report = lay(path.join(dir, 'ci'), suite([['kinds', [mark('trace.zip'), mark('page.html'), mark('video.webm'), mark('stdout')]]]), ['trace.zip', 'page.html', 'video.webm', 'stdout']);

    await importIt(report);

    expect(putNames()).toEqual(['page.html', 'stdout', 'trace.zip', 'video.webm']);
    expect(platform.puts.find((p) => p.name === 'trace.zip')?.type).toBe('application/zip');
  });
});

describe('CLI · run import · JUnit · a file that is not there', () => {
  it('is named with its test and its path from the report, counted, and the import does not fail', async () => {
    const report = lay(path.join(dir, 'ci'), suite([['has it', [mark('here.png')]], ['lost it', [mark('gone/shot.png')]]]), ['here.png']);

    const out = await importIt(report);

    expect(notFound(out)).toEqual(['plune: attachment not found — "shop.Cart › lost it": gone/shot.png']);
    expect(out).toContain('Imported 2 results · 1 files uploaded · 1 files not found');
    expect(platform.results).toHaveLength(2);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('is shown without --verbose, and a report with no marker prints no summary of files', async () => {
    const quiet = await importIt(lay(path.join(dir, 'a'), suite([['plain', ['nothing here']]])));
    expect(quiet).not.toContain('files uploaded');
    expect(quiet).not.toContain('not found');
  });

  it('with --fail-on-missing-attachments the exit code is 1 and every result is still sent', async () => {
    const report = lay(path.join(dir, 'ci'), suite([['lost it', [mark('gone.png')]], ['has it', [mark('here.png')]]]), ['here.png']);

    const out = await importIt(report, '--fail-on-missing-attachments');

    expect(process.exitCode).toBe(1);
    expect(platform.results).toHaveLength(2);
    expect(putNames()).toEqual(['here.png']);
    expect(out).toContain('1 files not found');
  });

  it('with --fail-on-missing-attachments and nothing missing the exit code stays 0', async () => {
    const report = lay(path.join(dir, 'ci'), suite([['has it', [mark('here.png')]]]), ['here.png']);

    await importIt(report, '--fail-on-missing-attachments');

    expect(process.exitCode ?? 0).toBe(0);
  });
});

describe('CLI · run import · JUnit · a path that leaves the folder of the report', () => {
  const SECRET = 'TOP-SECRET-BYTES';

  function layOutside(): { inside: string; outside: string } {
    const outside = path.join(dir, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'passwd.txt'), SECRET);
    return { inside: path.join(dir, 'ci'), outside };
  }

  it('../ upward is refused with the line of a missing file, and nothing reaches the bucket', async () => {
    const { inside } = layOutside();
    const report = lay(inside, suite([['sneaky', [mark('../outside/passwd.txt'), mark('../../../../../../etc/passwd')]]]));

    const out = await importIt(report);

    expect(platform.puts).toEqual([]);
    expect(notFound(out)).toEqual([
      'plune: attachment not found — "shop.Cart › sneaky": ../outside/passwd.txt',
      'plune: attachment not found — "shop.Cart › sneaky": ../../../../../../etc/passwd',
    ]);
    expect(out).toContain('0 files uploaded · 2 files not found');
    expect(out).not.toContain(SECRET);
  });

  it('an absolute path outside is refused, an absolute path inside is taken', async () => {
    const { inside, outside } = layOutside();
    const here = path.join(inside, 'here.png');
    const report = lay(inside, suite([['abs', [mark(path.join(outside, 'passwd.txt')), mark(here)]]]), ['here.png']);

    const out = await importIt(report);

    expect(putNames()).toEqual(['here.png']);
    expect(notFound(out)).toHaveLength(1);
  });

  it('a link inside the folder that leads out is followed to where it points and refused', async () => {
    const { inside, outside } = layOutside();
    const report = lay(inside, suite([['linked', [mark('link/passwd.txt')]]]));
    // A junction needs no privilege on Windows; on the others it is a plain symlink.
    fs.symlinkSync(outside, path.join(inside, 'link'), 'junction');

    const out = await importIt(report);

    expect(platform.puts).toEqual([]);
    expect(notFound(out)).toEqual(['plune: attachment not found — "shop.Cart › linked": link/passwd.txt']);
  });

  it('a link to a single file outside is refused too', async (ctx) => {
    const { inside, outside } = layOutside();
    const report = lay(inside, suite([['linked file', [mark('single.txt')]]]));
    try {
      fs.symlinkSync(path.join(outside, 'passwd.txt'), path.join(inside, 'single.txt'), 'file');
    } catch {
      ctx.skip(); // Windows without the symlink privilege: the junction test above holds the case.
      return;
    }

    const out = await importIt(report);

    expect(platform.puts).toEqual([]);
    expect(notFound(out)).toHaveLength(1);
  });

  it('a folder where a file was named is not a file', async () => {
    const report = lay(path.join(dir, 'ci'), suite([['dir', [mark('shots')]]]), ['shots/a.png']);

    const out = await importIt(report);

    expect(platform.puts).toEqual([]);
    expect(notFound(out)).toHaveLength(1);
  });

  it('with the flag, a refused path alone makes the exit code 1', async () => {
    const { inside } = layOutside();
    const report = lay(inside, suite([['sneaky', [mark('../outside/passwd.txt')]]]));

    await importIt(report, '--fail-on-missing-attachments');

    expect(process.exitCode).toBe(1);
    expect(platform.results).toHaveLength(1);
  });
});

describe('CLI · run import · JUnit · a marker is words from the report, not ours', () => {
  it('a UNC path and a device path are refused on their face: the disk is never asked about them', async () => {
    const real = vi.mocked(fs.realpathSync);
    const BS = String.fromCharCode(92);
    const report = lay(path.join(dir, 'ci'), suite([['net', [mark(`${BS}${BS}127.0.0.1${BS}x${BS}y.png`), mark('//127.0.0.1/x/y.png'), mark(`${BS}${BS}.${BS}pipe${BS}x`)]]]));
    real.mockClear();

    const out = await importIt(report);

    const asked = real.mock.calls.map((c) => String(c[0]));
    expect(asked.filter((p) => p.includes('127.0.0.1') || p.includes('pipe'))).toEqual([]);
    expect(notFound(out)).toHaveLength(3);
    expect(platform.puts).toEqual([]);
  });

  it('a test name with a new line and an escape code cannot start a line of ours or reach a terminal', async () => {
    const xml =
      '<testsuites><testsuite name="s">' +
      '<testcase classname="c" name="x&#10;::warning title=PWN::INJECTED"><system-out>[[ATTACHMENT|gone.png]]</system-out></testcase>' +
      '<testcase classname="c" name="y&#27;[31m red"><system-out>[[ATTACHMENT|gone&#27;[0m.png]]</system-out></testcase>' +
      '</testsuite></testsuites>';

    const out = await importIt(lay(path.join(dir, 'ci'), xml));

    const lines = out.split('\n').filter((l) => l !== '');
    expect(lines.filter((l) => l.startsWith('::'))).toEqual([]);
    expect(lines.filter((l) => !l.startsWith('plune: ') && !l.startsWith('Read ') && !l.startsWith('Imported ') && !l.startsWith('http'))).toEqual([]);
    expect(out).not.toContain('\u001b');
    expect(notFound(out)).toHaveLength(2);
  });

  it('a sibling folder that shares the name of the report folder as a prefix is outside, in any letter case', async () => {
    const report = lay(path.join(dir, 'ci'), suite([['evil', [mark('../ci-evil/x.txt'), mark(path.join(dir, 'ci-evil', 'x.txt').toUpperCase())]]]));
    fs.mkdirSync(path.join(dir, 'ci-evil'));
    fs.writeFileSync(path.join(dir, 'ci-evil', 'x.txt'), 'EVIL');

    const out = await importIt(report);

    expect(platform.puts).toEqual([]);
    expect(notFound(out)).toHaveLength(2);
  });

  it('more than 100 markers in a test: the first 100 are read, one line says how many were not', async () => {
    const marks = Array.from({ length: 103 }, (_, i) => mark(`f${i}.txt`));
    const out = await importIt(lay(path.join(dir, 'ci'), suite([['flood', marks]])));

    expect(notFound(out)).toHaveLength(100);
    expect(out.split('\n').filter((l) => l.includes('more markers ignored'))).toEqual([
      'plune: "shop.Cart › flood": 3 more markers ignored (at most 100 per test)',
    ]);
  });
});

describe('CLI · run import · JUnit · the summary tells what did not travel', () => {
  it('a project that knows no test: the files found are named as not sent, not left as «0 files uploaded» alone', async () => {
    await platform.close();
    platform = await startBucketPlatform({ known: false });
    vi.stubEnv('PLUNE_API_URL', platform.url);
    const report = lay(path.join(dir, 'ci'), suite([['unknown', [mark('here.png'), mark('gone.png')]]]), ['here.png']);

    const out = await importIt(report);

    expect(out).toContain('Imported 0 results · 0 files uploaded · 1 files not found · 1 files not sent (their result was not stored)');
    expect(platform.puts).toEqual([]);
  });

  it('a project without a bucket: the picture goes to the result, the trace is counted as not stored', async () => {
    await platform.close();
    platform = await startBucketPlatform({ bucket: false });
    vi.stubEnv('PLUNE_API_URL', platform.url);
    const report = lay(path.join(dir, 'ci'), suite([['plain', [mark('cart.png'), mark('trace.zip')]]]), ['cart.png', 'trace.zip']);

    const out = await importIt(report);

    expect(platform.puts).toEqual([]);
    expect(platform.direct.map((d) => d.name)).toEqual(['cart.png']);
    expect(platform.direct[0]?.type).toBe('image/png');
    expect(out).toContain('1 file(s) not stored (no bucket connected)');
    expect(out).toContain('Imported 1 results · 1 files uploaded · 0 files not found');
  });
});
