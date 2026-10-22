import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatIds, handleIds, planIds } from '../ids.js';
import { testsOfListing } from '../verify.js';

const FIXTURE = new URL('../../__tests__/fixtures/playwright-list.json', import.meta.url);
const raw = readFileSync(FIXTURE, 'utf8');
const code = testsOfListing(JSON.parse(raw));
const TOP = 'nested/cart.spec.ts#top level';

const keyed = (id: string, value: string, state = 'active') => ({
  id,
  title: 't',
  type: 'automated',
  state,
  externalKeys: [{ kind: 'path-title', value }],
});

const deps = (file: string, cases: unknown[], write: boolean) => ({
  apiUrl: 'https://api.test',
  loadToken: () => 'tok',
  fetchImpl: (async () =>
    new Response(JSON.stringify({ testCases: cases, nextCursor: null }))) as typeof fetch,
  list: () => raw,
  file,
  write,
});
const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'ids-')), 'plune', 'ids.json');

describe('plune ids (plune-ai/plune#1291, AC-01/AC-05)', () => {
  it('maps only tests without an id that have a case; lists the rest', () => {
    const plan = planIds(code, [keyed('k1', TOP)], {});
    expect(plan.added).toEqual({ [TOP]: 'k1' });
    expect(plan.covered).toBe(2); // the PluneId one and the @P one name an id
    expect(plan.noCase).toEqual([]);
    expect(planIds(code, [], {}).noCase).toEqual([TOP]);
  });

  it('a retired case gets no entry', () => {
    const plan = planIds(code, [keyed('k1', TOP, 'deprecated')], {});
    expect(plan.added).toEqual({});
    expect(plan.noCase).toEqual([TOP]);
  });

  it('dry run writes nothing; --write writes a sorted file; a second run is a no-op', async () => {
    const file = tmpFile();
    const cases = [keyed('k1', TOP)];
    const dry = await handleIds(deps(file, cases, false));
    expect(dry.written).toBe(false);
    expect(() => readFileSync(file)).toThrow();
    expect(formatIds(dry, false)).toContain('Would add to');

    const first = await handleIds(deps(file, cases, true));
    expect(first.written).toBe(true);
    const text = readFileSync(file, 'utf8');
    expect(text).toBe(`{\n  "${TOP}": "k1"\n}\n`);

    const again = await handleIds(deps(file, cases, true));
    expect(again.written).toBe(false);
    expect(again.added).toEqual({});
    expect(readFileSync(file, 'utf8')).toBe(text);
  });

  it('keeps existing entries, never overwrites one, reports orphans, merges sorted', async () => {
    const file = tmpFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `{\n  "z.spec.ts#gone": "old",\n  "${TOP}": "mine"\n}\n`);
    const r = await handleIds(deps(file, [keyed('k1', TOP)], true));
    expect(r.added).toEqual({});
    expect(r.orphaned).toEqual(['z.spec.ts#gone']);
    expect(JSON.parse(readFileSync(file, 'utf8'))[TOP]).toBe('mine');
  });

  it('a broken mapfile is an error and is left as it was', async () => {
    const file = tmpFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{ nope');
    await expect(handleIds(deps(file, [keyed('k1', TOP)], true))).rejects.toThrow(/not valid JSON/);
    expect(readFileSync(file, 'utf8')).toBe('{ nope');
    writeFileSync(file, '["a"]');
    await expect(handleIds(deps(file, [], true))).rejects.toThrow(/must be an object/);
  });
});
