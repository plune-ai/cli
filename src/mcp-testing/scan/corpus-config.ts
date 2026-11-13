import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONFIG_RULES,
  scanClientConfig,
  type ClientId,
  type ConfigOptions,
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
 * The accuracy corpus of the `scan/cfg/*` rules of `plune mcp scan` (MCP-G7, second part), beside the corpus of the
 * description rules (`corpus.ts`, which it imports from and does not change). `corpus/config/malicious/` holds client
 * files as text (`<id>.config.txt`) with an expectation file (`<id>.expected.json`); `corpus/config/benign/` holds
 * ordinary files with a meta file. A file is text, not JSON, because some fixtures are broken on purpose.
 *
 * A token is never stored: a fixture writes `{{token:<format>:<seed>}}` and the loader expands it to a fake value of
 * that format, the same for the same seed. `{{repeat:<unit>:<bytes>}}` expands to a long text. The test then looks for
 * every expanded token, and any 8 characters of it, in the whole result of the scanner.
 *
 * Units of the false findings: the server entry (`servers`) and the string field of an entry (`fields`); a rule that
 * needs a list the caller gives (`foreign-host`, `package-not-allowed`) counts only the files that gave it. Like the
 * description corpus, this measures fixture recall, not the share of real attacks found.
 */

export const CFG_RULES = (Object.keys(CONFIG_RULES) as ConfigRuleId[])
  .filter((r) => r.startsWith('scan/cfg/'))
  .sort();

export type NotChecked =
  | { kind: 'not-evaluated'; rule: ConfigRuleId; path: string }
  | { kind: 'unreadable'; problem: 'parse-error' | 'too-large' };
export interface CfgExpectation {
  rule: ConfigRuleId;
  path: string;
}
export interface CfgFixture {
  id: string;
  client: ClientId;
  path: string;
  text: string;
  options: ConfigOptions;
  expected: CfgExpectation[];
  notChecked: NotChecked[];
  provenance: Provenance;
  /** The fake tokens the placeholders expanded to. */
  tokens: string[];
}
export interface CfgBenign {
  id: string;
  origin: Origin;
  client: ClientId;
  path: string;
  text: string;
  options: ConfigOptions;
}
export interface ConfigCorpus {
  malicious: CfgFixture[];
  benign: CfgBenign[];
}

// ---- the placeholders --------------------------------------------------------------------------------------------

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const FORMATS: Record<
  string,
  { prefix: string; length: number; alphabet: string } | { literal: string }
> = {
  ghp: { prefix: 'ghp_', length: 36, alphabet: ALNUM },
  githubpat: { prefix: 'github_pat_', length: 60, alphabet: `${ALNUM}_` },
  aws: { prefix: 'AKIA', length: 16, alphabet: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567' },
  slack: { prefix: 'xoxb-', length: 24, alphabet: ALNUM },
  stripe: { prefix: 'sk_live_', length: 24, alphabet: ALNUM },
  anthropic: { prefix: 'sk-ant-', length: 40, alphabet: `${ALNUM}_-` },
  openai: { prefix: 'sk-proj-', length: 48, alphabet: `${ALNUM}_-` },
  google: { prefix: 'AIza', length: 35, alphabet: `${ALNUM}_-` },
  npm: { prefix: 'npm_', length: 36, alphabet: ALNUM },
  gitlab: { prefix: 'glpat-', length: 20, alphabet: `${ALNUM}_-` },
  privatekey: { literal: ['-----BEGIN RSA', 'PRIVATE KEY-----'].join(' ') },
};
const MAX_REPEAT = 16 * 1024 * 1024;

/** A fake token of a format: the same text for the same seed, in the alphabet and length of the format. */
export function fakeToken(format: string, seed: number): string {
  const f = FORMATS[format];
  if (f === undefined) throw new Error(`unknown token format "${format}"`);
  if ('literal' in f) return f.literal;
  let body = '';
  for (let round = 0; body.length < f.length; round++) {
    for (const byte of createHash('sha256').update(`${format}:${seed}:${round}`).digest())
      body += f.alphabet[byte % f.alphabet.length];
  }
  return f.prefix + body.slice(0, f.length);
}

function expandText(text: string, file: string): { text: string; tokens: string[] } {
  const tokens: string[] = [];
  const out = text.replace(
    /\{\{(token|repeat):([^:{}]*):(\d+)\}\}/g,
    (_m, kind: string, a: string, b: string) => {
      if (kind === 'token') {
        if (!(a in FORMATS)) throw new Error(`${file}: unknown token format`);
        const token = fakeToken(a, Number(b));
        tokens.push(token);
        return token;
      }
      const bytes = Number(b);
      if (a === '' || bytes < 1 || bytes > MAX_REPEAT) throw new Error(`${file}: bad repeat`);
      return a.repeat(Math.ceil(bytes / Buffer.byteLength(a)));
    },
  );
  return { text: out, tokens };
}

// ---- loading -----------------------------------------------------------------------------------------------------

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
const CLIENT_IDS: readonly string[] = ['claude-code', 'cursor', 'vscode', 'claude-desktop'];

/** The ids of a folder, from its config files; a sidecar with no config, or a config with no sidecar, names the file. */
function idsOf(dir: string, sidecar: string): string[] {
  const files = readdirSync(dir);
  const configs = new Set(
    files.filter((f) => f.endsWith('.config.txt')).map((f) => f.slice(0, -11)),
  );
  for (const f of files) {
    if (f.endsWith(sidecar) && !configs.has(f.slice(0, -sidecar.length)))
      throw new Error(`${f}: no matching .config.txt`);
  }
  for (const id of configs)
    if (!files.includes(`${id}${sidecar}`))
      throw new Error(`${id}.config.txt: no matching ${id}${sidecar}`);
  return [...configs].sort();
}

export function loadConfigCorpus(root: string): ConfigCorpus {
  const dir = join(root, 'config');
  const malicious = idsOf(join(dir, 'malicious'), '.expected.json').map((id) => {
    const meta = readJson(join(dir, 'malicious', `${id}.expected.json`)) as Omit<
      CfgFixture,
      'id' | 'text' | 'tokens' | 'options'
    > & { options?: ConfigOptions };
    for (const e of meta.expected)
      if (!(e.rule in CONFIG_RULES))
        throw new Error(`fixture ${id} expects a rule that does not exist`);
    if (!CLIENT_IDS.includes(meta.client)) throw new Error(`fixture ${id}: unknown client`);
    const { text, tokens } = expandText(
      readFileSync(join(dir, 'malicious', `${id}.config.txt`), 'utf8'),
      `${id}.config.txt`,
    );
    return { ...meta, id, text, tokens, options: meta.options ?? {} };
  });
  const benign = idsOf(join(dir, 'benign'), '.meta.json').map((id) => {
    const meta = readJson(join(dir, 'benign', `${id}.meta.json`)) as {
      origin: Origin;
      client: ClientId;
      path: string;
      options?: ConfigOptions;
    };
    if (meta.origin !== 'real' && meta.origin !== 'synthetic')
      throw new Error(`${id}: origin must be real or synthetic`);
    if (!CLIENT_IDS.includes(meta.client)) throw new Error(`${id}: unknown client`);
    const { text } = expandText(
      readFileSync(join(dir, 'benign', `${id}.config.txt`), 'utf8'),
      `${id}.config.txt`,
    );
    return {
      id,
      origin: meta.origin,
      client: meta.client,
      path: meta.path,
      text,
      options: meta.options ?? {},
    };
  });
  return { malicious, benign };
}

/** SHA-256 over the names and contents (line ends as LF) of every file of `corpus/config/malicious` and `benign`. */
export function configCorpusHash(root: string): string {
  const h = createHash('sha256');
  for (const d of ['malicious', 'benign']) {
    for (const f of readdirSync(join(root, 'config', d)).sort()) {
      h.update(
        `${d}/${f}\n${readFileSync(join(root, 'config', d, f), 'utf8').replace(/\r\n/g, '\n')}\n`,
      );
    }
  }
  return h.digest('hex');
}

// ---- the measure -------------------------------------------------------------------------------------------------

export type CfgScan = (
  file: { path: string; client: ClientId; text: string },
  options: ConfigOptions,
) => ConfigScan;
const defaultScan: CfgScan = (file, options) => scanClientConfig([file], options);

export interface CfgOriginCount {
  servers: number;
  fields: number;
  falsePositives: Place[];
  wilsonUpper95Servers: number | null;
}
export interface CfgRuleReport {
  status: 'measured' | 'not measured';
  fixtures: number;
  detected: number;
  missed: { fixture: string; pointer: string }[];
  benign: Record<Origin, CfgOriginCount>;
  gateEligible: boolean;
  gateReason: string;
}
export interface CfgReport {
  rules: Record<string, CfgRuleReport>;
  /** What the scanner must say it did not check, counted apart from findings. */
  notChecked: { expected: number; detected: number; missed: { fixture: string; what: string }[] };
}

/** The string leaves under the server entries of a client file; 0 when the text is not plain JSON. */
function stringFields(text: string): number {
  let root: unknown;
  try {
    root = JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''));
  } catch {
    return 0;
  }
  const leaves = (v: unknown): number =>
    typeof v === 'string'
      ? 1
      : Array.isArray(v)
        ? v.reduce<number>((n, x) => n + leaves(x), 0)
        : typeof v === 'object' && v !== null
          ? Object.values(v).reduce<number>((n, x) => n + leaves(x), 0)
          : 0;
  const lists: unknown[] = [];
  const o = (root ?? {}) as Record<string, unknown>;
  lists.push(o['mcpServers'], o['servers']);
  const projects = o['projects'];
  if (typeof projects === 'object' && projects !== null) {
    for (const p of Object.values(projects))
      lists.push((p as Record<string, unknown> | null)?.['mcpServers']);
  }
  return lists.reduce<number>(
    (n, l) =>
      n +
      (typeof l === 'object' && l !== null && !Array.isArray(l)
        ? Object.values(l).reduce<number>((m, e) => m + leaves(e), 0)
        : 0),
    0,
  );
}

const needsList = (rule: string, options: ConfigOptions): boolean =>
  rule === 'scan/cfg/foreign-host'
    ? !options.allowHosts?.length
    : rule === 'scan/cfg/package-not-allowed'
      ? !options.allowPackages?.length
      : false;

export function measureConfig(corpus: ConfigCorpus, scan: CfgScan = defaultScan): CfgReport {
  const run = (f: { path: string; client: ClientId; text: string; options: ConfigOptions }) =>
    scan({ path: f.path, client: f.client, text: f.text }, f.options);
  const malicious = corpus.malicious.map((f) => ({ f, result: run(f) }));
  const benign = corpus.benign.map((b) => ({ b, result: run(b), fields: stringFields(b.text) }));
  const rules: Record<string, CfgRuleReport> = {};
  for (const rule of CFG_RULES) {
    const expected = malicious.flatMap(({ f, result }) =>
      f.expected
        .filter((e) => e.rule === rule)
        .map((e) => ({
          fixture: f.id,
          pointer: e.path,
          hit: result.findings.some((x) => x.rule === rule && x.path === e.path),
        })),
    );
    const count = (origin: Origin): CfgOriginCount => {
      const sets = benign.filter(({ b }) => b.origin === origin && !needsList(rule, b.options));
      const servers = sets.reduce(
        (n, { result }) => n + result.files.reduce((m, x) => m + x.servers.length, 0),
        0,
      );
      const fields = sets.reduce((n, s) => n + s.fields, 0);
      const falsePositives = sets.flatMap(({ b, result }) =>
        result.findings.filter((x) => x.rule === rule).map((x) => ({ set: b.id, pointer: x.path })),
      );
      return {
        servers,
        fields,
        falsePositives,
        wilsonUpper95Servers: wilsonUpper95(falsePositives.length, servers),
      };
    };
    const real = count('real');
    const missed = expected
      .filter((e) => !e.hit)
      .map(({ fixture, pointer }) => ({ fixture, pointer }));
    const reasons = [
      CONFIG_RULES[rule].class !== 'deterministic' ? `class ${CONFIG_RULES[rule].class}` : '',
      expected.length === 0 ? 'no fixtures' : '',
      real.servers < GATE_MIN_UNITS
        ? `not enough real units (${real.servers} of ${GATE_MIN_UNITS})`
        : '',
      real.falsePositives.length > 0 ? 'false findings on real units' : '',
      missed.length > 0 ? 'missed fixtures' : '',
    ].filter(Boolean);
    rules[rule] = {
      status: expected.length === 0 ? 'not measured' : 'measured',
      fixtures: expected.length,
      detected: expected.length - missed.length,
      missed,
      benign: { real, synthetic: count('synthetic') },
      gateEligible: reasons.length === 0,
      gateReason: reasons.join('; '),
    };
  }
  const notChecked: CfgReport['notChecked'] = { expected: 0, detected: 0, missed: [] };
  for (const { f, result } of malicious) {
    for (const n of f.notChecked) {
      notChecked.expected++;
      const hit =
        n.kind === 'not-evaluated'
          ? result.notEvaluated.some((x) => x.rule === n.rule && x.path === n.path)
          : result.files.some(
              (x) => x.status === 'unreadable' && x.problems.some((p) => p.kind === n.problem),
            );
      if (hit) notChecked.detected++;
      else
        notChecked.missed.push({
          fixture: f.id,
          what: n.kind === 'not-evaluated' ? `${n.rule} ${n.path}` : n.problem,
        });
    }
  }
  return { rules, notChecked };
}

/** What a later measure may not make worse, with the date and the commit it was taken at. */
export interface CfgBaseline {
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
  notChecked: { expected: number; missed: { fixture: string; what: string }[] };
}

export function cfgBaselineOf(
  report: CfgReport,
  meta: { measuredAt: string; commit: string; corpusSha256: string },
): CfgBaseline {
  const rules: CfgBaseline['rules'] = {};
  for (const [id, r] of Object.entries(report.rules)) {
    rules[id] = {
      fixtures: r.fixtures,
      missed: r.missed,
      falsePositives: {
        real: r.benign.real.falsePositives,
        synthetic: r.benign.synthetic.falsePositives,
      },
    };
  }
  return {
    ...meta,
    rules,
    notChecked: { expected: report.notChecked.expected, missed: report.notChecked.missed },
  };
}

/** Where a fresh measure is worse than the baseline; the lines hold rule ids, fixture ids and paths, never text of a file. */
export function compareCfgToBaseline(
  report: CfgReport,
  baseline: CfgBaseline,
  corpusSha256: string,
): string[] {
  const problems: string[] = [];
  if (corpusSha256 !== baseline.corpusSha256)
    problems.push('the config corpus changed and corpus/config/baseline.json was not updated');
  const key = (p: { fixture?: string; set?: string; pointer: string }) =>
    `${p.fixture ?? p.set} ${p.pointer}`;
  for (const id of CFG_RULES) {
    const now = report.rules[id]!;
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
  if (report.notChecked.expected < baseline.notChecked.expected)
    problems.push(
      `not checked: ${report.notChecked.expected} fixtures, the baseline has ${baseline.notChecked.expected}`,
    );
  if (report.notChecked.expected === 0) problems.push('not checked: no fixture');
  const before = new Set(baseline.notChecked.missed.map((m) => `${m.fixture} ${m.what}`));
  for (const m of report.notChecked.missed)
    if (!before.has(`${m.fixture} ${m.what}`))
      problems.push(`not checked: now not reported ${m.fixture} ${m.what}`);
  return problems;
}

/** Whether a text holds the token, or any run of 8 of its characters. */
export function leaksToken(text: string, token: string): boolean {
  if (text.includes(token)) return true;
  for (let i = 0; i + 8 <= token.length; i++) if (text.includes(token.slice(i, i + 8))) return true;
  return false;
}
