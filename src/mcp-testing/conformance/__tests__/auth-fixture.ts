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
   * What an endpoint answers instead of its own answer: a status, or a string for a 302 to that location. Keys: `mcp`
   * (no token), `mcp:own` (a token issued for this server), `mcp:other` (for another resource), `mcp:bad` (not issued),
   * `prm`, `as`, `token:own`, `token:other`.
   */
  force?: Record<string, number | string>;
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
  authorization: string | undefined;
  body: string;
}

export interface AuthFixture {
  /** The MCP endpoint. */
  url: string;
  /** The issuer: this server's origin. */
  origin: string;
  seen: Seen[];
  close(): Promise<void>;
}

export const CLIENT_ID = 'plune-test-client';
export const CLIENT_SECRET = 'cs-8f3a91d27b4c46e5a0';

const json = (
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
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
      authorization: req.headers.authorization,
      body,
    });
    const forced = (key: string): boolean => {
      const f = o.force?.[key];
      if (f === undefined) return false;
      if (typeof f === 'number') json(res, f, {});
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
        ...(o.as?.iss === true ? { authorization_response_iss_parameter_supported: true } : {}),
        ...(o.as?.cimd === true ? { client_id_metadata_document_supported: true } : {}),
      });
    }
    if (path === '/token' && req.method === 'POST') {
      const basic = req.headers.authorization?.startsWith('Basic ')
        ? Buffer.from(req.headers.authorization.slice(6), 'base64').toString()
        : '';
      if (basic !== `${CLIENT_ID}:${CLIENT_SECRET}`)
        return json(res, 401, { error: 'invalid_client' });
      const form = new URLSearchParams(body);
      const wanted = form.get('resource') ?? resource();
      if (forced(wanted === resource() ? 'token:own' : 'token:other')) return;
      if (o.otherResource === 'refuse' && wanted !== resource())
        return json(res, 400, { error: 'invalid_target' });
      const token = `at-${o.sameToken === true ? 1 : ++counter}-7c1d9e5b3f2a8064`;
      issued.set(token, o.sameToken === true ? resource() : wanted);
      return json(res, 200, { access_token: token, token_type: 'Bearer', expires_in: 300 });
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
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
