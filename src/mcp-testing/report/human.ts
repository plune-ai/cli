import { printable } from '../../reporter-core/failure-detail.js';
import { summaryLine, type Summary } from '../conformance/score.js';
import { MCP_EXIT } from '../exit-codes.js';
import type {
  CheckClass,
  CheckLevel,
  McpCheckReport,
  McpConformanceReport,
  McpConformanceReportSet,
  McpDiffReport,
  McpReport,
} from '../result.js';
import { renderDiffMarkdown, renderDiffText } from '../snapshot/index.js';

/**
 * The text each command prints of its own report: `human` for every command, and the `markdown` of `diff`, which
 * came before the shared renderers (./index.ts) and keeps its own table. Text from the server reaches a report
 * already printable (no control character), so a renderer adds none and needs no escaping of its own beyond its
 * format.
 */

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const target = (t: { tool: string; param?: string }) =>
  t.param === undefined ? t.tool : `${t.tool}.${t.param}`;
/** Columns padded to their widest cell. A width by reduce, not Math.max(...): a server's list can hold any number of rows. */
const pad = (rows: string[][]) => {
  const widths =
    rows[0]?.map((_, i) => rows.reduce((w, r) => Math.max(w, r[i]?.length ?? 0), 0)) ?? [];
  return rows.map((r) =>
    r
      .map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
      .join('  ')
      .trimEnd(),
  );
};

export function lintHuman(report: McpReport, { showInfo }: { showInfo: boolean }): string {
  const lines: string[] = [];
  const server =
    report.server === null ? 'unnamed server' : `${report.server.name} ${report.server.version}`;
  lines.push(
    `Server: ${server} · ${report.transport} · ${plural(report.toolCount, 'tool', 'tools')}`,
    '',
  );

  const shown = report.findings.filter((f) => f.level !== 'info' || showInfo);
  const heads = pad(shown.map((f) => [f.level, target(f.target), f.rule]));
  shown.forEach((f, i) => {
    lines.push(
      heads[i] ?? '',
      `  ${f.message}`,
      `  expected: ${f.expected}; actual: ${f.actual}`,
      `  fix: ${f.fix}`,
    );
    if (f.specRef !== '') lines.push(`  spec: ${f.specRef}`);
  });
  if (!showInfo && report.counts.info > 0) {
    lines.push(
      `${plural(report.counts.info, 'info finding', 'info findings')} not shown (--show-info shows ${report.counts.info === 1 ? 'it' : 'them'}).`,
    );
  }
  for (const s of report.suppressed)
    lines.push(`suppressed: ${s.level} ${target(s.target)} ${s.rule}: ${s.reason}`);

  const file = report.exceptions.file ?? '';
  const on = (e: { rule: string; tool?: string; param?: string }) =>
    `${e.rule} on ${e.tool ?? 'every tool'}${e.param === undefined ? '' : `.${e.param}`}`;
  for (const e of report.exceptions.expired)
    lines.push(
      `warning: ${file}:${e.line}: the exception for ${on(e)} expired on ${e.expires ?? ''} and no longer applies.`,
    );
  for (const e of report.exceptions.stale)
    lines.push(`stale: ${file}:${e.line}: the exception for ${on(e)} matched no finding.`);

  if (report.calls !== null) {
    lines.push('', `Calls (--call, at most ${report.calls.limit}, arguments {}):`);
    const rows = [
      ...report.calls.called.map((c) => [
        '  called',
        c.tool,
        c.reason === undefined ? c.state : `${c.state}: ${c.reason}`,
      ]),
      ...report.calls.skipped.map((s) => ['  skipped', s.tool, s.reason]),
    ];
    for (const line of pad(rows)) lines.push(line);
  }

  lines.push('');
  if (report.toolCount === 0) lines.push('Nothing measured: the server lists no tools.');
  else if (report.listing.state === 'could-not-run')
    lines.push(
      `Nothing measured past page ${report.listing.pages}: tools/list did not end, so the list is incomplete.`,
    );
  if (report.calls !== null && report.toolCount > 0) {
    if (report.calls.called.length === 0)
      lines.push('Nothing measured: --call found no tool it may call.');
    else if (report.calls.called.some((c) => c.state === 'could-not-run'))
      lines.push(
        `Nothing measured for ${plural(report.calls.called.filter((c) => c.state === 'could-not-run').length, 'call', 'calls')}: could-not-run is not a pass.`,
      );
  }
  const { error, warn, info, suppressed } = report.counts;
  lines.push(
    `${plural(error, 'error', 'errors')}, ${plural(warn, 'warning', 'warnings')}, ${info} info, ${suppressed} suppressed · failing on: ${report.failOn}`,
  );
  return lines.join('\n') + '\n';
}

/**
 * No line of our output may read as a CI workflow command. The Actions runner reads two forms (actions/runner,
 * src/Runner.Common/ActionCommand.cs):
 * - `::name …::data` at the start of a line once its leading white space is trimmed (`TryParseV2`, line 35; .NET
 *   trims NEL, U+0085, which `\s` does not match): such a line gets a `?` before the `::`;
 * - the older `##[name …]data` anywhere in the line (`TryParse`, line 132: `IndexOf`, not a prefix), which
 *   includes `##[set-output …]` and `##[stop-commands]`: every `##[` becomes `##?[`.
 * Every text a command prints, to stdout or stderr, goes through here last, whatever produced it; a JSON document
 * goes through `noCommandsJson` instead, the GitHub annotations through their own escaping.
 */
export const noCommands = (text: string): string =>
  text.replace(/^([\s\u0085]*)::/gm, '$1?::').replaceAll('##[', '##?[');

/**
 * `noCommands` for a JSON document: `##[` written as `##\u005b`, which `JSON.parse` reads back as the same text. A
 * line of JSON never starts with `::` (a string's line breaks are escaped), so that is all it needs.
 */
export const noCommandsJson = (json: string): string => json.replaceAll('##[', '##\\u005b');

/** One entry of the rule catalog (`--list-rules`). */
export interface RuleEntry {
  id: string;
  class: CheckClass;
  level: CheckLevel;
  description: string;
  fix: string;
  specRef: string;
}

export const CATALOG_RENDERERS: Record<'human' | 'json', (rules: readonly RuleEntry[]) => string> =
  {
    human: (rules) => {
      const heads = pad(rules.map((r) => [r.id, r.class, r.level, r.description]));
      return (
        rules
          .flatMap((r, i) => [
            heads[i] ?? '',
            `  fix: ${r.fix}`,
            ...(r.specRef === '' ? [] : [`  spec: ${r.specRef}`]),
          ])
          .join('\n') + '\n'
      );
    },
    json: (rules) =>
      JSON.stringify(
        {
          kind: 'mcp-lint-rules',
          schemaVersion: 1,
          rules: rules.map(({ id, class: cls, level, description, fix, specRef }) => ({
            id,
            class: cls,
            level,
            description,
            fix,
            specRef,
          })),
        },
        null,
        2,
      ) + '\n',
  };

/** `plune mcp check`: one row per check, the smoke calls, and a last line on what the exit code means. */
export function checkHuman(report: McpCheckReport): string {
  const server =
    report.server === null ? 'unnamed server' : `${report.server.name} ${report.server.version}`;
  const lines = [
    `Server: ${server} · ${report.transport} · protocol ${report.protocolVersion ?? 'unknown'}`,
    '',
  ];
  const timed = (c: { detail: string; timedOut?: true }) =>
    c.timedOut === true ? `${c.detail} (timed out)` : c.detail;
  for (const line of pad(report.checks.map((c) => [c.state, c.id, timed(c)]))) lines.push(line);
  const calls = report.smoke?.calls ?? [];
  const called = calls.filter((c) => c.state !== 'not-applicable');
  if (report.smoke !== null) {
    lines.push(
      '',
      `Smoke (--smoke, at most ${report.smoke.limit} tools, arguments {}${report.writeCallsAllowed ? ', --allow-write-calls' : ''}):`,
    );
    if (calls.length === 0) lines.push('  no tool listed');
    for (const line of pad(called.map((c) => [`  ${c.state}`, c.tool, timed(c)]))) lines.push(line);
    // The tools not called, one line per reason: a list of 200 000 tools is not 200 000 lines (the JSON has each one).
    const notCalled = new Map<string, string[]>();
    for (const c of calls)
      if (c.state === 'not-applicable') {
        const tools = notCalled.get(c.detail) ?? [];
        tools.push(c.tool);
        notCalled.set(c.detail, tools);
      }
    for (const [reason, tools] of notCalled)
      lines.push(
        `  ${plural(tools.length, 'tool', 'tools')} not called: ${reason}${tools.length <= 5 ? ` (${tools.join(', ')})` : ''}`,
      );
  }
  const initialize = report.checks.find((c) => c.id === 'initialize');
  if (initialize?.state === 'failed' && report.stderrTail.length > 0)
    lines.push(
      '',
      'The last lines the server wrote to stderr:',
      ...report.stderrTail.map((l) => `  ${l}`),
    );
  const count = (state: string) => report.checks.filter((c) => c.state === state).length;
  const smokeCount = (state: string) => calls.filter((c) => c.state === state).length;
  lines.push(
    '',
    `${count('passed')} passed, ${count('failed')} failed, ${count('could-not-run')} could not run, ${count('not-applicable')} not applicable`,
  );
  if (report.smoke !== null)
    lines.push(
      `Smoke: ${smokeCount('passed')} passed, ${smokeCount('failed')} failed, ${smokeCount('could-not-run')} could not run, ${smokeCount('not-applicable')} not called`,
    );
  lines.push(
    report.exitCode === 0
      ? 'Healthy: every check that applies passed.'
      : report.exitCode === 1
        ? 'Failed: at least one check or smoke call failed.'
        : 'Not measured: nothing failed, but something could not run, and could-not-run is not a pass.',
  );
  return lines.join('\n') + '\n';
}

/**
 * Opens a pull request comment of `--format markdown`, so a workflow finds and updates its own comment. Not the eval
 * diff's marker (`plune diff`): the two comments live side by side in one pull request.
 */
export const MCP_DIFF_MARKER = '<!-- plune-mcp-diff -->';

/** Server text reaches the terminal and the comment without a control character, line by line. */
const flat = (text: string) => text.split('\n').map(printable).join('\n');

const nothingToCompare = (report: McpDiffReport) =>
  report.exitCode === MCP_EXIT.unmeasured
    ? 'Nothing to compare: neither snapshot holds a tool, resource, resource template or prompt.'
    : '';

export function diffHuman(report: McpDiffReport): string {
  const nothing = nothingToCompare(report);
  const diff = { changes: report.changes, summary: report.summary };
  return `${[flat(renderDiffText(diff)), '', ...(nothing === '' ? [] : [nothing]), `failing on: ${report.failOn}`].join('\n')}\n`;
}

export function diffMarkdown(report: McpDiffReport): string {
  const nothing = nothingToCompare(report);
  const diff = { changes: report.changes, summary: report.summary };
  return `${[MCP_DIFF_MARKER, '### MCP contract', '', flat(renderDiffMarkdown(diff)).trimEnd(), ...(nothing === '' ? [] : ['', nothing])].join('\n')}\n`;
}

const WHY: Record<Summary['verdict'], (s: Summary) => string> = {
  passed: () => 'every scored check that applies passed',
  failed: (s) => `${s.failed.length} scored check${s.failed.length === 1 ? '' : 's'} failed`,
  incomplete: (s) =>
    s.applicable === 0 ? 'nothing was measured, so nothing is proven' : 'a scored check could not run',
};

/** `--protocol-version both`: the report of each era in turn, and the exit code of the two. */
export function conformanceSetHuman(set: McpConformanceReportSet): string {
  const blocks = set.reports.map((r) => conformanceHuman(r));
  return `${blocks.join('\n')}\nBoth eras, each scored on its own: exit ${set.exitCode}.\n`;
}

/** `plune mcp conformance`: a line per check, a score line per suite, and the verdict with its exit code. */
export function conformanceHuman(r: McpConformanceReport): string {
  const server = r.server === null ? 'a server without serverInfo' : `${r.server.name} ${r.server.version}`;
  const how = r.eraDetection ?? (r.protocolVersionRequested === 'auto' ? 'from the handshake' : 'from --protocol-version');
  const version = `${r.protocolVersion === null ? 'protocol version unknown' : `protocol ${r.protocolVersion}`}${r.era === undefined ? '' : `, ${r.era} era`} (${how})`;
  const lines = [
    `plune mcp conformance · ${server} · ${r.transport} · ${version}`,
    `Profile ${r.profileId} ${r.profileVersion} · sha256 ${r.manifestDigest.slice(0, 12)}`,
    '',
  ];
  for (const c of r.checks) {
    const level = c.level ?? c.kind;
    const why = c.reason === undefined ? '' : ` (${c.reason})`;
    const unscored = c.bucket === 'pending' && c.state !== 'pending' ? ' · not in the profile, not scored' : '';
    lines.push(`  ${c.state.padEnd(15)} ${level.padEnd(7)} ${c.id}${why}${unscored}`);
  }
  lines.push('');
  const reasons = new Map(r.checks.filter((c) => c.reason !== undefined).map((c) => [c.id, c.reason as string]));
  for (const s of r.suites) {
    const summary = r.bySuite[s];
    if (summary !== undefined) lines.push(`${s}: ${summaryLine(summary, reasons)}`);
  }
  if (r.suites.length > 1) lines.push(`all suites: ${summaryLine(r.summary, reasons)}`);
  lines.push(`Verdict: ${r.summary.verdict} (exit ${r.exitCode}): ${WHY[r.summary.verdict](r.summary)}.`);
  return `${lines.join('\n')}\n`;
}
