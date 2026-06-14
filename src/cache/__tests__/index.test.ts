import { describe, expect, it } from 'vitest';
import * as api from '../index.js';

// Loads the public barrel so its re-exports are covered (mirrors types/embeddings barrel tests).
describe('cache public surface (index.ts)', () => {
  it('exposes openCache', () => {
    expect(typeof api.openCache).toBe('function');
  });
});
