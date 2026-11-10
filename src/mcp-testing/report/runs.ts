/**
 * A command's report as a run of checks (./model.ts). Each command keeps its own document for `json`; here it becomes
 * the checks every other format reads, under a fixed set of cases, so a JUnit file names the same cases on every run
 * of a server, whatever it found.
 */

import { printable } from '../../reporter-core/failure-detail.js';
import { MCP_EXIT } from '../exit-codes.js';
import { CALL_RULES, compareLevels, LINT_RULES } from '../lint/index.js';
import type { HealthCheckId, McpCheckReport, McpDiffReport, McpReport } from '../result.js';
import type { ContractChange } from '../snapshot/index.js';
import type { McpRun, ReportCheck } from './model.js';

/** Every string of a check printable: the adapters take server text, and some of it (a diff's names) raw. */
const clean = (c: ReportCheck): ReportCheck => ({
  ...c,
  title: printable(c.title),
  target: printable(c.target),
  message: printable(c.message),
  expected: printable(c.expected),
  actual: printable(c.actual),
  fix: printable(c.fix),
  specRef: printable(c.specRef),
});

const targetOf = (t: { tool: string; param?: string }) =>
  t.param === undefined ? t.tool : `${t.tool}.${t.param}`;

export function lintRun(report: McpReport, showInfo: boolean): McpRun {
  const base = { command: 'lint' as const, document: report, showInfo };
  if (report.toolCount === 0)
    return { ...base, cases: [], checks: [], nothing: 'the server lists no tools' };
  const rules = [...LINT_RULES, ...CALL_RULES];
  const titles = new Map(rules.map((r) => [r.id, r.description]));
  const listing: ReportCheck = {
    id: 'tools-list',
    title: 'tools/list is read to its last page',
    target: '',
    state: report.listing.state,
    class: 'deterministic',
    level: 'error',
    message:
      report.listing.state === 'passed'
        ? `read in ${report.listing.pages} page(s)`
        : `tools/list did not end within ${report.listing.pages} pages: the list is incomplete`,
    expected: 'a last page without nextCursor',
    actual: `${report.listing.pages} page(s)`,
    fix: 'End the pages of tools/list: the last answer carries no nextCursor.',
    specRef: '',
    durationMs: null,
  };
  const findings = report.findings.map(
    (f): ReportCheck => ({
      id: f.rule,
      title: titles.get(f.rule) ?? f.rule,
      target: targetOf(f.target),
      state: f.state,
      class: f.class,
      level: f.level,
      message: f.message,
      expected: f.expected,
      actual: f.actual,
      fix: f.fix,
      specRef: f.specRef,
      durationMs: null,
      ...(report.failOn === 'never' || compareLevels(f.level, report.failOn) < 0
        ? { advisory: true as const }
        : {}),
    }),
  );
  // A call rule that judged no answer is not a pass: not asked for (`not-applicable`), or no answer (`could-not-run`).
  const unjudged = (state: 'not-applicable' | 'could-not-run', target: string, why: string) =>
    CALL_RULES.map(
      (r): ReportCheck => ({
        id: r.id,
        title: r.description,
        target,
        state,
        class: r.class,
        level: r.level,
        message: why,
        expected: 'an answer of the tool to judge',
        actual: why,
        fix: r.fix,
        specRef: r.specRef,
        durationMs: null,
      }),
    );
  const calls = report.calls;
  const callChecks =
    calls === null
      ? unjudged('not-applicable', '', '--call was not given: no tool was called')
      : calls.called.length === 0
        ? unjudged('could-not-run', '', '--call found no tool it may call')
        : calls.called
            .filter((c) => c.state === 'could-not-run')
            .flatMap((c) => unjudged('could-not-run', c.tool, c.reason ?? 'no answer'));
  return {
    ...base,
    cases: [
      { id: listing.id, title: listing.title },
      ...rules.map((r) => ({ id: r.id, title: r.description })),
    ],
    checks: [listing, ...findings, ...callChecks].map(clean),
    nothing: '',
  };
}

/** What each check of `plune mcp check` is for: the same words on every run. */
const HEALTH: Record<HealthCheckId | 'smoke', { title: string; expected: string; fix: string }> = {
  start: {
    title: 'The server starts',
    expected: 'the process starts, or the server answers at --url',
    fix: 'Run the server command by hand and fix what stops it.',
  },
  initialize: {
    title: 'The handshake finishes',
    expected: 'an answer to initialize within --timeout',
    fix: 'Answer initialize with protocolVersion, capabilities and serverInfo.',
  },
  'protocol-version': {
    title: 'The protocol version is one this client speaks',
    expected: 'a protocol version of the specification',
    fix: 'Answer initialize with a protocol version the specification lists.',
  },
  capabilities: {
    title: 'The capabilities are declared',
    expected: 'a capabilities object in the initialize answer',
    fix: 'Declare what the server offers in the capabilities of the initialize answer.',
  },
  'tools-list': {
    title: 'tools/list is read to its last page',
    expected: 'every page of tools/list within --check-timeout',
    fix: 'Answer tools/list with a tools array; the last page carries no nextCursor.',
  },
  'resources-list': {
    title: 'resources/list is read to its last page',
    expected: 'every page of resources/list within --check-timeout',
    fix: 'Answer resources/list with a resources array, or do not declare resources.',
  },
  'resource-templates-list': {
    title: 'resources/templates/list is read to its last page',
    expected: 'every page of resources/templates/list within --check-timeout',
    fix: 'Answer resources/templates/list with a resourceTemplates array.',
  },
  'prompts-list': {
    title: 'prompts/list is read to its last page',
    expected: 'every page of prompts/list within --check-timeout',
    fix: 'Answer prompts/list with a prompts array, or do not declare prompts.',
  },
  ping: {
    title: 'The server answers ping',
    expected: 'an empty answer to ping within --check-timeout',
    fix: 'Answer ping with an empty result.',
  },
  smoke: {
    title: 'The tools safe to call answer {}',
    expected: 'an answer without isError within --smoke-timeout',
    fix: 'Make the tool answer {} without an error, or require its arguments in inputSchema.',
  },
};

export function checkRun(report: McpCheckReport): McpRun {
  const ms = new Map(report.timing.checks.map((t) => [t.id, t.ms]));
  const callMs = new Map(report.timing.calls.map((t) => [t.tool, t.ms]));
  const of = (
    id: HealthCheckId | 'smoke',
    c: { state: ReportCheck['state']; detail: string },
    target: string,
    durationMs: number | null,
  ): ReportCheck => ({
    id,
    title: HEALTH[id].title,
    target,
    state: c.state,
    class: 'deterministic',
    level: 'error',
    message: c.detail,
    expected: HEALTH[id].expected,
    actual: c.detail,
    fix: HEALTH[id].fix,
    specRef: '',
    durationMs,
  });
  const checks = report.checks.map((c) => of(c.id, c, '', ms.get(c.id) ?? null));
  const calls = report.smoke?.calls ?? [];
  if (report.smoke === null)
    checks.push(
      of('smoke', { state: 'not-applicable', detail: '--smoke was not given' }, '', null),
    );
  else {
    for (const c of calls) checks.push(of('smoke', c, c.tool, callMs.get(c.tool) ?? null));
    // The exit code says it too: a smoke run that called nothing measured nothing.
    if (!calls.some((c) => c.state !== 'not-applicable'))
      checks.push(
        of(
          'smoke',
          { state: 'could-not-run', detail: '--smoke found no tool it may call' },
          '',
          null,
        ),
      );
  }
  return {
    command: 'check',
    document: report,
    cases: (Object.keys(HEALTH) as (HealthCheckId | 'smoke')[]).map((id) => ({
      id,
      title: HEALTH[id].title,
    })),
    checks: checks.map(clean),
    nothing: '',
    showInfo: false,
  };
}

type DiffFailOn = McpDiffReport['failOn'];

/**
 * The cases of `diff`. `fails` is the command's own gate (`--fail-on`): a change under a case that does not fail the
 * run is advice, so the exit code is 1 exactly when a case failed. `contract-changes` holds every change and fails
 * only under `--fail-on any`; the other two are for a reviewer and never fail the run.
 */
const DIFF_CASES: {
  id: string;
  title: string;
  class: ReportCheck['class'];
  expected: string;
  fix: string;
  takes: (ch: ContractChange) => boolean;
  fails: (failOn: DiffFailOn) => boolean;
}[] = [
  {
    id: 'breaking-changes',
    title: 'No change to the contract breaks a client',
    class: 'deterministic',
    expected: 'no breaking change since the baseline snapshot',
    fix: 'Undo the change, or release it as breaking and commit a new baseline snapshot.',
    takes: (ch) => ch.classification === 'breaking',
    fails: (failOn) => failOn !== 'none',
  },
  {
    id: 'contract-changes',
    title: 'The contract is the one of the baseline snapshot',
    class: 'deterministic',
    expected: 'no change since the baseline snapshot',
    fix: 'Undo the change, or commit a new baseline snapshot once it is accepted.',
    takes: () => true,
    fails: (failOn) => failOn === 'any',
  },
  {
    id: 'unclassified-changes',
    title: 'Every change to the contract is classified',
    class: 'heuristic',
    expected: 'a change some rule knows',
    fix: 'Check the change by hand; commit a new baseline snapshot once it is accepted.',
    takes: (ch) => ch.unclassified === true,
    fails: () => false,
  },
  {
    id: 'security-signals',
    title: 'No change to what a tool says about its safety',
    class: 'heuristic',
    expected: 'the same safety hints as in the baseline snapshot',
    fix: 'Check that the tool still does what its hints say before accepting the change.',
    takes: (ch) => ch.signal === 'security',
    fails: () => false,
  },
];

export function diffRun(report: McpDiffReport): McpRun {
  const base = { command: 'diff' as const, document: report, showInfo: false };
  if (report.exitCode === MCP_EXIT.unmeasured)
    return {
      ...base,
      cases: [],
      checks: [],
      nothing: 'neither snapshot holds a tool, resource, resource template or prompt',
    };
  const checks = DIFF_CASES.flatMap((c) => {
    const fails = c.fails(report.failOn);
    return report.changes.filter(c.takes).map(
      (ch): ReportCheck => ({
        id: c.id,
        title: c.title,
        target: ch.name === '' ? ch.entity : `${ch.entity} ${ch.name}`,
        state: 'failed',
        class: c.class,
        // What fails the run is an error; advice a warning, and every change listed again an info line.
        level: fails ? 'error' : c.id === 'contract-changes' ? 'info' : 'warn',
        message: ch.reason,
        expected: c.expected,
        actual: `${ch.field} ${ch.kind} (${ch.classification})`,
        fix: c.fix,
        specRef: '',
        durationMs: null,
        ...(fails ? {} : { advisory: true as const }),
      }),
    );
  });
  return {
    ...base,
    cases: DIFF_CASES.map((c) => ({ id: c.id, title: c.title })),
    checks: checks.map(clean),
    nothing: '',
  };
}
