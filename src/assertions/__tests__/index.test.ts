import { describe, expect, it } from 'vitest';
import * as api from '../index.js';

// Loads the public barrel so its re-exports are covered (mirrors types/__tests__/barrels.test.ts).
describe('assertions public surface (index.ts)', () => {
  it('exposes the registry facade', () => {
    expect(typeof api.getAssertion).toBe('function');
    expect(typeof api.createAssertionRegistry).toBe('function');
    expect(typeof api.createDefaultRegistry).toBe('function');
  });
});
