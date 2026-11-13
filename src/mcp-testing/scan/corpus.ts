import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSnapshot, type McpSnapshot } from '../snapshot/snapshot.js';
import {
  DESC_RULES,
  descriptionTexts,
  scanDescriptions,
  type DescRuleId,
  type DescriptionFinding,
} from './descriptions.js';

/**
 * The accuracy corpus of `plune mcp scan` (MCP-G7) and the measure over it. `corpus/malicious/` holds, per fixture, a
 * snapshot and an expectation file (`{ rule, pointer }` pairs plus where the fixture came from); `corpus/benign/` holds
 * snapshots of ordinary tool lists with an `origin` of `real` or `synthetic`. The measure counts, per rule, which
 * expected findings the rule makes and how many ordinary texts it flags, apart for each origin.
 *
 * What it measures is fixture recall: the fixtures are written by the authors of the rules, so "found 100 %" says the
 * rules still work, not that they find real attacks. False findings on ordinary descriptions are the honest number.
 * A rule with no fixture is `not measured`, never a pass.
 */

export interface Expectation {
  rule: DescRuleId;
  pointer: string;
}
export interface Provenance {
  catalogClass: string;
  mechanism: string;
  concealment: string;
  source: string;
  catalogRefs: string[];
  author: string;
  date: string;
}
export interface MaliciousFixture {
  id: string;
  snapshot: McpSnapshot;
  expected: Expectation[];
  provenance: Provenance;
}
export type Origin = 'real' | 'synthetic';
export interface BenignSet {
  id: string;
  origin: Origin;
  snapshot: McpSnapshot;
}
export interface Corpus {
  malicious: MaliciousFixture[];
  benign: BenignSet[];
}

export const GATE_MIN_UNITS = 385;
const Z = 1.96;

/** The upper end of the 95 % Wilson interval of `k` in `n`; `null` for no units. */
export function wilsonUpper95(k: number, n: number): number | null {
  if (n === 0) return null;
  const p = k / n;
  const z2 = Z * Z;
  const upper =
    (p + z2 / (2 * n) + Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return Math.round(upper * 1e6) / 1e6;
}

/** A `{ $repeat, bytes }` object stands for a text of that many bytes: a megabyte per fixture would bloat the repository. */
function expand(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(expand);
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>;
    if (typeof o['$repeat'] === 'string' && typeof o['bytes'] === 'number') {
      return o['$repeat'].repeat(Math.ceil(o['bytes'] / Buffer.byteLength(o['$repeat'])));
    }
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, expand(x)]));
  }
  return v;
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
const readSnapshot = (path: string): McpSnapshot =>
  parseSnapshot(JSON.stringify(expand(readJson(path))));
const ids = (dir: string, suffix: string) =>
  readdirSync(dir)
    .filter((f) => f.endsWith(suffix))
    .map((f) => f.slice(0, -suffix.length))
    .sort();

export function loadCorpus(root: string): Corpus {
  const malicious = ids(join(root, 'malicious'), '.snapshot.json').map((id) => {
    const meta = readJson(join(root, 'malicious', `${id}.expected.json`)) as {
      expected: Expectation[];
      provenance: Provenance;
    };
    for (const e of meta.expected)
      if (!(e.rule in DESC_RULES))
        throw new Error(`fixture ${id} expects a rule that does not exist`);
    return {
      id,
      snapshot: readSnapshot(join(root, 'malicious', `${id}.snapshot.json`)),
      expected: meta.expected,
      provenance: meta.provenance,
    };
  });
  const benign = ids(join(root, 'benign'), '.snapshot.json').map((id) => {
    const meta = readJson(join(root, 'benign', `${id}.meta.json`)) as { origin: Origin };
    return {
      id,
      origin: meta.origin,
      snapshot: readSnapshot(join(root, 'benign', `${id}.snapshot.json`)),
    };
  });
  return { malicious, benign };
}

/** SHA-256 over the names and contents (line ends as LF) of every corpus file but the two generated ones. */
export function corpusHash(root: string): string {
  const h = createHash('sha256');
  for (const dir of ['malicious', 'benign']) {
    for (const f of readdirSync(join(root, dir)).sort()) {
      h.update(`${dir}/${f}\n${readFileSync(join(root, dir, f), 'utf8').replace(/\r\n/g, '\n')}\n`);
    }
  }
  h.update(
    `SOURCES.json\n${readFileSync(join(root, 'SOURCES.json'), 'utf8').replace(/\r\n/g, '\n')}`,
  );
  return h.digest('hex');
}

export interface Place {
  set: string;
  pointer: string;
}
export interface OriginCount {
  units: number;
  falsePositives: Place[];
  wilsonUpper95: number | null;
}
export interface RuleReport {
  status: 'measured' | 'not measured';
  fixtures: number;
  detected: number;
  missed: { fixture: string; pointer: string }[];
  benign: Record<Origin, OriginCount>;
  gateEligible: boolean;
  gateReason: string;
}
export type Report = Record<DescRuleId, RuleReport>;

export type Scan = (snapshot: McpSnapshot) => DescriptionFinding[];
const defaultScan: Scan = (s) => scanDescriptions(s).findings;

/** The units of one rule in a snapshot: every text, but for the parameter rule only the string parameters' descriptions. */
const unitsOf = (rule: DescRuleId, s: McpSnapshot) =>
  descriptionTexts(s).filter((t) => rule !== 'scan/desc/param-asks-for-context' || t.stringParam)
    .length;

export function measure(corpus: Corpus, scan: Scan = defaultScan): Report {
  const report = {} as Report;
  const malicious = corpus.malicious.map((f) => ({ f, found: scan(f.snapshot) }));
  const benign = corpus.benign.map((b) => ({ b, found: scan(b.snapshot) }));
  for (const rule of Object.keys(DESC_RULES).sort() as DescRuleId[]) {
    const expected = malicious.flatMap(({ f, found }) =>
      f.expected
        .filter((e) => e.rule === rule)
        .map((e) => ({
          fixture: f.id,
          pointer: e.pointer,
          hit: found.some((x) => x.rule === rule && x.pointer === e.pointer),
        })),
    );
    const count = (origin: Origin): OriginCount => {
      const sets = benign.filter(({ b }) => b.origin === origin);
      const units = sets.reduce((n, { b }) => n + unitsOf(rule, b.snapshot), 0);
      const falsePositives = sets.flatMap(({ b, found }) =>
        found.filter((x) => x.rule === rule).map((x) => ({ set: b.id, pointer: x.pointer })),
      );
      return { units, falsePositives, wilsonUpper95: wilsonUpper95(falsePositives.length, units) };
    };
    const real = count('real');
    const missed = expected
      .filter((e) => !e.hit)
      .map(({ fixture, pointer }) => ({ fixture, pointer }));
    const reasons = [
      DESC_RULES[rule].class !== 'deterministic' ? `class ${DESC_RULES[rule].class}` : '',
      expected.length === 0 ? 'no fixtures' : '',
      real.units < GATE_MIN_UNITS
        ? `not enough real units (${real.units} of ${GATE_MIN_UNITS})`
        : '',
      real.falsePositives.length > 0 ? 'false findings on real units' : '',
      missed.length > 0 ? 'missed fixtures' : '',
    ].filter(Boolean);
    report[rule] = {
      status: expected.length === 0 ? 'not measured' : 'measured',
      fixtures: expected.length,
      detected: expected.length - missed.length,
      missed,
      benign: { real, synthetic: count('synthetic') },
      gateEligible: reasons.length === 0,
      gateReason: reasons.join('; '),
    };
  }
  return report;
}

/** What the corpus control keeps: the numbers a later measure may not make worse, with the date and the commit they were taken at. */
export interface Baseline {
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

export function baselineOf(
  report: Report,
  meta: { measuredAt: string; commit: string; corpusSha256: string },
): Baseline {
  const rules: Baseline['rules'] = {};
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

/**
 * Where a fresh measure is worse than the baseline; an empty list is a pass. A rule with no fixture, a fixture the baseline
 * saw found and is now missed, a false finding the baseline did not have, and a corpus that is not the one measured are all
 * problems. The lines carry rule ids, fixture ids and pointers only, never text the fixtures hold.
 */
export function compareToBaseline(
  report: Report,
  baseline: Baseline,
  corpusSha256: string,
): string[] {
  const problems: string[] = [];
  if (corpusSha256 !== baseline.corpusSha256)
    problems.push('the corpus changed and corpus/baseline.json was not updated');
  const key = (p: { fixture?: string; set?: string; pointer: string }) =>
    `${p.fixture ?? p.set} ${p.pointer}`;
  for (const id of Object.keys(DESC_RULES)) {
    const now = report[id as DescRuleId];
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
