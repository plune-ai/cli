// The code snapshot of an automated case: the text of the one `test()` / `it()` call a result points
// at, as it is written in the file, so that Plune can show it on the case and draft a description from
// it (plune-ai/plune#2936). Read here, on the machine that ran the tests, because the platform never
// sees the repository.
//
// No parser: the call is found on the line the runner named and cut at its own closing parenthesis by
// a scanner that knows strings, templates, comments and regular expressions. What it cannot read is no
// snapshot, never a guess and never a failed run.

import { readFileSync } from 'node:fs';

/** What the platform keeps of a snapshot, in bytes of UTF-8: the same ceiling as a case's description. */
export const SNAPSHOT_MAX_BYTES = 16_384;

/** `test(`, `test.skip(` … `it.only(` — the declaration forms. `test.describe(` is not one of them. */
const CALL = /\b(?:test|it)(?:\.(?:skip|fixme|only|fail|slow))?\s*\(/g;

/** After one of these a `/` opens a regular expression, not a division. */
// ponytail: by the last character only — `return /x/` reads as a division and the call is lost (no snapshot). A tokenizer when that shows up.
const BEFORE_REGEX = new Set([...'(,=:[!&|?{};+-*%<>~^']);

function skipString(src: string, i: number, quote: string): number {
  for (let j = i + 1; j < src.length; j += 1) {
    const c = src[j];
    if (c === '\\') j += 1;
    else if (c === quote) return j + 1;
    else if (c === '\n') return -1;
  }
  return -1;
}

function skipTemplate(src: string, i: number): number {
  for (let j = i + 1; j < src.length; j += 1) {
    const c = src[j];
    if (c === '\\') j += 1;
    else if (c === '`') return j + 1;
    else if (c === '$' && src[j + 1] === '{') {
      const end = matching(src, j + 2, '}');
      if (end < 0) return -1;
      j = end;
    }
  }
  return -1;
}

function skipRegex(src: string, i: number): number {
  let inClass = false;
  for (let j = i + 1; j < src.length; j += 1) {
    const c = src[j];
    if (c === '\\') j += 1;
    else if (c === '\n') return -1;
    else if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      let k = j + 1;
      while (k < src.length && /[a-z]/i.test(src[k]!)) k += 1;
      return k;
    }
  }
  return -1;
}

/** The index of the bracket that closes the one opened just before `i`, or -1. */
function matching(src: string, i: number, close: string): number {
  const stack = [close];
  let prev = '(';
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    let to = -2;
    if (c === '/' && next === '/') to = src.indexOf('\n', i);
    else if (c === '/' && next === '*')
      to = src.indexOf('*/', i + 2) < 0 ? -1 : src.indexOf('*/', i + 2) + 2;
    else if (c === "'" || c === '"') to = skipString(src, i, c);
    else if (c === '`') to = skipTemplate(src, i);
    else if (c === '/' && BEFORE_REGEX.has(prev)) to = skipRegex(src, i);
    if (to === -1) return -1;
    if (to !== -2) {
      // A literal is a value: a `/` after it divides. A comment changes nothing.
      if (c !== '/' || (next !== '/' && next !== '*')) prev = 'a';
      i = to;
      continue;
    }
    if (c === '(') stack.push(')');
    else if (c === '[') stack.push(']');
    else if (c === '{') stack.push('}');
    else if (c === ')' || c === ']' || c === '}') {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i;
    }
    if (!/\s/.test(c)) prev = c;
    i += 1;
  }
  return -1;
}

/**
 * The text of the test call that starts on `line` (from 1): from its name to its own `)`, line breaks
 * as LF, no trailing `;`. Undefined when the line holds no test call, the call does not close, or the
 * text is larger than the platform keeps.
 */
export function callTextAt(source: string, line: number): string | undefined {
  const lines = source.split('\n');
  if (line < 1 || line > lines.length) return undefined;
  const lineStart = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0);
  CALL.lastIndex = lineStart;
  const head = CALL.exec(source);
  if (head === null || head.index >= lineStart + lines[line - 1]!.length) return undefined;
  const end = matching(source, head.index + head[0].length, ')');
  if (end < 0) return undefined;
  const text = source.slice(head.index, end + 1).replace(/\r\n/g, '\n');
  return Buffer.byteLength(text, 'utf8') <= SNAPSHOT_MAX_BYTES ? text : undefined;
}

/** A word that says the value next to it is a credential. */
const CREDENTIAL = 'password|passwd|token|secret|api[-_]?key';
/** One string literal, its quote in group `q`. */
const LITERAL = String.raw`(?<q>['"\x60])(?:\\.|(?!\k<q>)[^\\\n])*\k<q>`;

/** Well-known shapes of a credential, wherever they stand. */
const SHAPES: { kind: string; re: RegExp }[] = [
  { kind: 'github-token', re: /\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{36}\b|\bgithub_pat_\w{20,}/g },
  { kind: 'api-key', re: /\bsk-[\w-]{20,}/g },
  { kind: 'aws-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  {
    kind: 'private-key',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  { kind: 'bearer', re: /\bBearer [\w.~+/=-]{20,}/g },
  { kind: 'jwt', re: /\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g },
];

/** A literal standing where a credential belongs: its group `lead` is kept, the literal is replaced. */
const PLACES: RegExp[] = [
  // `password = '…'`, `apiKey: "…"`, `'x-api-key': '…'`
  new RegExp(
    String.raw`(?<lead>\b(?<role>[\w$-]*(?:${CREDENTIAL})[\w$-]*)['"]?\s*[:=]\s*)${LITERAL}`,
    'gi',
  ),
  // `setToken('…')`: the call is named for a credential
  new RegExp(String.raw`(?<lead>\b(?<role>[\w$]*(?:${CREDENTIAL})[\w$]*)\s*\(\s*)${LITERAL}`, 'gi'),
  // `.fill('#password', '…')`: the field the value goes to is named in the same call
  new RegExp(
    String.raw`(?<lead>\.fill\(\s*['"][^'"\n]*?(?<role>${CREDENTIAL})[^'"\n]*['"]\s*,\s*)${LITERAL}`,
    'gi',
  ),
  // `getByLabel('Password').fill('…')`: … or in the call the fill is chained off
  new RegExp(
    String.raw`(?<lead>\(\s*['"][^'"\n]*?(?<role>${CREDENTIAL})[^'"\n]*['"][^()\n]*\)\s*\.fill\(\s*)${LITERAL}`,
    'gi',
  ),
];

/**
 * The text with every credential replaced by a `‹role›` marker, the shape the platform's own masking
 * uses: by its form (a key, a token, a private key block), by its place (a value given to something
 * named for a credential, or filled into a field that is), and the user:password of a URL.
 * The platform masks again before a draft; this is so that the secret never leaves the machine.
 */
export function maskCredentials(text: string): string {
  let out = text;
  for (const { kind, re } of SHAPES) out = out.replace(re, `‹${kind}›`);
  for (const re of PLACES) {
    out = out.replace(re, (...args) => {
      const groups = args.at(-1) as { lead: string; role: string; q: string };
      return `${groups.lead}${groups.q}‹${groups.role.toLowerCase().replace(/^[^a-z]+/, '')}›${groups.q}`;
    });
  }
  return out.replace(/\b([a-z][\w+.-]*:\/\/)[^\s/@'"\x60]+@/gi, '$1‹credential›@');
}

/** Where a test is declared: its file (absolute, or from the working directory) and line, from 1. */
export interface CodeLocation {
  file: string;
  line: number;
}

/**
 * The snapshot to send for a test declared at `at`: read, cut, masked, and within the platform's
 * ceiling — or undefined. `files` keeps each file read once per run.
 */
export function snapshotAt(
  at: CodeLocation,
  files: Map<string, string | null>,
): string | undefined {
  let source = files.get(at.file);
  if (source === undefined) {
    try {
      source = readFileSync(at.file, 'utf8');
    } catch {
      source = null;
    }
    files.set(at.file, source);
  }
  if (source === null) return undefined;
  const text = callTextAt(source, at.line);
  if (text === undefined) return undefined;
  const masked = maskCredentials(text);
  return Buffer.byteLength(masked, 'utf8') <= SNAPSHOT_MAX_BYTES ? masked : undefined;
}
