/**
 * What a malformed call is derived from, and what an answer to it is searched for (`scan/probe/error-detail-leak`).
 *
 * The arguments come from the tool's `inputSchema` in one fixed way and from nothing else: the first required property
 * is left out (the other required ones get a placeholder of their type); a tool with no required property gets its
 * first property with a value of the wrong type. A tool that declares neither gets no malformed call.
 *
 * The patterns are heuristics, and each is linear: every repetition is bounded and no two repetitions run over the
 * same characters, so no input makes one of them backtrack. They run on the first 64 KiB of an answer only. A
 * match says "the answer looks like this kind of detail", never that something valuable leaked; no match is not a pass.
 */

export const MAX_LEAK_TEXT = 64 * 1024;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The most names of `required` or `properties` that are walked, and the most bytes the derived arguments may hold. */
export const MAX_SCHEMA_NAMES = 256;
export const MAX_DERIVED_BYTES = 16 * 1024;

const PLACEHOLDER: Record<string, unknown> = {
  string: '',
  number: 0,
  integer: 0,
  boolean: false,
  array: [],
  object: {},
};

/** A schema with more names than are walked: no malformed call is derived from it. */
export function schemaTooLarge(schema: unknown): boolean {
  if (!isRecord(schema)) return false;
  const required = schema['required'];
  const properties = schema['properties'];
  return (
    (Array.isArray(required) && required.length > MAX_SCHEMA_NAMES) ||
    (isRecord(properties) && Object.keys(properties).length > MAX_SCHEMA_NAMES)
  );
}

/** Derived arguments over the size a declared call may have. */
export function derivedTooLarge(args: Record<string, unknown>): boolean {
  return Buffer.byteLength(JSON.stringify(args), 'utf8') > MAX_DERIVED_BYTES;
}

export function malformedArguments(schema: unknown): Record<string, unknown> | undefined {
  if (!isRecord(schema)) return undefined;
  const properties = isRecord(schema['properties']) ? schema['properties'] : {};
  const required = Array.isArray(schema['required'])
    ? (schema['required'] as unknown[]).filter((r): r is string => typeof r === 'string')
    : [];
  const typeOf = (name: string): unknown => {
    const p = Object.hasOwn(properties, name) ? properties[name] : undefined;
    return isRecord(p) ? p['type'] : undefined;
  };
  if (required.length > 0)
    return Object.fromEntries(
      required.slice(1).map((name) => {
        const t = typeOf(name);
        return [
          name,
          typeof t === 'string' && Object.hasOwn(PLACEHOLDER, t) ? PLACEHOLDER[t] : null,
        ];
      }),
    );
  const first = Object.keys(properties)[0];
  if (first === undefined) return undefined;
  return { [first]: typeOf(first) === 'string' ? 0 : 'x' };
}

export interface LeakPattern {
  id: 'stack-js' | 'stack-py' | 'abs-path' | 'sql' | 'internal-host';
  /** The words the finding uses for it. */
  what: string;
  re: RegExp;
}

export const LEAK_PATTERNS: readonly LeakPattern[] = [
  {
    id: 'stack-js',
    what: 'a stack trace',
    re: /\bat (?:[^\s()]{1,200} \([^\s()]{1,300}:\d{1,6}:\d{1,6}\)|(?:\/|[A-Za-z]:\\|file:|node:)[^\s()]{1,300}:\d{1,6})/,
  },
  {
    id: 'stack-py',
    what: 'a stack trace',
    re: /\bFile "[^"\n]{1,300}", line \d{1,7}|Traceback \(most recent call last\)/,
  },
  {
    id: 'abs-path',
    what: 'a file path',
    re: /(?<![\w.:/-])\/(?:usr|var|etc|home|opt|srv|app|root|tmp|Users|mnt|data|workspace)\/[^\s"'<>():]{1,300}|\b[A-Za-z]:\\[^\s"'<>|?*]{1,300}/,
  },
  {
    id: 'sql',
    what: 'an SQL fragment',
    re: /\b(?:SELECT\s[^;]{0,200}?\sFROM\s|INSERT\s+INTO\s|UPDATE\s+\S{1,100}\s+SET\s|DELETE\s+FROM\s|FROM\s+[\w.]{1,64}\s+WHERE\b|syntax error at or near|SQLSTATE\[|ORA-\d{5}|ER_[A-Z_]{3,40})/i,
  },
  {
    id: 'internal-host',
    what: 'an internal host name or address',
    re: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3})\b|\b[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){0,3}\.(?:internal|local|lan|corp|intranet)\b|\blocalhost:\d{2,5}/i,
  },
];

/** The id of the first pattern the answer matches, or undefined. The text is read up to 64 KiB. */
export function findLeak(text: string): LeakPattern['id'] | undefined {
  const head = text.slice(0, MAX_LEAK_TEXT);
  return LEAK_PATTERNS.find((p) => p.re.test(head))?.id;
}

/** The text of an answer that refused a call: the error message and data, or the text content of an isError result. */
export function errorTextOf(message: unknown): string {
  const parts: string[] = [];
  const m = isRecord(message) ? message : {};
  const error = isRecord(m['error']) ? m['error'] : undefined;
  if (error !== undefined) {
    if (typeof error['message'] === 'string') parts.push(error['message']);
    const data = error['data'];
    if (data !== undefined)
      parts.push(typeof data === 'string' ? data : (JSON.stringify(data) ?? ''));
  }
  // A JSON-RPC answer holds `result`; the runner may also hand over the result itself.
  const result = isRecord(m['result']) ? m['result'] : m;
  const content = result['content'];
  if (Array.isArray(content))
    for (const c of content)
      if (isRecord(c) && typeof c['text'] === 'string') parts.push(c['text']);
  return parts.join('\n').slice(0, MAX_LEAK_TEXT);
}
