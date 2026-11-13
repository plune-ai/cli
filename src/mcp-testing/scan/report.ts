import { createHash } from 'node:crypto';
import { noCommands, noCommandsJson } from '../report/human.js';
import type { ScanClass, ScanLevel } from './descriptions.js';

/**
 * The one report of `plune mcp scan` (MCP-G6): the shape of a finding is fixed here once, and every format below only
 * draws it. Everything in a `ScanReport` is built from fixed fields and from names the libraries already masked and
 * escaped (a server label, a field path, a rule's own sentence); no value of a secret and no text of a description is
 * in it, so no renderer needs to take anything out. What a renderer adds is the escaping of its own format.
 */

export type ScanGroup = 'descriptions' | 'pins' | 'config' | 'cross' | 'active';
export const GROUPS: readonly ScanGroup[] = ['descriptions', 'pins', 'config', 'cross', 'active'];
export type GroupState = 'ran' | 'not-evaluated' | 'not-requested';
export type FailOn = 'error' | 'warn' | 'never';

/** The sentence every format carries, word for word. */
export const DISCLAIMER =
  'No finding does not mean the server is safe: this is the result of the listed rules over the data that was read.';

export interface ScanFinding {
  rule: string;
  group: ScanGroup | 'exceptions';
  class: ScanClass;
  severity: ScanLevel;
  /** The rule may change the exit code: a `gating: yes` rule, or any heuristic when `--gate-heuristics` is given. */
  gating: boolean;
  /** Changes the exit code in this run: gating, at or above `--fail-on`, and not suppressed. */
  counted: boolean;
  /** The server label (a name of the file or of the server, never its address). */
  target: string;
  /** The path of the field in a configuration file, the pointer of a text in a snapshot, or the entry of a lock file. */
  path: string;
  location?: { file: string; line: number; column?: number };
  message: string;
  fix: string;
  suppressed?: { reason: string; expires: string };
  /** A hash of the rule, the target and the path (and which of the same three it is): no value, stable between runs. */
  fingerprint: string;
}

export interface NotEvaluatedRow {
  group: ScanGroup;
  rule?: string;
  target: string;
  reason: string;
  /** `missing-input`: a rule that needs a list or a second snapshot the caller did not give. `could-not-run`: it was asked for and did not run. */
  kind: 'missing-input' | 'could-not-run';
  file?: string;
  path?: string;
  line?: number;
}

export interface GroupRow {
  group: ScanGroup;
  state: GroupState;
  reason?: string;
  rules: string[];
  targets: string[];
}

export interface ScanReport {
  kind: 'mcp-scan-report';
  schemaVersion: 1;
  exitCode: number;
  result: 'findings' | 'no-findings' | 'not-measured';
  failOn: FailOn;
  gateHeuristics: boolean;
  allowPartial: boolean;
  /** Exit 0 only because of `--allow-partial`: something asked for did not run. */
  partial: boolean;
  groups: GroupRow[];
  inputs: {
    snapshots: number;
    tools: number;
    configFiles: number;
    servers: number;
    pinFile: string | null;
  };
  counts: {
    error: number;
    warn: number;
    info: number;
    advice: number;
    total: number;
    counted: number;
    suppressed: number;
    notAffectingExit: number;
  };
  findings: ScanFinding[];
  notEvaluated: NotEvaluatedRow[];
  exceptions: { file: string | null; expired: number; unused: number };
  /** Findings that have no place in a file, which SARIF cannot show. */
  omittedResults: number;
  notes: string[];
  disclaimer: string;
}

/** The rule ids each group reads, for the summary and the JUnit cases; filled by run.ts from the libraries. */
export const fingerprintOf = (rule: string, target: string, path: string, nth: number): string =>
  createHash('sha256')
    .update(`${rule}\n${target}\n${path}\n${nth}`, 'utf8')
    .digest('hex')
    .slice(0, 32);

const where = (f: { location?: { file: string; line: number; column?: number } }) =>
  f.location === undefined
    ? ''
    : ` (${f.location.file}:${f.location.line}${f.location.column === undefined ? '' : `:${f.location.column}`})`;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// --- human ---

/** One line saying why the exit code is what it is, for every code. */
export function exitLine(r: ScanReport): string {
  if (r.exitCode === 1)
    return `Exit 1: ${plural(r.counts.counted, 'finding', 'findings')} at --fail-on ${r.failOn} that gate.`;
  if (r.exitCode === 3)
    return 'Exit 3: not measured. Something that was asked for did not run (see "Not evaluated"); that is not a pass.';
  if (r.partial)
    return 'Exit 0 only because of --allow-partial: something that was asked for did not run (see "Not evaluated").';
  return r.result === 'no-findings'
    ? 'Exit 0: no finding that gates, and everything asked for ran.'
    : 'Exit 0: no finding at --fail-on that gates; the others do not change the exit code.';
}

function human(r: ScanReport): string {
  const out: string[] = [];
  const c = r.counts;
  out.push(
    `plune mcp scan: ${plural(c.total, 'finding', 'findings')} (${c.error} error, ${c.warn} warn, ${c.info} info, ${c.advice} advice), ${c.suppressed} suppressed, exit ${r.exitCode}.`,
  );
  out.push('', 'Checked:');
  for (const g of r.groups) {
    if (g.state === 'not-requested') continue;
    out.push(
      `  ${g.group}: ${g.state === 'ran' ? `${plural(g.rules.length, 'rule', 'rules')} over ${g.targets.length === 0 ? 'no target' : plural(g.targets.length, 'target', 'targets')}` : `NOT EVALUATED${g.reason === undefined ? '' : `: ${g.reason}`}`}`,
    );
  }
  out.push(
    `  input: ${plural(r.inputs.snapshots, 'snapshot', 'snapshots')} (${plural(r.inputs.tools, 'tool', 'tools')}), ${plural(r.inputs.configFiles, 'config file', 'config files')} (${plural(r.inputs.servers, 'server entry', 'server entries')})${r.inputs.pinFile === null ? '' : `, pin file ${r.inputs.pinFile}`}`,
  );
  if (r.notEvaluated.length > 0) {
    out.push('', 'Not evaluated (this is not "no finding"):');
    for (const n of r.notEvaluated)
      out.push(
        `  ${n.group}${n.rule === undefined ? '' : ` ${n.rule}`}${n.target === '' ? '' : ` ${n.target}`}${n.path === undefined ? '' : ` ${n.path}`}: ${n.reason}${n.kind === 'could-not-run' ? '' : ' [an input was not given]'}`,
      );
  }
  const live = r.findings.filter((f) => f.suppressed === undefined);
  if (live.length > 0) {
    out.push('', 'Findings:');
    for (const f of live) {
      out.push(
        `  ${f.severity.padEnd(6)} ${f.rule}  ${f.target === '' ? '' : `${f.target} `}${f.path}${where(f)}${f.counted ? '  [fails the run]' : ''}`,
        `         ${f.message}`,
        `         fix: ${f.fix}`,
      );
    }
  }
  const suppressed = r.findings.filter((f) => f.suppressed !== undefined);
  if (suppressed.length > 0) {
    out.push('', 'Suppressed by the exceptions file:');
    for (const f of suppressed)
      out.push(
        `  ${f.rule}  ${f.target === '' ? '' : `${f.target} `}${f.path}: ${f.suppressed!.reason} (until ${f.suppressed!.expires})`,
      );
  }
  if (r.exceptions.file !== null)
    out.push(
      '',
      `Exceptions file ${r.exceptions.file}: ${r.exceptions.expired} expired, ${r.exceptions.unused} that matched nothing.`,
    );
  out.push(
    '',
    `${plural(c.notAffectingExit, 'finding', 'findings')} do not change the exit code (advice, info, rules that wait for the measure${r.gateHeuristics ? '' : ', heuristics'}).`,
  );
  if (r.gateHeuristics)
    out.push(
      '--gate-heuristics is on: heuristic findings gate the exit code. That is not recommended: they are advice by construction.',
    );
  for (const note of r.notes) out.push(note);
  out.push('', exitLine(r), DISCLAIMER);
  return `${out.join('\n')}\n`;
}

// --- github ---

/** Annotations GitHub keeps per step (https://docs.github.com/en/rest/checks/runs): 10 of each kind; the rest is counted. */
const ANNOTATIONS = 10;
const escapeData = (s: string) =>
  s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProperty = (s: string) => escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
const noLegacy = (s: string) => s.replaceAll('##[', '##?[');

function github(r: ScanReport): string {
  const used = { error: 0, warning: 0, notice: 0 };
  let more = 0;
  const lines: string[] = [];
  const annotate = (
    kind: keyof typeof used,
    title: string,
    message: string,
    file?: { file: string; line: number; column?: number },
  ) => {
    if (used[kind] >= ANNOTATIONS) {
      more++;
      return;
    }
    used[kind]++;
    const props = [
      ...(file === undefined
        ? []
        : [
            `file=${escapeProperty(noLegacy(file.file))}`,
            `line=${file.line}`,
            ...(file.column === undefined ? [] : [`col=${file.column}`]),
          ]),
      `title=${escapeProperty(noLegacy(title))}`,
    ];
    lines.push(`::${kind} ${props.join(',')}::${escapeData(noLegacy(message))}`);
  };
  for (const f of r.findings) {
    if (f.suppressed !== undefined) continue;
    annotate(
      f.severity === 'error' ? 'error' : f.severity === 'warn' ? 'warning' : 'notice',
      `${f.rule}${f.target === '' ? '' : ` ${f.target}`}`,
      `${f.message} ${f.path === '' ? '' : `[${f.path}] `}fix: ${f.fix}`,
      f.location,
    );
  }
  for (const n of r.notEvaluated)
    annotate(
      'warning',
      `not evaluated: ${n.group}${n.rule === undefined ? '' : ` ${n.rule}`}`,
      `${n.reason}${n.target === '' ? '' : ` (${n.target})`}`,
      n.file !== undefined && n.line !== undefined ? { file: n.file, line: n.line } : undefined,
    );
  // Suppressed findings are not annotated; one notice says that exceptions hid some, so a reader of the log knows.
  if (r.counts.suppressed > 0)
    lines.push(
      `::notice title=exceptions::${plural(r.counts.suppressed, 'finding', 'findings')} hidden by exceptions (${r.exceptions.file === null ? 'exceptions file' : escapeData(noLegacy(r.exceptions.file))}); the report lists them.`,
    );
  const tail = [
    ...(more > 0
      ? [
          `${more} more in the report: GitHub keeps ${ANNOTATIONS} annotations of each kind per step.`,
        ]
      : []),
    `plune mcp scan: ${plural(r.counts.total, 'finding', 'findings')}, ${r.counts.suppressed} suppressed, ${r.notEvaluated.length} not evaluated; exit ${r.exitCode}. ${exitLine(r)}`,
    DISCLAIMER,
  ];
  return `${[...lines, ...tail.map(noCommands)].join('\n')}\n`;
}

// --- sarif ---

/** GitHub takes at most 25 000 results of a run, and shows the first 5 000 by importance (the code scanning documentation). */
export const SARIF_MAX_RESULTS = 25_000;
const SARIF_LEVEL = { error: 'error', warn: 'warning', info: 'note', advice: 'note' } as const;
const importance = (f: ScanFinding) =>
  (f.counted ? 0 : 4) + { error: 0, warn: 1, info: 2, advice: 3 }[f.severity];

/** The rules of the findings and of the groups' rule lists, for `tool.driver.rules`. */
export interface SarifRule {
  id: string;
  class: ScanClass;
  severity: ScanLevel;
  gating: string;
  fix: string;
}

function sarif(r: ScanReport, rules: readonly SarifRule[], version: string): string {
  const ids = [...new Set([...rules.map((x) => x.id), ...r.findings.map((f) => f.rule)])].sort();
  const byId = new Map(rules.map((x) => [x.id, x]));
  const withPlace = r.findings
    .filter((f) => f.location !== undefined)
    .sort((a, b) => importance(a) - importance(b));
  const kept = withPlace.slice(0, SARIF_MAX_RESULTS);
  const omitted = r.findings.length - kept.length;
  const results = kept.map((f) => ({
    ruleId: f.rule,
    ruleIndex: ids.indexOf(f.rule),
    level: SARIF_LEVEL[f.severity],
    message: { text: `${f.message} Fix: ${f.fix}` },
    locations: [
      {
        physicalLocation: {
          artifactLocation: {
            uri: f.location!.file.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/'),
            uriBaseId: '%SRCROOT%',
          },
          region: {
            startLine: f.location!.line,
            ...(f.location!.column === undefined ? {} : { startColumn: f.location!.column }),
          },
        },
        ...(f.path === ''
          ? {}
          : {
              logicalLocations: [
                {
                  name: f.path,
                  fullyQualifiedName: `${f.target}${f.target === '' ? '' : ':'}${f.path}`,
                },
              ],
            }),
      },
    ],
    partialFingerprints: { 'plune/mcp-scan/v1': f.fingerprint },
    ...(f.suppressed === undefined
      ? {}
      : {
          suppressions: [
            { kind: 'external', status: 'accepted', justification: f.suppressed.reason },
          ],
        }),
    properties: {
      class: f.class,
      severity: f.severity,
      gating: f.gating,
      counted: f.counted,
      group: f.group,
    },
  }));
  const document = {
    $schema:
      'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'plune mcp scan',
            version,
            informationUri: 'https://github.com/plune-ai/cli',
            rules: ids.map((id) => {
              const def = byId.get(id);
              return {
                id,
                name: id,
                shortDescription: { text: def === undefined ? id : `${id}: ${def.fix}` },
                defaultConfiguration: {
                  level: def === undefined ? 'note' : SARIF_LEVEL[def.severity],
                },
                properties: def === undefined ? {} : { class: def.class, gating: def.gating },
              };
            }),
          },
        },
        invocations: [
          {
            executionSuccessful: r.exitCode === 0 || r.exitCode === 1,
            exitCode: r.exitCode,
            toolExecutionNotifications: [
              ...r.notEvaluated.map((n) => ({
                level: 'warning',
                message: {
                  text: `not evaluated: ${n.group}${n.rule === undefined ? '' : ` ${n.rule}`}: ${n.reason}`,
                },
                descriptor: { id: n.rule ?? `scan/${n.group}` },
              })),
              ...(omitted > 0
                ? [
                    {
                      level: 'warning',
                      message: {
                        text: `${omitted} result(s) have no place in a file and are not in this file (see properties.omittedResults).`,
                      },
                      descriptor: { id: 'scan/omitted-results' },
                    },
                  ]
                : []),
            ],
          },
        ],
        results,
        properties: {
          disclaimer: DISCLAIMER,
          omittedResults: omitted,
          notEvaluated: r.notEvaluated.length,
          counts: r.counts,
          exitCode: r.exitCode,
        },
      },
    ],
  };
  return noCommandsJson(`${JSON.stringify(document, null, 2)}\n`);
}

// --- junit-xml ---

const NOT_XML =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const xmlText = (s: string) =>
  s.replace(NOT_XML, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const xmlAttr = (s: string) =>
  xmlText(s)
    .replace(/"/g, '&quot;')
    .replace(/\t/g, '&#9;')
    .replace(/\n/g, '&#10;')
    .replace(/\r/g, '&#13;');

/**
 * One test case for each rule of a group that ran, over each target of it. A finding that changes the exit code is a
 * `failure`; a finding that does not (advice, info, a rule that waits for the measure) and a suppressed one is `skipped`
 * with its reason, so a pass of the file always means the run passed; a rule that was not evaluated is `skipped` with
 * the reason, never a pass.
 */
function junit(r: ScanReport): string {
  interface Case {
    classname: string;
    name: string;
    kind: 'pass' | 'failure' | 'skipped';
    type: string;
    message: string;
  }
  const cases: Case[] = [];
  for (const g of r.groups) {
    if (g.state === 'not-requested') continue;
    const classname = `mcp.scan.${g.group}`;
    if (g.state === 'not-evaluated') {
      cases.push({
        classname,
        name: g.group,
        kind: 'skipped',
        type: 'not-evaluated',
        message: `not evaluated: ${g.reason ?? 'the group did not run'}`,
      });
      continue;
    }
    for (const rule of g.rules) {
      for (const target of g.targets.length === 0 ? [''] : g.targets) {
        const name = target === '' ? rule : `${rule} ${target}`;
        const mine = r.findings.filter((f) => f.rule === rule && f.target === target);
        const na = r.notEvaluated.find(
          (n) => n.group === g.group && n.rule === rule && (n.target === '' || n.target === target),
        );
        const failing = mine.filter((f) => f.counted);
        if (failing.length > 0)
          cases.push({
            classname,
            name,
            kind: 'failure',
            type: failing[0]!.severity,
            message: failing.map((f) => `${f.path}: ${f.message}`).join('\n'),
          });
        else if (mine.length > 0)
          cases.push({
            classname,
            name,
            kind: 'skipped',
            type: mine.every((f) => f.suppressed !== undefined) ? 'suppressed' : 'advisory',
            message: mine
              .map(
                (f) =>
                  `${f.suppressed === undefined ? '' : `suppressed (${f.suppressed.reason}): `}${f.path}: ${f.message}`,
              )
              .join('\n'),
          });
        else if (na !== undefined)
          cases.push({
            classname,
            name,
            kind: 'skipped',
            type: 'not-evaluated',
            message: `not evaluated: ${na.reason}`,
          });
        else cases.push({ classname, name, kind: 'pass', type: '', message: '' });
      }
    }
  }
  for (const f of r.findings.filter((x) => x.group === 'exceptions')) {
    cases.push({
      classname: 'mcp.scan.exceptions',
      name: `${f.rule} ${f.target}`.trim(),
      kind: 'skipped',
      type: 'advisory',
      message: f.message,
    });
  }
  const failures = cases.filter((c) => c.kind === 'failure').length;
  const skipped = cases.filter((c) => c.kind === 'skipped').length;
  const totals = `tests="${cases.length}" failures="${failures}" errors="0" skipped="${skipped}"`;
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="plune mcp scan" ${totals}>`,
    `  <testsuite name="plune mcp scan" ${totals}>`,
  ];
  for (const c of cases) {
    const head = `    <testcase classname="${xmlAttr(c.classname)}" name="${xmlAttr(c.name)}"`;
    if (c.kind === 'pass') lines.push(`${head}/>`);
    else
      lines.push(
        `${head}>`,
        `      <${c.kind} type="${xmlAttr(c.type)}" message="${xmlAttr(c.message.split('\n')[0] ?? '')}">${xmlText(c.message)}</${c.kind}>`,
        '    </testcase>',
      );
  }
  lines.push(
    `    <system-out>${xmlText(`${exitLine(r)}\n${DISCLAIMER}`)}</system-out>`,
    '  </testsuite>',
    '</testsuites>',
  );
  return `${lines.join('\n')}\n`
    .replace(/^([\s\u0085]*)::/gm, '$1?::')
    .replaceAll('##[', '##&#91;');
}

export type ScanFormat = 'human' | 'json' | 'github' | 'sarif' | 'junit-xml';

/** One format of a report, with the workflow commands of its text neutralized. */
export function renderScan(
  r: ScanReport,
  format: string,
  rules: readonly SarifRule[],
  version: string,
): string {
  switch (format) {
    case 'json':
      return noCommandsJson(`${JSON.stringify(r, null, 2)}\n`);
    case 'human':
      return noCommands(human(r));
    case 'github':
      return github(r);
    case 'sarif':
      return sarif(r, rules, version);
    case 'junit-xml':
      return junit(r);
    default:
      throw new Error(`plune mcp scan does not write ${format}`);
  }
}
