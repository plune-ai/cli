// Assertion registry (ADR-AP01). Composition edge: wires the built-in pure kinds.
// Function-based, no global state. Assertions are STATELESS — resolve returns a shared instance
// (params arrive per-call via AssertionContext), unlike the providers registry which constructs.

import type { Assertion } from '../types/assertion.js';
import type { AssertionKind } from '../types/config.js';
import { exactMatch } from './exact-match.js';
import { contains, containsAny, containsAll } from './contains.js';
import { jsonSchema } from './json-schema.js';
import { semanticSimilarity } from './semantic-similarity.js';
import { llmJudge } from './llm-judge.js';
import { faithfulness } from './faithfulness.js';
import { answerRelevance } from './answer-relevance.js';
import { contextPrecision } from './context-precision.js';

export interface AssertionRegistry {
  register(type: string, impl: Assertion): void;
  resolve(type: string): Assertion;
  has(type: string): boolean;
}

export function createAssertionRegistry(): AssertionRegistry {
  const impls = new Map<string, Assertion>();

  return {
    register(type, impl) {
      if (impls.has(type)) {
        throw new Error(`Assertion "${type}" is already registered — assertion types must be unique.`);
      }
      impls.set(type, impl);
    },
    resolve(type) {
      const impl = impls.get(type);
      if (impl === undefined) {
        const known = [...impls.keys()].join(', ') || '(none)';
        throw new Error(`Unknown assertion type "${type}". Registered: ${known}.`);
      }
      return impl;
    },
    has(type) {
      return impls.has(type);
    },
  };
}

// Each impl is typed to its own params (Assertion<KindParams>); the registry erases that to
// Assertion<unknown>. The cast is sound because the config schema guarantees the params handed
// to run(ctx) match the resolved kind. All 10 documented kinds are registered.
export function createDefaultRegistry(): AssertionRegistry {
  const registry = createAssertionRegistry();
  registry.register('exact-match', exactMatch as Assertion);
  registry.register('contains', contains as Assertion);
  registry.register('contains-any', containsAny as Assertion);
  registry.register('contains-all', containsAll as Assertion);
  registry.register('json-schema', jsonSchema as Assertion);
  registry.register('semantic-similarity', semanticSimilarity as Assertion);
  registry.register('llm-judge', llmJudge as Assertion);
  registry.register('faithfulness', faithfulness as Assertion);
  registry.register('answer-relevance', answerRelevance as Assertion);
  registry.register('context-precision', contextPrecision as Assertion);
  return registry;
}

// Memoized default registry — the built-in kinds are immutable, so build once and reuse
// (the orchestrator calls getAssertion per assertion per row). Tests needing isolation use
// createAssertionRegistry() instead.
let defaultRegistry: AssertionRegistry | undefined;

/** Convenience facade for the orchestrator: resolve a built-in assertion by kind. */
export function getAssertion(type: AssertionKind): Assertion {
  defaultRegistry ??= createDefaultRegistry();
  return defaultRegistry.resolve(type);
}
