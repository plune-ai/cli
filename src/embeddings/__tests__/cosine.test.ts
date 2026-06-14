import { describe, expect, it } from 'vitest';
import { cosine } from '../cosine.js';

const v = (...xs: number[]): Float32Array => Float32Array.from(xs);

describe('cosine (ADR-EMB02)', () => {
  it('returns 1 for identical / parallel vectors (AC-1)', () => {
    expect(cosine(v(1, 0, 0), v(1, 0, 0))).toBeCloseTo(1);
    expect(cosine(v(1, 2, 3), v(2, 4, 6))).toBeCloseTo(1);
  });

  it('returns 0 for orthogonal vectors (AC-1)', () => {
    expect(cosine(v(1, 0, 0), v(0, 1, 0))).toBeCloseTo(0);
  });

  it('returns -1 for opposite vectors (AC-1)', () => {
    expect(cosine(v(1, 0, 0), v(-1, 0, 0))).toBeCloseTo(-1);
  });

  it('returns 0 for a zero vector — no NaN (AC-2)', () => {
    expect(cosine(v(0, 0, 0), v(1, 0, 0))).toBe(0);
  });

  it('throws on a length mismatch (AC-2)', () => {
    expect(() => cosine(v(1, 0), v(1, 0, 0))).toThrow();
  });
});
