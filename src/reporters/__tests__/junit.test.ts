import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateXML } from 'xmllint-wasm';
import { readJUnit } from '../../importers/junit.js';
import { parseXml, type XmlElement } from '../../importers/xml.js';
import type { RowResult, RunResult } from '../../types/results.js';
import { renderReport } from '../index.js';
import { renderJunit } from '../junit.js';
import { allPass, dryRun, mixed } from './fixtures.js';

const XSD = readFileSync(fileURLToPath(new URL('./fixtures/junit-10.xsd', import.meta.url)), 'utf8');

const pass = { type: 'contains', passed: true };

function run(evals: RunResult['evals'], summary: Partial<RunResult['summary']> = {}): RunResult {
  return {
    schemaVersion: 1,
    plune_version: '0.1.0',
    started_at: '2026-11-25T09:00:00.000Z',
    finished_at: '2026-11-25T09:00:02.500Z',
    config_hash: 'e'.repeat(64),
    summary: { total: 0, passed: 0, failed: 0, errored: 0, cost_usd: 0, duration_ms: 2500, ...summary },
    evals,
  };
}

// One row of every status, two evals, a repeated row and two rows with the same variables.
const everyStatus: RunResult = run(
  [
    {
      id: 'greeting',
      tags: [],
      passed: false,
      rows: [
        { vars: { name: 'John Doe' }, output: 'Hello, John Doe', cached: false, latency_ms: 120, assertions: [pass] },
        {
          vars: { name: 'John Doe', email: 'user@plune.ai' },
          output: 'Hi',
          cached: false,
          latency_ms: 80,
          assertions: [
            pass,
            { type: 'llm-judge', passed: false, score: 0.3, reason: 'too terse' },
            { type: 'contains', passed: false },
          ],
        },
        {
          vars: { name: '' },
          output: null,
          cached: false,
          error: { code: 'PROVIDER_TRANSIENT_EXHAUSTED', message: 'provider down' },
          assertions: [],
        },
      ],
    },
    {
      id: 'farewell',
      tags: ['smoke'],
      passed: false,
      rows: [
        { vars: { q: 1 }, output: null, cached: false, inconclusive: 'blocked', assertions: [] },
        { vars: { q: 1 }, output: null, cached: false, inconclusive: 'skipped', assertions: [] },
        {
          vars: { q: 2 },
          output: 'Bye',
          cached: false,
          latency_ms: 300,
          assertions: [{ type: 'contains', passed: false, reason: 'no "Goodbye"' }],
          attempts: {
            runs: 3,
            pass_threshold: 0.7,
            passed: 1,
            failed: 2,
            errored: 0,
            results: [true, false, false].map((passed) => ({
              output: 'Bye',
              cached: false,
              assertions: [{ type: 'contains', passed }],
            })),
          },
        },
      ],
    },
  ],
  { total: 6, passed: 1, failed: 2, errored: 1, blocked: 1, skipped: 1 },
);

const root = (xml: string): XmlElement => parseXml(xml, 'report.xml').children.find((c) => c.name === 'testsuites')!;
const suitesOf = (xml: string): XmlElement[] => root(xml).children.filter((c) => c.name === 'testsuite');
const casesOf = (suite: XmlElement): XmlElement[] => suite.children.filter((c) => c.name === 'testcase');
const sum = (xs: XmlElement[], attr: string): number => xs.reduce((n, x) => n + Number(x.attrs[attr]), 0);

/** What the JUnit schema says against a document: no line when it is valid. */
async function schemaErrors(xml: string): Promise<string[]> {
  const res = await validateXML({
    xml: [{ fileName: 'report.xml', contents: xml }],
    schema: [{ fileName: 'junit-10.xsd', contents: XSD }],
  });
  return res.errors.map((e) => e.message);
}

describe('CLI · run --format junit · the document', () => {
  it('is what the dispatcher gives for junit', () => {
    expect(renderReport(everyStatus, 'junit')).toBe(renderJunit(everyStatus));
  });

  it('one suite per eval, one case per row, the eval id as classname', () => {
    const suites = suitesOf(renderJunit(everyStatus));
    expect(suites.map((s) => s.attrs['name'])).toEqual(['greeting', 'farewell']);
    expect(suites.map((s) => casesOf(s).length)).toEqual([3, 3]);
    expect(casesOf(suites[0]!).map((c) => c.attrs['classname'])).toEqual(['greeting', 'greeting', 'greeting']);
  });

  it('names a case by the variables of its row; a second row with the same ones gets a number', () => {
    const [, farewell] = suitesOf(renderJunit(everyStatus));
    expect(casesOf(farewell!).map((c) => c.attrs['name'])).toEqual(['{"q":1}', '{"q":1} #2', '{"q":2}']);
  });

  it('the counts of the suites add up to the summary, and the root carries the totals', () => {
    const xml = renderJunit(everyStatus);
    const suites = suitesOf(xml);
    const s = everyStatus.summary;
    expect(sum(suites, 'tests')).toBe(s.total);
    expect(sum(suites, 'failures')).toBe(s.failed);
    expect(sum(suites, 'errors')).toBe(s.errored);
    expect(sum(suites, 'skipped')).toBe(s.blocked! + s.skipped!);
    expect(root(xml).attrs).toMatchObject({ name: 'plune run', tests: '6', failures: '2', errors: '1' });
  });

  it('time is in seconds: the row, the suite as the sum of its rows, the root as the run', () => {
    const xml = renderJunit(everyStatus);
    const [greeting] = suitesOf(xml);
    expect(casesOf(greeting!).map((c) => c.attrs['time'])).toEqual(['0.120', '0.080', undefined]);
    expect(greeting!.attrs['time']).toBe('0.200');
    expect(root(xml).attrs['time']).toBe('2.500');
    expect(greeting!.attrs['timestamp']).toBe('2026-11-25T09:00:00.000Z');
  });

  it('a failed row is a <failure> with the reasons of its failed checks and the output', () => {
    const failure = casesOf(suitesOf(renderJunit(everyStatus))[0]!)[1]!.children[0]!;
    expect(failure.name).toBe('failure');
    expect(failure.attrs['type']).toBe('llm-judge, contains');
    expect(failure.attrs['message']).toBe('llm-judge (score 0.3): too terse; contains');
    expect(failure.text).toContain('llm-judge (score 0.3): too terse\ncontains');
    expect(failure.text).toContain('output:\nHi');
  });

  it('a repeated row says how many of its runs passed', () => {
    const failure = casesOf(suitesOf(renderJunit(everyStatus))[1]!)[2]!.children[0]!;
    expect(failure.text).toContain('1/3 passed (pass_threshold 0.7): failed');
  });

  it('an errored row is an <error> with the code and the message', () => {
    const error = casesOf(suitesOf(renderJunit(everyStatus))[0]!)[2]!.children[0]!;
    expect(error.name).toBe('error');
    expect(error.attrs).toEqual({ type: 'PROVIDER_TRANSIENT_EXHAUSTED', message: 'provider down' });
    expect(error.text).toBe('provider down');
  });

  it('a repeated row that errored, and a failed row with no output, read the same way', () => {
    const attempts = { runs: 2, pass_threshold: 1, passed: 0, failed: 0, errored: 2 };
    const down = { code: 'PROVIDER_TRANSIENT_EXHAUSTED', message: 'provider down' };
    const one = { output: null, cached: false, error: down, assertions: [] };
    const xml = renderJunit(
      run([
        {
          id: 'e',
          tags: [],
          passed: false,
          rows: [
            { vars: {}, ...one, attempts: { ...attempts, results: [one, one] } },
            { vars: { n: 1 }, output: null, cached: false, assertions: [{ type: 'contains', passed: false }] },
          ],
        },
      ]),
    );
    const [errored, failed] = casesOf(suitesOf(xml)[0]!);
    expect(errored!.children[0]!.text).toBe('0/2 passed (pass_threshold 1): errored\nprovider down');
    expect(failed!.children[0]!.text).toBe('contains');
  });

  it('a blocked and a skipped row are both <skipped>, and the message says which', () => {
    const [blocked, skipped] = casesOf(suitesOf(renderJunit(everyStatus))[1]!);
    expect(blocked!.children.map((c) => [c.name, c.attrs['message']])).toEqual([['skipped', 'blocked (not judged)']]);
    expect(skipped!.children.map((c) => [c.name, c.attrs['message']])).toEqual([['skipped', 'skipped (not judged)']]);
  });

  it('a suite says the status of its eval, rolled up from the rows', () => {
    const status = (s: XmlElement) =>
      s.children.find((c) => c.name === 'properties')!.children.find((p) => p.attrs['name'] === 'plune.status')!
        .attrs['value'];
    expect(suitesOf(renderJunit(everyStatus)).map(status)).toEqual(['failed', 'failed']);
    expect(suitesOf(renderJunit(mixed)).map(status)).toEqual(['passed', 'failed', 'errored']);
    const noRows = run([{ id: 'empty', tags: [], passed: true, rows: [] }]);
    expect(suitesOf(renderJunit(noRows)).map(status)).toEqual(['skipped']);
  });

  it('a passed row is a case with no child', () => {
    const cases = suitesOf(renderJunit(allPass)).flatMap(casesOf);
    expect(cases).toHaveLength(allPass.summary.total);
    expect(cases.flatMap((c) => c.children)).toEqual([]);
  });

  it('cuts a long output to maxOutputChars', () => {
    const long = run([
      { id: 'e', tags: [], passed: false, rows: [{ vars: {}, output: 'x'.repeat(50), cached: false, assertions: [{ type: 'contains', passed: false }] }] },
    ]);
    const xml = renderReport(long, 'junit', { maxOutputChars: 10 });
    expect(xml).toContain(`output:\n${'x'.repeat(10)}… (truncated)`);
    expect(xml).not.toContain('x'.repeat(11));
  });
});

describe('CLI · run --format junit · read back by run import', () => {
  it('gives the same number of cases per status and the same names', () => {
    const results = readJUnit(renderJunit(everyStatus), 'report.xml');
    // The import knows four words; a blocked and a skipped row both arrive as `skipped`.
    const count = (s: string) => results.filter((r) => r.rawStatus === s).length;
    const s = everyStatus.summary;
    expect(results).toHaveLength(s.total);
    expect(count('pass')).toBe(s.passed);
    expect(count('failure')).toBe(s.failed);
    expect(count('error')).toBe(s.errored);
    expect(count('skipped')).toBe(s.blocked! + s.skipped!);
    expect(results.map((r) => r.keys[0]!.value)).toEqual([
      'greeting#{"name":"John Doe"}',
      'greeting#{"name":"John Doe","email":"user@plune.ai"}',
      'greeting#{"name":""}',
      'farewell#{"q":1}',
      'farewell#{"q":1} #2',
      'farewell#{"q":2}',
    ]);
    expect(new Set(results.map((r) => r.resultKey)).size).toBe(s.total);
    expect(results[1]!.errorContext).toContain('too terse');
    expect(results[0]!.execution).toMatchObject({ startedAt: '2026-11-25T09:00:00.000Z', durationMs: 120 });
  });

  it('an address like bob@Proton.me in the variables is not read as a case id, and the name is still their JSON', () => {
    const vars = { email: 'bob@Proton.me', note: '@P123' };
    const one = run([{ id: 'mail', tags: [], passed: true, rows: [{ vars, output: 'ok', cached: false, assertions: [pass] }] }], { total: 1, passed: 1 });
    const xml = renderJunit(one);
    const [read] = readJUnit(xml, 'report.xml');
    expect(read).not.toHaveProperty('testCaseId');
    const name = casesOf(suitesOf(xml)[0]!)[0]!.attrs['name']!;
    expect(JSON.parse(name)).toEqual(vars);
  });

  it('a dry run says so on every row, and an error without a code still makes a document', () => {
    const row = { vars: { q: 1 }, output: null, cached: false, assertions: [] };
    expect(renderJunit(dryRun)).not.toContain('not judged');
    expect(renderJunit(dryRun)).toContain('<skipped message="dry run (not executed)"/>');
    const broken = run([{ id: 'e', tags: [], passed: false, rows: [{ ...row, error: {} as RowResult['error'] }] }], { total: 1, errored: 1 });
    expect(renderJunit(broken)).toContain('<error type="error" message="">');
    expect(renderJunit(broken).endsWith('</testsuites>\n')).toBe(true);
  });
});

describe('CLI · run --format junit · the schema', () => {
  it.each([
    ['every status', everyStatus],
    ['failed and errored evals', mixed],
    ['all passed', allPass],
    ['a dry run', dryRun],
    ['no evals', run([])],
  ])('validates against the JUnit XSD: %s', async (_name, result) => {
    expect(await schemaErrors(renderJunit(result))).toEqual([]);
  });

  // The check can fail: the schema requires a name on a suite and knows no <verdict> element.
  it.each([
    ['a suite without its name', (xml: string) => xml.replace(/<testsuite name="[^"]*"/, '<testsuite')],
    ['an element JUnit does not have', (xml: string) => xml.replace('</testsuite>', '<verdict/></testsuite>')],
  ])('the validator refuses a document that is not JUnit: %s', async (_name, breakIt) => {
    const xml = renderJunit(allPass);
    const broken = breakIt(xml);
    expect(broken).not.toBe(xml);
    expect(await schemaErrors(broken)).not.toEqual([]);
  });
});

describe('CLI · run --format junit · text from a model', () => {
  // A control character, a lone surrogate, U+FFFF, the end of a CDATA section, markup and a quote.
  const nasty = 'a\u0000b\u0008c\ud800d￿ ]]> <b>&"\'\n::error::x ##[group]';
  const row: RowResult = {
    vars: { q: nasty },
    output: nasty,
    cached: false,
    assertions: [{ type: 'contains', passed: false, reason: nasty }],
  };
  const hostile = run(
    [
      { id: `e ${nasty}`, tags: [], passed: false, rows: [row, { ...row, error: { code: nasty, message: nasty } }] },
    ],
    { total: 2, failed: 1, errored: 1 },
  );

  it('stays a document a parser reads and the schema accepts', async () => {
    const xml = renderJunit(hostile);
    expect(() => parseXml(xml, 'report.xml')).not.toThrow();
    expect(await schemaErrors(xml)).toEqual([]);
    expect(xml).not.toContain(']]>');
    expect(xml).not.toMatch(/[\u0000-\u0008\ud800￿]/);
  });

  it('keeps the text that XML can hold', () => {
    const [failed] = casesOf(suitesOf(renderJunit(hostile))[0]!);
    expect(failed!.children[0]!.text).toContain('abcd ]]> <b>&"\'');
    expect(readJUnit(renderJunit(hostile), 'report.xml').map((r) => r.rawStatus)).toEqual(['failure', 'error']);
  });

  it('no line of it starts a GitHub workflow command', () => {
    const xml = renderJunit(hostile);
    expect(xml).not.toMatch(/^\s*::/m);
    expect(xml).not.toContain('##[');
  });
});
