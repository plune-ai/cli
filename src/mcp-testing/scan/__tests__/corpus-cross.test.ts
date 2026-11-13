// CLI · mcp scan · corpus · cross servers: the accuracy corpus of the `scan/cross/*` rules (MCP-G7, third part) and its
// regression control. Everything in it is synthetic; a failure names rules, fixtures and pointers only.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanClientConfig, type ConfigScan } from '../config/config.js';
import { corpusUpdateRequested } from '../corpus.js';
import {
  CROSS_RULES,
  MAX_CORPUS_FILE_BYTES,
  compareCrossToBaseline,
  crossBaselineOf,
  crossCorpusHash,
  crossTable,
  loadCrossCorpus,
  measureCross,
  toolPairs,
  type CrossBaseline,
  type CrossCorpus,
  type CrossScan,
} from '../corpus-cross.js';
import { visible } from '../descriptions.js';

const ROOT = join(__dirname, '..', '..', '..', '..');
const DIR = join(ROOT, 'corpus');
const REPORT = join(DIR, 'cross', 'report.json');
const BASELINE = join(DIR, 'cross', 'baseline.json');
const README = join(DIR, 'cross', 'README.md');
const START = '<!-- cross-table:start -->';
const END = '<!-- cross-table:end -->';

const corpus = loadCrossCorpus(DIR);
const report = measureCross(corpus);
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
const clip = (lines: string[]) => lines.map((l) => visible(l, 160));
const real: CrossScan = (snapshots) => scanClientConfig([], { snapshots });
const withTable = (readme: string, table: string) =>
  `${readme.slice(0, readme.indexOf(START) + START.length)}\n${table}\n${readme.slice(readme.indexOf(END))}`;

// `PLUNE_CORPUS_UPDATE=1 CORPUS_COMMIT=<sha> CORPUS_DATE=<date>` rewrites the generated files: the deliberate update.
if (corpusUpdateRequested(process.env)) {
  const meta = {
    measuredAt: process.env['CORPUS_DATE']!,
    commit: process.env['CORPUS_COMMIT']!,
    corpusSha256: crossCorpusHash(DIR),
  };
  if (!meta.measuredAt || !meta.commit) throw new Error('set CORPUS_COMMIT and CORPUS_DATE');
  writeFileSync(REPORT, json(report));
  writeFileSync(BASELINE, json(crossBaselineOf(report, meta)));
  writeFileSync(README, withTable(readFileSync(README, 'utf8'), crossTable(report)));
}
const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as CrossBaseline;

describe('CLI · mcp scan · corpus · cross servers · coverage of the catalog', () => {
  it('the code and the catalog list the same scan/cross rules, and each has at least three fixtures it should meet and one it is known to miss', () => {
    const catalog = readFileSync(
      join(ROOT, 'docs', 'features', 'mcp-scan', 'threat-catalog.md'),
      'utf8',
    );
    const inCatalog = [...catalog.matchAll(/^\| (scan\/cross\/[a-z-]+) \|/gm)]
      .map((m) => m[1]!)
      .sort();
    expect(inCatalog).toEqual([...CROSS_RULES]);
    const lacking = CROSS_RULES.filter((r) => {
      const x = report[r]!;
      return x.fixtures - x.designedMisses < 3 || x.designedMisses < 1;
    });
    expect(lacking).toEqual([]);
  });

  it('every fixture says where it came from and who wrote it: all synthetic, no source claimed', () => {
    const bad = corpus.malicious
      .filter(
        (f) =>
          f.origin !== 'synthetic' ||
          !f.provenance.mechanism ||
          !f.provenance.author ||
          !f.provenance.date ||
          !f.provenance.concealment ||
          f.provenance.source !== 'not verified',
      )
      .map((f) => f.id);
    expect(bad).toEqual([]);
    expect(corpus.benign.filter((b) => b.origin !== 'synthetic')).toEqual([]);
  });

  it('a designed miss says why, and every other expectation does not', () => {
    for (const f of corpus.malicious)
      for (const e of f.expected)
        if (e.designedMiss !== undefined) expect(e.designedMiss.length, f.id).toBeGreaterThan(10);
    expect(
      corpus.malicious.flatMap((f) => f.expected).filter((e) => 'designedMiss' in e).length,
    ).toBe(CROSS_RULES.reduce((n, r) => n + report[r]!.designedMisses, 0));
  });

  it('the ordinary side covers the cases the brief names: same name on unrelated servers, a staging copy, common verbs', () => {
    const ids = corpus.benign.map((b) => b.id);
    for (const id of [
      'two-unrelated-both-search',
      'server-and-staging-copy',
      'common-verb-in-prose',
    ])
      expect(ids).toContain(id);
    expect(corpus.benign.length).toBeGreaterThanOrEqual(10);
  });
});

describe('CLI · mcp scan · corpus · cross servers · what the files may hold', () => {
  const files = ['malicious', 'benign'].flatMap((d) =>
    readdirSync(join(DIR, 'cross', d)).map((f) => join(DIR, 'cross', d, f)),
  );

  it('no raw hidden character is stored: a fixture writes it as an escape', () => {
    const raw =
      /[\u{E0000}-\u{E007F}‪-‮⁦-⁩​-‏⁠﻿؜\u007F-\u009F\u0000-\u0008\u000B\u000C\u000E-\u001F]/u;
    expect(
      files.filter((f) => raw.test(readFileSync(f, 'utf8'))).map((f) => f.slice(DIR.length)),
    ).toEqual([]);
  });

  it('no token-shaped value is stored', () => {
    const token =
      /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,})/;
    expect(
      files.filter((f) => token.test(readFileSync(f, 'utf8'))).map((f) => f.slice(DIR.length)),
    ).toEqual([]);
  });

  it('the hidden fixtures do hold their hidden characters, as escapes', () => {
    const text = (id: string) =>
      readFileSync(join(DIR, 'cross', 'malicious', `${id}.group.json`), 'utf8');
    expect(text('duplicate-tool-name-06-zero-width-in-name')).toContain('\\u200b');
    expect(text('duplicate-tool-name-07-cyrillic-homoglyph')).toContain('\\u0435');
    expect(text('foreign-tool-reference-11-zero-width-split')).toContain('\\u200b');
  });
});

describe('CLI · mcp scan · corpus · cross servers · the measure', () => {
  it('measures every rule, and a rule is measured only with fixtures', () => {
    expect(CROSS_RULES.filter((r) => report[r]!.status !== 'measured')).toEqual([]);
    const emptied: CrossCorpus = { malicious: [], benign: corpus.benign };
    expect(measureCross(emptied)[CROSS_RULES[0]!]!.status).toBe('not measured');
  });

  it('finds every expectation that is not a designed miss, and misses every designed one: the designed misses are the misses', () => {
    for (const r of CROSS_RULES) {
      const x = report[r]!;
      expect(x.foundDesignedMisses, r).toEqual([]);
      expect(x.missed.length, r).toBe(x.designedMisses);
      expect(x.detected, r).toBe(x.fixtures - x.designedMisses);
    }
  });

  it('is the same twice, and corpus/cross/report.json is that measure', () => {
    expect(json(measureCross(loadCrossCorpus(DIR)))).toBe(json(report));
    expect(readFileSync(REPORT, 'utf8')).toBe(json(report));
  });

  it('the README holds the measured table', () => {
    const readme = readFileSync(README, 'utf8');
    expect(readme).toContain(START);
    expect(readme.slice(readme.indexOf(START) + START.length, readme.indexOf(END)).trim()).toBe(
      crossTable(report),
    );
  });

  it('keeps real and synthetic units apart, and lets no rule through to the gate with none real', () => {
    for (const r of CROSS_RULES) {
      const rule = report[r]!;
      expect(rule.benign.real.groups).toBe(0);
      expect(rule.benign.real.toolPairs).toBe(0);
      expect(rule.benign.synthetic.groups).toBe(corpus.benign.length);
      expect(rule.benign.synthetic.toolPairs).toBeGreaterThan(0);
      expect(rule.gateEligible).toBe(false);
      expect(rule.gateReason).toContain('not enough real units');
    }
  });

  it('counts false findings per group and per tool pair, and a pair is a tool of one server with a tool of another', () => {
    const staging = corpus.benign.find((b) => b.id === 'server-and-staging-copy')!;
    expect(toolPairs(staging.snapshots)).toBe(9);
    const none = corpus.benign.find((b) => b.id === 'no-overlap')!;
    expect(toolPairs(none.snapshots)).toBe(2 * 2 + 2 * 1 + 2 * 1);
    const dup = report['scan/cross/duplicate-tool-name']!.benign.synthetic;
    expect(dup.falsePositives.length).toBeGreaterThanOrEqual(6);
    expect(dup.falseGroups).toBe(new Set(dup.falsePositives.map((p) => p.set)).size);
    expect(dup.perGroup).toBeCloseTo(dup.falsePositives.length / dup.groups, 3);
    expect(dup.perToolPair).toBeCloseTo(dup.falsePositives.length / dup.toolPairs, 3);
  });
});

describe('CLI · mcp scan · corpus · cross servers · the control', () => {
  it('the measure now is not worse than corpus/cross/baseline.json, which says when and at which commit it was taken', () => {
    expect(baseline.measuredAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(baseline.commit).toMatch(/^[0-9a-f]{7,40}$/);
    expect(clip(compareCrossToBaseline(report, baseline, crossCorpusHash(DIR)))).toEqual([]);
  });

  it('goes red when a rule stops finding what it found, for each rule', () => {
    for (const rule of CROSS_RULES) {
      const broken: CrossScan = (s) => {
        const r = real(s);
        return { ...r, findings: r.findings.filter((x) => x.rule !== rule) } as ConfigScan;
      };
      const now = measureCross(corpus, broken);
      expect(now[rule]!.detected, rule).toBeLessThan(report[rule]!.detected);
      const problems = compareCrossToBaseline(now, baseline, crossCorpusHash(DIR));
      expect(
        problems.some((p) => p.startsWith(`${rule}: now misses`)),
        rule,
      ).toBe(true);
      // The other rule is not moved by it.
      const other = CROSS_RULES.find((r) => r !== rule)!;
      expect(now[other]!.detected).toBe(report[other]!.detected);
    }
  });

  it('goes red when a rule flags an ordinary group it did not flag', () => {
    const quiet = corpus.benign.find((b) => b.id === 'no-overlap')!;
    const seed = real(corpus.malicious[0]!.snapshots).findings[0]!;
    const noisy: CrossScan = (s) => {
      const r = real(s);
      if (s !== quiet.snapshots) return r;
      return {
        ...r,
        findings: [...r.findings, { ...seed, server: 'notes', path: '/tools/0/name' }],
      } as ConfigScan;
    };
    const problems = compareCrossToBaseline(
      measureCross(corpus, noisy),
      baseline,
      crossCorpusHash(DIR),
    );
    expect(
      problems.filter((p) => p.includes('new false finding on synthetic no-overlap')),
    ).toHaveLength(1);
  });

  it('a finding of the right rule on the wrong server, or on the wrong path, is a miss: the measure matches rule, server and path', () => {
    const f = corpus.malicious.find((x) => x.id === 'duplicate-tool-name-01-plain')!;
    const rule = 'scan/cross/duplicate-tool-name';
    const seed = real(f.snapshots).findings.find((x) => x.rule === rule)!;
    const stub =
      (server: string, path: string): CrossScan =>
      (s) =>
        s !== f.snapshots
          ? real(s)
          : ({ ...real(s), findings: [{ ...seed, server, path }] } as ConfigScan);
    const misses = (r: ReturnType<typeof measureCross>) =>
      r[rule]!.missed.some((m) => m.fixture === f.id);
    expect(f.expected[0]!.server).toBe(seed.server);
    expect(misses(measureCross(corpus, stub(seed.server!, seed.path!)))).toBe(false);
    const other = [...f.snapshots.keys()].find((k) => k !== seed.server)!;
    expect(misses(measureCross(corpus, stub(other, seed.path!)))).toBe(true);
    expect(misses(measureCross(corpus, stub(seed.server!, '/tools/9/name')))).toBe(true);
  });

  it('sees a designed miss that the rule now finds, so an improvement is a decision to record', () => {
    const f = corpus.malicious.find((x) => x.id === 'duplicate-tool-name-05-case-variant')!;
    const finds: CrossScan = (s) => {
      const r = real(s);
      if (s !== f.snapshots) return r;
      return {
        ...r,
        findings: [
          ...r.findings,
          {
            ...real(corpus.malicious[0]!.snapshots).findings[0]!,
            server: 'docs',
            path: '/tools/0/name',
          },
        ],
      } as ConfigScan;
    };
    const now = measureCross(corpus, finds)['scan/cross/duplicate-tool-name']!;
    expect(now.foundDesignedMisses.map((m) => m.fixture)).toEqual([f.id]);
  });

  it('goes red on an empty corpus and on a rule left without fixtures', () => {
    const problems = compareCrossToBaseline(
      measureCross({ malicious: [], benign: [] }),
      baseline,
      crossCorpusHash(DIR),
    );
    expect(CROSS_RULES.every((r) => problems.includes(`${r}: not measured (no fixture)`))).toBe(
      true,
    );
    const one = CROSS_RULES[0]!;
    const without: CrossCorpus = {
      ...corpus,
      malicious: corpus.malicious.filter((f) => !f.expected.some((e) => e.rule === one)),
    };
    expect(compareCrossToBaseline(measureCross(without), baseline, crossCorpusHash(DIR))).toContain(
      `${one}: not measured (no fixture)`,
    );
  });

  it('goes red when the corpus changed and the baseline did not', () => {
    expect(compareCrossToBaseline(report, baseline, 'f'.repeat(64))).toContain(
      'the cross corpus changed and corpus/cross/baseline.json was not updated',
    );
  });

  it('goes red when fixtures are removed', () => {
    const fewer: CrossCorpus = { ...corpus, malicious: corpus.malicious.slice(1) };
    expect(
      compareCrossToBaseline(measureCross(fewer), baseline, crossCorpusHash(DIR)).some((p) =>
        /fixtures, the baseline has/.test(p),
      ),
    ).toBe(true);
  });
});

describe('CLI · mcp scan · corpus · cross servers · the loader is strict', () => {
  const dir = (files: Record<string, string>) => {
    const root = mkdtempSync(join(tmpdir(), 'plune-cross-corpus-'));
    for (const d of ['malicious', 'benign']) mkdirSync(join(root, 'cross', d), { recursive: true });
    for (const [name, text] of Object.entries(files))
      writeFileSync(join(root, 'cross', name), text);
    return root;
  };
  const group = JSON.stringify({
    servers: { a: { tools: [{ name: 'x' }] }, b: { tools: [{ name: 'y' }] } },
  });
  const PROV = {
    catalogClass: 'shadowing',
    mechanism: 'm',
    concealment: 'plain',
    source: 'not verified',
    catalogRefs: ['INV'],
    author: 'a',
    date: '2026-11-13',
  };
  const META = { origin: 'synthetic', description: 'd', author: 'a', date: '2026-11-13' };
  const expected = (extra: object = {}) =>
    JSON.stringify({
      origin: 'synthetic',
      expected: [{ rule: 'scan/cross/duplicate-tool-name', server: 'a', path: '/tools/0/name' }],
      provenance: PROV,
      ...extra,
    });
  const good = { 'malicious/a.group.json': group, 'malicious/a.expected.json': expected() };

  it('loads a well-formed directory', () => {
    expect(loadCrossCorpus(dir(good)).malicious.map((f) => f.id)).toEqual(['a']);
  });

  it('names the file, and says what is wrong, for every kind of malformed fixture', () => {
    const groupOf = (servers: unknown) => JSON.stringify({ servers });
    const two = { a: { tools: [{ name: 'x' }] }, b: { tools: [{ name: 'y' }] } };
    const exp = (over: Record<string, unknown>) =>
      JSON.stringify({ ...JSON.parse(expected()), ...over });
    const item = { rule: 'scan/cross/duplicate-tool-name', server: 'a', path: '/tools/0/name' };
    const cases: [string, Record<string, string>, RegExp][] = [
      [
        'unknown key in a group',
        { 'malicious/a.group.json': JSON.stringify({ servers: two, extra: 1 }) },
        /a\.group\.json: .*extra/,
      ],
      [
        'unknown key in a server',
        { 'malicious/a.group.json': groupOf({ ...two, a: { tools: [], extra: 1 } }) },
        /a\.group\.json: .*extra/,
      ],
      [
        'unknown key in a tool',
        { 'malicious/a.group.json': groupOf({ ...two, a: { tools: [{ name: 'x', extra: 1 }] } }) },
        /a\.group\.json: .*extra/,
      ],
      [
        'unknown key in the expectations file',
        { 'malicious/a.expected.json': exp({ extra: 1 }) },
        /a\.expected\.json: .*extra/,
      ],
      [
        'unknown key in an expectation',
        { 'malicious/a.expected.json': exp({ expected: [{ ...item, extra: 1 }] }) },
        /a\.expected\.json: .*extra/,
      ],
      [
        'expected is not an array',
        { 'malicious/a.expected.json': exp({ expected: item }) },
        /a\.expected\.json: .*expected.*array/,
      ],
      [
        'designedMiss is not a string',
        { 'malicious/a.expected.json': exp({ expected: [{ ...item, designedMiss: 3 }] }) },
        /a\.expected\.json: .*designedMiss/,
      ],
      [
        'provenance missing',
        { 'malicious/a.expected.json': exp({ provenance: undefined }) },
        /a\.expected\.json: .*provenance/,
      ],
      [
        'provenance field missing',
        { 'malicious/a.expected.json': exp({ provenance: { ...PROV, author: undefined } }) },
        /a\.expected\.json: .*author/,
      ],
      [
        'provenance field empty',
        { 'malicious/a.expected.json': exp({ provenance: { ...PROV, mechanism: '  ' } }) },
        /a\.expected\.json: .*mechanism/,
      ],
      [
        'unknown key in provenance',
        { 'malicious/a.expected.json': exp({ provenance: { ...PROV, extra: 1 } }) },
        /a\.expected\.json: .*extra/,
      ],
      [
        'expected file is not JSON',
        { 'malicious/a.expected.json': '{ nope' },
        /a\.expected\.json: .*JSON/,
      ],
      ['group file is not JSON', { 'malicious/a.group.json': '{ nope' }, /a\.group\.json: .*JSON/],
      [
        'too large',
        { 'malicious/a.group.json': ' '.repeat(MAX_CORPUS_FILE_BYTES + 1) },
        /a\.group\.json: .*too large/,
      ],
    ];
    const benign = { 'benign/c.group.json': group };
    const bcases: [string, string, RegExp][] = [
      [
        'unknown key in a benign meta',
        JSON.stringify({ ...META, extra: 1 }),
        /c\.meta\.json: .*extra/,
      ],
      [
        'benign author missing',
        JSON.stringify({ ...META, author: undefined }),
        /c\.meta\.json: .*author/,
      ],
      ['benign date empty', JSON.stringify({ ...META, date: '' }), /c\.meta\.json: .*date/],
      [
        'benign description missing',
        JSON.stringify({ ...META, description: undefined }),
        /c\.meta\.json: .*description/,
      ],
      ['benign meta is not JSON', '[', /c\.meta\.json: .*JSON/],
    ];
    for (const [name, files, message] of cases)
      expect(() => loadCrossCorpus(dir({ ...good, ...files })), name).toThrow(message);
    for (const [name, meta, message] of bcases)
      expect(
        () => loadCrossCorpus(dir({ ...good, ...benign, 'benign/c.meta.json': meta })),
        name,
      ).toThrow(message);
    expect(
      loadCrossCorpus(dir({ ...good, ...benign, 'benign/c.meta.json': JSON.stringify(META) }))
        .benign,
    ).toHaveLength(1);
  });
  it('names a sidecar without a group, and a group without a sidecar', () => {
    expect(() =>
      loadCrossCorpus(dir({ ...good, 'malicious/o.expected.json': expected() })),
    ).toThrow(/o\.expected\.json/);
    expect(() => loadCrossCorpus(dir({ ...good, 'benign/m.meta.json': '{}' }))).toThrow(
      /m\.meta\.json/,
    );
    expect(() => loadCrossCorpus(dir({ 'malicious/b.group.json': group }))).toThrow(
      /b\.expected\.json/,
    );
  });
  it('refuses a group of fewer than two servers', () => {
    const one = JSON.stringify({ servers: { a: { tools: [{ name: 'x' }] } } });
    expect(() => loadCrossCorpus(dir({ ...good, 'malicious/a.group.json': one }))).toThrow(
      /a\.group\.json: a group has at least two servers/,
    );
  });
  it('refuses an origin that is not real or synthetic', () => {
    expect(() =>
      loadCrossCorpus(
        dir({ ...good, 'malicious/a.expected.json': expected({ origin: 'scraped' }) }),
      ),
    ).toThrow(/a: origin/);
    expect(() =>
      loadCrossCorpus(
        dir({
          ...good,
          'benign/c.group.json': group,
          'benign/c.meta.json': JSON.stringify({ origin: 'x' }),
        }),
      ),
    ).toThrow(/c: origin/);
  });
  it('refuses a rule that does not exist or is not a cross rule, and a server that is not in the group', () => {
    const bad = (rule: string, server = 'a') =>
      expected({ expected: [{ rule, server, path: '/tools/0/name' }] });
    for (const rule of ['scan/cross/none', 'scan/cfg/http-plaintext'])
      expect(() =>
        loadCrossCorpus(dir({ ...good, 'malicious/a.expected.json': bad(rule) })),
      ).toThrow(/rule that does not exist/);
    expect(() =>
      loadCrossCorpus(
        dir({ ...good, 'malicious/a.expected.json': bad('scan/cross/duplicate-tool-name', 'zzz') }),
      ),
    ).toThrow(/server that is not in the group/);
  });
  it('refuses a server that is not a snapshot, and names the file', () => {
    const broken = JSON.stringify({
      servers: { a: { tools: [{ description: 'no name' }] }, b: {} },
    });
    expect(() => loadCrossCorpus(dir({ ...good, 'malicious/a.group.json': broken }))).toThrow(
      /a\.group\.json: server "a" is not a snapshot/,
    );
  });
});
