/**
 * The report formats every `plune mcp` command that tests a server shares, and the flags that choose them. One run
 * (./model.ts) in, five renderers out: `human`, `json`, `github`, `markdown`, `junit-xml`. A renderer gets the run
 * already masked (the commands mask server text as they build their report) and printable; it adds the escaping of
 * its own format and nothing else.
 */

import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { UsageError } from '../connect/options.js';
import type { McpCheckReport, McpConformanceReport, McpDiffReport, McpReport } from '../result.js';
import { markdownCell } from '../snapshot/index.js';
import {
  checkHuman,
  conformanceHuman,
  diffHuman,
  diffMarkdown,
  lintHuman,
  noCommands,
  noCommandsJson,
} from './human.js';
import type { McpRun, ReportCheck } from './model.js';
import type { ReportFormat, ReportOutputs } from './options.js';

export * from './model.js';
export * from './options.js';
export { checkRun, conformanceRun, diffRun, lintRun } from './runs.js';

const firstLine = (text: string) => text.split(/\r?\n/)[0] ?? '';

/** Lines GitHub turns into an annotation start with this; ours are the only ones (see `noCommands`). */
const COMMAND = '::';

/**
 * Every text is built first, stdout and each file: a renderer that fails leaves no file behind. Then the files, each
 * through a temporary file beside it renamed over it, then stdout: the exit code is the one the files record,
 * whatever happens to the printing. A relative path is read from `cwd`, else from this process's folder.
 */
export function writeReport(
  run: McpRun,
  outputs: ReportOutputs,
  io: { out(text: string): void; err(text: string): void; cwd?: string },
): void {
  const files: { name: string; path: string; text: string }[] = [];
  let building: ReportFormat = outputs.format;
  let stdout: string;
  try {
    for (const f of outputs.files) {
      building = f.format;
      files.push({
        name: f.path,
        path: resolve(io.cwd ?? '.', f.path),
        text: render(run, f.format),
      });
    }
    building = outputs.format;
    stdout = render(run, outputs.format);
  } catch (err) {
    throw new UsageError(
      `could not build the ${building} report (${firstLine((err as Error).message)}); no file was written.`,
    );
  }
  writeFiles(files);
  try {
    io.out(stdout);
  } catch (err) {
    io.err(`plune mcp ${run.command}: could not print the report (${(err as Error).message}).\n`);
  }
}

/**
 * Each file is whole or not there: written to a temporary file in its own folder, then renamed over the target. The
 * set is not one step on the file system: a rename that fails after others leaves those files written, and the error
 * names them. `reportOutputs` refuses the usual causes (two flags for one file, a folder, a missing folder) before
 * the server is reached.
 */
function writeFiles(files: { name: string; path: string; text: string }[]): void {
  const temps = files.map((f, i) =>
    join(dirname(f.path), `.${basename(f.path)}.${process.pid}.${i}.tmp`),
  );
  const drop = (from: number) => {
    for (const t of temps.slice(from)) rmSync(t, { force: true });
  };
  const code = (err: unknown) => (err as NodeJS.ErrnoException).code ?? 'error';
  for (const [i, f] of files.entries()) {
    try {
      writeFileSync(temps[i] ?? '', f.text);
    } catch (err) {
      drop(0);
      throw new UsageError(`--out: could not write ${f.name} (${code(err)}); no file was written.`);
    }
  }
  const written: string[] = [];
  for (const [i, f] of files.entries()) {
    try {
      renameSync(temps[i] ?? '', f.path);
      written.push(f.name);
    } catch (err) {
      drop(i);
      const kept = written.length === 0 ? 'no file was written' : `written: ${written.join(', ')}`;
      throw new UsageError(`--out: could not write ${f.name} (${code(err)}); ${kept}.`);
    }
  }
}

/** One format of a run, with the workflow commands of its text neutralized (see `noCommands`). */
export function render(run: McpRun, format: ReportFormat): string {
  switch (format) {
    case 'json':
      return noCommandsJson(`${JSON.stringify(run.document, null, 2)}\n`);
    case 'human':
      return noCommands(
        run.command === 'lint'
          ? lintHuman(run.document as McpReport, { showInfo: run.showInfo })
          : run.command === 'check'
            ? checkHuman(run.document as McpCheckReport)
            : run.command === 'conformance'
              ? conformanceHuman(run.document as McpConformanceReport)
              : diffHuman(run.document as McpDiffReport),
      );
    case 'markdown':
      return noCommands(
        run.command === 'diff' ? diffMarkdown(run.document as McpDiffReport) : markdown(run),
      );
    case 'github':
      return github(run);
    case 'junit-xml':
      return junitXml(run);
  }
}

// --- states over a case ---

/** The checks a person is shown: not the passed ones, and lint's info findings only with --show-info. */
const shown = (run: McpRun) =>
  run.checks.filter(
    (c) =>
      c.state !== 'passed' &&
      c.state !== 'not-applicable' &&
      (c.level !== 'info' || run.showInfo || c.state === 'could-not-run'),
  );

type CaseOutcome =
  | { kind: 'pass' }
  | { kind: 'error' | 'failure' | 'skipped'; type: string; message: string; checks: ReportCheck[] };

/**
 * A case's outcome from its checks, the worst first: anything that could not run is an `error` (never a pass, never
 * skipped); a failed check is a `failure` when it fails the command's own gate, else advice (`advisory`, set by the
 * command's adapter in ./runs.ts), `skipped`; then `pending` and `not-applicable`, both `skipped`; a case with none
 * of these passed. So the exit code is 1 exactly when a case failed.
 */
function outcomeOf(checks: ReportCheck[]): CaseOutcome {
  const pick = (
    kind: 'error' | 'failure' | 'skipped',
    type: string,
    prefix: string,
    hit: ReportCheck[],
  ): CaseOutcome => {
    const first = hit[0] as ReportCheck;
    const target = first.target === '' ? '' : `${first.target}: `;
    const more = hit.length > 1 ? ` (and ${hit.length - 1} more)` : '';
    return { kind, type, message: `${prefix}${target}${first.message}${more}`, checks: hit };
  };
  const by = (f: (c: ReportCheck) => boolean) => checks.filter(f);
  const cnr = by((c) => c.state === 'could-not-run');
  if (cnr.length > 0) return pick('error', 'could-not-run', 'could-not-run: ', cnr);
  const failed = by((c) => c.state === 'failed' && c.advisory !== true);
  if (failed.length > 0) return pick('failure', failed[0]?.class ?? 'deterministic', '', failed);
  const advice = by((c) => c.state === 'failed');
  if (advice.length > 0) return pick('skipped', 'advisory', 'advisory: ', advice);
  const pending = by((c) => c.state === 'pending');
  if (pending.length > 0) return pick('skipped', 'pending', 'pending: ', pending);
  const na = by((c) => c.state === 'not-applicable');
  if (na.length > 0) return pick('skipped', 'not-applicable', 'not-applicable: ', na);
  return { kind: 'pass' };
}

interface Case {
  id: string;
  title: string;
  suite?: string;
  outcome: CaseOutcome;
  durationMs: number | null;
}

/** The fixed cases with their outcomes; nothing measured is one `run` case that could not run, never an empty list. */
function casesOf(run: McpRun): Case[] {
  if (run.cases.length === 0) {
    const check: ReportCheck = {
      id: 'run',
      title: `plune mcp ${run.command}`,
      target: '',
      state: 'could-not-run',
      class: 'deterministic',
      level: 'error',
      message: `nothing was measured: ${run.nothing}`,
      expected: 'at least one check that ran',
      actual: run.nothing,
      fix: 'Point the command at a server that lists what it checks.',
      specRef: '',
      durationMs: null,
    };
    return [{ id: 'run', title: check.title, outcome: outcomeOf([check]), durationMs: null }];
  }
  return run.cases.map(({ id, title, suite }) => {
    const mine = run.checks.filter((c) => c.id === id);
    const timed = mine.filter((c) => c.durationMs !== null);
    return {
      id,
      title,
      ...(suite === undefined ? {} : { suite }),
      outcome: outcomeOf(mine),
      durationMs:
        timed.length === 0 ? null : timed.reduce((sum, c) => sum + (c.durationMs ?? 0), 0),
    };
  });
}

const count = (cases: Case[], kind: CaseOutcome['kind'], type?: string) =>
  cases.filter(
    (c) =>
      c.outcome.kind === kind &&
      (type === undefined || ('type' in c.outcome && c.outcome.type === type)),
  ).length;

function tally(cases: Case[]): string {
  const failed = count(cases, 'failure');
  const cnr = count(cases, 'error');
  const passed = count(cases, 'pass');
  const skipped = count(cases, 'skipped');
  return `${passed} passed, ${failed} failed, ${cnr} could not run, ${skipped} advisory or not applicable`;
}

const detailOf = (c: ReportCheck) =>
  [
    `${c.target === '' ? '' : `${c.target}: `}${c.message}`,
    `expected: ${c.expected}`,
    `actual: ${c.actual}`,
    `fix: ${c.fix}`,
    ...(c.specRef === '' ? [] : [`spec: ${c.specRef}`]),
  ].join('\n');

// --- github ---

/**
 * Annotations GitHub keeps per step: "GitHub Actions are limited to 10 warning annotations and 10 error annotations
 * per step." (https://docs.github.com/en/rest/checks/runs). The notice limit is not confirmed by the documentation;
 * it is taken as the same 10. Past a limit the rest are counted in one plain line.
 */
export const ANNOTATION_LIMITS = { error: 10, warning: 10, notice: 10 } as const;

/**
 * Rows of the Markdown table of lint and check, and checks spelled out in one JUnit case: the first ones, then one
 * line with how many more the JSON report holds. A pull request comment is limited in size, and 100 000 rows read as
 * none.
 */
export const MARKDOWN_ROWS = 200;
const andMore = (n: number) => `… and ${n} more in the full report.`;

/**
 * The escaping of the Actions runner (actions/runner, src/Runner.Common/ActionCommand.cs): in the message `%`, `\r`
 * and `\n`; in a property `:` and `,` as well. `%` first, or the `%` of an escape would be escaped again.
 */
const escapeData = (s: string) =>
  s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProperty = (s: string) => escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
/** Server text in an annotation cannot carry the older command form either (see `noCommands`). */
const noLegacy = (s: string) => s.replaceAll('##[', '##?[');

/** Failed by its level; could-not-run as a warning (not measured, not a violation); anything else is not annotated. */
function annotationOf(c: ReportCheck): keyof typeof ANNOTATION_LIMITS | undefined {
  if (c.state === 'could-not-run') return 'warning';
  if (c.state !== 'failed') return undefined;
  return c.level === 'error' ? 'error' : c.level === 'warn' ? 'warning' : 'notice';
}

/**
 * One line per annotation, without `file=`: the finding is about a server, not a line of this repository, so GitHub
 * shows it on the run's page. The message cannot end the line or open a second command: its new lines are escaped.
 */
function github(run: McpRun): string {
  const used = { error: 0, warning: 0, notice: 0 };
  let more = 0;
  const lines: string[] = [];
  const checks =
    run.cases.length === 0
      ? casesOf(run).flatMap((c) => ('checks' in c.outcome ? c.outcome.checks : []))
      : shown(run);
  for (const c of checks) {
    const kind = annotationOf(c);
    if (kind === undefined) continue;
    if (used[kind] >= ANNOTATION_LIMITS[kind]) {
      more++;
      continue;
    }
    used[kind]++;
    const title = `${c.state === 'could-not-run' ? 'could not run: ' : ''}${c.id}${c.target === '' ? '' : ` ${c.target}`}`;
    lines.push(
      `${COMMAND}${kind} title=${escapeProperty(noLegacy(title))}${COMMAND}${escapeData(noLegacy(detailOf(c)))}`,
    );
  }
  const tail = [
    ...(more > 0
      ? [
          `${more} more in the report: GitHub keeps ${ANNOTATION_LIMITS.error} error and ${ANNOTATION_LIMITS.warning} warning annotations per step.`,
        ]
      : []),
    `plune mcp ${run.command}: ${tally(casesOf(run))}; exit ${run.document.exitCode}.`,
  ];
  return `${[...lines, ...tail.map(noCommands)].join('\n')}\n`;
}

// --- markdown ---

/** lint and check as a pull request comment: a hidden marker of the command, the tally, and what did not pass. */
function markdown(run: McpRun): string {
  const cases = casesOf(run);
  const rows =
    run.cases.length === 0
      ? cases.flatMap((c) => ('checks' in c.outcome ? c.outcome.checks : []))
      : shown(run);
  const lines = [
    `<!-- plune-mcp-${run.command} -->`,
    `### MCP ${run.command}`,
    '',
    `**Exit ${run.document.exitCode}** — ${tally(cases)}`,
    '',
  ];
  if (rows.length === 0) lines.push('Nothing to show: every check that applies passed.');
  else {
    lines.push(
      '| State | Level | Check | Target | Expected | Actual | Fix |',
      '| --- | --- | --- | --- | --- | --- | --- |',
    );
    // One row at a time: a server's list can hold more findings than one call takes arguments.
    for (const c of rows.slice(0, MARKDOWN_ROWS))
      lines.push(
        `| ${c.state} | ${c.level} | ${markdownCell(c.id)} | ${markdownCell(c.target)} | ${markdownCell(c.expected)} | ${markdownCell(c.actual)} | ${markdownCell(c.fix)} |`,
      );
    if (rows.length > MARKDOWN_ROWS) lines.push('', andMore(rows.length - MARKDOWN_ROWS));
  }
  return `${lines.join('\n')}\n`;
}

// --- junit-xml ---

/**
 * What XML 1.0 does not allow (https://www.w3.org/TR/xml/#charsets): C0 controls but tab, new line and carriage
 * return; U+FFFE and U+FFFF; a surrogate without its pair. Removed, not replaced: a parser refuses the whole file for
 * one of them.
 */
const NOT_XML =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
export const xmlChars = (s: string): string => s.replace(NOT_XML, '');
const xmlText = (s: string) =>
  xmlChars(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** In an attribute a new line or tab would be read back as a space: kept as character references. */
const xmlAttr = (s: string) =>
  xmlText(s)
    .replace(/"/g, '&quot;')
    .replace(/\t/g, '&#9;')
    .replace(/\n/g, '&#10;')
    .replace(/\r/g, '&#13;');

/**
 * One `<testsuite>` of the fixed cases, `classname` `mcp.<command>` (`mcp.conformance.<suite>`) and `name` the case
 * id: no count, version or time in either, so `classname#name` (the key `plune run import` matches on) is the same on
 * every run. `time` is the only field that differs between two runs of one server; there is no `timestamp`.
 */
function junitXml(run: McpRun): string {
  const cases = casesOf(run);
  const suite = `plune mcp ${run.command}`;
  const totals = `tests="${cases.length}" failures="${count(cases, 'failure')}" errors="${count(cases, 'error')}" skipped="${count(cases, 'skipped')}"`;
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="${suite}" ${totals}>`,
    `  <testsuite name="${suite}" ${totals}>`,
  ];
  for (const c of cases) {
    const time = c.durationMs === null ? '' : ` time="${(c.durationMs / 1000).toFixed(3)}"`;
    const classname = c.suite === undefined ? `mcp.${run.command}` : `mcp.${run.command}.${c.suite}`;
    const head = `    <testcase classname="${xmlAttr(classname)}" name="${xmlAttr(c.id)}"${time}`;
    if (c.outcome.kind === 'pass') {
      lines.push(`${head}/>`);
      continue;
    }
    const { checks } = c.outcome;
    const body = [
      ...checks.slice(0, MARKDOWN_ROWS).map(detailOf),
      ...(checks.length > MARKDOWN_ROWS ? [andMore(checks.length - MARKDOWN_ROWS)] : []),
    ].join('\n\n');
    lines.push(
      `${head}>`,
      `      <${c.outcome.kind} type="${xmlAttr(c.outcome.type)}" message="${xmlAttr(c.outcome.message)}">${xmlText(body)}</${c.outcome.kind}>`,
      '    </testcase>',
    );
  }
  lines.push('  </testsuite>', '</testsuites>');
  // No line of the file reads as a workflow command, should a step print it: `##[` as a character reference, which
  // a reader decodes to the same text; a line that starts with `::` gets a `?` (see `noCommands`).
  return `${lines.join('\n')}\n`
    .replace(/^([\s\u0085]*)::/gm, '$1?::')
    .replaceAll('##[', '##&#91;');
}
