import type { LintException } from '../lint/index.js';

/**
 * Lint findings on Plune's own tool list that are accepted on purpose. Each needs a reason; an entry without one
 * fails the contract test, and so does an entry that no longer matches any finding.
 */
export const PLUNE_LINT_EXCEPTIONS: readonly LintException[] = [];
