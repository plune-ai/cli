import type { ConnectTarget } from './options.js';

// The one place secrets are masked. Everything the connection core writes (the frame journal, error messages, the
// stderr tail) and everything a command prints passes through a Redactor. A frame that goes to the server is never
// touched: only the copy that is written down is masked.
//
// Two rules:
// - by name: a header or variable whose name says it is a credential is shown as ***, whatever its length;
// - by value: every value given for the connection (headers, --env, secrets in the URL) is replaced wherever it
//   appears, because a server may repeat a token in its own error. A value under 8 characters is not searched for
//   (--env DEBUG=1 must not turn every 1 into ***); only its name can hide it.

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

/** Every value of the connection a server could repeat back. */
function secretsOf(target: ConnectTarget): string[] {
  const values: string[] = [];
  if (target.kind === 'stdio') {
    values.push(...Object.values(target.env));
  } else {
    for (const value of Object.values(target.headers)) {
      values.push(value);
      // `Bearer <token>`: the token alone is what an error message repeats.
      const credentials = /^\S+\s+(\S+)$/.exec(value)?.[1];
      if (credentials !== undefined) values.push(credentials);
    }
    try {
      const url = new URL(target.url);
      values.push(decodeURIComponent(url.username), decodeURIComponent(url.password));
      for (const [name, value] of url.searchParams)
        if (SECRET_QUERY.has(name.toLowerCase())) values.push(value);
    } catch {
      // not a URL: options.ts refuses those before a target exists
    }
  }
  return values;
}

export function createRedactor(secrets: Iterable<string>): Redactor {
  const forms = new Set<string>();
  for (const secret of secrets) {
    if (secret.length < MIN_SECRET_LENGTH) continue;
    forms.add(secret);
    forms.add(encodeURIComponent(secret));
    forms.add(JSON.stringify(secret).slice(1, -1));
  }
  // Longest first, so a secret that contains another is replaced whole.
  const ordered = [...forms].sort((a, b) => b.length - a.length);
  const text = (input: string): string =>
    ordered.reduce((out, secret) => out.replaceAll(secret, MASK), input);
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

export const redactorFor = (target: ConnectTarget): Redactor => createRedactor(secretsOf(target));

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
