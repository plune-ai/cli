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
 * The text of the test call declared on `line` (from 1): from its name to its own `)`, line breaks as
 * LF, no trailing `;`. `column` (from 1, as the runner reports it) picks the call when the line holds
 * more than one; without it such a line gives none rather than the wrong one. Undefined too when the
 * line holds no test call, the call does not close, or the text is larger than the platform keeps.
 */
export function callTextAt(source: string, line: number, column?: number): string | undefined {
  const lines = source.split('\n');
  if (line < 1 || line > lines.length) return undefined;
  const lineStart = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0);
  const lineEnd = lineStart + lines[line - 1]!.length;
  const heads: RegExpExecArray[] = [];
  CALL.lastIndex = lineStart;
  for (let h = CALL.exec(source); h !== null && h.index < lineEnd; h = CALL.exec(source))
    heads.push(h);
  const at = column === undefined ? -1 : lineStart + column - 1;
  const head =
    heads.find((h) => h.index <= at && at < h.index + h[0].length) ??
    (heads.length === 1 ? heads[0] : undefined);
  if (head === undefined) return undefined;
  const end = matching(source, head.index + head[0].length, ')');
  if (end < 0) return undefined;
  const text = source.slice(head.index, end + 1).replace(/\r\n/g, '\n');
  return Buffer.byteLength(text, 'utf8') <= SNAPSHOT_MAX_BYTES ? text : undefined;
}

/** A word that says the value next to it is a credential. Wide on purpose: masking a harmless value
 * (`author: 'Jane'`, `bypass('x')`) costs a word of the snapshot; missing a password leaks it. */
const CREDENTIAL =
  'password|passphrase|passwd|pass|pwd|token|secret|api[-_]?key|private[-_]?key|credential|auth|session|cookie';
/** One string literal, its quote in group `q`. */
const LITERAL = String.raw`(?<q>['"\x60])(?:\\.|(?!\k<q>)[^\\\n])*\k<q>`;
/** The Playwright calls that type a value into a field. */
const TYPING = '(?:fill|type|pressSequentially)';

/** Well-known shapes of a credential, wherever they stand. */
const SHAPES: { kind: string; re: RegExp }[] = [
  { kind: 'github-token', re: /\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{36}\b|\bgithub_pat_\w{20,}/g },
  { kind: 'api-key', re: /\bsk-[\w-]{20,}/g },
  { kind: 'api-key', re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}/g },
  { kind: 'npm-token', re: /\bnpm_[A-Za-z0-9]{20,}/g },
  { kind: 'google-key', re: /\bAIza[\w-]{30,}/g },
  { kind: 'plune-token', re: /\bplune_[A-Za-z0-9_]{16,}/g },
  { kind: 'aws-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  {
    kind: 'private-key',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
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
  // `.fill('#password', '…')`, `.type('#pwd', '…')`: the field is named in the same call
  new RegExp(
    String.raw`(?<lead>\.${TYPING}\(\s*['"][^'"\n]*?(?<role>${CREDENTIAL})[^'"\n]*['"]\s*,\s*)${LITERAL}`,
    'gi',
  ),
  // `getByLabel('Password').fill('…')`, `getByRole('textbox', { name: 'Password' }).type('…')`: … or
  // anywhere in the call the typing is chained off
  new RegExp(
    String.raw`(?<lead>\([^()\n]*?(?<role>${CREDENTIAL})[^()\n]*\)\s*\.${TYPING}\(\s*)${LITERAL}`,
    'gi',
  ),
  // `{ name: 'session', value: '…' }`: a cookie (or any name/value pair) named for a credential
  new RegExp(
    String.raw`(?<lead>\bname\s*:\s*['"][^'"\n]*?(?<role>${CREDENTIAL})[^'"\n]*['"]\s*,\s*value\s*:\s*)${LITERAL}`,
    'gi',
  ),
];

/**
 * A header written out as a line (a raw request in a template, a log pasted into a test):
 * `Authorization: …`, `Cookie: …`, `x-session-id: …`. The name stays, the value goes, to the end of
 * the line or of the string. A quoted value is the literal rules' to take, and a value that is code —
 * a variable or a call followed by `,` `;` `)` `}` `]` (`sessionId: sid,`) — names no secret and stays.
 */
const HEADER_LINE =
  /((?:^|\\[nr]|\x60)[ \t>*<+-]*['"]?)((?:proxy-)?authorization|(?:set-)?cookie|[\w-]*session[\w-]*)(['"]?[ \t]*:[ \t]*)(?![\w$.]+(?:\([^()\n]*\))?[ \t]*[,;)}\]])[^\s'"\x60\\][^\r\n'"\x60\\]*/gim;

/** A URL parameter whose name says credential: its value goes. */
const QUERY_PARAM =
  /([?&][\w.-]*(?:token|key|secret|password|passwd|pass|pwd|auth|signature|sig|credential|session)[\w.-]*=)(?!‹)[^&#\s'"\x60]+/gi;

/**
 * The text with every credential replaced by a `‹role›` marker, the shape the platform's own masking
 * uses: by its form (a key, a token, a private key block, the value of an `Authorization` scheme), by
 * its place (a value given to something named for a credential, typed into a field that is, a header
 * line, a URL parameter, a `PLUNE_` variable), and the user:password of a URL. The platform masks
 * again before a draft; this is so that the secret never leaves the machine.
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
  return (
    out
      .replace(HEADER_LINE, '$1$2$3‹header›')
      .replace(/\b(Bearer)([ \t]+)(?!‹)[\w.~+/=-]{8,}/g, '$1$2‹credential›')
      // `Basic` and `Token` are words too (`Basic checkout works`): only a value with a digit, `=`, `+`, `/` or a capital after a small letter (base64) is one.
      .replace(
        /\b(Basic|Token)([ \t]+)(?!‹)(?=[\w.~+/=-]*[\d=+/]|[\w.~+/=-]*[a-z][\w.~+/=-]*[A-Z])[\w.~+/=-]{8,}/g,
        '$1$2‹credential›',
      )
      .replace(/\b(PLUNE_[A-Z0-9_]*=)(?!‹)[^\s'"\x60;,)]+/g, '$1‹env-secret›')
      .replace(QUERY_PARAM, '$1‹credential›')
      .replace(/\b([a-z][\w+.-]*:\/\/)[^\s/@'"\x60]+@/gi, '$1‹credential›@')
  );
}

/** Where a test is declared: its file (absolute, or from the working directory) and line, from 1. */
export interface CodeLocation {
  file: string;
  line: number;
  column?: number;
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
  const text = callTextAt(source, at.line, at.column);
  if (text === undefined) return undefined;
  const masked = maskCredentials(text);
  return Buffer.byteLength(masked, 'utf8') <= SNAPSHOT_MAX_BYTES ? masked : undefined;
}
