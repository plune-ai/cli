/**
 * `--config <file>` of the oauth suite: how the run may sign in, in JSON. A secret is never a value here, only the
 * name of the environment variable that holds it (`clientSecretEnv`); a file with a key that names a secret is refused,
 * so a secret is not written into a file by habit. A file named `.yaml` or `.yml` is read as YAML (the same rules), with
 * no anchor, alias, custom tag or merge key and a size limit checked before parsing; any other file is JSON.
 */

import { readFileSync } from 'node:fs';
import { isScalar, parseDocument, visit } from 'yaml';
import { UsageError } from '../../connect/options.js';

export type RegistrationMethod = 'preregistered' | 'dcr' | 'cimd';
export type AuthMode = 'interactive' | 'headless' | 'client-credentials';

export interface OauthConfig {
  /** The revisions to run, when `--protocol-version` is auto. */
  protocolVersions?: string[];
  registration?: {
    method: RegistrationMethod;
    clientId?: string;
    /** The name of the environment variable that holds the client secret. */
    clientSecretEnv?: string;
    clientIdMetadataUrl?: string;
    /** The URL of a document whose client_id is not its own URL: the server must refuse it. */
    clientIdMetadataMismatchUrl?: string;
    /**
     * Dynamic registration creates a client on the authorization server, and the client may stay there. Off unless true.
     */
    allowClientCreation?: boolean;
  };
  /** Several methods written as a list: the suite runs once for each (and for each revision). */
  registrations?: NonNullable<OauthConfig['registration']>[];
  scopes?: string[];
  /** The scopes to ask for the token that must be refused for lack of scope; `scopes` stays the full set. */
  narrowScopes?: string[];
  redirectUri?: string;
  auth?: AuthMode;
  /** The canonical URI of the server: what the metadata's `resource` is compared with, and what the token is for. */
  resource?: string;
}

const TOP = new Set([
  'protocolVersions',
  'registration',
  'scopes',
  'narrowScopes',
  'redirectUri',
  'auth',
  'resource',
]);
const REGISTRATION = new Set([
  'method',
  'clientId',
  'clientSecretEnv',
  'clientIdMetadataUrl',
  'clientIdMetadataMismatchUrl',
  'allowClientCreation',
]);
const METHODS: readonly RegistrationMethod[] = ['preregistered', 'dcr', 'cimd'];
const MODES: readonly AuthMode[] = ['interactive', 'headless', 'client-credentials'];
/** A key that says it holds a secret, other than the name of the variable that does. */
const SECRET_KEY = /secret|token|password|passwd|key|code|verifier/i;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

function strings(flag: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || v === ''))
    throw new UsageError(`--config: "${flag}" must be a list of non-empty strings.`);
  return value as string[];
}

/** A list of scopes: each one word, since a scope with white space is two scopes written as one. */
function scopeList(flag: string, value: unknown): string[] {
  const list = strings(flag, value);
  const bad = list.find((s) => /\s/.test(s));
  if (bad !== undefined)
    throw new UsageError(
      `--config: "${flag}" has ${JSON.stringify(bad)}, which holds white space: list each scope as its own string.`,
    );
  return list;
}

function text(flag: string, value: unknown): string {
  if (typeof value !== 'string' || value === '')
    throw new UsageError(`--config: "${flag}" must be a non-empty string.`);
  return value;
}

type Registration = NonNullable<OauthConfig['registration']>;

/** One registration object; `label` is how its keys are named in a usage error (`registration`, `registration[1]`). */
function parseRegistration(value: unknown, label: string): Registration {
  if (!isObject(value)) throw new UsageError(`--config: "${label}" must be an object.`);
  for (const k of Object.keys(value)) {
    if (!REGISTRATION.has(k)) {
      const why = SECRET_KEY.test(k)
        ? ' (a secret is never written in the file: name the variable that holds it)'
        : '';
      throw new UsageError(`--config: unknown key "${label}.${k}"${why}.`);
    }
  }
  const method = text(`${label}.method`, value['method']);
  if (!(METHODS as readonly string[]).includes(method))
    throw new UsageError(`--config: "${label}.method" must be one of ${METHODS.join(', ')}.`);
  const reg: Registration = { method: method as RegistrationMethod };
  if (value['clientId'] !== undefined) reg.clientId = text(`${label}.clientId`, value['clientId']);
  if (value['clientIdMetadataUrl'] !== undefined)
    reg.clientIdMetadataUrl = text(`${label}.clientIdMetadataUrl`, value['clientIdMetadataUrl']);
  if (value['clientIdMetadataMismatchUrl'] !== undefined)
    reg.clientIdMetadataMismatchUrl = text(
      `${label}.clientIdMetadataMismatchUrl`,
      value['clientIdMetadataMismatchUrl'],
    );
  for (const k of ['clientIdMetadataUrl', 'clientIdMetadataMismatchUrl'] as const) {
    const u = reg[k];
    if (u === undefined) continue;
    let parsed: URL | undefined;
    try {
      parsed = new URL(u);
    } catch {
      parsed = undefined;
    }
    if (parsed === undefined || parsed.protocol !== 'https:' || parsed.pathname === '/')
      throw new UsageError(
        `--config: "${label}.${k}" must be an https URL with a path, such as https://example.com/client.json.`,
      );
  }
  if (value['allowClientCreation'] !== undefined) {
    if (typeof value['allowClientCreation'] !== 'boolean')
      throw new UsageError(`--config: "${label}.allowClientCreation" must be true or false.`);
    reg.allowClientCreation = value['allowClientCreation'];
  }
  if (value['clientSecretEnv'] !== undefined) {
    const name = text(`${label}.clientSecretEnv`, value['clientSecretEnv']);
    if (!ENV_NAME.test(name))
      throw new UsageError(
        `--config: "${label}.clientSecretEnv" is the NAME of an environment variable, not the secret.`,
      );
    reg.clientSecretEnv = name;
  }
  return reg;
}

/** The largest `--config` file read, in bytes, checked before anything is parsed. */
export const MAX_CONFIG_BYTES = 64 * 1024;

/** YAML as plain data: no anchor, alias, custom tag or merge key, one document, no repeated key. */
function readYaml(source: string): unknown {
  const parsed = parseDocument(source, { merge: false, schema: 'core', uniqueKeys: true });
  const first = parsed.errors[0];
  if (first !== undefined)
    throw new UsageError(`--config: the file is not valid YAML (${first.code}).`);
  // Walked before anything is turned into data, so an alias is never expanded.
  visit(parsed, {
    Alias() {
      throw new UsageError('--config: YAML aliases and anchors are not allowed.');
    },
    Node(_key, node) {
      if (node.anchor !== undefined)
        throw new UsageError('--config: YAML aliases and anchors are not allowed.');
      if (node.tag !== undefined)
        throw new UsageError(`--config: a YAML tag (${node.tag.slice(0, 40)}) is not allowed.`);
    },
    Pair(_key, pair) {
      if (isScalar(pair.key) && pair.key.value === '<<')
        throw new UsageError('--config: a YAML merge key (<<) is not allowed.');
    },
  });
  return parsed.toJS();
}

/**
 * The configuration in `source` (a file's text, JSON unless `format` says YAML); a UsageError for anything that is
 * not one.
 */
export function parseOauthConfig(source: string, format: 'json' | 'yaml' = 'json'): OauthConfig {
  if (Buffer.byteLength(source) > MAX_CONFIG_BYTES)
    throw new UsageError(
      `--config: the file is too large (more than ${MAX_CONFIG_BYTES / 1024} KiB).`,
    );
  let doc: unknown;
  if (format === 'yaml') doc = readYaml(source);
  else {
    try {
      doc = JSON.parse(source);
    } catch {
      throw new UsageError(
        '--config: the file is not JSON (a file named .yaml or .yml is read as YAML).',
      );
    }
  }
  if (!isObject(doc)) throw new UsageError('--config: the file must hold an object.');
  const config: OauthConfig = {};
  for (const [key, value] of Object.entries(doc)) {
    if (!TOP.has(key)) {
      const why = SECRET_KEY.test(key)
        ? ' (a secret is never written in the file: name the variable that holds it)'
        : '';
      throw new UsageError(`--config: unknown key "${key}"${why}.`);
    }
    if (key === 'protocolVersions') config.protocolVersions = strings(key, value);
    else if (key === 'scopes') config.scopes = scopeList(key, value);
    else if (key === 'narrowScopes') {
      const list = scopeList(key, value);
      if (list.length === 0 || new Set(list).size !== list.length)
        throw new UsageError(
          '--config: "narrowScopes" must be a non-empty list of scopes with no duplicates.',
        );
      config.narrowScopes = list;
    } else if (key === 'redirectUri') config.redirectUri = text(key, value);
    else if (key === 'resource') {
      const uri = text(key, value);
      try {
        new URL(uri);
      } catch {
        throw new UsageError('--config: "resource" must be an absolute URL.');
      }
      config.resource = uri;
    } else if (key === 'auth') {
      const mode = text(key, value);
      if (!(MODES as readonly string[]).includes(mode))
        throw new UsageError(`--config: "auth" must be one of ${MODES.join(', ')}.`);
      config.auth = mode as AuthMode;
    } else if (key === 'registration') {
      if (Array.isArray(value)) {
        // Several methods: one run of the suite for each, in the order written.
        if (value.length === 0)
          throw new UsageError('--config: "registration" must not be an empty list.');
        const list = value.map((v, n) => parseRegistration(v, `registration[${n}]`));
        const methods = list.map((r) => r.method);
        const twice = methods.find((m, n) => methods.indexOf(m) !== n);
        if (twice !== undefined)
          throw new UsageError(`--config: "registration" names the method "${twice}" twice.`);
        config.registrations = list;
      } else config.registration = parseRegistration(value, 'registration');
    }
  }
  if (config.registration !== undefined && config.registrations !== undefined)
    throw new UsageError('--config: "registration" is one object or a list, not both.');
  if (config.narrowScopes !== undefined && config.scopes !== undefined) {
    const full = config.scopes;
    const extra = config.narrowScopes.filter((s) => !full.includes(s));
    if (extra.length > 0)
      throw new UsageError(
        `--config: "narrowScopes" must be a subset of "scopes", and ${extra.map((s) => JSON.stringify(s)).join(', ')} ${extra.length === 1 ? 'is' : 'are'} not in "scopes".`,
      );
    if (config.narrowScopes.length === full.length)
      throw new UsageError('--config: "narrowScopes" must differ from "scopes".');
  }
  return config;
}

export function loadOauthConfig(path: string): OauthConfig {
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new UsageError(
      `--config: could not read ${path}${code === undefined ? '' : ` (${code})`}.`,
    );
  }
  return parseOauthConfig(source, /\.ya?ml$/i.test(path) ? 'yaml' : 'json');
}
