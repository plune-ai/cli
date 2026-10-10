import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MissingAttachment } from '../attachments.js';
import { AllureReportError, looksLikeAllureDir, readAllure } from '../allure.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'allure-results');

// ---- real adapters --------------------------------------------------------------------------------------------
// Every folder under fixtures/allure-results was written by the adapter it is named after, running the same
// four tests (adds an item, total is wrong, coupon, boom) — see fixtures/allure-results/README.md.

interface Adapter {
  folder: string;
  /** The test that passes, as the adapter titles it. */
  passes: string;
  /** Whether the adapter writes a result for a skipped test at all (allure-vitest does not). */
  skips: boolean;
  /** How many tests the adapter ran. */
  count: number;
  /** The text a failed assertion shows in Allure's own report. */
  message: string;
  /** The status Allure itself shows for the test that throws. */
  throws: 'broken' | 'failed';
  /** The attachment the pass attached on a step, and the one it attached on the test. */
  onStep: string;
  onTest: string;
  /** What the test that fails attached on its step. */
  onFailedStep: string;
}

const ADAPTERS: Adapter[] = [
  { folder: 'pytest', count: 6, passes: 'test_adds_item', skips: true, message: 'AssertionError: total should be 4', throws: 'broken', onStep: 'after add', onTest: 'state', onFailedStep: 'total' },
  { folder: 'junit5', count: 4, passes: 'addsItem()', skips: true, message: 'total should be 4 ==> expected: <4> but was: <3>', throws: 'broken', onStep: 'after add', onTest: 'state', onFailedStep: 'total' },
  { folder: 'playwright', count: 4, passes: 'adds an item', skips: true, message: 'total should be 4', throws: 'failed', onStep: 'after add', onTest: 'state', onFailedStep: 'total' },
  { folder: 'vitest', count: 3, passes: 'adds an item', skips: false, message: 'total should be 4', throws: 'broken', onStep: 'after add', onTest: 'state', onFailedStep: 'total' },
  { folder: 'cypress', count: 4, passes: 'adds an item', skips: true, message: 'total should be 4', throws: 'broken', onStep: 'after add', onTest: 'state', onFailedStep: 'total' },
  { folder: 'jest', count: 4, passes: 'adds an item', skips: true, message: 'Expected: 4', throws: 'broken', onStep: 'after add', onTest: 'state', onFailedStep: 'total' },
];

const byName = (results: ReturnType<typeof readAllure>, name: string) => {
  const found = results.find((r) => r.title === name || r.title?.endsWith(` › ${name}`));
  if (found === undefined) throw new Error(`no result "${name}" in ${results.map((r) => r.title).join(' | ')}`);
  return found;
};

describe.each(ADAPTERS)('CLI · run import · Allure · $folder · the folder the adapter wrote', (a) => {
  const dir = path.join(fixtures, a.folder);
  const read = (): { results: ReturnType<typeof readAllure>; missing: MissingAttachment[] } => {
    const missing: MissingAttachment[] = [];
    return { results: readAllure(dir, missing), missing };
  };

  it('is recognised as an Allure folder and gives one result per test, none of them missing a file', () => {
    expect(looksLikeAllureDir(dir)).toBe(true);
    const { results, missing } = read();
    expect(results).toHaveLength(a.count);
    expect(missing).toEqual([]);
    expect(new Set(results.map((r) => r.source))).toEqual(new Set(['allure']));
  });

  it('keeps the statuses Allure shows: passed, failed, skipped, and the throwing test as the adapter wrote it', () => {
    const { results } = read();
    expect(byName(results, a.passes).rawStatus).toBe('passed');
    expect(results.find((r) => /total/i.test(r.title ?? ''))?.rawStatus).toBe('failed');
    const boom = results.find((r) => /boom/.test(r.title ?? ''));
    expect(boom?.rawStatus).toBe(a.throws);
    if (a.skips) expect(results.find((r) => /coupon/.test(r.title ?? ''))?.rawStatus).toBe('skipped');
  });

  it('carries the failure message and the trace of the failed test, and nothing for the one that passed', () => {
    const { results } = read();
    const failed = results.find((r) => r.rawStatus === 'failed' && /total/i.test(r.title ?? ''));
    expect(failed?.errorContext).toContain(a.message);
    expect(failed?.errorContext).toMatch(/\n\n.+/s);
    expect(failed?.failure?.headline).toBe(failed?.errorContext?.split('\n')[0]);
    expect(byName(results, a.passes).errorContext).toBeUndefined();
  });

  it('sends the attachment of a step and the one of the test, from inside the folder, each with its own type', () => {
    const { results } = read();
    const files = byName(results, a.passes).files ?? [];
    const names = files.map((f) => f.name);
    expect(names).toContain(a.onStep);
    expect(names).toContain(a.onTest);
    expect(files.find((f) => f.name === a.onStep)?.contentType).toBe('image/png');
    expect(files.find((f) => f.name === a.onTest)?.contentType).toBe('application/json');
    for (const f of files) {
      expect(fs.existsSync(f.path ?? '')).toBe(true);
      expect(path.relative(fs.realpathSync(dir), f.path ?? '').startsWith('..')).toBe(false);
    }
    const failedFiles = results.find((r) => r.rawStatus === 'failed' && /total/i.test(r.title ?? ''))?.files ?? [];
    expect(failedFiles.map((f) => f.name)).toContain(a.onFailedStep);
  });

  it('gives every result a time, a key and a location a reviewer can use', () => {
    const { results } = read();
    for (const r of results) {
      expect(r.execution?.startedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
      expect(r.execution?.retry).toBe(0);
      expect(r.keys[0]?.kind).toBe('path-title');
      expect(r.resultKey).toBe(`${r.keys[0]?.value}#0`);
      expect(r.specRef).toBeTruthy();
    }
  });
});

describe('CLI · run import · Allure · pytest · fixtures of a test, from the container', () => {
  it('the attachment a fixture made on a step goes to the tests that used the fixture', () => {
    const results = readAllure(path.join(fixtures, 'pytest'));
    expect(byName(results, 'test_adds_item').files?.map((f) => f.name)).toContain('fixture log');
    expect(byName(results, 'test_boom').files).toBeUndefined();
  });

  it('a parametrised test is one result per parameter, not one for all', () => {
    const results = readAllure(path.join(fixtures, 'pytest'));
    const keys = results.filter((r) => /test_quantity/.test(r.title ?? '')).map((r) => r.keys[0]?.value);
    expect(keys).toEqual(expect.arrayContaining(['tests.test_cart#test_quantity[1]', 'tests.test_cart#test_quantity[2]']));
    expect(new Set(keys).size).toBe(2);
  });

  it('the key of pytest and of JUnit 5 is the one the JUnit report of the same test has (classname#name)', () => {
    expect(byName(readAllure(path.join(fixtures, 'pytest')), 'test_adds_item').keys[0]?.value).toBe('tests.test_cart#test_adds_item');
    expect(byName(readAllure(path.join(fixtures, 'junit5')), 'addsItem()').keys[0]?.value).toBe('shop.CartTest#addsItem()');
  });

  it('the key of Playwright is the one its own reporter and its JSON report give: file#describe#title', () => {
    expect(byName(readAllure(path.join(fixtures, 'playwright')), 'adds an item').keys[0]?.value).toBe('cart.spec.js#cart#adds an item');
  });
});

describe('CLI · run import · Allure · JUnit 5 · the container names the group', () => {
  it('the class container gives the group, the per-test containers (named like the test) do not', () => {
    const r = byName(readAllure(path.join(fixtures, 'junit5')), 'addsItem()');
    expect(r.title).toBe('CartTest › addsItem()');
  });
});

// ---- hand-built folders ---------------------------------------------------------------------------------------

let tmp = '';
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-allure-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A folder of results: `files` are paths below it, each holding its own path as bytes. */
function lay(tests: Record<string, unknown>[], files: string[] = [], containers: Record<string, unknown>[] = []): string {
  const dir = path.join(tmp, 'allure-results');
  fs.mkdirSync(dir, { recursive: true });
  tests.forEach((t, i) => fs.writeFileSync(path.join(dir, `${String(i).padStart(3, '0')}-result.json`), JSON.stringify(t)));
  containers.forEach((c, i) => fs.writeFileSync(path.join(dir, `${String(i).padStart(3, '0')}-container.json`), JSON.stringify(c)));
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), `bytes of ${f}`);
  }
  return dir;
}

const t = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  uuid: 'u1',
  name: 'adds',
  fullName: 'shop.Cart#adds',
  historyId: 'h1',
  status: 'passed',
  start: 1_000,
  stop: 1_500,
  ...over,
});

describe('CLI · run import · Allure · the statuses', () => {
  it('passes the four words of Allure on as they are, a missing one as "unknown", and a word it does not know untouched', () => {
    const dir = lay([
      t({ uuid: 'a', historyId: 'a', name: 'a', status: 'passed' }),
      t({ uuid: 'b', historyId: 'b', name: 'b', status: 'failed' }),
      t({ uuid: 'c', historyId: 'c', name: 'c', status: 'broken' }),
      t({ uuid: 'd', historyId: 'd', name: 'd', status: 'skipped' }),
      t({ uuid: 'e', historyId: 'e', name: 'e', status: 'unknown' }),
      t({ uuid: 'f', historyId: 'f', name: 'f', status: undefined }),
      t({ uuid: 'g', historyId: 'g', name: 'g', status: 'something-new' }),
    ]);
    const got = Object.fromEntries(readAllure(dir).map((r) => [r.title, r.rawStatus]));
    expect(got).toEqual({ a: 'passed', b: 'failed', c: 'broken', d: 'skipped', e: 'unknown', f: 'unknown', g: 'something-new' });
  });
});

describe('CLI · run import · Allure · the failure and the steps', () => {
  it('message and trace both reach the error text, the failed step chain reaches the failure', () => {
    const dir = lay([
      t({
        status: 'failed',
        statusDetails: { message: 'boom: 1 != 2', trace: 'at shop.Cart.adds (Cart.java:7)' },
        steps: [
          { name: 'outer', status: 'failed', steps: [{ name: 'inner ok', status: 'passed' }, { name: 'inner bad', status: 'failed' }] },
          { name: 'later', status: 'skipped' },
        ],
      }),
    ]);
    const [r] = readAllure(dir);
    expect(r?.errorContext).toBe('boom: 1 != 2\n\nat shop.Cart.adds (Cart.java:7)');
    expect(r?.failure?.headline).toBe('boom: 1 != 2');
    expect(r?.failure?.steps).toEqual(['outer', 'inner bad']);
  });

  it('a result with no statusDetails and no steps still reads', () => {
    const [r] = readAllure(lay([t({ steps: undefined, statusDetails: undefined })]));
    expect(r?.errorContext).toBeUndefined();
    expect(r?.failure).toBeUndefined();
  });

  it('time: start and stop are milliseconds, the duration is their difference and never negative', () => {
    const [a] = readAllure(lay([t({ start: Date.UTC(2026, 9, 10, 8, 0, 0), stop: Date.UTC(2026, 9, 10, 8, 0, 2, 250) })]));
    expect(a?.execution).toEqual({ startedAt: '2026-10-10T08:00:00.000Z', finishedAt: '2026-10-10T08:00:02.250Z', durationMs: 2250, retry: 0 });
    const [b] = readAllure(lay([t({ start: 5_000, stop: 1_000 })]));
    expect(b?.execution?.durationMs).toBe(0);
    const [c] = readAllure(lay([t({ start: undefined, stop: undefined })]));
    expect(c?.execution).toBeUndefined();
  });

  it('@P<id> in the name names the case outright, as in a JUnit report', () => {
    const [r] = readAllure(lay([t({ name: 'adds @Pcart-1' })]));
    expect(r?.testCaseId).toBe('cart-1');
  });
});

describe('CLI · run import · Allure · attachments of the test, its steps and its fixtures', () => {
  it('the container of a suite lends its fixtures to every test below it, even through a second container', () => {
    const dir = lay(
      [
        t({ uuid: 't1', attachments: [{ name: 'own', source: 'own.txt', type: 'text/plain' }], steps: [{ name: 's', attachments: [{ name: 'on step', source: 'step.png' }], steps: [{ name: 'deep', attachments: [{ name: 'on deep step', source: 'deep.log' }] }] }] }),
      ],
      ['own.txt', 'step.png', 'deep.log', 'before.txt', 'after.txt', 'outer.txt'],
      [
        { uuid: 'c1', name: 'inner', children: ['t1'], befores: [{ name: 'setup', attachments: [{ name: 'before', source: 'before.txt', type: 'text/plain' }] }], afters: [{ name: 'teardown', steps: [{ name: 'x', attachments: [{ name: 'after', source: 'after.txt' }] }] }] },
        { uuid: 'c0', name: 'outer', children: ['c1'], befores: [{ name: 'setup', attachments: [{ name: 'outer', source: 'outer.txt' }] }] },
      ],
    );
    const [r] = readAllure(dir);
    expect(r?.files?.map((f) => f.name).sort()).toEqual(['after', 'before', 'on deep step', 'on step', 'outer', 'own']);
    expect(r?.title).toBe('inner › adds');
  });

  it('the type is the one in the JSON; with none, the extension says; with neither, a generic file', () => {
    const dir = lay(
      [t({ attachments: [{ name: 'a', source: 'a.dat', type: 'image/png' }, { name: 'b', source: 'b.json' }, { name: 'c', source: 'c.weird' }] })],
      ['a.dat', 'b.json', 'c.weird'],
    );
    const files = readAllure(dir)[0]?.files ?? [];
    expect(files.map((f) => [f.name, f.contentType])).toEqual([
      ['a', 'image/png'],
      ['b', 'application/json'],
      ['c', 'application/octet-stream'],
    ]);
  });

  it('two attachments pointing at one file are one file', () => {
    const dir = lay([t({ attachments: [{ name: 'a', source: 'a.txt' }], steps: [{ name: 's', attachments: [{ name: 'again', source: 'a.txt' }] }] })], ['a.txt']);
    expect(readAllure(dir)[0]?.files).toHaveLength(1);
  });
});

describe('CLI · run import · Allure · a file that is not there, or is not ours to read', () => {
  it('a missing source leaves the result and is listed with the test and the source as written', () => {
    const missing: MissingAttachment[] = [];
    const dir = lay([t({ attachments: [{ name: 'gone', source: 'gone.png' }, { name: 'here', source: 'here.txt' }] })], ['here.txt']);
    const out = readAllure(dir, missing);
    expect(out).toHaveLength(1);
    expect(out[0]?.files?.map((f) => f.name)).toEqual(['here']);
    expect(missing).toEqual([{ title: 'adds', path: 'gone.png' }]);
  });

  it('a source outside the folder (.., absolute, nested ..) is refused the way a missing one is, and its bytes are not read', () => {
    const missing: MissingAttachment[] = [];
    fs.writeFileSync(path.join(tmp, 'secret.txt'), 'NEVER');
    const dir = lay([
      t({ attachments: [{ name: 'up', source: '../secret.txt' }, { name: 'abs', source: path.join(tmp, 'secret.txt') }, { name: 'nested', source: 'a/../../secret.txt' }] }),
    ]);
    const [r] = readAllure(dir, missing);
    expect(r?.files).toBeUndefined();
    expect(missing.map((m) => m.path)).toEqual(['../secret.txt', path.join(tmp, 'secret.txt'), 'a/../../secret.txt']);
  });

  it('a link that leads out of the folder is refused: the real place is judged', () => {
    const missing: MissingAttachment[] = [];
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'NEVER');
    const dir = lay([t({ attachments: [{ name: 'via link', source: 'link/secret.txt' }] })]);
    fs.symlinkSync(outside, path.join(dir, 'link'), 'junction');
    const [r] = readAllure(dir, missing);
    expect(r?.files).toBeUndefined();
    expect(missing).toHaveLength(1);
  });

  it('a source that is a folder, or has a line break in it, is a missing file and never silently dropped', () => {
    const missing: MissingAttachment[] = [];
    const dir = lay([t({ attachments: [{ name: 'dir', source: 'sub' }, { name: 'nl', source: 'a\nb.txt' }] })], ['sub/x.txt']);
    const [r] = readAllure(dir, missing);
    expect(r?.files).toBeUndefined();
    expect(missing.map((m) => m.path)).toEqual(['sub', 'a\nb.txt']);
  });

  it('a name with a line break and "::warning::" cannot start a line of its own in what is listed', () => {
    const missing: MissingAttachment[] = [];
    const dir = lay([t({ name: 'evil\n::warning::pwned', attachments: [{ name: 'x', source: 'gone.txt' }] })]);
    readAllure(dir, missing);
    const line = `plune: attachment not found — "${missing[0]?.title}": ${missing[0]?.path}`;
    expect(line.split('\n')).toHaveLength(1);
    expect(missing[0]?.title).toBe('evil?::warning::pwned');
  });
});

describe('CLI · run import · Allure · the same test run again (historyId)', () => {
  it('the last by stop is the result, the earlier ones are its attempts 0, 1, ... under the same key', () => {
    const dir = lay([
      t({ uuid: 'r3', status: 'passed', start: 3_000, stop: 3_500 }),
      t({ uuid: 'r1', status: 'failed', start: 1_000, stop: 1_500, statusDetails: { message: 'first' } }),
      t({ uuid: 'r2', status: 'failed', start: 2_000, stop: 2_500, statusDetails: { message: 'second' } }),
      t({ uuid: 'other', historyId: 'h2', name: 'other', fullName: 'shop.Cart#other' }),
    ]);
    const out = readAllure(dir);
    const runs = out.filter((r) => r.title === 'adds').sort((a, b) => (a.execution?.retry ?? 0) - (b.execution?.retry ?? 0));
    expect(runs.map((r) => [r.execution?.retry, r.rawStatus])).toEqual([[0, 'failed'], [1, 'failed'], [2, 'passed']]);
    expect(runs.map((r) => r.resultKey)).toEqual(['shop.Cart#adds#0', 'shop.Cart#adds#1', 'shop.Cart#adds#2']);
    expect(runs[0]?.errorContext).toBe('first');
    expect(out.find((r) => r.title === 'other')?.execution?.retry).toBe(0);
  });

  it('a file of an earlier attempt goes with that attempt, not with the last', () => {
    const dir = lay(
      [
        t({ uuid: 'r1', status: 'failed', start: 1, stop: 2, attachments: [{ name: 'first shot', source: 'one.png' }] }),
        t({ uuid: 'r2', start: 3, stop: 4, attachments: [{ name: 'last shot', source: 'two.png' }] }),
      ],
      ['one.png', 'two.png'],
    );
    const out = readAllure(dir).sort((a, b) => (a.execution?.retry ?? 0) - (b.execution?.retry ?? 0));
    expect(out.map((r) => r.files?.map((f) => f.name))).toEqual([['first shot'], ['last shot']]);
  });

  it('results without a historyId are never taken for repeats of each other', () => {
    const dir = lay([t({ uuid: 'a', historyId: undefined, fullName: 'x#a', name: 'a' }), t({ uuid: 'b', historyId: undefined, fullName: 'x#a', name: 'a' })]);
    expect(readAllure(dir).map((r) => r.execution?.retry)).toEqual([0, 0]);
  });
});

describe('CLI · run import · Allure · a folder that is not a report', () => {
  it('an empty folder is an error that says so, not a report of nothing', () => {
    const dir = path.join(tmp, 'empty');
    fs.mkdirSync(dir);
    expect(looksLikeAllureDir(dir)).toBe(false);
    expect(() => readAllure(dir)).toThrow(AllureReportError);
    expect(() => readAllure(dir)).toThrow(/no \*-result\.json/);
  });

  it('a folder of other files has no results either, and the error names the folder', () => {
    const dir = lay([], []);
    fs.writeFileSync(path.join(dir, 'report.xml'), '<testsuite/>');
    fs.writeFileSync(path.join(dir, 'a-container.json'), '{}');
    expect(looksLikeAllureDir(dir)).toBe(false);
    expect(() => readAllure(dir)).toThrow(dir);
  });

  it('a result that is not JSON names the file', () => {
    const dir = lay([t()]);
    fs.writeFileSync(path.join(dir, 'broken-result.json'), '{"name": ');
    expect(() => readAllure(dir)).toThrow(/broken-result\.json/);
  });
});
