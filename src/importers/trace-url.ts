import { printable } from '../reporter-core/failure-detail.js';
import { traceUrlProblem } from '../types/run-result-schema.js';

/**
 * The trace link a report gives a test, as the result carries it: trimmed, or `undefined` when there is none. A link the
 * platform would refuse (`traceUrlProblem`) costs only the link, never the result or its batch: it is left out and
 * said in `notes`, the title as a JSON string so a name with a new line in it cannot start a line of ours.
 */
export function traceUrlOf(value: unknown, title: string, notes: string[]): string | undefined {
  if (value === undefined || (typeof value === 'string' && value.trim() === '')) return undefined;
  const problem = traceUrlProblem(value);
  if (problem === undefined) return (value as string).trim();
  notes.push(`plune: ${JSON.stringify(printable(title))}: trace link not sent (${problem}) — the result is imported without it.`);
  return undefined;
}
