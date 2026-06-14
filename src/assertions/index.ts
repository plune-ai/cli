// Public surface of the assertions module — what the orchestrator imports.

export { getAssertion, createAssertionRegistry, createDefaultRegistry } from './registry.js';
export type { AssertionRegistry } from './registry.js';

// Re-export the (frozen) assertion contract types for consumers.
export type { Assertion, AssertionContext, AssertionResult } from '../types/assertion.js';
