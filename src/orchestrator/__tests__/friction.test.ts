import { describe, expect, it } from 'vitest';
import {
  frictionAdvice,
  isIdKey,
  scanIds,
  SCAN_DEPTH,
  SCAN_ITEMS,
  type FrictionCall,
} from '../friction.js';
import { isIdenticalCall, isPageTurn } from '../../util/tool-calls.js';

const ok = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const WITH_ID = { items: [{ id: 'ISSUE-8841', title: 'a' }] };

function call(step: number, name: string, args: unknown, answer?: unknown): FrictionCall {
  return {
    step,
    name,
    args,
    executed: true,
    is_error: false,
    ...(answer !== undefined ? { ids: scanIds(answer) } : {}),
  };
}

const types = (calls: FrictionCall[]): string[] => frictionAdvice(calls).map((a) => a.type);

describe('CLI · run · friction · identical-retry', () => {
  it('CLI · run · friction · two identical calls in a row are caught, in one step and across steps (AC-6)', () => {
    const same = [
      call(1, 'search', { q: 'a', n: 1 }, ok({})),
      call(1, 'search', { n: 1, q: 'a' }, ok({})),
    ];
    expect(frictionAdvice(same)).toMatchObject([
      { type: 'identical-retry', tool: 'search', steps: [1], count: 1 },
    ]);
    const across = [call(1, 'search', { q: 'a' }, ok({})), call(2, 'search', { q: 'a' }, ok({}))];
    expect(frictionAdvice(across)).toMatchObject([
      { type: 'identical-retry', steps: [1, 2], count: 1 },
    ]);
  });

  it('CLI · run · friction · different arguments, or another tool in between, are not a retry (AC-6)', () => {
    expect(
      types([call(1, 'search', { q: 'a' }, ok({})), call(2, 'search', { q: 'b' }, ok({}))]),
    ).toEqual([]);
    expect(
      types([
        call(1, 'search', { q: 'a' }, ok({})),
        call(2, 'other', {}, ok({})),
        call(3, 'search', { q: 'a' }, ok({})),
      ]),
    ).toEqual([]);
  });
});

describe('CLI · run · friction · pagination-continuation', () => {
  it('CLI · run · friction · a call that differs only in a pagination key is a page turn and never a retry (AC-7)', () => {
    for (const key of [
      'cursor',
      'page',
      'offset',
      'limit',
      'after',
      'before',
      'start',
      'pageToken',
      'nextCursor',
    ]) {
      const got = frictionAdvice([
        call(1, 'list', { q: 'a', [key]: 'x' }, ok({})),
        call(2, 'list', { q: 'a', [key]: 'y' }, ok({})),
      ]);
      expect(
        got.map((a) => a.type),
        key,
      ).toEqual(['pagination-continuation']);
    }
    // A key that is added or dropped is a page turn as well.
    expect(
      types([
        call(1, 'list', { q: 'a' }, ok({})),
        call(2, 'list', { q: 'a', cursor: 'c1' }, ok({})),
      ]),
    ).toEqual(['pagination-continuation']);
  });

  it('CLI · run · friction · a page turn that also changes another argument is neither a retry nor a page turn (AC-7)', () => {
    expect(
      types([
        call(1, 'list', { q: 'a', page: 1 }, ok({})),
        call(2, 'list', { q: 'b', page: 2 }, ok({})),
      ]),
    ).toEqual([]);
  });

  it('CLI · run · friction · the shared check agrees: a page turn is not identical', () => {
    const [a, b] = [
      { name: 'list', args: { cursor: 1 } },
      { name: 'list', args: { cursor: 2 } },
    ];
    expect(isIdenticalCall(a, b)).toBe(false);
    expect(isPageTurn(a, b)).toBe(true);
    expect(isIdenticalCall(a, { name: 'list', args: { cursor: 1 } })).toBe(true);
    expect(isPageTurn(a, { name: 'list', args: { cursor: 1 } })).toBe(false);
  });
});

const item = (id: string, extra: Record<string, unknown> = {}) => ok({ items: [{ id, ...extra }] });

describe('CLI · run · friction · search-after-id', () => {
  it('CLI · run · friction · the fixture really holds an identifier, so "no signal" below is not trivial', () => {
    expect(scanIds(ok(WITH_ID))).toMatchObject({ paths: ['items[].id'] });
    expect((scanIds(ok(WITH_ID)) as { values: unknown[] }).values).toHaveLength(1);
  });

  it('CLI · run · friction · a later call of the same tool that returns a record already seen is flagged, with paths and no values (AC-8, AC-9)', () => {
    const got = frictionAdvice([
      call(1, 'search', { q: 'a' }, ok(WITH_ID)),
      call(2, 'search', { q: 'b' }, ok(WITH_ID)),
    ]);
    expect(got).toMatchObject([
      { type: 'search-after-id', tool: 'search', steps: [1, 2], count: 1, paths: ['items[].id'] },
    ]);
    expect(JSON.stringify(got)).not.toContain('ISSUE-8841');
  });

  it('CLI · run · friction · a later call that returns other records is no signal: the old rule fired here', () => {
    expect(
      types([
        call(1, 'search', { q: 'a' }, item('ISSUE-8841')),
        call(2, 'search', { q: 'b' }, item('ISSUE-9999')),
      ]),
    ).toEqual([]);
    expect(
      types([call(1, 'search', { q: 'a' }, ok(WITH_ID)), call(2, 'search', { q: 'b' }, ok({}))]),
    ).toEqual([]);
  });

  it('CLI · run · friction · numbers and short strings are not compared: 5 and "ab12" are too common to mean the same record', () => {
    expect(
      types([
        call(1, 'search', { q: 'a' }, item('ab12')),
        call(2, 'search', { q: 'b' }, item('ab12')),
      ]),
    ).toEqual([]);
    expect(
      types([
        call(1, 'search', { q: 'a' }, ok({ items: [{ id: 5 }] })),
        call(2, 'search', { q: 'b' }, ok({ items: [{ id: 5 }] })),
      ]),
    ).toEqual([]);
    expect(
      types([
        call(1, 'search', { q: 'a' }, item('abcdef')),
        call(2, 'search', { q: 'b' }, item('abcdef')),
      ]),
    ).toEqual(['search-after-id']);
  });

  it('CLI · run · friction · a UUID counts, and a shared value is found anywhere in the later answer', () => {
    const uuid = '3f2b8c1e-7a4d-4e0b-9c55-0d6f1a2b3c4d';
    expect(
      types([
        call(1, 'search', { q: 'a' }, ok({ rows: [{ link: uuid }] })),
        call(2, 'search', { q: 'b' }, ok({ other: { deep: [{ link: uuid }] } })),
      ]),
    ).toEqual(['search-after-id']);
  });

  it('CLI · run · friction · another tool returning the same record is no signal', () => {
    expect(
      types([
        call(1, 'search', { q: 'a' }, ok(WITH_ID)),
        call(2, 'fetch', { q: 'b' }, ok(WITH_ID)),
      ]),
    ).toEqual([]);
  });

  it('CLI · run · friction · two calls of one tool inside one step give no search-after-id (AC-8)', () => {
    expect(
      types([
        call(1, 'search', { q: 'a' }, ok(WITH_ID)),
        call(1, 'search', { q: 'b' }, ok(WITH_ID)),
      ]),
    ).toEqual([]);
  });

  it('CLI · run · friction · an errored answer, or no identifier at all: no signal', () => {
    expect(
      types([
        call(1, 'search', { q: 'a' }, ok({ items: [] })),
        call(2, 'search', { q: 'b' }, ok({ items: [] })),
      ]),
    ).toEqual([]);
    const failed = { ...call(1, 'search', { q: 'a' }), is_error: true };
    expect(types([failed, call(2, 'search', { q: 'b' }, ok(WITH_ID))])).toEqual([]);
  });

  it('CLI · run · friction · an answer that cannot be read is "not measured" with its reason, not zero signals (AC-9)', () => {
    const text = { content: [{ type: 'text', text: 'Found 3 issues: ISSUE-8841 and more' }] };
    const got = frictionAdvice([
      call(1, 'search', { q: 'a' }, text),
      call(2, 'search', { q: 'b' }, ok({})),
    ]);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ type: 'friction-unmeasured', tool: 'search', steps: [1, 2] });
    expect(got[0]!.reason).toContain('not measured');
    expect(got[0]!.reason).toContain('not JSON');
    expect(JSON.stringify(got)).not.toContain('ISSUE-8841');
  });

  it('CLI · run · friction · a server with text answers gets one "not measured" for the tool in the row, not one per pair of calls', () => {
    const text = { content: [{ type: 'text', text: 'plain' }] };
    const calls = Array.from({ length: 12 }, (_, i) =>
      call(i + 1, 'search', { q: String(i) }, text),
    );
    const got = frictionAdvice(calls);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ type: 'friction-unmeasured', tool: 'search' });
    expect(got[0]!.count).toBeLessThanOrEqual(calls.length);
    expect(frictionAdvice([...calls, ...calls.map((c) => ({ ...c, name: 'list' }))])).toHaveLength(
      2,
    );
  });

  it('CLI · run · friction · an answer nobody scanned is not measured either', () => {
    const got = frictionAdvice([
      call(1, 'search', { q: 'a' }),
      call(2, 'search', { q: 'b' }, ok({})),
    ]);
    expect(types([call(1, 'search', { q: 'a' }), call(2, 'search', { q: 'b' })])).toEqual([
      'friction-unmeasured',
    ]);
    expect(got[0]!.reason).toContain('no answer was kept');
  });

  it('CLI · run · friction · calls that never ran are left out', () => {
    const notRun = { ...call(2, 'search', { q: 'a' }, ok({})), executed: false };
    expect(types([call(1, 'search', { q: 'a' }, ok({})), notRun])).toEqual([]);
  });
});

describe('CLI · run · friction · paths of keys that come from the server', () => {
  const paths = (v: unknown) => (scanIds(ok(v)) as { paths: string[] }).paths;
  it('CLI · run · friction · a segment that looks like data becomes *', () => {
    const uuid = '3f2b8c1e-7a4d-4e0b-9c55-0d6f1a2b3c4d';
    expect(paths({ users: { [uuid]: { id: 5 } } })).toEqual(['users.*.id']);
    expect(paths({ by: { 'ann@example.com': { id: 5 } } })).toEqual(['by.*.id']);
    expect(paths({ by: { '12345': { id: 5 } } })).toEqual(['by.*.id']);
    expect(paths({ by: { ['x'.repeat(41)]: { id: 5 } } })).toEqual(['by.*.id']);
    expect(paths({ by: { 'two words': { id: 5 } } })).toEqual(['by.*.id']);
    expect(paths({ by: { 'a\nb': { id: 5 } } })).toEqual(['by.*.id']);
    expect(paths({ by: { 'a-b_c': { id: 5 } } })).toEqual(['by.a-b_c.id']);
  });

  it('CLI · run · friction · a path is at most 120 characters', () => {
    let deep: unknown = { id: 1 };
    for (let i = 0; i < 5; i++) deep = { ['k'.repeat(30) + i]: deep };
    expect(paths(deep)[0]!.length).toBeLessThanOrEqual(120);
  });
});

describe('CLI · run · friction · what counts as an identifier', () => {
  it('CLI · run · friction · key names', () => {
    for (const key of [
      'id',
      'ids',
      'ID',
      'key',
      'uuid',
      'slug',
      'number',
      'ref',
      'identifier',
      'user_id',
      'userId',
      'issueNumber',
      'page_ref',
      'ticketIds',
    ])
      expect(isIdKey(key), key).toBe(true);
    for (const key of [
      'title',
      'valid',
      'Valid',
      'idle',
      'identity',
      'monkey',
      'name',
      'grid',
      'paid',
      'hidden',
    ])
      expect(isIdKey(key), key).toBe(false);
  });

  it('CLI · run · friction · values: scalars and arrays of scalars under an id key, and UUID strings anywhere', () => {
    expect(scanIds(ok({ id: 7 })).paths).toEqual(['id']);
    expect(scanIds(ok({ data: { ids: ['a', 'b'] } }))).toMatchObject({ paths: ['data.ids'] });
    expect(scanIds(ok({ rows: [{ link: '3f2b8c1e-7a4d-4e0b-9c55-0d6f1a2b3c4d' }] }))).toMatchObject(
      {
        paths: ['rows[].link'],
      },
    );
    expect(scanIds(ok({ id: null, ids: [], key: '', name: 'x' }))).toMatchObject({ paths: [] });
    expect(scanIds(ok({ id: { nested: 1 } }))).toMatchObject({ paths: [] });
  });

  it('CLI · run · friction · structured content is read too', () => {
    expect(scanIds({ structuredContent: { items: [{ id: 1 }] }, content: [] })).toMatchObject({
      paths: ['items[].id'],
    });
  });

  it('CLI · run · friction · the walk is bounded in depth and in array items', () => {
    let deep: unknown = { id: 1 };
    for (let i = 0; i < SCAN_DEPTH + 2; i++) deep = { a: deep };
    expect(scanIds(ok(deep))).toMatchObject({ paths: [] });
    const late = Array.from({ length: SCAN_ITEMS + 1 }, (_, i) =>
      i === SCAN_ITEMS ? { id: 1 } : {},
    );
    expect(scanIds(ok({ items: late }))).toMatchObject({ paths: [] });
  });

  it('CLI · run · friction · a result that is no JSON, or has no text, is unreadable', () => {
    expect(scanIds({ content: [{ type: 'text', text: 'plain' }] })).toEqual({
      unreadable: 'the answer is not JSON',
    });
    expect(scanIds({ content: [] })).toEqual({ unreadable: 'the answer is not JSON' });
    expect(scanIds('x')).toEqual({ unreadable: 'the answer is not JSON' });
  });
});
