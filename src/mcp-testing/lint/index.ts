import { CALL_RULES, type CallContext, type CallRule } from './call-rules.js';
import { LINT_RULES, type LintRule, type RuleHit } from './rules.js';
import type { CheckLevel, ListedTool, LintFinding } from './types.js';

export { LINT_RULES, detectLanguage, type LintRule, type RuleHit } from './rules.js';
export { CALL_RULES, type CallRule, type CallContext } from './call-rules.js';
export { LINT_THRESHOLDS, type LanguageCode } from './thresholds.js';
export { estimateTokens, toolListSize, type ToolListSize } from './size.js';
export { applyExceptions, type AppliedExceptions } from './exceptions.js';
export type * from './types.js';

const finding = (rule: LintRule | CallRule, hit: RuleHit): LintFinding => ({
  id: rule.id,
  class: rule.class,
  level: hit.level ?? rule.level,
  state: hit.state ?? 'failed',
  target: hit.target,
  message: hit.message,
  expected: hit.expected,
  actual: hit.actual,
  fix: rule.fix,
  specRef: rule.specRef,
});

/**
 * Lint a `tools/list` answer: one finding per rule hit, `failed`, or `could-not-run` for a rule that could not judge
 * the list (a rule with nothing to say adds none).
 */
export function lintTools(tools: readonly ListedTool[], rules = LINT_RULES): LintFinding[] {
  return rules.flatMap((rule) => rule.check(tools).map((hit) => finding(rule, hit)));
}

/** Lint the result of one live call of `tool`, as the server sent it. */
export function lintCall(tool: ListedTool, result: unknown, context: CallContext, rules = CALL_RULES): LintFinding[] {
  return rules.flatMap((rule) => rule.check(tool, result, context).map((hit) => finding(rule, hit)));
}

const RANK: Record<CheckLevel, number> = { info: 0, warn: 1, error: 2 };

/** Orders levels: positive when `a` is more serious than `b`. */
export const compareLevels = (a: CheckLevel, b: CheckLevel): number => RANK[a] - RANK[b];

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

/**
 * Whether a finding fails `plune mcp lint --fail-on <level>`: by its level alone, whatever its class. A heuristic
 * cannot fail the default `--fail-on error`, because no heuristic rule reports above `warn`; a user who asks for
 * `--fail-on warn` asks for heuristic warnings too. `never` fails nothing.
 */
export function failsAt(finding: LintFinding, failOn: CheckLevel | 'never'): boolean {
  if (failOn === 'never') return false;
  if (finding.state !== 'failed' && finding.state !== 'could-not-run') return false;
  return RANK[finding.level] >= RANK[failOn];
}
