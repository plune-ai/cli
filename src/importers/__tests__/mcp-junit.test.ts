import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readReport } from '../index.js';
import { parseXml, type XmlElement } from '../xml.js';

/**
 * The JUnit files `plune mcp lint|check|diff|conformance --reporter junit-xml` write, read by the parser
 * `plune run import` uses. The writer marks each case by the child it gives it and that child's `type`; the import
 * keeps only the child's name as `rawStatus`. So the guard is on that pair: a check that could not run is an
 * `<error>`, which the import must not read as a pass, and a check that was not applicable is a `<skipped>`.
 */

const DIR = fileURLToPath(
  new URL('../../mcp-testing/__tests__/fixtures/reports/', import.meta.url),
);
const FILES = readdirSync(DIR).filter((f) => f.endsWith('.xml'));

/** What the writer says of each case: the outcome child and its `type`, `pass` for a case with neither. */
function marks(source: string, file: string): string[] {
  const out: string[] = [];
  const walk = (el: XmlElement) => {
    for (const child of el.children) {
      if (child.name !== 'testcase') {
        walk(child);
        continue;
      }
      const outcome = child.children.find((c) => ['error', 'failure', 'skipped'].includes(c.name));
      out.push(outcome === undefined ? 'pass' : `${outcome.name}:${outcome.attrs['type'] ?? ''}`);
    }
  };
  walk(parseXml(source, file));
  return out;
}

/** The writer's mark → the import's `rawStatus`, for every mark the commands write today. */
const EXPECTED: Record<string, string> = {
  pass: 'pass',
  'failure:deterministic': 'failure',
  'error:could-not-run': 'error',
  'skipped:not-applicable': 'skipped',
  'skipped:advisory': 'skipped',
  'skipped:pending': 'skipped',
};

describe('CLI · run import · JUnit · the reports of plune mcp', () => {
  it('has the fixtures to read', () => {
    expect(FILES.length).toBeGreaterThan(0);
  });

  it.each(FILES)('%s: no case that could not run is imported as passed', (name) => {
    const file = path.join(DIR, name);
    const source = readFileSync(file, 'utf8');
    const { format, results } = readReport(source, file);
    const seen = marks(source, file);

    expect(format).toBe('junit');
    expect(results.map((r) => r.rawStatus)).toEqual(
      seen.map((m) => EXPECTED[m] ?? `unknown mark ${m}`),
    );
  });

  it('a could-not-run case is in the fixtures, so the rule above is exercised', () => {
    const all = FILES.flatMap((f) => marks(readFileSync(path.join(DIR, f), 'utf8'), f));
    expect(all).toContain('error:could-not-run');
    expect(all).toContain('skipped:not-applicable');
  });
});

describe('CLI · run import · JUnit · the tools a case of plune mcp is about', () => {
  const read = (name: string) => {
    const file = path.join(DIR, name);
    return readReport(readFileSync(file, 'utf8'), file).results;
  };
  const targetsByKey = (name: string) =>
    Object.fromEntries(
      read(name)
        .filter((r) => r.targets !== undefined)
        .map((r) => [r.keys[0]?.value, r.targets]),
    );

  it('each plune.mcp.tool property is a target of the result; the key stays classname#name', () => {
    expect(targetsByKey('check-smoke.xml')).toEqual({
      'mcp.check#smoke': ['read_error', 'read_ok', 'read_rpc_error'],
    });
    expect(targetsByKey('lint-mixed.xml')['mcp.lint#input-schema-not-object']).toEqual(['broken']);
    expect(targetsByKey('conformance-bad.xml')).toEqual({});
    // A case about no tool sends no `targets` key at all, not an empty list.
    expect(
      read('check-smoke.xml').find((r) => r.keys[0]?.value === 'mcp.check#ping'),
    ).not.toHaveProperty('targets');
  });

  it('only plune.mcp.tool feeds targets: trimmed, distinct, a value the platform refuses left out', () => {
    const xml = `<testsuite><testcase classname="c" name="n"><properties>
      <property name="plune.mcp.tool" value=" b "/>
      <property name="plune.mcp.tool" value="b"/>
      <property name="plune.mcp.tool" value="   "/>
      <property name="plune.mcp.tool" value="${'x'.repeat(201)}"/>
      <property name="plune.mcp.tool" value="a"/>
      <property name="browser" value="chromium"/>
    </properties></testcase></testsuite>`;
    expect(readReport(xml, 'r.xml').results[0]?.targets).toEqual(['b', 'a']);
    const many = Array.from(
      { length: 60 },
      (_, i) => `<property name="plune.mcp.tool" value="t${i}"/>`,
    ).join('');
    const capped = `<testsuite><testcase classname="c" name="n"><properties>${many}</properties></testcase></testsuite>`;
    expect(readReport(capped, 'r.xml').results[0]?.targets).toHaveLength(50);
  });
});
