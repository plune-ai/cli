import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseSnapshot, type McpSnapshot } from '../snapshot/index.js';
import {
  CONFIG_RULES,
  scanClientConfig,
  type ConfigRuleId,
  type ConfigScan,
} from './config/config.js';
import {
  GATE_MIN_UNITS,
  wilsonUpper95,
  type Origin,
  type Place,
  type Provenance,
} from './corpus.js';

/**
 * The accuracy corpus of the `scan/cross/*` rules of `plune mcp scan` (MCP-G7, third part), beside the corpus of the
 * description rules (`corpus.ts`) and of the client-configuration rules (`corpus-config.ts`), which it imports from and
 * does not change. A unit here is a group of two or more servers, because a cross rule reads the servers together:
 * `corpus/cross/malicious/<id>.group.json` holds the servers of a group, with `<id>.expected.json`; `corpus/cross/benign/`
 * holds ordinary groups with `<id>.meta.json`.
 *
 * Everything in it is `synthetic`: written for this corpus, no text copied from a real server. An expectation that the
 * rules are known not to meet is a **designed miss** (it carries the reason): it is counted as missed, so the number is
 * honest, and the control looks for it to stay missed. Like the other corpora, this measures fixture recall, not the
 * share of real attacks found; false findings are counted on ordinary groups per group and per tool pair (a pair of
 * tools of two servers of a group), `real` and `synthetic` apart.
 */

export const CROSS_RULES = (Object.keys(CONFIG_RULES) as ConfigRuleId[])
  .filter((r) => r.startsWith('scan/cross/'))
  .sort();

/** A server of a group as a fixture writes it; the loader makes a snapshot of it. */
export interface GroupServer {
  tools?: { name: string; description?: string; inputSchema?: unknown }[];
  prompts?: { name: string; description?: string }[];
  resources?: { uri: string; name: string; description?: string }[];
  instructions?: string;
}
export interface CrossExpectation {
  rule: ConfigRuleId;
  /** The label of the server the finding is on. */
  server: string;
  /** The pointer into that server's snapshot. */
  path: string;
  /** Set on an expectation the rule is known not to meet: why. */
  designedMiss?: string;
}
export interface CrossFixture {
  id: string;
  origin: Origin;
  snapshots: Map<string, McpSnapshot>;
  expected: CrossExpectation[];
  provenance: Provenance;
}
export interface CrossBenign {
  id: string;
  origin: Origin;
  snapshots: Map<string, McpSnapshot>;
}
export interface CrossCorpus {
  malicious: CrossFixture[];
  benign: CrossBenign[];
}

/** The largest file of the corpus the loader reads; a fixture is a few KB. */
export const MAX_CORPUS_FILE_BYTES = 256 * 1024;

/** Reads a file of the corpus as JSON; every complaint names the file, none quotes its text. */
function readJson(path: string, file: string): unknown {
  if (statSync(path).size > MAX_CORPUS_FILE_BYTES)
    throw new Error(`${file}: too large (over ${MAX_CORPUS_FILE_BYTES / 1024} KiB)`);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${file}: not valid JSON`);
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const filled = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** `value` is an object whose keys are all in `allowed`; names the first one that is not. */
function onlyKeys(
  value: unknown,
  allowed: readonly string[] | null,
  file: string,
  what: string,
): Record<string, unknown> {
  if (!isObject(value)) throw new Error(`${file}: ${what} is not an object`);
  if (allowed !== null)
    for (const k of Object.keys(value))
      if (!allowed.includes(k)) throw new Error(`${file}: ${what} has an unknown key "${k}"`);
  return value;
}
function needFilled(
  value: Record<string, unknown>,
  keys: readonly string[],
  file: string,
  what: string,
): void {
  for (const k of keys) if (!filled(value[k])) throw new Error(`${file}: ${what} has no "${k}"`);
}

const PROVENANCE_KEYS = ['catalogClass', 'mechanism', 'concealment', 'source', 'author', 'date'];
const ENTRY_KEYS = {
  tools: ['name', 'description', 'inputSchema'],
  prompts: ['name', 'description'],
  resources: ['uri', 'name', 'description'],
} as const;

function snapshotOf(label: string, s: GroupServer, file: string): McpSnapshot {
  const capabilities: Record<string, unknown> = {};
  if (s.tools !== undefined) capabilities['tools'] = {};
  if (s.prompts !== undefined) capabilities['prompts'] = {};
  if (s.resources !== undefined) capabilities['resources'] = {};
  try {
    return parseSnapshot(
      JSON.stringify({
        kind: 'plune-mcp-snapshot',
        schemaVersion: 2,
        transport: 'stdio',
        server: { name: label, version: '0.0.0' },
        instructions: s.instructions ?? null,
        capabilities,
        tools: s.tools ?? null,
        resources: s.resources ?? null,
        resourceTemplates: null,
        prompts: s.prompts ?? null,
      }),
    );
  } catch {
    throw new Error(`${file}: server "${label}" is not a snapshot`);
  }
}

function groupOf(path: string, file: string): Map<string, McpSnapshot> {
  const raw = onlyKeys(readJson(path, file), ['servers'], file, 'the group');
  const entries = Object.entries(onlyKeys(raw['servers'] ?? {}, null, file, '"servers"'));
  if (entries.length < 2) throw new Error(`${file}: a group has at least two servers`);
  for (const [label, server] of entries) {
    const s = onlyKeys(
      server,
      ['instructions', ...Object.keys(ENTRY_KEYS)],
      file,
      `server "${label}"`,
    );
    for (const [list, keys] of Object.entries(ENTRY_KEYS)) {
      if (s[list] === undefined) continue;
      if (!Array.isArray(s[list]))
        throw new Error(`${file}: server "${label}" "${list}" is not an array`);
      for (const entry of s[list] as unknown[])
        onlyKeys(entry, keys, file, `an entry of "${list}" of "${label}"`);
    }
  }
  return new Map(entries.map(([label, s]) => [label, snapshotOf(label, s as GroupServer, file)]));
}

/** The ids of a folder, from its group files; a sidecar with no group, or a group with no sidecar, names the file. */
function idsOf(dir: string, sidecar: string): string[] {
  const files = readdirSync(dir);
  const groups = new Set(
    files.filter((f) => f.endsWith('.group.json')).map((f) => f.slice(0, -'.group.json'.length)),
  );
  for (const f of files)
    if (f.endsWith(sidecar) && !groups.has(f.slice(0, -sidecar.length)))
      throw new Error(`${f}: no matching .group.json`);
  for (const id of groups)
    if (!files.includes(`${id}${sidecar}`))
      throw new Error(`${id}.group.json: no matching ${id}${sidecar}`);
  return [...groups].sort();
}

function provenanceOf(value: unknown, file: string): Provenance {
  if (value === undefined) throw new Error(`${file}: no provenance`);
  const p = onlyKeys(value, [...PROVENANCE_KEYS, 'catalogRefs'], file, 'the provenance');
  needFilled(p, PROVENANCE_KEYS, file, 'the provenance');
  const refs = p['catalogRefs'];
  if (!Array.isArray(refs) || refs.length === 0 || !refs.every(filled))
    throw new Error(`${file}: the provenance has no "catalogRefs"`);
  return p as unknown as Provenance;
}

function originOf(id: string, value: unknown): Origin {
  if (value !== 'real' && value !== 'synthetic')
    throw new Error(`${id}: origin must be real or synthetic`);
  return value;
}

export function loadCrossCorpus(root: string): CrossCorpus {
  const dir = join(root, 'cross');
  const malicious = idsOf(join(dir, 'malicious'), '.expected.json').map((id) => {
    const file = `${id}.expected.json`;
    const raw = readJson(join(dir, 'malicious', file), file);
    const meta = onlyKeys(raw, ['origin', 'expected', 'provenance'], file, 'the file');
    const origin = originOf(id, meta['origin']);
    const snapshots = groupOf(join(dir, 'malicious', `${id}.group.json`), `${id}.group.json`);
    if (!Array.isArray(meta['expected'])) throw new Error(`${file}: "expected" is not an array`);
    const expected = (meta['expected'] as unknown[]).map((item) => {
      const e = onlyKeys(item, ['rule', 'server', 'path', 'designedMiss'], file, 'an expectation');
      if (e['designedMiss'] !== undefined && !filled(e['designedMiss']))
        throw new Error(`${file}: "designedMiss" is not a string`);
      if (
        typeof e['rule'] !== 'string' ||
        !(e['rule'] in CONFIG_RULES) ||
        !e['rule'].startsWith('scan/cross/')
      )
        throw new Error(`fixture ${id} expects a rule that does not exist`);
      if (typeof e['server'] !== 'string' || !snapshots.has(e['server']))
        throw new Error(`fixture ${id} expects a finding on a server that is not in the group`);
      if (!filled(e['path'])) throw new Error(`${file}: an expectation has no "path"`);
      return e as unknown as CrossExpectation;
    });
    return { id, origin, snapshots, expected, provenance: provenanceOf(meta['provenance'], file) };
  });
  const benign = idsOf(join(dir, 'benign'), '.meta.json').map((id) => {
    const file = `${id}.meta.json`;
    const meta = onlyKeys(
      readJson(join(dir, 'benign', file), file),
      ['origin', 'description', 'author', 'date'],
      file,
      'the file',
    );
    const origin = originOf(id, meta['origin']);
    needFilled(meta, ['description', 'author', 'date'], file, 'the file');
    return {
      id,
      origin,
      snapshots: groupOf(join(dir, 'benign', `${id}.group.json`), `${id}.group.json`),
    };
  });
  return { malicious, benign };
}

/** SHA-256 over the names and contents (line ends as LF) of every file of `corpus/cross/malicious` and `benign`. */
export function crossCorpusHash(root: string): string {
  const h = createHash('sha256');
  for (const d of ['malicious', 'benign']) {
    for (const f of readdirSync(join(root, 'cross', d)).sort()) {
      h.update(
        `${d}/${f}\n${readFileSync(join(root, 'cross', d, f), 'utf8').replace(/\r\n/g, '\n')}\n`,
      );
    }
  }
  return h.digest('hex');
}

// ---- the measure -------------------------------------------------------------------------------------------------

export type CrossScan = (snapshots: Map<string, McpSnapshot>) => ConfigScan;
const defaultScan: CrossScan = (snapshots) => scanClientConfig([], { snapshots });

export interface CrossOriginCount {
  groups: number;
  /** Pairs of tools of two different servers of a group. */
  toolPairs: number;
  falsePositives: Place[];
  /** Groups with at least one false finding. */
  falseGroups: number;
  perGroup: number | null;
  perToolPair: number | null;
  wilsonUpper95Groups: number | null;
}
export interface CrossRuleReport {
  status: 'measured' | 'not measured';
  fixtures: number;
  detected: number;
  /** Expectations marked as designed misses. */
  designedMisses: number;
  /** Everything not found, designed misses included. */
  missed: { fixture: string; pointer: string }[];
  /** Designed misses the rule now finds: the corpus is out of date, or the rule changed. */
  foundDesignedMisses: { fixture: string; pointer: string }[];
  benign: Record<Origin, CrossOriginCount>;
  gateEligible: boolean;
  gateReason: string;
}
export type CrossReport = Record<string, CrossRuleReport>;

const pointerOf = (server: string, path: string) => `${server}${path}`;

/** Pairs of tools of two different servers: the unit the false findings are also counted on. */
export function toolPairs(snapshots: Map<string, McpSnapshot>): number {
  const counts = [...snapshots.values()].map((s) => s.tools?.length ?? 0);
  let pairs = 0;
  for (let i = 0; i < counts.length; i++)
    for (let j = i + 1; j < counts.length; j++) pairs += counts[i]! * counts[j]!;
  return pairs;
}

const ratio = (k: number, n: number): number | null =>
  n === 0 ? null : Math.round((k / n) * 10_000) / 10_000;

export function measureCross(corpus: CrossCorpus, scan: CrossScan = defaultScan): CrossReport {
  const malicious = corpus.malicious.map((f) => ({ f, result: scan(f.snapshots) }));
  const benign = corpus.benign.map((b) => ({ b, result: scan(b.snapshots) }));
  const report: CrossReport = {};
  for (const rule of CROSS_RULES) {
    const expected = malicious.flatMap(({ f, result }) =>
      f.expected
        .filter((e) => e.rule === rule)
        .map((e) => ({
          fixture: f.id,
          pointer: pointerOf(e.server, e.path),
          designed: e.designedMiss !== undefined,
          hit: result.findings.some(
            (x) => x.rule === rule && x.server === e.server && x.path === e.path,
          ),
        })),
    );
    const count = (origin: Origin): CrossOriginCount => {
      const sets = benign.filter(({ b }) => b.origin === origin);
      const groups = sets.length;
      const pairs = sets.reduce((n, { b }) => n + toolPairs(b.snapshots), 0);
      const falsePositives = sets.flatMap(({ b, result }) =>
        result.findings
          .filter((x) => x.rule === rule)
          .map((x) => ({ set: b.id, pointer: pointerOf(x.server, x.path) })),
      );
      const falseGroups = new Set(falsePositives.map((p) => p.set)).size;
      return {
        groups,
        toolPairs: pairs,
        falsePositives,
        falseGroups,
        perGroup: ratio(falsePositives.length, groups),
        perToolPair: ratio(falsePositives.length, pairs),
        wilsonUpper95Groups: wilsonUpper95(falseGroups, groups),
      };
    };
    const real = count('real');
    const missed = expected
      .filter((e) => !e.hit)
      .map(({ fixture, pointer }) => ({ fixture, pointer }));
    const reasons = [
      CONFIG_RULES[rule].class !== 'deterministic' ? `class ${CONFIG_RULES[rule].class}` : '',
      expected.length === 0 ? 'no fixtures' : '',
      real.groups < GATE_MIN_UNITS
        ? `not enough real units (${real.groups} of ${GATE_MIN_UNITS})`
        : '',
      real.falsePositives.length > 0 ? 'false findings on real units' : '',
      missed.some(
        (m) => !expected.find((e) => e.fixture === m.fixture && e.pointer === m.pointer)!.designed,
      )
        ? 'missed fixtures'
        : '',
    ].filter(Boolean);
    report[rule] = {
      status: expected.length === 0 ? 'not measured' : 'measured',
      fixtures: expected.length,
      detected: expected.length - missed.length,
      designedMisses: expected.filter((e) => e.designed).length,
      missed,
      foundDesignedMisses: expected
        .filter((e) => e.designed && e.hit)
        .map(({ fixture, pointer }) => ({ fixture, pointer })),
      benign: { real, synthetic: count('synthetic') },
      gateEligible: reasons.length === 0,
      gateReason: reasons.join('; '),
    };
  }
  return report;
}

/** What a later measure may not make worse, with the date and the commit it was taken at. */
export interface CrossBaseline {
  measuredAt: string;
  commit: string;
  corpusSha256: string;
  rules: Record<
    string,
    {
      fixtures: number;
      missed: { fixture: string; pointer: string }[];
      falsePositives: Record<Origin, Place[]>;
    }
  >;
}

export function crossBaselineOf(
  report: CrossReport,
  meta: { measuredAt: string; commit: string; corpusSha256: string },
): CrossBaseline {
  const rules: CrossBaseline['rules'] = {};
  for (const [id, r] of Object.entries(report)) {
    rules[id] = {
      fixtures: r.fixtures,
      missed: r.missed,
      falsePositives: {
        real: r.benign.real.falsePositives,
        synthetic: r.benign.synthetic.falsePositives,
      },
    };
  }
  return { ...meta, rules };
}

/** Where a fresh measure is worse than the baseline; the lines hold rule ids, fixture ids and pointers, never text of a file. */
export function compareCrossToBaseline(
  report: CrossReport,
  baseline: CrossBaseline,
  corpusSha256: string,
): string[] {
  const problems: string[] = [];
  if (corpusSha256 !== baseline.corpusSha256)
    problems.push('the cross corpus changed and corpus/cross/baseline.json was not updated');
  const key = (p: { fixture?: string; set?: string; pointer: string }) =>
    `${p.fixture ?? p.set} ${p.pointer}`;
  for (const id of CROSS_RULES) {
    const now = report[id]!;
    const was = baseline.rules[id];
    if (now.status === 'not measured') problems.push(`${id}: not measured (no fixture)`);
    if (was === undefined) {
      problems.push(`${id}: not in the baseline`);
      continue;
    }
    if (now.fixtures < was.fixtures)
      problems.push(`${id}: ${now.fixtures} fixtures, the baseline has ${was.fixtures}`);
    const missedBefore = new Set(was.missed.map(key));
    for (const m of now.missed)
      if (!missedBefore.has(key(m))) problems.push(`${id}: now misses ${key(m)}`);
    for (const origin of ['real', 'synthetic'] as const) {
      const before = new Set(was.falsePositives[origin].map(key));
      for (const f of now.benign[origin].falsePositives)
        if (!before.has(key(f))) problems.push(`${id}: new false finding on ${origin} ${key(f)}`);
    }
  }
  return problems;
}

/** The measured table, as the README holds it between its two markers. */
export function crossTable(report: CrossReport): string {
  const rows = [
    '| rule | found / expected (designed misses included) | designed misses | false findings (synthetic) | groups | tool pairs (denominator of the rate in report.json) | gate |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const id of CROSS_RULES) {
    const r = report[id]!;
    const s = r.benign.synthetic;
    rows.push(
      `| ${id} | ${r.detected} / ${r.fixtures} | ${r.designedMisses} | ${s.falsePositives.length} (in ${s.falseGroups} ${s.falseGroups === 1 ? 'group' : 'groups'}) | ${s.groups} | ${s.toolPairs} | ${r.gateEligible ? 'eligible' : 'not eligible'} |`,
    );
  }
  return rows.join('\n');
}
