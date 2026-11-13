/**
 * A small JSON reader that keeps where every value starts, for `scanClientConfig` (MCP-G4): `JSON.parse` gives no
 * positions, and a finding in a report or in SARIF needs the line and column of the place it is about. Pure: text in,
 * tree out; it never throws. A syntax error is a category and an offset, never a quote of the text (the line with the
 * error may hold a secret).
 *
 * Objects are lists of members, not JavaScript objects: a key such as `__proto__` is only a string here, and a
 * repeated key stays visible to the caller. Nesting is bounded, so a hostile file cannot exhaust the stack.
 */

export type JsonNode =
  | { t: 'object'; at: number; members: JsonMember[] }
  | { t: 'array'; at: number; items: JsonNode[] }
  | { t: 'string'; at: number; value: string }
  | { t: 'other'; at: number };

export interface JsonMember {
  key: string;
  keyAt: number;
  value: JsonNode;
}

export type ParseErrorCategory =
  | 'unexpected-character'
  | 'unexpected-end'
  | 'unterminated-string'
  | 'unterminated-comment'
  | 'bad-escape'
  | 'control-character'
  | 'bad-literal'
  | 'comment-not-allowed'
  | 'trailing-content'
  | 'too-deep';

export type ParseResult =
  | { ok: true; root: JsonNode | undefined }
  | { ok: false; category: ParseErrorCategory; at: number };

/** Deeper than any real client file; a file nested further is refused, not walked. */
export const MAX_DEPTH = 100;

class Stop {
  constructor(
    readonly category: ParseErrorCategory,
    readonly at: number,
  ) {}
}

const LITERAL = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/;
const PLAIN = /[^"\\\u0000-\u001f]*/y;
const HEX4 = /^[0-9a-fA-F]{4}$/;
const ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

/**
 * Read `text` as JSON. With `comments`, line and block comments count as white space (VS Code reads its file that
 * way); a leading byte order mark is skipped. An empty file (only white space) is `{ ok: true, root: undefined }`.
 */
export function parseJson(text: string, opts: { comments: boolean }): ParseResult {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const n = text.length;
  const stop = (category: ParseErrorCategory, at = i): never => {
    throw new Stop(category, at);
  };

  const skip = (): void => {
    for (;;) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++;
      else if (c === 0x2f) {
        if (!opts.comments) stop('comment-not-allowed');
        const next = text[i + 1];
        if (next === '/') {
          i += 2;
          while (i < n && text[i] !== '\n' && text[i] !== '\r') i++;
        } else if (next === '*') {
          const end = text.indexOf('*/', i + 2);
          if (end === -1) stop('unterminated-comment');
          i = end + 2;
        } else stop('unexpected-character');
      } else return;
    }
  };

  const string = (): string => {
    i++; // the opening quote
    let out = '';
    for (;;) {
      PLAIN.lastIndex = i;
      const m = PLAIN.exec(text);
      out += m ? m[0] : '';
      i += m ? m[0].length : 0;
      if (i >= n) stop('unterminated-string', i);
      const c = text[i]!;
      if (c === '"') {
        i++;
        return out;
      }
      if (c !== '\\') stop('control-character');
      const e = text[i + 1];
      if (e === undefined) stop('unterminated-string', i);
      if (e === 'u') {
        if (!HEX4.test(text.slice(i + 2, i + 6))) stop('bad-escape');
        out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16));
        i += 6;
      } else {
        const ch = ESCAPES[e!];
        if (ch === undefined) stop('bad-escape');
        out += ch;
        i += 2;
      }
    }
  };

  const value = (depth: number): JsonNode => {
    if (depth > MAX_DEPTH) stop('too-deep');
    const at = i;
    const c = text[i];
    if (c === undefined) return stop('unexpected-end');
    if (c === '{') {
      i++;
      const members: JsonMember[] = [];
      skip();
      if (text[i] === '}') {
        i++;
        return { t: 'object', at, members };
      }
      for (;;) {
        skip();
        if (i >= n) stop('unexpected-end');
        if (text[i] !== '"') stop('unexpected-character');
        const keyAt = i;
        const key = string();
        skip();
        if (text[i] !== ':') stop(i >= n ? 'unexpected-end' : 'unexpected-character');
        i++;
        skip();
        members.push({ key, keyAt, value: value(depth + 1) });
        skip();
        if (text[i] === ',') i++;
        else if (text[i] === '}') {
          i++;
          return { t: 'object', at, members };
        } else stop(i >= n ? 'unexpected-end' : 'unexpected-character');
      }
    }
    if (c === '[') {
      i++;
      const items: JsonNode[] = [];
      skip();
      if (text[i] === ']') {
        i++;
        return { t: 'array', at, items };
      }
      for (;;) {
        skip();
        items.push(value(depth + 1));
        skip();
        if (text[i] === ',') i++;
        else if (text[i] === ']') {
          i++;
          return { t: 'array', at, items };
        } else stop(i >= n ? 'unexpected-end' : 'unexpected-character');
      }
    }
    if (c === '"') return { t: 'string', at, value: string() };
    let end = i;
    while (end < n && !',]} \t\r\n/'.includes(text[end]!)) end++;
    if (end === i) stop('unexpected-character');
    if (!LITERAL.test(text.slice(i, end))) stop('bad-literal');
    i = end;
    return { t: 'other', at };
  };

  try {
    skip();
    if (i >= n) return { ok: true, root: undefined };
    const root = value(0);
    skip();
    if (i < n) stop('trailing-content');
    return { ok: true, root };
  } catch (e) {
    if (e instanceof Stop) return { ok: false, category: e.category, at: e.at };
    // Not reachable from the code above; a RangeError from a hostile shape must still not escape.
    return { ok: false, category: 'too-deep', at: i };
  }
}

/** Offset in `text` to 1-based line and column as an editor counts them: UTF-16 units, `\r\n`, `\n` and `\r` end a line, a byte order mark is not a column. */
export function lineLocator(text: string): (at: number) => { line: number; column: number } {
  const starts = [text.charCodeAt(0) === 0xfeff ? 1 : 0];
  for (const m of text.matchAll(/\r\n|\r|\n/g)) starts.push(m.index + m[0].length);
  return (at) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= at) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: at - starts[lo]! + 1 };
  };
}
