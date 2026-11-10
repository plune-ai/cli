import { LineCounter, isMap, isSeq, parseDocument, type Node } from 'yaml';
import { MCP_EXIT } from './exit-codes.js';
import type { LintException } from './lint/index.js';

// The exceptions file of a server's repository, read for `plune mcp lint`. Not plune.yaml: that is the eval config,
// read by a strict schema, and an exception for a foreign server's lint must not break `plune run`. Not .plune/: that
// folder holds the cache and the last run and is usually not committed.

/** An entry of an exceptions file, by the line it starts on. */
export interface FileException extends LintException {
  line: number;
  /** The last day the entry applies, `YYYY-MM-DD`. */
  expires?: string;
}

/** A file of exceptions that cannot be read as one: exit 2, every problem with its line. */
export class ExceptionsFileError extends Error {
  readonly exitCode = MCP_EXIT.usage;
  constructor(message: string) {
    super(message);
    this.name = 'ExceptionsFileError';
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (s: string) =>
  DATE.test(s) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

/**
 * The exceptions file of a server's repository (`plune-mcp-ignore.yaml`):
 *
 *     ignore:
 *       - rule: desc-no-when-not
 *         tool: some_tool        # without tool: the rule on every tool
 *         reason: "Why."         # required
 *         expires: 2026-12-31    # optional, the last day it applies
 *
 * `name` is how errors name the file. An entry whose `expires` is before `today` (`YYYY-MM-DD`) no longer applies and
 * comes back in `expired`. Every entry without a reason, and every value of the wrong shape, is one line of the
 * error, with its line number.
 */
export function parseExceptionsFile(
  text: string,
  name: string,
  today: string,
): { active: FileException[]; expired: FileException[] } {
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines });
  const lineOf = (node: Node | null | undefined) => lines.linePos(node?.range?.[0] ?? 0).line;
  const problems: string[] = [];
  const fail = (node: Node | null | undefined, message: string) =>
    problems.push(`${name}:${lineOf(node)}: ${message}`);
  for (const e of doc.errors)
    problems.push(`${name}:${e.linePos?.[0]?.line ?? 1}: ${e.message.split('\n')[0]}`);

  const active: FileException[] = [];
  const expired: FileException[] = [];
  const root = doc.contents;
  if (problems.length === 0 && root !== null) {
    const list = isMap(root) ? root.get('ignore', true) : undefined;
    if (!isMap(root) || (list !== undefined && list !== null && !isSeq(list)))
      fail(root, 'expected "ignore:" with a list of entries.');
    else if (isSeq(list)) {
      for (const item of list.items as Node[]) {
        if (!isMap(item)) {
          fail(item, 'an entry needs rule and reason.');
          continue;
        }
        const field = (key: string) => {
          const value = item.get(key, true) as Node | undefined;
          const plain = (value as { value?: unknown } | undefined)?.value;
          if (value !== undefined && plain !== null && typeof plain !== 'string')
            fail(value, `${key} must be text.`);
          return typeof plain === 'string' ? plain : undefined;
        };
        const [rule, tool, reason, expires] = [
          field('rule'),
          field('tool'),
          field('reason'),
          field('expires'),
        ];
        if (rule === undefined || rule.trim() === '') fail(item, 'an entry needs a rule.');
        if (reason === undefined || reason.trim() === '')
          fail(
            item,
            `the exception for ${rule ?? 'a rule'} needs a reason: an exception nobody can read back is a silenced check.`,
          );
        if (expires !== undefined && !isDate(expires))
          fail(item, `expires must be a date, YYYY-MM-DD (got "${expires}").`);
        if (
          rule === undefined ||
          reason === undefined ||
          reason.trim() === '' ||
          (expires !== undefined && !isDate(expires))
        )
          continue;
        const entry: FileException = {
          id: rule,
          target: tool === undefined ? {} : { tool },
          reason,
          line: lineOf(item),
          ...(expires === undefined ? {} : { expires }),
        };
        (expires !== undefined && expires < today ? expired : active).push(entry);
      }
    }
  }
  if (problems.length > 0) throw new ExceptionsFileError(problems.join('\n'));
  return { active, expired };
}
