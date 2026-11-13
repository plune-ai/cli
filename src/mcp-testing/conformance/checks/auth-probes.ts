/**
 * The negative probes of the `oauth` suite that need no person and create nothing on the server: a client_id that does
 * not exist, and a redirect URI that is not registered. Each depends on a refusal, so each has a control, the real
 * client with its real redirect URI, that must not be refused: a server that refuses or shows a sign-in to everything
 * says nothing about the requirement.
 *
 * The client is the pre-registered one of `--config`; no client is registered for a probe. The other redirect URI is on
 * an `.invalid` host and no answer is followed, so nothing is ever asked of a host that is not the server's.
 */

import { randomBytes } from 'node:crypto';
import type { CheckOutcome } from '../outcome.js';
import {
  asMetadata,
  credentialRefusal,
  inconclusive,
  isHttpUrl,
  isMeta,
  isOutcome,
  lostStatus,
  needsAuth,
  needsInput,
  prerequisite,
  requestToken,
  transient,
  type OauthContext,
} from './auth.js';
import {
  authorizationEndpoint,
  authorize,
  isEndpoint,
  said,
  type Authorize,
} from './auth-registration.js';
import type { ConformanceCheck } from './index.js';
import { failed, passed } from './wire.js';

/** A redirect URI no client registered: on a host that never resolves. */
const OTHER_REDIRECT = 'https://plune-conformance-other.invalid/callback';
const SEE_6749 = 'RFC 6749 section 4.1.2.1';

interface Target {
  clientId: string;
  redirectUri: string;
}

/** The pre-registered client and redirect URI of `--config`, or the outcome of a probe that cannot start without them. */
function targetOf(ctx: OauthContext): Target | CheckOutcome {
  const reg = ctx.config.registration;
  if (reg?.method !== 'preregistered' || reg.clientId === undefined)
    return needsInput(
      '--config needs registration with method "preregistered" and a clientId: the probe asks the authorization endpoint with a client that exists. No client is registered for it.',
    );
  if (ctx.config.redirectUri === undefined)
    return needsInput(
      '--config needs redirectUri, the one the client was registered with: it is the control of the probe.',
    );
  return { clientId: reg.clientId, redirectUri: ctx.config.redirectUri };
}
const isTarget = (v: Target | CheckOutcome): v is Target => 'clientId' in v;

/** The control: the real client with its real redirect URI. An outcome when it cannot serve as one. */
function controlOutcome(a: Authorize, what: string): CheckOutcome | undefined {
  if (a.kind === 'transient') return inconclusive(what, a.status, [a.detail]);
  if (a.kind === 'refused' || a.kind === 'unclear')
    return prerequisite(
      `${what} answered ${said(a)} to the pre-registered client with its own redirect URI: there is no control to compare with.`,
      [a.detail],
    );
  return undefined;
}

/** 4xx that say no: 408, 413, 414 and the like say the request was not taken, which is not an answer about the client. */
const REFUSING = new Set([400, 401, 403, 404]);
const isClientError = (status: number): boolean => status >= 400 && status < 500;
const notARefusal = (what: string, a: Authorize): CheckOutcome =>
  prerequisite(
    `${what} answered HTTP ${a.status}, which does not say the request was refused for what it carried (only 400, 401, 403, 404 or an error naming the client do).`,
    [a.detail],
  );

/** The first of the halves that failed, else the first that could not run, else all of them as one pass. */
function combine(halves: CheckOutcome[], skipped: string[]): CheckOutcome {
  const details = halves.flatMap((h) => h.details ?? []);
  const note = skipped.length === 0 ? '' : ` ${skipped.join(' ')}`;
  const bad = halves.filter((h) => h.state === 'failed');
  if (bad.length > 0)
    return {
      ...failed(
        bad.map((h) => h.actual).join(' '),
        bad
          .map((h) => ('fix' in h ? h.fix : undefined) ?? '')
          .join(' ')
          .trim(),
      ),
      details,
    };
  const open = halves.find((h) => h.state === 'could-not-run');
  if (open !== undefined) return { ...open, details };
  return { ...passed(`${halves.map((h) => h.actual).join(' ')}${note}`), details };
}

// ---- a client that does not exist ----

async function unknownAtAuthorize(
  ctx: OauthContext,
  endpoint: string,
  t: Target,
  made: string,
): Promise<CheckOutcome> {
  const real = await authorize(ctx, endpoint, t.clientId, t.redirectUri);
  const out = controlOutcome(real, 'The authorization endpoint');
  if (out !== undefined) return out;
  const a = await authorize(ctx, endpoint, made, t.redirectUri);
  const details = [real.detail, a.detail];
  if (a.toRedirectUri)
    return {
      ...failed(
        `The authorization endpoint redirected a client_id that does not exist to the redirect URI (${a.kind === 'accepted' ? 'with no error' : `with error ${said(a)}`}).`,
        `Do not redirect when the client_id is not valid (${SEE_6749}): answer with an error to the resource owner, not to the redirect URI.`,
      ),
      details,
    };
  if (a.kind === 'transient')
    return { ...inconclusive('The authorization endpoint (a made-up client)', a.status, details) };
  if (a.kind !== 'refused' && isClientError(a.status) && !REFUSING.has(a.status))
    return { ...notARefusal('The authorization endpoint (a made-up client)', a), details };
  if (a.kind === 'refused' || REFUSING.has(a.status))
    return {
      ...passed(
        `The authorization endpoint refused a client_id that does not exist (${said(a)}), and did not refuse the real client.`,
      ),
      details,
    };
  return {
    ...needsInput(
      `The authorization endpoint answered a client_id that does not exist as it answered the real one (HTTP ${a.status}, a sign-in or a redirect elsewhere): it cannot be told whether it is refused.`,
    ),
    details,
  };
}

const NOT_ASKED = 'The token endpoint was not asked';

async function unknownAtToken(ctx: OauthContext, made: string): Promise<CheckOutcome | string> {
  const reg = ctx.config.registration;
  const secretName = reg?.clientSecretEnv;
  const secret = secretName === undefined ? undefined : ctx.env[secretName];
  if (
    ctx.config.auth !== 'client-credentials' ||
    reg?.clientId === undefined ||
    secret === undefined ||
    secret === ''
  )
    return `${NOT_ASKED}: it needs auth "client-credentials" and a client secret (clientSecretEnv naming a variable that is set) in --config for the control.`;
  const m = await asMetadata(ctx);
  if (!isMeta(m)) return `${NOT_ASKED}: the authorization server metadata could not be read.`;
  const endpoint = m.doc['token_endpoint'];
  if (typeof endpoint !== 'string' || !isHttpUrl(endpoint))
    return `${NOT_ASKED}: the metadata has no token_endpoint that is an http(s) URL.`;
  const refusal = credentialRefusal(ctx, endpoint);
  if (refusal !== undefined) return `${NOT_ASKED}: ${refusal}`;
  const resource = ctx.config.resource ?? ctx.url;
  const real = await requestToken(ctx, endpoint, reg.clientId, secret, resource);
  if ('error' in real) {
    if (transient(real.status))
      return lostStatus('The token endpoint (the control)', real.error, [real.detail]);
    return prerequisite(
      `The token endpoint refused the pre-registered client (${real.error}): there is no control to compare with.`,
      [real.detail],
    );
  }
  // The made-up client gets a made-up secret, never the real one.
  const t = await requestToken(ctx, endpoint, made, randomBytes(12).toString('hex'), resource);
  const details = [real.detail, t.detail];
  if ('token' in t)
    return {
      ...failed(
        'The token endpoint issued an access token to a client_id that does not exist.',
        `Refuse a client that is not known with invalid_client (RFC 6749 section 5.2).`,
      ),
      details,
    };
  if (transient(t.status))
    return lostStatus('The token endpoint (a made-up client)', t.error, details);
  if (t.status === 400 || t.status === 401)
    return {
      ...passed(
        `The token endpoint refused a client_id that does not exist (${t.error}), and issued a token to the real client.`,
      ),
      details,
    };
  return {
    ...prerequisite(
      `The token endpoint answered a client_id that does not exist with ${t.error}, which is not a refusal of a client (RFC 6749 section 5.2 uses 400 or 401).`,
      details,
    ),
  };
}

const invalidClient: ConformanceCheck = async (c) => {
  const ctx = c.oauth!;
  const p = await needsAuth(ctx);
  if (isOutcome(p)) return p;
  const t = targetOf(ctx);
  if (!isTarget(t)) return t;
  const e = await authorizationEndpoint(ctx);
  if (!isEndpoint(e)) return e;
  const made = `plune-conformance-unknown-client-${randomBytes(6).toString('hex')}`;
  const halves = [await unknownAtAuthorize(ctx, e.endpoint, t, made)];
  const skipped: string[] = [];
  const token = await unknownAtToken(ctx, made);
  if (typeof token === 'string') skipped.push(token);
  else halves.push(token);
  return combine(halves, skipped);
};

// ---- a redirect URI that is not registered ----

const redirectMismatch: ConformanceCheck = async (c) => {
  const ctx = c.oauth!;
  const p = await needsAuth(ctx);
  if (isOutcome(p)) return p;
  const t = targetOf(ctx);
  if (!isTarget(t)) return t;
  const e = await authorizationEndpoint(ctx);
  if (!isEndpoint(e)) return e;
  const real = await authorize(ctx, e.endpoint, t.clientId, t.redirectUri);
  const out = controlOutcome(real, 'The authorization endpoint');
  if (out !== undefined) return out;
  const a = await authorize(ctx, e.endpoint, t.clientId, OTHER_REDIRECT);
  const details = [real.detail, a.detail];
  if (a.toRedirectUri)
    return {
      ...failed(
        `The authorization endpoint redirected to ${OTHER_REDIRECT}, a redirect URI the client did not register (${a.kind === 'accepted' ? 'with no error' : `with error ${said(a)}`}).`,
        `Do not redirect to a redirect URI that does not match a registered one, with a code or with an error (${SEE_6749}); compare it exactly with the registered values.`,
      ),
      details,
    };
  if (a.kind === 'transient')
    return inconclusive(
      'The authorization endpoint (an unregistered redirect URI)',
      a.status,
      details,
    );
  if (isClientError(a.status) && a.kind !== 'refused' && !REFUSING.has(a.status))
    return {
      ...notARefusal('The authorization endpoint (an unregistered redirect URI)', a),
      details,
    };
  if (isClientError(a.status))
    return {
      ...passed(
        `The authorization endpoint refused a redirect URI the client did not register without redirecting to it (${said(a)}), and did not refuse the registered one.`,
      ),
      details,
    };
  return {
    ...needsInput(
      `The authorization endpoint answered an unregistered redirect URI as it answered the registered one (HTTP ${a.status}, a sign-in or a redirect elsewhere that is not to it): it cannot be told whether it is checked.`,
    ),
    details,
  };
};

export const AUTH_PROBES: Record<string, ConformanceCheck> = {
  'oauth-neg-invalid-client': invalidClient,
  'oauth-neg-authorize-redirect-mismatch': redirectMismatch,
};
