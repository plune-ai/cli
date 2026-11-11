// The class of every assertion type, in one table. `measure`: a number against a threshold the author sets;
// `deterministic`: yes or no by a rule; `heuristic`: advice. Measures and deterministic checks decide the row; a
// heuristic never does: the orchestrator files what it finds under the row's `agent.advice`, and no config makes it
// a gate. Typed by every kind, so a new kind without a class does not compile; a test holds it to the registry.

import type { AssertionKind } from '../types/config.js';

export type AssertionClass = 'measure' | 'deterministic' | 'heuristic';

export const ASSERTION_CLASSES: Record<AssertionKind, AssertionClass> = {
  'exact-match': 'deterministic',
  contains: 'deterministic',
  'contains-any': 'deterministic',
  'contains-all': 'deterministic',
  'json-schema': 'deterministic',
  // A score against the author's threshold. They decide the row as they always have.
  'semantic-similarity': 'measure',
  'llm-judge': 'measure',
  faithfulness: 'measure',
  'answer-relevance': 'measure',
  'context-precision': 'measure',
  'tool-called': 'deterministic',
  'tool-not-called': 'deterministic',
  'tool-args': 'deterministic',
  'tool-order': 'deterministic',
  'only-tools': 'deterministic',
  'first-tool': 'deterministic',
  'no-tool-errors': 'deterministic',
  'tool-call-count': 'measure',
  'no-repeated-call': 'heuristic',
  'token-budget': 'measure',
  'tool-latency': 'measure',
  'tool-result-size': 'measure',
  'tool-result-schema': 'deterministic',
  'no-destructive-tool': 'deterministic',
};
