import { LINT_RULES } from './rules.js';
import type { CheckLevel, ListedTool, LintFinding } from './types.js';

export { LINT_RULES, detectLanguage, type LintRule, type RuleHit } from './rules.js';
export { LINT_THRESHOLDS, type LanguageCode } from './thresholds.js';
export { estimateTokens, toolListSize, type ToolListSize } from './size.js';
export { applyExceptions, type AppliedExceptions } from './exceptions.js';
export type * from './types.js';

/** Lint a `tools/list` answer: one finding per rule hit, every one `failed` (a rule with nothing to say adds none). */
export function lintTools(tools: readonly ListedTool[], rules = LINT_RULES): LintFinding[] {
  return rules.flatMap((rule) =>
    rule.check(tools).map(
      (hit): LintFinding => ({
        id: rule.id,
        class: rule.class,
        level: hit.level ?? rule.level,
        state: 'failed',
        target: hit.target,
        message: hit.message,
        expected: hit.expected,
        actual: hit.actual,
        fix: rule.fix,
        specRef: rule.specRef,
      }),
    ),
  );
}

const RANK: Record<CheckLevel, number> = { info: 0, warn: 1, error: 2 };

/**
 * Whether a finding fails a gate. A heuristic never does; a measure or a deterministic check does at `minLevel`
 * (`error` by default) or above, when it failed or could not run — `could-not-run` is never a pass.
 * No gating finding is not green on its own: a list of zero tools yields no findings at all, so the caller must check
 * that tools were checked (as the contract test does). The `list-size` measure is a warning, so it does not gate at
 * the default level; its threshold is the measured limit of our own biggest list.
 */
export function gates(finding: LintFinding, minLevel: CheckLevel = 'error'): boolean {
  if (finding.class === 'heuristic') return false;
  if (finding.state !== 'failed' && finding.state !== 'could-not-run') return false;
  return RANK[finding.level] >= RANK[minLevel];
}
