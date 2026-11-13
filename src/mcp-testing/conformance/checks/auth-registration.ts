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

import { randomBytes } from 'node:crypto';
import { ConnectError } from '../../connect/session.js';
import type { CheckOutcome } from '../outcome.js';
import type { Exchange } from '../raw-http.js';
import {
  asMetadata,
  blockedNote,
  allowed,
  collectIssued,
  isLoopbackUrl,
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
const CLIENT_NAME = 'plune-conformance-test';
/** Said whenever a registration may have made a client that the report cannot name. */
const MAY_REMAIN = 'A client may have been created and could not be named.';
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

/** What the redirect to the redirect URI carried (in memory only: the code is masked in every output). */
export interface RedirectResponse {
  code: string | null;
  iss: string | null;
  state: string | null;
}

export type Authorize =
  | { kind: 'accepted'; status: number; detail: Exchange; response: RedirectResponse }
  /** The server refused the client itself: invalid_client, unauthorized_client, or an invalid_request that names it. */
  | { kind: 'refused'; status: number; error: string; detail: Exchange }
  /** An answer that says nothing certain of the client (403 with no code, access_denied, server_error...). */
  | { kind: 'unclear'; status: number; error: string | undefined; detail: Exchange }
  /** A page, or a redirect that is not to the redirect URI: a sign-in cannot be told from an error. */
  | { kind: 'page'; status: number; detail: Exchange }
  | { kind: 'transient'; status: number; detail: Exchange };

/** What the client of a server's authorization endpoint is told that names the client as the fault. */
const CLIENT_REFUSED = new Set(['invalid_client', 'unauthorized_client']);
const NAMES_CLIENT = /client_id|client id|client metadata|metadata|unknown client|invalid client/i;

function judged(
  status: number,
  error: string | null | undefined,
  description: string | null | undefined,
  detail: Exchange,
): Authorize {
  if (error === null || error === undefined)
    return { kind: 'unclear', status, error: undefined, detail };
  const refused =
    CLIENT_REFUSED.has(error) ||
    (error === 'invalid_request' && NAMES_CLIENT.test(description ?? ''));
  return refused
    ? { kind: 'refused', status, error: error.slice(0, 60), detail }
    : { kind: 'unclear', status, error: error.slice(0, 60), detail };
}

/** The query and fragment values of a Location that the server issued: they are masked in every exchange. */
const ISSUED_IN_REDIRECT = ['code', 'access_token', 'id_token', 'refresh_token', 'state'];
/** The `state` this suite sends: echoing it back is not an issue. */
const SENT_STATE = 'plune-conformance';
function collectRedirectIssued(
  ctx: OauthContext,
  location: string | undefined,
  base: URL,
  sentState: string,
): void {
  if (location === undefined) return;
  let target: URL;
  try {
    target = new URL(location, base);
  } catch {
    return;
  }
  for (const params of [target.searchParams, new URLSearchParams(target.hash.slice(1))])
    for (const key of ISSUED_IN_REDIRECT) {
      const value = params.get(key);
      if (value !== null && value.length >= 4 && value !== sentState) ctx.secrets.add(value);
    }
}

/** Whether a Location is the redirect URI: the same scheme, host and path (an origin is "null" for a custom scheme). */
function sameAddress(a: URL, b: URL): boolean {
  if (a.origin !== 'null' || b.origin !== 'null')
    return a.origin === b.origin && a.pathname === b.pathname;
  return a.protocol === b.protocol && a.host === b.host && a.pathname === b.pathname;
}

/**
 * One authorization request with `clientId`, to the endpoint of the metadata. Only the client_id, the redirect URI and
 * a PKCE challenge go: no secret. A redirect is read, never followed: one to the redirect URI with no error is
 * `accepted`; one to anywhere else is `page` (a sign-in).
 */
export async function authorize(
  ctx: OauthContext,
  endpoint: string,
  clientId: string,
  redirectUri: string,
  opts: { codeChallenge?: string; state?: string } = {},
): Promise<Authorize & { toRedirectUri: boolean }> {
  const state = opts.state ?? SENT_STATE;
  const url = new URL(endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set(
    'code_challenge',
    opts.codeChallenge ?? 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  );
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('resource', ctx.config.resource ?? ctx.url);
  const { res, detail } = await send(ctx, url.href, {
    method: 'GET',
    headers: [['Accept', 'text/html, application/json']],
  });
  const { status } = res;
  const location = res.headers.find(([n]) => n.toLowerCase() === 'location')?.[1];
  // Before the exchange is written down: what a redirect carries is issued by the server, and a code is as good as a token.
  collectRedirectIssued(ctx, location, url, state);
  const d = detail();
  if (transient(status) && !(status >= 300 && status < 400 && location !== undefined))
    return { kind: 'transient', status, detail: d, toRedirectUri: false };
  if (status >= 300 && status < 400) {
    let target: URL;
    try {
      target = new URL(location ?? '', url);
    } catch {
      return { kind: 'unclear', status, error: undefined, detail: d, toRedirectUri: false };
    }
    let expected: URL | undefined;
    try {
      expected = new URL(redirectUri);
    } catch {
      expected = undefined;
    }
    // Compared as URLs, by origin and path: a redirect URI that only appears in a parameter of another address is not it.
    const landed = expected !== undefined && sameAddress(target, expected);
    const fragment = new URLSearchParams(target.hash.slice(1));
    const error = target.searchParams.get('error') ?? fragment.get('error');
    if (error !== null)
      return {
        ...judged(
          status,
          error,
          target.searchParams.get('error_description') ?? fragment.get('error_description'),
          d,
        ),
        toRedirectUri: landed,
      };
    return landed
      ? {
          kind: 'accepted',
          status,
          detail: d,
          toRedirectUri: true,
          response: {
            code: target.searchParams.get('code'),
            iss: target.searchParams.get('iss'),
            state: target.searchParams.get('state'),
          },
        }
      : { kind: 'page', status, detail: d, toRedirectUri: false };
  }
  if (status >= 200 && status < 300)
    return { kind: 'page', status, detail: d, toRedirectUri: false };
  let error: string | undefined;
  let description: string | undefined;
  try {
    const doc: unknown = JSON.parse(res.body);
    if (isObject(doc)) {
      if (typeof doc['error'] === 'string') error = doc['error'];
      if (typeof doc['error_description'] === 'string') description = doc['error_description'];
    }
  } catch {
    error = undefined;
  }
  return { ...judged(status, error, description, d), toRedirectUri: false };
}

export const said = (a: { status: number; error?: string | undefined }): string =>
  `HTTP ${a.status}${a.error === undefined ? '' : `, ${a.error}`}`;

interface Endpoint {
  meta: Meta;
  endpoint: string;
}

/** The metadata and its authorization endpoint, or the outcome of a check that cannot start from them. */
export async function authorizationEndpoint(ctx: OauthContext): Promise<Endpoint | CheckOutcome> {
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
export const isEndpoint = (v: Endpoint | CheckOutcome): v is Endpoint => 'endpoint' in v;

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
  if (a.kind === 'refused')
    return {
      ...failed(
        `The authorization endpoint refused the pre-registered client (${said(a)}).`,
        'Accept the client_id that was registered for this client, with its redirect URI.',
      ),
      details,
    };
  if (a.kind === 'unclear')
    return {
      ...prerequisite(
        `The authorization endpoint answered ${said(a)}, which does not say whether the client is known.`,
      ),
      details,
    };
  // The client was not refused. That is a pass only if a client that does not exist is refused: else the endpoint
  // takes everything (every client is sent to a sign-in), and nothing was learned about this one.
  const made = `plune-conformance-no-such-client-${randomBytes(6).toString('hex')}`;
  const control = await authorize(ctx, e.endpoint, made, ctx.config.redirectUri);
  details.push(control.detail);
  if (control.kind === 'transient')
    return inconclusive('The authorization endpoint (a made-up client)', control.status, details);
  if (control.kind === 'refused')
    return {
      ...passed(
        `The client_id was not refused (${a.kind === 'accepted' ? 'a redirect to the redirect URI' : `HTTP ${a.status}, a sign-in`}), while a made-up client was (${said(control)}).`,
      ),
      details,
    };
  if (control.kind === 'unclear')
    return {
      ...prerequisite(
        `A made-up client_id got ${said(control)}, which is not a refusal of the client: the answer for the real one proves nothing.`,
      ),
      details,
    };
  return {
    ...needsInput(
      `The authorization endpoint treats a made-up client_id as it treats the pre-registered one (HTTP ${control.status}, ${control.kind === 'page' ? 'a sign-in' : 'a redirect to the redirect URI'}): it cannot be told whether the client is known.`,
    ),
    details,
  };
};

// ---- dynamic registration ----

interface Removal {
  removed: boolean;
  /** One sentence: what became of the client. */
  note: string;
  details: Exchange[];
}

/**
 * The client a registration made, deleted when the server gave the means (RFC 7592 section 2.3). The registration access
 * token goes only to the origin of the registration endpoint, whatever other origins are allowed. `clientId` is
 * undefined for a client the server made without naming it.
 */
async function remove(
  ctx: OauthContext,
  endpoint: string,
  made: Record<string, unknown>,
  clientId: string | undefined,
): Promise<Removal> {
  const remains = (why: string, details: Exchange[] = []): Removal => ({
    removed: false,
    note:
      clientId === undefined
        ? `${MAY_REMAIN} It was not deleted: ${why}.`
        : `Client ${clientId} remains on the authorization server: ${why}.`,
    details,
  });
  const uri = made['registration_client_uri'];
  const token = made['registration_access_token'];
  if (typeof uri !== 'string' || typeof token !== 'string')
    return remains(
      'the server returned no registration_client_uri and registration_access_token to delete it with',
    );
  if (!isHttpUrl(uri)) return remains('its registration_client_uri is not a URL');
  if (new URL(uri).origin !== new URL(endpoint).origin)
    return remains(
      'its registration_client_uri is on another origin than the registration endpoint, so the registration access token was not sent there',
    );
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
        removed: true,
        note:
          clientId === undefined
            ? `A client the server did not name was removed again (DELETE answered HTTP ${res.status}).`
            : `Client ${clientId} was removed again (DELETE answered HTTP ${res.status}).`,
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
  | { kind: 'created'; clientId: string; status: number; removal: Removal; detail: Exchange }
  /** A 2xx that names no client_id. The server may have made one: a deletion was tried when it gave the means. */
  | { kind: 'no-client-id'; status: number; removal: Removal; detail: Exchange }
  | { kind: 'refused'; status: number; error: string | undefined; detail: Exchange }
  | { kind: 'needs-credential'; status: number; detail: Exchange }
  /** 429, or 3xx or 5xx after the POST (`maybe`: the write may have happened). */
  | { kind: 'transient'; status: number; maybe: boolean; detail: Exchange }
  /** A 2xx whose body is larger than a reader takes: the client_id cannot be read. */
  | { kind: 'truncated'; status: number; detail: Exchange }
  /** No answer: a timeout or a lost connection after the POST was sent. */
  | { kind: 'lost'; why: string; reason: 'timeout' | 'transport-error' };

/** One registration with `redirectUri`; a client it makes is deleted before this returns. */
async function register(
  ctx: OauthContext,
  endpoint: string,
  redirectUri: string,
): Promise<Registered> {
  const body = {
    client_name: CLIENT_NAME,
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    application_type: 'native',
  };
  let sent: Awaited<ReturnType<typeof send>>;
  try {
    sent = await send(ctx, endpoint, {
      method: 'POST',
      headers: [
        ['Content-Type', 'application/json'],
        ['Accept', 'application/json'],
      ],
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (!(err instanceof ConnectError)) throw err;
    return err.kind === 'timeout'
      ? { kind: 'lost', why: 'it did not answer in time', reason: 'timeout' }
      : { kind: 'lost', why: 'the connection failed', reason: 'transport-error' };
  }
  const { res, detail } = sent;
  let doc: unknown;
  try {
    doc = res.ended ? JSON.parse(res.body) : undefined;
  } catch {
    doc = undefined;
  }
  const made = isObject(doc) ? doc : {};
  // Before anything is written: what the server issued must not appear in the exchange.
  collectIssued(ctx, doc);
  const d = detail();
  const { status } = res;
  if (status >= 200 && status < 300) {
    if (!res.ended) return { kind: 'truncated', status, detail: d };
    const id = made['client_id'];
    if (typeof id === 'string' && id !== '')
      return {
        kind: 'created',
        clientId: id,
        status,
        removal: await remove(ctx, endpoint, made, id),
        detail: d,
      };
    return {
      kind: 'no-client-id',
      status,
      removal: await remove(ctx, endpoint, made, undefined),
      detail: d,
    };
  }
  if (status === 401 || status === 403) return { kind: 'needs-credential', status, detail: d };
  if (transient(status)) return { kind: 'transient', status, maybe: status !== 429, detail: d };
  const error =
    isObject(doc) && typeof doc['error'] === 'string' ? doc['error'].slice(0, 60) : undefined;
  return { kind: 'refused', status, error, detail: d };
}

const registeredDetails = (r: Registered): Exchange[] =>
  r.kind === 'lost'
    ? []
    : [r.detail, ...(r.kind === 'created' || r.kind === 'no-client-id' ? r.removal.details : [])];

/** The sentence a registration leaves behind when a client may exist: removed, named, or not nameable. */
function trace(r: Registered): string {
  if (r.kind === 'created' || r.kind === 'no-client-id') return r.removal.note;
  if (r.kind === 'truncated' || r.kind === 'lost') return MAY_REMAIN;
  if (r.kind === 'transient' && r.maybe) return MAY_REMAIN;
  return '';
}

const withTrace = (o: CheckOutcome, r: Registered, extra = ''): CheckOutcome => {
  const note = [trace(r), extra].filter((s) => s !== '').join(' ');
  return note === '' || o.actual === undefined ? o : { ...o, actual: `${o.actual} ${note}` };
};

/** A loopback redirect URI for the control: that of `--config` when it is one, else the default, and it says so. */
function controlRedirect(ctx: OauthContext): { uri: string; note: string } {
  const given = ctx.config.redirectUri;
  if (given === undefined) return { uri: DEFAULT_REDIRECT, note: '' };
  if (isHttpUrl(given) && isLoopbackUrl(given)) return { uri: given, note: '' };
  return {
    uri: DEFAULT_REDIRECT,
    note: `The redirectUri of --config is not a loopback URL, so the registration used ${DEFAULT_REDIRECT}.`,
  };
}

interface Target {
  endpoint: string;
  redirect: string;
  note: string;
}

/** Where a dynamic registration may be made, or the outcome of a check that cannot make one. */
async function registrationEndpoint(ctx: OauthContext): Promise<Target | CheckOutcome> {
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
  const { uri, note } = controlRedirect(ctx);
  return { endpoint, redirect: uri, note };
}
const isTarget = (v: Target | CheckOutcome): v is Target => 'endpoint' in v;

/** The registration that works, once per run: both dcr checks start from it. */
const control = (ctx: OauthContext, target: Target): Promise<Registered> =>
  ctx.memo('oauth dcr control', () => register(ctx, target.endpoint, target.redirect));

/**
 * The outcome for an answer that is not a created client, with what became of a client that may exist. Undefined for a
 * created one.
 */
function notCreated(r: Registered, what: string, extra = ''): CheckOutcome | undefined {
  const details = registeredDetails(r);
  const out = (o: CheckOutcome): CheckOutcome => withTrace({ ...o, details }, r, extra);
  switch (r.kind) {
    case 'created':
      return undefined;
    case 'lost':
      return out({
        state: 'could-not-run',
        reason: r.reason,
        actual: `${what} got no answer (${r.why}).`,
      });
    case 'truncated':
      return out({
        state: 'could-not-run',
        reason: 'transport-error',
        actual: `${what} got HTTP ${r.status} with a body larger than this check reads: nothing can be said of the requirement.`,
      });
    case 'transient':
      return out(inconclusive(what, r.status, details));
    case 'needs-credential':
      return out(
        needsInput(
          `${what} got HTTP ${r.status}: registration needs a credential this run does not have.`,
        ),
      );
    case 'no-client-id':
      return out(
        failed(
          `${what} got HTTP ${r.status} without a client_id.`,
          'Answer a registration with 201 and the client_id (RFC 7591 section 3.2.1).',
        ),
      );
    case 'refused':
      return out(
        failed(
          `${what} was refused (HTTP ${r.status}${r.error === undefined ? '' : `, ${r.error}`}).`,
          'Accept a registration with a native application_type and a loopback redirect URI (RFC 7591).',
        ),
      );
  }
}

const dcr: ConformanceCheck = async (c) => {
  const ctx = c.oauth!;
  const t = await registrationEndpoint(ctx);
  if (!isTarget(t)) return t;
  const r = await control(ctx, t);
  const bad = notCreated(r, 'A registration with a correct body', t.note);
  if (bad !== undefined) return bad;
  if (r.kind !== 'created') return bad!;
  return {
    ...passed(
      `A client was registered (HTTP ${r.status}). ${r.removal.note}${t.note === '' ? '' : ` ${t.note}`}`,
    ),
    details: registeredDetails(r),
  };
};

const dcrHttpRedirectProbe: ConformanceCheck = async (c) => {
  const ctx = c.oauth!;
  const t = await registrationEndpoint(ctx);
  if (!isTarget(t)) return t;
  const ok = await control(ctx, t);
  if (ok.kind !== 'created') {
    // The control did not make a client the probe could be read against; what it may have left is named all the same.
    const why = notCreated(ok, 'The control registration (a loopback redirect)', t.note);
    if (ok.kind === 'refused' || ok.kind === 'no-client-id')
      return {
        ...prerequisite(
          `The control registration with a loopback redirect URI did not make a client: a refusal of the http redirect would prove nothing. ${trace(ok)}`.trim(),
          registeredDetails(ok),
        ),
      };
    return why!;
  }
  const r = await register(ctx, t.endpoint, HTTP_REDIRECT);
  const details = [...registeredDetails(ok), ...registeredDetails(r)];
  const extra = t.note;
  if (r.kind === 'created')
    return withTrace(
      {
        ...failed(
          `A client with the redirect URI ${HTTP_REDIRECT} was registered (HTTP ${r.status}).`,
          'Refuse a redirect URI that is http and not on localhost (all redirect URIs MUST be localhost or https).',
        ),
        details,
      },
      r,
      extra,
    );
  if (r.kind === 'refused')
    return withTrace(
      {
        ...passed(
          `The redirect URI ${HTTP_REDIRECT} was refused (HTTP ${r.status}${r.error === undefined ? '' : `, ${r.error}`}); the registration with a loopback redirect was accepted.`,
        ),
        details,
      },
      r,
      extra,
    );
  if (r.kind === 'no-client-id')
    return withTrace(
      {
        ...prerequisite(
          `The registration with an http redirect got HTTP ${r.status} without a client_id.`,
        ),
        details,
      },
      r,
      extra,
    );
  const bad = notCreated(r, 'The registration with an http redirect', extra);
  return bad === undefined ? prerequisite('unreachable') : { ...bad, details };
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
        `The authorization endpoint answered HTTP ${good.status} with a page or a redirect to a sign-in, and gave no sign that it read the document: it was not judged.`,
      ),
      details: [good.detail],
    };
  if (good.kind === 'unclear')
    return {
      ...prerequisite(
        `The authorization endpoint answered ${said(good)}, which does not say that the document was refused.`,
      ),
      details: [good.detail],
    };
  if (good.kind === 'refused')
    return {
      ...failed(
        `The client_id URL of the document was refused (${said(good)}).`,
        'Fetch the document at the client_id URL and accept the client it describes.',
      ),
      details: [good.detail],
    };
  const seen = `The document was accepted (HTTP ${good.status}, a redirect to the redirect URI with no error).`;
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
        `${seen} The mismatched document got HTTP ${bad.status} with a page or a redirect to a sign-in, and no sign that it was read: not judged.`,
      ),
      details,
    };
  if (bad.kind === 'unclear')
    return {
      ...prerequisite(
        `${seen} The mismatched document got ${said(bad)}, which does not say that the document was refused.`,
      ),
      details,
    };
  if (bad.kind === 'refused')
    return {
      ...passed(
        `${seen} The document whose client_id does not match its URL was refused (${said(bad)}).`,
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
