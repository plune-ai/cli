import { describe, expect, it, vi } from 'vitest';
import { createAssertionRegistry, getAssertion } from '../registry.js';
import type { Assertion } from '../../types/assertion.js';
import type { AssertionKind } from '../../types/config.js';

const PURE_KINDS: AssertionKind[] = [
  'exact-match',
  'contains',
  'contains-any',
  'contains-all',
  'json-schema',
];

describe('assertion registry (ADR-AP01)', () => {
  it('resolves each built-in pure kind (AC-1)', () => {
    for (const kind of PURE_KINDS) {
      expect(typeof getAssertion(kind).run).toBe('function');
    }
  });

  it('registers and resolves a custom assertion with no core change (AC-2)', () => {
    const registry = createAssertionRegistry();
    const fake: Assertion = { run: vi.fn(async () => ({ passed: true })) };
    registry.register('fake', fake);
    expect(registry.resolve('fake')).toBe(fake);
  });

  it('throws on a duplicate registration (FR-1)', () => {
    const registry = createAssertionRegistry();
    const fake: Assertion = { run: async () => ({ passed: true }) };
    registry.register('dup', fake);
    expect(() => registry.register('dup', fake)).toThrowError(/already registered/i);
  });

  it('throws on resolving an unknown type (FR-1)', () => {
    const registry = createAssertionRegistry();
    expect(() => registry.resolve('nope')).toThrowError(/unknown assertion/i);
  });

  it('resolves the semantic-similarity kind', () => {
    expect(typeof getAssertion('semantic-similarity').run).toBe('function');
  });

  it('resolves the llm-judge and RAG kinds (AC-8)', () => {
    const kinds: AssertionKind[] = [
      'llm-judge',
      'faithfulness',
      'answer-relevance',
      'context-precision',
    ];
    for (const kind of kinds) {
      expect(typeof getAssertion(kind).run).toBe('function');
    }
  });
});
