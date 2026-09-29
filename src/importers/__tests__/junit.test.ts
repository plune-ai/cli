import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { readJUnit, looksLikeJUnit } from '../junit.js';
import { XmlParseError, parseXml } from '../xml.js';

/**
 * JUnit XML is the format that decides whether Plune is usable without a provider key.
 *
 * Every assertion below is about a report some real runner actually writes — Jest, pytest,
 * Surefire and Playwright's own JUnit reporter each fill a different subset of the same tags, and
 * a parser that only handles the tidy one is a parser that works on the fixture and nowhere else.
 */

const REPORT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="jest tests" tests="4" failures="1" errors="1">
  <testsuite name="cart" tests="4" timestamp="2026-09-09T10:00:00.000Z" file="tests/cart.spec.ts">
    <testcase classname="cart" name="adds an item" time="0.125" />
    <testcase classname="cart" name="rejects a negative quantity" time="0.5">
      <failure message="expected 1 to be 0" type="AssertionError">at cart.spec.ts:12:3</failure>
    </testcase>
    <testcase classname="cart" name="talks to the pricing service" time="2">
      <error message="ECONNREFUSED">the harness fell over</error>
    </testcase>
    <testcase classname="cart" name="applies a coupon">
      <skipped />
    </testcase>
  </testsuite>
</testsuites>`;

describe('reading a JUnit report', () => {
  it('speaks the four words the platform already maps for this format', () => {
    // Not `passed`/`failed`: the platform's DEFAULT_STATUS_MAPPING carries a `junit` entry spelled
    // `pass` / `failure` / `error` / `skipped`, and that map is the contract. Emitting anything else
    // would still land — via the "already one of the five" fallback — while quietly counting as
    // unmapped, which is the number a team reads to find holes in their own configuration.
    const results = readJUnit(REPORT, 'results.xml');

    expect(results.map((r) => r.rawStatus)).toEqual(['pass', 'failure', 'error', 'skipped']);
    expect(new Set(results.map((r) => r.source))).toEqual(new Set(['junit']));
  });

  it('identifies a test by classname and name', () => {
    const [first] = readJUnit(REPORT, 'results.xml');

    expect(first?.keys).toEqual([{ kind: 'path-title', value: 'cart#adds an item' }]);
    expect(first?.resultKey).toBe('cart#adds an item#0');
  });

  it('carries the failure the runner wrote, message and body both', () => {
    const failed = readJUnit(REPORT, 'results.xml')[1];

    expect(failed?.errorContext).toContain('expected 1 to be 0');
    expect(failed?.errorContext).toContain('AssertionError');
    expect(failed?.errorContext).toContain('at cart.spec.ts:12:3');
  });

  it('reads an error over a failure when a case carries both', () => {
    // Both means the assertion failed AND the harness fell over, and the second is what makes the
    // first untrustworthy — reporting `failure` would blame the product for the runner.
    const both = `<testsuite name="s">
      <testcase classname="c" name="t">
        <failure message="assert">no</failure>
        <error message="boom">the harness fell over</error>
      </testcase>
    </testsuite>`;

    expect(readJUnit(both, 'r.xml')[0]?.rawStatus).toBe('error');
  });

  it('takes the time from the case and the start from the suite, and nothing from this machine', () => {
    // The format has no per-case start. The suite's timestamp is the closest thing IN THE FILE;
    // the file's mtime would be a guess wearing a fact's clothes, so a report without a timestamp
    // reports no execution at all rather than an invented one.
    const [first] = readJUnit(REPORT, 'results.xml');
    expect(first?.execution).toEqual({
      startedAt: '2026-09-09T10:00:00.000Z',
      finishedAt: '2026-09-09T10:00:00.125Z',
      durationMs: 125,
      retry: 0,
    });

    const undated = readJUnit('<testsuite name="s"><testcase classname="c" name="t" time="9"/></testsuite>', 'r.xml');
    expect(undated[0]?.execution).toBeUndefined();
  });

  describe('where the test lives', () => {
    it('prefers the file the writer named, with its line when there is one', () => {
      const located = `<testsuite name="s">
        <testcase classname="c" name="t" file="e2e/cart.spec.ts" line="42"/>
        <testcase classname="c" name="u" file="e2e/cart.spec.ts"/>
      </testsuite>`;
      const results = readJUnit(located, 'r.xml');

      expect(results[0]?.specRef).toBe('e2e/cart.spec.ts:42');
      expect(results[1]?.specRef).toBe('e2e/cart.spec.ts');
    });

    it('falls back to the classname, which is an address in the runner’s own terms', () => {
      const results = readJUnit(REPORT, 'results.xml');
      // The suite names the file, so these inherit it.
      expect(results[0]?.specRef).toBe('tests/cart.spec.ts');

      const bare = readJUnit('<testsuite name="s"><testcase classname="tests.test_cart.TestCart" name="t"/></testsuite>', 'r.xml');
      expect(bare[0]?.specRef).toBe('tests.test_cart.TestCart');
    });

    it('says nothing rather than inventing a location when the report has neither', () => {
      // A queue entry whose `specRef` is a made-up path sends a reviewer to a file that is not
      // there. The command counts these and says so; it does not fill the gap.
      const nowhere = readJUnit('<testsuite name="s"><testcase name="t"/></testsuite>', 'r.xml');
      expect(nowhere[0]?.specRef).toBeUndefined();
    });
  });

  describe('the name a reviewer reads', () => {
    it('joins the class and the case', () => {
      expect(readJUnit(REPORT, 'r.xml')[0]?.title).toBe('cart › adds an item');
    });

    it('does not repeat the case name when the class already ends with it', () => {
      // Playwright's own JUnit writer puts the whole path in `classname`; `a › b › b` reads like
      // a bug in us rather than a quirk of the writer.
      const pw = `<testsuite name="s">
        <testcase classname="cart.spec.ts › cart › adds an item" name="adds an item"/>
      </testsuite>`;
      expect(readJUnit(pw, 'r.xml')[0]?.title).toBe('cart.spec.ts › cart › adds an item');
    });
  });

  it('finds cases in suites nested inside suites', () => {
    const nested = `<testsuites>
      <testsuite name="outer">
        <testsuite name="inner" timestamp="2026-09-09T10:00:00.000Z">
          <testcase classname="inner" name="deep" time="1"/>
        </testsuite>
      </testsuite>
    </testsuites>`;
    const results = readJUnit(nested, 'r.xml');

    expect(results).toHaveLength(1);
    // The NEAREST suite is the one whose timestamp applies, not the outermost.
    expect(results[0]?.execution?.startedAt).toBe('2026-09-09T10:00:00.000Z');
  });
});

/**
 * The key a Playwright suite's own JUnit report gives a test has to be the one the reporter and the JSON
 * import give it (plune-ai/cli#47) — or `--create` offers every test a second time.
 *
 * `fixtures/playwright-1.63.0-win32.xml` is not typed by hand. It is what Playwright 1.63.0's `junit`
 * reporter wrote on Windows over two spec files — `login.spec.ts`, and `shop/checkout/cart.spec.ts` with a
 * `describe('cart')` around a nested `describe('coupons')` — with the machine's absolute path in the failure's
 * code frame swapped for `C:\repo`. Playwright fills `classname` with the file suite's title, the path from
 * the test directory in the OS's own separators, and `name` with the describe titles and the test's, joined
 * by ` › `. The adapter's e2e (`packages/playwright/e2e`) makes the same comparison against the live reporter,
 * on Linux in CI.
 */
const WINDOWS_REPORT = readFileSync(new URL('./fixtures/playwright-1.63.0-win32.xml', import.meta.url), 'utf8');
/** The same run as a POSIX machine writes it: only the separators differ. */
const POSIX_REPORT = WINDOWS_REPORT.replaceAll('\\', '/');

/** What the reporter's `path-title` is for each test of that run — `file#describe#…#title`, file with forward slashes. */
const REPORTER_KEYS = [
  'login.spec.ts#shows the sign-in form',
  'shop/checkout/cart.spec.ts#starts with an empty cart',
  'shop/checkout/cart.spec.ts#cart#adds an item',
  'shop/checkout/cart.spec.ts#cart#rejects a negative quantity',
  'shop/checkout/cart.spec.ts#cart#coupons#applies a coupon',
  'shop/checkout/cart.spec.ts#cart#coupons#keeps its case when renamed @P42',
  'shop/checkout/cart.spec.ts#cart#leaves the currency alone',
];

describe('a Playwright suite’s own report (plune-ai/cli#47)', () => {
  it.each([
    ['Windows', WINDOWS_REPORT],
    ['POSIX', POSIX_REPORT],
  ])('keys each test the way the reporter does, written on %s', (_os, report) => {
    const results = readJUnit(report, 'reports/junit.xml');

    expect(results.map((r) => r.keys)).toEqual(REPORTER_KEYS.map((value) => [{ kind: 'path-title', value }]));
    expect(results.map((r) => r.resultKey)).toEqual(REPORTER_KEYS.map((value) => `${value}#0`));
  });

  it('still reads the rest of the real file: outcomes, the skipped test with no time, the failure’s text', () => {
    const results = readJUnit(WINDOWS_REPORT, 'reports/junit.xml');

    expect(results.map((r) => r.rawStatus)).toEqual(['pass', 'pass', 'pass', 'failure', 'pass', 'pass', 'skipped']);
    expect(results[3]?.errorContext).toContain('expect(received).toBeGreaterThan(expected)');
    expect(results[3]?.errorContext).toContain('> 13 |     expect(-1).toBeGreaterThan(0);');
  });

  it('leaves the key of any other runner as it was', () => {
    // Neither half is enough alone: a ` › ` in a name means Playwright only beside a spec file in
    // `classname` (the second and third cases), and a spec file there changes nothing while the name has
    // no ` › ` and the slashes already run forward (the last, the shape of a Vitest report).
    const others = `<testsuite name="s">
      <testcase classname="tests.test_cart.TestCart" name="test_adds_an_item"/>
      <testcase classname="com.acme.CartTest" name="cart › adds an item"/>
      <testcase classname="cart" name="cart › adds an item"/>
      <testcase classname="tests/cart.test.ts" name="cart &gt; adds an item"/>
    </testsuite>`;

    expect(readJUnit(others, 'r.xml').map((r) => r.keys[0]?.value)).toEqual([
      'tests.test_cart.TestCart#test_adds_an_item',
      'com.acme.CartTest#cart › adds an item',
      'cart#cart › adds an item',
      'tests/cart.test.ts#cart > adds an item',
    ]);
  });

  it('takes any of the spec spellings Playwright matches by default', () => {
    const spellings = ['a.spec.ts', 'a.test.ts', 'a.spec.js', 'a.test.tsx', 'a.spec.mjs', 'a.test.cts'];
    const report = `<testsuite name="s">${spellings
      .map((file) => `<testcase classname="dir\\${file}" name="d › t"/>`)
      .join('')}</testsuite>`;

    expect(readJUnit(report, 'r.xml').map((r) => r.keys[0]?.value)).toEqual(spellings.map((file) => `dir/${file}#d#t`));
  });

  it('is not slowed by a file or a title made of the characters its patterns look for', () => {
    // Foreign text: the patterns above run over whatever the report holds. A class that ends in `$`
    // is quadratic on `.`.repeat(n) + `x` in V8 — that is the size that shows it.
    const nasty = ['.'.repeat(80_000) + 'x', ' › '.repeat(40_000), '@P'.repeat(40_000), '\\'.repeat(80_000)];
    const started = performance.now();
    for (const text of nasty) {
      readJUnit(`<testsuite name="s"><testcase classname="${text}.spec.ts" name="${text}"/></testsuite>`, 'r.xml');
      readJUnit(`<testsuite name="s"><testcase classname="${text}" name="${text}"/></testsuite>`, 'r.xml');
    }
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe('the case a test says it is (plune-ai/cli#38)', () => {
  it('reads a @P<id> token in the title as the case, and leaves the token and the key as the title gave them', () => {
    const results = readJUnit(WINDOWS_REPORT, 'reports/junit.xml');
    const stated = results.filter((r) => r.testCaseId !== undefined);

    expect(stated).toHaveLength(1);
    expect(stated[0]?.testCaseId).toBe('42');
    // Not stripped: the token is part of the title, as it is for the adapter, and the key follows the title.
    expect(stated[0]?.keys).toEqual([
      { kind: 'path-title', value: 'shop/checkout/cart.spec.ts#cart#coupons#keeps its case when renamed @P42' },
    ]);
    expect(stated[0]?.title).toContain('@P42');
  });

  it('keeps a renamed test on its case: the key changes with the title, the token does not', () => {
    const before = readJUnit('<testsuite name="s"><testcase classname="cart" name="adds an item @P42"/></testsuite>', 'a.xml');
    const after = readJUnit('<testsuite name="s"><testcase classname="cart" name="puts an item in the basket @P42"/></testsuite>', 'b.xml');

    expect(before[0]?.keys).not.toEqual(after[0]?.keys);
    expect(before[0]?.testCaseId).toBe('42');
    expect(after[0]?.testCaseId).toBe('42');
  });

  it('reads the token anywhere in a name, wherever another runner puts the describes', () => {
    const jest = '<testsuite name="s"><testcase classname="cart @P8 adds an item" name="cart @P8 adds an item"/></testsuite>';

    expect(readJUnit(jest, 'r.xml')[0]?.testCaseId).toBe('8');
  });

  it('reads a Playwright title the way the reporter does: the test’s own, not a describe’s', () => {
    // The reporter reads `test.title` alone, so a token on a `describe` claims nothing for the tests in it.
    const report = `<testsuite name="cart.spec.ts">
      <testcase classname="cart.spec.ts" name="cart @P5 › adds an item"/>
      <testcase classname="cart.spec.ts" name="cart › adds an item @P6"/>
    </testsuite>`;

    expect(readJUnit(report, 'r.xml').map((r) => r.testCaseId)).toEqual([undefined, '6']);
  });

  it('names no case when there is no id after the @P', () => {
    const bare = '<testsuite name="s"><testcase classname="c" name="see @P for details"/></testsuite>';

    expect(readJUnit(bare, 'r.xml')[0]).not.toHaveProperty('testCaseId');
  });
});

describe('reading the XML itself', () => {
  it('keeps a stack trace that contains a > inside an attribute', () => {
    // The reason this is hand-scanned rather than matched with a regex: a `>` in `message="..."`
    // is ordinary in a stack trace, and a pattern for the tag's end cuts the element in half there.
    const tricky = `<testsuite name="s"><testcase classname="c" name="t"><failure message="expected a > b"/></testcase></testsuite>`;

    expect(readJUnit(tricky, 'r.xml')[0]?.errorContext).toBe('expected a > b');
  });

  it('decodes the entities a writer escapes and leaves CDATA alone', () => {
    const escaped = `<testsuite name="s"><testcase classname="c" name="a &amp; b &lt;x&gt; &#65;">
      <failure message="no"><![CDATA[if (a < b && c > d) {}]]></failure>
    </testcase></testsuite>`;
    const [result] = readJUnit(escaped, 'r.xml');

    expect(result?.keys[0]?.value).toBe('c#a & b <x> A');
    expect(result?.errorContext).toContain('if (a < b && c > d) {}');
  });

  it('leaves an entity nobody defined as written rather than deleting characters', () => {
    // `&nbsp;` in a title is a title we still want; dropping it would change the key the test
    // resolves by, which is worse than an odd-looking name.
    const odd = '<testsuite name="s"><testcase classname="c" name="a&nbsp;b"/></testsuite>';
    expect(readJUnit(odd, 'r.xml')[0]?.keys[0]?.value).toBe('c#a&nbsp;b');
  });

  it('names the file and the line when the report does not parse', () => {
    // "invalid input" tells someone with a 40 MB report from CI nothing at all.
    const broken = `<testsuites>
  <testsuite name="s">
    <testcase classname="c" name="t">
  </testsuite>
</testsuites>`;

    expect(() => readJUnit(broken, 'ci/results.xml')).toThrow(XmlParseError);
    expect(() => readJUnit(broken, 'ci/results.xml')).toThrow(/ci\/results\.xml:4 —/);
  });

  it('refuses a document with no elements instead of importing nothing', () => {
    expect(() => parseXml('   ', 'empty.xml')).toThrow(/empty\.xml:1 — no elements/);
  });

  it('recognises a report by its root, wrapper or not', () => {
    expect(looksLikeJUnit('<?xml version="1.0"?>\n<testsuites>')).toBe(true);
    expect(looksLikeJUnit('<testsuite name="s">')).toBe(true);
    expect(looksLikeJUnit('{"suites":[]}')).toBe(false);
  });
});
