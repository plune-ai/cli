import { describe, expect, it } from 'vitest';
import { extractJson } from '../json-extract.js';

describe('extractJson — strict (ADR-AP02)', () => {
  it('parses output that is entirely valid JSON', () => {
    const r = extractJson('{"a":1}', 'strict');
    expect(r).toEqual({ ok: true, value: { a: 1 } });
  });

  it('parses surrounding whitespace', () => {
    expect(extractJson('  {"a":1}  ', 'strict')).toEqual({ ok: true, value: { a: 1 } });
  });

  it('preserves a valid JSON null value (not confused with "not found")', () => {
    expect(extractJson('null', 'strict')).toEqual({ ok: true, value: null });
  });

  it('fails when there is text around the JSON', () => {
    expect(extractJson('here: {"a":1}', 'strict')).toEqual({ ok: false });
  });

  it('fails on non-JSON output', () => {
    expect(extractJson('not json at all', 'strict')).toEqual({ ok: false });
  });
});

describe('extractJson — auto (ADR-AP02)', () => {
  it('extracts JSON from a ```json fenced block', () => {
    const out = 'Here you go:\n```json\n{"a":1}\n```\nDone.';
    expect(extractJson(out, 'auto')).toEqual({ ok: true, value: { a: 1 } });
  });

  it('extracts JSON from a plain ``` fenced block', () => {
    expect(extractJson('```\n{"b":2}\n```', 'auto')).toEqual({ ok: true, value: { b: 2 } });
  });

  it('extracts the first balanced object embedded in prose', () => {
    expect(extractJson('result = {"a":1} ok', 'auto')).toEqual({ ok: true, value: { a: 1 } });
  });

  it('extracts a top-level array', () => {
    expect(extractJson('items: [1,2,3]!', 'auto')).toEqual({ ok: true, value: [1, 2, 3] });
  });

  it('handles braces inside strings without breaking balancing', () => {
    expect(extractJson('x {"a":"}"} y', 'auto')).toEqual({ ok: true, value: { a: '}' } });
  });

  it('returns ok:false when no JSON is present', () => {
    expect(extractJson('just prose, no json', 'auto')).toEqual({ ok: false });
  });

  it('falls through to a balanced object when the fenced block is not valid JSON', () => {
    expect(extractJson('```\nnot json\n```\n{"c":3}', 'auto')).toEqual({ ok: true, value: { c: 3 } });
  });

  it('handles escaped quotes inside strings (backslash-aware balancing)', () => {
    expect(extractJson('out: {"msg":"say \\"hi\\""}', 'auto')).toEqual({
      ok: true,
      value: { msg: 'say "hi"' },
    });
  });

  it('returns ok:false when an opening brace never closes', () => {
    expect(extractJson('result = { unclosed forever', 'auto')).toEqual({ ok: false });
  });

  it('skips a decoy balanced run that is not valid JSON and finds the real JSON (regression: review BUG #1)', () => {
    expect(extractJson('Here {as requested}: {"score":5}', 'auto')).toEqual({
      ok: true,
      value: { score: 5 },
    });
  });

  it('skips a decoy object and finds a later valid array', () => {
    expect(extractJson('note {x>0} then ["a","b"]', 'auto')).toEqual({
      ok: true,
      value: ['a', 'b'],
    });
  });
});
