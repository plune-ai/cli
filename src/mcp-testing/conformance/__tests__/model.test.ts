// The conformance model as pure functions: the catalog against the registry of implementations, the frozen profile,
// and the score and verdict of a set of verdicts. No server, no process.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CATALOG, type CatalogEntry } from '../catalog.js';
import { IMPLEMENTATIONS } from '../checks/index.js';
import type { Verdict } from '../outcome.js';
import { manifestDigest, PROFILE, type Profile } from '../profile.js';
import { BUCKETS, exitCodeOf, floorScore, summarize, summaryLine } from '../score.js';

/** The digest each profile version was frozen with. A new list is a new version, and a new line here. */
const FROZEN: Record<string, string> = {
  '2026-11.1': '466f528105d991a6734e4d9b03572d3f4882e393a0623f06831be3acd7c2e200',
  // The same ids: base-jsonrpc-parse-error moved to HTTP only, which changes the score of a stdio server.
  '2026-11.2': '466f528105d991a6734e4d9b03572d3f4882e393a0623f06831be3acd7c2e200',
};

/**
 * Where each id of the profile applies (kind, level, eras, transports), per version: an id moved to another transport
 * or era leaves or joins the denominator, so it re-scores a server and needs a new version as a new list does.
 */
const RULES: Record<string, string> = {
  '2026-11.1': 'a00f6a2d31a8e9c381bc38d97f709927401b9ae789aba425c5a8f34c0d4655df',
  '2026-11.2': '95caebf216f085d053c2615d55152b6c9318094ae3e9544bba5a67bf865696be',
};
const rulesDigest = (ids: readonly string[]) => {
  const byId = new Map(CATALOG.map((e) => [e.id, e]));
  const lines = [...ids].sort().map((id) => {
    const e = byId.get(id);
    return `${id} ${e?.kind} ${e?.level} ${[...(e?.eras ?? [])].sort().join(',')} ${[...(e?.transports ?? [])].sort().join(',')}`;
  });
  return createHash('sha256').update(lines.join('\n')).digest('hex');
};

const PROFILE_SOURCE = fileURLToPath(new URL('../profile.ts', import.meta.url));
const SAVED = fileURLToPath(new URL('./fixtures/result-2026-11.1.json', import.meta.url));

/** The ids one set has and the other lacks, both ways: empty when they match. */
function drift(catalog: readonly { id: string }[], registry: Readonly<Record<string, unknown>>) {
  const inCatalog = new Set(catalog.map((e) => e.id));
  const inRegistry = new Set(Object.keys(registry));
  return {
    notImplemented: [...inCatalog].filter((id) => !inRegistry.has(id)),
    notCatalogued: [...inRegistry].filter((id) => !inCatalog.has(id)),
  };
}

const entry = (over: Partial<CatalogEntry> & { id: string }): CatalogEntry => ({
  suite: 'protocol',
  title: over.id,
  description: over.id,
  kind: 'check',
  level: 'MUST',
  derived: false,
  specRefs: [{ revision: '2025-11-25', page: 'basic/index', section: 'Messages' }],
  eras: ['legacy', 'modern'],
  transports: ['stdio', 'http'],
  needsFixture: false,
  ...over,
});

describe('CLI · mcp conformance · catalog and registry', () => {
  it('the registry and the catalog hold the same ids', () => {
    expect(drift(CATALOG, IMPLEMENTATIONS)).toEqual({ notImplemented: [], notCatalogued: [] });
  });

  it('an id added to only one side is caught, on either side', () => {
    const extra = entry({ id: 'life-new-probe' });
    expect(drift([...CATALOG, extra], IMPLEMENTATIONS).notImplemented).toEqual(['life-new-probe']);
    expect(drift(CATALOG, { ...IMPLEMENTATIONS, 'life-new-probe': null }).notCatalogued).toEqual([
      'life-new-probe',
    ]);
  });

  it('every entry is complete: a kebab-case id, a level for a check, a cited section, a title and a description', () => {
    const ids = CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of CATALOG) {
      expect(e.id, e.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(e.level === null, e.id).toBe(e.kind !== 'check');
      expect(e.specRefs.length, e.id).toBeGreaterThan(0);
      for (const r of e.specRefs) {
        expect(r.revision, e.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(r.section.trim(), e.id).not.toBe('');
      }
      expect(e.title.trim(), e.id).not.toBe('');
      expect(e.description.trim(), e.id).not.toBe('');
      expect(e.eras.length, e.id).toBeGreaterThan(0);
      expect(e.transports.length, e.id).toBeGreaterThan(0);
      if (e.derived) expect((e.derivation ?? '').trim(), e.id).not.toBe('');
    }
  });
});

describe('CLI · mcp conformance · frozen profile', () => {
  it('the digest is the one its version was frozen with', () => {
    expect(manifestDigest(PROFILE.checks)).toBe(FROZEN[PROFILE.version]);
    expect(PROFILE.version).toMatch(/^\d{4}-\d{2}\.\d+$/);
  });

  it('where each id of the profile applies is what its version was frozen with: a change of transport or era is a new version', () => {
    expect(rulesDigest(PROFILE.checks)).toBe(RULES[PROFILE.version]);
  });

  it('a saved 2026-11.1 stdio result with base-jsonrpc-parse-error failed still scores as it recorded: failed', () => {
    const ids = PROFILE.checks.filter((id) => id !== 'base-jsonrpc-parse-error');
    const s = summarize([...ids.map((id) => v(id, 'passed')), v('base-jsonrpc-parse-error', 'failed')]);
    expect(s.verdict).toBe('failed');
    expect(s.failed).toEqual(['base-jsonrpc-parse-error']);
  });

  it('the digest does not depend on the order, and changes with the set', () => {
    expect(manifestDigest([...PROFILE.checks].reverse())).toBe(manifestDigest(PROFILE.checks));
    expect(manifestDigest(PROFILE.checks.slice(1))).not.toBe(manifestDigest(PROFILE.checks));
  });

  it('the list is written as literals, never taken from the catalog', () => {
    const source = readFileSync(PROFILE_SOURCE, 'utf8');
    const list = /checks: \[\r?\n([\s\S]*?)\r?\n\s*\],/.exec(source);
    expect(list, 'a `checks: [ ... ],` block of its own lines').not.toBeNull();
    for (const line of (list?.[1] ?? '').split(/\r?\n/))
      expect(line, 'one quoted id per line').toMatch(/^\s*'[a-z0-9-]+',$/);
    expect(source).not.toMatch(/from '\.\/catalog\.js'/);
  });

  it('every id of the profile is a MUST check of the catalog', () => {
    const byId = new Map(CATALOG.map((e) => [e.id, e]));
    for (const id of PROFILE.checks) {
      expect(byId.get(id)?.kind, id).toBe('check');
      expect(byId.get(id)?.level, id).toBe('MUST');
    }
  });
});

const v = (id: string, state: Verdict['state'], reason?: Verdict['reason']): Verdict =>
  reason === undefined ? { id, state } : { id, state, reason };

describe('CLI · mcp conformance · score and verdict', () => {
  const catalog = [
    entry({ id: 'must-a' }),
    entry({ id: 'must-b' }),
    entry({ id: 'must-c' }),
    entry({ id: 'must-d' }),
    entry({ id: 'should-a', level: 'SHOULD' }),
    entry({ id: 'may-a', level: 'MAY' }),
    entry({ id: 'probe', kind: 'control', level: null }),
    entry({ id: 'hint', kind: 'advice', level: null }),
  ];
  // SHOULD and MAY in the profile too: the score still reads only MUST.
  const profile: Profile = {
    id: 'test',
    version: '2026-11.1',
    checks: ['must-a', 'must-b', 'must-c', 'must-d', 'should-a', 'may-a'],
  };
  const score = (verdicts: Verdict[]) => summarize(verdicts, catalog, profile);

  it('rounds down to a tenth: 1999 of 2000 is 99.9, not 100', () => {
    expect(floorScore(1999, 2000)).toBe(99.9);
    expect(floorScore(22, 24)).toBe(91.6);
    expect(floorScore(0, 0)).toBeNull();
    expect(floorScore(0, 3)).toBe(0);
  });

  it('only MUST counts: SHOULD and MAY are advisories and move neither the score nor the exit code', () => {
    const s = score([
      v('must-a', 'passed'),
      v('should-a', 'failed'),
      v('may-a', 'failed'),
      v('probe', 'failed'),
      v('hint', 'failed'),
    ]);
    expect(s).toMatchObject({ score: 100, applicable: 1, verdict: 'passed' });
    expect(s.advisories).toEqual(['should-a', 'may-a', 'hint']);
    expect(s.controls).toEqual(['probe']);
    expect(exitCodeOf(s.verdict)).toBe(0);
  });

  it('not-applicable and pending stay out of the denominator; could-not-run is in it, but not for needs-input', () => {
    const s = score([
      v('must-a', 'passed'),
      v('must-b', 'not-applicable', 'transport'),
      v('must-c', 'pending'),
      v('must-d', 'could-not-run', 'needs-input'),
    ]);
    expect(s).toMatchObject({ score: 100, applicable: 1, verdict: 'passed' });
    const t = score([v('must-a', 'passed'), v('must-b', 'could-not-run', 'timeout')]);
    expect(t).toMatchObject({ score: 50, applicable: 2, verdict: 'incomplete' });
    expect(exitCodeOf(t.verdict)).toBe(3);
  });

  it('a failure fails the run, before anything that could not run', () => {
    const s = score([v('must-a', 'failed'), v('must-b', 'could-not-run', 'timeout'), v('must-c', 'passed')]);
    expect(s).toMatchObject({ score: 33.3, verdict: 'failed' });
    expect(exitCodeOf(s.verdict)).toBe(1);
  });

  it('nothing measured is score null, incomplete, exit 3: no checks, all needs-input, all not-applicable', () => {
    for (const verdicts of [
      [],
      [v('must-a', 'could-not-run', 'needs-input'), v('must-b', 'could-not-run', 'needs-input')],
      [v('must-a', 'not-applicable', 'era'), v('should-a', 'passed')],
    ]) {
      const s = score(verdicts);
      expect(s).toMatchObject({ score: null, applicable: 0, verdict: 'incomplete' });
      expect(exitCodeOf(s.verdict)).toBe(3);
    }
  });

  it('a MUST check outside the profile is pending, whatever its verdict', () => {
    const s = summarize([v('must-a', 'passed'), v('must-b', 'failed')], catalog, { ...profile, checks: ['must-a'] });
    expect(s).toMatchObject({ score: 100, verdict: 'passed', pending: ['must-b'] });
  });

  it('the buckets add up to the checks, and the summary line names every id it counts against', () => {
    const verdicts = [
      v('must-a', 'failed'),
      v('must-b', 'could-not-run', 'timeout'),
      v('must-c', 'passed'),
      v('must-d', 'could-not-run', 'needs-input'),
      v('should-a', 'passed'),
      v('probe', 'passed'),
    ];
    const s = score(verdicts);
    expect(BUCKETS.reduce((n, k) => n + s[k].length, 0)).toBe(verdicts.length);
    expect(summaryLine(s, new Map([['must-b', 'timeout']]))).toBe(
      'Score 33.3 = 1 of 3 | failed: must-a | could-not-run: must-b (timeout) | outside the score: needs-input 1, advisories 1, controls 1',
    );
    expect(summaryLine(score([]))).toBe('Score none = 0 of 0');
  });

  it('an id the catalog does not have is refused', () => {
    expect(() => score([v('nowhere', 'passed')])).toThrow(/no check "nowhere"/);
  });
});

describe('CLI · mcp conformance · a saved result keeps its score', () => {
  const saved = JSON.parse(readFileSync(SAVED, 'utf8')) as {
    manifestDigest: string;
    checks: Verdict[];
    summary: { score: number | null; applicable: number; verdict: string };
    exitCode: number;
  };

  it('scored again with today\'s catalog and profile, it gives the score and exit code it recorded', () => {
    expect(saved.manifestDigest).toBe(manifestDigest(PROFILE.checks));
    const s = summarize(saved.checks);
    expect({ score: s.score, applicable: s.applicable, verdict: s.verdict }).toEqual(saved.summary);
    expect(exitCodeOf(s.verdict)).toBe(saved.exitCode);
  });

  it('a new MUST check in the catalog but not in the profile changes neither, whatever it says', () => {
    const catalog = [...CATALOG, entry({ id: 'life-new-probe' })];
    for (const state of ['failed', 'could-not-run', 'passed'] as const) {
      const s = summarize(
        [...saved.checks, v('life-new-probe', state, state === 'could-not-run' ? 'timeout' : undefined)],
        catalog,
      );
      expect({ score: s.score, applicable: s.applicable, verdict: s.verdict }, state).toEqual(saved.summary);
      expect(exitCodeOf(s.verdict), state).toBe(saved.exitCode);
      expect(s.pending, state).toContain('life-new-probe');
    }
  });
});
