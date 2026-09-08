/**
 * JUnit XML → results the platform already knows how to take.
 *
 * The format nearly every runner can print: Jest, Vitest, pytest, PHPUnit, Surefire, Cypress,
 * Playwright's own `junit` reporter, and most CI plugins. One parser is what opens Plune to a team
 * that already runs tests and only wants them accounted for — the route that needs no LLM provider
 * key, because nothing here is generated (`plune-ai/cli#29`).
 *
 * The vocabulary is not invented here. The platform's default status map already carries a `junit`
 * entry — `pass` / `failure` / `error` / `skipped` — so those four words are the contract, and a
 * project that disagrees overrides the map on its side rather than waiting for a release of this.
 * The same discipline as every adapter (ADR 0023): this file knows the FORMAT, never the platform.
 */

import { resultKey } from '../reporter-core/result-key.js';
import type { KeyRef, PendingResult } from '../reporter-core/types.js';
import { parseXml, type XmlElement } from './xml.js';

/** The key into the project's status map. */
const SOURCE = 'junit';

/** The four words the platform's default map already spells for this format. */
type JUnitStatus = 'pass' | 'failure' | 'error' | 'skipped';

interface Located {
  test: XmlElement;
  /** The nearest enclosing `<testsuite>`, for the fields a case inherits rather than carries. */
  suite: XmlElement | undefined;
}

/** Every `<testcase>`, each paired with the suite it sits in. Suites nest; test cases do not. */
function locate(el: XmlElement, suite: XmlElement | undefined, out: Located[]): void {
  for (const child of el.children) {
    if (child.name === 'testcase') out.push({ test: child, suite });
    else locate(child, child.name === 'testsuite' ? child : suite, out);
  }
}

/**
 * What the runner said happened.
 *
 * `error` outranks `failure` because a case carrying both is saying the assertion failed AND the
 * harness fell over, and the second is the one that makes the first untrustworthy. A case with no
 * outcome child passed — the format states success by saying nothing, which is why «no results»
 * and «everything passed» look alike and the caller counts them.
 */
function outcomeOf(test: XmlElement): { status: JUnitStatus; detail: XmlElement | undefined } {
  for (const name of ['error', 'failure', 'skipped'] as const) {
    const found = test.children.find((c) => c.name === name);
    if (found !== undefined) return { status: name, detail: found };
  }
  return { status: 'pass', detail: undefined };
}

/** The failure's own words: what the writer put in `message`/`type`, then the body it wrapped. */
function errorTextOf(detail: XmlElement | undefined): string {
  if (detail === undefined) return '';
  const head = [detail.attrs['message'], detail.attrs['type']].filter((s) => s !== undefined && s !== '');
  return [...head, detail.text.trim()].filter((s) => s !== '').join('\n\n');
}

/**
 * How this test says who it is.
 *
 * `path-title` and nothing else, because nothing else is in the file. `classname` + `name` is the
 * pair every writer fills and the one a person can also type into a case by hand. It will not
 * always be byte-identical to what the Playwright adapter derives for the same test — the report
 * does not carry the fields the adapter reads — and that is a fact about the format rather than
 * something to paper over: the ranking that decides what matches stays server-side (C2).
 */
function keyOf(classname: string, name: string): KeyRef {
  return { kind: 'path-title', value: classname === '' ? name : `${classname}#${name}` };
}

/**
 * A name a reviewer can judge, for the queue entry an unknown test becomes (D14).
 *
 * `classname › name`, except when the class already ends with the name — Playwright's own JUnit
 * writer puts the whole path in `classname`, and `a › b › b` reads like a bug in us.
 */
function titleOf(classname: string, name: string): string {
  if (classname === '') return name;
  if (classname === name || classname.endsWith(` ${name}`) || classname.endsWith(`›${name}`)) return classname;
  return `${classname} › ${name}`;
}

/**
 * Where the test lives, when the writer said so.
 *
 * `file` is optional in this format and plenty of writers omit it. `classname` is the fallback
 * because it IS an address in the runner's own terms (`tests.test_cart.TestCart`), which is what a
 * reviewer needs to find the test. When neither exists the test simply cannot be offered to the
 * review queue — the caller reports how many, rather than letting them vanish.
 */
function specRefOf(test: XmlElement, suite: XmlElement | undefined, classname: string): string | undefined {
  const file = test.attrs['file'] ?? suite?.attrs['file'] ?? '';
  if (file !== '') {
    const line = test.attrs['line'];
    return line !== undefined && line !== '' ? `${file}:${line}` : file;
  }
  return classname === '' ? undefined : classname;
}

/**
 * When the test ran, if the file is in a position to say.
 *
 * `time` is per case and exact; a start time is not in the format at all. The suite's `timestamp`
 * is the closest thing the file actually contains, so every case in a suite reports the suite's
 * start — approximate, but derived from the report rather than from this machine's clock. Without
 * a `timestamp` there is no honest `startedAt`, and the duration goes unrecorded rather than being
 * hung off a guess: the file's mtime would look exactly like a fact.
 */
function executionOf(test: XmlElement, suite: XmlElement | undefined): PendingResult['execution'] {
  const stamp = suite?.attrs['timestamp'];
  if (stamp === undefined || stamp === '') return undefined;
  const started = new Date(stamp);
  if (Number.isNaN(started.getTime())) return undefined;
  const seconds = Number.parseFloat(test.attrs['time'] ?? '');
  const durationMs = Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : 0;
  return {
    startedAt: started.toISOString(),
    finishedAt: new Date(started.getTime() + durationMs).toISOString(),
    durationMs,
    // The base format has no reruns. Surefire's `<rerunFailure>` does, and reading it is work for
    // the day somebody asks; reporting 0 says «first attempt», which is true of every case here.
    retry: 0,
  };
}

/** Read a JUnit XML report. Throws `XmlParseError`, which names the file and the line. */
export function readJUnit(source: string, file: string): PendingResult[] {
  const doc = parseXml(source, file);
  const found: Located[] = [];
  locate(doc, undefined, found);

  return found.map(({ test, suite }) => {
    const name = test.attrs['name'] ?? '';
    const classname = test.attrs['classname'] ?? test.attrs['class'] ?? '';
    const { status, detail } = outcomeOf(test);
    const key = keyOf(classname, name);
    const specRef = specRefOf(test, suite, classname);
    const errorContext = errorTextOf(detail);
    const execution = executionOf(test, suite);

    return {
      resultKey: resultKey(key.value, 0),
      keys: [key],
      source: SOURCE,
      rawStatus: status,
      title: titleOf(classname, name),
      ...(specRef !== undefined ? { specRef } : {}),
      ...(execution !== undefined ? { execution } : {}),
      ...(errorContext !== '' ? { errorContext } : {}),
    };
  });
}

/** Does this text look like a JUnit report? Read by the format detector, never by a parser. */
export function looksLikeJUnit(source: string): boolean {
  return /<\s*testsuites?\b/.test(source.slice(0, 4096));
}
