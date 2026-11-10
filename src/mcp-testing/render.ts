import type { CheckClass, CheckLevel, McpReport } from './result.js';
import type { McpCheckReport } from './result.js';

/**
 * A renderer turns one report into the text a command prints. Every format is one; a new format adds an entry to
 * `RENDERERS` and leaves the report as it is. Text from the server reaches a report already printable (no control
 * character), so a renderer adds none and needs no escaping of its own beyond its format.
 */
export type Renderer = (report: McpReport, opts: { showInfo: boolean }) => string;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const target = (t: { tool: string; param?: string }) =>
  t.param === undefined ? t.tool : `${t.tool}.${t.param}`;
const pad = (rows: string[][]) => {
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => r[i]?.length ?? 0))) ?? [];
  return rows.map((r) =>
    r
      .map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
      .join('  ')
      .trimEnd(),
  );
};

function human(report: McpReport, { showInfo }: { showInfo: boolean }): string {
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
    if (rows.length > 0) lines.push(...pad(rows));
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
 * No line of our output may read as a CI workflow command: a line that starts with `::` once its leading spaces are
 * gone gets a `?` before the `::`. Every text a command prints goes through here last, whatever produced it.
 */
export const noCommands = (text: string): string => text.replace(/^(\s*)::/gm, '$1?::');

export const RENDERERS: Record<'human' | 'json', Renderer> = {
  human,
  json: (report) => JSON.stringify(report, null, 2) + '\n',
};

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
function checkHuman(report: McpCheckReport): string {
  const server =
    report.server === null ? 'unnamed server' : `${report.server.name} ${report.server.version}`;
  const lines = [
    `Server: ${server} · ${report.transport} · protocol ${report.protocolVersion ?? 'unknown'}`,
    '',
  ];
  const timed = (c: { detail: string; timedOut?: true }) =>
    c.timedOut === true ? `${c.detail} (timed out)` : c.detail;
  lines.push(...pad(report.checks.map((c) => [c.state, c.id, timed(c)])));
  if (report.smoke !== null) {
    lines.push(
      '',
      `Smoke (--smoke, at most ${report.smoke.limit} tools, arguments {}${report.writeCallsAllowed ? ', --allow-write-calls' : ''}):`,
    );
    if (report.smoke.calls.length === 0) lines.push('  no tool listed');
    lines.push(...pad(report.smoke.calls.map((c) => [`  ${c.state}`, c.tool, timed(c)])));
  }
  const initialize = report.checks.find((c) => c.id === 'initialize');
  if (initialize?.state === 'failed' && report.stderrTail.length > 0)
    lines.push(
      '',
      'The last lines the server wrote to stderr:',
      ...report.stderrTail.map((l) => `  ${l}`),
    );
  const count = (state: string) => report.checks.filter((c) => c.state === state).length;
  lines.push(
    '',
    `${count('passed')} passed, ${count('failed')} failed, ${count('could-not-run')} could not run, ${count('not-applicable')} not applicable`,
    report.exitCode === 0
      ? 'Healthy: every check that applies passed.'
      : report.exitCode === 1
        ? 'Failed: at least one check failed.'
        : 'Not measured: nothing failed, but something could not run, and could-not-run is not a pass.',
  );
  return lines.join('\n') + '\n';
}

export const CHECK_RENDERERS: Record<'human' | 'json', (report: McpCheckReport) => string> = {
  human: checkHuman,
  json: (report) => JSON.stringify(report, null, 2) + '\n',
};
