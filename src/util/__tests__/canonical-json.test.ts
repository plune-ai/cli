import { describe, it, expect } from 'vitest';
import { canonicalJson } from '../canonical-json.js';

describe('canonicalJson (AC-04, AC-05, ADR-TC03)', () => {
  it('sorts object keys ascending', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('sorts nested object keys recursively', () => {
    const r = canonicalJson({ z: { b: 2, a: 1 }, a: 0 });
    expect(r).toBe('{"a":0,"z":{"a":1,"b":2}}');
  });

  it('preserves array order (arrays are NOT sorted)', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('handles arrays of objects — keys inside are sorted', () => {
    const r = canonicalJson([{ b: 2, a: 1 }]);
    expect(r).toBe('[{"a":1,"b":2}]');
  });

  it('serializes -0 as 0', () => {
    expect(canonicalJson({ v: -0 })).toBe('{"v":0}');
  });

  it('throws on NaN', () => {
    expect(() => canonicalJson({ v: NaN })).toThrow();
  });

  it('throws on Infinity', () => {
    expect(() => canonicalJson({ v: Infinity })).toThrow();
  });

  it('throws on -Infinity', () => {
    expect(() => canonicalJson({ v: -Infinity })).toThrow();
  });

  it('normalizes strings to NFC before serialization', () => {
    // 'é' as NFD (e + combining accent) vs NFC (single codepoint)
    const nfd = 'é'; // NFD form of é
    const nfc = 'é'; // NFC form of é
    expect(canonicalJson({ v: nfd })).toBe(canonicalJson({ v: nfc }));
  });

  it('produces byte-identical output for identical content regardless of key order', () => {
    const a = { provider: 'anthropic', model: 'claude-3', temperature: 0, max_tokens: 256, prompt_resolved: 'hi' };
    const b = { model: 'claude-3', temperature: 0, prompt_resolved: 'hi', max_tokens: 256, provider: 'anthropic' };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('produces different output when values differ', () => {
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
  });

  it('handles primitive null', () => {
    expect(canonicalJson(null)).toBe('null');
  });

  it('handles empty object', () => {
    expect(canonicalJson({})).toBe('{}');
  });

  it('handles empty array', () => {
    expect(canonicalJson([])).toBe('[]');
  });

  it('serializes numbers using JS-native JSON.stringify representation', () => {
    expect(canonicalJson({ v: 1.5 })).toBe('{"v":1.5}');
    expect(canonicalJson({ v: 1e20 })).toBe('{"v":100000000000000000000}');
    expect(canonicalJson({ v: 1e-7 })).toBe('{"v":1e-7}');
  });

  it('sorts keys at every nesting level recursively', () => {
    const deep = { z: { z: { b: 2, a: 1 }, a: 0 }, a: 99 };
    expect(canonicalJson(deep)).toBe('{"a":99,"z":{"a":0,"z":{"a":1,"b":2}}}');
  });

  // --- non-plain objects + undefined (ADR-TC03 frozen-format edge policy) ---

  it('throws on a non-plain object (Date) instead of collapsing it to {}', () => {
    // A Date has no own enumerable keys → naive key-bag serialization would emit {},
    // making two distinct Dates collide. The frozen format rejects it instead (ADR-TC03).
    expect(() => canonicalJson({ when: new Date(0) })).toThrow();
  });

  it('throws on a class instance (prototype is not Object.prototype)', () => {
    class Box {
      value = 1;
    }
    expect(() => canonicalJson({ box: new Box() })).toThrow();
  });

  it('accepts a null-prototype plain dictionary', () => {
    const dict = Object.create(null) as Record<string, unknown>;
    dict['b'] = 1;
    dict['a'] = 2;
    expect(canonicalJson(dict)).toBe('{"a":2,"b":1}');
  });

  it('throws on an undefined object value (documented divergence from JSON.stringify — ADR-TC03)', () => {
    // JSON.stringify drops keys with undefined values; the frozen canonical format rejects
    // them so an ambiguous input can never silently produce two different identities.
    expect(() => canonicalJson({ a: undefined })).toThrow();
  });
});

// ----------------------------------------------------------------------------
// T8 — property-based tests (AC-04): ≥1000 permutations, 0 mismatches
// ----------------------------------------------------------------------------

function _permute(arr: string[]): string[][] {
  if (arr.length <= 1) return [arr.slice()];
  const result: string[][] = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const p of _permute(rest)) {
      result.push([arr[i] as string, ...p]);
    }
  }
  return result;
}

function _buildOrdered(
  obj: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> {
  const r: Record<string, unknown> = {};
  for (const k of keys) r[k] = obj[k];
  return r;
}

describe('canonicalJson property-based (T8 — AC-04)', () => {
  const TEST_OBJECTS: Record<string, unknown>[] = [
    { provider: 'anthropic', model: 'claude-3', temperature: 0, max_tokens: 1024, prompt: 'hi' },
    { z: 99, a: 1, m: 'mid', b: true, y: null },
    { apple: 'red', cherry: 42, banana: false, date: 'sweet', elderberry: 0.5 },
    { x1: 10, x2: 20, x3: 30, x4: 40, x5: 50 },
    { aa: 'alpha', bb: 'beta', cc: 'gamma', dd: 'delta', ee: 'epsilon' },
    { one: 1, two: 2, three: 3, four: 4, five: 5 },
    { nested: { b: 2, a: 1 }, flat: 42, bool: true, arr: [3, 1, 2], str: 'text' },
    { alpha: 0.1, beta: 0.2, gamma: 0.3, delta: 0.4, epsilon: 0.5 },
    { k1: 'v1', k2: 'v2', k3: 'v3', k4: 'v4', k5: 'v5' },
    { w: 'west', e: 'east', n: 'north', s: 'south', c: 'center' },
  ];

  it('0 mismatches across ≥1000 generated key-order permutations', () => {
    let totalPermutations = 0;
    let mismatches = 0;

    for (const obj of TEST_OBJECTS) {
      const keys = Object.keys(obj);
      const canonical = canonicalJson(obj);
      for (const perm of _permute(keys)) {
        const permuted = _buildOrdered(obj, perm);
        if (canonicalJson(permuted) !== canonical) mismatches++;
        totalPermutations++;
      }
    }

    expect(mismatches).toBe(0);
    // 10 objects × 5! = 120 permutations each = 1200 total
    expect(totalPermutations).toBeGreaterThanOrEqual(1000);
  });
});
