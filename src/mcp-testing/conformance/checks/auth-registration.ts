/**
 * The registration and token checks of the `oauth` suite: a pre-registered client at the authorization endpoint, a
 * client made by dynamic registration (RFC 7591) and removed again (RFC 7592), a redirect over http that must not be
 * registered, a client_id that is a URL, and the shape of the token response.
 *
 * Dynamic registration makes a record on the authorization server, which is not ours: it runs only when `--config`
 * says `registration.allowClientCreation`, only against an origin `--allow-origin` named, and the client it made is
 * deleted afterwards when the server gave the means. A client that stays is named in the result, with its client_id (not
 * a secret). What the server issues (`client_secret`, `registration_access_token`, an access token) goes into the set
 * of secrets before anything is written.
 */

import { ConnectError } from '../../connect/session.js';
import type { CheckOutcome } from '../outcome.js';
import type { Exchange } from '../raw-http.js';
import {
  asMetadata,
  blockedNote,
  allowed,
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
  send,
  transient,
  type Meta,
  type OauthContext,
} from './auth.js';
import type { RegistrationMethod } from './auth-config.js';
import type { ConformanceCheck } from './index.js';
import { failed, isObject, passed } from './wire.js';

const DEFAULT_REDIRECT = 'http://127.0.0.1:8765/callback';
/** A redirect over http to a name that is not loopback: the fault of the negative probe. */
const HTTP_REDIRECT = 'http://plune-conformance.invalid/callback';

const notApplicable = (actual: string): CheckOutcome => ({
  state: 'not-applicable',
  reason: 'not-offered',
  actual,
});

/** The registration of `--config` when it is of `method`; else the outcome of a check that is not for it. */
function registrationOf(ctx: OauthContext, method: RegistrationMethod) {
  const reg = ctx.config.registration;
  if (reg === undefined)
    return needsInput(`--config needs "registration" with method "${method}" for this check.`);
  if (reg.method !== method)
    return notApplicable(`--config names the ${reg.method} method; this check is for ${method}.`);
  return reg;
}
const isReg = (
  v: ReturnType<typeof registrationOf>,
): v is NonNullable<OauthContext['config']['registration']> => 'method' in v && !('state' in v);

// ---- the authorization endpoint, asked with a client_id only ----

type Authorize =
  | { kind: 'accepted'; status: number; detail: Exchange }
  | { kind: 'errored'; status: number; error: string | undefined; detail: Exchange }
  | { kind: 'page'; status: number; detail: Exchange }
  | { kind: 'transient'; status: number; detail: Exchange };

/**
 * One authorization request with `clientId`, to the endpoint of the metadata. Only the client_id, the redirect URI and
 * a PKCE challenge go: no secret. A redirect is read, never followed. `accepted`: a redirect with no error; `errored`:
 * an error in the redirect or a 4xx; `page`: a 2xx (a sign-in page cannot be told from an error page).
 */
async function authorize(
  ctx: OauthContext,
  endpoint: string,
  clientId: string,
  redirectUri: string,
): Promise<Authorize> {
  const url = new URL(endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', 'plune-conformance');
  url.searchParams.set('code_challenge', 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('resource', ctx.config.resource ?? ctx.url);
  const { res, detail } = await send(ctx, url.href, {
    method: 'GET',
    headers: [['Accept', 'text/html, application/json']],
  });
  const d = detail();
  const { status } = res;
  if (
    transient(status) &&
    !(status >= 300 && status < 400 && res.headers.some(([n]) => n.toLowerCase() === 'location'))
  )
    return { kind: 'transient', status, detail: d };
  if (status >= 300 && status < 400) {
    const location = res.headers.find(([n]) => n.toLowerCase() === 'location')?.[1] ?? '';
    let target: URL;
    try {
      target = new URL(location, url);
    } catch {
      return { kind: 'errored', status, error: undefined, detail: d };
    }
    const error =
      target.searchParams.get('error') ?? new URLSearchParams(target.hash.slice(1)).get('error');
    return error === null
      ? { kind: 'accepted', status, detail: d }
      : { kind: 'errored', status, error, detail: d };
  }
  if (status >= 200 && status < 300) return { kind: 'page', status, detail: d };
  let error: string | undefined;
  try {
    const doc: unknown = JSON.parse(res.body);
    if (isObject(doc) && typeof doc['error'] === 'string') error = doc['error'].slice(0, 60);
  } catch {
    error = undefined;
  }
  return { kind: 'errored', status, error, detail: d };
}

/** What the client of a server's authorization endpoint is told that names the client as the fault. */
const CLIENT_REFUSED = new Set(['invalid_client', 'unauthorized_client']);

interface Endpoint {
  meta: Meta;
  endpoint: string;
}

/** The metadata and its authorization endpoint, or the outcome of a check that cannot start from them. */
async function authorizationEndpoint(ctx: OauthContext): Promise<Endpoint | CheckOutcome> {
  const m = await asMetadata(ctx);
  if (!isMeta(m)) return m;
  const endpoint = m.doc['authorization_endpoint'];
  if (typeof endpoint !== 'string')
    return prerequisite('The authorization server metadata has no authorization_endpoint.', [
      m.detail,
    ]);
  if (!isHttpUrl(endpoint))
    return prerequisite(
      'The authorization_endpoint of the metadata is not an absolute http(s) URL.',
      [m.detail],
    );
  if (!allowed(ctx, endpoint))
    return needsInput(`The authorization endpoint ${blockedNote(endpoint)}`);
  return { meta: m, endpoint };
}
const isEndpoint = (v: Endpoint | CheckOutcome): v is Endpoint => 'endpoint' in v;

const prereg: ConformanceCheck = async (c) => {
  const ctx = c.oauth!;
  const p = await needsAuth(ctx);
  if (isOutcome(p)) return p;
  const reg = registrationOf(ctx, 'preregistered');
  if (!isReg(reg)) return reg;
  if (reg.clientId === undefined)
    return needsInput('--config needs registration.clientId for a pre-registered client.');
  if (ctx.config.redirectUri === undefined)
    return needsInput(
      '--config needs redirectUri: the client is asked for at the authorization endpoint with it.',
    );
  const e = await authorizationEndpoint(ctx);
  if (!isEndpoint(e)) return e;
  const a = await authorize(ctx, e.endpoint, reg.clientId, ctx.config.redirectUri);
  const details = [a.detail];
  if (a.kind === 'transient') return inconclusive('The authorization endpoint', a.status, details);
  if (a.kind === 'accepted')
    return {
      ...passed(
        `The client_id was accepted: the authorization endpoint answered HTTP ${a.status} with a redirect that carries no error.`,
      ),
      details,
    };
  if (a.kind === 'page')
    return {
      ...needsInput(
        `The authorization endpoint answered HTTP ${a.status} with a page: a sign-in cannot be told from an error here, so the client was not judged.`,
      ),
      details,
    };
  if (a.error !== undefined && CLIENT_REFUSED.has(a.error))
    return {
      ...failed(
        `The authorization endpoint refused the pre-registered client (${a.error}, HTTP ${a.status}).`,
        'Accept the client_id that was registered for this client, with its redirect URI.',
      ),
      details,
    };
  return {
    ...prerequisite(
      `The authorization endpoint answered HTTP ${a.status}${a.error === undefined ? '' : ` (${a.error})`}, which does not say whether the client is known.`,
    ),
    details,
  };
};

// ---- dynamic registration ----

interface Removal {
  clientId: string;
  removed: boolean;
  /** One sentence: what became of the client. */
  note: string;
  details: Exchange[];
}

/** The client a registration made, deleted when the server gave the means (RFC 7592 section 2.3). */
async function remove(
  ctx: OauthContext,
  made: Record<string, unknown>,
  clientId: string,
): Promise<Removal> {
  const remains = (why: string, details: Exchange[] = []): Removal => ({
    clientId,
    removed: false,
    note: `Client ${clientId} remains on the authorization server: ${why}.`,
    details,
  });
  const uri = made['registration_client_uri'];
  const token = made['registration_access_token'];
  if (typeof uri !== 'string' || typeof token !== 'string')
    return remains(
      'the server returned no registration_client_uri and registration_access_token to delete it with',
    );
  if (!isHttpUrl(uri)) return remains('its registration_client_uri is not a URL');
  const refusal = credentialRefusal(ctx, uri, 'registration access token');
  if (refusal !== undefined) return remains(`it was not deleted (${refusal})`);
  try {
    const { res, detail } = await send(ctx, uri, {
      method: 'DELETE',
      headers: [['Authorization', `Bearer ${token}`]],
    });
    const d = [detail()];
    if (res.status === 204 || res.status === 200)
      return {
        clientId,
        removed: true,
        note: `Client ${clientId} was removed again (DELETE answered HTTP ${res.status}).`,
        details: d,
      };
    return remains(
      `DELETE answered HTTP ${res.status}${res.status === 405 ? ' (the server does not support it)' : ''}`,
      d,
    );
  } catch (err) {
    if (!(err instanceof ConnectError)) throw err;
    return remains('DELETE could not be sent');
  }
}

type Registered =
  | { kind: 'created'; clientId: string; removal: Removal; detail: Exchange }
  | { kind: 'refused'; status: number; error: string | undefined; detail: Exchange }
  | { kind: 'no-client-id'; status: number; detail: Exchange }
  | { kind: 'needs-credential'; status: number; detail: Exchange }
  | { kind: 'transient'; status: number; detail: Exchange };

/** One registration with `redirectUri`; a client it makes is deleted before this returns. */
async function register(
  ctx: OauthContext,
  endpoint: string,
  redirectUri: string,
): Promise<Registered> {
  const body = {
    client_name: 'plune-conformance',
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    application_type: 'native',
  };
  const { res, detail } = await send(ctx, endpoint, {
    method: 'POST',
    headers: [
      ['Content-Type', 'application/json'],
      ['Accept', 'application/json'],
    ],
    body: JSON.stringify(body),
  });
  let doc: unknown;
  try {
    doc = JSON.parse(res.body);
  } catch {
    doc = undefined;
  }
  const made = isObject(doc) ? doc : {};
  // Before anything is written: what the server issued must not appear in the exchange.
  for (const k of ['client_secret', 'registration_access_token'])
    if (typeof made[k] === 'string' && made[k] !== '') ctx.secrets.add(made[k] as string);
  const d = detail();
  const { status } = res;
  if (status === 200 || status === 201) {
    const id = made['client_id'];
    if (typeof id !== 'string' || id === '') return { kind: 'no-client-id', status, detail: d };
    return { kind: 'created', clientId: id, removal: await remove(ctx, made, id), detail: d };
  }
  if (status === 401 || status === 403) return { kind: 'needs-credential', status, detail: d };
  if (transient(status)) return { kind: 'transient', status, detail: d };
  const error =
    isObject(doc) && typeof doc['error'] === 'string' ? doc['error'].slice(0, 60) : undefined;
  return { kind: 'refused', status, error, detail: d };
}

const registeredDetails = (r: Registered): Exchange[] => [
  r.detail,
  ...(r.kind === 'created' ? r.removal.details : []),
];

/** Where a dynamic registration may be made, or the outcome of a check that cannot make one. */
async function registrationEndpoint(
  ctx: OauthContext,
): Promise<{ endpoint: string; redirect: string } | CheckOutcome> {
  const p = await needsAuth(ctx);
  if (isOutcome(p)) return p;
  const reg = registrationOf(ctx, 'dcr');
  if (!isReg(reg)) return reg;
  const m = await asMetadata(ctx);
  if (!isMeta(m)) return m;
  const endpoint = m.doc['registration_endpoint'];
  if (endpoint === undefined)
    return { ...notApplicable('The metadata has no registration_endpoint.'), details: [m.detail] };
  if (typeof endpoint !== 'string' || !isHttpUrl(endpoint))
    return prerequisite(
      'The registration_endpoint of the metadata is not an absolute http(s) URL.',
      [m.detail],
    );
  if (reg.allowClientCreation !== true)
    return needsInput(
      'Dynamic registration makes a client on the authorization server, and the client may stay there. Set "allowClientCreation": true in registration of --config to allow it. No request was sent.',
    );
  const refusal = credentialRefusal(ctx, endpoint, 'registration request');
  if (refusal !== undefined)
    return needsInput(`${refusal} No request was sent to the registration endpoint.`);
  return { endpoint, redirect: ctx.config.redirectUri ?? DEFAULT_REDIRECT };
}
const isTarget = (
  v: { endpoint: string; redirect: string } | CheckOutcome,
): v is { endpoint: string; redirect: string } => 'endpoint' in v;

/** The registration that works, once per run: both dcr checks start from it. */
const control = (
  ctx: OauthContext,
  target: { endpoint: string; redirect: string },
): Promise<Registered> =>
  ctx.memo('oauth dcr control', () => register(ctx, target.endpoint, target.redirect));

/** The outcome for an answer that is not a created client, or undefined for a created one. */
function notCreated(r: Registered, what: string): CheckOutcome | undefined {
  const details = [r.detail];
  switch (r.kind) {
    case 'created':
      return undefined;
    case 'transient':
      return inconclusive(what, r.status, details);
    case 'needs-credential':
      return {
        ...needsInput(
          `${what} got HTTP ${r.status}: registration needs a credential this run does not have.`,
        ),
        details,
      };
    case 'no-client-id':
      return {
        ...failed(
          `${what} got HTTP ${r.status} without a client_id.`,
          'Answer a registration with 201 and the client_id (RFC 7591 section 3.2.1).',
        ),
        details,
      };
    case 'refused':
      return {
        ...failed(
          `${what} was refused (HTTP ${r.status}${r.error === undefined ? '' : `, ${r.error}`}).`,
          'Accept a registration with a native application_type and a loopback redirect URI (RFC 7591).',
        ),
        details,
      };
  }
}

const dcr: ConformanceCheck = async (c) => {
  const ctx = c.oauth!;
  const t = await registrationEndpoint(ctx);
  if (!isTarget(t)) return t;
  const r = await control(ctx, t);
  const bad = notCreated(r, 'A registration with a correct body');
  if (bad !== undefined) return bad;
  if (r.kind !== 'created') return bad!;
  return {
    ...passed(`A client was registered (HTTP 201). ${r.removal.note}`),
    details: registeredDetails(r),
  };
};

const dcrHttpRedirectProbe: ConformanceCheck = async (c) => {
  const ctx = c.oauth!;
  const t = await registrationEndpoint(ctx);
  if (!isTarget(t)) return t;
  const ok = await control(ctx, t);
  if (ok.kind !== 'created') {
    if (ok.kind === 'transient')
      return inconclusive('The control registration (a loopback redirect)', ok.status, [ok.detail]);
    if (ok.kind === 'needs-credential')
      return {
        ...needsInput(
          `The control registration got HTTP ${ok.status}: registration needs a credential this run does not have.`,
        ),
        details: [ok.detail],
      };
    return {
      ...prerequisite(
        'The control registration with a loopback redirect URI did not make a client: a refusal of the http redirect would prove nothing.',
        [ok.detail],
      ),
    };
  }
  const r = await register(ctx, t.endpoint, HTTP_REDIRECT);
  const details = [ok.detail, ...ok.removal.details, ...registeredDetails(r)];
  if (r.kind === 'created')
    return {
      ...failed(
        `A client with the redirect URI ${HTTP_REDIRECT} was registered (HTTP 201). ${r.removal.note}`,
        'Refuse a redirect URI that is http and not on localhost (all redirect URIs MUST be localhost or https).',
      ),
      details,
    };
  if (r.kind === 'refused')
    return {
      ...passed(
        `The redirect URI ${HTTP_REDIRECT} was refused (HTTP ${r.status}${r.error === undefined ? '' : `, ${r.error}`}); the registration with a loopback redirect was accepted.`,
      ),
      details,
    };
  if (r.kind === 'transient')
    return inconclusive('The registration with an http redirect', r.status, details);
  if (r.kind === 'needs-credential')
    return {
      ...needsInput(
        `The registration with an http redirect got HTTP ${r.status}: it needs a credential this run does not have.`,
      ),
      details,
    };
  return {
    ...prerequisite(
      `The registration with an http redirect got HTTP ${r.status} without a client_id.`,
      details,
    ),
  };
};

/** The probe, and the client its control made when that one could not be removed: it is named whatever the verdict. */
const dcrHttpRedirect: ConformanceCheck = async (c) => {
  const outcome = await dcrHttpRedirectProbe(c);
  const ctx = c.oauth!;
  const t = await registrationEndpoint(ctx);
  if (!isTarget(t)) return outcome;
  const ok = await control(ctx, t);
  if (ok.kind !== 'created' || ok.removal.removed || outcome.actual === undefined) return outcome;
  return { ...outcome, actual: `${outcome.actual} ${ok.removal.note}` };
};

// ---- Client ID Metadata Documents ----

const cimd: ConformanceCheck = async (c) => {
  const ctx = c.oauth!;
  const p = await needsAuth(ctx);
  if (isOutcome(p)) return p;
  const reg = registrationOf(ctx, 'cimd');
  if (!isReg(reg)) return reg;
  const e = await authorizationEndpoint(ctx);
  if (!isEndpoint(e)) return e;
  if (e.meta.doc['client_id_metadata_document_supported'] !== true)
    return {
      ...notApplicable(
        'The metadata does not advertise client_id_metadata_document_supported: oauth-as-cimd-advertised says so.',
      ),
      details: [e.meta.detail],
    };
  if (reg.clientIdMetadataUrl === undefined)
    return needsInput(
      '--config needs registration.clientIdMetadataUrl: an https URL of a client metadata document that you host.',
    );
  if (ctx.config.redirectUri === undefined)
    return needsInput('--config needs redirectUri, one that the document lists.');
  const good = await authorize(ctx, e.endpoint, reg.clientIdMetadataUrl, ctx.config.redirectUri);
  if (good.kind === 'transient')
    return inconclusive('The authorization endpoint (the document)', good.status, [good.detail]);
  if (good.kind === 'page')
    return {
      ...needsInput(
        `The authorization endpoint answered HTTP ${good.status} with a page: a sign-in cannot be told from an error here.`,
      ),
      details: [good.detail],
    };
  if (good.kind === 'errored')
    return {
      ...failed(
        `The client_id URL of the document was refused (HTTP ${good.status}${good.error === undefined ? '' : `, ${good.error}`}).`,
        'Fetch the document at the client_id URL and accept the client it describes.',
      ),
      details: [good.detail],
    };
  const seen = `The document was accepted (HTTP ${good.status}, a redirect with no error).`;
  if (reg.clientIdMetadataMismatchUrl === undefined)
    return {
      ...needsInput(
        `${seen} The other half needs registration.clientIdMetadataMismatchUrl, a document whose client_id is not its own URL: it was not tried.`,
      ),
      details: [good.detail],
    };
  const bad = await authorize(
    ctx,
    e.endpoint,
    reg.clientIdMetadataMismatchUrl,
    ctx.config.redirectUri,
  );
  const details = [good.detail, bad.detail];
  if (bad.kind === 'transient')
    return inconclusive(
      'The authorization endpoint (the document that does not match)',
      bad.status,
      details,
    );
  if (bad.kind === 'page')
    return {
      ...needsInput(
        `${seen} The mismatched document got HTTP ${bad.status} with a page: not judged.`,
      ),
      details,
    };
  if (bad.kind === 'errored')
    return {
      ...passed(
        `${seen} The document whose client_id does not match its URL was refused (HTTP ${bad.status}${bad.error === undefined ? '' : `, ${bad.error}`}).`,
      ),
      details,
    };
  return {
    ...failed(
      `${seen} The document whose client_id does not match its URL was accepted too (HTTP ${bad.status}).`,
      'Refuse a client_id URL whose document names another client_id: it must match the URL exactly.',
    ),
    details,
  };
};

// ---- the token response ----

const tokenFormat: ConformanceCheck = async (c) => {
  const ctx = c.oauth!;
  const p = await needsAuth(ctx);
  if (isOutcome(p)) return p;
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
      'The token response is read from a client-credentials token: --config needs auth "client-credentials" and a preregistered client (clientId, and clientSecretEnv naming a variable that is set).',
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
  const t = await requestToken(ctx, endpoint, reg.clientId, secret, ctx.config.resource ?? ctx.url);
  const details = [t.detail];
  const doc = 'token' in t ? t.doc : t.doc;
  if ('error' in t && !(t.status === 200 && isObject(doc))) {
    if (transient(t.status)) return lostStatus('The token endpoint', t.error, details);
    if (t.status === 200)
      return {
        ...failed(
          'The token response is not a JSON object.',
          'Answer a token request with a JSON object (RFC 6749 section 5.1).',
        ),
        details,
      };
    return prerequisite(
      `The token endpoint refused the request (${t.error}): there is no token response to read.`,
      details,
    );
  }
  const d = doc as Record<string, unknown>;
  const problems: string[] = [];
  if (typeof d['access_token'] !== 'string' || d['access_token'] === '')
    problems.push('access_token is missing');
  const type = d['token_type'];
  if (typeof type !== 'string') problems.push('token_type is missing');
  else if (type.toLowerCase() !== 'bearer')
    problems.push(`token_type is ${JSON.stringify(type.slice(0, 40))}, not Bearer`);
  if (problems.length > 0)
    return {
      ...failed(
        `${problems.join('; ')}.`,
        'Answer a token request with access_token and token_type "Bearer" (RFC 6749 section 5.1).',
      ),
      details,
    };
  const note =
    d['expires_in'] === undefined ? ' expires_in is absent (RFC 6749 recommends it).' : '';
  return {
    ...passed(`The token response has access_token and token_type Bearer.${note}`),
    details,
  };
};

export const AUTH_REGISTRATION: Record<string, ConformanceCheck> = {
  'oauth-reg-prereg': prereg,
  'oauth-reg-dcr': dcr,
  'oauth-reg-dcr-http-redirect-rejected': dcrHttpRedirect,
  'oauth-reg-cimd': cimd,
  'oauth-token-format': tokenFormat,
};
