/**
 * The checks of the `oauth` suite that read what a server over HTTP says about its authorization: the 401 and its
 * challenge, the protected resource metadata, the authorization server's metadata, and what the server does with a
 * token that is not for it. Every request goes through `send`, which adds no `--header` value (a run of this suite
 * asks as a client with no credentials would) and never leaves the origin of the server, unless `--allow-origin` names
 * another. A secret (a token, a client secret) lives in `OauthContext.secrets`, and every exchange that is written down
 * is masked with it.
 */

import { randomBytes } from 'node:crypto';
import { ConnectError } from '../../connect/session.js';
import { createRedactor } from '../../connect/redact.js';
import type { Era } from '../catalog.js';
import type { CheckOutcome } from '../outcome.js';
import {
  exchange,
  header,
  rawRequest,
  type Exchange,
  type HeaderList,
  type RawResponse,
} from '../raw-http.js';
import type { OauthConfig } from './auth-config.js';
import type { ConformanceCheck } from './index.js';
import { failed, isObject, passed } from './wire.js';
import { modernMeta } from './modern/meta.js';

export interface OauthContext {
  /** The MCP endpoint under test. */
  url: string;
  /** The revision this run is for. */
  revision: string;
  era: Era;
  config: OauthConfig;
  /** Origins other than the server's that may be asked (`--allow-origin`), as `scheme://host:port`. */
  allowOrigins: ReadonlySet<string>;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** The plain fetch: never the session's, which adds the `--header` values. */
  fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
  /** Values that must not appear in anything written: a token once it is known, the client secret. */
  secrets: Set<string>;
  memo<T>(key: string, make: () => Promise<T>): Promise<T>;
}

const SERVER_OTHER_RESOURCE = 'https://other-resource.plune-conformance.invalid';
const needsInput = (actual: string): CheckOutcome => ({
  state: 'could-not-run',
  reason: 'needs-input',
  actual,
});
const prerequisite = (actual: string, details?: Exchange[]): CheckOutcome => ({
  state: 'could-not-run',
  reason: 'prerequisite-failed',
  actual,
  ...(details === undefined ? {} : { details }),
});

const originOf = (url: string): string => new URL(url).origin;
/** The origin is the server's or one `--allow-origin` named. */
export const allowed = (ctx: OauthContext, url: string): boolean => {
  const origin = originOf(url);
  return origin === originOf(ctx.url) || ctx.allowOrigins.has(origin);
};

interface Sent {
  res: RawResponse;
  /** The exchange as it is written down, built when asked: a secret learned from the answer is masked too. */
  detail(): Exchange;
}

/** One request to `url` with no credentials of the run's own; the caller has checked `allowed`. */
export async function send(
  ctx: OauthContext,
  url: string,
  req: { method: string; headers?: HeaderList; body?: string },
): Promise<Sent> {
  const request = {
    method: req.method,
    headers: req.headers ?? [],
    ...(req.body === undefined ? {} : { body: req.body }),
  };
  const target = {
    url,
    fetch: ctx.fetch,
    headers: {},
    get redact() {
      return createRedactor(ctx.secrets, { named: ctx.secrets });
    },
  };
  const res = await rawRequest(target, request, { timeoutMs: ctx.timeoutMs, maxBytes: 256 * 1024 });
  return { res, detail: () => exchange(target, request, res) };
}

/** The body of an MCP request the way the revision starts: initialize, or server/discover from 2026-07-28. */
function mcpRequest(ctx: OauthContext): { headers: HeaderList; body: string } {
  const headers: HeaderList = [
    ['Content-Type', 'application/json'],
    ['Accept', 'application/json, text/event-stream'],
  ];
  if (ctx.era === 'modern') {
    headers.push(['MCP-Protocol-Version', ctx.revision]);
    return {
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'plune-conformance-oauth',
        method: 'server/discover',
        params: { _meta: modernMeta(ctx.revision) },
      }),
    };
  }
  return {
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'plune-conformance-oauth',
      method: 'initialize',
      params: {
        protocolVersion: ctx.revision,
        capabilities: {},
        clientInfo: { name: 'plune-conformance', version: '0' },
      },
    }),
  };
}

export interface Probed {
  status: number;
  /** The `WWW-Authenticate` header(s) as one text, undefined when absent. */
  challenge: string | undefined;
  detail: Exchange;
}

/** One request to the MCP endpoint, with `token` as the bearer when given. */
export async function probe(ctx: OauthContext, token?: string): Promise<Probed> {
  const { headers, body } = mcpRequest(ctx);
  if (token !== undefined) {
    ctx.secrets.add(token);
    headers.push(['Authorization', `Bearer ${token}`]);
  }
  const { res, detail } = await send(ctx, ctx.url, { method: 'POST', headers, body });
  return {
    status: res.status,
    challenge: header(res.headers, 'www-authenticate'),
    detail: detail(),
  };
}

/** The parameters of the Bearer challenge in a `WWW-Authenticate` value; undefined when there is no Bearer scheme. */
export function bearerParams(value: string | undefined): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const scheme = /(^|[\s,])Bearer(?=[\s,]|$)/i.exec(value);
  if (scheme === null) return undefined;
  const params: Record<string, string> = {};
  // ponytail: a challenge of another scheme after Bearer in the same value would add its parameters; one scheme is what a server sends.
  for (const m of value
    .slice(scheme.index + scheme[0].length)
    .matchAll(/([A-Za-z0-9_-]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^\s,]+)/g)) {
    const raw = m[2] ?? '';
    params[(m[1] ?? '').toLowerCase()] = raw.startsWith('"')
      ? raw.slice(1, -1).replace(/\\(.)/g, '$1')
      : raw;
  }
  return params;
}

/** The first probe, without a token: once per run. */
const unauthenticated = (ctx: OauthContext): Promise<Probed> =>
  ctx.memo('oauth probe', () => probe(ctx));

/** What the first probe says about the suite: the outcome every check but the first returns when it is not a 401. */
async function needsAuth(ctx: OauthContext): Promise<Probed | CheckOutcome> {
  const p = await unauthenticated(ctx);
  if (p.status === 401) return p;
  if (p.status >= 200 && p.status < 300)
    return {
      state: 'not-applicable',
      reason: 'no-auth',
      actual: `A request without a token got HTTP ${p.status}: the server is public.`,
      details: [p.detail],
    };
  return prerequisite(
    `A request without a token got HTTP ${p.status}, not 401: nothing of the authorization can be read.`,
    [p.detail],
  );
}

const isOutcome = (v: Probed | CheckOutcome): v is CheckOutcome => !('status' in v);

type Fetched =
  | { state: 'ok'; url: string; doc: Record<string, unknown>; detail: Exchange }
  | { state: 'blocked'; url: string }
  | { state: 'bad'; url: string; why: string; detail?: Exchange };

/** A JSON object from `url`, by GET, with no credentials; a foreign origin is not asked. */
async function getJson(ctx: OauthContext, url: string): Promise<Fetched> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { state: 'bad', url, why: 'it is not an absolute URL' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    return { state: 'bad', url, why: 'it is not an http(s) URL' };
  if (!allowed(ctx, url)) return { state: 'blocked', url };
  let sent: Sent;
  try {
    sent = await send(ctx, url, { method: 'GET', headers: [['Accept', 'application/json']] });
  } catch (err) {
    if (!(err instanceof ConnectError)) throw err;
    return {
      state: 'bad',
      url,
      why: err.kind === 'timeout' ? 'it did not answer in time' : 'it could not be reached',
    };
  }
  const detail = sent.detail();
  if (sent.res.status !== 200)
    return { state: 'bad', url, why: `it answered HTTP ${sent.res.status}`, detail };
  let doc: unknown;
  try {
    doc = JSON.parse(sent.res.body);
  } catch {
    return { state: 'bad', url, why: 'the answer is not JSON', detail };
  }
  if (!isObject(doc)) return { state: 'bad', url, why: 'the answer is not a JSON object', detail };
  return { state: 'ok', url, doc, detail };
}

interface Prm {
  /** The `resource_metadata` URL the challenge gave, when it gave one. */
  challengeUrl: string | undefined;
  fromChallenge: Fetched | undefined;
  wellKnown: Fetched[];
  /** The document in use: the challenge's, else the first well-known one that answered. */
  found: Extract<Fetched, { state: 'ok' }> | undefined;
}

const WK_PRM = '/.well-known/oauth-protected-resource';

/** The protected resource metadata, found the way the specification lists: the challenge's URL, else the well-known URIs. */
function discoverPrm(ctx: OauthContext, challenge: string | undefined): Promise<Prm> {
  return ctx.memo('oauth prm', async () => {
    const url = new URL(ctx.url);
    const challengeUrl = bearerParams(challenge)?.['resource_metadata'];
    const prm: Prm = { challengeUrl, fromChallenge: undefined, wellKnown: [], found: undefined };
    if (challengeUrl !== undefined) {
      prm.fromChallenge = await getJson(ctx, challengeUrl);
      if (prm.fromChallenge.state === 'ok') {
        prm.found = prm.fromChallenge;
        return prm;
      }
    }
    const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
    const urls = [...new Set([`${url.origin}${WK_PRM}${path}`, `${url.origin}${WK_PRM}`])];
    for (const u of urls) {
      const got = await getJson(ctx, u);
      prm.wellKnown.push(got);
      if (got.state === 'ok') {
        prm.found = got;
        break;
      }
    }
    return prm;
  });
}

const fetchedDetails = (...f: (Fetched | undefined)[]): Exchange[] =>
  f.flatMap((x) =>
    x !== undefined && x.state !== 'blocked' && x.detail !== undefined ? [x.detail] : [],
  );

const blockedNote = (url: string): string =>
  `${originOf(url)} is not the origin of the server: it was not asked. Name it with --allow-origin ${originOf(url)} to ask it.`;

/** The first authorization server of the metadata, when there is one. */
const issuerOf = (prm: Prm): string | undefined => {
  const list = prm.found?.doc['authorization_servers'];
  const first = Array.isArray(list) ? list[0] : undefined;
  return typeof first === 'string' ? first : undefined;
};

interface As {
  issuer: string;
  tried: Fetched[];
  found: Extract<Fetched, { state: 'ok' }> | undefined;
}

/** The authorization server's metadata, by the locations and the order of the specification. */
function discoverAs(ctx: OauthContext, issuer: string): Promise<As> {
  return ctx.memo(`oauth as ${issuer}`, async () => {
    let u: URL;
    try {
      u = new URL(issuer);
    } catch {
      return {
        issuer,
        tried: [{ state: 'bad', url: issuer, why: 'it is not an absolute URL' }],
        found: undefined,
      };
    }
    const path = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '');
    const urls =
      path === ''
        ? [
            `${u.origin}/.well-known/oauth-authorization-server`,
            `${u.origin}/.well-known/openid-configuration`,
          ]
        : [
            `${u.origin}/.well-known/oauth-authorization-server${path}`,
            `${u.origin}/.well-known/openid-configuration${path}`,
            `${u.origin}${path}/.well-known/openid-configuration`,
          ];
    const as: As = { issuer, tried: [], found: undefined };
    for (const url of urls) {
      const got = await getJson(ctx, url);
      as.tried.push(got);
      if (got.state === 'ok') {
        as.found = got;
        break;
      }
      if (got.state === 'blocked') break;
    }
    return as;
  });
}

/** What the checks of the authorization server's metadata start from: the metadata, or the outcome without it. */
async function asMetadata(ctx: OauthContext): Promise<Meta | CheckOutcome> {
  const p = await needsAuth(ctx);
  if (isOutcome(p)) return p;
  const prm = await discoverPrm(ctx, p.challenge);
  if (prm.found === undefined)
    return prerequisite(
      'The protected resource metadata could not be read: oauth-prm-reachable says why.',
    );
  const issuer = issuerOf(prm);
  if (issuer === undefined)
    return prerequisite(
      'The protected resource metadata names no authorization server: oauth-prm-valid says why.',
    );
  const as = await discoverAs(ctx, issuer);
  if (as.found === undefined) {
    const blocked = as.tried.find((t) => t.state === 'blocked');
    if (blocked !== undefined)
      return needsInput(`The authorization server ${blockedNote(blocked.url)}`);
    return prerequisite(
      "The authorization server's metadata could not be read: oauth-as-metadata-discoverable says why.",
      fetchedDetails(...as.tried),
    );
  }
  return { as, doc: as.found.doc, detail: as.found.detail };
}

type Meta = { as: As; doc: Record<string, unknown>; detail: Exchange };
const isMeta = (v: Meta | CheckOutcome): v is Meta => 'doc' in v;

// ---- the checks ----

const requiresAuth: ConformanceCheck = async (c) => {
  const ctx = c.oauth!;
  const p = await unauthenticated(ctx);
  if (p.status === 401)
    return { ...passed('A request without a token got HTTP 401.'), details: [p.detail] };
  if (p.status >= 200 && p.status < 300)
    return {
      state: 'not-applicable',
      reason: 'no-auth',
      actual: `A request without a token got HTTP ${p.status}: the server is public.`,
      details: [p.detail],
    };
  return {
    ...failed(
      `A request without a token got HTTP ${p.status}.`,
      'Answer a request to the MCP endpoint that has no access token with 401 Unauthorized and a WWW-Authenticate challenge.',
    ),
    details: [p.detail],
  };
};

const challengeBearer: ConformanceCheck = async (c) => {
  const ctx = c.oauth!;
  const p = await needsAuth(ctx);
  if (isOutcome(p)) return p;
  if (p.challenge === undefined)
    return {
      ...failed(
        'The 401 has no WWW-Authenticate header.',
        'Send WWW-Authenticate: Bearer ... with the 401.',
      ),
      details: [p.detail],
    };
  if (bearerParams(p.challenge) === undefined)
    return {
      ...failed(
        'The WWW-Authenticate header of the 401 does not use the Bearer scheme.',
        'Challenge with the Bearer scheme (RFC 6750 section 3).',
      ),
      details: [p.detail],
    };
  return { ...passed('The 401 carries a Bearer challenge.'), details: [p.detail] };
};

const prmReachable: ConformanceCheck = async (c) => {
  const ctx = c.oauth!;
  const p = await needsAuth(ctx);
  if (isOutcome(p)) return p;
  const prm = await discoverPrm(ctx, p.challenge);
  const details = fetchedDetails(prm.fromChallenge, ...prm.wellKnown);
  if (prm.found !== undefined)
    return {
      ...passed(
        `The metadata was found ${prm.found === prm.fromChallenge ? 'at the resource_metadata URL of the challenge' : 'at a well-known URI'}.`,
      ),
      details,
    };
  const blocked = [prm.fromChallenge, ...prm.wellKnown].find((f) => f?.state === 'blocked');
  if (blocked !== undefined)
    return { ...needsInput(`The resource_metadata URL ${blockedNote(blocked.url)}`), details };
  return {
    ...failed(
      `Neither mechanism served the metadata (${[prm.fromChallenge, ...prm.wellKnown]
        .flatMap((f) => (f?.state === 'bad' ? [`${f.url}: ${f.why}`] : []))
        .join('; ')}).`,
      `Put resource_metadata in the WWW-Authenticate header of the 401, or serve the metadata at ${WK_PRM} (RFC 9728).`,
    ),
    details,
  };
};

const challengeMetadataUrl: ConformanceCheck = async (c) => {
  const ctx = c.oauth!;
  const p = await needsAuth(ctx);
  if (isOutcome(p)) return p;
  const prm = await discoverPrm(ctx, p.challenge);
  if (prm.challengeUrl === undefined)
    return {
      state: 'not-applicable',
      reason: 'not-offered',
      actual:
        'The challenge has no resource_metadata: the well-known URI is the other mechanism, and oauth-prm-reachable judges it.',
      details: [p.detail],
    };
  const f = prm.fromChallenge;
  if (f?.state === 'ok')
    return {
      ...passed('resource_metadata is an absolute URL that serves a JSON object.'),
      details: [f.detail],
    };
  if (f?.state === 'blocked') return needsInput(`The resource_metadata URL ${blockedNote(f.url)}`);
  return {
    ...failed(
      `resource_metadata (${f?.url ?? ''}): ${f?.state === 'bad' ? f.why : 'not read'}.`,
      'Give resource_metadata the absolute URL of a document that answers 200 with the JSON metadata.',
    ),
    details: fetchedDetails(f),
  };
};

const prmValid: ConformanceCheck = async (c) => {
  const ctx = c.oauth!;
  const p = await needsAuth(ctx);
  if (isOutcome(p)) return p;
  const prm = await discoverPrm(ctx, p.challenge);
  if (prm.found === undefined)
    return prerequisite(
      'The protected resource metadata could not be read: oauth-prm-reachable says why.',
    );
  const doc = prm.found.doc;
  const problems: string[] = [];
  const servers = doc['authorization_servers'];
  const urls = Array.isArray(servers)
    ? servers.filter((s): s is string => typeof s === 'string' && URL.canParse(s))
    : [];
  if (urls.length === 0) problems.push('authorization_servers lists no URL');
  const expected = ctx.config.resource ?? ctx.url;
  if (doc['resource'] !== expected)
    problems.push(
      `resource is ${typeof doc['resource'] === 'string' ? JSON.stringify(doc['resource']) : 'missing'}, not ${JSON.stringify(expected)}`,
    );
  const details = [prm.found.detail];
  if (problems.length > 0)
    return {
      ...failed(
        `${problems.join('; ')}.`,
        'Serve a metadata object with authorization_servers (at least one URL) and resource equal to the URL of this server.',
      ),
      details,
    };
  return {
    ...passed(`authorization_servers lists ${urls.length} URL(s); resource is the server's URL.`),
    details,
  };
};

const challengeScope: ConformanceCheck = async (c) => {
  const p = await needsAuth(c.oauth!);
  if (isOutcome(p)) return p;
  const scope = bearerParams(p.challenge)?.['scope'];
  if (scope !== undefined && scope !== '')
    return { ...passed('The challenge names a scope.'), details: [p.detail] };
  return {
    ...failed(
      'The challenge has no scope parameter.',
      'Add scope="..." to the WWW-Authenticate header: the scopes the endpoint needs.',
    ),
    details: [p.detail],
  };
};

const asDiscoverable: ConformanceCheck = async (c) => {
  const ctx = c.oauth!;
  const p = await needsAuth(ctx);
  if (isOutcome(p)) return p;
  const prm = await discoverPrm(ctx, p.challenge);
  if (prm.found === undefined)
    return prerequisite(
      'The protected resource metadata could not be read: oauth-prm-reachable says why.',
    );
  const issuer = issuerOf(prm);
  if (issuer === undefined)
    return prerequisite(
      'The protected resource metadata names no authorization server: oauth-prm-valid says why.',
    );
  const as = await discoverAs(ctx, issuer);
  const details = fetchedDetails(...as.tried);
  if (as.found !== undefined)
    return {
      ...passed(`The metadata was found at the ${new URL(as.found.url).pathname} location.`),
      details,
    };
  const blocked = as.tried.find((t) => t.state === 'blocked');
  if (blocked !== undefined)
    return needsInput(`The authorization server ${blockedNote(blocked.url)}`);
  return {
    ...failed(
      `No metadata document at any location: ${as.tried.flatMap((t) => (t.state === 'bad' ? [`${t.url}: ${t.why}`] : [])).join('; ')}.`,
      'Serve the authorization server metadata (RFC 8414) or the OpenID Connect discovery document at the well-known locations of the issuer.',
    ),
    details,
  };
};

/** The check of one member of the authorization server's metadata. */
const asMember =
  (
    judge: (
      doc: Record<string, unknown>,
      as: As,
    ) => { ok: true; actual: string } | { ok: false; actual: string; fix: string },
  ): ConformanceCheck =>
  async (c) => {
    const m = await asMetadata(c.oauth!);
    if (!isMeta(m)) return m;
    const v = judge(m.doc, m.as);
    return v.ok
      ? { ...passed(v.actual), details: [m.detail] }
      : { ...failed(v.actual, v.fix), details: [m.detail] };
  };

const asIssuerMatches = asMember((doc, as) =>
  doc['issuer'] === as.issuer
    ? { ok: true, actual: 'issuer is identical to the issuer identifier.' }
    : {
        ok: false,
        actual: `issuer is ${typeof doc['issuer'] === 'string' ? JSON.stringify(doc['issuer']) : 'missing'}, the identifier was ${JSON.stringify(as.issuer)}.`,
        fix: 'Serve a metadata document whose issuer is exactly the issuer identifier it is published for (RFC 8414 section 3.3).',
      },
);

const asPkceAdvertised = asMember((doc) =>
  Array.isArray(doc['code_challenge_methods_supported'])
    ? { ok: true, actual: 'code_challenge_methods_supported is present.' }
    : {
        ok: false,
        actual: 'The metadata has no code_challenge_methods_supported.',
        fix: 'Add code_challenge_methods_supported to the metadata (["S256"]): a client must refuse an authorization server that does not advertise PKCE.',
      },
);

const asPkceS256 = asMember((doc) => {
  const methods = doc['code_challenge_methods_supported'];
  if (Array.isArray(methods) && methods.includes('S256'))
    return { ok: true, actual: 'S256 is listed.' };
  return {
    ok: false,
    actual: Array.isArray(methods)
      ? 'code_challenge_methods_supported does not list S256.'
      : 'The metadata has no code_challenge_methods_supported.',
    fix: 'List S256 in code_challenge_methods_supported.',
  };
});

const asIssAdvertised = asMember((doc) =>
  doc['authorization_response_iss_parameter_supported'] === true
    ? { ok: true, actual: 'authorization_response_iss_parameter_supported is true.' }
    : {
        ok: false,
        actual: 'The metadata does not say authorization_response_iss_parameter_supported: true.',
        fix: 'Send iss in authorization responses (RFC 9207) and advertise it with authorization_response_iss_parameter_supported: true.',
      },
);

const asCimdAdvertised = asMember((doc) =>
  doc['client_id_metadata_document_supported'] === true
    ? { ok: true, actual: 'client_id_metadata_document_supported is true.' }
    : {
        ok: false,
        actual: 'The metadata does not say client_id_metadata_document_supported: true.',
        fix: 'Support OAuth Client ID Metadata Documents and advertise it with client_id_metadata_document_supported: true.',
      },
);

const ENDPOINTS = ['authorization_endpoint', 'token_endpoint', 'registration_endpoint'] as const;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

const asHttps: ConformanceCheck = async (c) => {
  const m = await asMetadata(c.oauth!);
  if (!isMeta(m)) return m;
  const urls = ENDPOINTS.flatMap((k) =>
    typeof m.doc[k] === 'string' ? [[k, m.doc[k] as string] as const] : [],
  );
  const isLoopback = (u: string): boolean => {
    try {
      const host = new URL(u).hostname.toLowerCase();
      return LOOPBACK.has(host) || host.endsWith('.localhost');
    } catch {
      return false;
    }
  };
  if (urls.length > 0 && urls.every(([, u]) => isLoopback(u)))
    return {
      state: 'not-applicable',
      reason: 'not-offered',
      actual:
        'Every endpoint is on a loopback name: the test setup of a local authorization server.',
      details: [m.detail],
    };
  const bad = urls.filter(([, u]) => !u.toLowerCase().startsWith('https://'));
  if (bad.length > 0)
    return {
      ...failed(
        `Not https: ${bad.map(([k]) => k).join(', ')}.`,
        'Serve every authorization server endpoint over HTTPS.',
      ),
      details: [m.detail],
    };
  return { ...passed(`${urls.length} endpoint(s), all https.`), details: [m.detail] };
};

const invalidToken401: ConformanceCheck = async (c) => {
  const ctx = c.oauth!;
  const p = await needsAuth(ctx);
  if (isOutcome(p)) return p;
  const bad = await probe(ctx, `plune-conformance-not-a-token-${randomBytes(12).toString('hex')}`);
  if (bad.status === 401)
    return {
      ...passed('A token the authorization server never issued got HTTP 401.'),
      details: [bad.detail],
    };
  return {
    ...failed(
      `A token the authorization server never issued got HTTP ${bad.status}.`,
      'Answer a request whose token is invalid or expired with 401 Unauthorized.',
    ),
    details: [bad.detail],
  };
};

/** `{ access_token }` from a token response, else the error the authorization server gave. */
async function requestToken(
  ctx: OauthContext,
  endpoint: string,
  clientId: string,
  secret: string,
  resource: string,
): Promise<{ token: string; detail: Exchange } | { error: string; detail: Exchange }> {
  ctx.secrets.add(secret);
  const form = new URLSearchParams({ grant_type: 'client_credentials', resource });
  if (ctx.config.scopes !== undefined && ctx.config.scopes.length > 0)
    form.set('scope', ctx.config.scopes.join(' '));
  const basic = Buffer.from(
    `${encodeURIComponent(clientId)}:${encodeURIComponent(secret)}`,
  ).toString('base64');
  ctx.secrets.add(basic);
  const { res, detail } = await send(ctx, endpoint, {
    method: 'POST',
    headers: [
      ['Content-Type', 'application/x-www-form-urlencoded'],
      ['Accept', 'application/json'],
      ['Authorization', `Basic ${basic}`],
    ],
    body: form.toString(),
  });
  let doc: unknown;
  try {
    doc = JSON.parse(res.body);
  } catch {
    doc = undefined;
  }
  const token = isObject(doc) ? doc['access_token'] : undefined;
  if (res.status === 200 && typeof token === 'string' && token !== '') {
    ctx.secrets.add(token);
    return { token, detail: detail() };
  }
  const code = isObject(doc) && typeof doc['error'] === 'string' ? doc['error'] : undefined;
  return {
    error: `HTTP ${res.status}${code === undefined ? '' : ` ${code.slice(0, 60)}`}`,
    detail: detail(),
  };
}

const wrongAudience: ConformanceCheck = async (c) => {
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
      'A token for another resource needs --config with auth "client-credentials" and a preregistered client (clientId, and clientSecretEnv naming a variable that is set).',
    );
  const m = await asMetadata(ctx);
  if (!isMeta(m)) return m;
  const endpoint = m.doc['token_endpoint'];
  if (typeof endpoint !== 'string')
    return prerequisite('The authorization server metadata has no token_endpoint.', [m.detail]);
  if (!allowed(ctx, endpoint))
    return needsInput(`The token endpoint ${blockedNote(endpoint)} No credentials were sent.`);
  const own = ctx.config.resource ?? ctx.url;
  const control = await requestToken(ctx, endpoint, reg.clientId, secret, own);
  if ('error' in control)
    return prerequisite(
      `The authorization server issued no token for the server itself (${control.error}): the control cannot be made.`,
      [control.detail],
    );
  const foreign = await requestToken(ctx, endpoint, reg.clientId, secret, SERVER_OTHER_RESOURCE);
  if ('error' in foreign)
    return needsInput(
      `The authorization server issued no token for another resource (${foreign.error}): there is nothing to offer the server.`,
    );
  const accepted = await probe(ctx, control.token);
  if (accepted.status === 401 || accepted.status === 403)
    return prerequisite(
      `The server answered HTTP ${accepted.status} to the token issued for itself: a refusal of the other token would prove nothing.`,
      [accepted.detail],
    );
  const refused = await probe(ctx, foreign.token);
  const details = [control.detail, accepted.detail, foreign.detail, refused.detail];
  if (refused.status === 401)
    return {
      ...passed(
        'A token issued for another resource got HTTP 401; the token issued for the server was accepted.',
      ),
      details,
    };
  return {
    ...failed(
      `A token issued for another resource got HTTP ${refused.status}, while the token issued for the server was accepted (HTTP ${accepted.status}).`,
      'Check the audience of every access token (RFC 8707) and answer a token that was not issued for this server with 401 Unauthorized.',
    ),
    details,
  };
};

export const AUTH: Record<string, ConformanceCheck> = {
  'oauth-requires-auth': requiresAuth,
  'oauth-challenge-bearer': challengeBearer,
  'oauth-prm-reachable': prmReachable,
  'oauth-challenge-metadata-url': challengeMetadataUrl,
  'oauth-prm-valid': prmValid,
  'oauth-challenge-scope': challengeScope,
  'oauth-as-metadata-discoverable': asDiscoverable,
  'oauth-as-issuer-matches': asIssuerMatches,
  'oauth-as-https': asHttps,
  'oauth-as-pkce-advertised': asPkceAdvertised,
  'oauth-as-pkce-s256': asPkceS256,
  'oauth-as-iss-advertised': asIssAdvertised,
  'oauth-as-cimd-advertised': asCimdAdvertised,
  'oauth-neg-invalid-token-401': invalidToken401,
  'oauth-neg-wrong-audience': wrongAudience,
};
