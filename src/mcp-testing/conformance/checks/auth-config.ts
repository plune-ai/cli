/**
 * `--config <file>` of the oauth suite: how the run may sign in, in JSON. A secret is never a value here, only the
 * name of the environment variable that holds it (`clientSecretEnv`); a file with a key that names a secret is refused,
 * so a secret is not written into a file by habit. YAML is not read yet.
 */

import { readFileSync } from 'node:fs';
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
  scopes?: string[];
  redirectUri?: string;
  auth?: AuthMode;
  /** The canonical URI of the server: what the metadata's `resource` is compared with, and what the token is for. */
  resource?: string;
}

const TOP = new Set([
  'protocolVersions',
  'registration',
  'scopes',
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

function text(flag: string, value: unknown): string {
  if (typeof value !== 'string' || value === '')
    throw new UsageError(`--config: "${flag}" must be a non-empty string.`);
  return value;
}

/** The configuration in `source` (a file's text); a UsageError for anything that is not one. */
export function parseOauthConfig(source: string): OauthConfig {
  let doc: unknown;
  try {
    doc = JSON.parse(source);
  } catch {
    throw new UsageError('--config: the file is not JSON (YAML is not read yet).');
  }
  if (!isObject(doc)) throw new UsageError('--config: the file must hold a JSON object.');
  const config: OauthConfig = {};
  for (const [key, value] of Object.entries(doc)) {
    if (!TOP.has(key)) {
      const why = SECRET_KEY.test(key)
        ? ' (a secret is never written in the file: name the variable that holds it)'
        : '';
      throw new UsageError(`--config: unknown key "${key}"${why}.`);
    }
    if (key === 'protocolVersions') config.protocolVersions = strings(key, value);
    else if (key === 'scopes') config.scopes = strings(key, value);
    else if (key === 'redirectUri') config.redirectUri = text(key, value);
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
      if (!isObject(value)) throw new UsageError('--config: "registration" must be an object.');
      for (const k of Object.keys(value)) {
        if (!REGISTRATION.has(k)) {
          const why = SECRET_KEY.test(k)
            ? ' (a secret is never written in the file: name the variable that holds it)'
            : '';
          throw new UsageError(`--config: unknown key "registration.${k}"${why}.`);
        }
      }
      const method = text('registration.method', value['method']);
      if (!(METHODS as readonly string[]).includes(method))
        throw new UsageError(
          `--config: "registration.method" must be one of ${METHODS.join(', ')}.`,
        );
      const reg: NonNullable<OauthConfig['registration']> = {
        method: method as RegistrationMethod,
      };
      if (value['clientId'] !== undefined)
        reg.clientId = text('registration.clientId', value['clientId']);
      if (value['clientIdMetadataUrl'] !== undefined)
        reg.clientIdMetadataUrl = text(
          'registration.clientIdMetadataUrl',
          value['clientIdMetadataUrl'],
        );
      if (value['clientIdMetadataMismatchUrl'] !== undefined)
        reg.clientIdMetadataMismatchUrl = text(
          'registration.clientIdMetadataMismatchUrl',
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
            `--config: "registration.${k}" must be an https URL with a path, such as https://example.com/client.json.`,
          );
      }
      if (value['allowClientCreation'] !== undefined) {
        if (typeof value['allowClientCreation'] !== 'boolean')
          throw new UsageError(
            '--config: "registration.allowClientCreation" must be true or false.',
          );
        reg.allowClientCreation = value['allowClientCreation'];
      }
      if (value['clientSecretEnv'] !== undefined) {
        const name = text('registration.clientSecretEnv', value['clientSecretEnv']);
        if (!ENV_NAME.test(name))
          throw new UsageError(
            '--config: "registration.clientSecretEnv" is the NAME of an environment variable, not the secret.',
          );
        reg.clientSecretEnv = name;
      }
      config.registration = reg;
    }
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
  return parseOauthConfig(source);
}
