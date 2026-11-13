/**
 * The checks of the `oauth` suite that need an authorization code, run without a person. With `auth: "headless"` and a
 * pre-registered client, one authorization request is made; in a test environment that asks for no sign-in the answer
 * is a redirect to the redirect URI that carries a code. Where it shows a sign-in, the checks are could-not-run
 * (needs-input): never passed, never failed. No redirect is followed, and the browser is not opened.
 *
 * `oauth-authz-response-iss` reads the redirect and exchanges nothing. The two negative probes of the token endpoint
 * rest on a control: a correct exchange with a fresh code must succeed, else a refusal proves nothing. Every code and
 * token the server issues is masked before any output, and every token is reported as issued and not revoked.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ConnectError } from '../../connect/session.js';
import type { CheckOutcome } from '../outcome.js';
import type { Exchange } from '../raw-http.js';
import {
  collectIssued,
  credentialRefusal,
  inconclusive,
  isHttpUrl,
  isOutcome,
  needsAuth,
  needsInput,
  prerequisite,
  send,
  transient,
  type OauthContext,
} from './auth.js';
import {
  authorizationEndpoint,
  authorize,
  isEndpoint,
  said,
  type RedirectResponse,
} from './auth-registration.js';
import type { ConformanceCheck } from './index.js';
import { failed, isObject, passed } from './wire.js';

/** A redirect URI the client never registered, on a host that never resolves. */
const OTHER_REDIRECT = 'https://plune-conformance-other.invalid/callback';

const NOT_USED =
  ' An authorization code was issued and was not used (it is not exchanged and expires on the server).';
const tokensIssued = (n: number): string =>
  n === 0
    ? ''
    : n === 1
      ? ' A token was issued and was not revoked.'
      : ` ${n === 2 ? 'Two' : String(n)} tokens were issued and were not revoked.`;

interface Start {
  clientId: string;
  redirectUri: string;
  endpoint: string;
  issuer: string | undefined;
  advertisesIss: boolean;
  /** The token endpoint, when the metadata has one. */
  tokenEndpoint: string | undefined;
}

/** What a check that asks for a code needs: a headless run, a pre-registered client, a redirect URI, the endpoints. */
async function start(ctx: OauthContext): Promise<Start | CheckOutcome> {
  const reg = ctx.config.registration;
  if (ctx.config.auth !== 'headless')
    return needsInput(
      'An authorization code is asked for without a person only with --config auth "headless" (a test environment that asks for no sign-in). No request was sent.',
    );
  if (
    reg?.method !== 'preregistered' ||
    reg.clientId === undefined ||
    ctx.config.redirectUri === undefined
  )
    return needsInput(
      '--config needs a preregistered client (registration.clientId) and redirectUri: the authorization request is made with them. No request was sent.',
    );
  const e = await authorizationEndpoint(ctx);
  if (!isEndpoint(e)) return e;
  const token = e.meta.doc['token_endpoint'];
  return {
    clientId: reg.clientId,
    redirectUri: ctx.config.redirectUri,
    endpoint: e.endpoint,
    issuer: typeof e.meta.doc['issuer'] === 'string' ? e.meta.doc['issuer'] : undefined,
    advertisesIss: e.meta.doc['authorization_response_iss_parameter_supported'] === true,
    tokenEndpoint: typeof token === 'string' ? token : undefined,
  };
}

interface Code {
  response: RedirectResponse;
  verifier: string;
  details: Exchange[];
}

const equal = (a: string, b: string): boolean =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** One authorization request with a PKCE pair of its own; the redirect with a code, or the outcome that says why not. */
async function codeFor(ctx: OauthContext, s: Start): Promise<Code | CheckOutcome> {
  const verifier = randomBytes(32).toString('base64url');
  ctx.secrets.add(verifier);
  const state = randomBytes(12).toString('hex');
  const a = await authorize(ctx, s.endpoint, s.clientId, s.redirectUri, {
    codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
    state,
  });
  const details = [a.detail];
  if (a.kind === 'transient') return inconclusive('The authorization endpoint', a.status, details);
  if (a.kind === 'page')
    return {
      ...needsInput(
        'The authorization endpoint shows a sign-in (or a redirect elsewhere) instead of a redirect with a code: this check needs a signed-in authorization code, which a run without a person cannot get.',
      ),
      details,
    };
  if (a.kind !== 'accepted')
    return prerequisite(
      `The authorization endpoint answered ${said(a)} to the pre-registered client with its own redirect URI: there is no code to use.`,
      details,
    );
  if (a.response.state === null || !equal(a.response.state, state))
    return prerequisite(
      'The state of the authorization response is not the one that was sent: the response is not trusted, and nothing was judged.',
      details,
    );
  if (a.response.code === null || a.response.code === '')
    return prerequisite('The authorization response carries no code.', details);
  return { response: a.response, verifier, details };
}
const isCode = (v: Code | CheckOutcome): v is Code => 'response' in v;

// ---- iss ----

const issInResponse: ConformanceCheck = async (c) => {
  const ctx = c.oauth!;
  const p = await needsAuth(ctx);
  if (isOutcome(p)) return p;
  const s = await start(ctx);
  if (!('endpoint' in s)) return s;
  if (s.issuer === undefined)
    return prerequisite('The authorization server metadata has no issuer to compare iss with.');
  const code = await codeFor(ctx, s);
  if (!isCode(code)) return code;
  const { iss } = code.response;
  const details = code.details;
  const says = (what: string) => `${what}${NOT_USED}`;
  if (iss !== null && iss !== s.issuer)
    return {
      ...failed(
        says('The authorization response carries an iss that is not the issuer of the metadata.'),
        'Put the issuer identifier of the authorization server in iss, exactly as the metadata has it (RFC 9207 section 2).',
      ),
      details,
    };
  if (iss !== null && !s.advertisesIss)
    return {
      ...failed(
        says(
          'The authorization response carries iss, but the metadata does not set authorization_response_iss_parameter_supported to true.',
        ),
        'Authorization servers that include the iss parameter MUST advertise it with authorization_response_iss_parameter_supported: true.',
      ),
      details,
    };
  if (iss === null && s.advertisesIss)
    return {
      ...failed(
        says(
          'The metadata sets authorization_response_iss_parameter_supported to true, but the authorization response has no iss.',
        ),
        'Include iss in every authorization response, or stop advertising it.',
      ),
      details,
    };
  if (iss === null)
    return {
      state: 'not-applicable',
      reason: 'not-offered',
      actual: says(
        'The server sends no iss and does not advertise it: there is nothing to compare.',
      ),
      details,
    };
  return {
    ...passed(says('iss is the issuer of the metadata, and the metadata advertises it.')),
    details,
  };
};

// ---- the token endpoint ----

interface Exchanged {
  status: number;
  doc: Record<string, unknown> | undefined;
  token: string | undefined;
  detail: Exchange;
}

interface TokenSetup {
  endpoint: string;
  clientId: string;
  secret: string | undefined;
  resource: string;
}

function tokenSetup(ctx: OauthContext, s: Start): TokenSetup | CheckOutcome {
  if (s.tokenEndpoint === undefined)
    return prerequisite('The authorization server metadata has no token_endpoint.');
  if (!isHttpUrl(s.tokenEndpoint))
    return prerequisite('The token_endpoint of the metadata is not an absolute http(s) URL.');
  const refusal = credentialRefusal(ctx, s.tokenEndpoint, 'authorization code');
  if (refusal !== undefined)
    return needsInput(`${refusal} No request was sent to the token endpoint.`);
  const name = ctx.config.registration?.clientSecretEnv;
  const secret = name === undefined ? undefined : ctx.env[name];
  if (name !== undefined && (secret === undefined || secret === ''))
    return needsInput(
      `The environment variable ${name} (clientSecretEnv) is not set. No request was sent.`,
    );
  return {
    endpoint: s.tokenEndpoint,
    clientId: s.clientId,
    secret,
    resource: ctx.config.resource ?? ctx.url,
  };
}

/** One authorization-code exchange. A public client sends its client_id; a client with a secret, Basic. */
async function exchange(
  ctx: OauthContext,
  t: TokenSetup,
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<Exchanged> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    resource: t.resource,
  });
  const headers: [string, string][] = [
    ['Content-Type', 'application/x-www-form-urlencoded'],
    ['Accept', 'application/json'],
  ];
  if (t.secret === undefined) form.set('client_id', t.clientId);
  else {
    ctx.secrets.add(t.secret);
    const basic = Buffer.from(
      `${encodeURIComponent(t.clientId)}:${encodeURIComponent(t.secret)}`,
    ).toString('base64');
    ctx.secrets.add(basic);
    headers.push(['Authorization', `Basic ${basic}`]);
  }
  const { res, detail } = await send(ctx, t.endpoint, {
    method: 'POST',
    headers,
    body: form.toString(),
  });
  let doc: unknown;
  try {
    doc = JSON.parse(res.body);
  } catch {
    doc = undefined;
  }
  // Before anything is written down: the tokens of the answer.
  collectIssued(ctx, doc);
  const token =
    isObject(doc) && typeof doc['access_token'] === 'string' && doc['access_token'] !== ''
      ? doc['access_token']
      : undefined;
  return { status: res.status, doc: isObject(doc) ? doc : undefined, token, detail: detail() };
}

type Control = { ok: true; details: Exchange[] } | { ok: false; outcome: CheckOutcome };

/** The correct exchange both probes rest on, made once per run. */
function control(ctx: OauthContext, s: Start, t: TokenSetup): Promise<Control> {
  return ctx.memo('oauth headless control', async (): Promise<Control> => {
    const code = await codeFor(ctx, s);
    if (!isCode(code)) return { ok: false, outcome: code };
    const x = await exchange(ctx, t, code.response.code!, code.verifier, s.redirectUri);
    const details = [...code.details, x.detail];
    if (transient(x.status))
      return {
        ok: false,
        outcome: inconclusive('The token endpoint (the control exchange)', x.status, details),
      };
    if (x.token === undefined)
      return {
        ok: false,
        outcome: prerequisite(
          `The token endpoint did not issue a token for a correct exchange (HTTP ${x.status}): a refusal of a wrong one would prove nothing.`,
          details,
        ),
      };
    return { ok: true, details };
  });
}

interface Probe {
  s: Start;
  t: TokenSetup;
  ctl: Extract<Control, { ok: true }>;
}

async function probeSetup(ctx: OauthContext): Promise<Probe | CheckOutcome> {
  const p = await needsAuth(ctx);
  if (isOutcome(p)) return p;
  const s = await start(ctx);
  if (!('endpoint' in s)) return s;
  const t = tokenSetup(ctx, s);
  if (!('resource' in t)) return t;
  const ctl = await control(ctx, s, t);
  if (!ctl.ok) return ctl.outcome;
  return { s, t, ctl };
}

/** A probe: a fresh code, exchanged with one thing changed. A connection that fails after the control says so. */
async function probeExchange(
  ctx: OauthContext,
  pr: Probe,
  change: (verifier: string) => { verifier: string; redirectUri: string },
): Promise<{ x: Exchanged; details: Exchange[] } | CheckOutcome> {
  try {
    const code = await codeFor(ctx, pr.s);
    if (!isCode(code)) return { ...code, actual: `${code.actual ?? ''}${tokensIssued(1)}` };
    const use = change(code.verifier);
    // A verifier made for the probe is as secret as the one of the request: masked before the exchange is written.
    ctx.secrets.add(use.verifier);
    const x = await exchange(ctx, pr.t, code.response.code!, use.verifier, use.redirectUri);
    return { x, details: [...pr.ctl.details, ...code.details, x.detail] };
  } catch (err) {
    if (!(err instanceof ConnectError)) throw err;
    return {
      state: 'could-not-run',
      reason: err.kind === 'timeout' ? 'timeout' : 'transport-error',
      actual: `The probe could not be completed: ${err.kind === 'timeout' ? 'no answer in time' : 'the connection failed'}.${tokensIssued(1)}`,
      details: pr.ctl.details,
    };
  }
}
const isProbed = (
  v: { x: Exchanged; details: Exchange[] } | CheckOutcome,
): v is { x: Exchanged; details: Exchange[] } => 'x' in v;

const wrongVerifier: ConformanceCheck = async (c) => {
  const ctx = c.oauth!;
  const pr = await probeSetup(ctx);
  if (!('ctl' in pr)) return pr;
  const r = await probeExchange(ctx, pr, () => ({
    verifier: randomBytes(32).toString('base64url'),
    redirectUri: pr.s.redirectUri,
  }));
  if (!isProbed(r)) return r;
  const { x, details } = r;
  if (x.token !== undefined)
    return {
      ...failed(
        `The token endpoint issued a token for a code exchanged with a code_verifier that does not match its challenge (HTTP ${x.status}).${tokensIssued(2)}`,
        'Check the code_verifier against the code_challenge of the authorization request and refuse a mismatch with invalid_grant (RFC 7636 section 4.6).',
      ),
      details,
    };
  if (transient(x.status))
    return {
      ...inconclusive('The token endpoint (the wrong verifier)', x.status, details),
      actual: `The token endpoint answered HTTP ${x.status}, which says nothing of the requirement.${tokensIssued(1)}`,
    };
  if (x.status === 400 || x.status === 401)
    return {
      ...passed(
        `A code exchanged with a code_verifier that does not match was refused (HTTP ${x.status}${typeof x.doc?.['error'] === 'string' ? `, ${x.doc['error'].slice(0, 60)}` : ''}), while the correct exchange gave a token.${tokensIssued(1)}`,
      ),
      details,
    };
  return {
    ...prerequisite(
      `The token endpoint answered HTTP ${x.status} to the wrong verifier, which is not a refusal of a grant.${tokensIssued(1)}`,
      details,
    ),
  };
};

const REDIRECT_NAMED = /redirect[_ ]?uri|redirection/i;

const tokenRedirectMismatch: ConformanceCheck = async (c) => {
  const ctx = c.oauth!;
  const pr = await probeSetup(ctx);
  if (!('ctl' in pr)) return pr;
  const r = await probeExchange(ctx, pr, (verifier) => ({ verifier, redirectUri: OTHER_REDIRECT }));
  if (!isProbed(r)) return r;
  const { x, details } = r;
  if (x.token !== undefined)
    return {
      ...failed(
        `The token endpoint issued a token for a code exchanged with a redirect_uri other than the one of the authorization request (HTTP ${x.status}).${tokensIssued(2)}`,
        'Compare the redirect_uri of the token request with the one of the authorization request and refuse a difference (RFC 6749 section 4.1.3).',
      ),
      details,
    };
  if (transient(x.status))
    return {
      ...inconclusive('The token endpoint (the other redirect_uri)', x.status, details),
      actual: `The token endpoint answered HTTP ${x.status}, which says nothing of the requirement.${tokensIssued(1)}`,
    };
  const description =
    typeof x.doc?.['error_description'] === 'string' ? x.doc['error_description'] : '';
  if ((x.status === 400 || x.status === 401) && REDIRECT_NAMED.test(description))
    return {
      ...passed(
        `A code exchanged with another redirect_uri was refused and the answer names the redirect_uri (HTTP ${x.status}).${tokensIssued(1)}`,
      ),
      details,
    };
  if (x.status === 400 || x.status === 401)
    return {
      ...prerequisite(
        `The token endpoint refused the code with a generic answer (HTTP ${x.status}${typeof x.doc?.['error'] === 'string' ? `, ${x.doc['error'].slice(0, 60)}` : ''}) that does not say the redirect_uri was the reason: it does not show that the redirect_uri was compared.${tokensIssued(1)}`,
        details,
      ),
    };
  return {
    ...prerequisite(
      `The token endpoint answered HTTP ${x.status} to the other redirect_uri, which is not a refusal of a grant.${tokensIssued(1)}`,
      details,
    ),
  };
};

export const AUTH_FLOW = {
  'oauth-authz-response-iss': issInResponse,
  'oauth-neg-pkce-wrong-verifier': wrongVerifier,
  'oauth-neg-token-redirect-mismatch': tokenRedirectMismatch,
} satisfies Record<string, ConformanceCheck>;
