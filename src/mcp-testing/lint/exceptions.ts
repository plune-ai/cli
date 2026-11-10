import type { LintException, LintFinding } from './types.js';

export interface AppliedExceptions {
  /** Findings no exception covers. */
  findings: LintFinding[];
  /** Findings an exception covers, with it. */
  excepted: { finding: LintFinding; exception: LintException }[];
  /** Exceptions that matched nothing: the finding is gone, so the exception is stale. */
  unused: LintException[];
}

const sameTarget = (f: LintFinding, e: LintException) => f.id === e.id && f.target.tool === e.target.tool && f.target.param === e.target.param;

/**
 * Set deliberate exceptions aside. An exception without a reason is refused outright: an exception is a decision,
 * and a decision nobody can read back is a silenced check.
 */
export function applyExceptions(findings: readonly LintFinding[], exceptions: readonly LintException[]): AppliedExceptions {
  const unexplained = exceptions.filter((e) => typeof e.reason !== 'string' || e.reason.trim() === '');
  if (unexplained.length > 0) {
    const list = unexplained.map((e) => `${e.id} on ${e.target.tool}${e.target.param === undefined ? '' : `.${e.target.param}`}`).join(', ');
    throw new Error(`a lint exception needs a reason: ${list}`);
  }
  const used = new Set<LintException>();
  const kept: LintFinding[] = [];
  const excepted: AppliedExceptions['excepted'] = [];
  for (const finding of findings) {
    const exception = exceptions.find((e) => sameTarget(finding, e));
    if (exception === undefined) kept.push(finding);
    else {
      used.add(exception);
      excepted.push({ finding, exception });
    }
  }
  return { findings: kept, excepted, unused: exceptions.filter((e) => !used.has(e)) };
}
