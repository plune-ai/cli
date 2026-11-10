import type { LintException, LintFinding } from './types.js';

export interface AppliedExceptions<E extends LintException = LintException> {
  /** Findings no exception covers. */
  findings: LintFinding[];
  /** Findings an exception covers, with it. */
  excepted: { finding: LintFinding; exception: E }[];
  /** Exceptions that matched nothing: the finding is gone, so the exception is stale. */
  unused: E[];
}

// An exception accepts what a rule found; a rule that could not run found nothing, so no exception covers it.
const covers = (e: LintException, f: LintFinding) =>
  f.state !== 'could-not-run' &&
  f.id === e.id &&
  (e.target.tool === undefined || f.target.tool === e.target.tool) &&
  (e.target.param === undefined || f.target.param === e.target.param);

const where = (e: LintException) =>
  `${e.target.tool ?? 'every tool'}${e.target.param === undefined ? '' : `.${e.target.param}`}`;

/**
 * Set deliberate exceptions aside. An exception without a reason is refused outright: an exception is a decision,
 * and a decision nobody can read back is a silenced check.
 */
export function applyExceptions<E extends LintException>(findings: readonly LintFinding[], exceptions: readonly E[]): AppliedExceptions<E> {
  const unexplained = exceptions.filter((e) => typeof e.reason !== 'string' || e.reason.trim() === '');
  if (unexplained.length > 0) {
    const list = unexplained.map((e) => `${e.id} on ${where(e)}`).join(', ');
    throw new Error(`a lint exception needs a reason: ${list}`);
  }
  const used = new Set<E>();
  const kept: LintFinding[] = [];
  const excepted: AppliedExceptions<E>['excepted'] = [];
  for (const finding of findings) {
    const exception = exceptions.find((e) => covers(e, finding));
    if (exception === undefined) kept.push(finding);
    else {
      used.add(exception);
      excepted.push({ finding, exception });
    }
  }
  return { findings: kept, excepted, unused: exceptions.filter((e) => !used.has(e)) };
}
