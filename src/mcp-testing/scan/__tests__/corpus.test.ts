// CLI · mcp scan · corpus: the accuracy corpus of the description rules (MCP-G7, first part) and its regression control.
// Fixtures hold text that reads like injections, so a failure here names rules, fixtures and pointers, never their text.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DESC_RULES, scanDescriptions, visible, type DescRuleId } from '../descriptions.js';
import {
  GATE_MIN_UNITS,
  baselineOf,
  compareToBaseline,
  corpusHash,
  corpusUpdateRequested,
  loadCorpus,
  measure,
  wilsonUpper95,
  type Baseline,
  type Corpus,
  type Scan,
} from '../corpus.js';

const ROOT = join(__dirname, '..', '..', '..', '..');
const DIR = join(ROOT, 'corpus');
const REPORT = join(DIR, 'report.json');
const BASELINE = join(DIR, 'baseline.json');
const RULES = Object.keys(DESC_RULES) as DescRuleId[];

const corpus = loadCorpus(DIR);
const report = measure(corpus);
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
const scanOf: Scan = (s) => scanDescriptions(s).findings;
const clip = (lines: string[]) => lines.map((l) => visible(l, 160));

// `PLUNE_CORPUS_UPDATE=1 CORPUS_COMMIT=<sha> CORPUS_DATE=<date>` rewrites the two generated files: the deliberate update.
if (corpusUpdateRequested(process.env)) {
  const meta = {
    measuredAt: process.env['CORPUS_DATE']!,
    commit: process.env['CORPUS_COMMIT']!,
    corpusSha256: corpusHash(DIR),
  };
  if (!meta.measuredAt || !meta.commit) throw new Error('set CORPUS_COMMIT and CORPUS_DATE');
  writeFileSync(REPORT, json(report));
  writeFileSync(BASELINE, json(baselineOf(report, meta)));
}
const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as Baseline;

describe('CLI · mcp scan · corpus · coverage of the catalog', () => {
  it('every description rule of the catalog has at least three malicious fixtures, and the code and the catalog list the same rules', () => {
    const catalog = readFileSync(
      join(ROOT, 'docs', 'features', 'mcp-scan', 'threat-catalog.md'),
      'utf8',
    );
    const inCatalog = [...catalog.matchAll(/^\| (scan\/desc\/[a-z-]+) \|/gm)]
      .map((m) => m[1]!)
      .sort();
    expect(inCatalog).toEqual([...RULES].sort());
    const few = RULES.filter((r) => report[r].fixtures < 3).map(
      (r) => `${r}: ${report[r].fixtures}`,
    );
    expect(few).toEqual([]);
  });

  it('every fixture says where it came from and who wrote it, and no source is claimed that was not read', () => {
    const bad = corpus.malicious
      .filter(
        (f) =>
          !f.provenance.mechanism ||
          !f.provenance.author ||
          !f.provenance.date ||
          !f.provenance.concealment ||
          f.provenance.source !== 'not verified',
      )
      .map((f) => f.id);
    expect(bad).toEqual([]);
  });

  it('the ordinary side has synthetic sets in the scripts and shapes the task names, and no real set yet', () => {
    const text = JSON.stringify(corpus.benign.map((b) => b.snapshot));
    expect(corpus.benign.some((b) => b.origin === 'synthetic')).toBe(true);
    expect(corpus.benign.filter((b) => b.origin === 'real')).toEqual([]);
    for (const [name, re] of [
      ['Ukrainian', /[Ѐ-ӿ]/],
      ['Persian or Arabic', /[؀-ۿ]/],
      ['Chinese', /[一-鿿]/],
      ['Japanese', /[぀-ヿ]/],
      ['emoji with a joiner', /\u{1F468}‍\u{1F469}/u],
    ] as const) {
      expect(re.test(text), name).toBe(true);
    }
    expect(
      corpus.benign.some((b) =>
        (b.snapshot.tools ?? []).some((t) => (t.description ?? '').length > 10000),
      ),
    ).toBe(true);
    expect(
      corpus.benign.some((b) =>
        (b.snapshot.tools ?? []).some((t) => (t.description ?? '').length <= 5),
      ),
    ).toBe(true);
  });

  it('SOURCES.json lists real sets with every field, and for each the sha-256 of the committed file', () => {
    const sources = JSON.parse(readFileSync(join(DIR, 'SOURCES.json'), 'utf8')) as {
      fields: string[];
      real: Record<string, unknown>[];
    };
    const gaps = sources.real.flatMap((s) =>
      sources.fields
        .filter((f) => s[f] === undefined || s[f] === '')
        .map((f) => `${String(s['id'])}: ${f}`),
    );
    expect(gaps).toEqual([]);
  });
});

describe('CLI · mcp scan · corpus · what the files may hold', () => {
  const files = ['malicious', 'benign']
    .flatMap((d) => readdirSync(join(DIR, d)).map((f) => join(DIR, d, f)))
    .concat(
      ['malicious', 'benign'].flatMap((d) =>
        readdirSync(join(DIR, 'config', d)).map((f) => join(DIR, 'config', d, f)),
      ),
    )
    .concat(join(DIR, 'SOURCES.json'));

  it('no raw tag character, bidi control, zero-width character or control character is stored: they are escapes', () => {
    const raw =
      /[\u{E0000}-\u{E007F}‪-‮⁦-⁩​-‏⁠﻿؜\u007F-\u009F\u0000-\u0008\u000B\u000C\u000E-\u001F]/u;
    expect(
      files.filter((f) => raw.test(readFileSync(f, 'utf8'))).map((f) => f.slice(DIR.length)),
    ).toEqual([]);
  });

  it('nothing in the corpus looks like a real token or a private key', () => {
    const token =
      /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.)|-----BEGIN [A-Z ]*PRIVATE KEY/;
    expect(
      files.filter((f) => token.test(readFileSync(f, 'utf8'))).map((f) => f.slice(DIR.length)),
    ).toEqual([]);
  });

  it('the corpus is not part of the npm package', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { files: string[] };
    expect(pkg.files.some((f) => /^\.?\/?(corpus|src|scripts)\b/.test(f))).toBe(false);
  });
});

describe('CLI · mcp scan · corpus · the measure', () => {
  it('measures every rule, and a rule is measured only with fixtures', () => {
    expect(RULES.filter((r) => report[r].status !== 'measured')).toEqual([]);
    expect(measure({ malicious: [], benign: corpus.benign })[RULES[0]!].status).toBe(
      'not measured',
    );
  });

  it('is the same twice, and corpus/report.json is that measure', () => {
    expect(json(measure(loadCorpus(DIR)))).toBe(json(report));
    expect(readFileSync(REPORT, 'utf8')).toBe(json(report));
  });

  it('takes the upper end of the Wilson interval, about 1 % for no false finding in 385 units', () => {
    expect(wilsonUpper95(0, GATE_MIN_UNITS)).toBeCloseTo(0.0099, 3);
    expect(wilsonUpper95(0, 0)).toBeNull();
    expect(wilsonUpper95(3, 10)).toBeGreaterThan(0.3);
  });

  it('lets no rule through to the gate on the units there are: none is real, so none has the 385 the gate needs', () => {
    expect(RULES.filter((r) => report[r].gateEligible)).toEqual([]);
    for (const r of RULES)
      expect(report[r].gateReason).toContain(`not enough real units (0 of ${GATE_MIN_UNITS})`);
  });

  it('counts each origin apart', () => {
    for (const r of RULES) {
      expect(report[r].benign.real.units).toBe(0);
      expect(report[r].benign.synthetic.units).toBeGreaterThan(0);
    }
  });
});

describe('CLI · mcp scan · corpus · the control', () => {
  it('the measure now is not worse than corpus/baseline.json, which says when and at which commit it was taken', () => {
    expect(baseline.measuredAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(baseline.commit).toMatch(/^[0-9a-f]{7,40}$/);
    expect(clip(compareToBaseline(report, baseline, corpusHash(DIR)))).toEqual([]);
  });

  it('goes red when a rule stops finding what it found', () => {
    for (const rule of RULES) {
      const broken: Scan = (s) => scanOf(s).filter((f) => f.rule !== rule);
      const problems = compareToBaseline(measure(corpus, broken), baseline, corpusHash(DIR));
      expect(
        problems.some((p) => p.startsWith(`${rule}: now misses`)),
        rule,
      ).toBe(true);
    }
  });

  it('goes red when a rule flags an ordinary text it did not flag', () => {
    const first = corpus.benign[0]!;
    const noisy: Scan = (s) =>
      scanOf(s).concat(
        s === first.snapshot
          ? [
              {
                ...scanOf(corpus.malicious[0]!.snapshot)[0]!,
                rule: 'scan/desc/html-comment',
                pointer: '/tools/0/description',
              },
            ]
          : [],
      );
    const problems = compareToBaseline(measure(corpus, noisy), baseline, corpusHash(DIR));
    expect(
      problems.filter((p) =>
        p.startsWith('scan/desc/html-comment: new false finding on synthetic'),
      ),
    ).toHaveLength(1);
  });

  it('goes red on an empty corpus and on a rule left without fixtures', () => {
    const empty: Corpus = { malicious: [], benign: [] };
    const problems = compareToBaseline(measure(empty), baseline, corpusHash(DIR));
    expect(RULES.every((r) => problems.includes(`${r}: not measured (no fixture)`))).toBe(true);
    const one = RULES[0]!;
    const without: Corpus = {
      ...corpus,
      malicious: corpus.malicious.filter((f) => !f.expected.some((e) => e.rule === one)),
    };
    expect(compareToBaseline(measure(without), baseline, corpusHash(DIR))).toContain(
      `${one}: not measured (no fixture)`,
    );
  });

  it('goes red when the corpus changed and the baseline did not', () => {
    expect(compareToBaseline(report, baseline, 'f'.repeat(64))).toContain(
      'the corpus changed and corpus/baseline.json was not updated',
    );
  });
});

describe('CLI · mcp scan · corpus · the update is deliberate and not in CI', () => {
  it('refuses to rewrite the generated files when CI is set, and says why', () => {
    expect(() => corpusUpdateRequested({ PLUNE_CORPUS_UPDATE: '1', CI: 'true' })).toThrow(/CI/);
  });
  it('asks for the rewrite only with the flag, outside CI', () => {
    expect(corpusUpdateRequested({ PLUNE_CORPUS_UPDATE: '1' })).toBe(true);
    expect(corpusUpdateRequested({})).toBe(false);
    expect(corpusUpdateRequested({ CI: 'true' })).toBe(false);
  });
});

describe('CLI · mcp scan · corpus · the loader is strict', () => {
  const snapshotText = readFileSync(
    join(DIR, 'malicious', 'tag-character-01-hidden.snapshot.json'),
    'utf8',
  );
  const expectedText = readFileSync(
    join(DIR, 'malicious', 'tag-character-01-hidden.expected.json'),
    'utf8',
  );
  const dir = (files: Record<string, string>) => {
    const root = mkdtempSync(join(tmpdir(), 'plune-corpus-'));
    for (const d of ['malicious', 'benign']) mkdirSync(join(root, d));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
    return root;
  };
  const good = {
    'malicious/a.snapshot.json': snapshotText,
    'malicious/a.expected.json': expectedText,
  };
  const origin = (o: string) => JSON.stringify({ origin: o });

  it('loads a well-formed directory', () => {
    expect(loadCorpus(dir(good)).malicious.map((f) => f.id)).toEqual(['a']);
  });
  it('names an expectation file that has no snapshot', () => {
    expect(() =>
      loadCorpus(dir({ ...good, 'malicious/orphan.expected.json': expectedText })),
    ).toThrow(/orphan\.expected\.json/);
  });
  it('names a meta file that has no snapshot', () => {
    expect(() =>
      loadCorpus(dir({ ...good, 'benign/lost.meta.json': origin('synthetic') })),
    ).toThrow(/lost\.meta\.json/);
  });
  it('names a snapshot that has no expectation file', () => {
    expect(() => loadCorpus(dir({ 'malicious/b.snapshot.json': snapshotText }))).toThrow(
      /b\.expected\.json/,
    );
  });
  it('refuses an origin that is not real or synthetic', () => {
    const files = {
      ...good,
      'benign/c.snapshot.json': snapshotText,
      'benign/c.meta.json': origin('scraped'),
    };
    expect(() => loadCorpus(dir(files))).toThrow(/c: origin/);
    expect(
      loadCorpus(
        dir({
          ...good,
          'benign/c.snapshot.json': snapshotText,
          'benign/c.meta.json': origin('real'),
        }),
      ).benign[0]!.origin,
    ).toBe('real');
  });
  it.each([
    ['zero bytes', { $repeat: 'x', bytes: 0 }],
    ['a fraction', { $repeat: 'x', bytes: 1.5 }],
    ['over 4 MB', { $repeat: 'x', bytes: 4 * 1024 * 1024 + 1 }],
    ['a text, not a number', { $repeat: 'x', bytes: '9' }],
    ['an empty unit', { $repeat: '', bytes: 10 }],
    ['a unit that is not text', { $repeat: 5, bytes: 10 }],
  ])('refuses a $repeat with %s, and names the fixture', (_name, rep) => {
    const snap = { ...JSON.parse(snapshotText), instructions: rep };
    const root = dir({ ...good, 'malicious/a.snapshot.json': JSON.stringify(snap) });
    expect(() => loadCorpus(root)).toThrow(/a\.snapshot\.json/);
  });
  it('accepts a $repeat of 4 MB', () => {
    const snap = {
      ...JSON.parse(snapshotText),
      instructions: { $repeat: 'ab', bytes: 4 * 1024 * 1024 },
    };
    const root = dir({ ...good, 'malicious/a.snapshot.json': JSON.stringify(snap) });
    expect(loadCorpus(root).malicious[0]!.snapshot.instructions!.length).toBeGreaterThanOrEqual(
      4 * 1024 * 1024,
    );
  });
});

describe('CLI · mcp scan · corpus · the denominator says what a unit is', () => {
  it('counts the description fields apart from all texts, per origin', () => {
    const snapshot = JSON.parse(readFileSync(join(DIR, 'benign', 'short.snapshot.json'), 'utf8'));
    const tiny: Corpus = {
      malicious: [],
      benign: [
        {
          id: 't',
          origin: 'synthetic',
          snapshot: {
            ...snapshot,
            tools: [
              {
                name: 'n',
                description: 'd',
                inputSchema: {
                  type: 'object',
                  properties: { p: { type: 'string', description: 'q' } },
                },
              },
            ],
          },
        },
      ],
    };
    const r = measure(tiny)[RULES[0]!].benign;
    // name, description, the keys type/properties/p/type/description, the values object/string, the description of p
    expect(r.synthetic.descriptionUnits).toBe(2);
    expect(r.synthetic.units).toBeGreaterThan(2);
    expect(r.real.descriptionUnits).toBe(0);
  });
  it('is in report.json for every rule', () => {
    for (const r of RULES) expect(report[r].benign.synthetic.descriptionUnits).toBeGreaterThan(0);
  });
});
