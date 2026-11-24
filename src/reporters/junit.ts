// JUnit XML reporter: the run as a file every CI system and `plune run import --format junit` read.
// One `<testsuite>` per eval, because that is the grouping a RunResult has (with several models an
// eval is one suite per model: its id is `<eval>@<model>`), and one `<testcase>` per dataset row.
// The escaping is the one the JUnit files of `plune mcp` use.

import { xmlAttr, xmlNoCommands, xmlText } from '../mcp-testing/report/index.js';
import type { AssertionResultRecord, RowResult, RunResult } from '../types/results.js';
import { aggregateStatus, rowStatus } from '../types/results.js';
import { repeatsText, truncate } from './helpers.js';

const DEFAULT_MAX_OUTPUT = 500;

export interface JunitOptions {
  maxOutputChars?: number;
}

const seconds = (ms: number): string => (ms / 1000).toFixed(3);

const checkLine = (a: AssertionResultRecord): string =>
  `${a.type}${a.score !== undefined ? ` (score ${a.score})` : ''}${a.reason !== undefined ? `: ${a.reason}` : ''}`;

/** The child that says what happened to the row; a passed row has none. */
function outcome(row: RowResult, maxOut: number, dryRun: boolean): string[] {
  const status = rowStatus(row);
  if (status === 'passed') return [];
  // JUnit has one word for a case that gave no verdict; the message keeps ours.
  // A dry run calls no model: its rows are skipped, and the file says why rather than «not judged».
  if (status === 'blocked' || status === 'skipped')
    return [`      <skipped message="${dryRun ? 'dry run (not executed)' : `${status} (not judged)`}"/>`];
  const repeats = repeatsText(row);
  if (status === 'errored') {
    // A report read from a file may hold an error without its code.
    const code = row.error?.code ?? 'error';
    const message = row.error?.message ?? '';
    const body = [...(repeats !== undefined ? [repeats] : []), message].join('\n');
    return [`      <error type="${xmlAttr(code)}" message="${xmlAttr(message)}">${xmlText(body)}</error>`];
  }
  const failed = row.assertions.filter((a) => !a.passed);
  const body = [
    ...(repeats !== undefined ? [repeats] : []),
    ...failed.map(checkLine),
    ...(row.output !== null ? [`\noutput:\n${truncate(row.output, maxOut)}`] : []),
  ].join('\n');
  const type = failed.map((a) => a.type).join(', ');
  const message = failed.map(checkLine).join('; ');
  return [`      <failure type="${xmlAttr(type)}" message="${xmlAttr(message)}">${xmlText(body)}</failure>`];
}

export function renderJunit(result: RunResult, opts: JunitOptions = {}): string {
  const maxOut = opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT;
  const totals = { tests: 0, failures: 0, errors: 0 };
  const suites: string[] = [];
  for (const ev of result.evals) {
    const statuses = ev.rows.map(rowStatus);
    const count = (...which: string[]): number => statuses.filter((s) => which.includes(s)).length;
    const time = ev.rows.reduce((ms, row) => ms + (row.latency_ms ?? 0), 0);
    totals.tests += statuses.length;
    totals.failures += count('failed');
    totals.errors += count('errored');
    suites.push(
      `  <testsuite name="${xmlAttr(ev.id)}" tests="${statuses.length}" failures="${count('failed')}" errors="${count('errored')}" skipped="${count('blocked', 'skipped')}" time="${seconds(time)}" timestamp="${xmlAttr(result.started_at)}">`,
      '    <properties>',
      `      <property name="plune.status" value="${aggregateStatus(statuses)}"/>`,
      '    </properties>',
    );
    // `classname#name` is the key `plune run import` matches a case on: two rows with the same variables get a number.
    const seen = new Map<string, number>();
    for (const row of ev.rows) {
      // `@P<id>` in a title is the case id to `plune run import`; an address like «bob@Proton.me» is not one. The JSON
      // escape of `@` keeps the name the same JSON value and takes the token away.
      const vars = JSON.stringify(row.vars).replace(/@(?=P[A-Za-z0-9_-])/g, '\\u0040');
      const nth = (seen.get(vars) ?? 0) + 1;
      seen.set(vars, nth);
      const name = nth === 1 ? vars : `${vars} #${nth}`;
      const time = row.latency_ms !== undefined ? ` time="${seconds(row.latency_ms)}"` : '';
      const head = `    <testcase classname="${xmlAttr(ev.id)}" name="${xmlAttr(name)}"${time}`;
      const child = outcome(row, maxOut, result.dry_run === true);
      suites.push(...(child.length === 0 ? [`${head}/>`] : [`${head}>`, ...child, '    </testcase>']));
    }
    suites.push('  </testsuite>');
  }
  return xmlNoCommands(
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<testsuites name="plune run" tests="${totals.tests}" failures="${totals.failures}" errors="${totals.errors}" time="${seconds(result.summary.duration_ms)}">`,
      ...suites,
      '</testsuites>',
      '',
    ].join('\n'),
  );
}
