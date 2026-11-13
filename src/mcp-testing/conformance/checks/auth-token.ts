/**
 * The unattended sign-in of the `oauth` suite: a token from the client-credentials grant, and the one request the suite
 * already uses to tell a protected server from an open one, sent with it. No person, no browser.
 *
 * The client secret goes only to a token endpoint on an origin `--allow-origin` named (https, or http on a loopback
 * name); the token goes only to the MCP endpoint. Nothing is retried: the check sends one request to the token
 * endpoint and one to the MCP endpoint. The token is masked in every output before it is written, and is not revoked.
 */

import { ConnectError } from '../../connect/session.js';
import {
  asMetadata,
  challengesOf,
  credentialRefusal,
  inconclusive,
  isHttpUrl,
  isMeta,
  isOutcome,
  lostStatus,
  needsAuth,
  needsInput,
  prerequisite,
  probe,
  requestToken,
  transient,
  type OauthContext,
} from './auth.js';
import type { CheckOutcome } from '../outcome.js';
import type { ConformanceCheck } from './index.js';
import { failed, isObject, passed } from './wire.js';

/** Said by every result after a token was issued. */
const ISSUED = ' A token was issued and was not revoked.';

/** The `aud` of a JWT access token, as a list; undefined when the token is not a JWT or has no aud (it is not verified). */
function audiencesOf(token: string): string[] | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
    if (!isObject(payload)) return undefined;
    const aud = payload['aud'];
    if (typeof aud === 'string') return [aud];
    if (Array.isArray(aud) && aud.every((a) => typeof a === 'string')) return aud as string[];
  } catch {
    return undefined;
  }
  return undefined;
}

export interface SignIn {
  endpoint: string;
  clientId: string;
  secret: string;
  resource: string;
}

/**
 * What a check that asks for a token needs: the client-credentials grant in `--config`, a secret in the environment, and
 * a token endpoint on an origin `--allow-origin` named. The outcome of a check that cannot start, else what it needs.
 */
export async function signIn(ctx: OauthContext): Promise<SignIn | CheckOutcome> {
  const reg = ctx.config.registration;
  const secretName = reg?.clientSecretEnv;
  const secret = secretName === undefined ? undefined : ctx.env[secretName];
  if (
    ctx.config.auth !== 'client-credentials' ||
    reg?.method !== 'preregistered' ||
    reg.clientId === undefined ||
    secret === undefined ||
    secret === ''
  )
    return needsInput(
      'A token is obtained with --config that has auth "client-credentials" and a preregistered client (clientId, and clientSecretEnv naming a variable that is set). No request was sent.',
    );
  const m = await asMetadata(ctx);
  if (!isMeta(m)) return m;
  const endpoint = m.doc['token_endpoint'];
  if (typeof endpoint !== 'string')
    return prerequisite('The authorization server metadata has no token_endpoint.', [m.detail]);
  if (!isHttpUrl(endpoint))
    return prerequisite('The token_endpoint of the metadata is not an absolute http(s) URL.', [
      m.detail,
    ]);
  const refusal = credentialRefusal(ctx, endpoint);
  if (refusal !== undefined)
    return needsInput(`${refusal} No request was sent to the token endpoint.`);
  return { endpoint, clientId: reg.clientId, secret, resource: ctx.config.resource ?? ctx.url };
}
export const isSignIn = (v: SignIn | CheckOutcome): v is SignIn => 'endpoint' in v;

const tokenWorks: ConformanceCheck = async (c) => {
  const ctx = c.oauth!;
  const p = await needsAuth(ctx);
  if (isOutcome(p)) return p;
  const s = await signIn(ctx);
  if (!isSignIn(s)) return s;
  const { endpoint, resource } = s;
  const t = await requestToken(ctx, endpoint, s.clientId, s.secret, resource);
  if ('error' in t) {
    const what = 'The token endpoint';
    if (t.status === 200)
      return prerequisite(
        `${what} answered HTTP 200 with no access_token: there is no token to try.`,
        [t.detail],
      );
    return transient(t.status)
      ? lostStatus(what, t.error, [t.detail])
      : prerequisite(
          `${what} refused the pre-registered client (${t.error}): there is no token to try.`,
          [t.detail],
        );
  }
  // From here a token exists: every answer says so.
  const issued = (o: CheckOutcome): CheckOutcome => ({
    ...o,
    actual: `${o.actual ?? ''}${ISSUED}`,
  });
  const type = t.doc['token_type'];
  if (typeof type !== 'string' || type.toLowerCase() !== 'bearer')
    return issued(
      prerequisite(
        `The token type ${typeof type === 'string' ? JSON.stringify(type.slice(0, 40)) : type === undefined ? 'is missing' : 'is not a string'}, which this check does not support (it sends a Bearer token): the token was not sent.`,
        [t.detail],
      ),
    );
  let sent: Awaited<ReturnType<typeof probe>>;
  try {
    sent = await probe(ctx, t.token);
  } catch (err) {
    if (!(err instanceof ConnectError)) throw err;
    return issued({
      state: 'could-not-run',
      reason: err.kind === 'timeout' ? 'timeout' : 'transport-error',
      actual: `The MCP endpoint, asked with the token, ${err.kind === 'timeout' ? 'did not answer in time' : 'could not be reached'}: nothing can be said of the requirement.`,
      details: [t.detail],
    });
  }
  const details = [t.detail, sent.detail];
  if (transient(sent.status))
    return issued(inconclusive('The MCP endpoint, asked with the token,', sent.status, details));
  if (sent.status >= 200 && sent.status < 300)
    return {
      ...passed(
        `A token issued for ${resource} by the token endpoint was accepted (HTTP ${sent.status}).${ISSUED}`,
      ),
      details,
    };
  if (sent.status === 401) {
    const scope = challengesOf(sent.challenge ?? '').some(
      (ch) => ch.params['error'] === 'insufficient_scope',
    );
    if (scope)
      return issued(
        prerequisite(
          'The MCP endpoint answered HTTP 401 with error="insufficient_scope": the token may lack a scope.',
          details,
        ),
      );
    // A 401 is a failure only if the server cannot be right: the token must be shown to be for this resource.
    if (!(audiencesOf(t.token) ?? []).includes(resource))
      return issued(
        prerequisite(
          `The MCP endpoint answered HTTP 401, but the audience of the issued token is not shown to be ${resource} (an opaque token, or a JWT whose aud does not hold it): the server may be right.`,
          details,
        ),
      );
    return {
      ...failed(
        `The MCP endpoint answered HTTP 401 to a JWT whose aud holds ${resource}, issued by its authorization server with token type Bearer.${ISSUED}`,
        'Accept an access token issued for this server by its authorization server (RFC 8707 audience, OAuth 2.1 section 5.2).',
      ),
      details,
    };
  }
  return issued(
    prerequisite(
      `The MCP endpoint answered HTTP ${sent.status} to the token, which is not a refusal of the token itself (it may lack a scope the endpoint needs).`,
      details,
    ),
  );
};

export const AUTH_TOKEN = {
  'oauth-e2e-token-works': tokenWorks,
} satisfies Record<string, ConformanceCheck>;
