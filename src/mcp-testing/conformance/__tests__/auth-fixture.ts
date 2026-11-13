// A resource server and an authorization server on loopback, for the oauth suite: each behaviour can be broken on its
// own. Both speak plain node:http, no OAuth library. The tokens are made-up strings; the server remembers which
// resource each one was issued for, so it can accept or refuse by audience the way a real one does.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface AuthOpts {
  /** No authorization at all: every request is answered. */
  public?: boolean;
  /** `url`: Bearer with resource_metadata; `plain`: Bearer without it (the well-known URI serves); `basic`: not Bearer; `none`: no header. */
  challenge?: 'url' | 'plain' | 'basic' | 'none' | 'tricky';
  /** A scope parameter in the challenge (default true). */
  scope?: boolean;
  /** `none`: no metadata anywhere. */
  prm?: 'ok' | 'none';
  /** Replaces the resource_metadata URL of the challenge (a foreign host). */
  prmUrl?: string;
  /** The `resource` member of the metadata. */
  prmResource?: string;
  /** `authorization_servers` of the metadata, instead of this server's own; `{origin}` stands for this server's origin. */
  authorizationServers?: string[];
  /** Bind to every interface and name the server by this host, instead of 127.0.0.1. */
  host?: string;
  /**
   * What an endpoint answers instead of its own answer: a status, or a string for a 302 to that location (`drop`: the connection is cut; `hang`: no answer). Keys: `mcp`
   * (no token), `mcp:own` (a token issued for this server), `mcp:other` (for another resource), `mcp:bad` (not issued),
   * `prm`, `as`, `token:own`, `token:other`.
   */
  force?: Record<string, number | string>;
  /** Dynamic client registration (RFC 7591) and deletion (RFC 7592). The metadata names the endpoint when `as.registration`. */
  dcr?: {
    /**
     * `ok`: a client is made, http redirects outside loopback refused; `accept-http`: those are accepted;
     * `reject-all`: every registration is refused (400); `auth-required`: 401; `no-client-id`: 201 without client_id;
     * `error`: 503.
     */
    mode?:
      | 'ok'
      | 'accept-http'
      | 'reject-all'
      | 'auth-required'
      | 'no-client-id'
      | 'error'
      /** The client is made, then the answer never comes. */
      | 'timeout-after-write'
      /** The client is made, and the answer is 201 with the means to delete it, but no client_id. */
      | 'no-client-id-deletable'
      /** The client is made, then a 502 answers. */
      | 'bad-gateway-after-write'
      /** 429: nothing is made. */
      | 'rate-limit'
      /** The client is made, and the 201 is larger than a reader takes. */
      | 'big';
    /** The answer also has an `initial_access_token`, and a secret in the query of registration_client_uri. */
    extras?: boolean;
    /** The base of registration_client_uri, instead of this server's origin. */
    uriBase?: string;
    /** `ok`: DELETE answers 204; `405`: DELETE is not supported; `none`: no registration_client_uri is returned. */
    remove?: 'ok' | '405' | 'none';
    /** The response carries a client_secret. */
    secret?: boolean;
  };
  /** The authorization endpoint: `redirect` (default), `login` (a page, 200), `error-redirect` (access_denied), or a status. */
  authorize?:
    | 'redirect'
    | 'login'
    | 'error-redirect'
    /** Every client, known or not, gets the sign-in page (200). */
    | 'login-all'
    /** Every client, known or not, is sent to this server's own /login. */
    | 'redirect-login-all'
    /** Every client gets 403 with no error code. */
    | 'forbidden'
    /** A client that does not exist is redirected to the redirect_uri with one more path segment (a trailing slash). */
    | 'unknown-slash'
    /** A client that does not exist is redirected to the redirect_uri with another host: a sibling URI. */
    | 'unknown-sibling'
    /** A redirect to a sign-in of this server that carries the redirect_uri it was given in a parameter. */
    | 'redirect-login-keeps-uri'
    /** A known client is redirected to any redirect_uri, registered or not (the fault), with a code. */
    | 'redirect-any'
    /** The same, with an error in the redirect. */
    | 'redirect-any-error'
    /** A client that does not exist is redirected to the redirect_uri with a code (the fault). */
    | 'accept-unknown'
    /** A client that does not exist is redirected to the redirect_uri with error=invalid_client. */
    | 'unknown-error-redirect'
    /** An unknown client gets invalid_request that names the client_id, or one that does not. */
    | 'invalid-request-client'
    | 'invalid-request-plain'
    | number;
  /** A client the token endpoint does not know: refused with invalid_client (default), given a token, or 400 or 403 otherwise. */
  tokenUnknown?: 'refuse' | 'accept' | 'invalid-request' | 'forbidden';
  /** The token endpoint refuses every request with this as the `error` of a 400 (any text, for the cut of a message). */
  tokenError?: string;
  /** What a client that does not exist gets at the authorization endpoint, in place of the usual answer. */
  unknown?: Odd;
  /** What a known client gets when its redirect_uri is on an .invalid host, in place of the usual answer. */
  foreign?: Odd;
  /** The token response also carries a refresh_token and an id_token. */
  tokenExtras?: boolean;
  /** A client_id URL whose document names another client_id: `reject` (default) or `accept` (the fault). */
  cimdMismatch?: 'reject' | 'accept';
  /** The token response: `ok` (default), `no-type`, `mac`, `bearer-lower`, `no-expires`, `no-token`. */
  /** The `token_type` of the token response, exactly as given (any JSON value). */
  tokenType?: unknown;
  /**
   * What the MCP endpoint answers to a token whose granted scope lacks `mcp:tools`: `require-full` is 403 with an
   * insufficient_scope challenge; `unauthorized` is 401; `forbidden-plain` is 403 with no error. Without it any scope is taken.
   */
  scopeRule?: 'require-full' | 'unauthorized' | 'forbidden-plain' | Odd;
  /**
   * What the token endpoint does with the scope asked for: `echo` grants it and says so in the answer; `full` ignores it
   * and grants `mcp:tools mcp:read`, saying so; `refuse-narrow` answers invalid_scope to a request without `mcp:tools`.
   * Without it the scope is granted and the answer has no `scope` field.
   */
  tokenScope?: 'echo' | 'full' | 'refuse-narrow' | 'drop-narrow';
  /** The `token_type` of a token asked for without `mcp:tools`, in place of Bearer. */
  narrowTokenType?: string;
  /** Where the token endpoint redirects a request for a token without `mcp:tools`. */
  narrowRedirect?: string;
  tokenResponse?: 'ok' | 'no-type' | 'mac' | 'dpop' | 'bearer-lower' | 'no-expires' | 'no-token';
  /**
   * What the access token is: `opaque` (default), or a JWT built when it is issued, without a signature, whose `aud`
   * is the resource asked for (`jwt`), a list holding it (`jwt-aud-list`), another resource (`jwt-other-aud`), or absent.
   */
  tokenShape?: 'opaque' | 'jwt' | 'jwt-aud-list' | 'jwt-other-aud' | 'jwt-no-aud';
  /** A `WWW-Authenticate` value on every status that `force` answers. */
  forceChallenge?: string | string[];
  /** The access token, exactly as given, in place of the one this server makes. */
  tokenRaw?: string;
  /** The protected resource metadata is larger than a reader takes. */
  bigPrm?: boolean;
  /** The token endpoint hands out one token whatever resource is asked for. */
  sameToken?: boolean;
  as?: {
    issuer?: string;
    pkce?: 'S256' | 'plain' | 'none' | 'empty';
    /** `false`: the metadata names no endpoint at all. */
    endpoints?: boolean;
    /** The token_endpoint member, as written. */
    tokenEndpoint?: string;
    /** The metadata names a registration_endpoint: this server's, or the URL given. */
    registration?: boolean | string;
    /** The base of every endpoint URL, instead of this server's origin. */
    base?: string;
    iss?: boolean;
    cimd?: boolean;
    /** No metadata at any well-known location. */
    none?: boolean;
    /** `true`: every endpoint is https (on a name this machine does not answer); `mixed`: only the authorization one. */
    https?: boolean | 'mixed';
  };
  /** `strict`: only a token issued for this server; `lax`: any token the authorization server issued; `any`: any bearer at all; `refuse-all`. */
  audience?: 'strict' | 'lax' | 'any' | 'refuse-all';
  /** `refuse`: the token endpoint refuses a resource other than this server (invalid_target). */
  otherResource?: 'issue' | 'refuse';
}

export interface Seen {
  /** `host:port` of the server that got it. */
  server: string;
  method: string;
  path: string;
  /** The query string, as sent. */
  query: string;
  authorization: string | undefined;
  body: string;
}

export interface AuthFixture {
  /** The MCP endpoint. */
  url: string;
  /** The issuer: this server's origin. */
  origin: string;
  seen: Seen[];
  /** client_ids made by registration, and those a DELETE removed. */
  registered: string[];
  deleted: string[];
  close(): Promise<void>;
}

/** An answer of its own: a status with a Location (or none), a dropped connection, or no answer at all. */
export type Odd = { status: number; location?: string } | 'drop' | 'hang';

export const CLIENT_ID = 'plune-test-client';
/** What `tokenScope: 'full'` grants, and the scope `scopeRule` asks for. */
export const FULL_SCOPE = 'mcp:tools mcp:read';
/** The authorization code and the state a redirect of this server carries (the state is not the one the suite sends). */
export const AUTH_CODE = 'zq7Kx9mWv3RtLb5N';
export const AUTH_STATE = 'st8Vn3Yb6HdQe2Ux';
export const CLIENT_SECRET = 'cs-8f3a91d27b4c46e5a0';
export const DCR_SECRET = 'dcs-5e2b7a90c14d3f68';
export const REG_TOKEN = /rat-\d+-91c7d2e4b6a8f035/;

const json = (
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string | string[]> = {},
) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let text = '';
    req.on('data', (c: Buffer) => (text += c.toString()));
    req.on('end', () => resolve(text));
  });

export async function authFixture(o: AuthOpts = {}, seen: Seen[] = []): Promise<AuthFixture> {
  const issued = new Map<string, string>();
  const granted = new Map<string, string>();
  const clients = new Map<string, { token: string }>();
  const registered: string[] = [];
  const deleted: string[] = [];
  let counter = 0;
  let origin = '';
  const resource = () => `${origin}/mcp`;
  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    seen.push({
      server: req.headers.host ?? '',
      method: req.method ?? '',
      path,
      query: (req.url ?? '').split('?')[1] ?? '',
      authorization: req.headers.authorization,
      body,
    });
    const forced = (key: string): boolean => {
      const f = o.force?.[key];
      if (f === undefined) return false;
      if (typeof f === 'number')
        json(
          res,
          f,
          {},
          o.forceChallenge === undefined ? {} : { 'www-authenticate': o.forceChallenge },
        );
      else if (f === 'drop') req.socket.destroy();
      else if (f === 'hang') return true;
      else res.writeHead(302, { location: f }).end();
      return true;
    };
    if (path === '/mcp') {
      if (o.public === true) return json(res, 200, { jsonrpc: '2.0', id: 'x', result: {} });
      const auth = req.headers.authorization;
      const token = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
      const aud = token === undefined ? undefined : issued.get(token);
      const kind =
        token === undefined
          ? 'mcp'
          : aud === resource()
            ? 'mcp:own'
            : aud !== undefined
              ? 'mcp:other'
              : 'mcp:bad';
      if (forced(kind)) return;
      const fine =
        o.audience === 'any'
          ? token !== undefined
          : o.audience !== 'refuse-all' &&
            aud !== undefined &&
            (aud === resource() || o.audience === 'lax');
      if (
        fine &&
        o.scopeRule !== undefined &&
        !(granted.get(token ?? '') ?? '').split(' ').includes('mcp:tools')
      ) {
        if (typeof o.scopeRule === 'object') {
          const v = o.scopeRule;
          res.writeHead(v.status, v.location === undefined ? {} : { location: v.location }).end();
          return;
        }
        if (o.scopeRule === 'drop') {
          req.socket.destroy();
          return;
        }
        if (o.scopeRule === 'hang') return;
        if (o.scopeRule === 'unauthorized') return json(res, 401, { error: 'invalid_token' });
        return json(
          res,
          403,
          { error: 'insufficient_scope' },
          o.scopeRule === 'require-full'
            ? { 'www-authenticate': 'Bearer error="insufficient_scope", scope="mcp:tools"' }
            : {},
        );
      }
      if (fine) return json(res, 200, { jsonrpc: '2.0', id: 'x', result: {} });
      const params = [
        ...(o.challenge === 'url' || o.challenge === undefined
          ? [
              `resource_metadata="${o.prmUrl ?? `${origin}/.well-known/oauth-protected-resource/mcp`}"`,
            ]
          : []),
        ...(o.scope === false ? [] : ['scope="mcp:tools"']),
      ];
      const headers: Record<string, string> =
        o.challenge === 'none'
          ? {}
          : {
              'www-authenticate':
                o.challenge === 'basic'
                  ? 'Basic realm="x"'
                  : o.challenge === 'tricky'
                    ? 'Basic realm="a Bearer b"'
                    : `Bearer ${params.join(', ')}`.trimEnd(),
            };
      return json(res, 401, { error: 'invalid_token' }, headers);
    }
    if (path === '/.well-known/oauth-protected-resource/mcp' && o.prm !== 'none') {
      if (forced('prm')) return;
      if (o.bigPrm === true) return json(res, 200, { pad: 'x'.repeat(300_000) });
      return json(res, 200, {
        resource: (o.prmResource ?? resource()).replace('{origin}', origin),
        authorization_servers: (o.authorizationServers ?? [origin]).map((a) =>
          a.replace('{origin}', origin),
        ),
      });
    }
    if (path === '/.well-known/oauth-authorization-server' && o.as?.none !== true) {
      if (forced('as')) return;
      const https = o.as?.https;
      const at = (p: string) =>
        https === true || (https === 'mixed' && p === '/authorize')
          ? `https://as.example${p}`
          : `${o.as?.base ?? origin}${p}`;
      return json(res, 200, {
        issuer: o.as?.issuer ?? origin,
        ...(o.as?.endpoints === false
          ? {}
          : {
              authorization_endpoint: at('/authorize'),
              token_endpoint: o.as?.tokenEndpoint ?? at('/token'),
            }),
        ...(o.as?.pkce === 'none'
          ? {}
          : {
              code_challenge_methods_supported:
                o.as?.pkce === 'plain' ? ['plain'] : o.as?.pkce === 'empty' ? [] : ['S256'],
            }),
        ...(o.as?.registration === undefined || o.as.registration === false
          ? {}
          : {
              registration_endpoint:
                o.as.registration === true ? `${o.as?.base ?? origin}/register` : o.as.registration,
            }),
        ...(o.as?.iss === true ? { authorization_response_iss_parameter_supported: true } : {}),
        ...(o.as?.cimd === true ? { client_id_metadata_document_supported: true } : {}),
      });
    }
    if (path === '/register' && req.method === 'POST') {
      const mode = o.dcr?.mode ?? 'ok';
      if (mode === 'error') return json(res, 503, {});
      if (mode === 'rate-limit') return json(res, 429, {});
      if (mode === 'auth-required') return json(res, 401, { error: 'invalid_token' });
      if (mode === 'reject-all') return json(res, 400, { error: 'invalid_client_metadata' });
      let meta: { redirect_uris?: unknown } = {};
      try {
        meta = JSON.parse(body) as typeof meta;
      } catch {
        return json(res, 400, { error: 'invalid_client_metadata' });
      }
      const uris = Array.isArray(meta.redirect_uris) ? (meta.redirect_uris as string[]) : [];
      const loopback = (u: string) =>
        /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(u);
      if (mode !== 'accept-http' && uris.some((u) => !u.startsWith('https://') && !loopback(u)))
        return json(res, 400, { error: 'invalid_redirect_uri' });
      if (mode === 'no-client-id') return json(res, 201, { client_name: 'x' });
      const n = registered.length + 1;
      const id = `dyn-${n}-3b8e`;
      const token = `rat-${n}-91c7d2e4b6a8f035`;
      clients.set(id, { token });
      registered.push(id);
      if (mode === 'timeout-after-write') return;
      if (mode === 'bad-gateway-after-write') return json(res, 502, {});
      if (mode === 'big') return json(res, 201, { client_id: id, pad: 'x'.repeat(300_000) });
      const uri = `${o.dcr?.uriBase ?? origin}/register/${id}`;
      if (mode === 'no-client-id-deletable')
        return json(res, 201, { registration_client_uri: uri, registration_access_token: token });
      return json(res, 201, {
        client_id: id,
        ...(o.dcr?.extras === true
          ? {
              initial_access_token: 'iat-4d8f21b6a09c7e53',
              registration_client_uri: `${uri}?key=qk-6a31f8c2d95b`,
            }
          : {}),
        ...(o.dcr?.secret === true ? { client_secret: DCR_SECRET } : {}),
        ...(o.dcr?.remove === 'none'
          ? {}
          : {
              ...(o.dcr?.extras === true ? {} : { registration_client_uri: uri }),
              registration_access_token: token,
            }),
      });
    }
    if (path.startsWith('/register/') && req.method === 'DELETE') {
      const id = path.slice('/register/'.length);
      const c = clients.get(id);
      if (o.dcr?.remove === '405') return json(res, 405, {});
      if (c === undefined || req.headers.authorization !== `Bearer ${c.token}`)
        return json(res, 401, { error: 'invalid_token' });
      clients.delete(id);
      deleted.push(id);
      res.writeHead(204).end();
      return;
    }
    if (path === '/authorize' && req.method === 'GET') {
      if (forced('authorize')) return;
      if (typeof o.authorize === 'number') return json(res, o.authorize, {});
      if (o.authorize === 'forbidden') return json(res, 403, {});
      if (o.authorize === 'error-redirect') {
        const back = new URL(
          new URL(req.url ?? '/', origin).searchParams.get('redirect_uri') ?? `${origin}/cb`,
        );
        back.searchParams.set('error', 'access_denied');
        res.writeHead(302, { location: back.href }).end();
        return;
      }
      if (o.authorize === 'login-all') {
        res.writeHead(200, { 'content-type': 'text/html' }).end('<html>sign in</html>');
        return;
      }
      if (o.authorize === 'redirect-login-keeps-uri') {
        const given = new URL(req.url ?? '/', origin).searchParams.get('redirect_uri') ?? '';
        res
          .writeHead(302, { location: `${origin}/login?redirect_uri=${encodeURIComponent(given)}` })
          .end();
        return;
      }
      if (o.authorize === 'redirect-login-all') {
        res.writeHead(302, { location: `${origin}/login` }).end();
        return;
      }
      const q = new URL(req.url ?? '/', origin).searchParams;
      const id = q.get('client_id') ?? '';
      const redirect = q.get('redirect_uri') ?? '';
      const known =
        id === CLIENT_ID ||
        clients.has(id) ||
        (id.startsWith('https://') &&
          (!id.endsWith('mismatch.json') || o.cimdMismatch === 'accept'));
      const odd = (v: Odd): void => {
        if (v === 'drop') req.socket.destroy();
        else if (v !== 'hang')
          res.writeHead(v.status, v.location === undefined ? {} : { location: v.location }).end();
      };
      if (!known && o.unknown !== undefined) return odd(o.unknown);
      if (!known && (o.authorize === 'unknown-slash' || o.authorize === 'unknown-sibling')) {
        const to = new URL(redirect || `${origin}/cb`);
        if (o.authorize === 'unknown-slash') to.pathname = `${to.pathname}/`;
        else to.host = 'sibling';
        res.writeHead(302, { location: to.href }).end();
        return;
      }
      if (!known && o.authorize === 'accept-unknown') {
        const to = new URL(redirect || `${origin}/cb`);
        to.searchParams.set('code', AUTH_CODE);
        to.searchParams.set('state', AUTH_STATE);
        res.writeHead(302, { location: to.href }).end();
        return;
      }
      if (!known && o.authorize === 'unknown-error-redirect') {
        const to = new URL(redirect || `${origin}/cb`);
        to.searchParams.set('error', 'invalid_client');
        res.writeHead(302, { location: to.href }).end();
        return;
      }
      if (!known && o.authorize === 'invalid-request-client')
        return json(res, 400, { error: 'invalid_request', error_description: 'unknown client_id' });
      if (!known && o.authorize === 'invalid-request-plain')
        return json(res, 400, { error: 'invalid_request', error_description: 'missing parameter' });
      if (!known) return json(res, 400, { error: 'invalid_client' });
      if (o.authorize === 'login') {
        res.writeHead(200, { 'content-type': 'text/html' }).end('<html>sign in</html>');
        return;
      }
      // A registered redirect URI is any that is not on a .invalid host; the faults skip the check.
      let foreign = false;
      try {
        foreign = new URL(redirect).hostname.endsWith('.invalid');
      } catch {
        foreign = false;
      }
      if (foreign && o.foreign !== undefined) return odd(o.foreign);
      if (foreign && o.authorize !== 'redirect-any' && o.authorize !== 'redirect-any-error')
        return json(res, 400, {
          error: 'invalid_request',
          error_description: 'redirect_uri is not registered',
        });
      const to = new URL(redirect || `${origin}/cb`);
      if (foreign && o.authorize === 'redirect-any-error')
        to.searchParams.set('error', 'invalid_request');
      else {
        to.searchParams.set('code', AUTH_CODE);
        to.searchParams.set('state', AUTH_STATE);
      }
      res.writeHead(302, { location: to.href }).end();
      return;
    }
    if (path === '/token' && req.method === 'POST') {
      if (o.tokenError !== undefined) return json(res, 400, { error: o.tokenError });
      const basic = req.headers.authorization?.startsWith('Basic ')
        ? Buffer.from(req.headers.authorization.slice(6), 'base64').toString()
        : '';
      if (basic !== `${CLIENT_ID}:${CLIENT_SECRET}` && o.tokenUnknown !== 'accept') {
        if (o.tokenUnknown === 'invalid-request')
          return json(res, 400, { error: 'invalid_request' });
        if (o.tokenUnknown === 'forbidden') return json(res, 403, {});
        return json(res, 401, { error: 'invalid_client' });
      }
      const form = new URLSearchParams(body);
      const wanted = form.get('resource') ?? resource();
      if (forced(wanted === resource() ? 'token:own' : 'token:other')) return;
      if (o.otherResource === 'refuse' && wanted !== resource())
        return json(res, 400, { error: 'invalid_target' });
      const asked = form.get('scope');
      if (
        o.tokenScope === 'drop-narrow' &&
        asked !== null &&
        !asked.split(' ').includes('mcp:tools')
      ) {
        req.socket.destroy();
        return;
      }
      if (
        o.narrowRedirect !== undefined &&
        asked !== null &&
        !asked.split(' ').includes('mcp:tools')
      ) {
        res.writeHead(302, { location: o.narrowRedirect }).end();
        return;
      }
      if (
        o.tokenScope === 'refuse-narrow' &&
        asked !== null &&
        !asked.split(' ').includes('mcp:tools')
      )
        return json(res, 400, { error: 'invalid_scope' });
      const scopeGranted = o.tokenScope === 'full' ? FULL_SCOPE : (asked ?? FULL_SCOPE);
      const serial = o.sameToken === true ? 1 : ++counter;
      const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
      const shape = o.tokenShape ?? 'opaque';
      const aud =
        shape === 'jwt-other-aud'
          ? 'https://elsewhere.example/mcp'
          : shape === 'jwt-aud-list'
            ? ['https://also.example/mcp', wanted]
            : wanted;
      const token =
        o.tokenRaw !== undefined
          ? o.tokenRaw
          : shape === 'opaque'
            ? `at-${serial}-7c1d9e5b3f2a8064`
            : `${part({ alg: 'none', typ: 'JWT' })}.${part({ iss: origin, jti: `j${serial}`, ...(shape === 'jwt-no-aud' ? {} : { aud }) })}.sig`;
      issued.set(token, o.sameToken === true ? resource() : wanted);
      granted.set(token, scopeGranted);
      const t = o.tokenResponse ?? 'ok';
      return json(res, 200, {
        ...(t === 'no-token' ? {} : { access_token: token }),
        ...(t === 'no-type'
          ? {}
          : {
              token_type:
                o.narrowTokenType !== undefined &&
                !(asked ?? FULL_SCOPE).split(' ').includes('mcp:tools')
                  ? o.narrowTokenType
                  : o.tokenType !== undefined
                    ? o.tokenType
                    : t === 'mac'
                      ? 'mac'
                      : t === 'dpop'
                        ? 'DPoP'
                        : t === 'bearer-lower'
                          ? 'bearer'
                          : 'Bearer',
            }),
        ...(t === 'no-expires' ? {} : { expires_in: 300 }),
        ...(o.tokenScope === 'echo' || o.tokenScope === 'full' ? { scope: scopeGranted } : {}),
        ...(o.tokenExtras === true
          ? { refresh_token: 'rt-9b2e47c1a8d03f65', id_token: 'idt-3c7a5e91f2b840d6' }
          : {}),
      });
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) =>
    server.listen(0, o.host === undefined ? '127.0.0.1' : '0.0.0.0', r),
  );
  origin = `http://${o.host ?? '127.0.0.1'}:${(server.address() as AddressInfo).port}`;
  return {
    url: `${origin}/mcp`,
    origin,
    seen,
    registered,
    deleted,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
