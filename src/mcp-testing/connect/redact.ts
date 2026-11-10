import type { ConnectTarget } from './options.js';

// The one place secrets are masked. Everything the connection core writes (the frame journal, error messages, the
// stderr tail) and everything a command prints passes through a Redactor. A frame that goes to the server is never
// touched: only the copy that is written down is masked.
//
// Two rules:
// - by name: a header or variable whose name says it is a credential is shown as ***, whatever its length;
// - by value: every value given for the connection (headers, --env, secrets in the URL) is replaced wherever it
//   appears, because a server may repeat a token in its own error. A value under 8 characters is not searched for
//   (--env DEBUG=1 must not turn every 1 into ***); only its name can hide it. The exception is a value whose name
//   already says it is a credential and that has no name in a text to hide behind: the URL password, a secret query
//   value, the password of Basic credentials. Those are searched for whatever their length, and the URL itself is
//   written in its masked form wherever it appears.

export const MASK = '***';
const MIN_SECRET_LENGTH = 8;
/** How deep `value()` walks; deeper is cut, so a hostile frame cannot make the copy cost more than the frame. */
const MAX_DEPTH = 64;

const SECRET_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie']);
const SECRET_HEADER_PART = /key|token|secret|auth/i;
const SECRET_ENV_PART = /KEY|TOKEN|SECRET|PASSWORD/i;
const SECRET_QUERY = new Set(['token', 'key', 'secret', 'password', 'api_key', 'access_token']);

export const isSecretHeader = (name: string): boolean =>
  SECRET_HEADERS.has(name.toLowerCase()) || SECRET_HEADER_PART.test(name);
export const isSecretEnv = (name: string): boolean => SECRET_ENV_PART.test(name);

export interface Redactor {
  /** The text with every known secret value replaced. */
  text(text: string): string;
  /** A masked copy: every string and every key goes through `text`. */
  value(value: unknown): unknown;
}

/** `user:password@` and the values of credential-named query parameters as ***. */
export function maskUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  if (url.username !== '') url.username = MASK;
  if (url.password !== '') url.password = MASK;
  for (const name of [...url.searchParams.keys()])
    if (SECRET_QUERY.has(name.toLowerCase())) url.searchParams.set(name, MASK);
  // URLSearchParams encodes * as %2A; the mask reads better as itself.
  return url.href.replaceAll('%2A%2A%2A', MASK);
}

const decoded = (text: string): string => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text; // a malformed escape: the raw form is still a secret, and the rest still gets read
  }
};

/** The query as written, not as URLSearchParams decodes it: a server may echo either form. */
const rawQuery = (search: string): [string, string][] =>
  search
    .slice(1)
    .split('&')
    .filter((pair) => pair !== '')
    .map((pair) => {
      const eq = pair.indexOf('=');
      return eq < 0 ? [pair, ''] : [pair.slice(0, eq), pair.slice(eq + 1)];
    });

interface Secrets {
  /** Searched for when at least 8 characters long. */
  values: string[];
  /** Searched for whatever their length: their name already says they are credentials. */
  named: string[];
  /** The forms of the URL to write as `maskUrl` gives it. */
  urls: string[];
}

/** Every value of the connection a server could repeat back. */
function secretsOf(target: ConnectTarget): Secrets {
  const secrets: Secrets = { values: [], named: [], urls: [] };
  if (target.kind === 'stdio') {
    secrets.values.push(...Object.values(target.env));
    return secrets;
  }
  for (const value of Object.values(target.headers)) {
    secrets.values.push(value);
    // `Bearer <token>`: the token alone is what an error message repeats. A value of three parts or more
    // (`Token token="…"`, `Digest …`) is masked whole only; its pieces are not looked for.
    const [scheme, credentials, ...rest] = value.trim().split(/\s+/);
    if (credentials === undefined || rest.length > 0) continue;
    secrets.values.push(credentials);
    if (scheme?.toLowerCase() !== 'basic') continue;
    const pair = Buffer.from(credentials, 'base64').toString('utf8');
    const colon = pair.indexOf(':');
    if (colon < 0) continue;
    secrets.values.push(pair, pair.slice(0, colon));
    secrets.named.push(pair.slice(colon + 1));
  }
  let url: URL;
  try {
    url = new URL(target.url);
  } catch {
    return secrets; // not a URL: options.ts refuses those before a target exists
  }
  secrets.values.push(url.username, decoded(url.username));
  secrets.named.push(url.password, decoded(url.password));
  for (const [name, value] of rawQuery(url.search)) {
    if (SECRET_QUERY.has(decoded(name).toLowerCase()))
      secrets.named.push(value, decoded(value.replaceAll('+', ' ')));
  }
  for (const [name, value] of url.searchParams)
    if (SECRET_QUERY.has(name.toLowerCase())) secrets.named.push(value);
  secrets.urls.push(target.url, url.href, url.href.replace(/\/$/, ''));
  return secrets;
}

/**
 * `secrets` are searched for from 8 characters on, `named` whatever their length. `url`: every form in `raw` is
 * written as `masked`, before any value is replaced.
 */
export function createRedactor(
  secrets: Iterable<string>,
  opts: { named?: Iterable<string>; url?: { raw: Iterable<string>; masked: string } } = {},
): Redactor {
  const forms = new Set<string>();
  const add = (secret: string) => {
    forms.add(secret);
    forms.add(encodeURIComponent(secret));
    forms.add(JSON.stringify(secret).slice(1, -1));
  };
  for (const secret of secrets) if (secret.length >= MIN_SECRET_LENGTH) add(secret);
  for (const secret of opts.named ?? []) if (secret !== '') add(secret);
  // Longest first, so a secret that contains another is replaced whole.
  const longestFirst = (items: Iterable<string>) =>
    [...new Set(items)].sort((a, b) => b.length - a.length);
  const ordered = longestFirst(forms);
  const urls = longestFirst(opts.url?.raw ?? []).filter((raw) => raw !== '');
  const text = (input: string): string =>
    ordered.reduce(
      (out, secret) => out.replaceAll(secret, MASK),
      urls.reduce((out, raw) => out.replaceAll(raw, opts.url!.masked), input),
    );
  const value = (input: unknown, depth = 0): unknown => {
    if (typeof input === 'string') return text(input);
    if (input === null || typeof input !== 'object') return input;
    if (depth >= MAX_DEPTH) return '[cut: too deep]';
    if (Array.isArray(input)) return input.map((item) => value(item, depth + 1));
    return Object.fromEntries(
      Object.entries(input).map(([k, v]) => [text(k), value(v, depth + 1)]),
    );
  };
  return { text, value: (input) => value(input) };
}

export function redactorFor(target: ConnectTarget): Redactor {
  const { values, named, urls } = secretsOf(target);
  return createRedactor(values, {
    named,
    ...(target.kind === 'stdio' ? {} : { url: { raw: urls, masked: maskUrl(target.url) } }),
  });
}

/** The connection as it may be written down: credential names masked, every other value through the redactor. */
export function describeTarget(target: ConnectTarget, redact: Redactor): Record<string, unknown> {
  const masked = (entries: Record<string, string>, secret: (name: string) => boolean) =>
    Object.fromEntries(
      Object.entries(entries).map(([name, value]) => [
        name,
        secret(name) ? MASK : redact.text(value),
      ]),
    );
  if (target.kind === 'stdio') {
    return {
      transport: 'stdio',
      command: redact.text(target.command),
      args: target.args.map(redact.text),
      env: masked(target.env, isSecretEnv),
      ...(target.cwd !== undefined ? { cwd: target.cwd } : {}),
    };
  }
  return {
    transport: target.kind,
    url: redact.text(maskUrl(target.url)),
    headers: masked(target.headers, isSecretHeader),
  };
}
