import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunCommandError } from '../../cli/commands/run-lifecycle.js';
import { readAllure } from '../allure.js';
import { AllureReportError, UnknownFormatError, XmlParseError, readFolder } from '../index.js';

// The real `fs`, with `readFileSync` a spy: one test below needs a file that cannot be read, on every OS.
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  const readFileSync = vi.fn(actual.readFileSync);
  return { ...actual, readFileSync, default: { ...actual, readFileSync } };
});

/**
 * A folder of JUnit XML files, one per class, as Maven Surefire (`target/surefire-reports`)
 * and Gradle (`build/test-results/test`) write it, is one run; a folder with a `*-result.json` stays Allure.
 *
 * Live, copied as the job left them: `junit-folder-surefire-3.5.6` (report-action's Smoke 41614390691) and
 * `junit-folder-gradle-9.8.1` (Smoke 41611972921). Written by hand to the formats: `junit-folder-surefire`, kept for the
 * attachment marker the live run does not print, and `junit-folder-testng`.
 */

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const SUREFIRE = path.join(fixtures, 'junit-folder-surefire');
const SUREFIRE_LIVE = path.join(fixtures, 'junit-folder-surefire-3.5.6');
const GRADLE = path.join(fixtures, 'junit-folder-gradle-9.8.1');
const TESTNG = path.join(fixtures, 'junit-folder-testng');
const ALLURE = path.join(fixtures, 'allure-results', 'junit5');

let tmp = '';
afterEach(() => {
  if (tmp !== '') fs.rmSync(tmp, { recursive: true, force: true });
  tmp = '';
});
const scratch = (): string => (tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-junit-folder-')));

/** A name with control characters: a line break and `::error::` where the system takes them; C1 controls on Windows (NTFS refuses C0 and `:`). */
const HOSTILE = process.platform === 'win32' ? 'evil\u0085\u009b31m' : 'evil\n::error::pwned';
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const SAFE = HOSTILE.replace(new RegExp(CONTROL.source, 'g'), '?');

/** The error `fn` throws, or nothing. */
function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('CLI · run import · JUnit folder · Maven Surefire 3.5.6', () => {
  it('two TEST-*.xml give four results in the order of the file names; the .txt summaries are passed over without a word', () => {
    const before = Date.now();
    const read = readFolder(SUREFIRE_LIVE);
    const after = Date.now();

    expect(read.format).toBe('junit');
    expect(read.results.map((r) => [r.keys[0]?.value, r.rawStatus])).toEqual([
      ['cart.CartTest#totalIsWrong', 'failure'],
      ['cart.CartTest#addsAnItem', 'pass'],
      ['cart.CartTest#appliesACoupon', 'skipped'],
      ['cart.PriceTest#addsTax', 'pass'],
    ]);
    expect(read.notes).toEqual([]);
    expect(read.missing).toEqual([]);
    // Surefire writes no `timestamp` on <testsuite>: each case's `time` still arrives, as the span
    // that ends when the import read the report. `appliesACoupon` was skipped with time="0.0", a real zero.
    expect(read.results.map((r) => r.execution?.durationMs)).toEqual([22, 12, 0, 27]);
    for (const r of read.results) {
      const finished = Date.parse(r.execution?.finishedAt ?? '');
      expect(finished).toBeGreaterThanOrEqual(before);
      expect(finished).toBeLessThanOrEqual(after);
      expect(finished - Date.parse(r.execution?.startedAt ?? '')).toBe(r.execution?.durationMs);
      expect(r.execution?.retry).toBe(0);
    }
  });
});

const SUREFIRE_TITLES = [
  'com.example.CartTest › addsAnItem()',
  'com.example.CartTest › rejectsANegativeQuantity()',
  'com.example.CheckoutTest › paysByCard()',
  'com.example.CheckoutTest › refusesAnExpiredCard()',
  'com.example.CheckoutTest › appliesAGiftCard()',
];

describe('CLI · run import · JUnit folder · Maven Surefire', () => {
  it('every TEST-*.xml of target/surefire-reports is one run, in the order of the file names; the .txt summaries are not read', () => {
    const read = readFolder(SUREFIRE);

    expect(read.format).toBe('junit');
    expect(read.results.map((r) => r.title)).toEqual(SUREFIRE_TITLES);
    expect(read.results.map((r) => r.rawStatus)).toEqual([
      'pass',
      'failure',
      'pass',
      'error',
      'skipped',
    ]);
    expect(read.notes).toEqual([]);
    expect(read.missing).toEqual([]);
  });

  it('a [[ATTACHMENT|path]] counts from the folder of its file, not from where the command runs', () => {
    const failed = readFolder(SUREFIRE).results.find(
      (r) => r.title === 'com.example.CartTest › rejectsANegativeQuantity()',
    );

    expect(fs.existsSync(path.resolve('artifacts', 'cart-total.txt'))).toBe(false);
    expect(failed?.files?.map((f) => f.path)).toEqual([
      fs.realpathSync(path.join(SUREFIRE, 'artifacts', 'cart-total.txt')),
    ]);
  });
});

describe('CLI · run import · JUnit folder · Gradle 9.8.1', () => {
  it('the TEST-*.xml of build/test-results/test is read; the binary/ folder beside it and the README are not', () => {
    const read = readFolder(GRADLE);

    expect(read.format).toBe('junit');
    expect(read.results.map((r) => [r.keys[0]?.value, r.rawStatus])).toEqual([
      ['cart.CartTest#totalIsWrong()', 'failure'],
      ['cart.CartTest#addsAnItem()', 'pass'],
      ['cart.CartTest#appliesACoupon()', 'skipped'],
    ]);
    expect(read.notes).toEqual([]);
    expect(read.missing).toEqual([]);
  });
});

describe('CLI · run import · JUnit folder · TestNG through Surefire', () => {
  it('testng-results.xml is not JUnit: skipped, with one line naming it; the junitreports/ copies below are not read', () => {
    const read = readFolder(TESTNG);

    expect(read.results.map((r) => r.title)).toEqual([
      'com.example.CartTest › addsAnItem',
      'com.example.CartTest › rejectsANegativeQuantity',
    ]);
    expect(read.notes).toEqual([
      `plune: ${path.join(TESTNG, 'testng-results.xml')} is not a JUnit report — skipped.`,
    ]);
  });

  it('the line about a skipped file carries no control character of its name', () => {
    const dir = scratch();
    fs.writeFileSync(
      path.join(dir, 'TEST-a.xml'),
      '<testsuite name="a"><testcase classname="a" name="t"/></testsuite>',
    );
    // C1 controls: NTFS takes them in a name, and a terminal reads U+009B as the start of an escape.
    fs.writeFileSync(path.join(dir, 'evil\u009b2J\u0085.xml'), '<testng-results/>');

    expect(readFolder(dir).notes).toEqual([
      `plune: ${path.join(dir, 'evil?2J?.xml')} is not a JUnit report — skipped.`,
    ]);
  });
});

describe('CLI · run import · a folder with neither report', () => {
  it('an empty folder is an error that names both, exit 2 like the Allure one', () => {
    const dir = scratch();

    expect(() => readFolder(dir)).toThrow(AllureReportError);
    expect(() => readFolder(dir)).toThrow(/no \*-result\.json files and no JUnit XML files in it/);
    expect(() => readFolder(dir)).toThrow(
      /target\/surefire-reports.*allure-results|allure-results.*target\/surefire-reports/,
    );
  });

  it('with --format junit, a folder with no JUnit file says that, and says nothing of *-result.json', () => {
    const error = thrown(() => readFolder(ALLURE, 'junit'));

    expect(error).toBeInstanceOf(AllureReportError);
    expect((error as Error).message).toMatch(/— no JUnit XML files in it/);
    expect((error as Error).message).not.toMatch(/\*-result\.json/);
  });

  it('a folder of XML none of which is JUnit: the error names what it skipped, three at most, without control characters', () => {
    const dir = scratch();
    for (const name of [`a-${HOSTILE}.xml`, 'b.xml', 'c.xml', 'd.xml', 'e.xml']) {
      fs.writeFileSync(path.join(dir, name), '<testng-results/>');
    }

    const error = thrown(() => readFolder(dir));

    expect(error).toBeInstanceOf(AllureReportError);
    expect((error as Error).message).toContain(
      `— no *-result.json files and no JUnit XML files in it (skipped, not JUnit: a-${SAFE}.xml, b.xml, c.xml and 2 more), `,
    );
    expect((error as Error).message).not.toMatch(CONTROL);
  });
});

describe('CLI · run import · JUnit folder · a file name is words from the disk', () => {
  it('a JUnit file that does not parse is named in the error without the control characters of its name', () => {
    const dir = scratch();
    fs.writeFileSync(
      path.join(dir, `TEST-${HOSTILE}.xml`),
      '<testsuite name="s">\n<testcase name="t">\n',
    );

    const error = thrown(() => readFolder(dir));

    expect(error).toBeInstanceOf(XmlParseError);
    expect((error as Error).message).toContain(`TEST-${SAFE}.xml:`);
    expect((error as Error).message).not.toMatch(CONTROL);
  });

  it('a file that cannot be read is said as for one file: "Cannot read <file>.", the error that exits 1', () => {
    const dir = scratch();
    fs.writeFileSync(path.join(dir, `TEST-${HOSTILE}.xml`), '<testsuite name="s"/>');
    vi.mocked(fs.readFileSync).mockImplementationOnce(() => {
      throw new Error('EACCES: permission denied');
    });

    const error = thrown(() => readFolder(dir));

    expect(error).toBeInstanceOf(RunCommandError);
    expect((error as Error).message).toBe(`Cannot read ${path.join(dir, `TEST-${SAFE}.xml`)}.`);
  });
});

describe('CLI · run import · Allure · a folder with a *-result.json is read as before', () => {
  it('without a flag and with --format allure, even with a JUnit file beside the results', () => {
    const dir = scratch();
    fs.cpSync(ALLURE, dir, { recursive: true });
    fs.copyFileSync(
      path.join(SUREFIRE, 'TEST-com.example.CartTest.xml'),
      path.join(dir, 'TEST-com.example.CartTest.xml'),
    );

    for (const format of [undefined, 'allure'] as const) {
      const read = readFolder(dir, format);
      expect(read.format).toBe('allure');
      expect(read.results).toEqual(readAllure(dir));
    }
  });
});

describe('CLI · run import · JUnit folder · --format', () => {
  it('--format junit reads the folder as JUnit; --format playwright-json on a folder is refused', () => {
    expect(readFolder(SUREFIRE, 'junit').results.map((r) => r.title)).toEqual(SUREFIRE_TITLES);
    expect(() => readFolder(SUREFIRE, 'playwright-json')).toThrow(UnknownFormatError);
    expect(() => readFolder(SUREFIRE, 'playwright-json')).toThrow(
      /allure-results or JUnit XML files are read from one, not playwright-json/,
    );
  });

  it('--format junit on a folder with *-result.json and JUnit files side by side reads the JUnit files', () => {
    const dir = scratch();
    fs.cpSync(ALLURE, dir, { recursive: true });
    fs.copyFileSync(
      path.join(SUREFIRE, 'TEST-com.example.CartTest.xml'),
      path.join(dir, 'TEST-com.example.CartTest.xml'),
    );

    const read = readFolder(dir, 'junit');

    expect(read.format).toBe('junit');
    expect(read.results.map((r) => r.title)).toEqual(SUREFIRE_TITLES.slice(0, 2));
  });
});
