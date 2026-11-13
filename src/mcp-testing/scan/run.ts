import { MCP_EXIT } from '../exit-codes.js';
import {
  comparePinned,
  PIN_RULES,
  pinnedCount,
  pinServer,
  type LockFile,
  type PinClass,
  type PinnedSection,
} from '../pin/pin.js';
import type { McpSnapshot } from '../snapshot/index.js';
import {
  CONFIG_RULES,
  safe,
  safePointer,
  safeText,
  scanClientConfig,
  type ConfigFile,
  type ConfigFinding,
  type ConfigRuleId,
} from './config/config.js';
import { lineLocator, parseJson, type JsonNode } from './config/json-tree.js';
import {
  DESC_RULES,
  scanDescriptions,
  type DescRuleId,
  type ScanClass,
  type ScanGating,
  type ScanLevel,
} from './descriptions.js';
import { covers, type ScanException } from './exceptions.js';
import type { ProbeSection } from './probes/runner.js';
import { PROBE_REASONS } from './probes/types.js';
import {
  DISCLAIMER,
  fingerprintOf,
  GROUPS,
  type FailOn,
  type GroupRow,
  type NotEvaluatedRow,
  type ScanFinding,
  type ScanGroup,
  type ScanReport,
  type SarifRule,
} from './report.js';

/**
 * `plune mcp scan` as a function of what was read (MCP-G6): the snapshots, the configuration files, the pin file and
 * the exceptions, already in memory. No file, no process, no connection here: a test of this module can prove that
 * nothing is opened, and the command is only the part that reads. The libraries of the groups produce the findings;
 * this module gives each one its place, the exceptions, the exit code and the "not evaluated" rows.
 */

export interface ScanSnapshot {
  label: string;
  snapshot: McpSnapshot;
  /** The file the snapshot is in (as the user named it), and its text: the place of a finding is a line of it. */
  file?: string;
  text?: string;
}

export interface ScanInput {
  snapshots: ScanSnapshot[];
  /** A snapshot that was asked for and could not be read or taken: one row, "not evaluated". */
  unreadable: { target: string; reason: string }[];
  configFiles: ConfigFile[];
  configRequested: boolean;
  /** Why no configuration file was read, when one was asked for and none found. */
  configMissing?: string;
  pin?: { file: string; text: string; lock: LockFile };
  /** A pin file that was named and could not be read: the pins group cannot run, and says why. */
  pinProblem?: { file: string; reason: string };
  active: boolean;
  /** What the active probes did (`--active`); undefined when none was run. */
  probes?: ProbeSection;
  allowHosts: string[];
  allowPackages: string[];
}

export interface ScanOptions {
  only?: ScanGroup[];
  skip?: ScanGroup[];
  failOn: FailOn;
  gateHeuristics: boolean;
  allowPartial: boolean;
  exceptions?: { file: string; active: ScanException[]; expired: ScanException[] };
}

/** The rule ids of each group, for the summary, the JUnit cases and SARIF. */
const PIN_IDS = [
  'scan/pin/tool-changed',
  'scan/pin/tool-added',
  'scan/pin/tool-removed',
  'scan/pin/server-not-pinned',
] as const;
/** The rules of the active probes (`--active`): a finding of one is the server's own answer to a declared call. */
const PROBE_RULES = {
  'scan/probe/unauthenticated-call': {
    class: 'deterministic',
    level: 'error',
    gating: 'yes',
    fix: 'Require authentication for this tool, or drop expect: refuse from the probe if the tool is meant to be public.',
  },
  'scan/probe/garbage-token-accepted': {
    class: 'deterministic',
    level: 'error',
    gating: 'yes',
    fix: 'Check the token on every call: a value the server never issued must be refused (401).',
  },
  'scan/probe/cross-account-access': {
    class: 'deterministic',
    level: 'error',
    gating: 'yes',
    fix: 'Check that the account of the token owns the object the call names, before the tool runs.',
  },
} as const satisfies Record<string, RuleDef>;

export const GROUP_RULES: Record<ScanGroup, string[]> = {
  descriptions: Object.keys(DESC_RULES),
  pins: [...PIN_IDS],
  config: Object.keys(CONFIG_RULES).filter((id) => id.startsWith('scan/cfg/')),
  cross: Object.keys(CONFIG_RULES).filter((id) => id.startsWith('scan/cross/')),
  active: Object.keys(PROBE_RULES),
};

interface RuleDef {
  class: ScanClass;
  level: ScanLevel;
  gating: ScanGating | 'yes' | 'no' | 'after-measure';
  fix: string;
}
const EXCEPTION_RULES = {
  'scan/exception/expired': {
    class: 'deterministic',
    level: 'warn',
    gating: 'no',
    fix: 'The exception is past its expires date and no longer hides the finding: renew it with a new reason, or fix the cause.',
  },
  'scan/exception/unused': {
    class: 'deterministic',
    level: 'info',
    gating: 'no',
    fix: 'The exception matched no finding of this run: remove it, or correct its rule and scope.',
  },
} as const satisfies Record<string, RuleDef>;
const PIN_DEFS = PIN_RULES as unknown as Record<string, RuleDef>;
const def = (rule: string): RuleDef =>
  (DESC_RULES as Record<string, RuleDef>)[rule] ??
  (CONFIG_RULES as Record<string, RuleDef>)[rule] ??
  PIN_DEFS[rule] ??
  (EXCEPTION_RULES as Record<string, RuleDef>)[rule] ??
  (PROBE_RULES as Record<string, RuleDef>)[rule]!;

/** Every rule the command can report, for the rules of SARIF. */
export const ALL_RULES: SarifRule[] = [
  ...Object.entries(DESC_RULES),
  ...PIN_IDS.map((id) => [id, PIN_DEFS[id]!] as const),
  ...Object.entries(CONFIG_RULES),
  ...Object.entries(EXCEPTION_RULES),
  ...Object.entries(PROBE_RULES),
].map(([id, d]) => ({ id, class: d.class, severity: d.level, gating: d.gating, fix: d.fix }));

/** The rules that gate from the first day, as the catalog marks them; a test reads the catalog against this. */
export const GATING_RULES: string[] = ALL_RULES.filter((r) => r.gating === 'yes')
  .map((r) => r.id)
  .sort();

const SENTENCE: Record<DescRuleId, string> = {
  'scan/desc/tag-character': 'Unicode tag characters, text nobody sees',
  'scan/desc/bidi-control': 'bidi control characters that change the order a text is shown in',
  'scan/desc/zero-width': 'zero-width characters inside the text',
  'scan/desc/joiner-or-direction-mark':
    'a joiner or direction mark outside the scripts that need one',
  'scan/desc/ansi-escape': 'a terminal escape sequence',
  'scan/desc/control-character': 'a control character',
  'scan/desc/html-comment': 'an HTML comment, hidden from a reader that renders Markdown or HTML',
  'scan/desc/encoded-blob': 'a base64 run that decodes to printable text',
  'scan/desc/oversized-text': 'a text over the size limit; only its start was scanned',
  'scan/desc/override-instruction': 'a phrase of the override-instruction list',
  'scan/desc/sensitive-path': 'a phrase of the credential-path list',
  'scan/desc/conceal-from-user': 'a phrase of the keep-it-from-the-user list',
  'scan/desc/call-other-tool-first': 'a phrase of the call-another-tool-first list',
  'scan/desc/param-asks-for-context': 'a phrase of the asks-for-context list',
};

// ---- places in a JSON text ---------------------------------------------------------------------------------------------

/** A file is parsed once per run, however many findings point into it; `runScan` empties the cache. */
const parseCache = new Map<
  string,
  { parsed: ReturnType<typeof parseJson>; at: ReturnType<typeof lineLocator> }
>();
function parsedOf(text: string) {
  let hit = parseCache.get(text);
  if (hit === undefined) {
    hit = { parsed: parseJson(text, { comments: false }), at: lineLocator(text) };
    parseCache.set(text, hit);
  }
  return hit;
}

const decodeToken = (t: string) => t.replace(/~1/g, '/').replace(/~0/g, '~');

/** The line and column of a JSON Pointer in `text`; when a segment is not found (a name shown escaped), of the deepest part that is. */
function pointerPlace(text: string, pointer: string): { line: number; column: number } | undefined {
  const { parsed, at } = parsedOf(text);
  if (!parsed.ok || parsed.root === undefined) return undefined;
  let node: JsonNode = parsed.root;
  let found = node.at;
  for (const raw of pointer.split('/').slice(1)) {
    const token = decodeToken(raw);
    let next: JsonNode | undefined;
    if (node.t === 'object') {
      for (let i = node.members.length - 1; i >= 0 && next === undefined; i--)
        if (node.members[i]!.key === token) next = node.members[i]!.value;
    } else if (node.t === 'array' && /^\d+$/.test(token)) next = node.items[Number(token)];
    if (next === undefined) break;
    node = next;
    found = node.at;
  }
  return at(found);
}

/** The place of an entry of a lock file: `servers.<label>.<section>[name]`, else the server, else the file. */
function lockPlace(
  text: string,
  label: string,
  section: PinnedSection | undefined,
  name: string,
): { line: number; column: number } | undefined {
  const { parsed, at } = parsedOf(text);
  if (!parsed.ok || parsed.root?.t !== 'object') return undefined;
  const servers = parsed.root.members.find((m) => m.key === 'servers')?.value;
  const server = servers?.t === 'object' ? servers.members.find((m) => m.key === label) : undefined;
  if (server === undefined) return at(parsed.root.at);
  const list =
    server.value.t === 'object' && section !== undefined
      ? server.value.members.find((m) => m.key === section)?.value
      : undefined;
  const keyName = section === 'resourceTemplates' ? 'uriTemplate' : 'name';
  if (list?.t === 'array') {
    for (const item of list.items) {
      if (item.t !== 'object') continue;
      const k = item.members.find((m) => m.key === keyName)?.value;
      if (k?.t === 'string' && k.value === name) return at(item.at);
    }
  }
  return at(server.keyAt);
}

// ---- the run -------------------------------------------------------------------------------------------------------------

const NOUN: Record<PinnedSection, string> = {
  tools: 'tool',
  prompts: 'prompt',
  resourceTemplates: 'resource template',
};
const PIN_RULE_OF: Record<PinClass, string> = {
  changed: 'scan/pin/tool-changed',
  added: 'scan/pin/tool-added',
  removed: 'scan/pin/tool-removed',
};
const rank = { error: 0, warn: 1, info: 2, advice: 3 } as const;

/** Whether a finding of this level and rule changes the exit code at `--fail-on`. */
export function failsAt(
  f: { severity: ScanLevel; class: ScanClass; gating: boolean },
  failOn: FailOn,
  gateHeuristics: boolean,
): boolean {
  if (failOn === 'never' || !f.gating) return false;
  if (f.class === 'heuristic') return gateHeuristics;
  return rank[f.severity] <= rank[failOn];
}

type Draft = Omit<ScanFinding, 'counted' | 'fingerprint' | 'gating' | 'class' | 'severity'> & {
  rule: string;
  severity?: ScanLevel;
  /** Set when this finding does not gate although its rule does (a probe with no expectation is information). */
  gating?: boolean;
};

export function runScan(input: ScanInput, opts: ScanOptions): ScanReport {
  parseCache.clear();
  try {
    return runScanUncached(input, opts);
  } finally {
    parseCache.clear();
  }
}

function runScanUncached(input: ScanInput, opts: ScanOptions): ScanReport {
  const asked: Record<ScanGroup, boolean> =
    opts.only !== undefined && opts.only.length > 0
      ? {
          descriptions: false,
          pins: false,
          config: false,
          cross: false,
          active: false,
          ...Object.fromEntries(opts.only.map((g) => [g, true])),
        }
      : {
          descriptions: input.snapshots.length > 0 || input.unreadable.length > 0,
          pins: input.pin !== undefined || input.pinProblem !== undefined,
          config: input.configRequested,
          cross: input.snapshots.length >= 2,
          active: input.active,
        };
  for (const g of opts.skip ?? []) asked[g] = false;

  const drafts: Draft[] = [];
  const rows: NotEvaluatedRow[] = [];
  const groups: GroupRow[] = [];
  const snapshotFile = new Map(input.snapshots.map((s) => [s.label, s]));
  const state = (group: ScanGroup, ran: boolean, targets: string[], reason?: string) =>
    groups.push({
      group,
      state: !asked[group] ? 'not-requested' : ran ? 'ran' : 'not-evaluated',
      ...(reason === undefined ? {} : { reason }),
      rules: GROUP_RULES[group],
      targets: [...new Set(targets)].sort(),
    });
  const couldNot = (
    group: ScanGroup,
    target: string,
    reason: string,
    extra: Partial<NotEvaluatedRow> = {},
  ) => rows.push({ group, target, reason, kind: 'could-not-run', ...extra });

  // descriptions
  {
    const ran: string[] = [];
    if (asked.descriptions) {
      for (const u of input.unreadable) couldNot('descriptions', safe(u.target), u.reason);
      if (input.snapshots.length === 0 && input.unreadable.length === 0)
        couldNot('descriptions', '', 'no snapshot was given to read');
      for (const s of input.snapshots) {
        const scan = scanDescriptions(s.snapshot);
        if (scan.status === 'nothing-to-scan') {
          couldNot(
            'descriptions',
            safe(s.label),
            'the snapshot holds no text to scan: that is not a pass',
          );
          continue;
        }
        ran.push(safe(s.label));
        const place =
          s.text === undefined || s.file === undefined
            ? undefined
            : (p: string) => pointerPlace(s.text!, p);
        for (const f of scan.findings) {
          if (f.rule === 'scan/desc/oversized-text')
            // The tail past the limit was not read: hidden text there would pass, so this is not a pass either.
            rows.push({
              group: 'descriptions',
              rule: f.rule,
              target: safe(s.label),
              path: safePointer(f.pointer),
              reason: 'the text is over 1 MB and only its first 1 MB was scanned',
              kind: 'could-not-run',
            });
          const where = place?.(f.pointer);
          drafts.push({
            rule: f.rule,
            group: 'descriptions',
            target: safe(s.label),
            path: safePointer(f.pointer),
            ...(where === undefined || s.file === undefined
              ? {}
              : { location: { file: safeText(s.file), ...where } }),
            message: `${SENTENCE[f.rule]} at offset ${f.offset}`,
            fix: f.fix,
          });
        }
      }
    }
    state(
      'descriptions',
      ran.length > 0,
      ran,
      rows.find((r) => r.group === 'descriptions')?.reason,
    );
  }

  // pins
  {
    const ran: string[] = [];
    if (asked.pins) {
      if (input.pinProblem !== undefined)
        couldNot('pins', safeText(input.pinProblem.file), input.pinProblem.reason);
      else if (input.pin === undefined) couldNot('pins', '', 'no pin file was given (--pin-file)');
      else if (input.snapshots.length === 0)
        couldNot('pins', '', 'no snapshot to compare with the pin file');
      else {
        const pin = input.pin;
        const file = safeText(pin.file);
        for (const s of input.snapshots) {
          const label = safe(s.label);
          const live = pinServer(s.snapshot, 'snapshot', '1970-01-01T00:00:00.000Z');
          if (pinnedCount(live) === 0) {
            couldNot(
              'pins',
              label,
              'the snapshot lists no tool, prompt or resource template: nothing to compare',
            );
            continue;
          }
          ran.push(label);
          const pinned = Object.hasOwn(pin.lock.servers, s.label)
            ? pin.lock.servers[s.label]
            : undefined;
          if (pinned === undefined) {
            const where = lockPlace(pin.text, s.label, undefined, '');
            drafts.push({
              rule: 'scan/pin/server-not-pinned',
              group: 'pins',
              target: label,
              path: '',
              ...(where === undefined ? {} : { location: { file, ...where } }),
              message: `the server is not in the pin file; nothing was compared`,
              fix: PIN_RULES['scan/pin/server-not-pinned'].fix,
            });
            continue;
          }
          for (const d of comparePinned(pinned, live).differences) {
            const rule = PIN_RULE_OF[d.class]!;
            const fields = [...new Set(d.changes.map((c) => safe(c.field)))].slice(0, 5).join(', ');
            const where = lockPlace(pin.text, s.label, d.section, d.name);
            drafts.push({
              rule,
              group: 'pins',
              target: label,
              path: d.name === '' ? '' : `${d.section}[${safe(d.name)}]`,
              ...(where === undefined ? {} : { location: { file, ...where } }),
              message:
                d.name === ''
                  ? 'the lists differ from the pinned ones in order or in how a section is declared'
                  : `${NOUN[d.section]} ${d.class}${fields === '' ? '' : ` (${fields})`}${d.modelText ? '; the text the model reads changed' : ''}`,
              fix: PIN_RULES[rule as keyof typeof PIN_RULES].fix,
            });
          }
        }
      }
    }
    state('pins', ran.length > 0, ran, rows.find((r) => r.group === 'pins')?.reason);
  }

  // config and cross: one library call, its findings and rows split by group
  {
    const crossOk = input.snapshots.length >= 2;
    const wantConfig = asked.config;
    const wantCross = asked.cross;
    const labelled = new Map(input.snapshots.map((s) => [s.label, s.snapshot]));
    const scan =
      wantConfig || wantCross
        ? scanClientConfig(wantConfig ? input.configFiles : [], {
            ...(input.allowHosts.length > 0 ? { allowHosts: input.allowHosts } : {}),
            ...(input.allowPackages.length > 0 ? { allowPackages: input.allowPackages } : {}),
            ...(wantCross && crossOk ? { snapshots: labelled } : {}),
          })
        : undefined;
    const configRan: string[] = [];
    if (wantConfig) {
      if (input.configFiles.length === 0)
        couldNot('config', '', input.configMissing ?? 'no configuration file was read');
      for (const f of scan?.files ?? []) {
        if (f.status === 'unreadable')
          couldNot(
            'config',
            '',
            `the file could not be read (${f.problems[0]?.kind ?? 'unreadable'}${f.problems[0]?.kind === 'parse-error' ? `: ${f.problems[0].category}` : ''})`,
            {
              file: f.path,
              ...(f.problems[0]?.kind === 'parse-error' ? { line: f.problems[0].line } : {}),
            },
          );
        else if (f.status === 'nothing-to-scan')
          couldNot(
            'config',
            '',
            'the file holds no server entry: nothing to assess, which is not a pass',
            { file: f.path },
          );
        else for (const s of f.servers) configRan.push(s.label);
      }
    }
    if (scan?.truncated === true) {
      const names = input.configFiles.map((f) => safeText(f.path)).slice(0, 3);
      couldNot(
        wantConfig ? 'config' : 'cross',
        '',
        `more findings than the cap of one run: the rest were not reported (${names.join(', ')}${input.configFiles.length > 3 ? ', ...' : ''}); that is not a pass`,
        names[0] === undefined ? {} : { file: names[0] },
      );
    }
    const crossRan: string[] = [];
    if (wantCross && !crossOk)
      couldNot(
        'cross',
        '',
        'needs the snapshots of at least two servers (--snapshot <label>=<file>)',
      );
    for (const f of scan?.findings ?? []) {
      const cross = f.rule.startsWith('scan/cross/');
      if (cross ? !wantCross : !wantConfig) continue;
      drafts.push(fromConfig(f, snapshotFile));
      if (cross) crossRan.push(f.server);
    }
    for (const n of scan?.notEvaluated ?? []) {
      const rule = n.rule;
      const cross =
        rule === 'scan/cross/duplicate-tool-name' || rule === 'scan/cross/foreign-tool-reference';
      if (rule === 'all') {
        couldNot(
          wantConfig ? 'config' : 'cross',
          '',
          'the scan of the configuration failed inside (internal-error)',
        );
        continue;
      }
      if (cross && !wantCross) continue;
      if (cross && !crossOk) continue;
      if (!cross && !wantConfig) continue;
      const group: ScanGroup = cross ? 'cross' : 'config';
      const optional = n.reason.startsWith('no list of allowed');
      rows.push({
        group,
        rule,
        target: '',
        reason: n.reason,
        kind: optional ? 'missing-input' : 'could-not-run',
        ...(n.file === undefined ? {} : { file: n.file }),
        ...(n.path === undefined ? {} : { path: n.path }),
        ...(n.line === undefined ? {} : { line: n.line }),
      });
    }
    if (
      wantCross &&
      crossOk &&
      !rows.some((r) => r.group === 'cross' && r.kind === 'could-not-run')
    )
      for (const s of input.snapshots) crossRan.push(safe(s.label));
    state(
      'config',
      configRan.length > 0 ||
        (wantConfig && (scan?.files ?? []).some((f) => f.status === 'scanned')),
      configRan,
      rows.find((r) => r.group === 'config' && r.kind === 'could-not-run')?.reason,
    );
    state(
      'cross',
      crossRan.length > 0,
      crossRan,
      rows.find((r) => r.group === 'cross' && r.kind === 'could-not-run')?.reason,
    );
  }

  // active probes (--active): the rows of what the probes did; one that did not run is "not measured"
  const section: ProbeSection = input.probes ?? {
    rows: [
      {
        id: '',
        tool: '',
        as: '',
        expect: 'none',
        answer: null,
        outcome: 'not-run',
        reason: 'no-probe-file',
      },
    ],
    findings: [],
    calls: 0,
    requests: 0,
    metadata: null,
  };
  if (asked.active) {
    for (const row of section.rows)
      if (row.outcome === 'not-run')
        couldNot('active', safeText(row.id), PROBE_REASONS[row.reason!]);
    for (const f of section.findings)
      drafts.push({
        rule: f.rule,
        group: 'active',
        target: safeText(f.id),
        path: '',
        severity: f.severity,
        ...(f.severity === 'info' ? { gating: false } : {}),
        message: safeText(f.message),
        fix: PROBE_RULES[f.rule].fix,
      });
  }
  state(
    'active',
    asked.active && section.rows.some((r) => r.answer !== null),
    section.rows.filter((r) => r.answer !== null).map((r) => safeText(r.id)),
    rows.find((r) => r.group === 'active')?.reason,
  );

  // exceptions
  const ex = opts.exceptions;
  const used = new Set<ScanException>();
  const suppressedOf = (f: { rule: string; target: string; path: string }) =>
    ex?.active.find((e) => covers(e, f));
  const findings: ScanFinding[] = [];
  const seen = new Map<string, number>();
  const finish = (d: Draft): ScanFinding => {
    const r = def(d.rule);
    const gating =
      d.gating ?? (r.gating === 'yes' || (opts.gateHeuristics && r.class === 'heuristic'));
    const hit = d.group === 'exceptions' ? undefined : suppressedOf(d);
    if (hit !== undefined) used.add(hit);
    const base = { class: r.class, severity: d.severity ?? r.level, gating };
    const key = `${d.rule}\n${d.target}\n${d.path}`;
    const nth = seen.get(key) ?? 0;
    seen.set(key, nth + 1);
    return {
      ...d,
      ...base,
      counted: hit === undefined && failsAt(base, opts.failOn, opts.gateHeuristics),
      ...(hit === undefined
        ? {}
        : { suppressed: { reason: safeText(hit.reason), expires: hit.expires } }),
      fingerprint: fingerprintOf(d.rule, d.target, d.path, nth),
    };
  };
  const order = (a: Draft, b: Draft) =>
    a.target.localeCompare(b.target) ||
    a.path.localeCompare(b.path) ||
    a.rule.localeCompare(b.rule) ||
    a.message.localeCompare(b.message);
  for (const d of [...drafts].sort(order)) findings.push(finish(d));
  const exceptionDrafts: Draft[] = [];
  if (ex !== undefined) {
    for (const e of ex.expired)
      exceptionDrafts.push({
        rule: 'scan/exception/expired',
        group: 'exceptions',
        target: safe(e.server),
        path: e.path === undefined ? '' : safeText(e.path),
        location: { file: safeText(ex.file), line: e.line },
        message: `the exception for ${e.rule} expired on ${e.expires} and no longer applies`,
        fix: EXCEPTION_RULES['scan/exception/expired'].fix,
      });
    for (const e of ex.active)
      if (!used.has(e))
        exceptionDrafts.push({
          rule: 'scan/exception/unused',
          group: 'exceptions',
          target: safe(e.server),
          path: e.path === undefined ? '' : safeText(e.path),
          location: { file: safeText(ex.file), line: e.line },
          message: `the exception for ${e.rule} matched no finding`,
          fix: EXCEPTION_RULES['scan/exception/unused'].fix,
        });
    for (const d of exceptionDrafts.sort(order)) findings.push(finish(d));
  }

  rows.sort(
    (a, b) =>
      a.group.localeCompare(b.group) ||
      (a.rule ?? '').localeCompare(b.rule ?? '') ||
      a.target.localeCompare(b.target) ||
      a.reason.localeCompare(b.reason),
  );
  const counted = findings.filter((f) => f.counted).length;
  const live = findings.filter((f) => f.suppressed === undefined);
  const count = (level: ScanLevel) => live.filter((f) => f.severity === level).length;
  const unmeasured = rows.some((r) => r.kind === 'could-not-run');
  const ranAny = groups.some((g) => g.state === 'ran');
  let exitCode: number = MCP_EXIT.ok;
  let partial = false;
  if (counted > 0) exitCode = MCP_EXIT.violations;
  else if (unmeasured) {
    if (opts.allowPartial && ranAny) partial = true;
    else exitCode = MCP_EXIT.unmeasured;
  }
  const notes: string[] = [];
  if (findings.some((f) => f.location === undefined))
    notes.push(
      'Some findings have no place in a file (a live server without --save-snapshot): SARIF counts them in omittedResults instead of showing them.',
    );
  if (partial)
    notes.push(
      '--allow-partial: the exit code is 0 although something that was asked for did not run.',
    );
  return {
    kind: 'mcp-scan-report',
    schemaVersion: 1,
    exitCode,
    result:
      exitCode === MCP_EXIT.unmeasured
        ? 'not-measured'
        : live.length === 0
          ? 'no-findings'
          : 'findings',
    failOn: opts.failOn,
    gateHeuristics: opts.gateHeuristics,
    allowPartial: opts.allowPartial,
    partial,
    groups: GROUPS.map((g) => groups.find((x) => x.group === g)!),
    inputs: {
      snapshots: input.snapshots.length,
      tools: input.snapshots.reduce((n, s) => n + (s.snapshot.tools?.length ?? 0), 0),
      configFiles: input.configFiles.length,
      servers: groups.find((g) => g.group === 'config')!.targets.length,
      pinFile: input.pin === undefined ? null : safeText(input.pin.file),
    },
    counts: {
      error: count('error'),
      warn: count('warn'),
      info: count('info'),
      advice: count('advice'),
      total: live.length,
      counted,
      suppressed: findings.length - live.length,
      notAffectingExit: live.filter((f) => !f.counted).length,
    },
    findings,
    probes: {
      rows: asked.active
        ? section.rows.map((r) => ({ ...r, id: safeText(r.id), tool: safeText(r.tool) }))
        : [],
      calls: asked.active ? section.calls : 0,
      requests: asked.active ? section.requests : 0,
      metadata: asked.active ? section.metadata : null,
    },
    notEvaluated: rows,
    exceptions: {
      file: ex === undefined ? null : safeText(ex.file),
      expired: ex?.expired.length ?? 0,
      unused: exceptionDrafts.filter((d) => d.rule === 'scan/exception/unused').length,
    },
    omittedResults: findings.filter((f) => f.location === undefined).length,
    notes,
    disclaimer: DISCLAIMER,
  };
}

function fromConfig(f: ConfigFinding, snapshots: Map<string, ScanSnapshot>): Draft {
  const group: ScanGroup = f.rule.startsWith('scan/cross/') ? 'cross' : 'config';
  const own =
    f.file !== undefined && f.line !== undefined
      ? { file: f.file, line: f.line, ...(f.column === undefined ? {} : { column: f.column }) }
      : undefined;
  let location = own;
  if (location === undefined && f.origin === 'snapshot') {
    const s = [...snapshots.values()].find((x) => safe(x.label) === f.server);
    const where =
      s?.text === undefined || s.file === undefined ? undefined : pointerPlace(s.text, f.path);
    if (s?.file !== undefined && where !== undefined)
      location = { file: safeText(s.file), ...where };
  }
  return {
    rule: f.rule as ConfigRuleId,
    group,
    severity: f.level,
    target: f.server,
    path: f.path,
    ...(location === undefined ? {} : { location }),
    message: f.message,
    fix: f.fix,
  };
}
