import { LineCounter, isMap, isScalar, isSeq, parseDocument, type Node } from 'yaml';
import { printable } from '../../reporter-core/failure-detail.js';
import { ExceptionsFileError } from '../exceptions-file.js';

/**
 * The exceptions file of `plune mcp scan` (MCP-G6), the same YAML shape as the one of `plune mcp lint`
 * (`ignore:` and a list of entries with `rule`, `reason` and `expires`), and so one format to learn:
 *
 *     ignore:
 *       - rule: scan/cfg/http-plaintext
 *         scope: github                    # the server label; or { server: github, path: mcpServers.github.url }
 *         reason: "Why."                   # required
 *         expires: 2026-12-31              # required: an exception without an end is a rule switched off
 *
 * An exception hides every finding of one rule on one server (and, with a path, only those at or under that path),
 * never a state of "not measured", and never for ever. An entry past its `expires` does not apply and is a finding of its own.
 */
export interface ScanException {
  rule: string;
  server: string;
  path?: string;
  reason: string;
  expires: string;
  line: number;
}

/** The longest an exception may last, in days, unless the caller says `--allow-long-exceptions`. */
export const MAX_EXCEPTION_DAYS = 180;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (s: string) =>
  DATE.test(s) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
const days = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * Every entry that cannot be read as one is a line of the error (exit 2, with its line number): no reason, no
 * `expires`, an `expires` that is not a date or lies further than `MAX_EXCEPTION_DAYS` from `today`.
 */
export function parseScanExceptions(
  text: string,
  name: string,
  today: string,
  opts: { allowLong?: boolean } = {},
): { active: ScanException[]; expired: ScanException[] } {
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines });
  const lineOf = (node: Node | null | undefined) => lines.linePos(node?.range?.[0] ?? 0).line;
  const problems: string[] = [];
  const fail = (node: Node | null | undefined, message: string) =>
    problems.push(`${name}:${lineOf(node)}: ${message}`);
  for (const e of doc.errors)
    problems.push(`${name}:${e.linePos?.[0]?.line ?? 1}: ${e.message.split('\n')[0]}`);

  const active: ScanException[] = [];
  const expired: ScanException[] = [];
  const root = doc.contents;
  if (problems.length === 0 && root !== null) {
    const list = isMap(root) ? root.get('ignore', true) : undefined;
    if (!isMap(root) || (list !== undefined && list !== null && !isSeq(list)))
      fail(root, 'expected "ignore:" with a list of entries.');
    else if (root.items.some((p) => !(isScalar(p.key) && p.key.value === 'ignore')))
      fail(
        root,
        `the only key of this file is "ignore:"; "${printable(String(root.items.map((p) => (isScalar(p.key) ? p.key.value : '?')).find((k) => k !== 'ignore')))}" is a typo or is not read.`,
      );
    else if (isSeq(list)) {
      for (const item of list.items as Node[]) {
        if (!isMap(item)) {
          fail(item, 'an entry needs rule, scope, reason and expires.');
          continue;
        }
        const pair = (map: typeof item, key: string) =>
          map.items.find((p) => isScalar(p.key) && p.key.value === key);
        const str = (map: typeof item, key: string): string | undefined => {
          const p = pair(map, key);
          if (p === undefined) return undefined;
          const plain = isScalar(p.value) ? p.value.value : p.value;
          if (plain !== null && plain !== undefined && typeof plain !== 'string') {
            fail(
              p.key as Node,
              key === 'expires'
                ? 'expires must be text: write the date in quotes ("2026-12-31").'
                : `${key} must be text.`,
            );
          }
          return typeof plain === 'string' ? plain : undefined;
        };
        const rule = str(item, 'rule');
        const reason = str(item, 'reason');
        const expires = str(item, 'expires');
        let server: string | undefined;
        let path: string | undefined;
        const scope = pair(item, 'scope');
        if (scope !== undefined && isMap(scope.value)) {
          server = str(scope.value, 'server');
          path = str(scope.value, 'path');
        } else server = str(item, 'scope');
        if (path !== undefined && path.trim() === '')
          fail(item, 'path must name a field; leave it out to cover the whole server.');
        const subject = printable(rule ?? 'a rule');
        if (rule === undefined || rule.trim() === '') fail(item, 'an entry needs a rule.');
        if (server === undefined || server.trim() === '')
          fail(
            item,
            `the exception for ${subject} needs a scope: the server label, as scope: <label> or scope: { server, path }.`,
          );
        if (reason === undefined || reason.trim() === '')
          fail(
            item,
            `the exception for ${subject} needs a reason: an exception nobody can read back is a silenced check.`,
          );
        if (expires === undefined)
          fail(
            item,
            `the exception for ${subject} needs an expires date: an exception without an end is a rule switched off.`,
          );
        else if (!isDate(expires))
          fail(item, `expires must be a date, YYYY-MM-DD (got "${printable(expires)}").`);
        else if (
          expires >= today &&
          days(today, expires) > MAX_EXCEPTION_DAYS &&
          opts.allowLong !== true
        ) {
          fail(
            item,
            `expires ${expires} is more than ${MAX_EXCEPTION_DAYS} days away; a longer exception needs --allow-long-exceptions.`,
          );
        }
        if (
          problems.length > 0 ||
          rule === undefined ||
          server === undefined ||
          reason === undefined ||
          expires === undefined
        )
          continue;
        const entry: ScanException = {
          rule,
          server,
          ...(path === undefined ? {} : { path }),
          reason,
          expires,
          line: lineOf(item),
        };
        (expires < today ? expired : active).push(entry);
      }
    }
  }
  if (problems.length > 0) throw new ExceptionsFileError(problems.join('\n'));
  return { active, expired };
}

/** Whether an exception covers a finding of this rule at this server and field path. */
export function covers(
  e: ScanException,
  f: { rule: string; target: string; path: string },
): boolean {
  if (e.rule !== f.rule || e.server !== f.target) return false;
  return (
    e.path === undefined ||
    f.path === e.path ||
    f.path.startsWith(`${e.path}.`) ||
    f.path.startsWith(`${e.path}[`) ||
    f.path.startsWith(`${e.path}/`)
  );
}
