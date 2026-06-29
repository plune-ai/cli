// PUBLIC surface — frozen within schemaVersion: 1 (ADR-TC01, ADR-TC02).
// This barrel is pinned by the golden contract test (T10).
// Any addition or removal here is a breaking change requiring a schemaVersion bump.
export type {
  RunResult,
  EvalResult,
  RowResult,
  AssertionResultRecord,
  Summary,
  Usage,
  RunError,
} from './results.js';
