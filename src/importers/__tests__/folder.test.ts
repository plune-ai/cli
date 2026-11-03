import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { readAllure } from '../allure.js';
import { AllureReportError, UnknownFormatError, readFolder } from '../index.js';

/**
 * plune-ai/plune#2309: a folder of JUnit XML files, one per class, as Maven Surefire (`target/surefire-reports`)
 * and Gradle (`build/test-results/test`) write it, is one run; a folder with a `*-result.json` stays Allure.
 *
 * `junit-folder-gradle-9.8.1` is a live run of report-action's Smoke 41611972921 (Gradle 9.8.1, JUnit 5.14.4), copied
 * as the job left it. `junit-folder-surefire` and `junit-folder-testng` are written by hand to the formats: there is
 * no live Maven job to take them from.
 */

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const SUREFIRE = path.join(fixtures, 'junit-folder-surefire');
const GRADLE = path.join(fixtures, 'junit-folder-gradle-9.8.1');
const TESTNG = path.join(fixtures, 'junit-folder-testng');
const ALLURE = path.join(fixtures, 'allure-results', 'junit5');

let tmp = '';
afterEach(() => {
  if (tmp !== '') fs.rmSync(tmp, { recursive: true, force: true });
  tmp = '';
});
const scratch = (): string => (tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-junit-folder-')));

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

  it('with --format junit, a folder with no JUnit file says that', () => {
    expect(() => readFolder(ALLURE, 'junit')).toThrow(AllureReportError);
    expect(() => readFolder(ALLURE, 'junit')).toThrow(/no JUnit XML files in it/);
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
});
