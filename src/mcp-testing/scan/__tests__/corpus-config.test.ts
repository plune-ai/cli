// CLI · mcp scan · corpus · client config: the accuracy corpus of the `scan/cfg/*` rules (MCP-G7, second part) and its
// regression control. Fixtures hold fake tokens made at run time; a failure names rules, fixtures and paths only.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanClientConfig, type ConfigScan } from '../config/config.js';
import { corpusUpdateRequested } from '../corpus.js';
import {
  CFG_RULES,
  cfgBaselineOf,
  compareCfgToBaseline,
  configCorpusHash,
  fakeToken,
  leaksToken,
  loadConfigCorpus,
  measureConfig,
  type CfgBaseline,
  type CfgScan,
  type ConfigCorpus,
} from '../corpus-config.js';
import { visible } from '../descriptions.js';

const ROOT = join(__dirname, '..', '..', '..', '..');
const DIR = join(ROOT, 'corpus');
const REPORT = join(DIR, 'config', 'report.json');
const BASELINE = join(DIR, 'config', 'baseline.json');

const corpus = loadConfigCorpus(DIR);
const report = measureConfig(corpus);
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
const clip = (lines: string[]) => lines.map((l) => visible(l, 160));
const real: CfgScan = (file, options) => scanClientConfig([file], options);

// `PLUNE_CORPUS_UPDATE=1 CORPUS_COMMIT=<sha> CORPUS_DATE=<date>` rewrites the two generated files: the deliberate update.
if (corpusUpdateRequested(process.env)) {
  const meta = {
    measuredAt: process.env['CORPUS_DATE']!,
    commit: process.env['CORPUS_COMMIT']!,
    corpusSha256: configCorpusHash(DIR),
  };
  if (!meta.measuredAt || !meta.commit) throw new Error('set CORPUS_COMMIT and CORPUS_DATE');
  writeFileSync(REPORT, json(report));
  writeFileSync(BASELINE, json(cfgBaselineOf(report, meta)));
}
const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as CfgBaseline;

/** Fixtures whose result is known to hold a token or 8 characters of it. A fixture listed here is a finding in the scanner. */
const KNOWN_LEAK: string[] = [];

describe('CLI · mcp scan · corpus · client config · coverage of the catalog', () => {
  it('every scan/cfg rule of the catalog has at least three malicious fixtures, and the code and the catalog list the same rules', () => {
    const catalog = readFileSync(
      join(ROOT, 'docs', 'features', 'mcp-scan', 'threat-catalog.md'),
      'utf8',
    );
    const inCatalog = [...catalog.matchAll(/^\| (scan\/cfg\/[a-z-]+) \|/gm)]
      .map((m) => m[1]!)
      .sort();
    expect(inCatalog).toEqual([...CFG_RULES]);
    const few = CFG_RULES.filter((r) => report.rules[r]!.fixtures < 3).map(
      (r) => `${r}: ${report.rules[r]!.fixtures}`,
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

  it('the ordinary side is synthetic, covers every client, and has no real set yet', () => {
    expect(corpus.benign.filter((b) => b.origin === 'real')).toEqual([]);
    expect(new Set(corpus.benign.map((b) => b.client))).toEqual(
      new Set(['claude-code', 'cursor', 'vscode', 'claude-desktop']),
    );
  });
});

describe('CLI · mcp scan · corpus · client config · what the files may hold', () => {
  const files = ['malicious', 'benign'].flatMap((d) =>
    readdirSync(join(DIR, 'config', d)).map((f) => join(DIR, 'config', d, f)),
  );

  it('no raw token, private key marker or real-looking secret is stored: tokens are placeholders', () => {
    const token =
      /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|npm_[A-Za-z0-9]{30,}|glpat-[A-Za-z0-9_-]{20}|sk_live_[A-Za-z0-9]{16,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.)|-----BEGIN [A-Z ]*PRIVATE KEY/;
    expect(
      files.filter((f) => token.test(readFileSync(f, 'utf8'))).map((f) => f.slice(DIR.length)),
    ).toEqual([]);
  });

  it('no raw hidden character is stored', () => {
    const raw =
      /[\u{E0000}-\u{E007F}‪-‮⁦-⁩​-‏⁠﻿؜\u007F-\u009F\u0000-\u0008\u000B\u000C\u000E-\u001F]/u;
    expect(
      files.filter((f) => raw.test(readFileSync(f, 'utf8'))).map((f) => f.slice(DIR.length)),
    ).toEqual([]);
  });

  it('a fake token is the same for the same seed, differs for another, and keeps the length of its format', () => {
    expect(fakeToken('ghp', 1)).toBe(fakeToken('ghp', 1));
    expect(fakeToken('ghp', 1)).not.toBe(fakeToken('ghp', 2));
    expect(fakeToken('ghp', 1)).toMatch(/^ghp_[A-Za-z0-9]{36}$/);
    expect(fakeToken('aws', 1)).toMatch(/^AKIA[A-Z2-7]{16}$/);
    expect(() => fakeToken('nope', 1)).toThrow(/unknown token format/);
  });
});

describe('CLI · mcp scan · corpus · client config · the measure', () => {
  it('measures every rule, and a rule is measured only with fixtures', () => {
    expect(CFG_RULES.filter((r) => report.rules[r]!.status !== 'measured')).toEqual([]);
    const emptied: ConfigCorpus = { malicious: [], benign: corpus.benign };
    expect(measureConfig(emptied).rules[CFG_RULES[0]!]!.status).toBe('not measured');
  });

  it('is the same twice, and corpus/config/report.json is that measure', () => {
    expect(json(measureConfig(loadConfigCorpus(DIR)))).toBe(json(report));
    expect(readFileSync(REPORT, 'utf8')).toBe(json(report));
  });

  it('keeps real and synthetic units apart, and lets no rule through to the gate with none real', () => {
    for (const r of CFG_RULES) {
      const rule = report.rules[r]!;
      expect(rule.benign.real.servers).toBe(0);
      if (!r.endsWith('foreign-host') && !r.endsWith('package-not-allowed'))
        expect(rule.benign.synthetic.servers).toBeGreaterThan(0);
      expect(rule.gateEligible).toBe(false);
    }
    expect(report.rules['scan/cfg/foreign-host']!.benign.synthetic.servers).toBeGreaterThan(0);
    expect(report.rules['scan/cfg/package-not-allowed']!.benign.synthetic.servers).toBeGreaterThan(
      0,
    );
  });

  it('counts what the scanner did not check apart from what it missed: all of them are reported', () => {
    expect(report.notChecked.expected).toBeGreaterThanOrEqual(6);
    expect(report.notChecked.missed).toEqual([]);
  });
});

describe('CLI · mcp scan · corpus · client config · no token reaches the output', () => {
  const withTokens = corpus.malicious.filter((f) => f.tokens.length > 0);

  it('the corpus has fixtures with tokens in every documented format', () => {
    expect(withTokens.length).toBeGreaterThanOrEqual(10);
  });

  it('in the whole result of the scanner there is no token and no 8 characters in a row of one', () => {
    const leaking = withTokens
      .filter((f) => !KNOWN_LEAK.includes(f.id))
      .filter((f) => {
        const out = JSON.stringify(
          real({ path: f.path, client: f.client, text: f.text }, f.options),
        );
        return f.tokens.some((t) => leaksToken(out, t));
      })
      .map((f) => f.id);
    expect(leaking).toEqual([]);
  });

  it('a fixture listed as a known leak does leak, and the list is checked, not trusted', () => {
    for (const id of KNOWN_LEAK) {
      const f = corpus.malicious.find((x) => x.id === id)!;
      const out = JSON.stringify(real({ path: f.path, client: f.client, text: f.text }, f.options));
      expect(
        f.tokens.some((t) => leaksToken(out, t)),
        id,
      ).toBe(true);
    }
  });

  it('the check itself sees a leak', () => {
    const t = fakeToken('ghp', 3);
    expect(leaksToken(`x ${t} y`, t)).toBe(true);
    expect(leaksToken(`x ${t.slice(10, 18)} y`, t)).toBe(true);
    expect(leaksToken(`x ${t.slice(10, 17)} y`, t)).toBe(false);
  });
});

describe('CLI · mcp scan · corpus · client config · the control', () => {
  it('the measure now is not worse than corpus/config/baseline.json, which says when and at which commit it was taken', () => {
    expect(baseline.measuredAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(baseline.commit).toMatch(/^[0-9a-f]{7,40}$/);
    expect(clip(compareCfgToBaseline(report, baseline, configCorpusHash(DIR)))).toEqual([]);
  });

  it('goes red when a rule stops finding what it found, for each rule', () => {
    for (const rule of CFG_RULES) {
      const broken: CfgScan = (f, o) => {
        const s = real(f, o);
        return { ...s, findings: s.findings.filter((x) => x.rule !== rule) } as ConfigScan;
      };
      const problems = compareCfgToBaseline(
        measureConfig(corpus, broken),
        baseline,
        configCorpusHash(DIR),
      );
      expect(
        problems.some((p) => p.startsWith(`${rule}: now misses`)),
        rule,
      ).toBe(true);
    }
  });

  it('goes red when a rule flags an ordinary file it did not flag', () => {
    const first = corpus.benign.find((b) => b.id === 'mixed-quiet')!;
    const noisy: CfgScan = (f, o) => {
      const s = real(f, o);
      if (f.text !== first.text) return s;
      return {
        ...s,
        findings: [
          ...s.findings,
          {
            ...real(corpus.malicious[0]!, corpus.malicious[0]!.options).findings[0]!,
            rule: 'scan/cfg/http-plaintext',
            path: 'mcpServers.one.url',
          },
        ],
      } as ConfigScan;
    };
    const problems = compareCfgToBaseline(
      measureConfig(corpus, noisy),
      baseline,
      configCorpusHash(DIR),
    );
    expect(
      problems.filter((p) =>
        p.startsWith('scan/cfg/http-plaintext: new false finding on synthetic'),
      ),
    ).toHaveLength(1);
  });

  it('goes red when the scanner stops saying it did not check', () => {
    const silent: CfgScan = (f, o) => {
      const s = real(f, o);
      return {
        ...s,
        notEvaluated: [],
        files: s.files.map((x) => ({ ...x, status: 'scanned', problems: [] })),
      } as ConfigScan;
    };
    const problems = compareCfgToBaseline(
      measureConfig(corpus, silent),
      baseline,
      configCorpusHash(DIR),
    );
    expect(problems.some((p) => p.startsWith('not checked: now not reported'))).toBe(true);
  });

  it('goes red on an empty corpus and on a rule left without fixtures', () => {
    const problems = compareCfgToBaseline(
      measureConfig({ malicious: [], benign: [] }),
      baseline,
      configCorpusHash(DIR),
    );
    expect(CFG_RULES.every((r) => problems.includes(`${r}: not measured (no fixture)`))).toBe(true);
    expect(problems).toContain('not checked: no fixture');
    const one = CFG_RULES[0]!;
    const without: ConfigCorpus = {
      ...corpus,
      malicious: corpus.malicious.filter((f) => !f.expected.some((e) => e.rule === one)),
    };
    expect(compareCfgToBaseline(measureConfig(without), baseline, configCorpusHash(DIR))).toContain(
      `${one}: not measured (no fixture)`,
    );
  });

  it('goes red when the corpus changed and the baseline did not', () => {
    expect(compareCfgToBaseline(report, baseline, 'f'.repeat(64))).toContain(
      'the config corpus changed and corpus/config/baseline.json was not updated',
    );
  });
});

describe('CLI · mcp scan · corpus · client config · the loader is strict', () => {
  const dir = (files: Record<string, string>) => {
    const root = mkdtempSync(join(tmpdir(), 'plune-cfg-corpus-'));
    for (const d of ['malicious', 'benign'])
      mkdirSync(join(root, 'config', d), { recursive: true });
    for (const [name, text] of Object.entries(files))
      writeFileSync(join(root, 'config', name), text);
    return root;
  };
  const expected = JSON.stringify({
    client: 'cursor',
    path: 'x.json',
    expected: [],
    notChecked: [],
    provenance: {},
  });
  const good = { 'malicious/a.config.txt': '{}', 'malicious/a.expected.json': expected };

  it('loads a well-formed directory', () => {
    expect(loadConfigCorpus(dir(good)).malicious.map((f) => f.id)).toEqual(['a']);
  });
  it('names a sidecar without a config, and a config without a sidecar', () => {
    expect(() => loadConfigCorpus(dir({ ...good, 'malicious/o.expected.json': expected }))).toThrow(
      /o\.expected\.json/,
    );
    expect(() => loadConfigCorpus(dir({ ...good, 'benign/m.meta.json': '{}' }))).toThrow(
      /m\.meta\.json/,
    );
    expect(() => loadConfigCorpus(dir({ 'malicious/b.config.txt': '{}' }))).toThrow(
      /b\.expected\.json/,
    );
  });
  it('refuses an origin that is not real or synthetic, and an unknown client or rule', () => {
    const benign = (meta: object) => ({
      ...good,
      'benign/c.config.txt': '{}',
      'benign/c.meta.json': JSON.stringify(meta),
    });
    expect(() =>
      loadConfigCorpus(dir(benign({ origin: 'scraped', client: 'cursor', path: 'x' }))),
    ).toThrow(/c: origin/);
    expect(() =>
      loadConfigCorpus(dir(benign({ origin: 'real', client: 'emacs', path: 'x' }))),
    ).toThrow(/c: unknown client/);
    const bad = JSON.stringify({
      client: 'cursor',
      path: 'x',
      expected: [{ rule: 'scan/cfg/none', path: 'p' }],
      notChecked: [],
      provenance: {},
    });
    expect(() =>
      loadConfigCorpus(dir({ 'malicious/a.config.txt': '{}', 'malicious/a.expected.json': bad })),
    ).toThrow(/rule that does not exist/);
  });
  it('refuses a placeholder with an unknown token format or a bad repeat, and names the file', () => {
    expect(() =>
      loadConfigCorpus(dir({ ...good, 'malicious/a.config.txt': '{{token:nope:1}}' })),
    ).toThrow(/a\.config\.txt: unknown token format/);
    expect(() =>
      loadConfigCorpus(dir({ ...good, 'malicious/a.config.txt': '{{repeat:x:0}}' })),
    ).toThrow(/a\.config\.txt: bad repeat/);
    expect(() =>
      loadConfigCorpus(dir({ ...good, 'malicious/a.config.txt': '{{repeat:x:99999999}}' })),
    ).toThrow(/a\.config\.txt: bad repeat/);
  });
});
